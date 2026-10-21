-- 講師身分證正反面／存摺封面／匯款五欄：已有資料就鎖定，管理員「開放修改一次」才可自行更換。
--
-- 業主 2026-10-20 要求：
--   1. 身分證正反面比照存摺鎖定（原本只鎖存摺與匯款）。
--   2. 後台每按一次「開放修改一次」只給一次機會；講師存檔後自動鎖回，要再改就再按一次。
--   3. 每次修改都留紀錄（誰、何時、改了什麼、是否用了開放權限），舊檔保留不刪。
--   4. 補漏洞：由 Google 表單匯入的雲端連結（*_external_url）也算「已有資料」，原本 DB 只看 *_path。
--   5. 開放權限 72 小時內有效（資安審查建議）：開了沒用不會永久有效，避免帳號被盜時被拿來改匯款。
--
-- 這支 migration 取代 20260818082549（存摺鎖定）與 20260825120000（匯款鎖定）的兩個 trigger，
-- 改由同一個 trigger 依「開放權限」決定是否放行。另修正舊匯款 trigger 把 NULL 與空字串視為不同、
-- 導致帳號已填但分行等欄位為 NULL 的講師一存檔就被擋的問題（比對前一律 NULLIF(BTRIM(...), '')）。
--
-- 權限邊界全在 DB：前端只是顯示層。可重複執行。

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- 1. 開放修改權限：每列＝管理員按一次，講師用掉（consumed）或管理員收回（revoked）後失效
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.instructor_edit_unlocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id uuid NOT NULL REFERENCES public.instructors(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('id_card', 'bankbook', 'bank_account')),
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  consumed_at timestamptz,
  consumed_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT instructor_edit_unlocks_single_outcome
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

ALTER TABLE public.instructor_edit_unlocks
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours');

COMMENT ON TABLE public.instructor_edit_unlocks IS
  '管理員開放講師自行修改已鎖定資料的一次性權限；只能由 admin RPC 建立／收回，由 guard trigger 用掉。';

-- 同一講師同一項目同時最多一筆「未用掉、未收回」的權限：重複按不會累積成多次。
-- （過期的那筆由開放 RPC 在重新開放前標成收回，revoked_by 為 NULL＝自然過期。）
CREATE UNIQUE INDEX IF NOT EXISTS instructor_edit_unlocks_one_open
  ON public.instructor_edit_unlocks (instructor_id, scope)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS instructor_edit_unlocks_instructor_idx
  ON public.instructor_edit_unlocks (instructor_id, granted_at DESC);

ALTER TABLE public.instructor_edit_unlocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read instructor edit unlocks" ON public.instructor_edit_unlocks;
CREATE POLICY "Admins can read instructor edit unlocks"
  ON public.instructor_edit_unlocks FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Instructors can read own edit unlocks" ON public.instructor_edit_unlocks;
CREATE POLICY "Instructors can read own edit unlocks"
  ON public.instructor_edit_unlocks FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.instructors i
      WHERE i.id = instructor_id AND i.user_id = (SELECT auth.uid())
    )
  );

