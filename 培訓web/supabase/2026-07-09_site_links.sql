-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  站內可編輯外連連結：site_links（第一個用途：我的薪資頁兩顆表單按鈕）
-- ───────────────────────────────────────────────────────────────────
-- 背景：公司暫停用網站做薪資登記，改用兩份 Google 表單收單。「我的薪資」頁
--   改成只顯示兩顆大按鈕連到表單，原統計/表格 UI 隱藏但保留（日後可能恢復）。
--   兩顆按鈕的標題/說明/網址要能在後台編輯，不寫死在前端。
-- 設計：key/value 型態的小表，key 為固定英文代碼（前端用 key 撈資料，不靠 id）。
--   目前只用兩列（salary_direct / salary_partner），但表設計成通用鍵值，
--   未來若有其他頁面要外連表單可以直接加列複用。
-- 權限：登入者可讀（前端頁面要顯示）；只有 admin 可寫（RLS 擋，後台管理頁用）。
-- 冪等：CREATE TABLE IF NOT EXISTS、DROP POLICY IF EXISTS 再 CREATE、
--   seed 用 ON CONFLICT (key) DO NOTHING（重跑不覆蓋管理員已改過的值）。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 資料表 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.site_links (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  description text,
  url         text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 2. RLS：登入者可讀；只有 admin 可寫 ─────────────────────────────
ALTER TABLE public.site_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "site_links read"  ON public.site_links;
DROP POLICY IF EXISTS "site_links admin" ON public.site_links;
CREATE POLICY "site_links read"  ON public.site_links FOR SELECT
  USING (auth.uid() IS NOT NULL);
CREATE POLICY "site_links admin" ON public.site_links FOR ALL
  USING      (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

-- ── 3. Seed 三列（重跑不覆蓋後台已改的）─────────────────────────────
INSERT INTO public.site_links (key, label, description, url)
VALUES
  ('salary_direct',  '直營課程', '營隊、體驗課、到府課、速解課',
   'https://docs.google.com/forms/d/e/1FAIpQLScKSEUXDctk1cqB7UqDc7CwY9I0g8e6T1XBaX-52c6C5GdTjg/viewform'),
  ('salary_partner', '合作單位', '補習班、學校社團、講座課程',
   'https://forms.gle/CBfwjZv34vT35nZTA'),
  ('salary_points',  '報酬 / 點數確認區', '查看每月報酬與點數結算結果',
   'https://docs.google.com/spreadsheets/d/1RQP_7NZFeEQTKcGJPjkoRe758LeADSpDIkY2-s2Q8NI/edit?gid=450117981#gid=450117981')
ON CONFLICT (key) DO NOTHING;

-- ── 驗證 ────────────────────────────────────────────────────────────
SELECT key, label, description, url, updated_at FROM public.site_links ORDER BY key;
-- 應有 3 列：salary_direct、salary_partner、salary_points。
-- ⚠️ 提醒：salary_points 連到 Google 試算表，請確認該試算表的共用設定是
--   「知道連結的使用者＝檢視者」，否則講師點進去會看到「要求存取權」。
