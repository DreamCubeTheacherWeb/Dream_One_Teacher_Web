-- ═══════════════════════════════════════════════════════════════════
-- 薪資總表換新（2026-10-19）：新總表暫存表＋舊資料隔離區
--   業主 2026-10-19 指示：「這份薪資資料確定正確，之前有異常的資料先獨立隔離起來，
--   之後再整理；先以這份為最新的讓大家可以查詢」，並同意：舊匯入整批搬隔離區、
--   新表整份匯入、22 筆打錯的年份更正並把原日期留在備註。
--
--   本檔只建「結構」，不搬也不改任何資料：
--   ① salary_master_rows：新總表逐列原文＋換算後欄位（由後台 Table Editor 匯入 CSV），
--      class_session_id 預先產生，匯入 class_sessions 時沿用，日後可逐列追回原文。
--   ② class_sessions_quarantine：舊匯入資料的隔離區，欄位複製自 class_sessions，
--      另加批次、原因、時間與「新總表對應列號」。必須是另一張表：
--      detect_session_anomaly 的「疑似重複」規則會拿整張 class_sessions 比對，
--      舊列若只加標記留在原表，會讓新匯入的每一列都被誤標重複。
--   兩張表只有 admin 能讀；寫入只透過 SQL Editor（postgres 身分），網站端沒有寫入權限。
--   搬移與匯入的資料操作見 scripts/salary_master_import/（03_apply.sql，單一交易、可還原）。
-- 本檔可重複執行。
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.salary_master_rows (
  class_session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch            text NOT NULL,
  row_no           text NOT NULL,
  -- 總表原文（逐字保留）
  raw_month        text,
  raw_instructor   text,
  raw_course_kind  text,
  raw_date         text,
  raw_registrar    text,
  raw_level        text,
  raw_course_name  text,
  raw_notes        text,
  raw_hours        text,
  raw_students     text,
  raw_salary       text,
  raw_bonus        text,
  raw_paid         text,
  raw_self_review  text,
  raw_progress     text,
  raw_incident     text,
  -- 換算後欄位（規則同 scripts/import_salary_history.py；全部以文字上傳，匯入時才轉型）
  course_type            text,
  role_in_session        text,
  instructor_name        text,
  instructor_role_at_time text,
  session_date           text,
  course_name            text,
  notes                  text,
  duration_hours         text,
  student_count          text,
  base_salary            text,
  bonus                  text,
  paid_amount            text,
  status                 text,
  registered_by_name     text,
  self_review            text,
  progress_note          text,
  incident_report        text,
  date_fixed             text,
  original_date          text,
  -- 匯入時填寫
  instructor_id    uuid,
  instructor_match text,
  imported_at      timestamptz,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salary_master_rows_batch_row_key UNIQUE (batch, row_no)
);

COMMENT ON TABLE public.salary_master_rows IS
  '薪資總表逐列原文與換算欄位（2026-10-19 起）。class_session_id 即匯入 class_sessions 時使用的 id。只有 admin 可讀。';

-- 不含 INCLUDING GENERATED：month_label／total_salary 在隔離區是一般欄位，保留搬入當下的值
CREATE TABLE IF NOT EXISTS public.class_sessions_quarantine
  (LIKE public.class_sessions INCLUDING DEFAULTS);

ALTER TABLE public.class_sessions_quarantine
  ADD COLUMN IF NOT EXISTS quarantine_batch      text,
  ADD COLUMN IF NOT EXISTS quarantine_reason     text,
  ADD COLUMN IF NOT EXISTS quarantined_at        timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS matched_master_row_no text;

CREATE UNIQUE INDEX IF NOT EXISTS class_sessions_quarantine_batch_id_key
  ON public.class_sessions_quarantine (quarantine_batch, id);
CREATE INDEX IF NOT EXISTS class_sessions_quarantine_matched_idx
  ON public.class_sessions_quarantine (quarantine_batch, (matched_master_row_no IS NULL));

COMMENT ON TABLE public.class_sessions_quarantine IS
  '從 class_sessions 隔離出來待整理的薪資紀錄（不刪除）。matched_master_row_no 有值＝新總表有一模一樣的列。只有 admin 可讀。';

-- ── 權限：只有 admin 可讀，網站端不可寫
ALTER TABLE public.salary_master_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_sessions_quarantine ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.salary_master_rows FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.class_sessions_quarantine FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.salary_master_rows TO authenticated;
GRANT SELECT ON public.class_sessions_quarantine TO authenticated;

DROP POLICY IF EXISTS "Admins can view salary master rows" ON public.salary_master_rows;
CREATE POLICY "Admins can view salary master rows"
  ON public.salary_master_rows FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can view quarantined sessions" ON public.class_sessions_quarantine;
CREATE POLICY "Admins can view quarantined sessions"
  ON public.class_sessions_quarantine FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

NOTIFY pgrst, 'reload schema';
