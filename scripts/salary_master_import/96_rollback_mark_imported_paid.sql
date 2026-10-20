-- 薪資總表換新 2026-10-19｜還原步驟 6：把 06_mark_imported_paid.sql 標成已付款的匯入紀錄改回原值（單一交易）
-- 原值來自 public.class_sessions_paid_backfill_20261020。注意：步驟 6 之後管理員對這些列手動改過的付款狀態也會被蓋回原值。
-- 備份表保留不刪（之後要再標一次已付款，直接重跑 06 即可）。
BEGIN;
SET LOCAL lock_timeout = '15s';
LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_enabled "char";
BEGIN
  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;

  UPDATE public.class_sessions s
     SET status = b.old_status,
         paid_amount = b.old_paid_amount,
         paid_at = b.old_paid_at
    FROM public.class_sessions_paid_backfill_20261020 b
   WHERE b.session_id = s.id;

  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;

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
       sum(s.total_salary - s.paid_amount)        AS 未付金額
  FROM public.class_sessions s
 GROUP BY s.source, s.status
 ORDER BY s.source, s.status;
