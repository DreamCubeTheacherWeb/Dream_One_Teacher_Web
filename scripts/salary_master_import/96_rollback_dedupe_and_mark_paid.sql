-- ════════════════════════════════════════════════════════════════
-- 96｜還原 06（去重＋標已付款）與 migration 20261020150000（新異常規則）
-- ════════════════════════════════════════════════════════════════
-- 單一交易：
--   1. 隔離區本批 91 筆搬回 class_sessions（原 id、原內容）。
--   2. 依備份表把每筆的付款狀態、已領金額、付款時間、異常標記、更新時間逐欄還原
--      （還原期間暫停異常與更新時間兩個 trigger，避免被重算）。
--   3. 異常規則換回 2026-10-20 以前的版本。
--   4. 刪除備份表。
-- 只還原 06 動過的欄位；06 之後網站端新增的紀錄不受影響（備份表裡沒有它們）。

BEGIN;

LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_cols text;
  v_restored int;
  v_updated int;
  v_backup int;
BEGIN
  IF to_regclass('public.salary_cleanup_20261020_backup') IS NULL THEN
    RAISE EXCEPTION '找不到備份表 salary_cleanup_20261020_backup，無法還原';
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

  -- 2. 逐欄還原付款狀態與異常標記
  UPDATE public.class_sessions cs
     SET status = b.status, paid_amount = b.paid_amount, paid_at = b.paid_at,
         is_anomaly = b.is_anomaly, anomaly_reasons = b.anomaly_reasons, updated_at = b.updated_at
    FROM public.salary_cleanup_20261020_backup b
   WHERE b.id = cs.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  SELECT count(*) INTO v_backup FROM public.salary_cleanup_20261020_backup;

  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;
  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_class_sessions_updated_at;

  IF v_restored <> 91 OR v_updated <> v_backup THEN
    RAISE EXCEPTION '還原筆數不符：搬回 %（應 91）、還原狀態 %（應 %）', v_restored, v_updated, v_backup;
  END IF;
  RAISE NOTICE 'ROLLBACK_OK 搬回 % 筆、還原 % 筆', v_restored, v_updated;
END $$;

-- 3. 異常規則換回舊版（2025_salary_system.sql 原文＋20260819 的 search_path 設定）
CREATE OR REPLACE FUNCTION public.detect_session_anomaly()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  reasons text[] := '{}';
  duplicate_count int;
BEGIN
  -- 規則 1:同講師同日期同課程名(可能重複登記)
  IF NEW.instructor_id IS NOT NULL AND NEW.course_name IS NOT NULL THEN
    SELECT count(*) INTO duplicate_count
    FROM public.class_sessions
    WHERE instructor_id = NEW.instructor_id
      AND session_date = NEW.session_date
      AND course_name = NEW.course_name
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);
    IF duplicate_count > 0 THEN
      reasons := array_append(reasons, '同講師同日同課程名可能重複');
    END IF;
  END IF;

  -- 規則 2:月份在 2020 之前
  IF NEW.session_date < DATE '2020-01-01' THEN
    reasons := array_append(reasons, '日期早於 2020 年');
  END IF;

  -- 規則 3:日期晚於當月底 + 1 個月(預排允許,過遠就警示)
  IF NEW.session_date > (CURRENT_DATE + INTERVAL '2 months')::date THEN
    reasons := array_append(reasons, '日期超過 2 個月後');
  END IF;

  -- 規則 4:薪資 0 但時數 > 0(可能漏填)
  IF COALESCE(NEW.duration_hours, 0) > 0
     AND COALESCE(NEW.base_salary, 0) = 0
     AND COALESCE(NEW.bonus, 0) = 0 THEN
    reasons := array_append(reasons, '有時數但薪資為 0');
  END IF;

  NEW.is_anomaly := cardinality(reasons) > 0;
  NEW.anomaly_reasons := reasons;
  RETURN NEW;
END;
$$;

-- 4. 備份表用完即刪
DROP TABLE public.salary_cleanup_20261020_backup;

COMMIT;
