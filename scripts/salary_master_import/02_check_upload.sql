-- 薪資總表換新 2026-10-19｜步驟 2：CSV 上傳到 salary_master_rows 之後的唯讀核對
-- 預期：rows=5535、distinct_row_no=5535、raw_checksum=9f352eadbbd4e1947b9b78f624483b58、
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
