-- ═══════════════════════════════════════════════════════════════════
-- 電子簽名：本人驗證 audit 欄位 2026-07-07
-- 在 Supabase SQL Editor 貼上執行，可重複執行（idempotent）。
-- ───────────────────────────────────────────────────────────────────
-- 背景：簽約流程原本只記 signed_at / ip_address / user_agent，本人性很弱。
-- 加上「簽名前 email 驗證碼確認」後，在此表補記驗證證據，供事後舉證。
-- 前端流程：講師按「開始簽署」→ Supabase 寄 6 碼到其 email → 輸入驗證通過
--           → 解鎖簽名畫布 → 送出時一併寫入 verified_at / verify_method。
-- ⚠️ 法律效力提醒：「email 驗證 + 手寫簽名」屬台灣《電子簽章法》的一般電子簽章，
--    有效力但「不推定本人親簽」（只有政府核可憑證的數位簽章才推定）。一般師資
--    合約通常足夠，高價值合約請諮詢律師。此為提醒，非法律意見。
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.instructor_contracts
  ADD COLUMN IF NOT EXISTS verified_at  timestamptz,  -- email 驗證通過的時間
  ADD COLUMN IF NOT EXISTS verify_method text;         -- 驗證方式，如 'email_otp'

-- 驗證：
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'instructor_contracts'
--     AND column_name IN ('verified_at','verify_method');
