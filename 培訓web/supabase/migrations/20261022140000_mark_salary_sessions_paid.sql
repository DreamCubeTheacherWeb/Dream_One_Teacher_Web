-- ═══════════════════════════════════════════════════════════════════
-- 2026-10-22 月結匯款「匯款完成，標記為已付款」：只標「這份轉帳檔實際納入」的紀錄，並留批次紀錄、可整批還原
--
--   取代從未套到正式庫的 20261021233000_mark_salary_period_paid（檔案已刪除）。獨立審查判定它不能上線：
--   它把「整期所有已核准」一起標成已付款，但月結匯款的轉帳檔會排除異常課、對不到講師的課、
--   缺帳號／身分證被擋下的講師、管理員手動排除的人，也不含匯出後才核准的晚到紀錄
--   → 沒匯到的錢被標成已付款、之後不再出現在匯款檔＝永久漏匯。
--   本檔開頭仍 DROP 它的兩個版本（2 參數草稿、4 參數版），確保任何資料庫裡都不會留著那支函式。
--
--   salary_payout_batches        一次「標記已付款」＝一批：期別、筆數、金額、誰、何時、付款日、
--                                轉帳檔總額與人工調整（只做紀錄，不寫進任何一堂課）、還原紀錄。
--   salary_payout_batch_items    這批標到的每一列：當時應付金額、舊 status／paid_amount／paid_at、
--                                標完後的 paid_amount／paid_at／updated_at（還原時用來判斷「之後有沒有被改過」）。
--     兩張表只有 admin 讀得到；沒有任何寫入權限，只能經下面兩個函式寫。
--     session_id 不設外鍵：紀錄之後被刪除，批次紀錄仍要留著（還原時回報「已不存在」）。
--
--   mark_salary_sessions_paid(p_period_start, p_period_end, p_items, p_expected_total,
--                             p_pay_date, p_transfer_total, p_adjustments)
--     p_items＝[{ "id": class_sessions.id, "amount": 轉帳檔裡這一堂的應付金額 }, …]
--       應付金額＝max(總額 − 已領, 0)，與 src/lib/payoutBankExport.js 的 sessionPayableCents 相同。
--     先鎖住清單裡的列，再逐筆確認：仍是 status='approved'、session_date 在期別內（含頭尾）、有連到講師、
--       目前應付金額＝清單金額。任一不符 → 什麼都不改，回 {"ok": false, "mismatches": [...]}（每筆附原因），
--       請前端重新整理、重新下載轉帳檔再標。
--     全部符合 → 同一交易內：建一批、記下每列舊值、把這些列改成 paid、paid_at＝現在、
--       paid_amount＝GREATEST(已領, 總額)——已領超過總額的列不改小（轉帳檔把它們當應付 $0 納入，
--       若改成「拒絕」會讓整批永遠標不了；保留較大的已領金額，確認框另外點出這些列）。
--       回 {"ok": true, "batch_id", "marked_count", "marked_amount", "paid_at"}。
--     清單不在這份轉帳檔裡的列（晚到的已核准、被排除的）完全不會碰到。
--     擋下（22023）：期別起訖缺漏／顛倒／超過 31 天、這一期還沒結束（迄日 ≥ 台北今天）、清單空白／格式錯／
--       重複、清單金額合計與 p_expected_total 不同。
--     兩位管理員同時送同一份：後到的等前一位完成後，逐筆確認會發現已是「已付款」→ ok=false、什麼都不改。
--
--   revert_salary_payout_batch(p_batch_id)
--     把這批標的列還原成舊值；只還原「仍是這批標上、之後沒被改過」的列
--     （status 仍是 paid，且 paid_amount、paid_at、updated_at 都還是標完當下的值）。
--     其他列回報原因、不動。可重跑（已還原的列不會再動；之後沒有可還原的列就回 0 筆）。
--
--   兩個函式：SECURITY DEFINER、search_path=''、只有 admin（其他人 42501）、anon／PUBLIC 不能執行。
--   class_sessions 的三個 trigger 照常跑（updated_at、異常標記、定價檢查），函式不停用任何 trigger。
--
-- 本檔可重複執行；整支在一個交易內（任何一句失敗整支取消）。
-- ═══════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── 0. 移除會「整期一起標」的舊函式（從未套到正式庫；保險起見仍移除）
DROP FUNCTION IF EXISTS public.mark_salary_period_paid(date, date);
DROP FUNCTION IF EXISTS public.mark_salary_period_paid(date, date, integer, numeric);

