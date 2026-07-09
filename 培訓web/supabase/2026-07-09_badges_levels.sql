-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  徽章補完：講師等級完整階梯（實習 → B → A → A+ → S）
-- ───────────────────────────────────────────────────────────────────
-- 原本只有 level_s(S) 與 level_a(A+/A 混合)，業主要補齊完整五級。
--   新增：intern(實習)、level_b(B)、level_aplus(A+)。
--   調整：level_a 從「A+ 或 A」改成「只有 A」（判定邏輯在前端 badges.js，
--         DB 這裡只改說明文字與排序，讓成就牆等級組呈 實習→S 階梯）。
-- 相依：需先跑過 2026-07-09_badges_foundation.sql（badge_definitions 表與既有徽章）。
-- 冪等：新增用 ON CONFLICT DO NOTHING；調整用 UPDATE（等級徽章的 sort_order 後台未開放編輯，
--       直接覆蓋安全）。可重複執行。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 新增三個等級徽章（rule_type=special，判定邏輯寫在 badges.js）──────
INSERT INTO public.badge_definitions
  (key, emoji, name, category, description, rule_type, rule_metric, rule_threshold, rule_operator, rule_special, sort_order)
VALUES
  ('intern','🔰','實習講師','level_tenure','講師等級 實習','special',NULL,NULL,'gte','level_intern',14),
  ('level_b','🔷','B 級講師','level_tenure','講師等級 B','special',NULL,NULL,'gte','level_b',15),
  ('level_aplus','💫','A+ 級講師','level_tenure','講師等級 A+','special',NULL,NULL,'gte','level_aplus',17)
ON CONFLICT (key) DO NOTHING;

-- ── 2. level_a 收斂為「只有 A」＋排到 B 與 A+ 之間 ─────────────────────
UPDATE public.badge_definitions
   SET description = '講師等級 A', sort_order = 16
 WHERE key = 'level_a';

-- ── 3. level_s 排到階梯最頂（實習14 / B15 / A16 / A+17 / S18）──────────
UPDATE public.badge_definitions
   SET sort_order = 18
 WHERE key = 'level_s';

-- ── 驗證：等級組應為 實習→B→A→A+→S 五顆 ─────────────────────────────
SELECT key, name, rule_special, sort_order
  FROM public.badge_definitions
 WHERE category = 'level_tenure' AND rule_type = 'special'
 ORDER BY sort_order;
