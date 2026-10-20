-- ════════════════════════════════════════════════════════════════
-- 06｜完全相同的重複列只留一筆＋2026-09-26 以前標為已付款（2026-10-20 業主指示）
-- ════════════════════════════════════════════════════════════════
-- 業主原話：「如果有兩筆一模一樣的資料選其中一筆就好」「9/26以後的才沒有付款，那之前都已經付款完了」。
--
-- 前提：migration 20261020150000_salary_anomaly_exact_duplicates.sql 已套用（新異常規則）。
-- 單一交易，任何一項核對不符就整批取消、資料不動：
--   1. 前置核對：新總表 5,535 筆、薪資＋獎金 10,724,608、已付款 3 筆、其餘已核准且已領金額 0。
--   2. 備份每筆的付款狀態與異常標記到 salary_cleanup_20261020_backup（只有資料庫擁有者讀得到），供還原。
--   3. 總表 16 欄原文完全相同的列（81 組、多出 91 筆、74,621 元）每組留來源列號最小的那筆，
--      其餘搬到隔離區 class_sessions_quarantine（不是刪除，可還原），matched_master_row_no＝留下那筆的列號。
--   4. 只動 source = 'historical_import'（業主的總表資料）：上課日期在 2026-09-26 以前、狀態為已核准者
--      → 已付款，已領金額＝總計，付款時間＝本次執行時間（5,435 筆）。網站回報與後台手動新增的紀錄不動。
--   5. 依新規則重算異常標記，事後核對筆數、金額、異常全部符合預期才提交。
-- 預演：把最下方 'apply' 改成 'dry-run'，跑到最後會拋出 DRY_RUN_OK（附統計）並整批取消。
-- 還原：96_rollback_dedupe_and_mark_paid.sql（資料；只還原 06 之後沒人再改過的列）＋97_restore_old_anomaly_rule.sql（舊規則）。

BEGIN;

LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

-- ── 1. 前置核對
DO $$
DECLARE
  v_src text;
  r record;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.detect_session_anomaly()'::regprocedure;
  IF position('內容完全相同' IN v_src) = 0 THEN
    RAISE EXCEPTION '請先套用 migration 20261020150000（新異常規則）';
  END IF;
  -- 一次改五千多筆：正式庫若有版控外的 trigger（例如改成已付款就發通知），先停下來查清楚
  SELECT string_agg(tgname, ', ' ORDER BY tgname) INTO v_src
    FROM pg_trigger
   WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal
     AND tgname NOT IN ('trg_class_sessions_updated_at', 'trg_session_anomaly', 'trg_guard_class_session_pricing');
  IF v_src IS NOT NULL THEN
    RAISE EXCEPTION 'class_sessions 有預期以外的 trigger：%，停止', v_src;
  END IF;
  -- 要刪 91 筆：若有表用外鍵（含 ON DELETE CASCADE）指向 class_sessions，會連帶刪掉或擋住，先停下來查清楚
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ') INTO v_src
    FROM pg_constraint WHERE confrelid = 'public.class_sessions'::regclass;
  IF v_src IS NOT NULL THEN
    RAISE EXCEPTION '有外鍵指向 class_sessions：%，停止', v_src;
  END IF;
  IF to_regclass('public.salary_cleanup_20261020_backup') IS NOT NULL THEN
    RAISE EXCEPTION '已經執行過（備份表 salary_cleanup_20261020_backup 已存在）';
  END IF;
  IF EXISTS (SELECT 1 FROM public.class_sessions_quarantine
              WHERE quarantine_batch = '2026-10-20 完全相同重複列（業主指示只留一筆）') THEN
    RAISE EXCEPTION '已經執行過（隔離批次已存在）';
  END IF;

  SELECT count(*) AS n,
         coalesce(sum(total_salary), 0) AS total,
         count(*) FILTER (WHERE status = 'paid') AS paid_n,
         coalesce(sum(paid_amount) FILTER (WHERE status = 'paid'), 0) AS paid_sum,
         count(*) FILTER (WHERE status = 'approved') AS approved_n,
         count(*) FILTER (WHERE status = 'approved' AND (coalesce(paid_amount, 0) <> 0 OR paid_at IS NOT NULL)) AS approved_dirty,
         count(*) FILTER (WHERE pricing_status IS DISTINCT FROM 'legacy') AS not_legacy
    INTO r
    FROM public.class_sessions
   WHERE source = 'historical_import';

  IF r.n <> 5535 OR r.total <> 10724608 OR r.paid_n <> 3 OR r.paid_sum <> 6000
     OR r.approved_n <> 5532 OR r.approved_dirty <> 0 OR r.not_legacy <> 0 THEN
    RAISE EXCEPTION '前置核對不符：筆數 %（應 5535）、總計 %（應 10724608）、已付款 % 筆 % 元（應 3 筆 6000）、已核准 %（應 5532）、已核准但有付款資料 %（應 0）、非 legacy 定價 %（應 0）',
      r.n, r.total, r.paid_n, r.paid_sum, r.approved_n, r.approved_dirty, r.not_legacy;
  END IF;
