-- 薪資總表換新 2026-10-19｜步驟 4：執行後唯讀核對
WITH m AS (
  SELECT m.*, cs.id AS cs_id, cs.base_salary AS cs_base, cs.bonus AS cs_bonus, cs.session_date AS cs_date,
         cs.instructor_id AS cs_instructor
    FROM public.salary_master_rows m
    LEFT JOIN public.class_sessions cs ON cs.id = m.class_session_id
   WHERE m.batch = '2026-10-19'
),
q AS (
  SELECT * FROM public.class_sessions_quarantine
   WHERE quarantine_batch = '2026-05 舊總表匯入（2026-10-19 隔離）'
)
SELECT jsonb_pretty(jsonb_build_object(
  'checked_at', now(),
  'class_sessions_by_source', (
    SELECT jsonb_object_agg(coalesce(source, '(null)'), c)
      FROM (SELECT source, count(*) AS c FROM public.class_sessions GROUP BY source) s
  ),
  'master_rows', (SELECT count(*) FROM m),
  'master_rows_in_class_sessions', (SELECT count(*) FROM m WHERE cs_id IS NOT NULL),
  'master_imported_at', (SELECT jsonb_build_array(min(imported_at), max(imported_at)) FROM m),
  'class_sessions_master_base_sum', (SELECT sum(cs_base) FROM m),
  'class_sessions_master_bonus_sum', (SELECT sum(cs_bonus) FROM m),
  'historical_not_from_master', (
    SELECT count(*) FROM public.class_sessions cs
     WHERE cs.source = 'historical_import'
       AND NOT EXISTS (SELECT 1 FROM public.salary_master_rows x WHERE x.class_session_id = cs.id)
  ),
  'instructor_match', (
    SELECT jsonb_object_agg(coalesce(instructor_match, '(null)'), c)
      FROM (SELECT instructor_match, count(*) AS c FROM m GROUP BY 1) x
  ),
  'unmatched_names', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('name', instructor_name, 'rows', c, 'match', instructor_match) ORDER BY c DESC), '[]'::jsonb)
      FROM (SELECT instructor_name, instructor_match, count(*) AS c FROM m
             WHERE instructor_match IS DISTINCT FROM 'matched' GROUP BY 1, 2) x
  ),
  'teacher_visible_rows', (
    SELECT count(*) FROM m
     WHERE cs_instructor IS NOT NULL AND cs_date >= public.instructor_salary_visible_from()
  ),
  'master_rows_by_month', (
    SELECT jsonb_object_agg(mo, c ORDER BY mo)
      FROM (SELECT to_char(cs_date, 'YYYY-MM') AS mo, count(*) AS c FROM m GROUP BY 1) x
  ),
  'date_fixed_rows', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'from', original_date, 'to', cs_date) ORDER BY row_no::int), '[]'::jsonb)
      FROM m WHERE date_fixed = 'true'
  ),
  'quarantine', (
    SELECT jsonb_build_object(
      'rows', count(*),
      'matched_in_master', count(*) FILTER (WHERE matched_master_row_no IS NOT NULL),
      'not_in_master', count(*) FILTER (WHERE matched_master_row_no IS NULL),
      'base_salary_sum', sum(base_salary),
      'bonus_sum', sum(bonus),
      'date_min', min(session_date),
      'date_max', max(session_date))
    FROM q
  ),
  'quarantine_not_in_master_by_year', (
    SELECT jsonb_object_agg(y, c ORDER BY y)
      FROM (SELECT to_char(session_date, 'YYYY') AS y, count(*) AS c FROM q
             WHERE matched_master_row_no IS NULL GROUP BY 1) x
  ),
  'anomaly_now', (
    SELECT jsonb_build_object('flagged', count(*) FILTER (WHERE is_anomaly), 'total', count(*))
      FROM public.class_sessions
  ),
  'anomaly_reasons_now', (
    SELECT jsonb_object_agg(r, c)
      FROM (SELECT unnest(anomaly_reasons) AS r, count(*) AS c FROM public.class_sessions GROUP BY 1) x
  )
)) AS postcheck;
