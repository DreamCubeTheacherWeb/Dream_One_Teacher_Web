-- 總表匯入「其他」重新分類｜步驟 8：楓葉體驗課改成體驗課（單一交易，只改課程類型）
-- 業主 2026-10-20 選方案 A：「只把楓葉體驗課 12 筆改成體驗課（直營區），其他維持」。
--
-- 對象：總表原始課程種類（salary_master_rows.raw_course_kind）是「楓葉體驗課」的 12 列，在 class_sessions 裡的那幾筆。
--      其中第 2543 列與第 2542 列完全相同，已由 06_dedupe_and_mark_paid.sql 搬到隔離區，所以正式庫應改 11 筆；
--      本檔會核對「12 列＝還在 class_sessions 的＋在隔離區的」，對不上就停。
-- 只改 course_type：'other' → 'trial'（網站顯示「體驗課」，報酬確認區歸「直營課程」）。
--   薪資、獎金、總計、已領、狀態、付款時間、日期、講師、備註、更新時間、異常標記等全部不動；交易內前後逐欄比對，不符即整批取消、資料庫維持原樣。
--   改的那一刻暫停「更新時間」與「異常標記」兩個 trigger（與 96 還原檔相同做法），交易結束前恢復；中途失敗會連同暫停一起復原。
--   為什麼要暫停更新時間：96_rollback_dedupe_and_mark_paid.sql 靠「updated_at 仍等於 06 執行時間」判斷 06 之後沒人改過，
--   若這 11 筆的 updated_at 變了，日後要撤回 06 時它們會被當成「被改過」而停下或略過。
-- 可重複執行：已經是體驗課就不做任何變更。還原見 98_rollback_reclassify_maple_trial.sql。
--   日後若執行 96 撤回 06，第 2543 列會以「其他」搬回 class_sessions；要維持體驗課，再跑一次本檔即可（只會改那 1 筆）。
-- 執行：Supabase SQL Editor 整段貼上按 Run。最後一個 SELECT 是結果摘要，請整張回傳（預期一列：trial 11 筆）。
--   中途出錯時資料不會有任何變更；之後重跑若只看到「current transaction is aborted」，先單獨執行 ROLLBACK; 再重跑。
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '2min';
-- 擋住交易期間的其他寫入，讓前後比對可靠（交易結束即釋放）
LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _maple ON COMMIT DROP AS
SELECT m.class_session_id AS id,
       m.row_no::int AS row_no,
       m.course_type AS staged_type,
       cs.id IS NOT NULL AS in_sessions,
       EXISTS (SELECT 1 FROM public.class_sessions_quarantine q WHERE q.id = m.class_session_id) AS in_quarantine,
       cs.source,
       cs.course_type AS type_before,
       cs.pricing_status,
       CASE WHEN cs.id IS NOT NULL
            THEN md5((to_jsonb(cs) - 'course_type')::text) END AS fp_before
  FROM public.salary_master_rows m
  LEFT JOIN public.class_sessions cs ON cs.id = m.class_session_id
 WHERE m.batch = '2026-10-19' AND btrim(m.raw_course_kind) = '楓葉體驗課';

DO $$
DECLARE
  v_src        text;
  v_staged     int;
  v_in         int;
  v_quar       int;
  v_missing    int;
  v_other      int;
  v_trial      int;
  v_bad_type   int;
  v_bad_src    int;
  v_not_legacy int;
  v_sum_before text;
  v_sum_after  text;
  v_rest_before text;
  v_rest_after text;
  v_upd        int;
  v_changed    int;
  v_not_trial  int;
  v_off        text;
