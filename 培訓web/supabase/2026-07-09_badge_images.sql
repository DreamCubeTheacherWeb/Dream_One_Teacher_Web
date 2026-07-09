-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  徽章自訂圖示（admin 上傳 PNG，取代只能選 emoji）
-- ───────────────────────────────────────────────────────────────────
-- 需求：後台建/改徽章時，admin 可上傳 PNG 當圖示（前端會先壓縮）。
-- 做法：badge_definitions 加 image_path；建公開 bucket 'badge_icons'
--       （所有人可讀＝徽章要顯示給全體；只有 admin 可上傳/改/刪）。
-- 顯示優先序（前端）：image_path 上傳圖 > BadgeIcon 幾何圖(41 內建 key) > emoji。
-- 相依：需先跑過 2026-07-09_badges_foundation.sql。冪等：可重複執行。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 徽章定義加「上傳圖路徑」欄位 ──────────────────────────────────
ALTER TABLE public.badge_definitions ADD COLUMN IF NOT EXISTS image_path text;
COMMENT ON COLUMN public.badge_definitions.image_path
  IS 'admin 上傳的自訂徽章圖（badge_icons bucket 內的路徑）；有值時優先於內建幾何圖與 emoji。';

-- ── 2. 公開圖床 bucket（所有人可讀、admin 可寫）──────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('badge_icons', 'badge_icons', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- ── 3. Storage RLS：公開讀 + 只有 admin 可上傳/改/刪 ────────────────
DROP POLICY IF EXISTS "badge_icons public read"   ON storage.objects;
DROP POLICY IF EXISTS "badge_icons admin insert"  ON storage.objects;
DROP POLICY IF EXISTS "badge_icons admin update"  ON storage.objects;
DROP POLICY IF EXISTS "badge_icons admin delete"  ON storage.objects;

CREATE POLICY "badge_icons public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'badge_icons');

CREATE POLICY "badge_icons admin insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'badge_icons'
    AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "badge_icons admin update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'badge_icons'
    AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "badge_icons admin delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'badge_icons'
    AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

-- ── 驗證 ────────────────────────────────────────────────────────────
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'badge_definitions' AND column_name = 'image_path';
SELECT id, public FROM storage.buckets WHERE id = 'badge_icons';
SELECT policyname FROM pg_policies
 WHERE tablename = 'objects' AND policyname LIKE 'badge_icons%';
