-- ═══════════════════════════════════════════════════════════════════
-- 2026-10-22 月結匯款：下載轉帳檔時存「匯出紀錄」，匯款完成後「對某一份匯出標記已付款」，可整份還原
--
--   取代從未套到正式庫的 20261021233000_mark_salary_period_paid（檔案已刪除）：它把「整期所有已核准」一起標已付款，
--   但轉帳檔會排除異常課、對不到講師、缺帳號／身分證被擋的講師、管理員排除的人，也不含匯出後才核准的紀錄
--   → 沒匯到的錢被標成已付款、之後不再出現在匯款檔＝永久漏匯。本檔開頭仍 DROP 它的兩個版本。
--   本檔的第一版（只把「網頁記憶體裡最後一次下載的清單」送去標）也被審查擋下：重新整理、隔天回來、匯出後才核准、
--   匯出後補好銀行資料 → 重新下載會用資料庫現況重算，可能把銀行沒匯的課標成已付款。所以改成「下載當下就把清單存進資料庫」。
--
--   salary_payout_exports         一次下載＝一筆匯出紀錄：期別、人數、筆數、課程應付合計、轉帳檔總額、每位講師的實付與人工調整、
--                                 下載當時沒納入的摘要、誰下載、何時；之後的標記與還原也記在這一列。
--   salary_payout_export_items    這份檔案納入的每一堂課：session_id、instructor_id、當時應付金額；
--                                 標記時補上標記前的 status／paid_amount／paid_at 與標記後的值（還原用）。
--     兩張表只有 admin 讀得到（mentor、講師、anon 都讀不到）；沒有任何直接寫入權限，只能經下面的函式寫。
--     session_id 不設外鍵：紀錄之後被刪除，匯出紀錄仍要留著（還原時回報「已不存在」）。
--
--   record_salary_payout_export(p_period_start, p_period_end, p_items, p_people, p_expected_total,
--                               p_pay_date, p_file_kind, p_exclusions) → 前端按下載時先呼叫，成功拿到匯出編號才產生檔案
--     p_items  ＝[{ "id": class_sessions.id, "instructor_id": 講師, "amount": 這一堂的本次應付 }, …]
--     p_people ＝[{ "instructor_id", "name", "amount": 這位的實付（＝他的課加總＋人工調整）, "adjustment", "adjustment_reason" }, …]
--     逐筆核對（salary_payout_item_mismatches）：仍是已核准、在期別內、講師相同、應付金額相同；任一不符 → 不存、回 ok=false 與原因。
--     另核對：每位講師的實付＝他的課加總＋人工調整、全部實付合計＝p_expected_total（轉帳檔總額）。
--   mark_salary_payout_export_paid(p_export_id, p_expected_count, p_expected_amount)
--     清單從資料庫那筆匯出紀錄拿（前端不送清單）；先鎖匯出紀錄與清單裡的列，再用同一套逐筆核對（含講師）。
--     任一不符 → 什麼都不改，回 ok=false 與原因。全部符合 → 同一交易內把這些列改成 paid、paid_at＝現在、
--     paid_amount＝GREATEST(已領, 總額)（已領超過總額的列不改小），記下標記前後的值，匯出紀錄記上標記人與時間。
--     一份匯出只能標一次；同一期兩份匯出有重疊的課，後標的那份會因為狀態已不是已核准而整份被擋（預期）。
--     擋下（22023）：找不到、已標記過、確認的筆數／金額和這份匯出不同、這一期還沒結束（迄日 ≥ 台北今天）。
--   revert_salary_payout_export(p_export_id)
--     只還原這份標的、而且之後沒被改過的列（status 仍是 paid，paid_amount、paid_at、updated_at 都還是標完當下的值）；
--     其他列回報原因、不動。可重跑。
--
--   三個函式：SECURITY DEFINER、search_path=''、只有 admin（其他人 42501）、anon／PUBLIC 不能執行。
--   可能為 NULL 的欄位一律用 IS DISTINCT FROM 比較（NULL <> 'approved' 會得到 NULL、被當成「沒有不符」而放行）。
--   class_sessions 的三個 trigger 照常跑（updated_at、異常標記、定價檢查），函式不停用任何 trigger。
--
-- 本檔可重複執行；整支在一個交易內（任何一句失敗整支取消）。
-- ═══════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── 0. 移除會「整期一起標」的舊函式（從未套到正式庫；保險起見仍移除）
DROP FUNCTION IF EXISTS public.mark_salary_period_paid(date, date);
DROP FUNCTION IF EXISTS public.mark_salary_period_paid(date, date, integer, numeric);
-- 本檔第一版（前端送清單）的兩個函式：從未套到任何正式庫；保險起見也移除，避免留下「吃前端清單」的入口
DROP FUNCTION IF EXISTS public.mark_salary_sessions_paid(date, date, jsonb, numeric, date, numeric, jsonb);
DROP FUNCTION IF EXISTS public.revert_salary_payout_batch(bigint);

