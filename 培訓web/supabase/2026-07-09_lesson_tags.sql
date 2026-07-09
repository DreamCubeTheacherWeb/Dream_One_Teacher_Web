-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  章節 hashtag：lessons 加 tags 欄位
-- ───────────────────────────────────────────────────────────────────
-- 需求：課程章節列表卡片原本顯示「N 文章／閱讀約 N 分鐘」，業主要改成
--       自由 hashtag——後台每課可自訂標籤，前台卡片顯示 #標籤。
-- 做法：lessons 加 text[] 欄位，預設空陣列。讀寫沿用 lessons 既有 RLS，
--       不新增任何政策（本檔不碰權限）。
-- 前端：後台 /admin/cms/:courseId 每課有 hashtag 編輯列；
--       前台課程頁自動顯示。SQL 未跑前前端不會壞（讀不到就當沒有標籤，
--       後台儲存時會提示先跑本檔）。
-- 冪等：可重複執行。
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.lessons
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

-- ── 驗證：應回一列 tags / ARRAY ─────────────────────────────────────
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'lessons' AND column_name = 'tags';
