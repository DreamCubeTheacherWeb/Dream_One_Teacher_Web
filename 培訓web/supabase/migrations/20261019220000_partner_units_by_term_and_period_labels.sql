-- ═══════════════════════════════════════════════════════════════════
-- 合作單位清單依教學期間分開（寒暑假／學期間）＋ 期間顯示文字照 B2B 表單
--   業主 2026-10-19：「寒暑假和學期間兩題可以分開，後台可以各自改，選到某個期間時下面的
--   單位選項會對應好」「寒假/學期間/暑假的文字要和表單一樣，後台可設定」。
-- 依賴：20261018120000_align_salary_report_with_forms.sql 已套用（salary_report_options 存在）。
-- 上線順序：先套本 migration，再部署會讀 term_scope 的前端。
-- 本檔可重複執行。只加欄位與回填，不刪任何資料；RLS、權限、RPC 皆不動。
-- ═══════════════════════════════════════════════════════════════════

-- A. 新欄位：合作單位屬於哪一組清單（vacation＝寒暑假、semester＝學期間）；其他種類為 NULL
ALTER TABLE public.salary_report_options
  ADD COLUMN IF NOT EXISTS term_scope text;

COMMENT ON COLUMN public.salary_report_options.term_scope IS
  '合作單位（kind=partner_unit）屬於哪組清單：vacation=寒暑假、semester=學期間；其他 kind 為 NULL';

-- B. 回填既有合作單位：10/18 種子先放寒暑假 48 筆（sort_order 10–480）、再放學期間 30 筆（490–780）。
--    名稱含「115上」者一律學期間（表單學期間清單的命名慣例），其餘依種子排序值判斷。
UPDATE public.salary_report_options
   SET term_scope = CASE
         WHEN value LIKE '%115上%' OR label LIKE '%115上%' OR sort_order >= 490 THEN 'semester'
         ELSE 'vacation'
       END
 WHERE kind = 'partner_unit' AND term_scope IS NULL;

-- 非合作單位的種類不該有 term_scope
UPDATE public.salary_report_options SET term_scope = NULL WHERE kind <> 'partner_unit' AND term_scope IS NOT NULL;

-- C. 約束：合作單位必須有組別，其他種類必須為 NULL（回填完才加，可重跑）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.salary_report_options'::regclass
       AND conname = 'salary_report_options_term_scope_check'
  ) THEN
    ALTER TABLE public.salary_report_options
      ADD CONSTRAINT salary_report_options_term_scope_check
      CHECK (
        (kind = 'partner_unit' AND term_scope IS NOT NULL AND term_scope IN ('vacation', 'semester'))
        OR (kind <> 'partner_unit' AND term_scope IS NULL)
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS salary_report_options_kind_scope_sort_idx
  ON public.salary_report_options (kind, term_scope, sort_order);

-- D. 教學課程期間顯示文字改成與 B2B 表單相同；只改仍是 10/18 預設文字的列，管理員改過的不覆寫
UPDATE public.salary_report_options SET label = '2026年寒假'       WHERE kind = 'term_period' AND value = 'winter_break' AND label = '寒假';
UPDATE public.salary_report_options SET label = '115學年度上學期'  WHERE kind = 'term_period' AND value = 'semester'     AND label = '學期間';
UPDATE public.salary_report_options SET label = '2026年暑假'       WHERE kind = 'term_period' AND value = 'summer_break' AND label = '暑假';

COMMENT ON TABLE public.salary_report_options IS
  '站內課程回報的下拉選項（對齊 Google 課後回報表單）；合作單位以 term_scope 分寒暑假／學期間兩組清單；停用選項請改 is_active=false，不要刪除';
