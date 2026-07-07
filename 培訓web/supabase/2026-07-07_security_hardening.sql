-- ═══════════════════════════════════════════════════════════════════
-- 資安加固腳本（2026-07-07 交接前把關）
-- 在 Supabase 專案的 SQL Editor 貼上整份執行即可，可重複執行（idempotent）。
-- ───────────────────────────────────────────────────────────────────
-- 背景：本平台前端用 anon key 直連 Supabase，所有權限邊界都靠 RLS 政策
-- 與 SECURITY DEFINER 函式內的角色檢查。體檢發現三個後端漏洞，本檔修補。
-- 修完請跑檔尾「驗證查詢」確認生效，並照最後的「攻擊重演」段自我驗證。
-- ═══════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────
-- 【紅／致命 1】delete_user_completely() 任何登入者都能刪任意帳號
-- ───────────────────────────────────────────────────────────────────
-- 問題：此函式是 SECURITY DEFINER（以擁有者權限執行）卻沒有角色檢查，
-- Postgres 預設把 EXECUTE 授權給 PUBLIC → 任何 Google 登入者（含 pending）
-- 都能在瀏覽器 console 呼叫它刪掉任意 user 的 instructors/合約/薪資/帳號。
-- 修法：函式開頭加 admin 守衛 + 固定 search_path；並收回 PUBLIC 的執行權。

CREATE OR REPLACE FUNCTION public.delete_user_completely(target_user_id uuid)
RETURNS void AS $$
DECLARE
  target_email text;
BEGIN
  -- ★ 守衛：只有 admin 能執行
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'permission denied: 只有管理員能刪除帳號';
  END IF;

  SELECT email INTO target_email FROM auth.users WHERE id = target_user_id;

  DELETE FROM public.instructors WHERE user_id = target_user_id;
  DELETE FROM public.progress WHERE user_id = target_user_id;
  DELETE FROM public.assignments WHERE user_id = target_user_id;
  DELETE FROM public.course_training_status WHERE user_id = target_user_id;
  DELETE FROM public.users WHERE id = target_user_id;

  IF target_email IS NOT NULL THEN
    DELETE FROM public.teacher_invites WHERE email = target_email;
  END IF;

  DELETE FROM auth.users WHERE id = target_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- 收回 PUBLIC 的預設執行權，只留給 authenticated（真正的守衛是上面函式內的 admin 檢查）
REVOKE ALL ON FUNCTION public.delete_user_completely(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user_completely(uuid) TO authenticated;


-- ───────────────────────────────────────────────────────────────────
-- 【紅／致命 2】contract-documents bucket 全體登入者可讀＋列舉
-- ───────────────────────────────────────────────────────────────────
-- 問題：SELECT 政策只有 USING (bucket_id = 'contract-documents')，沒有
-- per-user 條件。任何登入者可列舉 signed/{別人uid}/ 並下載他人的簽署合約 PDF
-- （含身分證字號、地址、電話、手寫簽名圖）。
-- 修法：admin/mentor 讀全部；一般講師只讀自己 signed/{自己uid}/ 下的檔；
-- 空白合約範本（非 signed/ 路徑）維持全體登入者可讀，簽約流程才不會壞。
-- 註：簽署檔上傳於 signed/{user_id}/（見 ContractSigningFlow.jsx 上傳處）；
--     若你的範本實際放在別的資料夾，最後一條 OR 已用「非 signed/ 開頭」涵蓋。

DROP POLICY IF EXISTS "read contract documents scoped" ON storage.objects;          -- 先清新政策自己，確保可重複執行
DROP POLICY IF EXISTS "Authenticated can read contract documents storage" ON storage.objects;

CREATE POLICY "read contract documents scoped"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'contract-documents'
    AND (
      -- admin / mentor 讀全部
      EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','mentor'))
      -- 本人讀自己 signed/{uid}/ 下的簽署檔
      OR (
        (storage.foldername(name))[1] = 'signed'
        AND (storage.foldername(name))[2] = auth.uid()::text
      )
      -- 空白範本（非 signed/ 路徑）全體登入者可讀，簽約流程才拿得到範本
      OR (storage.foldername(name))[1] IS DISTINCT FROM 'signed'
    )
  );


-- ───────────────────────────────────────────────────────────────────
-- 【黃／中度 3】notifications 可被任意登入者偽造塞給任何人
-- ───────────────────────────────────────────────────────────────────
-- 問題：INSERT 政策是 WITH CHECK (true)，任何人可 insert 一筆
-- {user_id: 受害者, type: 'contract', link: 'https://釣魚站'} → 受害者在
-- 站內信任介面看到假的「請重新簽約」並點擊。屬釣魚放大器。
-- 難點：不能單純「只有職員能發」，因為一般使用者對留言按讚時會合法地
-- 發通知給留言作者（LessonDetail.jsx）；也會發合約提醒給自己（Layout.jsx）。
-- 修法（防禦式，不破壞既有流程）：職員可發任意通知；一般使用者只能發給自己、
-- 或發 type='like' 的社群通知 → 擋掉偽造 contract/system 等敏感類型的釣魚。
-- ★ 長期正解：把通知建立改成資料庫 trigger / SECURITY DEFINER 函式（server 端
--   產生），前端完全禁止 INSERT。見 STATUS.md 分階段計畫。此處為過渡加固。

DROP POLICY IF EXISTS "notifications insert guarded" ON public.notifications;        -- 先清新政策自己，確保可重複執行
DROP POLICY IF EXISTS "Staff can insert notifications" ON public.notifications;

CREATE POLICY "notifications insert guarded"
  ON public.notifications FOR INSERT
  TO authenticated
  WITH CHECK (
    -- 職員（admin/mentor）可發任意通知
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','mentor'))
    -- 或：發給自己的提醒
    OR user_id = auth.uid()
    -- 或：一般使用者對留言按讚的社群通知
    OR type = 'like'
  );


-- ═══════════════════════════════════════════════════════════════════
-- 驗證查詢（執行後貼回結果自我確認）
-- ═══════════════════════════════════════════════════════════════════
-- 1) 確認 delete_user_completely 現在有 admin 守衛（看函式定義應含 RAISE EXCEPTION）：
--    SELECT pg_get_functiondef('public.delete_user_completely(uuid)'::regprocedure);
--
-- 2) 確認 storage 政策已替換（應只剩 scoped 那條，不再有無條件 USING）：
--    SELECT policyname, cmd FROM pg_policies
--    WHERE tablename = 'objects' AND schemaname = 'storage'
--      AND policyname ILIKE '%contract%';
--
-- 3) 確認 notifications INSERT 政策已換：
--    SELECT policyname, with_check FROM pg_policies
--    WHERE tablename = 'notifications' AND cmd = 'INSERT';
--
-- ═══════════════════════════════════════════════════════════════════
-- 攻擊重演（用「非 admin 測試帳號」的 session，證明漏洞已堵死）
-- ═══════════════════════════════════════════════════════════════════
-- A) 用一般（pending/teacher）帳號在前端 console 跑：
--      await supabase.rpc('delete_user_completely', { target_user_id: '<任意uuid>' })
--    → 應回 permission denied（修好前會真的刪掉帳號）。
-- B) 用一般帳號跑：
--      await supabase.storage.from('contract-documents').list('signed')
--    → 應回空陣列或僅自己的資料夾（修好前會列出所有講師資料夾）。
-- ═══════════════════════════════════════════════════════════════════