-- ── 1. 匯出紀錄
CREATE TABLE IF NOT EXISTS public.salary_payout_exports (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  item_count        integer NOT NULL CHECK (item_count >= 0),
  people_count      integer NOT NULL CHECK (people_count > 0),
  total_amount      numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  transfer_total    numeric(14,2) NOT NULL,
  people            jsonb NOT NULL CHECK (jsonb_typeof(people) = 'array'),
  exclusions        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exclusions) = 'array'),
  pay_date          date,
  file_kind         text CHECK (file_kind IS NULL OR file_kind IN ('csv', 'xlsx')),
  exported_by       uuid,
  exported_by_name  text,
  exported_at       timestamptz NOT NULL DEFAULT now(),
  marked_at         timestamptz,
  marked_by         uuid,
  marked_by_name    text,
  marked_count      integer,
  marked_amount     numeric(14,2),
  reverted_count    integer NOT NULL DEFAULT 0 CHECK (reverted_count >= 0),
  reverted_amount   numeric(14,2) NOT NULL DEFAULT 0,
  reverted_at       timestamptz,
  reverted_by       uuid,
  reverted_by_name  text,
  CONSTRAINT salary_payout_exports_period_check CHECK (period_end >= period_start)
);

COMMENT ON TABLE public.salary_payout_exports IS
  '月結匯款：每次下載轉帳檔存一筆匯出紀錄（納入哪些課、每位講師實付），匯款完成後對這一筆標記已付款、可還原。只有 admin 可讀；只能經 record_salary_payout_export／mark_salary_payout_export_paid／revert_salary_payout_export 寫入。';
COMMENT ON COLUMN public.salary_payout_exports.total_amount IS '這份檔案納入的課程應付合計（各堂本次應付相加，不含人工調整）';
COMMENT ON COLUMN public.salary_payout_exports.transfer_total IS '轉帳檔總額（每位講師實付相加，含人工調整）';
COMMENT ON COLUMN public.salary_payout_exports.people IS '每位講師 [{instructor_id, name, amount 實付, adjustment 人工調整, adjustment_reason}]；人工調整只做紀錄，不寫進任何一堂課的已領金額';
COMMENT ON COLUMN public.salary_payout_exports.exclusions IS '下載當時沒有納入的摘要（文字，給確認框看）';

CREATE TABLE IF NOT EXISTS public.salary_payout_export_items (
  export_id        bigint NOT NULL REFERENCES public.salary_payout_exports (id) ON DELETE RESTRICT,
  session_id       uuid NOT NULL,
  instructor_id    uuid NOT NULL,
  amount           numeric(12,2) NOT NULL CHECK (amount >= 0),
  old_status       public.session_status_enum,
  old_paid_amount  numeric(10,2),
  old_paid_at      timestamptz,
  new_paid_amount  numeric(10,2),
  new_paid_at      timestamptz,
  new_updated_at   timestamptz,
  reverted_at      timestamptz,
  reverted_by      uuid,
  PRIMARY KEY (export_id, session_id)
);