END $$;

-- ── 2. 備份（還原用；只有資料庫擁有者讀得到）
-- cleanup_run_at＝本次執行時間（06 改過的列 updated_at 都會等於它）；touched＝06 有改到這一列（最後一步填）
CREATE TABLE public.salary_cleanup_20261020_backup AS
  SELECT id, status, paid_amount, paid_at, is_anomaly, anomaly_reasons, updated_at,
         now() AS cleanup_run_at, false AS touched
    FROM public.class_sessions;
ALTER TABLE public.salary_cleanup_20261020_backup ADD PRIMARY KEY (id);
ALTER TABLE public.salary_cleanup_20261020_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.salary_cleanup_20261020_backup FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.salary_cleanup_20261020_backup IS
  '2026-10-20 去重＋標已付款之前的付款狀態與異常標記備份；還原用 96_rollback_dedupe_and_mark_paid.sql。網站端讀不到。';

-- ── 3. 找出總表原文完全相同的列（每組留列號最小的那筆）
CREATE TEMP TABLE _dup ON COMMIT DROP AS
WITH m AS (
  SELECT row_no::int AS row_no, class_session_id,
         min(row_no::int) OVER (PARTITION BY
           coalesce(raw_month, ''), coalesce(raw_instructor, ''), coalesce(raw_course_kind, ''),
           coalesce(raw_date, ''), coalesce(raw_registrar, ''), coalesce(raw_level, ''),
           coalesce(raw_course_name, ''), coalesce(raw_notes, ''), coalesce(raw_hours, ''),
           coalesce(raw_students, ''), coalesce(raw_salary, ''), coalesce(raw_bonus, ''),
           coalesce(raw_paid, ''), coalesce(raw_self_review, ''), coalesce(raw_progress, ''),
           coalesce(raw_incident, '')) AS keep_row_no
    FROM public.salary_master_rows
   WHERE batch = '2026-10-19'
)
SELECT m.row_no, m.class_session_id AS id, m.keep_row_no, k.class_session_id AS keep_id
  FROM m
  JOIN public.salary_master_rows k ON k.batch = '2026-10-19' AND k.row_no::int = m.keep_row_no
 WHERE m.row_no <> m.keep_row_no;

DO $$
DECLARE
  r record;
  v_mismatch int;
  v_cols text;
  v_sel text;
  v_moved int;
  v_deleted int;
