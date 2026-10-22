-- ═══════════════════════════════════════════════════════════════════
-- 2026-10-21 後台「本期匯款完成」：一期匯完，一鍵把該期已核准的紀錄標成已付款
--   背景：講師「我的報酬」的「已匯款」小卡與每列狀態看 class_sessions.status；
--         每期匯完若沒人標，紀錄會一直停在「已核准」（10/20 以前只能後台逐筆改）。
--   一期＝結算週期「上月 26 日～本月 25 日」（前端 src/lib/salaryPayday.js 決定是哪一期，這裡只收起訖日）。
--
--   mark_salary_period_paid(p_period_start, p_period_end, p_expected_count, p_expected_amount)
--     只有 admin（其他人 42501）；anon／PUBLIC 不能執行。
--     只動 session_date 落在區間內（含頭尾）、status = 'approved' 的列：
--       status → 'paid'、paid_amount → total_salary、paid_at → now()（同一次呼叫的列 paid_at 相同，可當批次記號）。
--     待核准（pending）、待定價（needs_review）、退回（rejected）、已付款的列一律不動（updated_at 也不會變）。
--     p_expected_count／p_expected_amount（選填）：管理員在確認框看到的筆數與金額；實際要標的跟它不同
--       （確認之後又有人核准或改了金額）就整批取消、什麼都不改，請前端重新確認。
--     可重跑：第二次找不到已核准的列，回 0 筆。兩位管理員同時按，後到的那次等前一次結束後回 0 筆，不會重複計算。
--     擋下：起訖日缺漏或顛倒、區間超過 31 天（含頭尾；最長的一期如 12/26～1/25 剛好 31 天）、這一期還沒結束（迄日 ≥ 台北今天）。
--     回傳 {"marked_count": 筆數, "marked_amount": 金額, "paid_at": 這批的付款時間}。
--   觸發器照常跑：trg_class_sessions_updated_at 把 updated_at 設成現在（「這列被改過」的記號，
--     scripts/salary_master_import/96 靠它判斷，不能停）；trg_session_anomaly 依現有規則重算異常標記；
--     trg_guard_class_session_pricing 照常檢查（只改付款三欄，不影響定價檢查）。
-- 本檔可重複執行。
-- ═══════════════════════════════════════════════════════════════════

-- 本檔早期草稿只有兩個參數（從未套到正式庫）；新舊兩版並存時用兩個參數呼叫會分不出是哪一個，先刪舊版
DROP FUNCTION IF EXISTS public.mark_salary_period_paid(date, date);

CREATE OR REPLACE FUNCTION public.mark_salary_period_paid(
  p_period_start date,
  p_period_end date,
  p_expected_count integer DEFAULT NULL,
  p_expected_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Asia/Taipei')::date;
  v_count integer;
  v_amount numeric;
BEGIN
  IF actor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = actor_id AND role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '只有管理員可以標記匯款完成。';
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

  WITH marked AS (
    UPDATE public.class_sessions cs
       SET status = 'paid',
           paid_amount = cs.total_salary,
           paid_at = now()
     WHERE cs.status = 'approved'
       AND cs.pricing_status NOT IN ('needs_review', 'rejected')
       AND cs.session_date BETWEEN p_period_start AND p_period_end
    RETURNING cs.total_salary
  )
  SELECT count(*)::integer, COALESCE(sum(total_salary), 0)
    INTO v_count, v_amount
    FROM marked;

  -- 跟確認框上的數字不同：丟出例外，上面的 UPDATE 整批取消
  IF (p_expected_count IS NOT NULL AND v_count <> p_expected_count)
     OR (p_expected_amount IS NOT NULL AND round(v_amount, 2) <> round(p_expected_amount, 2)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('這一期的紀錄剛剛有變動（確認時 %s 筆、$%s，現在 %s 筆、$%s），這次沒有標記任何紀錄，請重新確認。',
        COALESCE(p_expected_count::text, '?'),
        COALESCE(to_char(round(p_expected_amount), 'FM999,999,999,990'), '?'),
        v_count, to_char(round(v_amount), 'FM999,999,999,990'));
  END IF;

  RETURN jsonb_build_object('marked_count', v_count, 'marked_amount', v_amount, 'paid_at', now());
END;
$$;

COMMENT ON FUNCTION public.mark_salary_period_paid(date, date, integer, numeric) IS
  '後台「本期匯款完成」：把 session_date 在區間內（含頭尾）的已核准紀錄標成已付款（paid_amount=total_salary、paid_at=now()）。只有 admin；可重跑；筆數或金額與確認時不同就整批取消。';

REVOKE ALL ON FUNCTION public.mark_salary_period_paid(date, date, integer, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_salary_period_paid(date, date, integer, numeric) TO authenticated;

NOTIFY pgrst, 'reload schema';