COMMENT ON TABLE public.salary_payout_export_items IS
  '每份匯出納入的每一堂課（當時的講師與應付金額）；標記時補上標記前後的 status／paid_amount／paid_at／updated_at（還原用）。只有 admin 可讀。';

CREATE INDEX IF NOT EXISTS salary_payout_export_items_session_idx ON public.salary_payout_export_items (session_id);
CREATE INDEX IF NOT EXISTS salary_payout_exports_period_idx ON public.salary_payout_exports (period_start, period_end);

ALTER TABLE public.salary_payout_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_payout_export_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.salary_payout_exports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.salary_payout_export_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.salary_payout_exports TO authenticated;
GRANT SELECT ON TABLE public.salary_payout_export_items TO authenticated;

DO $$
DECLARE
  seq text := pg_get_serial_sequence('public.salary_payout_exports', 'id');
BEGIN
  IF seq IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', seq);
  END IF;
END $$;

DROP POLICY IF EXISTS "Admins can view salary payout exports" ON public.salary_payout_exports;
CREATE POLICY "Admins can view salary payout exports"
  ON public.salary_payout_exports FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can view salary payout export items" ON public.salary_payout_export_items;
CREATE POLICY "Admins can view salary payout export items"
  ON public.salary_payout_export_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

-- ── 2. 逐筆核對（存匯出與標記共用同一套規則）
--   p_items＝[{id, instructor_id, amount}, …]；回不符的清單（照 p_items 順序），全部符合回 []
--   讀的是呼叫當下的資料（標記時呼叫前已先鎖住這些列）。只給下面的 SECURITY DEFINER 函式內部使用。
CREATE OR REPLACE FUNCTION public.salary_payout_item_mismatches(p_items jsonb, p_period_start date, p_period_end date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH req AS (
    SELECT (e ->> 'id')::uuid AS id, (e ->> 'instructor_id')::uuid AS instructor_id, (e ->> 'amount')::numeric AS amount, ord
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ord)
  ), chk AS (
    SELECT r.id, r.instructor_id AS expected_instructor_id, r.amount, r.ord,
           cs.id AS found_id, cs.status, cs.session_date, cs.instructor_id, cs.instructor_name,
           GREATEST(COALESCE(cs.total_salary, 0) - COALESCE(cs.paid_amount, 0), 0) AS payable
      FROM req r
      LEFT JOIN public.class_sessions cs ON cs.id = r.id
  ), judged AS (
    SELECT chk.*,
           CASE
             WHEN found_id IS NULL THEN 'not_found'
             WHEN status IS DISTINCT FROM 'approved' THEN 'status'
             WHEN session_date IS NULL OR session_date < p_period_start OR session_date > p_period_end THEN 'period'
             WHEN instructor_id IS DISTINCT FROM expected_instructor_id THEN 'instructor'
             WHEN round(payable, 2) IS DISTINCT FROM round(amount, 2) THEN 'amount'
           END AS reason
      FROM chk
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', id,
           'reason', reason,
           'session_date', session_date,
           'instructor_name', instructor_name,
           'current_status', status,
           'expected_instructor_id', expected_instructor_id,
           'current_instructor_id', instructor_id,
           'expected_amount', amount,
           'current_amount', payable,
           'message', CASE reason
             WHEN 'not_found' THEN '找不到這筆紀錄（可能已刪除）'
             WHEN 'status' THEN format('狀態已不是「已核准」（現在：%s）',
               CASE status::text WHEN 'paid' THEN '已付款' WHEN 'pending' THEN '待核准' ELSE COALESCE(status::text, '未設定') END)
             WHEN 'period' THEN format('日期 %s 不在這一期', COALESCE(session_date::text, '未填'))
             WHEN 'instructor' THEN CASE WHEN instructor_id IS NULL THEN '已沒有連到講師主檔'
               ELSE format('講師和下載時不同（現在：%s）', COALESCE(NULLIF(btrim(instructor_name), ''), '未填姓名')) END
             WHEN 'amount' THEN format('應付金額已變動（下載時 $%s，現在 $%s）',
               replace(to_char(amount, 'FM999,999,999,990.00'), '.00', ''), replace(to_char(payable, 'FM999,999,999,990.00'), '.00', ''))
           END
         ) ORDER BY ord), '[]'::jsonb)
    FROM judged
   WHERE reason IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.salary_payout_item_mismatches(jsonb, date, date) FROM PUBLIC, anon, authenticated;

