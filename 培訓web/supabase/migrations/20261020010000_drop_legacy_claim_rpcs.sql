-- ═══════════════════════════════════════════════════════════════════
-- 移除 2026-07 舊認領流程留下的函式與客戶端寫入政策（2026-10-20 大檢查）
-- 可重複執行。只刪函式與一條政策，不動任何資料列。
--
-- 背景：2026-08-24 起認領改走 claim_my_precreated_instructor／claim_existing_instructor_by_identity
--   （只准 pending 呼叫、計數器在 private schema）。但 07-09 的舊函式從沒 DROP：
--   * submit_claim_request：SECURITY DEFINER、不檢查呼叫者角色（已綁定的 teacher 也能再綁一筆），
--     主檔沒身分證時只要對上手機末四碼就放行，猜錯次數存在客戶端可寫入的 instructor_claim_requests。
--   * search_unlinked_instructors：任何登入者（含剛用 Google 登入的 pending）都能列出未認領講師姓名。
--   前端（src/）已無任何呼叫；兩支都只剩測試假資料提到。
-- 同時收掉 instructor_claim_requests 的客戶端 INSERT 政策（"Users can create own claims"）：
--   新流程不寫這張表，留著只讓人能自己塞申請列。本人讀取、管理員 FOR ALL 兩條政策不動。
-- ═══════════════════════════════════════════════════════════════════

-- 1. 舊認領函式：不管簽章（07 月有 3 參數與 4 參數兩版）一律刪除
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('submit_claim_request', 'search_unlinked_instructors')
  LOOP
    RAISE NOTICE 'dropping legacy claim function %', fn.signature;
    EXECUTE format('DROP FUNCTION %s', fn.signature);
  END LOOP;
END;
$$;

-- 2. 申請表不再開放客戶端新增
DO $$
BEGIN
  IF to_regclass('public.instructor_claim_requests') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Users can create own claims" ON public.instructor_claim_requests';
  END IF;
END;
$$;
