-- 總表匯入「其他」重新分類｜還原步驟 8：楓葉體驗課改回「其他」（單一交易，只改課程類型）
-- 把 08_reclassify_maple_trial.sql 改成體驗課的列，改回總表匯入時的課程類型（salary_master_rows.course_type，即 'other'）。
-- 只改 course_type；金額、狀態、付款時間、更新時間、異常標記等全部不動，交易內前後逐欄比對，不符即整批取消。
-- 與 08 相同：改的那一刻暫停「更新時間」與「異常標記」兩個 trigger，交易結束前恢復（保住 96 還原 06 所需的 updated_at）。
-- 可重複執行：已經是「其他」就不做任何變更。中途出錯後重跑若只看到「current transaction is aborted」，先單獨執行 ROLLBACK; 再重跑。
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '2min';
LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _maple ON COMMIT DROP AS
SELECT m.class_session_id AS id,
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
  v_bad_staged int;
  v_missing    int;
  v_quar       int;
  v_trial      int;
  v_other      int;
  v_bad_type   int;
  v_bad_src    int;
  v_not_legacy int;
  v_sum_before text;
  v_sum_after  text;
  v_rest_before text;
  v_rest_after text;
  v_upd        int;
  v_changed    int;
  v_not_back   int;
  v_off        text;
BEGIN
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
         count(*) FILTER (WHERE staged_type IS DISTINCT FROM 'other'),
         count(*) FILTER (WHERE NOT in_sessions AND NOT in_quarantine),
         count(*) FILTER (WHERE in_quarantine AND NOT in_sessions),
         count(*) FILTER (WHERE in_sessions AND type_before = 'trial'),
         count(*) FILTER (WHERE in_sessions AND type_before = 'other'),
         count(*) FILTER (WHERE in_sessions AND type_before NOT IN ('other', 'trial')),
         count(*) FILTER (WHERE in_sessions AND source IS DISTINCT FROM 'historical_import'),
         count(*) FILTER (WHERE in_sessions AND type_before = 'trial' AND pricing_status IS DISTINCT FROM 'legacy')
    INTO v_staged, v_bad_staged, v_missing, v_quar, v_trial, v_other, v_bad_type, v_bad_src, v_not_legacy
    FROM _maple;
  IF v_staged <> 12 OR v_bad_staged > 0 THEN
    RAISE EXCEPTION '總表暫存表的楓葉體驗課應為 12 列且匯入類型都是 other，實際 % 列、% 列不是 other，停止', v_staged, v_bad_staged;
  END IF;
  IF v_missing > 0 OR v_bad_type > 0 OR v_bad_src > 0 OR v_not_legacy > 0 THEN
    RAISE EXCEPTION '狀態不符，停止：% 列找不到、% 筆是其他課程類型、% 筆來源不是總表匯入、% 筆定價狀態不是 legacy',
      v_missing, v_bad_type, v_bad_src, v_not_legacy;
  END IF;
  IF v_trial = 0 THEN
    RAISE NOTICE '已經是「其他」（% 筆，另 % 列在隔離區），本次不做任何變更', v_other, v_quar;
    RETURN;
  END IF;

  SELECT row(count(*), sum(base_salary), sum(bonus), sum(total_salary), sum(paid_amount),
             count(*) FILTER (WHERE status = 'paid'), count(*) FILTER (WHERE status = 'approved'),
             count(*) FILTER (WHERE status = 'pending'), max(paid_at))::text
    INTO v_sum_before FROM public.class_sessions;
  SELECT md5(string_agg(to_jsonb(cs)::text, E'\n' ORDER BY cs.id)) INTO v_rest_before
    FROM public.class_sessions cs WHERE cs.id NOT IN (SELECT id FROM _maple);

  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_class_sessions_updated_at;
  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;
  UPDATE public.class_sessions cs
     SET course_type = t.staged_type
    FROM _maple t
   WHERE t.id = cs.id AND t.in_sessions AND t.type_before = 'trial' AND cs.course_type = 'trial';
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_class_sessions_updated_at;
  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;
  SELECT string_agg(tgname, ', ') INTO v_off
    FROM pg_trigger
   WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal AND tgenabled <> 'O';
  IF v_off IS NOT NULL THEN
    RAISE EXCEPTION 'trigger 沒有恢復：%，已取消', v_off;
  END IF;
  IF v_upd <> v_trial THEN
    RAISE EXCEPTION '還原筆數不符：% 筆（應 %），已取消', v_upd, v_trial;
  END IF;

  SELECT count(*) FILTER (WHERE md5((to_jsonb(cs) - 'course_type')::text)
                                IS DISTINCT FROM t.fp_before),
         count(*) FILTER (WHERE cs.course_type IS DISTINCT FROM 'other')
    INTO v_changed, v_not_back
    FROM _maple t JOIN public.class_sessions cs ON cs.id = t.id;
  SELECT row(count(*), sum(base_salary), sum(bonus), sum(total_salary), sum(paid_amount),
             count(*) FILTER (WHERE status = 'paid'), count(*) FILTER (WHERE status = 'approved'),
             count(*) FILTER (WHERE status = 'pending'), max(paid_at))::text
    INTO v_sum_after FROM public.class_sessions;
  SELECT md5(string_agg(to_jsonb(cs)::text, E'\n' ORDER BY cs.id)) INTO v_rest_after
    FROM public.class_sessions cs WHERE cs.id NOT IN (SELECT id FROM _maple);
  IF v_changed > 0 OR v_not_back > 0 OR v_sum_after IS DISTINCT FROM v_sum_before
     OR v_rest_after IS DISTINCT FROM v_rest_before THEN
    RAISE EXCEPTION '事後核對不符，已取消：對象有 % 筆課程類型以外的欄位變了、% 筆不是「其他」、整張表金額狀態 %→%、其他列%變動',
      v_changed, v_not_back, v_sum_before, v_sum_after,
      CASE WHEN v_rest_after IS DISTINCT FROM v_rest_before THEN '有' ELSE '沒有' END;
  END IF;

  RAISE NOTICE '還原完成：% 筆改回「其他」；金額、狀態與其他資料不變', v_upd;
END $$;

COMMIT;

SELECT '98 還原楓葉體驗課' AS "步驟",
       cs.course_type AS "目前課程類型",
       count(*) AS "筆數",
       sum(cs.base_salary) AS "薪資合計",
       sum(cs.bonus) AS "獎金合計",
       sum(cs.paid_amount) AS "已領合計",
       count(*) FILTER (WHERE cs.status = 'paid') AS "已付款",
       count(*) FILTER (WHERE cs.status <> 'paid') AS "未付款",
       count(*) FILTER (WHERE cs.is_anomaly) AS "異常標記"
  FROM public.salary_master_rows m
  JOIN public.class_sessions cs ON cs.id = m.class_session_id
 WHERE m.batch = '2026-10-19' AND btrim(m.raw_course_kind) = '楓葉體驗課'
 GROUP BY cs.course_type;
