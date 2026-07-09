-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  講師個人資料新增「戶籍地址」欄位
-- ───────────────────────────────────────────────────────────────────
-- 需求：個人頁除了「通訊地址」外，讓講師也能填「戶籍地址」（前端設為必填）。
-- 影響：instructors 表加一個 text 欄位；不動 RLS（沿用既有本人可讀寫政策）。
-- 冪等：ADD COLUMN IF NOT EXISTS，可重跑。
-- 相依：instructors_setup.sql（instructors 表本體）。
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS household_address text;  -- 戶籍地址

COMMENT ON COLUMN public.instructors.household_address IS '戶籍地址（前端必填，與通訊地址分開）';

-- 驗證：
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'instructors' AND column_name = 'household_address';
