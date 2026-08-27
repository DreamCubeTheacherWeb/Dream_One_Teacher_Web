-- 同一個資料欄位可能在同一頁表單出現多次（例如申請人姓名與聯絡人姓名）。
-- 原唯一鍵過度限制了欄位排版，而每筆資料本來就已有 UUID 主鍵。
DO $$
DECLARE
  matching_constraint text;
BEGIN
  FOR matching_constraint IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.contract_field_positions'::regclass
      AND constraint_row.contype = 'u'
      AND (
        SELECT array_agg(attribute_row.attname::text ORDER BY constraint_key.ordinality)
        FROM unnest(constraint_row.conkey) WITH ORDINALITY
          AS constraint_key(attnum, ordinality)
        JOIN pg_catalog.pg_attribute attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = constraint_key.attnum
      ) = ARRAY['doc_type', 'doc_version', 'field_type', 'page_number']::text[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.contract_field_positions DROP CONSTRAINT %I',
      matching_constraint
    );
  END LOOP;
END;
$$;

-- 移除唯一約束會一併移除原索引；保留常用的文件版本查詢路徑。
CREATE INDEX IF NOT EXISTS contract_field_positions_doc_type_version_idx
  ON public.contract_field_positions (doc_type, doc_version);

-- 以單一資料庫交易取代前端的「先 DELETE、再 INSERT」兩步儲存。
-- 任何一筆新位置不合法時，整筆 RPC 回滾，不會清空原有排版。
CREATE OR REPLACE FUNCTION public.replace_contract_field_positions(
  p_doc_type text,
  p_doc_version integer,
  p_positions jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.users user_row
    WHERE user_row.id = (SELECT auth.uid())
      AND user_row.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'admin access required to replace contract field positions';
  END IF;

  IF NULLIF(btrim(p_doc_type), '') IS NULL
     OR p_doc_version IS NULL
     OR p_doc_version < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'document type and positive document version are required';
  END IF;

  IF p_positions IS NULL OR jsonb_typeof(p_positions) <> 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'positions must be a JSON array';
  END IF;

  -- 防止兩個管理員同時儲存同一份文件時，各自的 DELETE/INSERT 結果交錯。
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_doc_type),
    p_doc_version
  );

  DELETE FROM public.contract_field_positions
  WHERE doc_type = p_doc_type
    AND doc_version = p_doc_version;

  INSERT INTO public.contract_field_positions (
    doc_type,
    doc_version,
    field_type,
    page_number,
    x,
    y_from_top,
    width,
    height,
    font_size
  )
  SELECT
    p_doc_type,
    p_doc_version,
    position_row.field_type,
    position_row.page_number,
    position_row.x,
    position_row.y_from_top,
    position_row.width,
    position_row.height,
    position_row.font_size
  FROM jsonb_to_recordset(p_positions) AS position_row(
    field_type text,
    page_number integer,
    x double precision,
    y_from_top double precision,
    width double precision,
    height double precision,
    font_size double precision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.replace_contract_field_positions(text, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_contract_field_positions(text, integer, jsonb)
  TO authenticated;