-- ── 3. 存匯出紀錄（按下載時呼叫）
CREATE OR REPLACE FUNCTION public.record_salary_payout_export(
  p_period_start date,
  p_period_end date,
  p_items jsonb,
  p_people jsonb,
  p_expected_total numeric,
  p_pay_date date DEFAULT NULL,
  p_file_kind text DEFAULT NULL,
  p_exclusions jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_name text;
  v_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_item_count integer;
  v_people_count integer;
  v_bad integer;
  v_distinct integer;
  v_items_total numeric;
  v_people_total numeric;
  v_mismatches jsonb;
  v_export_id bigint;
BEGIN
  SELECT COALESCE(NULLIF(btrim(u.name), ''), u.email) INTO actor_name
    FROM public.users u WHERE u.id = actor_id AND u.role = 'admin';
  IF actor_id IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '只有管理員可以建立匯出紀錄。';
  END IF;

  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '期間起訖日不正確。';
  END IF;
  IF p_period_end - p_period_start > 30 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '一次只能匯出一期（最長 31 天）。';
  END IF;
  IF p_file_kind IS NOT NULL AND p_file_kind NOT IN ('csv', 'xlsx') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '檔案類型不正確。';
  END IF;

  -- 課的清單：[{id, instructor_id, amount}]，可以是空的（只有人工調整的人）
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '課的清單格式不正確。';
  END IF;
  v_item_count := jsonb_array_length(p_items);
  IF v_item_count > 5000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '一份匯出最多 5000 筆。';
  END IF;
  SELECT count(*) FILTER (WHERE NOT ok) INTO v_bad
    FROM (
      SELECT CASE
               WHEN jsonb_typeof(e) = 'object'
                AND jsonb_typeof(e -> 'id') = 'string'
                AND jsonb_typeof(e -> 'instructor_id') = 'string'
                AND jsonb_typeof(e -> 'amount') = 'number'
               THEN (e ->> 'id') ~* v_uuid_re
                AND (e ->> 'instructor_id') ~* v_uuid_re
                AND (e ->> 'amount')::numeric >= 0
                AND (e ->> 'amount')::numeric = round((e ->> 'amount')::numeric, 2)
               ELSE false
             END AS ok
        FROM jsonb_array_elements(p_items) AS t(e)
    ) checked;
  IF v_bad > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('課的清單格式不正確（%s 筆）。', v_bad);
  END IF;
  SELECT count(DISTINCT (e ->> 'id')::uuid), COALESCE(sum((e ->> 'amount')::numeric), 0)
    INTO v_distinct, v_items_total
    FROM jsonb_array_elements(p_items) AS t(e);
  IF v_distinct <> v_item_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '課的清單裡有重複的紀錄。';
  END IF;

  -- 每位講師：[{instructor_id, name, amount, adjustment, adjustment_reason}]
  IF p_people IS NULL OR jsonb_typeof(p_people) <> 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '這份檔案沒有任何講師。';
  END IF;
  v_people_count := jsonb_array_length(p_people);
  IF v_people_count > 2000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '講師人數過多。';
  END IF;
  SELECT count(*) FILTER (WHERE NOT ok) INTO v_bad
    FROM (
      SELECT CASE
               WHEN jsonb_typeof(e) = 'object'
                AND jsonb_typeof(e -> 'instructor_id') = 'string'
                AND jsonb_typeof(e -> 'name') = 'string'
                AND jsonb_typeof(e -> 'amount') = 'number'
                AND jsonb_typeof(e -> 'adjustment') = 'number'
                AND COALESCE(jsonb_typeof(e -> 'adjustment_reason'), 'null') IN ('string', 'null')
               THEN (e ->> 'instructor_id') ~* v_uuid_re
                AND char_length(e ->> 'name') <= 200
                AND char_length(COALESCE(e ->> 'adjustment_reason', '')) <= 500
                AND (e ->> 'amount')::numeric > 0
                AND (e ->> 'amount')::numeric = round((e ->> 'amount')::numeric, 2)
                AND (e ->> 'adjustment')::numeric = round((e ->> 'adjustment')::numeric, 2)
                AND ((e ->> 'adjustment')::numeric = 0 OR NULLIF(btrim(COALESCE(e ->> 'adjustment_reason', '')), '') IS NOT NULL)
               ELSE false
             END AS ok
        FROM jsonb_array_elements(p_people) AS t(e)
    ) checked;
  IF v_bad > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('講師清單格式不正確（%s 位）。', v_bad);
  END IF;
  IF (SELECT count(DISTINCT (e ->> 'instructor_id')::uuid) FROM jsonb_array_elements(p_people) AS t(e)) <> v_people_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '講師清單裡有重複的講師。';
  END IF;
  -- 每一堂課的講師都要在講師清單裡；每位講師的實付＝他的課加總＋人工調整
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS t(e)
     WHERE (e ->> 'instructor_id')::uuid NOT IN (SELECT (p ->> 'instructor_id')::uuid FROM jsonb_array_elements(p_people) AS q(p))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '有課的講師不在講師清單裡。';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_people) AS q(p)
     WHERE round((p ->> 'amount')::numeric, 2) IS DISTINCT FROM round(
             COALESCE((SELECT sum((e ->> 'amount')::numeric) FROM jsonb_array_elements(p_items) AS t(e)
                        WHERE (e ->> 'instructor_id')::uuid = (p ->> 'instructor_id')::uuid), 0)
             + (p ->> 'adjustment')::numeric, 2)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '講師實付和他的課加總＋人工調整不一致。';
  END IF;
  SELECT sum((p ->> 'amount')::numeric) INTO v_people_total FROM jsonb_array_elements(p_people) AS q(p);
  IF p_expected_total IS NULL OR round(p_expected_total, 2) IS DISTINCT FROM round(v_people_total, 2) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('講師實付合計（$%s）與轉帳檔總額（$%s）不同。',
        replace(to_char(v_people_total, 'FM999,999,999,990.00'), '.00', ''),
        COALESCE(replace(to_char(p_expected_total, 'FM999,999,999,990.00'), '.00', ''), '?'));
  END IF;

  IF p_exclusions IS NULL OR jsonb_typeof(p_exclusions) <> 'array' OR jsonb_array_length(p_exclusions) > 50
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_exclusions) AS t(e) WHERE jsonb_typeof(e) <> 'string' OR char_length(e #>> '{}') > 300) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '排除摘要格式不正確。';
  END IF;

  v_mismatches := public.salary_payout_item_mismatches(p_items, p_period_start, p_period_end);
  IF jsonb_array_length(v_mismatches) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'mismatch_count', jsonb_array_length(v_mismatches), 'mismatches', v_mismatches);
  END IF;

  INSERT INTO public.salary_payout_exports
    (period_start, period_end, item_count, people_count, total_amount, transfer_total, people, exclusions,
     pay_date, file_kind, exported_by, exported_by_name)
  VALUES
    (p_period_start, p_period_end, v_item_count, v_people_count, v_items_total, v_people_total, p_people, p_exclusions,
     p_pay_date, p_file_kind, actor_id, actor_name)
  RETURNING id INTO v_export_id;

  INSERT INTO public.salary_payout_export_items (export_id, session_id, instructor_id, amount)
  SELECT v_export_id, (e ->> 'id')::uuid, (e ->> 'instructor_id')::uuid, (e ->> 'amount')::numeric
    FROM jsonb_array_elements(p_items) AS t(e);

  RETURN jsonb_build_object(
    'ok', true,
    'export_id', v_export_id,
    'item_count', v_item_count,
    'people_count', v_people_count,
    'total_amount', v_items_total,
    'transfer_total', v_people_total
  );