-- ── 1. 批次紀錄
CREATE TABLE IF NOT EXISTS public.salary_payout_batches (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  item_count       integer NOT NULL CHECK (item_count > 0),
  total_amount     numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  pay_date         date,
  transfer_total   numeric(14,2),
  adjustments      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(adjustments) = 'array'),
  marked_by        uuid,
  marked_by_name   text,
  marked_at        timestamptz NOT NULL DEFAULT now(),
  reverted_count   integer NOT NULL DEFAULT 0 CHECK (reverted_count >= 0),
  reverted_amount  numeric(14,2) NOT NULL DEFAULT 0,
  reverted_at      timestamptz,
  reverted_by      uuid,
  reverted_by_name text,
  CONSTRAINT salary_payout_batches_period_check CHECK (period_end >= period_start)
);

COMMENT ON TABLE public.salary_payout_batches IS
  '月結匯款「匯款完成，標記為已付款」的批次紀錄（一次標記＝一批）。只有 admin 可讀；只能經 mark_salary_sessions_paid／revert_salary_payout_batch 寫入。';
COMMENT ON COLUMN public.salary_payout_batches.total_amount IS '這批標記的課程應付金額合計（轉帳檔裡各堂應付金額相加，不含人工調整）';
COMMENT ON COLUMN public.salary_payout_batches.transfer_total IS '當時轉帳檔總額（含人工調整；只做紀錄）';
COMMENT ON COLUMN public.salary_payout_batches.adjustments IS '當時轉帳檔的人工調整 [{instructor_id, name, amount, reason}]（只做紀錄，不寫進任何一堂課的已領金額）';

CREATE TABLE IF NOT EXISTS public.salary_payout_batch_items (
  batch_id         bigint NOT NULL REFERENCES public.salary_payout_batches (id) ON DELETE RESTRICT,
  session_id       uuid NOT NULL,
  amount           numeric(12,2) NOT NULL CHECK (amount >= 0),
  old_status       public.session_status_enum NOT NULL,
  old_paid_amount  numeric(10,2),
  old_paid_at      timestamptz,
  new_paid_amount  numeric(10,2) NOT NULL,
  new_paid_at      timestamptz NOT NULL,
  new_updated_at   timestamptz,
  reverted_at      timestamptz,
  reverted_by      uuid,
  PRIMARY KEY (batch_id, session_id)
);

COMMENT ON TABLE public.salary_payout_batch_items IS
  '每批標記的每一列：當時應付金額、標記前的 status／paid_amount／paid_at（還原用）、標記後的值（判斷之後有沒有被改過）。只有 admin 可讀。';

CREATE INDEX IF NOT EXISTS salary_payout_batch_items_session_idx ON public.salary_payout_batch_items (session_id);
CREATE INDEX IF NOT EXISTS salary_payout_batches_period_idx ON public.salary_payout_batches (period_start, period_end);

ALTER TABLE public.salary_payout_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_payout_batch_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.salary_payout_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.salary_payout_batch_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.salary_payout_batches TO authenticated;
GRANT SELECT ON TABLE public.salary_payout_batch_items TO authenticated;

DO $$
DECLARE
  seq text := pg_get_serial_sequence('public.salary_payout_batches', 'id');
BEGIN
  IF seq IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', seq);
  END IF;
END $$;

DROP POLICY IF EXISTS "Admins can view salary payout batches" ON public.salary_payout_batches;
CREATE POLICY "Admins can view salary payout batches"
  ON public.salary_payout_batches FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can view salary payout batch items" ON public.salary_payout_batch_items;
CREATE POLICY "Admins can view salary payout batch items"
  ON public.salary_payout_batch_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

