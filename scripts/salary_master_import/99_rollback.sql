-- 薪資總表換新 2026-10-19｜還原：把 03_apply.sql 的結果整個退回（單一交易）
-- 1) 刪除由新總表匯入 class_sessions 的列（以暫存表預先產生的 id 精準指定）
-- 2) 隔離區該批舊資料原樣搬回 class_sessions（衍生欄位由資料庫重算）
-- 3) 清掉該隔離批次、把暫存表標回「未匯入」。暫存表本身保留，修正後可再執行 03_apply.sql。
-- 講師在網站回報、後台手動登記的列不受影響。

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '10min';
LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_batch    constant text := '2026-10-19';
  v_qbatch   constant text := '2026-05 舊總表匯入（2026-10-19 隔離）';
  v_cols     text;
  v_q        int;
  v_removed  int;
  v_restored int;
BEGIN
  SELECT count(*) INTO v_q FROM public.class_sessions_quarantine WHERE quarantine_batch = v_qbatch;
  IF v_q = 0 THEN
    RAISE EXCEPTION '隔離批次「%」不存在，沒有可還原的資料', v_qbatch;
  END IF;

  DELETE FROM public.class_sessions cs
   USING public.salary_master_rows m
   WHERE m.batch = v_batch AND m.class_session_id = cs.id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  -- 只寫回非衍生欄位（month_label、total_salary 由資料庫自動重算）
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
    FROM information_schema.columns c
    JOIN information_schema.columns q
      ON q.table_schema = 'public' AND q.table_name = 'class_sessions_quarantine' AND q.column_name = c.column_name
   WHERE c.table_schema = 'public' AND c.table_name = 'class_sessions' AND c.is_generated = 'NEVER';

  EXECUTE format(
    'INSERT INTO public.class_sessions (%s) SELECT %s FROM public.class_sessions_quarantine WHERE quarantine_batch = $1 ORDER BY created_at, id',
    v_cols, v_cols)
  USING v_qbatch;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  IF v_restored <> v_q THEN
    RAISE EXCEPTION '還原筆數不符：隔離區 %、寫回 %', v_q, v_restored;
  END IF;

  DELETE FROM public.class_sessions_quarantine WHERE quarantine_batch = v_qbatch;
  UPDATE public.salary_master_rows
     SET imported_at = NULL, instructor_id = NULL, instructor_match = NULL
   WHERE batch = v_batch;

  RAISE NOTICE '還原完成：移除新總表匯入 % 筆、寫回舊資料 % 筆', v_removed, v_restored;
END $$;

COMMIT;
