-- ════════════════════════════════════════════════════════════════
-- 96｜還原 06（去重＋標已付款）的資料；舊異常規則另用 97_restore_old_anomaly_rule.sql
-- ════════════════════════════════════════════════════════════════
-- 單一交易：
--   1. 隔離區本批 91 筆搬回 class_sessions（原 id、原內容、原異常標記）。
--   2. 06 改到的列（備份表 touched），而且 06 之後沒人再改過（updated_at 仍等於 06 執行時間）者，
--      依備份逐欄還原付款狀態、已領金額、付款時間、異常標記、更新時間。
--      還原期間暫停異常與更新時間兩個 trigger，避免被重算。
--   3. 06 之後有人改過（後台核准、標已付款、刪除）的列一律不動：預設模式下只要有這種列就整批停止，
--      把下方 'apply' 改成 'skip-changed' 才會略過它們、只還原其他列（略過的筆數會列出）。
--   4. 刪除備份表。
-- 預演：把下方 'apply' 改成 'dry-run'，跑到最後會拋出 DRY_RUN_OK（附統計）並整批取消。

BEGIN;

LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

SELECT set_config('salary_cleanup.rollback_mode', 'apply', true);

DO $$
DECLARE
  v_mode text := current_setting('salary_cleanup.rollback_mode');
  v_cols text;
  v_changed int;
  v_touched int;
  v_restored int;
  v_updated int;
  v_summary text;
BEGIN
  IF v_mode NOT IN ('apply', 'skip-changed', 'dry-run') THEN
    RAISE EXCEPTION '不認得的模式 %', v_mode;
  END IF;
  IF to_regclass('public.salary_cleanup_20261020_backup') IS NULL THEN
    RAISE EXCEPTION '找不到備份表 salary_cleanup_20261020_backup，無法還原（只要換回舊規則請用 97）';
  END IF;
  IF (SELECT count(*) FROM public.class_sessions_quarantine
       WHERE quarantine_batch = '2026-10-20 完全相同重複列（業主指示只留一筆）') <> 91 THEN
    RAISE EXCEPTION '隔離區本批不是 91 筆，停止';
  END IF;
  IF EXISTS (SELECT 1 FROM public.class_sessions cs
               JOIN public.class_sessions_quarantine q ON q.id = cs.id
              WHERE q.quarantine_batch = '2026-10-20 完全相同重複列（業主指示只留一筆）') THEN
    RAISE EXCEPTION '要搬回的紀錄已經在 class_sessions，停止';
  END IF;

  SELECT count(*) FILTER (WHERE b.touched),
         count(*) FILTER (WHERE b.touched AND (cs.id IS NULL OR cs.updated_at IS DISTINCT FROM b.cleanup_run_at))
    INTO v_touched, v_changed
    FROM public.salary_cleanup_20261020_backup b
    LEFT JOIN public.class_sessions cs ON cs.id = b.id;
  IF v_changed > 0 AND v_mode <> 'skip-changed' THEN
    RAISE EXCEPTION '06 之後有 % 筆被改過或刪除（後台核准、標已付款等），預設不還原；確認要略過它們請改用 skip-changed 模式', v_changed;
  END IF;

  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;
  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_class_sessions_updated_at;

  -- 1. 搬回（衍生欄位 month_label／total_salary 由資料庫自己算）
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'class_sessions'
     AND c.is_generated = 'NEVER'
     AND EXISTS (SELECT 1 FROM information_schema.columns q
                  WHERE q.table_schema = 'public' AND q.table_name = 'class_sessions_quarantine'
                    AND q.column_name = c.column_name);
  EXECUTE format(
    'INSERT INTO public.class_sessions (%s) SELECT %s FROM public.class_sessions_quarantine WHERE quarantine_batch = $1',
    v_cols, v_cols)
  USING '2026-10-20 完全相同重複列（業主指示只留一筆）';
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  DELETE FROM public.class_sessions_quarantine
   WHERE quarantine_batch = '2026-10-20 完全相同重複列（業主指示只留一筆）';

  -- 2. 只還原 06 改過、而且之後沒人再改過的列
  UPDATE public.class_sessions cs
     SET status = b.status, paid_amount = b.paid_amount, paid_at = b.paid_at,
         is_anomaly = b.is_anomaly, anomaly_reasons = b.anomaly_reasons, updated_at = b.updated_at
    FROM public.salary_cleanup_20261020_backup b
   WHERE b.id = cs.id AND b.touched AND cs.updated_at = b.cleanup_run_at;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;
  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_class_sessions_updated_at;

  v_summary := format('搬回 %s 筆、還原 %s 筆、06 之後被改過而略過 %s 筆', v_restored, v_updated, v_changed);
  IF v_restored <> 91 OR v_updated <> v_touched - v_changed THEN
    RAISE EXCEPTION '還原筆數不符，已取消：%（應搬回 91、還原 %）', v_summary, v_touched - v_changed;
  END IF;
  IF v_mode = 'dry-run' THEN
    RAISE EXCEPTION 'DRY_RUN_OK %', v_summary;
  END IF;
  RAISE NOTICE 'ROLLBACK_OK %', v_summary;
END $$;

-- 3. 備份表用完即刪
DROP TABLE public.salary_cleanup_20261020_backup;

COMMIT;
