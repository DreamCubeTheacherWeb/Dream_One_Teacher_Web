-- 薪資總表換新 2026-10-19｜步驟 7（唯讀盤點）：總表匯入後落在「其他」的課，在總表上原本寫的是什麼
-- 只有一個 SELECT，不改任何資料。貼到 Supabase SQL Editor 整段執行，結果是一張表，請整張回傳。
--
-- 範圍：class_sessions 中 source = 'historical_import' AND course_type = 'other' AND session_date >= 2026-01-01
--      （講師端「我的報酬」只看得到 2026-01 起的紀錄，這些就是確認區「其他課程」裡來自總表的列）。
-- 對應：03_apply.sql 匯入時 class_sessions.id 沿用 salary_master_rows.class_session_id（batch '2026-10-19'），
--      總表原始的「課程種類」在 salary_master_rows.raw_course_kind。
--      build_upload_csv.py 的 COURSE_MAP 把「其他」「楓葉體驗課」「學校社團」「徵稿」與對不到的種類都轉成 'other'。
--
-- 結果欄位：
--   區塊 1 依總表原始課程種類分組（含合計）
--   區塊 2 總表種類寫「其他」的，再依課程名稱分組（看裡面有沒有其實是某種課的）
--   區塊 3 改分類前要知道的檢查數字（全部應為說明欄寫的預期值）
WITH base AS (
  SELECT cs.id,
         cs.instructor_id,
         cs.instructor_name,
         cs.session_date,
         cs.course_name,
         coalesce(cs.base_salary, 0) AS base_salary,
         coalesce(cs.bonus, 0)       AS bonus,
         coalesce(cs.paid_amount, 0) AS paid_amount,
         cs.status::text             AS status,
         cs.pricing_status,
         cs.is_anomaly,
         m.class_session_id IS NOT NULL AS has_master,
         CASE WHEN m.class_session_id IS NULL THEN '（對不到總表暫存列）'
              ELSE coalesce(nullif(btrim(m.raw_course_kind), ''), '（總表空白）') END AS kind
    FROM public.class_sessions cs
    LEFT JOIN public.salary_master_rows m
      ON m.class_session_id = cs.id AND m.batch = '2026-10-19'
   WHERE cs.source = 'historical_import'
     AND cs.course_type = 'other'
     AND cs.session_date >= DATE '2026-01-01'
),
tagged AS (
  SELECT 1 AS sec, '1 依總表原始課程種類' AS section, kind AS item, b.* FROM base b
  UNION ALL
  SELECT 1, '1 依總表原始課程種類', '＝ 合計', b.* FROM base b
  UNION ALL
  SELECT 2, '2 總表寫「其他」的課程名稱', coalesce(nullif(btrim(course_name), ''), '（無課程名稱）'), b.*
    FROM base b WHERE kind = '其他'
),
grouped AS (
  SELECT sec, section, item,
         count(*)                                         AS rows,
         count(DISTINCT coalesce(instructor_id::text, instructor_name)) AS instructors,
         sum(base_salary)                                 AS base_sum,
         sum(bonus)                                       AS bonus_sum,
         sum(paid_amount)                                 AS paid_sum,
         count(*) FILTER (WHERE status = 'pending')       AS st_pending,
         count(*) FILTER (WHERE status = 'approved')      AS st_approved,
         count(*) FILTER (WHERE status = 'paid')          AS st_paid,
         min(session_date)::text || '～' || max(session_date)::text AS date_range,
         CASE WHEN item = '＝ 合計' THEN '講師端看得到的（有對應講師）：' || count(*) FILTER (WHERE instructor_id IS NOT NULL) || ' 筆'
              ELSE NULL END                               AS note
    FROM tagged
   GROUP BY sec, section, item
),
checks AS (
  SELECT 3 AS sec, '3 檢查' AS section, item, n AS rows, note, ord
    FROM (VALUES
      (1, '匯入後課程類型已被改過的總表列（2026 起）',
       (SELECT count(*) FROM public.class_sessions cs
          JOIN public.salary_master_rows m ON m.class_session_id = cs.id AND m.batch = '2026-10-19'
         WHERE cs.session_date >= DATE '2026-01-01' AND cs.course_type IS DISTINCT FROM m.course_type),
       '預期 0；不是 0 代表有人在後台改過，改分類時要避開'),
      (2, '上面「其他」列中 pricing_status 不是 legacy',
       (SELECT count(*) FROM base WHERE pricing_status IS DISTINCT FROM 'legacy'),
       '預期 0；quoted 的列改課程類型會被定價防呆擋下'),
      (3, '上面「其他」列中目前標記為異常（is_anomaly）',
       (SELECT count(*) FROM base WHERE is_anomaly),
       '參考用；改分類時資料庫會重算這個標記'),
      (4, '上面「其他」列中對不到總表暫存列',
       (SELECT count(*) FROM base WHERE NOT has_master),
       '預期 0'),
      (5, '2026 年以前的總表「其他」列（講師端看不到）',
       (SELECT count(*) FROM public.class_sessions
         WHERE source = 'historical_import' AND course_type = 'other' AND session_date < DATE '2026-01-01'),
       '參考用；本機模擬（上傳檔＋05 推估更正）是 170 筆'),
      (6, '總表暫存列筆數（batch 2026-10-19）',
       (SELECT count(*) FROM public.salary_master_rows WHERE batch = '2026-10-19'),
       '預期 5535')
    ) AS v(ord, item, n, note)
)
SELECT section AS "區塊", item AS "項目", rows AS "筆數", instructors AS "講師數",
       base_sum AS "薪資合計", bonus_sum AS "獎金合計", paid_sum AS "已領合計",
       st_pending AS "待核准", st_approved AS "已核准", st_paid AS "已付款",
       date_range AS "日期範圍", note AS "說明"
  FROM (
    SELECT sec, section, item, rows, instructors, base_sum, bonus_sum, paid_sum,
           st_pending, st_approved, st_paid, date_range, note,
           CASE WHEN item = '＝ 合計' THEN 1 ELSE 0 END AS is_total, 0 AS ord
      FROM grouped
    UNION ALL
    SELECT sec, section, item, rows, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, note, 0, ord
      FROM checks
  ) x
 ORDER BY sec, is_total, ord, rows DESC, item;