BEGIN
  -- 1. 前置核對
  -- 正式庫若有版控外的 trigger（例如改資料就發通知），先停下來查清楚
  SELECT string_agg(tgname, ', ' ORDER BY tgname) INTO v_src
    FROM pg_trigger
   WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal
     AND tgname NOT IN ('trg_class_sessions_updated_at', 'trg_session_anomaly', 'trg_guard_class_session_pricing');
  IF v_src IS NOT NULL THEN
    RAISE EXCEPTION 'class_sessions 有預期以外的 trigger：%，停止', v_src;
  END IF;
  -- 本檔會暫停再恢復 trigger：執行前三個都必須是啟用狀態，免得把別人刻意關掉的 trigger 默默打開
  SELECT string_agg(tgname, ', ' ORDER BY tgname) INTO v_src
    FROM pg_trigger
   WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal AND tgenabled <> 'O';
  IF v_src IS NOT NULL THEN
    RAISE EXCEPTION 'class_sessions 有 trigger 目前不是啟用狀態：%，停止（請先查清楚是誰關的）', v_src;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE in_sessions),
         count(*) FILTER (WHERE in_quarantine AND NOT in_sessions),
         count(*) FILTER (WHERE NOT in_sessions AND NOT in_quarantine),
         count(*) FILTER (WHERE in_sessions AND type_before = 'other'),
         count(*) FILTER (WHERE in_sessions AND type_before = 'trial'),
         count(*) FILTER (WHERE in_sessions AND type_before NOT IN ('other', 'trial')),
         count(*) FILTER (WHERE in_sessions AND source IS DISTINCT FROM 'historical_import'),
         count(*) FILTER (WHERE in_sessions AND type_before = 'other' AND pricing_status IS DISTINCT FROM 'legacy')
    INTO v_staged, v_in, v_quar, v_missing, v_other, v_trial, v_bad_type, v_bad_src, v_not_legacy
    FROM _maple;
  IF v_staged <> 12 THEN
    RAISE EXCEPTION '總表暫存表裡的楓葉體驗課應為 12 列，實際 % 列，停止', v_staged;
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION '有 % 列楓葉體驗課既不在 class_sessions 也不在隔離區，停止', v_missing;
  END IF;
  IF v_bad_type > 0 OR v_bad_src > 0 THEN
    RAISE EXCEPTION '有 % 筆已被改成其他課程類型、% 筆來源不是總表匯入，停止（請先查是誰改的）', v_bad_type, v_bad_src;
  END IF;
  IF v_not_legacy > 0 THEN
    RAISE EXCEPTION '有 % 筆的定價狀態不是 legacy（改課程類型可能被定價防呆擋下或影響重算），停止', v_not_legacy;
  END IF;
  IF v_other = 0 THEN
    RAISE NOTICE '已經是體驗課（% 筆，另 % 列在隔離區），本次不做任何變更', v_trial, v_quar;
    RETURN;
  END IF;

  -- 2. 改之前記下整張表的金額與狀態，以及對象以外所有列的完整內容
  SELECT row(count(*), sum(base_salary), sum(bonus), sum(total_salary), sum(paid_amount),
             count(*) FILTER (WHERE status = 'paid'), count(*) FILTER (WHERE status = 'approved'),
             count(*) FILTER (WHERE status = 'pending'), max(paid_at))::text
    INTO v_sum_before FROM public.class_sessions;
  SELECT md5(string_agg(to_jsonb(cs)::text, E'\n' ORDER BY cs.id)) INTO v_rest_before
    FROM public.class_sessions cs WHERE cs.id NOT IN (SELECT id FROM _maple);

  -- 3. 只改課程類型（暫停更新時間與異常兩個 trigger，定價防呆照常運作）
  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_class_sessions_updated_at;
  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;
  UPDATE public.class_sessions cs
     SET course_type = 'trial'
    FROM _maple t
   WHERE t.id = cs.id AND t.in_sessions AND t.type_before = 'other' AND cs.course_type = 'other';
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_class_sessions_updated_at;
  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;
  SELECT string_agg(tgname, ', ') INTO v_off
    FROM pg_trigger
   WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal AND tgenabled <> 'O';
  IF v_off IS NOT NULL THEN
    RAISE EXCEPTION 'trigger 沒有恢復：%，已取消', v_off;
  END IF;
  IF v_upd <> v_other THEN
    RAISE EXCEPTION '更新筆數不符：% 筆（應 %），已取消', v_upd, v_other;
  END IF;

  -- 4. 事後核對：對象只差課程類型（連更新時間、異常標記都不變），其他列與整張表的金額狀態完全不變
  SELECT count(*) FILTER (WHERE md5((to_jsonb(cs) - 'course_type')::text)
                                IS DISTINCT FROM t.fp_before),
         count(*) FILTER (WHERE cs.course_type IS DISTINCT FROM 'trial')
    INTO v_changed, v_not_trial
    FROM _maple t JOIN public.class_sessions cs ON cs.id = t.id;
  SELECT row(count(*), sum(base_salary), sum(bonus), sum(total_salary), sum(paid_amount),
             count(*) FILTER (WHERE status = 'paid'), count(*) FILTER (WHERE status = 'approved'),
             count(*) FILTER (WHERE status = 'pending'), max(paid_at))::text
    INTO v_sum_after FROM public.class_sessions;
  SELECT md5(string_agg(to_jsonb(cs)::text, E'\n' ORDER BY cs.id)) INTO v_rest_after
    FROM public.class_sessions cs WHERE cs.id NOT IN (SELECT id FROM _maple);
  IF v_changed > 0 OR v_not_trial > 0 OR v_sum_after IS DISTINCT FROM v_sum_before
     OR v_rest_after IS DISTINCT FROM v_rest_before THEN
    RAISE EXCEPTION '事後核對不符，已取消：對象有 % 筆課程類型以外的欄位變了、% 筆不是體驗課、整張表金額狀態 %→%、其他列%變動',
      v_changed, v_not_trial, v_sum_before, v_sum_after,
      CASE WHEN v_rest_after IS DISTINCT FROM v_rest_before THEN '有' ELSE '沒有' END;
  END IF;

  RAISE NOTICE '完成：% 筆楓葉體驗課改成體驗課（另 % 列在隔離區未動）；只改課程類型，其他欄位與其他資料都不變',
    v_upd, v_quar;
END $$;

COMMIT;

-- 結果摘要（交易已結束，這是改完後的實際狀態）
SELECT '08 楓葉體驗課' AS "步驟",
       cs.course_type AS "目前課程類型",
       count(*) AS "筆數",
       sum(cs.base_salary) AS "薪資合計",
       sum(cs.bonus) AS "獎金合計",
       sum(cs.paid_amount) AS "已領合計",
       count(*) FILTER (WHERE cs.status = 'paid') AS "已付款",
       count(*) FILTER (WHERE cs.status <> 'paid') AS "未付款",
       count(*) FILTER (WHERE cs.is_anomaly) AS "異常標記",
       min(cs.session_date)::text || '～' || max(cs.session_date)::text AS "日期範圍"
  FROM public.salary_master_rows m
  JOIN public.class_sessions cs ON cs.id = m.class_session_id
 WHERE m.batch = '2026-10-19' AND btrim(m.raw_course_kind) = '楓葉體驗課'
 GROUP BY cs.course_type;