-- 沒有任何 INSERT／UPDATE／DELETE 政策：只能經由下方 SECURITY DEFINER 函式寫入。
REVOKE ALL ON public.instructor_edit_unlocks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.instructor_edit_unlocks TO authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 2. 修改紀錄：只由 trigger 寫入，只有管理員能讀（含帳號等個資）
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.instructor_document_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instructor_id uuid NOT NULL REFERENCES public.instructors(id) ON DELETE CASCADE,
  item text NOT NULL CHECK (item IN ('id_front', 'id_back', 'bankbook', 'bank_account')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid,
  changed_by_role text NOT NULL CHECK (changed_by_role IN ('instructor', 'admin', 'system')),
  unlock_id uuid REFERENCES public.instructor_edit_unlocks(id) ON DELETE SET NULL,
  old_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_value jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.instructor_document_changes IS
  '講師身分證／存摺／匯款資料每次變更的紀錄；文件類 old_value.path 指向保留下來的舊檔。';

CREATE INDEX IF NOT EXISTS instructor_document_changes_instructor_idx
  ON public.instructor_document_changes (instructor_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS instructor_document_changes_old_path_idx
  ON public.instructor_document_changes ((old_value ->> 'path'));
CREATE INDEX IF NOT EXISTS instructor_document_changes_new_path_idx
  ON public.instructor_document_changes ((new_value ->> 'path'));

ALTER TABLE public.instructor_document_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read instructor document changes" ON public.instructor_document_changes;
CREATE POLICY "Admins can read instructor document changes"
  ON public.instructor_document_changes FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

REVOKE ALL ON public.instructor_document_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.instructor_document_changes TO authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 3. 鎖定守衛：取代舊的存摺／匯款 trigger
-- ────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_guard_instructor_bankbook ON public.instructors;
DROP TRIGGER IF EXISTS trg_guard_instructor_bank_account ON public.instructors;
DROP FUNCTION IF EXISTS public.guard_instructor_bankbook();
DROP FUNCTION IF EXISTS public.guard_instructor_bank_account();

CREATE OR REPLACE FUNCTION public.guard_instructor_locked_documents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  id_front_changed boolean;
  id_back_changed boolean;
  bankbook_changed boolean;
  bank_changed boolean;
  unlock_id uuid;
BEGIN
  -- SQL Editor／service role／受控匯入沒有使用者 JWT，保留系統維運能力。
  IF actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM public.users WHERE id = actor_id AND role = 'admin') THEN
    RETURN NEW;
  END IF;

  id_front_changed := ROW(NULLIF(BTRIM(NEW.id_front_path), ''), NEW.id_front_mime, NEW.id_front_size, NEW.id_front_uploaded_at)
    IS DISTINCT FROM ROW(NULLIF(BTRIM(OLD.id_front_path), ''), OLD.id_front_mime, OLD.id_front_size, OLD.id_front_uploaded_at);
  id_back_changed := ROW(NULLIF(BTRIM(NEW.id_back_path), ''), NEW.id_back_mime, NEW.id_back_size, NEW.id_back_uploaded_at)
    IS DISTINCT FROM ROW(NULLIF(BTRIM(OLD.id_back_path), ''), OLD.id_back_mime, OLD.id_back_size, OLD.id_back_uploaded_at);
  bankbook_changed := ROW(NULLIF(BTRIM(NEW.bankbook_path), ''), NEW.bankbook_mime, NEW.bankbook_size, NEW.bankbook_uploaded_at)
    IS DISTINCT FROM ROW(NULLIF(BTRIM(OLD.bankbook_path), ''), OLD.bankbook_mime, OLD.bankbook_size, OLD.bankbook_uploaded_at);
  bank_changed := ROW(
      NULLIF(BTRIM(NEW.bank_account_name), ''), NULLIF(BTRIM(NEW.bank_name), ''),
      NULLIF(BTRIM(NEW.bank_branch), ''), NULLIF(BTRIM(NEW.bank_code), ''),
      NULLIF(BTRIM(NEW.bank_account_number), '')
    ) IS DISTINCT FROM ROW(
      NULLIF(BTRIM(OLD.bank_account_name), ''), NULLIF(BTRIM(OLD.bank_name), ''),
      NULLIF(BTRIM(OLD.bank_branch), ''), NULLIF(BTRIM(OLD.bank_code), ''),
      NULLIF(BTRIM(OLD.bank_account_number), '')
    );

  -- 身分證：正面或反面任一「原本已有資料」而被更動，就需要一次 id_card 開放權限（同次存檔改兩面只用一次）。
  IF (id_front_changed AND (NULLIF(BTRIM(OLD.id_front_path), '') IS NOT NULL
                            OR NULLIF(BTRIM(OLD.id_front_external_url), '') IS NOT NULL))
     OR (id_back_changed AND (NULLIF(BTRIM(OLD.id_back_path), '') IS NOT NULL
                              OR NULLIF(BTRIM(OLD.id_back_external_url), '') IS NOT NULL)) THEN
    unlock_id := NULL;
    UPDATE public.instructor_edit_unlocks
       SET consumed_at = now(), consumed_by = actor_id
     WHERE instructor_id = OLD.id AND scope = 'id_card'
       AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
    RETURNING id INTO unlock_id;
    IF unlock_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = '身分證照片已鎖定，如需修改，請於講師群組提出。';
    END IF;
  END IF;

  IF bankbook_changed AND (NULLIF(BTRIM(OLD.bankbook_path), '') IS NOT NULL
                           OR NULLIF(BTRIM(OLD.bankbook_external_url), '') IS NOT NULL) THEN
    unlock_id := NULL;
    UPDATE public.instructor_edit_unlocks
       SET consumed_at = now(), consumed_by = actor_id
     WHERE instructor_id = OLD.id AND scope = 'bankbook'
       AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
    RETURNING id INTO unlock_id;
    IF unlock_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = '存摺封面已鎖定，如需修改，請於講師群組提出。';
    END IF;
  END IF;

  IF bank_changed AND NULLIF(BTRIM(OLD.bank_account_number), '') IS NOT NULL THEN
    unlock_id := NULL;
    UPDATE public.instructor_edit_unlocks
       SET consumed_at = now(), consumed_by = actor_id
     WHERE instructor_id = OLD.id AND scope = 'bank_account'
       AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
    RETURNING id INTO unlock_id;
    IF unlock_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = '匯款銀行資訊已鎖定，如需修改，請於講師群組提出。';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_locked_documents() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_instructor_locked_documents ON public.instructors;
CREATE TRIGGER trg_guard_instructor_locked_documents
  BEFORE UPDATE ON public.instructors
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_instructor_locked_documents();


-- ────────────────────────────────────────────────────────────────────
-- 4. 修改紀錄 trigger：AFTER 才寫，只記實際寫入的值（upsert 的 INSERT 預檢不會留假紀錄）
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_instructor_document_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  doc_key text;
  scope_key text;
  old_value jsonb;
  new_value jsonb;
  used_unlock uuid;
BEGIN
  IF actor_id IS NULL THEN
    actor_role := 'system';
  ELSIF EXISTS (SELECT 1 FROM public.users WHERE id = actor_id AND role = 'admin') THEN
    actor_role := 'admin';
  ELSE
    actor_role := 'instructor';
  END IF;

  FOREACH doc_key IN ARRAY ARRAY['id_front', 'id_back', 'bankbook'] LOOP
    old_value := jsonb_strip_nulls(jsonb_build_object(
      'path', NULLIF(BTRIM(old_row ->> (doc_key || '_path')), ''),
      'mime', old_row -> (doc_key || '_mime'),
      'size', old_row -> (doc_key || '_size'),
      'uploaded_at', old_row -> (doc_key || '_uploaded_at'),
      'external_url', NULLIF(BTRIM(old_row ->> (doc_key || '_external_url')), '')
    ));
    new_value := jsonb_strip_nulls(jsonb_build_object(
      'path', NULLIF(BTRIM(new_row ->> (doc_key || '_path')), ''),
      'mime', new_row -> (doc_key || '_mime'),
      'size', new_row -> (doc_key || '_size'),
      'uploaded_at', new_row -> (doc_key || '_uploaded_at'),
      'external_url', NULLIF(BTRIM(new_row ->> (doc_key || '_external_url')), '')
    ));

    IF old_value IS DISTINCT FROM new_value THEN
      scope_key := CASE WHEN doc_key = 'bankbook' THEN 'bankbook' ELSE 'id_card' END;
      used_unlock := NULL;
      IF actor_role = 'instructor' THEN
        SELECT u.id INTO used_unlock
        FROM public.instructor_edit_unlocks u
        WHERE u.instructor_id = NEW.id AND u.scope = scope_key
          AND u.consumed_at = now() AND u.consumed_by = actor_id
        ORDER BY u.granted_at DESC
        LIMIT 1;
      END IF;

      INSERT INTO public.instructor_document_changes
        (instructor_id, item, changed_by, changed_by_role, unlock_id, old_value, new_value)
      VALUES
        (NEW.id, doc_key, actor_id, actor_role, used_unlock, old_value, new_value);
    END IF;
  END LOOP;

  old_value := jsonb_strip_nulls(jsonb_build_object(
    'bank_account_name', NULLIF(BTRIM(old_row ->> 'bank_account_name'), ''),
    'bank_name', NULLIF(BTRIM(old_row ->> 'bank_name'), ''),
    'bank_branch', NULLIF(BTRIM(old_row ->> 'bank_branch'), ''),
    'bank_code', NULLIF(BTRIM(old_row ->> 'bank_code'), ''),
    'bank_account_number', NULLIF(BTRIM(old_row ->> 'bank_account_number'), '')
  ));
  new_value := jsonb_strip_nulls(jsonb_build_object(
    'bank_account_name', NULLIF(BTRIM(new_row ->> 'bank_account_name'), ''),
    'bank_name', NULLIF(BTRIM(new_row ->> 'bank_name'), ''),
    'bank_branch', NULLIF(BTRIM(new_row ->> 'bank_branch'), ''),
    'bank_code', NULLIF(BTRIM(new_row ->> 'bank_code'), ''),
    'bank_account_number', NULLIF(BTRIM(new_row ->> 'bank_account_number'), '')
  ));

  IF old_value IS DISTINCT FROM new_value THEN
    used_unlock := NULL;
    IF actor_role = 'instructor' THEN
      SELECT u.id INTO used_unlock
      FROM public.instructor_edit_unlocks u
      WHERE u.instructor_id = NEW.id AND u.scope = 'bank_account'
        AND u.consumed_at = now() AND u.consumed_by = actor_id
      ORDER BY u.granted_at DESC
      LIMIT 1;
    END IF;

    INSERT INTO public.instructor_document_changes
      (instructor_id, item, changed_by, changed_by_role, unlock_id, old_value, new_value)
    VALUES
      (NEW.id, 'bank_account', actor_id, actor_role, used_unlock, old_value, new_value);
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.log_instructor_document_changes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_log_instructor_document_changes ON public.instructors;
CREATE TRIGGER trg_log_instructor_document_changes
  AFTER INSERT OR UPDATE ON public.instructors
  FOR EACH ROW
  EXECUTE FUNCTION public.log_instructor_document_changes();


-- ────────────────────────────────────────────────────────────────────
-- 5. 管理員 RPC：開放一次／收回
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_grant_instructor_edit_unlock(p_instructor_id uuid, p_scope text)
RETURNS public.instructor_edit_unlocks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  result public.instructor_edit_unlocks;
BEGIN
  IF actor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = actor_id AND role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '只有管理員可以開放講師修改。';
  END IF;

  IF p_scope IS NULL OR p_scope NOT IN ('id_card', 'bankbook', 'bank_account') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '未知的開放項目。';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.instructors WHERE id = p_instructor_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '找不到這位講師。';
  END IF;

  -- 過期未用的權限先標成收回（revoked_by 留 NULL＝自然過期），才能重新開放。
  UPDATE public.instructor_edit_unlocks
     SET revoked_at = now()
   WHERE instructor_id = p_instructor_id AND scope = p_scope
     AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at <= now();

  -- 已有尚未用掉的權限就直接回傳那一筆：按兩次不會變成可改兩次，也不會延長期限。
  INSERT INTO public.instructor_edit_unlocks (instructor_id, scope, granted_by)
  VALUES (p_instructor_id, p_scope, actor_id)
  ON CONFLICT (instructor_id, scope) WHERE consumed_at IS NULL AND revoked_at IS NULL
  DO NOTHING;

  SELECT * INTO result
  FROM public.instructor_edit_unlocks
  WHERE instructor_id = p_instructor_id AND scope = p_scope
    AND consumed_at IS NULL AND revoked_at IS NULL;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_revoke_instructor_edit_unlock(p_unlock_id uuid)
RETURNS public.instructor_edit_unlocks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  result public.instructor_edit_unlocks;
BEGIN
  IF actor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = actor_id AND role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '只有管理員可以收回開放。';
  END IF;

  UPDATE public.instructor_edit_unlocks
     SET revoked_at = now(), revoked_by = actor_id
   WHERE id = p_unlock_id AND consumed_at IS NULL AND revoked_at IS NULL
  RETURNING * INTO result;

  -- 已被講師用掉或已收回：回傳現況，讓畫面重新整理即可。
  IF result.id IS NULL THEN
    SELECT * INTO result FROM public.instructor_edit_unlocks WHERE id = p_unlock_id;
    IF result.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '找不到這筆開放紀錄。';
    END IF;
  END IF;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_grant_instructor_edit_unlock(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_revoke_instructor_edit_unlock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_instructor_edit_unlock(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_instructor_edit_unlock(uuid) TO authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 6. 保留舊檔：講師不能上傳到、覆寫或刪除「現行或曾經提交過」的身分證／存摺檔名
--    （取代 instructors_setup.sql 的講師上傳政策與 20260819140407 只保護現行存摺的兩條政策；大頭照不受影響）
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_protected_instructor_file(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.instructors i
    WHERE p_name IN (
      NULLIF(BTRIM(i.id_front_path), ''),
      NULLIF(BTRIM(i.id_back_path), ''),
      NULLIF(BTRIM(i.bankbook_path), '')
    )
  ) OR EXISTS (
    SELECT 1 FROM public.instructor_document_changes c
    WHERE c.old_value ->> 'path' = p_name OR c.new_value ->> 'path' = p_name
  )
$$;

REVOKE ALL ON FUNCTION public.is_protected_instructor_file(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_protected_instructor_file(text) TO authenticated;

-- 上傳也要排除：否則講師可先把路徑指到一個還不存在的檔名，鎖定後再上傳任意圖片到那個檔名，
-- 不用開放也不留紀錄就換掉畫面上的證件（資安審查建議）。條件其餘與 instructors_setup.sql 原政策相同。
DROP POLICY IF EXISTS "Users can upload own instructor files" ON storage.objects;
CREATE POLICY "Users can upload own instructor files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND NOT public.is_protected_instructor_file(name)
  );

DROP POLICY IF EXISTS "Users can update own instructor files" ON storage.objects;
CREATE POLICY "Users can update own instructor files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND NOT public.is_protected_instructor_file(name)
  )
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND NOT public.is_protected_instructor_file(name)
  );

DROP POLICY IF EXISTS "Users can delete own instructor files" ON storage.objects;
CREATE POLICY "Users can delete own instructor files"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND NOT public.is_protected_instructor_file(name)
  );

COMMIT;
