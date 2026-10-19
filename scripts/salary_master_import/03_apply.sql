-- 薪資總表換新 2026-10-19｜步驟 3：搬隔離區＋匯入新總表（單一交易）
-- 前提：已套 migration 20261019120000_salary_master_quarantine.sql，且 02_check_upload.sql 全數符合預期。
-- 任何一個檢查不符就 RAISE EXCEPTION，整個交易回滾、資料庫維持原樣。
-- 只動 source = 'historical_import' 的列；講師在網站回報（self_report）與後台手動登記（manual）的列完全不碰。
-- 還原見 99_rollback.sql。

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '10min';
-- 擋住交易期間的其他寫入，確保搬移筆數與檢查一致（交易結束即釋放）
LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_batch      constant text := '2026-10-19';
  v_qbatch     constant text := '2026-05 舊總表匯入（2026-10-19 隔離）';
  v_reason     constant text := '2026-05 從舊總表「所有薪資登記」一次匯入；業主 2026-10-19 指示改以新總表為準，舊資料隔離待整理';
  v_rows_exp   constant int := 5535;
  v_sum_exp    constant text := '9f352eadbbd4e1947b9b78f624483b58';
  v_base_exp   constant numeric := 10271061;
  v_bonus_exp  constant numeric := 453547;
  v_rows       int;
  v_checksum   text;
  v_hist       int;
  v_moved      int;
  v_deleted    int;
  v_inserted   int;
  v_matched    int;
  v_base       numeric;
  v_bonus      numeric;
  v_cols       text;
