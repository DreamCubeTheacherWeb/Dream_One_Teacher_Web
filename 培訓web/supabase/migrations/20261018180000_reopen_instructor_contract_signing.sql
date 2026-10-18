-- ═══════════════════════════════════════════════════════════════════
-- 講師前台簽約重開（2026-10-18，業主決定：補寫入通道＋恢復 Email 身分驗證）
-- 可重複執行。
--
-- 背景：8/19 資安修補移除了講師對 instructor_contracts 的 INSERT 政策，
-- 前台簽約因此必須改由「可信 RPC」建立紀錄。本 migration 提供 submit_my_contract：
--   * SECURITY DEFINER、空 search_path；
--   * Email 身分驗證不信任 client：只認 JWT 的 amr（Supabase 在 verifyOtp 成功後簽進
--     session 的驗證紀錄，method 為 otp／magiclink，30 分鐘內有效）；
--   * 文件版本須等於目前啟用版本、簽名檔與 PDF 必須真的已上傳到自己的 signed/<uid>/ 資料夾；
--   * 作廢舊約與新增新約在同一交易，並以 advisory lock 避免同一人併發雙簽；
--   * IP 由伺服器端 request header 取得，不再由前端呼叫第三方服務。
-- 不新增任何讓 authenticated 直接 INSERT／UPDATE instructor_contracts 的 policy。
-- ═══════════════════════════════════════════════════════════════════

-- 7/07 的 supabase/2026-07-07_esign_verification.sql 可能尚未套進正式庫，這裡冪等補上。
ALTER TABLE public.instructor_contracts
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verify_method text;

-- 先移除同名的所有多載，避免 PostgREST 呼叫歧義。
DO $$
DECLARE
  old_function record;
BEGIN
  FOR old_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'submit_my_contract'
  LOOP
    EXECUTE format('DROP FUNCTION %s', old_function.signature);
  END LOOP;
END;
$$;

