-- 薪資總表換新 2026-10-19｜步驟 6（2026-10-20 追加）：總表匯入的 9/30 以前紀錄全部標成「已付款」
-- 業主 2026-10-20：「我給你的資料全部都是已經有領過的，沒有人未領」。
-- 匯入時沿用總表的狀態（5,532 筆 approved、已領金額 0），講師端因此顯示「未領金額」。
-- 同日業主確認：10 月的課 11/10 才匯，總表裡 10 月那 6 筆先不標（維持已核准），11/10 匯完再標。
--
-- 做法（單一交易，任何一步失敗整批不生效）：
--   1. 原值（status／paid_amount／paid_at）備份到 public.class_sessions_paid_backfill_20261020
--      （網站讀不到，只能在 SQL Editor 查）；已備份過的列不覆蓋，所以重跑也保留最初的原值。
--   2. source = 'historical_import' 且上課日在 2026-10-01 之前的列，改成 status = 'paid'、paid_amount = total_salary；
--      paid_at 不動（實際匯款日不明）。網站上講師回報、管理員手動新增的紀錄（source 不是 historical_import）一律不動。
--   3. 暫停「異常偵測」trigger 只為了這次更新：它在更新時會重算「同講師同日同課名」，
--      會把匯入時沒標到的那一半重複列也標成異常；這次只改付款狀態，不該順便改異常標記。交易結束前恢復。
--   4. 交易內核對：範圍內還有未付、或異常偵測 trigger 沒恢復，就整批取消（報錯，什麼都不會改）。
-- 執行後畫面上的表就是核對結果：historical_import 應是 paid 一列（未付 0）＋ approved 一列（10 月的 6 筆）。
-- 可重複執行；還原用 96_rollback_mark_imported_paid.sql。
BEGIN;
SET LOCAL lock_timeout = '15s';
LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.class_sessions_paid_backfill_20261020 (
  session_id       uuid PRIMARY KEY,
  old_status       public.session_status_enum NOT NULL,
  old_paid_amount  numeric(10,2),
  old_paid_at      timestamptz,
  backed_up_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.class_sessions_paid_backfill_20261020 IS
  '2026-10-20 總表匯入紀錄（2026-10-01 前）標成已付款前的原值；還原用 scripts/salary_master_import/96_rollback_mark_imported_paid.sql';
ALTER TABLE public.class_sessions_paid_backfill_20261020 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.class_sessions_paid_backfill_20261020 FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_cutoff   CONSTANT date := DATE '2026-10-01';  -- 這天（含）以後的課還沒匯，不標
  v_blocked  int;
  v_left     int;
  v_enabled  "char";
BEGIN
  -- 待定價／已退回的紀錄依規則必須維持 pending，不能標成已付款；匯入資料理論上沒有，有的話整批停下來
  SELECT count(*) INTO v_blocked
    FROM public.class_sessions s
   WHERE s.source = 'historical_import'
     AND s.session_date < v_cutoff
     AND s.pricing_status IN ('needs_review', 'rejected');
  IF v_blocked > 0 THEN
    RAISE EXCEPTION '有 % 筆匯入紀錄是待定價或已退回，不能直接標成已付款，請先處理', v_blocked;
  END IF;

  INSERT INTO public.class_sessions_paid_backfill_20261020 (session_id, old_status, old_paid_amount, old_paid_at)
  SELECT s.id, s.status, s.paid_amount, s.paid_at
    FROM public.class_sessions s
   WHERE s.source = 'historical_import'
     AND s.session_date < v_cutoff
     AND (s.status <> 'paid' OR s.paid_amount IS DISTINCT FROM s.total_salary)
  ON CONFLICT (session_id) DO NOTHING;

  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;

  UPDATE public.class_sessions s
     SET status = 'paid',
         paid_amount = s.total_salary
   WHERE s.source = 'historical_import'
     AND s.session_date < v_cutoff
     AND (s.status <> 'paid' OR s.paid_amount IS DISTINCT FROM s.total_salary);

  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;

  SELECT count(*) INTO v_left
    FROM public.class_sessions s
   WHERE s.source = 'historical_import'
     AND s.session_date < v_cutoff
     AND (s.status <> 'paid' OR s.paid_amount IS DISTINCT FROM s.total_salary);
  IF v_left > 0 THEN
    RAISE EXCEPTION '核對失敗：還有 % 筆 10/1 以前的匯入紀錄未標成已付款，整批取消', v_left;
  END IF;

  SELECT t.tgenabled INTO v_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.class_sessions'::regclass AND t.tgname = 'trg_session_anomaly';
  IF v_enabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION '核對失敗：異常偵測 trigger 沒有恢復（狀態 %），整批取消', v_enabled;
  END IF;
END;
$$;

COMMIT;

-- 核對表（交易已完成，這裡只是讀取）
SELECT s.source                                   AS 來源,
       s.status                                   AS 狀態,
       count(*)                                   AS 筆數,
       sum(s.total_salary)                        AS 報酬合計,
       sum(s.total_salary - s.paid_amount)        AS 未付金額,
       min(s.session_date)                        AS 最早上課日,
       max(s.session_date)                        AS 最晚上課日,
       (SELECT count(*) FROM public.class_sessions_paid_backfill_20261020) AS 已備份原值筆數
  FROM public.class_sessions s
 GROUP BY s.source, s.status
 ORDER BY s.source, s.status;