BEGIN
  SELECT count(*) AS n, count(DISTINCT d.keep_row_no) AS groups,
         count(cs.id) AS found,
         coalesce(sum(cs.total_salary), 0) AS total,
         count(*) FILTER (WHERE cs.status = 'approved' AND cs.session_date < DATE '2026-09-26'
                            AND cs.source = 'historical_import') AS approved_before
    INTO r
    FROM _dup d
    LEFT JOIN public.class_sessions cs ON cs.id = d.id;
  IF r.n <> 91 OR r.groups <> 81 OR r.found <> 91 OR r.total <> 74621 OR r.approved_before <> 91 THEN
    RAISE EXCEPTION '重複列核對不符：% 筆（應 91）、% 組（應 81）、在 class_sessions 找到 %、金額 %（應 74621）、9/26 前已核准 %（應 91）',
      r.n, r.groups, r.found, r.total, r.approved_before;
  END IF;

  -- 要搬走的每一筆，網站上的內容必須與留下的那筆完全相同
  SELECT count(*) INTO v_mismatch
    FROM _dup d
    JOIN public.class_sessions a ON a.id = d.id
    LEFT JOIN public.class_sessions b ON b.id = d.keep_id
   WHERE b.id IS NULL
      OR row(a.instructor_id, a.instructor_name, a.session_date, a.course_type, a.course_name, a.location,
             a.role_in_session, a.instructor_role_at_time, a.duration_hours, a.student_count, a.base_salary,
             a.bonus, a.paid_amount, a.status, a.registered_by_name, a.self_review, a.progress_note,
             a.incident_report, a.notes, a.source)
         IS DISTINCT FROM
         row(b.instructor_id, b.instructor_name, b.session_date, b.course_type, b.course_name, b.location,
             b.role_in_session, b.instructor_role_at_time, b.duration_hours, b.student_count, b.base_salary,
             b.bonus, b.paid_amount, b.status, b.registered_by_name, b.self_review, b.progress_note,
             b.incident_report, b.notes, b.source);
  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION '有 % 筆重複列與留下的那筆內容不同，停止', v_mismatch;
  END IF;

  -- 隔離區沒有的欄位（例如之後新增的 extra_fields）在要搬的列上必須是空的，否則會遺失資料
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'class_sessions'
       AND c.column_name = 'extra_fields'
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns q
                        WHERE q.table_schema = 'public' AND q.table_name = 'class_sessions_quarantine'
                          AND q.column_name = 'extra_fields')
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.class_sessions cs JOIN _dup d ON d.id = cs.id WHERE cs.extra_fields IS NOT NULL'
       INTO v_mismatch;
    IF v_mismatch <> 0 THEN
      RAISE EXCEPTION '有 % 筆要搬的列帶有 extra_fields，隔離區沒有此欄，停止', v_mismatch;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'class_sessions'
       AND c.column_name NOT IN ('extra_fields')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns q
                        WHERE q.table_schema = 'public' AND q.table_name = 'class_sessions_quarantine'
                          AND q.column_name = c.column_name)
  ) THEN
    RAISE EXCEPTION 'class_sessions 有隔離區沒有的欄位，請先補齊隔離區結構';
  END IF;

  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position),
         string_agg('cs.' || quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols, v_sel
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'class_sessions'
     AND EXISTS (SELECT 1 FROM information_schema.columns q
                  WHERE q.table_schema = 'public' AND q.table_name = 'class_sessions_quarantine'
                    AND q.column_name = c.column_name);

  EXECUTE format(
    'INSERT INTO public.class_sessions_quarantine (%s, quarantine_batch, quarantine_reason, matched_master_row_no) '
    'SELECT %s, $1, ''總表第 '' || d.row_no || '' 列與第 '' || d.keep_row_no || '' 列完全相同，業主 2026-10-20 指示只留第 '' || d.keep_row_no || '' 列'', d.keep_row_no::text '
    'FROM public.class_sessions cs JOIN _dup d ON d.id = cs.id',
    v_cols, v_sel)
  USING '2026-10-20 完全相同重複列（業主指示只留一筆）';
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  DELETE FROM public.class_sessions cs USING _dup d WHERE cs.id = d.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_moved <> 91 OR v_deleted <> 91 THEN
    RAISE EXCEPTION '搬移筆數不符：搬入隔離區 %、刪除 %（皆應 91）', v_moved, v_deleted;
  END IF;
END $$;

-- ── 4. 2026-09-26 以前的總表資料標為已付款（同時依新規則重算這些列的異常標記）
DO $$
DECLARE
  v_n int;
  v_sum numeric;
BEGIN
  SELECT count(*), coalesce(sum(total_salary), 0) INTO v_n, v_sum
    FROM public.class_sessions
   WHERE source = 'historical_import' AND status = 'approved' AND session_date < DATE '2026-09-26';
  IF v_n <> 5435 OR v_sum <> 10636401 THEN
    RAISE EXCEPTION '待標已付款筆數不符：% 筆 % 元（應 5435 筆 10636401 元）', v_n, v_sum;
  END IF;

  UPDATE public.class_sessions
     SET status = 'paid', paid_amount = total_salary, paid_at = now()
   WHERE source = 'historical_import' AND status = 'approved' AND session_date < DATE '2026-09-26';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 5435 THEN
    RAISE EXCEPTION '標已付款筆數不符：%（應 5435）', v_n;
  END IF;
END $$;

-- ── 5. 其餘總表資料與目前有異常標記的列也依新規則重算（只會改 is_anomaly／anomaly_reasons）
UPDATE public.class_sessions
   SET updated_at = updated_at
 WHERE (source = 'historical_import' OR is_anomaly)
   AND paid_at IS DISTINCT FROM now();

-- 記下 06 改到的列（步驟 4、5 的列 updated_at 都被 trigger 設成本次執行時間），96 只還原這些、且之後沒人再改過的
UPDATE public.salary_cleanup_20261020_backup b
   SET touched = true
  FROM public.class_sessions cs
 WHERE cs.id = b.id AND cs.updated_at = b.cleanup_run_at;

-- ── 6. 事後核對（不符就整批取消），預演模式在這裡拋出 DRY_RUN_OK
SELECT set_config('salary_cleanup.mode', 'apply', true);

DO $$
DECLARE
  r record;
  v_expected_flag int;
  v_unexpected int;
  v_touched int;
  v_summary text;
BEGIN
  SELECT count(*) AS n,
         coalesce(sum(total_salary), 0) AS total,
         count(*) FILTER (WHERE status = 'paid') AS paid_n,
         coalesce(sum(paid_amount) FILTER (WHERE status = 'paid'), 0) AS paid_sum,
         count(*) FILTER (WHERE status <> 'paid') AS unpaid_n,
         coalesce(sum(total_salary) FILTER (WHERE status <> 'paid'), 0) AS unpaid_sum,
         count(*) FILTER (WHERE status <> 'paid' AND session_date < DATE '2026-09-26') AS unpaid_before,
         count(*) FILTER (WHERE status = 'paid' AND session_date >= DATE '2026-09-26') AS paid_after,
         count(*) FILTER (WHERE is_anomaly) AS anomaly_n
    INTO r
    FROM public.class_sessions
   WHERE source = 'historical_import';

  -- 新規則下唯一剩下的疑似重複：曾瑀希 2026-03-27 南瓜田 960 兩筆（總表第 3222、3622 列，只差登記人欄一個空白一個 SEP）
  SELECT CASE WHEN count(*) FILTER (WHERE cs.instructor_id IS NOT NULL) = 2 THEN 2 ELSE 0 END
    INTO v_expected_flag
    FROM public.salary_master_rows m
    JOIN public.class_sessions cs ON cs.id = m.class_session_id
   WHERE m.batch = '2026-10-19' AND m.row_no IN ('3222', '3622');

  SELECT count(*) INTO v_unexpected
    FROM public.class_sessions cs
   WHERE cs.source = 'historical_import' AND cs.is_anomaly
     AND cs.id NOT IN (SELECT class_session_id FROM public.salary_master_rows
                        WHERE batch = '2026-10-19' AND row_no IN ('3222', '3622'));

  SELECT count(*) INTO v_touched
    FROM public.salary_cleanup_20261020_backup b
    JOIN public.class_sessions cs ON cs.id = b.id
   WHERE b.touched AND cs.source = 'historical_import';

  v_summary := format('總表 %s 筆、總計 %s；已付款 %s 筆 %s 元；未付款 %s 筆 %s 元；異常 %s 筆（應 %s）；隔離區本批 %s 筆',
    r.n, r.total, r.paid_n, r.paid_sum, r.unpaid_n, r.unpaid_sum, r.anomaly_n, v_expected_flag,
    (SELECT count(*) FROM public.class_sessions_quarantine
      WHERE quarantine_batch = '2026-10-20 完全相同重複列（業主指示只留一筆）'));

  IF r.n <> 5444 OR r.total <> 10649987 OR r.paid_n <> 5438 OR r.paid_sum <> 10642401
     OR r.unpaid_n <> 6 OR r.unpaid_sum <> 7586 OR r.unpaid_before <> 0 OR r.paid_after <> 0
     OR r.anomaly_n <> v_expected_flag OR v_unexpected <> 0 OR v_touched <> 5444 THEN
    RAISE EXCEPTION '事後核對不符，已取消：%（9/26 前未付款 %、9/26 後已付款 %、非預期異常 %、備份標記改過 %／應 5444）',
      v_summary, r.unpaid_before, r.paid_after, v_unexpected, v_touched;
  END IF;

  IF current_setting('salary_cleanup.mode') = 'dry-run' THEN
    RAISE EXCEPTION 'DRY_RUN_OK %', v_summary;
  END IF;
  RAISE NOTICE 'APPLY_OK %', v_summary;
END $$;

COMMIT;
