-- ════════════════════════════════════════════════════════════════
-- 2026-10-20 薪資異常規則收斂：只有「內容完全相同」才算疑似重複
-- ════════════════════════════════════════════════════════════════
-- 業主 2026-10-20：「我給你的都是正確的資料」「481 個異常也太瞎了」「兩筆一模一樣的資料選其中一筆就好」。
-- 舊規則 1 只比「同講師同日同課程名」，同一天在同一校上兩堂（時數、人數、金額不同）也被標成重複，
-- 新總表 5,535 筆中 427 筆是這樣來的；規則 4「有時數但薪資為 0」另標了 58 筆業主核對過的總表資料。
--
-- 改動（只動判定規則，不改任何資料；資料整理在 scripts/salary_master_import/06_dedupe_and_mark_paid.sql）：
--   規則 1：同講師同日，且課程種類、課程名、地點、合作單位、期間、發放教材、交通補助與公里數、角色、
--           時數、人數、薪資、獎金、備註、課程自評、學習進度、特殊狀況回報都相同，才標「可能重複登記」。
--           （合作課回報常不帶課程名，所以要連合作單位一起比，同日兩校各上一堂才不會被誤標。
--           自訂欄位 extra_fields 不比：它由 20261020130000 新增，這支 migration 不依賴它。）
--   規則 4：來源是業主核對過的薪資總表（source = 'historical_import'）不再標「有時數但薪資為 0」；
--           網站回報與後台手動新增的紀錄照舊檢查。
--   規則 2、3 不變。
-- 觸發時機不變（新增或修改紀錄時重算該筆），可重複執行。
-- 還原：scripts/salary_master_import/97_restore_old_anomaly_rule.sql 換回舊規則（可單獨執行）。

CREATE OR REPLACE FUNCTION public.detect_session_anomaly()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  reasons text[] := '{}';
BEGIN
  -- 規則 1：同講師同日，內容完全相同（可能重複登記）
  IF NEW.instructor_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.class_sessions s
     WHERE s.instructor_id = NEW.instructor_id
       AND s.session_date = NEW.session_date
       AND s.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND s.course_type IS NOT DISTINCT FROM NEW.course_type
       AND s.course_name IS NOT DISTINCT FROM NEW.course_name
       AND s.location IS NOT DISTINCT FROM NEW.location
       AND s.unit_name IS NOT DISTINCT FROM NEW.unit_name
       AND s.term_period IS NOT DISTINCT FROM NEW.term_period
       AND s.materials_issued IS NOT DISTINCT FROM NEW.materials_issued
       AND s.transport_subsidy_requested IS NOT DISTINCT FROM NEW.transport_subsidy_requested
       AND s.transport_distance_km IS NOT DISTINCT FROM NEW.transport_distance_km
       AND s.role_in_session IS NOT DISTINCT FROM NEW.role_in_session
       AND s.duration_hours IS NOT DISTINCT FROM NEW.duration_hours
       AND s.student_count IS NOT DISTINCT FROM NEW.student_count
       AND s.base_salary IS NOT DISTINCT FROM NEW.base_salary
       AND s.bonus IS NOT DISTINCT FROM NEW.bonus
       AND s.notes IS NOT DISTINCT FROM NEW.notes
       AND s.self_review IS NOT DISTINCT FROM NEW.self_review
       AND s.progress_note IS NOT DISTINCT FROM NEW.progress_note
       AND s.incident_report IS NOT DISTINCT FROM NEW.incident_report
  ) THEN
    reasons := array_append(reasons, '同講師同日有內容完全相同的紀錄，可能重複登記');
  END IF;

  -- 規則 2：月份在 2020 之前
  IF NEW.session_date < DATE '2020-01-01' THEN
    reasons := array_append(reasons, '日期早於 2020 年');
  END IF;

  -- 規則 3：日期晚於今天 + 2 個月（預排允許，過遠就警示）
  IF NEW.session_date > (CURRENT_DATE + INTERVAL '2 months')::date THEN
    reasons := array_append(reasons, '日期超過 2 個月後');
  END IF;

  -- 規則 4：薪資 0 但時數 > 0（可能漏填）；業主核對過的總表資料不檢查
  IF NEW.source IS DISTINCT FROM 'historical_import'
     AND COALESCE(NEW.duration_hours, 0) > 0
     AND COALESCE(NEW.base_salary, 0) = 0
     AND COALESCE(NEW.bonus, 0) = 0 THEN
    reasons := array_append(reasons, '有時數但薪資為 0');
  END IF;

  NEW.is_anomaly := cardinality(reasons) > 0;
  NEW.anomaly_reasons := reasons;
  RETURN NEW;
END;
$$;