END;
$$;

COMMENT ON FUNCTION public.record_salary_payout_export(date, date, jsonb, jsonb, numeric, date, text, jsonb) IS
  '月結匯款下載轉帳檔時存一筆匯出紀錄（逐筆核對已核准、期別、講師、金額；不符不存、回 ok=false）。只有 admin。';
REVOKE ALL ON FUNCTION public.record_salary_payout_export(date, date, jsonb, jsonb, numeric, date, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_salary_payout_export(date, date, jsonb, jsonb, numeric, date, text, jsonb) TO authenticated;

-- ── 4. 對一份匯出標記已付款（清單從資料庫拿）
CREATE OR REPLACE FUNCTION public.mark_salary_payout_export_paid(
  p_export_id bigint,
  p_expected_count integer,
  p_expected_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_name text;
  v_today date := (now() AT TIME ZONE 'Asia/Taipei')::date;
  v_now timestamptz := now();
  v_export public.salary_payout_exports%ROWTYPE;
  v_items jsonb;
  v_mismatches jsonb;
  v_marked integer;
BEGIN
  SELECT COALESCE(NULLIF(btrim(u.name), ''), u.email) INTO actor_name
    FROM public.users u WHERE u.id = actor_id AND u.role = 'admin';
  IF actor_id IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '只有管理員可以標記已付款。';
  END IF;

  -- 鎖住這份匯出：同一份同時按兩次，後到的等前一次完成後會看到「已經標記過」
  SELECT * INTO v_export FROM public.salary_payout_exports WHERE id = p_export_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('找不到匯出 #%s。', COALESCE(p_export_id::text, '?'));
  END IF;
  IF v_export.marked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('匯出 #%s 已經標記過已付款，不能再標一次。', p_export_id);
  END IF;
  IF p_expected_count IS DISTINCT FROM v_export.item_count
     OR p_expected_amount IS NULL OR round(p_expected_amount, 2) IS DISTINCT FROM round(v_export.total_amount, 2) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('確認的筆數／金額（%s 筆、$%s）和匯出 #%s（%s 筆、$%s）不同，這次沒有標記任何紀錄，請重新讀取。',
        COALESCE(p_expected_count::text, '?'), COALESCE(replace(to_char(p_expected_amount, 'FM999,999,999,990.00'), '.00', ''), '?'),
        p_export_id, v_export.item_count, replace(to_char(v_export.total_amount, 'FM999,999,999,990.00'), '.00', ''));
  END IF;
  IF v_export.period_end >= v_today THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('這一期到 %s 才結束，結束後才能標記已付款。', to_char(v_export.period_end, 'FMMM/FMDD'));
  END IF;

  -- 先鎖住這份清單裡的列（依 id 排序，避免互等），再用同一套規則逐筆核對
  PERFORM 1
     FROM public.class_sessions cs
    WHERE cs.id IN (SELECT i.session_id FROM public.salary_payout_export_items i WHERE i.export_id = p_export_id)
    ORDER BY cs.id
      FOR UPDATE;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', i.session_id, 'instructor_id', i.instructor_id, 'amount', i.amount)
           ORDER BY i.session_id), '[]'::jsonb)
    INTO v_items
    FROM public.salary_payout_export_items i
   WHERE i.export_id = p_export_id;

  v_mismatches := public.salary_payout_item_mismatches(v_items, v_export.period_start, v_export.period_end);
  IF jsonb_array_length(v_mismatches) > 0 THEN
    -- 什麼都沒改（上面只有讀取與鎖定）；交易結束鎖就放開
    RETURN jsonb_build_object(
      'ok', false,
      'export_id', p_export_id,
      'marked_count', 0,
      'mismatch_count', jsonb_array_length(v_mismatches),
      'mismatches', v_mismatches
    );
  END IF;

  -- old 讀的是這句開始前的快照（＝標記前的值）；upd 的 RETURNING 是 trigger 跑完之後的新值
  WITH items AS (
    SELECT i.session_id
      FROM public.salary_payout_export_items i
     WHERE i.export_id = p_export_id
  ), old AS (
    SELECT cs.id, cs.status, cs.paid_amount, cs.paid_at
      FROM public.class_sessions cs
      JOIN items ON items.session_id = cs.id
  ), upd AS (
    UPDATE public.class_sessions cs
       SET status = 'paid',
           paid_amount = GREATEST(COALESCE(cs.paid_amount, 0), cs.total_salary),
           paid_at = v_now
      FROM items
     WHERE cs.id = items.session_id
       AND cs.status = 'approved'
    RETURNING cs.id, cs.paid_amount, cs.paid_at, cs.updated_at
  )
  UPDATE public.salary_payout_export_items i
     SET old_status = o.status,
         old_paid_amount = o.paid_amount,
         old_paid_at = o.paid_at,
         new_paid_amount = u.paid_amount,
         new_paid_at = u.paid_at,
         new_updated_at = u.updated_at
    FROM old o
    JOIN upd u ON u.id = o.id
   WHERE i.export_id = p_export_id
     AND i.session_id = o.id;
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  IF v_marked <> v_export.item_count THEN
    -- 理論上不會發生（上面已逐筆確認並鎖住）；萬一發生就整份取消
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('標記筆數（%s）與匯出筆數（%s）不同，這次沒有標記任何紀錄。', v_marked, v_export.item_count);
  END IF;

  UPDATE public.salary_payout_exports
     SET marked_at = v_now,
         marked_by = actor_id,
         marked_by_name = actor_name,
         marked_count = v_marked,
         marked_amount = v_export.total_amount
   WHERE id = p_export_id;

  RETURN jsonb_build_object(
    'ok', true,
    'export_id', p_export_id,
    'marked_count', v_marked,
    'marked_amount', v_export.total_amount,
    'paid_at', v_now
  );
