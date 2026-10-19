-- ═══════════════════════════════════════════════════════════════════
-- 合約範本讀取權限收緊（2026-10-19）
-- 可重複執行。只改政策，不動資料、不動函式。
--
-- 背景：2026-10-18 講師簽約重開的資安審查指出兩筆既有設計債（非該次引入）：
--   * public.contract_documents 的 SELECT 政策是 TO authenticated USING (true)；
--   * storage.objects 對 contract-documents bucket 內「非 signed/」路徑（合約範本）全體登入者可讀。
--   站點任何 Google 帳號首次登入即自動建 pending 角色，等於任何人登入後直接打 PostgREST／Storage API
--   就能列出並下載「講師委任報酬表」等範本。
--
-- 做法：兩處讀取都改為「public.users.role IN ('teacher','mentor','admin')」（排除 pending），
--   與 20261018150000 對報酬表／回報選項表的做法一致。
--   * signed/<uid>/ 本人可讀、admin／mentor 整個 bucket 可讀的既有規則原樣保留
--     （mentor 是否該讀 signed/ 待業主決定，本 migration 不動）。
--   * 管理員 FOR ALL 政策不動，後台上傳／改名／停用／刪除不受影響。
--   * anon 本來就沒有政策（RLS 下為 0 列），這裡明寫 REVOKE 把表級權限也收掉。
-- 前端影響面：pending 只會在個人資料頁觸發一次 contract_documents 查詢（結果只用來比對已簽合約版本，
--   pending 不可能有合約），改成 0 列不會報錯；同批前端把 canAccessInstructorContracts 一併排除 pending。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. public.contract_documents：只剩一條讀取政策 ──
ALTER TABLE public.contract_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read active contract documents" ON public.contract_documents;
DROP POLICY IF EXISTS "Approved roles can read contract documents" ON public.contract_documents;

-- 後台若曾手動加過其他 SELECT 專用政策（permissive 政策是 OR 關係，留著等於沒收緊），一併收掉；
-- FOR ALL 的管理員政策 cmd 為 ALL，不在此範圍。
DO $$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'contract_documents'
      AND cmd = 'SELECT'
  LOOP
    RAISE NOTICE 'dropping extra SELECT policy on contract_documents: %', policy_row.policyname;
    EXECUTE format('DROP POLICY %I ON public.contract_documents', policy_row.policyname);
  END LOOP;
END;
$$;

CREATE POLICY "Approved roles can read contract documents"
  ON public.contract_documents FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role IN ('teacher', 'mentor', 'admin')
    )
  );

REVOKE ALL ON TABLE public.contract_documents FROM anon;

-- ── 2. storage.objects：contract-documents bucket 的讀取 ──
DROP POLICY IF EXISTS "Authenticated can read contract documents storage" ON storage.objects;
DROP POLICY IF EXISTS "read contract documents scoped" ON storage.objects;
CREATE POLICY "read contract documents scoped"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'contract-documents'
    AND (
      -- 本人的簽署檔（signed/<uid>/…）
      (
        (storage.foldername(name))[1] = 'signed'
        AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
      )
      -- 管理員與輔導員：整個 bucket（含所有人的 signed/；mentor 是否該讀待業主決定）
      OR EXISTS (
        SELECT 1 FROM public.users u
         WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'mentor')
      )
      -- 範本等非 signed/ 路徑：只給已核准角色，pending 讀不到
      OR (
        (storage.foldername(name))[1] IS DISTINCT FROM 'signed'
        AND EXISTS (
          SELECT 1 FROM public.users u
           WHERE u.id = (SELECT auth.uid()) AND u.role IN ('teacher', 'mentor', 'admin')
        )
      )
    )
  );