BEGIN
  -- 1. 暫存表必須正好是這次上傳的 5,535 筆，且原文與本機 CSV 逐字相同
  SELECT count(*),
         md5(string_agg(concat_ws(E'\x1f', row_no,
               coalesce(raw_month, ''), coalesce(raw_instructor, ''), coalesce(raw_course_kind, ''),
               coalesce(raw_date, ''), coalesce(raw_registrar, ''), coalesce(raw_level, ''),
               coalesce(raw_course_name, ''), coalesce(raw_notes, ''), coalesce(raw_hours, ''),
               coalesce(raw_students, ''), coalesce(raw_salary, ''), coalesce(raw_bonus, ''),
               coalesce(raw_paid, ''), coalesce(raw_self_review, ''), coalesce(raw_progress, ''),
               coalesce(raw_incident, '')), E'\n' ORDER BY row_no::int))
    INTO v_rows, v_checksum
    FROM public.salary_master_rows WHERE batch = v_batch;
  IF v_rows <> v_rows_exp OR v_checksum IS DISTINCT FROM v_sum_exp THEN
    RAISE EXCEPTION '暫存表與本機 CSV 不符：筆數 %（應為 %）、checksum %（應為 %）', v_rows, v_rows_exp, v_checksum, v_sum_exp;
  END IF;
  IF EXISTS (SELECT 1 FROM public.salary_master_rows WHERE batch = v_batch AND imported_at IS NOT NULL) THEN
    RAISE EXCEPTION '批次 % 已經匯入過，不可重複執行（要重來請先跑 99_rollback.sql）', v_batch;
  END IF;
  IF EXISTS (SELECT 1 FROM public.class_sessions_quarantine WHERE quarantine_batch = v_qbatch) THEN
    RAISE EXCEPTION '隔離批次「%」已存在，不可重複搬移', v_qbatch;
  END IF;
  IF EXISTS (SELECT 1 FROM public.class_sessions cs
               JOIN public.salary_master_rows m ON m.class_session_id = cs.id) THEN
    RAISE EXCEPTION '預先產生的 class_session_id 與既有紀錄衝突';
  END IF;

  -- 2. 講師對應：名字（去前後空白）在 instructors 裡恰好一位才帶 instructor_id，同名多位或找不到都留空
  UPDATE public.salary_master_rows m
     SET instructor_id = NULL,
         instructor_match = CASE WHEN i.c = 1 THEN 'matched' WHEN i.c > 1 THEN 'ambiguous' ELSE 'unmatched' END
    FROM (SELECT mm.class_session_id, count(ins.id) AS c
            FROM public.salary_master_rows mm
            LEFT JOIN public.instructors ins ON trim(ins.full_name) = mm.instructor_name
           WHERE mm.batch = v_batch
           GROUP BY mm.class_session_id) i
   WHERE m.class_session_id = i.class_session_id;
  UPDATE public.salary_master_rows m
     SET instructor_id = ins.id
    FROM public.instructors ins
   WHERE m.batch = v_batch AND m.instructor_match = 'matched' AND trim(ins.full_name) = m.instructor_name;
  -- 同名多位時：若 5 月舊紀錄裡這個名字一律掛在同一位講師，就沿用那一位（維持現狀，不另做判斷）；否則留空
  UPDATE public.salary_master_rows m
     SET instructor_id = p.instructor_id, instructor_match = 'matched_previous'
    FROM (SELECT instructor_name, min(instructor_id::text)::uuid AS instructor_id
            FROM public.class_sessions
           WHERE source = 'historical_import' AND instructor_id IS NOT NULL
           GROUP BY instructor_name
          HAVING count(DISTINCT instructor_id) = 1) p
   WHERE m.batch = v_batch AND m.instructor_match = 'ambiguous' AND p.instructor_name = m.instructor_name
     AND EXISTS (SELECT 1 FROM public.instructors ins
                  WHERE ins.id = p.instructor_id AND trim(ins.full_name) = m.instructor_name);

  -- 3. 舊匯入整批搬到隔離區（欄位動態取兩表共有者，含當下的 month_label／total_salary 值）
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
    FROM information_schema.columns c
    JOIN information_schema.columns q
      ON q.table_schema = 'public' AND q.table_name = 'class_sessions_quarantine' AND q.column_name = c.column_name
   WHERE c.table_schema = 'public' AND c.table_name = 'class_sessions';

  SELECT count(*) INTO v_hist FROM public.class_sessions WHERE source = 'historical_import';

  EXECUTE format(
    'INSERT INTO public.class_sessions_quarantine (%s, quarantine_batch, quarantine_reason) '
    'SELECT %s, $1, $2 FROM public.class_sessions WHERE source = ''historical_import''',
    v_cols, v_cols)
  USING v_qbatch, v_reason;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  DELETE FROM public.class_sessions cs
   USING public.class_sessions_quarantine q
   WHERE q.quarantine_batch = v_qbatch AND q.id = cs.id AND cs.source = 'historical_import';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_moved <> v_hist OR v_deleted <> v_hist
     OR EXISTS (SELECT 1 FROM public.class_sessions WHERE source = 'historical_import') THEN
    RAISE EXCEPTION '搬移筆數不符：原有 %、搬入 %、刪除 %', v_hist, v_moved, v_deleted;
  END IF;

  -- 4. 新總表整份匯入（依來源列號順序，與 5 月那次相同的欄位寫法；id 沿用暫存表預先產生的值）
  INSERT INTO public.class_sessions (
    id, course_type, course_name, location, instructor_id, instructor_name, role_in_session,
    instructor_role_at_time, session_date, duration_hours, student_count, base_salary, bonus,
    paid_amount, status, registered_by_name, self_review, progress_note, incident_report, notes, source)
  SELECT m.class_session_id,
         m.course_type,
         nullif(m.course_name, ''),
         NULL,
         m.instructor_id,
         m.instructor_name,
         m.role_in_session::public.session_role_enum,
         nullif(m.instructor_role_at_time, ''),
         m.session_date::date,
         nullif(m.duration_hours, '')::numeric,
         nullif(m.student_count, '')::int,
         coalesce(nullif(m.base_salary, ''), '0')::numeric,
         coalesce(nullif(m.bonus, ''), '0')::numeric,
         coalesce(nullif(m.paid_amount, ''), '0')::numeric,
         m.status::public.session_status_enum,
         nullif(m.registered_by_name, ''),
         nullif(m.self_review, ''),
         nullif(m.progress_note, ''),
         nullif(m.incident_report, ''),
         nullif(m.notes, ''),
         'historical_import'
    FROM public.salary_master_rows m
   WHERE m.batch = v_batch
   ORDER BY m.row_no::int;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT sum(cs.base_salary), sum(cs.bonus)
    INTO v_base, v_bonus
    FROM public.class_sessions cs
    JOIN public.salary_master_rows m ON m.class_session_id = cs.id AND m.batch = v_batch;
  IF v_inserted <> v_rows_exp OR v_base <> v_base_exp OR v_bonus <> v_bonus_exp THEN
    RAISE EXCEPTION '匯入結果不符：筆數 %（應為 %）、薪資合計 %（應為 %）、獎金合計 %（應為 %）',
      v_inserted, v_rows_exp, v_base, v_base_exp, v_bonus, v_bonus_exp;
  END IF;

  UPDATE public.salary_master_rows SET imported_at = now() WHERE batch = v_batch;

  -- 5. 隔離區標註：舊列在新總表有一模一樣的列（以匯入後的同型別欄位比對；年份更正的列用原登記日期、
  --    備註去掉更正說明），就記下對應的來源列號；同內容多筆時一對一配對
  WITH q AS (
    SELECT id, k, row_number() OVER (PARTITION BY k ORDER BY id) AS rn
      FROM (SELECT id,
                   md5(row(instructor_name, session_date, course_type, role_in_session, course_name, notes,
                           duration_hours, student_count, base_salary, bonus, paid_amount,
                           registered_by_name, self_review, progress_note, incident_report,
                           instructor_role_at_time)::text) AS k
              FROM public.class_sessions_quarantine
             WHERE quarantine_batch = v_qbatch) a
  ),
  n AS (
    SELECT row_no, k, row_number() OVER (PARTITION BY k ORDER BY row_no::int) AS rn
      FROM (SELECT m.row_no,
                   md5(row(cs.instructor_name,
                           CASE WHEN m.date_fixed = 'true' THEN to_date(m.original_date, 'YYYY/MM/DD') ELSE cs.session_date END,
                           cs.course_type, cs.role_in_session, cs.course_name,
                           CASE WHEN m.date_fixed = 'true'
                                THEN nullif(regexp_replace(cs.notes, ' ?［原登記日期 [^］]*］$', ''), '')
                                ELSE cs.notes END,
                           cs.duration_hours, cs.student_count, cs.base_salary, cs.bonus, cs.paid_amount,
                           cs.registered_by_name, cs.self_review, cs.progress_note, cs.incident_report,
                           cs.instructor_role_at_time)::text) AS k
              FROM public.salary_master_rows m
              JOIN public.class_sessions cs ON cs.id = m.class_session_id
             WHERE m.batch = v_batch) b
  )
  UPDATE public.class_sessions_quarantine x
     SET matched_master_row_no = n.row_no
    FROM q JOIN n ON n.k = q.k AND n.rn = q.rn
   WHERE x.quarantine_batch = v_qbatch AND x.id = q.id;
  GET DIAGNOSTICS v_matched = ROW_COUNT;

  RAISE NOTICE '完成：隔離 % 筆（其中 % 筆在新總表有相同列）、匯入 % 筆，薪資 %、獎金 %',
    v_moved, v_matched, v_inserted, v_base, v_bonus;
END $$;

COMMIT;