-- ── 2. 標記：只標清單裡的列
CREATE OR REPLACE FUNCTION public.mark_salary_sessions_paid(
  p_period_start date,
  p_period_end date,
  p_items jsonb,
  p_expected_total numeric,
  p_pay_date date DEFAULT NULL,
  p_transfer_total numeric DEFAULT NULL,
  p_adjustments jsonb DEFAULT '[]'::jsonb
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
  v_item_count integer;
  v_bad integer;
  v_distinct integer;
  v_items_total numeric;
  v_mismatches jsonb;
  v_batch_id bigint;
  v_marked integer;
BEGIN
  SELECT COALESCE(NULLIF(btrim(u.name), ''), u.email) INTO actor_name
    FROM public.users u WHERE u.id = actor_id AND u.role = 'admin';
  IF actor_id IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '只有管理員可以標記已付款。';
  END IF;

  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '期間起訖日不正確。';
  END IF;
  IF p_period_end - p_period_start > 30 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '一次只能標記一期（最長 31 天）。';
  END IF;
  IF p_period_end >= v_today THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('這一期到 %s 才結束，結束後才能標記已付款。', to_char(p_period_end, 'FMMM/FMDD'));
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '沒有要標記的紀錄。';
  END IF;
  v_item_count := jsonb_array_length(p_items);
  IF v_item_count > 5000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '一次最多標記 5000 筆。';
  END IF;

  -- 每一筆都要是 {"id": uuid 字串, "amount": ≥ 0、最多兩位小數的數字}（CASE 保證先檢查型別再轉型）
  SELECT count(*) FILTER (WHERE NOT ok) INTO v_bad
    FROM (
      SELECT CASE
               WHEN jsonb_typeof(e) = 'object'
                AND jsonb_typeof(e -> 'id') = 'string'
                AND jsonb_typeof(e -> 'amount') = 'number'
               THEN (e ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                AND (e ->> 'amount')::numeric >= 0
                AND (e ->> 'amount')::numeric = round((e ->> 'amount')::numeric, 2)
               ELSE false
             END AS ok
        FROM jsonb_array_elements(p_items) AS t(e)
    ) checked;
  IF v_bad > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('清單格式不正確（%s 筆）。', v_bad);
  END IF;

  SELECT count(DISTINCT (e ->> 'id')::uuid), COALESCE(sum((e ->> 'amount')::numeric), 0)
    INTO v_distinct, v_items_total
    FROM jsonb_array_elements(p_items) AS t(e);
  IF v_distinct <> v_item_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '清單裡有重複的紀錄。';
  END IF;
  IF p_expected_total IS NULL OR round(p_expected_total, 2) <> round(v_items_total, 2) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('清單金額合計（$%s）與確認金額（$%s）不同，這次沒有標記任何紀錄。',
        replace(to_char(v_items_total, 'FM999,999,999,990.00'), '.00', ''), COALESCE(replace(to_char(p_expected_total, 'FM999,999,999,990.00'), '.00', ''), '?'));
  END IF;

  IF p_adjustments IS NULL OR jsonb_typeof(p_adjustments) <> 'array' OR jsonb_array_length(p_adjustments) > 2000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '人工調整紀錄格式不正確。';
  END IF;

  -- 先鎖住清單裡的列（依 id 排序，避免兩個交易互等）；之後的檢查與更新都看鎖住後的值
  PERFORM 1
     FROM public.class_sessions cs
    WHERE cs.id IN (SELECT (e ->> 'id')::uuid FROM jsonb_array_elements(p_items) AS t(e))
    ORDER BY cs.id
      FOR UPDATE;

  WITH req AS (
    SELECT (e ->> 'id')::uuid AS id, (e ->> 'amount')::numeric AS amount, ord
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ord)
  ), chk AS (
    SELECT r.id, r.amount, r.ord, cs.id AS found_id, cs.status, cs.session_date, cs.instructor_id, cs.instructor_name,
           GREATEST(COALESCE(cs.total_salary, 0) - COALESCE(cs.paid_amount, 0), 0) AS payable
      FROM req r
      LEFT JOIN public.class_sessions cs ON cs.id = r.id
  ), judged AS (
    SELECT chk.*,
           CASE
             WHEN found_id IS NULL THEN 'not_found'
             WHEN status <> 'approved' THEN 'status'
             WHEN session_date < p_period_start OR session_date > p_period_end THEN 'period'
             WHEN instructor_id IS NULL THEN 'no_instructor'
             WHEN round(payable, 2) <> round(amount, 2) THEN 'amount'
           END AS reason
      FROM chk
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', id,
           'reason', reason,
           'session_date', session_date,
           'instructor_name', instructor_name,
           'current_status', status,
           'expected_amount', amount,
           'current_amount', payable,
           'message', CASE reason
             WHEN 'not_found' THEN '找不到這筆紀錄（可能已刪除）'
             WHEN 'status' THEN format('狀態已不是「已核准」（現在：%s）',
               CASE status::text WHEN 'paid' THEN '已付款' WHEN 'pending' THEN '待核准' ELSE status::text END)
             WHEN 'period' THEN format('日期 %s 不在這一期', session_date)
             WHEN 'no_instructor' THEN '沒有連到講師主檔'
             WHEN 'amount' THEN format('應付金額已變動（下載時 $%s，現在 $%s）',
               replace(to_char(amount, 'FM999,999,999,990.00'), '.00', ''), replace(to_char(payable, 'FM999,999,999,990.00'), '.00', ''))
           END
         ) ORDER BY ord), '[]'::jsonb)
    INTO v_mismatches
    FROM judged
   WHERE reason IS NOT NULL;

  IF jsonb_array_length(v_mismatches) > 0 THEN
    -- 什麼都沒改（上面只有讀取與鎖定）；交易結束鎖就放開
    RETURN jsonb_build_object(
      'ok', false,
      'marked_count', 0,
      'mismatch_count', jsonb_array_length(v_mismatches),
      'mismatches', v_mismatches
    );
  END IF;

  INSERT INTO public.salary_payout_batches
    (period_start, period_end, item_count, total_amount, pay_date, transfer_total, adjustments, marked_by, marked_by_name, marked_at)
  VALUES
    (p_period_start, p_period_end, v_item_count, v_items_total, p_pay_date, p_transfer_total, p_adjustments, actor_id, actor_name, v_now)
  RETURNING id INTO v_batch_id;

  -- old 讀的是這句開始前的快照（＝標記前的值）；upd 的 RETURNING 是 trigger 跑完之後的新值
  WITH req AS (
    SELECT (e ->> 'id')::uuid AS id, (e ->> 'amount')::numeric AS amount
      FROM jsonb_array_elements(p_items) AS t(e)
  ), old AS (
    SELECT cs.id, cs.status, cs.paid_amount, cs.paid_at, r.amount
      FROM public.class_sessions cs
      JOIN req r ON r.id = cs.id
  ), upd AS (
    UPDATE public.class_sessions cs
       SET status = 'paid',
           paid_amount = GREATEST(COALESCE(cs.paid_amount, 0), cs.total_salary),
           paid_at = v_now
      FROM req r
     WHERE cs.id = r.id
       AND cs.status = 'approved'
    RETURNING cs.id, cs.paid_amount, cs.paid_at, cs.updated_at
  )
  INSERT INTO public.salary_payout_batch_items
    (batch_id, session_id, amount, old_status, old_paid_amount, old_paid_at, new_paid_amount, new_paid_at, new_updated_at)
  SELECT v_batch_id, o.id, o.amount, o.status, o.paid_amount, o.paid_at, u.paid_amount, u.paid_at, u.updated_at
    FROM old o
    JOIN upd u ON u.id = o.id;
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  IF v_marked <> v_item_count THEN
    -- 理論上不會發生（上面已逐筆確認並鎖住）；萬一發生就整批取消
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('標記筆數（%s）與清單筆數（%s）不同，這次沒有標記任何紀錄。', v_marked, v_item_count);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', v_batch_id,
    'marked_count', v_marked,
    'marked_amount', v_items_total,
    'paid_at', v_now
  );