CREATE FUNCTION public.submit_my_contract(
  p_filled_name text,
  p_filled_instructor_role text,
  p_filled_id_number text,
  p_filled_address text,
  p_filled_phone text,
  p_signature_path text,
  p_signed_pdf_paths jsonb,
  p_doc_versions jsonb,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_amr jsonb;
  v_verified_epoch numeric;
  v_name text := NULLIF(btrim(p_filled_name), '');
  v_instructor_role text := NULLIF(btrim(p_filled_instructor_role), '');
  v_id_number text := NULLIF(btrim(p_filled_id_number), '');
  v_address text := NULLIF(btrim(p_filled_address), '');
  v_phone text := NULLIF(btrim(p_filled_phone), '');
  v_user_agent text := NULLIF(left(btrim(COALESCE(p_user_agent, '')), 500), '');
  v_prefix text;
  v_path text;
  v_doc record;
  v_headers jsonb;
  v_ip text;
  v_row public.instructor_contracts%ROWTYPE;
BEGIN
  -- a. 必須登入
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  -- b. 角色必須存在且已通過審核（非 pending）
  SELECT user_row.role::text INTO v_role
  FROM public.users user_row
  WHERE user_row.id = v_uid;

  IF v_role IS NULL OR v_role = 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'role not allowed';
  END IF;

  -- c. Email 身分驗證：只認 JWT amr 裡 otp／magiclink 且 30 分鐘內的紀錄
  v_amr := auth.jwt() -> 'amr';
  IF v_amr IS NOT NULL AND jsonb_typeof(v_amr) = 'array' THEN
    SELECT max(
             CASE
               WHEN jsonb_typeof(amr_item.item -> 'timestamp') = 'number'
                 THEN (amr_item.item ->> 'timestamp')::numeric
               ELSE NULL
             END
           )
    INTO v_verified_epoch
    FROM jsonb_array_elements(v_amr) AS amr_item(item)
    WHERE jsonb_typeof(amr_item.item) = 'object'
      AND amr_item.item ->> 'method' IN ('otp', 'magiclink');
  END IF;

  IF v_verified_epoch IS NULL
     OR v_verified_epoch < extract(epoch FROM pg_catalog.now()) - 1800 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EMAIL_VERIFICATION_REQUIRED';
  END IF;

  -- d. 輸入清洗與長度限制
  IF v_name IS NULL OR v_instructor_role IS NULL OR v_id_number IS NULL
     OR v_address IS NULL OR v_phone IS NULL
     OR char_length(v_id_number) <> 10
     OR char_length(v_name) > 100
     OR char_length(v_instructor_role) > 50
     OR char_length(v_address) > 300
     OR char_length(v_phone) > 30
     OR p_signature_path IS NULL
     OR p_signed_pdf_paths IS NULL OR jsonb_typeof(p_signed_pdf_paths) <> 'object'
     OR p_doc_versions IS NULL OR jsonb_typeof(p_doc_versions) <> 'object'
     OR char_length(p_signed_pdf_paths::text) > 8000
     OR char_length(p_doc_versions::text) > 4000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_INPUT';
  END IF;

  -- e. 文件版本：每種啟用中的文件，送來的版本必須等於目前啟用版本
  --    （同一 doc_type 若有多筆啟用，與前台一致取最高版本）
  -- 行政表單（doc_category = 'form'，如匯款申請書）不屬於簽約流程；用 to_jsonb 取欄位，
  -- 讓尚未加 doc_category 欄位的環境也能執行。
  IF NOT EXISTS (
    SELECT 1 FROM public.contract_documents document_row
    WHERE document_row.is_active = true
      AND COALESCE(to_jsonb(document_row) ->> 'doc_category', 'contract') <> 'form'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NO_ACTIVE_DOCUMENTS';
  END IF;

  FOR v_doc IN
    SELECT DISTINCT ON (document_row.doc_type)
           document_row.doc_type, document_row.version, document_row.doc_mode
    FROM public.contract_documents document_row
    WHERE document_row.is_active = true
      AND COALESCE(to_jsonb(document_row) ->> 'doc_category', 'contract') <> 'form'
    ORDER BY document_row.doc_type, document_row.version DESC
  LOOP
    IF (p_doc_versions ->> v_doc.doc_type) IS DISTINCT FROM v_doc.version::text THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'DOC_VERSION_MISMATCH';
    END IF;
    IF v_doc.doc_mode = 'fill_sign'
       AND NULLIF(p_signed_pdf_paths ->> v_doc.doc_type, '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SIGNED_PDF_MISSING';
    END IF;
  END LOOP;

  -- f. 檔案路徑：只能是自己 signed/<uid>/ 底下、副檔名正確、且確實已上傳
  v_prefix := 'signed/' || v_uid::text || '/';

  IF left(p_signature_path, char_length(v_prefix)) <> v_prefix
     OR position('..' IN p_signature_path) > 0
     OR right(p_signature_path, 4) <> '.png'
     OR NOT EXISTS (
       SELECT 1 FROM storage.objects object_row
       WHERE object_row.bucket_id = 'contract-documents'
         AND object_row.name = p_signature_path
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FILE_NOT_UPLOADED';
  END IF;

  FOR v_path IN
    SELECT path_item.value FROM jsonb_each_text(p_signed_pdf_paths) AS path_item(key, value)
  LOOP
    IF v_path IS NULL
       OR left(v_path, char_length(v_prefix)) <> v_prefix
       OR position('..' IN v_path) > 0
       OR right(v_path, 4) <> '.pdf'
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects object_row
         WHERE object_row.bucket_id = 'contract-documents'
           AND object_row.name = v_path
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FILE_NOT_UPLOADED';
    END IF;
  END LOOP;

  -- g. IP：由伺服器端 request header 取得（PostgREST 會把 header 放進 request.headers）
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;

  IF v_headers IS NOT NULL AND jsonb_typeof(v_headers) = 'object' THEN
    v_ip := NULLIF(btrim(v_headers ->> 'cf-connecting-ip'), '');
    IF v_ip IS NULL THEN
      v_ip := NULLIF(btrim(split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
    END IF;
    v_ip := left(v_ip, 64);
  END IF;

  -- h. 同一交易：作廢該使用者舊的有效合約，再新增這一份
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('submit_my_contract'),
    pg_catalog.hashtext(v_uid::text)
  );

  UPDATE public.instructor_contracts contract_row
  SET status = 'voided'
  WHERE contract_row.user_id = v_uid
    AND contract_row.status = 'signed';

  INSERT INTO public.instructor_contracts (
    user_id,
    filled_name,
    filled_instructor_role,
    filled_id_number,
    filled_address,
    filled_phone,
    signature_path,
    rules_doc_version,
    compensation_doc_version,
    contract_doc_version,
    doc_versions,
    signed_pdf_paths,
    signed_pdf_path,
    signed_at,
    ip_address,
    user_agent,
    verified_at,
    verify_method,
    status
  )
  VALUES (
    v_uid,
    v_name,
    v_instructor_role,
    v_id_number,
    v_address,
    v_phone,
    p_signature_path,
    CASE WHEN (p_doc_versions ->> 'rules') ~ '^[0-9]{1,9}$' THEN (p_doc_versions ->> 'rules')::integer ELSE 0 END,
    CASE WHEN (p_doc_versions ->> 'compensation') ~ '^[0-9]{1,9}$' THEN (p_doc_versions ->> 'compensation')::integer ELSE 0 END,
    CASE WHEN (p_doc_versions ->> 'contract') ~ '^[0-9]{1,9}$' THEN (p_doc_versions ->> 'contract')::integer ELSE 0 END,
    p_doc_versions,
    p_signed_pdf_paths,
    (SELECT path_item.value
       FROM jsonb_each_text(p_signed_pdf_paths) WITH ORDINALITY AS path_item(key, value, ordinality)
      ORDER BY path_item.ordinality
      LIMIT 1),
    pg_catalog.now(),
    v_ip,
    v_user_agent,
    to_timestamp(v_verified_epoch::double precision),
    'email_otp',
    'signed'
  )
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

-- i. 只有登入者能呼叫
REVOKE ALL ON FUNCTION public.submit_my_contract(text, text, text, text, text, text, jsonb, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_my_contract(text, text, text, text, text, text, jsonb, jsonb, text)
  TO authenticated;

COMMENT ON FUNCTION public.submit_my_contract(text, text, text, text, text, text, jsonb, jsonb, text) IS
  '講師簽約的唯一寫入通道：驗證 JWT amr 的 Email 驗證（30 分鐘內）、文件版本與已上傳檔案後，作廢舊約並建立新約。';