END;
$$;

COMMENT ON FUNCTION public.mark_salary_payout_export_paid(bigint, integer, numeric) IS
  '月結匯款：對一份匯出紀錄標記已付款（清單從資料庫拿；逐筆核對已核准、期別、講師、金額，任一不符整份不改、回 ok=false）。只有 admin。';
REVOKE ALL ON FUNCTION public.mark_salary_payout_export_paid(bigint, integer, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_salary_payout_export_paid(bigint, integer, numeric) TO authenticated;

-- ── 5. 還原一份匯出的標記
CREATE OR REPLACE FUNCTION public.revert_salary_payout_export(p_export_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_name text;
  v_now timestamptz := now();
  v_marked_at timestamptz;
  v_skipped jsonb;
  v_reverted integer;
  v_reverted_amount numeric;
  v_remaining integer;
BEGIN
  SELECT COALESCE(NULLIF(btrim(u.name), ''), u.email) INTO actor_name
    FROM public.users u WHERE u.id = actor_id AND u.role = 'admin';
  IF actor_id IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '只有管理員可以還原已付款標記。';
  END IF;

  -- 鎖住這份匯出：同時按兩次還原，後到的等前一次完成後只會看到「沒有可還原的列」
  SELECT e.marked_at INTO v_marked_at FROM public.salary_payout_exports e WHERE e.id = p_export_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('找不到匯出 #%s。', COALESCE(p_export_id::text, '?'));
  END IF;
  IF v_marked_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('匯出 #%s 還沒標記已付款，不需要還原。', p_export_id);
  END IF;

  PERFORM 1
     FROM public.class_sessions cs
    WHERE cs.id IN (
      SELECT i.session_id FROM public.salary_payout_export_items i
       WHERE i.export_id = p_export_id AND i.new_paid_at IS NOT NULL AND i.reverted_at IS NULL
    )
    ORDER BY cs.id
      FOR UPDATE;

  -- 之後被改過或已不存在的列：回報、不動
  WITH cur AS (
    SELECT i.session_id, i.new_paid_amount, i.new_paid_at, i.new_updated_at,
           cs.id AS found_id, cs.status, cs.paid_amount, cs.paid_at, cs.updated_at, cs.session_date, cs.instructor_name
      FROM public.salary_payout_export_items i
      LEFT JOIN public.class_sessions cs ON cs.id = i.session_id
     WHERE i.export_id = p_export_id AND i.new_paid_at IS NOT NULL AND i.reverted_at IS NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', session_id,
           'session_date', session_date,
           'instructor_name', instructor_name,
           'reason', CASE WHEN found_id IS NULL THEN 'not_found' WHEN status IS DISTINCT FROM 'paid' THEN 'status' ELSE 'changed' END,
           'message', CASE
             WHEN found_id IS NULL THEN '這筆紀錄已不存在'
             WHEN status IS DISTINCT FROM 'paid' THEN format('已不是已付款（現在：%s）',
               CASE status::text WHEN 'approved' THEN '已核准' WHEN 'pending' THEN '待核准' ELSE COALESCE(status::text, '未設定') END)
             ELSE '標記後被改過（已領金額、付款時間或其他欄位）'
           END
         ) ORDER BY session_date, session_id), '[]'::jsonb)
    INTO v_skipped
    FROM cur
   WHERE found_id IS NULL
      OR status IS DISTINCT FROM 'paid'
      OR paid_amount IS DISTINCT FROM new_paid_amount
      OR paid_at IS DISTINCT FROM new_paid_at
      OR updated_at IS DISTINCT FROM new_updated_at;

  WITH ok AS (
    SELECT i.session_id, i.old_status, i.old_paid_amount, i.old_paid_at, i.amount
      FROM public.salary_payout_export_items i
      JOIN public.class_sessions cs ON cs.id = i.session_id
     WHERE i.export_id = p_export_id
       AND i.new_paid_at IS NOT NULL
       AND i.reverted_at IS NULL
       AND cs.status = 'paid'
       AND cs.paid_amount IS NOT DISTINCT FROM i.new_paid_amount
       AND cs.paid_at IS NOT DISTINCT FROM i.new_paid_at
       AND cs.updated_at IS NOT DISTINCT FROM i.new_updated_at
  ), upd AS (
    UPDATE public.class_sessions cs
       SET status = ok.old_status,
           paid_amount = ok.old_paid_amount,
           paid_at = ok.old_paid_at
      FROM ok
     WHERE cs.id = ok.session_id
    RETURNING cs.id
  ), marked AS (
    UPDATE public.salary_payout_export_items i
       SET reverted_at = v_now,
           reverted_by = actor_id
      FROM upd
     WHERE i.export_id = p_export_id AND i.session_id = upd.id
    RETURNING i.amount
  )
  SELECT count(*)::integer, COALESCE(sum(amount), 0) INTO v_reverted, v_reverted_amount FROM marked;

  IF v_reverted > 0 THEN
    UPDATE public.salary_payout_exports
       SET reverted_count = reverted_count + v_reverted,
           reverted_amount = reverted_amount + v_reverted_amount,
           reverted_at = v_now,
           reverted_by = actor_id,
           reverted_by_name = actor_name
     WHERE id = p_export_id;
  END IF;

  SELECT count(*)::integer INTO v_remaining
    FROM public.salary_payout_export_items i
   WHERE i.export_id = p_export_id AND i.new_paid_at IS NOT NULL AND i.reverted_at IS NULL;

  RETURN jsonb_build_object(
    'export_id', p_export_id,
    'reverted_count', v_reverted,
    'reverted_amount', v_reverted_amount,
    'skipped_count', jsonb_array_length(v_skipped),
    'skipped', v_skipped,
    'remaining_count', v_remaining
  );
END;
$$;

COMMENT ON FUNCTION public.revert_salary_payout_export(bigint) IS
  '還原一份匯出的已付款標記：只還原這份標的、之後沒被改過的列（status、paid_amount、paid_at、updated_at 都還是標完當下的值），其他回報不動。可重跑。只有 admin。';
REVOKE ALL ON FUNCTION public.revert_salary_payout_export(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revert_salary_payout_export(bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