END;
$$;

COMMENT ON FUNCTION public.mark_salary_sessions_paid(date, date, jsonb, numeric, date, numeric, jsonb) IS
  '月結匯款「匯款完成，標記為已付款」：只把轉帳檔實際納入的 class_sessions（id＋應付金額清單）標成已付款並記一批；任一不符整批不改、回 ok=false 與不符清單。只有 admin。';

REVOKE ALL ON FUNCTION public.mark_salary_sessions_paid(date, date, jsonb, numeric, date, numeric, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_salary_sessions_paid(date, date, jsonb, numeric, date, numeric, jsonb) TO authenticated;

-- ── 3. 還原一批
CREATE OR REPLACE FUNCTION public.revert_salary_payout_batch(p_batch_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_name text;
  v_now timestamptz := now();
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

  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '請指定要還原的批次。';
  END IF;
  -- 鎖住這一批：同一批同時按兩次還原，後到的等前一次完成後只會看到「沒有可還原的列」
  PERFORM 1 FROM public.salary_payout_batches b WHERE b.id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('找不到批次 #%s。', p_batch_id);
  END IF;

  PERFORM 1
     FROM public.class_sessions cs
    WHERE cs.id IN (
      SELECT i.session_id FROM public.salary_payout_batch_items i
       WHERE i.batch_id = p_batch_id AND i.reverted_at IS NULL
    )
    ORDER BY cs.id
      FOR UPDATE;

  -- 之後被改過或已不存在的列：回報、不動
  WITH cur AS (
    SELECT i.session_id, i.new_paid_amount, i.new_paid_at, i.new_updated_at,
           cs.id AS found_id, cs.status, cs.paid_amount, cs.paid_at, cs.updated_at, cs.session_date, cs.instructor_name
      FROM public.salary_payout_batch_items i
      LEFT JOIN public.class_sessions cs ON cs.id = i.session_id
     WHERE i.batch_id = p_batch_id AND i.reverted_at IS NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', session_id,
           'session_date', session_date,
           'instructor_name', instructor_name,
           'reason', CASE WHEN found_id IS NULL THEN 'not_found' WHEN status <> 'paid' THEN 'status' ELSE 'changed' END,
           'message', CASE
             WHEN found_id IS NULL THEN '這筆紀錄已不存在'
             WHEN status <> 'paid' THEN format('已不是已付款（現在：%s）',
               CASE status::text WHEN 'approved' THEN '已核准' WHEN 'pending' THEN '待核准' ELSE status::text END)
             ELSE '標記後被改過（已領金額、付款時間或其他欄位）'
           END
         ) ORDER BY session_date, session_id), '[]'::jsonb)
    INTO v_skipped
    FROM cur
   WHERE found_id IS NULL
      OR status <> 'paid'
      OR paid_amount IS DISTINCT FROM new_paid_amount
      OR paid_at IS DISTINCT FROM new_paid_at
      OR updated_at IS DISTINCT FROM new_updated_at;

  WITH ok AS (
    SELECT i.session_id, i.old_status, i.old_paid_amount, i.old_paid_at, i.amount
      FROM public.salary_payout_batch_items i
      JOIN public.class_sessions cs ON cs.id = i.session_id
     WHERE i.batch_id = p_batch_id
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
    UPDATE public.salary_payout_batch_items i
       SET reverted_at = v_now,
           reverted_by = actor_id
      FROM upd
     WHERE i.batch_id = p_batch_id AND i.session_id = upd.id
    RETURNING i.amount
  )
  SELECT count(*)::integer, COALESCE(sum(amount), 0) INTO v_reverted, v_reverted_amount FROM marked;

  IF v_reverted > 0 THEN
    UPDATE public.salary_payout_batches
       SET reverted_count = reverted_count + v_reverted,
           reverted_amount = reverted_amount + v_reverted_amount,
           reverted_at = v_now,
           reverted_by = actor_id,
           reverted_by_name = actor_name
     WHERE id = p_batch_id;
  END IF;

  SELECT count(*)::integer INTO v_remaining
    FROM public.salary_payout_batch_items i
   WHERE i.batch_id = p_batch_id AND i.reverted_at IS NULL;

  RETURN jsonb_build_object(
    'batch_id', p_batch_id,
    'reverted_count', v_reverted,
    'reverted_amount', v_reverted_amount,
    'skipped_count', jsonb_array_length(v_skipped),
    'skipped', v_skipped,
    'remaining_count', v_remaining
  );
END;
$$;

COMMENT ON FUNCTION public.revert_salary_payout_batch(bigint) IS
  '還原一批「標記已付款」：只還原仍是這批標上、之後沒被改過的列（status、paid_amount、paid_at、updated_at 都還是標完當下的值），其他回報不動。可重跑。只有 admin。';

REVOKE ALL ON FUNCTION public.revert_salary_payout_batch(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revert_salary_payout_batch(bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
