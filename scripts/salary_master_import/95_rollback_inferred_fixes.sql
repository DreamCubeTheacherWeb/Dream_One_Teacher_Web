-- 薪資總表換新 2026-10-19｜還原步驟 5：把 25 筆推估更正改回原值並拿掉備註裡的更正說明（單一交易）
-- 由 build_inferred_fixes.py 產生，請勿手改。
BEGIN;
SET LOCAL lock_timeout = '15s';
LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _fix (row_no text, field text, raw_field text, raw_value text, expect_old text, new_value text, tag text)
  ON COMMIT DROP;
INSERT INTO _fix VALUES
  ('373', 'student_count', 'raw_students', '29 28 31 27', NULL, '115', '［原登記人數「29 28 31 27」，2026-10-19 業主同意推估為 115］'),
  ('374', 'student_count', 'raw_students', '29 28 31 27', NULL, '115', '［原登記人數「29 28 31 27」，2026-10-19 業主同意推估為 115］'),
  ('380', 'student_count', 'raw_students', '30+30', NULL, '60', '［原登記人數「30+30」，2026-10-19 業主同意推估為 60］'),
  ('381', 'student_count', 'raw_students', '30+30', NULL, '60', '［原登記人數「30+30」，2026-10-19 業主同意推估為 60］'),
  ('482', 'student_count', 'raw_students', '低年級18 高年級15', NULL, '33', '［原登記人數「低年級18 高年級15」，2026-10-19 業主同意推估為 33］'),
  ('483', 'student_count', 'raw_students', '低年級18 高年級15', NULL, '33', '［原登記人數「低年級18 高年級15」，2026-10-19 業主同意推估為 33］'),
  ('484', 'student_count', 'raw_students', '低年級20 高年級20', NULL, '40', '［原登記人數「低年級20 高年級20」，2026-10-19 業主同意推估為 40］'),
  ('485', 'student_count', 'raw_students', '低年級20 高年級20', NULL, '40', '［原登記人數「低年級20 高年級20」，2026-10-19 業主同意推估為 40］'),
  ('486', 'student_count', 'raw_students', '低年級20 高年級20', NULL, '40', '［原登記人數「低年級20 高年級20」，2026-10-19 業主同意推估為 40］'),
  ('810', 'student_count', 'raw_students', '三11 六8', NULL, '19', '［原登記人數「三11 六8」，2026-10-19 業主同意推估為 19］'),
  ('1846', 'student_count', 'raw_students', '20人', NULL, '20', '［原登記人數「20人」，2026-10-19 業主同意推估為 20］'),
  ('1848', 'student_count', 'raw_students', '16人', NULL, '16', '［原登記人數「16人」，2026-10-19 業主同意推估為 16］'),
  ('1849', 'student_count', 'raw_students', '19人', NULL, '19', '［原登記人數「19人」，2026-10-19 業主同意推估為 19］'),
  ('1851', 'student_count', 'raw_students', '20人', NULL, '20', '［原登記人數「20人」，2026-10-19 業主同意推估為 20］'),
  ('1852', 'student_count', 'raw_students', '20人', NULL, '20', '［原登記人數「20人」，2026-10-19 業主同意推估為 20］'),
  ('1853', 'student_count', 'raw_students', '19人', NULL, '19', '［原登記人數「19人」，2026-10-19 業主同意推估為 19］'),
  ('1854', 'student_count', 'raw_students', '16人', NULL, '16', '［原登記人數「16人」，2026-10-19 業主同意推估為 16］'),
  ('2791', 'student_count', 'raw_students', '24+13', NULL, '37', '［原登記人數「24+13」，2026-10-19 業主同意推估為 37］'),
  ('2794', 'student_count', 'raw_students', '22 21', NULL, '43', '［原登記人數「22 21」，2026-10-19 業主同意推估為 43］'),
  ('2795', 'student_count', 'raw_students', '24 20', NULL, '44', '［原登記人數「24 20」，2026-10-19 業主同意推估為 44］'),
  ('2796', 'student_count', 'raw_students', '23 20', NULL, '43', '［原登記人數「23 20」，2026-10-19 業主同意推估為 43］'),
  ('137', 'student_count', 'raw_students', '-1', '-1', '4', '［原登記人數 -1，2026-10-19 業主同意推估為 4（同梯次其他講師都是 4 人）］'),
  ('1778', 'student_count', 'raw_students', '-1', '-1', '0', '［原登記人數 -1，2026-10-19 業主同意推估為 0（科博館櫃台列人數一律填 0）］'),
  ('180', 'duration_hours', 'raw_hours', '0.0', '0', '9', '［原登記時數 0，2026-10-19 業主同意推估為 9（同營隊 8/18～8/21 都是 9 小時、同樣 2,700 元）］'),
  ('2095', 'session_date', 'raw_date', '2025/1/17', '2025-01-17', '2026-01-17', '［原登記日期 2025/1/17，2026-10-19 業主同意推估為 2026/1/17（備註寫 2025年12月馬胎營隊，前後列皆為 2025/12～2026/1 的登記）］');

DO $$
DECLARE
  v_bad int;
  v_upd int := 0;
  v_n   int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM _fix f
    LEFT JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
    LEFT JOIN public.class_sessions cs ON cs.id = m.class_session_id
   WHERE cs.id IS NULL OR strpos(coalesce(cs.notes, ''), f.tag) = 0;
  IF v_bad <> 0 THEN RAISE EXCEPTION '有 % 列找不到這次的更正說明，整批不還原', v_bad; END IF;

  UPDATE public.class_sessions cs
     SET student_count = f.expect_old::int,
         notes = nullif(btrim(replace(cs.notes, f.tag, '')), '')
    FROM _fix f JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
   WHERE cs.id = m.class_session_id AND f.field = 'student_count';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_upd := v_upd + v_n;

  UPDATE public.class_sessions cs
     SET duration_hours = f.expect_old::numeric,
         notes = nullif(btrim(replace(cs.notes, f.tag, '')), '')
    FROM _fix f JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
   WHERE cs.id = m.class_session_id AND f.field = 'duration_hours';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_upd := v_upd + v_n;

  UPDATE public.class_sessions cs
     SET session_date = f.expect_old::date,
         notes = nullif(btrim(replace(cs.notes, f.tag, '')), '')
    FROM _fix f JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
   WHERE cs.id = m.class_session_id AND f.field = 'session_date';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_upd := v_upd + v_n;

  IF v_upd <> 25 THEN RAISE EXCEPTION '還原筆數不符：%（應為 25）', v_upd; END IF;
  RAISE NOTICE '還原完成：% 列', v_upd;
END $$;

COMMIT;
