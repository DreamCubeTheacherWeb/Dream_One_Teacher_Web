-- 薪資總表換新 2026-10-19｜步驟 2：CSV 上傳到 salary_master_rows 之後的唯讀核對
-- 預期：rows=5535、distinct_row_no=5535、raw_checksum=9f352eadbbd4e1947b9b78f624483b58、
--       derived_checksum=918701e66d70059cf5b1d39ab2b6d95d、replacement_char_rows=0、
--       base_salary_sum=10271061、bonus_sum=453547、paid_sum=6000、date_fixed=22、bad_* 全為 0。
WITH m AS (
  SELECT * FROM public.salary_master_rows WHERE batch = '2026-10-19'
),
names AS (
  SELECT trim(full_name) AS n, count(*) AS c FROM public.instructors GROUP BY 1
),
per_name AS (
  SELECT m.instructor_name, count(*) AS rows, max(names.c) AS hits
    FROM m LEFT JOIN names ON names.n = m.instructor_name
   GROUP BY m.instructor_name
)
SELECT jsonb_pretty(jsonb_build_object(
  'rows', (SELECT count(*) FROM m),
  'distinct_row_no', (SELECT count(DISTINCT row_no) FROM m),
  'row_no_min_max', (SELECT jsonb_build_array(min(row_no::int), max(row_no::int)) FROM m),
  'raw_checksum', (
    SELECT md5(string_agg(concat_ws(E'\x1f', row_no,
             coalesce(raw_month, ''), coalesce(raw_instructor, ''), coalesce(raw_course_kind, ''),
             coalesce(raw_date, ''), coalesce(raw_registrar, ''), coalesce(raw_level, ''),
             coalesce(raw_course_name, ''), coalesce(raw_notes, ''), coalesce(raw_hours, ''),
             coalesce(raw_students, ''), coalesce(raw_salary, ''), coalesce(raw_bonus, ''),
             coalesce(raw_paid, ''), coalesce(raw_self_review, ''), coalesce(raw_progress, ''),
             coalesce(raw_incident, '')), E'\n' ORDER BY row_no::int))
      FROM m
  ),
  'derived_checksum', (SELECT md5(string_agg(concat_ws(E'\x1f', row_no, coalesce(course_type, ''), coalesce(role_in_session, ''), coalesce(instructor_name, ''), coalesce(instructor_role_at_time, ''), coalesce(session_date, ''), coalesce(course_name, ''), coalesce(notes, ''), coalesce(duration_hours, ''), coalesce(student_count, ''), coalesce(base_salary, ''), coalesce(bonus, ''), coalesce(paid_amount, ''), coalesce(status, ''), coalesce(registered_by_name, ''), coalesce(self_review, ''), coalesce(progress_note, ''), coalesce(incident_report, ''), coalesce(date_fixed, ''), coalesce(original_date, '')), E'\n' ORDER BY row_no::int)) FROM m),
  'replacement_char_rows', (SELECT count(*) FROM m WHERE strpos(coalesce(raw_month, ''), chr(65533)) > 0 OR strpos(coalesce(raw_instructor, ''), chr(65533)) > 0 OR strpos(coalesce(raw_course_kind, ''), chr(65533)) > 0 OR strpos(coalesce(raw_date, ''), chr(65533)) > 0 OR strpos(coalesce(raw_registrar, ''), chr(65533)) > 0 OR strpos(coalesce(raw_level, ''), chr(65533)) > 0 OR strpos(coalesce(raw_course_name, ''), chr(65533)) > 0 OR strpos(coalesce(raw_notes, ''), chr(65533)) > 0 OR strpos(coalesce(raw_hours, ''), chr(65533)) > 0 OR strpos(coalesce(raw_students, ''), chr(65533)) > 0 OR strpos(coalesce(raw_salary, ''), chr(65533)) > 0 OR strpos(coalesce(raw_bonus, ''), chr(65533)) > 0 OR strpos(coalesce(raw_paid, ''), chr(65533)) > 0 OR strpos(coalesce(raw_self_review, ''), chr(65533)) > 0 OR strpos(coalesce(raw_progress, ''), chr(65533)) > 0 OR strpos(coalesce(raw_incident, ''), chr(65533)) > 0 OR strpos(coalesce(course_type, ''), chr(65533)) > 0 OR strpos(coalesce(role_in_session, ''), chr(65533)) > 0 OR strpos(coalesce(instructor_name, ''), chr(65533)) > 0 OR strpos(coalesce(instructor_role_at_time, ''), chr(65533)) > 0 OR strpos(coalesce(session_date, ''), chr(65533)) > 0 OR strpos(coalesce(course_name, ''), chr(65533)) > 0 OR strpos(coalesce(notes, ''), chr(65533)) > 0 OR strpos(coalesce(duration_hours, ''), chr(65533)) > 0 OR strpos(coalesce(student_count, ''), chr(65533)) > 0 OR strpos(coalesce(base_salary, ''), chr(65533)) > 0 OR strpos(coalesce(bonus, ''), chr(65533)) > 0 OR strpos(coalesce(paid_amount, ''), chr(65533)) > 0 OR strpos(coalesce(status, ''), chr(65533)) > 0 OR strpos(coalesce(registered_by_name, ''), chr(65533)) > 0 OR strpos(coalesce(self_review, ''), chr(65533)) > 0 OR strpos(coalesce(progress_note, ''), chr(65533)) > 0 OR strpos(coalesce(incident_report, ''), chr(65533)) > 0 OR strpos(coalesce(date_fixed, ''), chr(65533)) > 0 OR strpos(coalesce(original_date, ''), chr(65533)) > 0),
  'base_salary_sum', (SELECT sum(coalesce(nullif(base_salary, ''), '0')::numeric) FROM m),
  'bonus_sum', (SELECT sum(coalesce(nullif(bonus, ''), '0')::numeric) FROM m),
  'paid_sum', (SELECT sum(coalesce(nullif(paid_amount, ''), '0')::numeric) FROM m),
  'date_fixed', (SELECT count(*) FROM m WHERE date_fixed = 'true'),
  'bad_session_date', (SELECT count(*) FROM m WHERE coalesce(session_date, '') !~ '^\d{4}-\d{2}-\d{2}$'),
  'bad_status', (SELECT count(*) FROM m WHERE coalesce(status, '') NOT IN ('approved', 'paid')),
  'bad_role', (
    SELECT count(*) FROM m
     WHERE coalesce(role_in_session, '') NOT IN ('lead', 'assistant', 'head_judge', 'sub_judge', 'counter', 'project_lead', 'other')
  ),
  'empty_name', (SELECT count(*) FROM m WHERE coalesce(instructor_name, '') = ''),
  'already_imported', (SELECT count(*) FROM m WHERE imported_at IS NOT NULL),
  'other_batches', (SELECT count(*) FROM public.salary_master_rows WHERE batch <> '2026-10-19'),
  'names_total', (SELECT count(*) FROM per_name),
  'names_matched', (SELECT count(*) FROM per_name WHERE hits = 1),
  'names_ambiguous', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('name', instructor_name, 'rows', rows) ORDER BY rows DESC), '[]'::jsonb)
      FROM per_name WHERE hits > 1
  ),
  'names_unmatched', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('name', instructor_name, 'rows', rows) ORDER BY rows DESC), '[]'::jsonb)
      FROM per_name WHERE hits IS NULL
  ),
  'overlap_with_website_rows', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'source', cs.source, 'name', cs.instructor_name, 'date', cs.session_date,
             'type', cs.course_type, 'course', cs.course_name, 'master_row', m.row_no)), '[]'::jsonb)
      FROM public.class_sessions cs
      JOIN m ON m.instructor_name = cs.instructor_name AND m.session_date = cs.session_date::text
     WHERE cs.source IS DISTINCT FROM 'historical_import'
  )
)) AS upload_check;
