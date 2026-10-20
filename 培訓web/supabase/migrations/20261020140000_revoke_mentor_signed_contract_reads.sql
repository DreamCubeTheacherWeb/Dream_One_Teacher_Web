-- ═══════════════════════════════════════════════════════════════════
-- 收回輔導員（mentor）讀取所有人已簽契約檔的權限（2026-10-20 業主決定）
-- 可重複執行。只改 storage 讀取政策，不動資料、不動函式、不動 contract_documents。
--
-- 背景：20261019103000 保留了「admin／mentor 可讀整個 contract-documents bucket」的既有規則，
--   註明 mentor 是否該讀 signed/ 待業主決定。signed/ 底下是講師簽好的契約 PDF 與簽名圖，
--   PDF 上有身分證字號與地址；法規顧問（個資最小必要）與端到端測試都把這列為待處理。
--   業主 2026-10-20 決定：已簽契約檔只留管理員與講師本人能讀。
--
-- 做法：重建 "read contract documents scoped"，只有 admin 可讀整個 bucket；
--   本人 signed/<uid>/ 照舊；範本等非 signed/ 路徑仍給 teacher／mentor／admin（輔導員後台的
--   「表單預覽與下載」只讀 templates/，不受影響）。
--   另把 storage.objects 上其他「只限 SELECT、且條件提到 contract-documents」的 permissive 政策收掉
--   （permissive 政策是 OR 關係，後台若曾手動加過，留著等於沒收回）；FOR ALL 的管理員政策不在此範圍。
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND cmd = 'SELECT'
      AND permissive = 'PERMISSIVE'
      AND policyname <> 'read contract documents scoped'
      AND coalesce(qual, '') LIKE '%contract-documents%'
  LOOP
    RAISE NOTICE 'dropping extra SELECT policy on storage.objects for contract-documents: %', policy_row.policyname;
    EXECUTE format('DROP POLICY %I ON storage.objects', policy_row.policyname);
  END LOOP;
END;
$$;

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
      -- 管理員：整個 bucket（含所有人的 signed/）
      OR EXISTS (
        SELECT 1 FROM public.users u
         WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
      )
      -- 範本等非 signed/ 路徑：已核准角色可讀，pending 讀不到
      OR (
        (storage.foldername(name))[1] IS DISTINCT FROM 'signed'
        AND EXISTS (
          SELECT 1 FROM public.users u
           WHERE u.id = (SELECT auth.uid()) AND u.role IN ('teacher', 'mentor', 'admin')
        )
      )
    )
  );
