-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  薪資登記提醒排程（每月 18、22 號站內通知講師）
-- ───────────────────────────────────────────────────────────────────
-- 需求：每月 18 號與 22 號提醒講師登記薪資（填課程回報表單）。
-- 結算規則：每月 25 號結算（計算區間＝上月 26 日～本月 25 日），逾期併入下月。
-- 做法：pg_cron 排程 → 呼叫 send_salary_reminder() → 對所有 teacher/mentor
--        寫入 notifications（站內鈴鐺通知，type='announcement'，連到 /my/salary）。
-- 注意：這是「站內」通知，講師開網站才看得到；要 email/LINE 主動推播需另外接。
-- 時區：pg_cron 用 UTC。'0 1 18,22 * *' ＝ 台北時間每月 18、22 號早上 09:00。
-- 冪等：可重複執行（同名排程會先解除再重建；當日重複觸發不會重複發通知）。
-- 移除方式：SELECT cron.unschedule('salary-reminder-18');
--           SELECT cron.unschedule('salary-reminder-22');
-- ═══════════════════════════════════════════════════════════════════

-- ── 0. 啟用 pg_cron（若這行報錯，改到 Dashboard → Database → Extensions 開啟 pg_cron）──
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── 1. 發通知函式 ────────────────────────────────────────────────────
-- 對象：role 為 teacher / mentor 的使用者（admin 不需要提醒；要調整改下面 IN 清單）。
-- 防重複：同一人同一天已有同標題通知就跳過（cron 重跑或 SQL 重複執行都不會轟炸）。
CREATE OR REPLACE FUNCTION public.send_salary_reminder()
RETURNS void AS $$
BEGIN
  INSERT INTO public.notifications (user_id, type, title, body, link)
  SELECT
    u.id,
    'announcement',
    '薪資登記提醒',
    '請儘早完成本期課程回報。每月 25 號結算（計算區間：上月 26 日～本月 25 日），逾期將併入下月。',
    '/my/salary'
  FROM public.users u
  WHERE u.role IN ('teacher', 'mentor')
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = u.id
        AND n.title = '薪資登記提醒'
        AND n.created_at::date = CURRENT_DATE
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 權限守衛：只給排程（以資料庫擁有者身分執行）呼叫；
-- 一般登入者不得執行，否則任何人都能對全體講師發通知轟炸。
REVOKE ALL ON FUNCTION public.send_salary_reminder() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.send_salary_reminder() FROM anon;
REVOKE ALL ON FUNCTION public.send_salary_reminder() FROM authenticated;

-- ── 2. 排程（先解除同名舊排程再建，冪等）────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('salary-reminder-18');
EXCEPTION WHEN OTHERS THEN NULL; -- 尚未存在就略過
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('salary-reminder-22');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule('salary-reminder-18', '0 1 18 * *', $$SELECT public.send_salary_reminder()$$);
SELECT cron.schedule('salary-reminder-22', '0 1 22 * *', $$SELECT public.send_salary_reminder()$$);

-- ── 驗證 ─────────────────────────────────────────────────────────────
-- 排程有沒有掛上（應看到兩列，schedule 分別是 0 1 18 * * / 0 1 22 * *）：
SELECT jobname, schedule, command FROM cron.job WHERE jobname LIKE 'salary-reminder-%';

-- ⚠️ 想手動試發：執行下面這行「會真的發通知給所有講師」，平日別跑；
--    要測請先只留自己（把函式裡 role IN (...) 暫時改成只比對自己的 email/id）。
-- SELECT public.send_salary_reminder();

-- 每次排程執行的歷史紀錄（跑過之後才有資料）：
-- SELECT jobname, status, return_message, start_time
--   FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
