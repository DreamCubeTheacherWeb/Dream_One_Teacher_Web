-- ════════════════════════════════════════════════════════════════
-- 97｜異常規則換回 2026-10-20 以前的版本（還原 migration 20261020150000）
-- ════════════════════════════════════════════════════════════════
-- 可單獨執行（例如 migration 套了、06 卻沒跑成），也可在 96 之後執行。只換函式、不改任何資料；
-- 既有紀錄的異常標記要等該筆下次被新增或修改時才會依舊規則重算。
-- 內容＝2025_salary_system.sql 原文＋20260819160000 的 search_path 設定。

BEGIN;

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

COMMIT;
