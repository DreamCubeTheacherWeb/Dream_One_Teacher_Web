-- 薪資總表換新 2026-10-19｜步驟 1：線上唯讀預檢（只有 SELECT，不改任何資料）
-- 在 Supabase SQL Editor 整段執行，結果是一個 JSON。
SELECT jsonb_pretty(jsonb_build_object(
  'checked_at', now(),
  'by_source', (
    SELECT jsonb_object_agg(coalesce(source, '(null)'), c)
      FROM (SELECT source, count(*) AS c FROM public.class_sessions GROUP BY source) s
  ),
  'historical', (
    SELECT jsonb_build_object(
      'rows', count(*),
      'base_salary_sum', sum(base_salary),
      'bonus_sum', sum(bonus),
      'paid_sum', sum(paid_amount),
      'date_min', min(session_date),
      'date_max', max(session_date),
      'created_min', min(created_at),
      'created_max', max(created_at),
      'updated_max', max(updated_at),
      'touched_approved_by', count(*) FILTER (WHERE approved_by IS NOT NULL),
      'touched_approved_at', count(*) FILTER (WHERE approved_at IS NOT NULL),
      'touched_paid_at', count(*) FILTER (WHERE paid_at IS NOT NULL),
      'touched_rate_card', count(*) FILTER (WHERE rate_card_id IS NOT NULL),
      'touched_series', count(*) FILTER (WHERE series_id IS NOT NULL),
      'touched_registered_by', count(*) FILTER (WHERE registered_by IS NOT NULL),
      'touched_pricing_not_legacy', count(*) FILTER (WHERE pricing_status IS DISTINCT FROM 'legacy'),
      'touched_manual_adjustment', count(*) FILTER (WHERE manual_adjustment_reason IS NOT NULL),
      'updated_1h_after_created', count(*) FILTER (WHERE updated_at > created_at + interval '1 hour')
    )
    FROM public.class_sessions WHERE source = 'historical_import'
  ),
  'non_historical_rows', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'source', source, 'name', instructor_name, 'date', session_date, 'type', course_type,
             'course', course_name, 'base', base_salary, 'bonus', bonus, 'status', status,
             'pricing', pricing_status, 'created', created_at) ORDER BY session_date), '[]'::jsonb)
      FROM (SELECT * FROM public.class_sessions
             WHERE source IS DISTINCT FROM 'historical_import'
             ORDER BY session_date LIMIT 200) n
  ),
  'fk_into_class_sessions', (
    SELECT coalesce(jsonb_agg(conrelid::regclass::text || '.' || conname || ' ON DELETE ' || confdeltype::text), '[]'::jsonb)
      FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.class_sessions'::regclass
  ),
  'triggers', (
    SELECT jsonb_agg(tgname ORDER BY tgname)
      FROM pg_trigger WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal
  ),
  'generated_columns', (
    SELECT jsonb_agg(column_name ORDER BY ordinal_position)
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'class_sessions' AND is_generated = 'ALWAYS'
  ),
  'column_count', (
    SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'class_sessions'
  ),
  'anomaly', (
    SELECT jsonb_build_object('flagged', count(*) FILTER (WHERE is_anomaly), 'total', count(*))
      FROM public.class_sessions
  ),
  'anomaly_reasons', (
    SELECT jsonb_object_agg(r, c)
      FROM (SELECT unnest(anomaly_reasons) AS r, count(*) AS c FROM public.class_sessions GROUP BY 1) x
  ),
  'instructors', (SELECT count(*) FROM public.instructors),
  'instructor_duplicate_names', (
    SELECT coalesce(jsonb_agg(n ORDER BY n), '[]'::jsonb)
      FROM (SELECT trim(full_name) AS n FROM public.instructors GROUP BY 1 HAVING count(*) > 1) d
  ),
  'staging_exists', to_regclass('public.salary_master_rows') IS NOT NULL,
  'quarantine_exists', to_regclass('public.class_sessions_quarantine') IS NOT NULL,
  'visible_from', public.instructor_salary_visible_from()
)) AS preflight;
