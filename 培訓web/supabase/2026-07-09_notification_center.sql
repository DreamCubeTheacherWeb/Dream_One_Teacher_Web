-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  廣播通知中心（admin 隨時發＋排程定時發，小鈴鐺站內通知）
-- ───────────────────────────────────────────────────────────────────
-- 需求：管理員要能 (1) 任何時候立即發通知給全體講師的小鈴鐺；
--       (2) 預先排程在指定時間發送，可選每天／每週／每月重複。
-- 做法：
--   1. admin_broadcast_notification RPC — 前端「立即發送」按鈕呼叫，
--      內含 admin 角色守衛（本專案鐵律：SECURITY DEFINER 必加守衛）。
--   2. scheduled_notifications 表 — 排程佇列，RLS 只允許 admin 讀寫。
--   3. pg_cron 每分鐘跑 process_scheduled_notifications()：
--      到期的 pending 列 → 發通知 → 標記 sent；有重複規則的推進到下一次。
-- 通知 type 沿用 'announcement'（小鈴鐺前端已認識，不用改 CHECK 與圖示）。
-- 對象：'teachers' ＝ role teacher/mentor；'all' ＝ 所有非 pending 使用者。
-- 時區：send_at 是 timestamptz，前端存 UTC、顯示轉台北時間，無換算問題；
--       pg_cron 每分鐘輪詢，實際送達時間最多晚設定時間 1 分鐘。
-- 冪等：整份可重複執行。與 2026-07-09_salary_reminder_cron.sql 同款排程手法。
-- 補漏機制：若 cron 停擺（如 DB 維護）錯過時間，恢復後會補發一次、
--       重複型的下一次時間會直接推進到未來（不會連環轟炸補齊每一發）。
-- ═══════════════════════════════════════════════════════════════════

-- ── 0. 啟用 pg_cron（若這行報錯，改到 Dashboard → Database → Extensions 開啟）──
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── 1. 排程佇列表 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduled_notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL CHECK (length(btrim(title)) > 0),
  body         text,
  link         text,
  audience     text NOT NULL DEFAULT 'teachers' CHECK (audience IN ('teachers', 'all')),
  send_at      timestamptz NOT NULL,
  repeat_rule  text NOT NULL DEFAULT 'none' CHECK (repeat_rule IN ('none', 'daily', 'weekly', 'monthly')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  last_sent_at timestamptz,
  created_by   uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sched_notif_due
  ON public.scheduled_notifications (send_at) WHERE status = 'pending';

ALTER TABLE public.scheduled_notifications ENABLE ROW LEVEL SECURITY;

-- RLS：只有 admin 能讀寫排程（一般講師連看都看不到）
DROP POLICY IF EXISTS "admin manage scheduled notifications" ON public.scheduled_notifications;
CREATE POLICY "admin manage scheduled notifications"
  ON public.scheduled_notifications FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

-- ── 2. 內部廣播函式（共用邏輯，不開放給任何登入者直接呼叫）──────────────
CREATE OR REPLACE FUNCTION public._broadcast_notification(
  p_title text, p_body text, p_link text, p_audience text
)
RETURNS integer AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.notifications (user_id, type, title, body, link)
  SELECT
    u.id,
    'announcement',
    btrim(p_title),
    NULLIF(btrim(coalesce(p_body, '')), ''),
    NULLIF(btrim(coalesce(p_link, '')), '')
  FROM public.users u
  WHERE CASE
    WHEN p_audience = 'all' THEN u.role <> 'pending'
    ELSE u.role IN ('teacher', 'mentor')
  END;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 守衛：不 GRANT 給任何人——只供下面兩支 definer 函式內部呼叫
REVOKE ALL ON FUNCTION public._broadcast_notification(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._broadcast_notification(text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public._broadcast_notification(text, text, text, text) FROM authenticated;

-- ── 3. 立即發送 RPC（前端「立即發送」按鈕用）─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_broadcast_notification(
  p_title    text,
  p_body     text DEFAULT NULL,
  p_link     text DEFAULT NULL,
  p_audience text DEFAULT 'teachers'
)
RETURNS integer AS $$
DECLARE
  v_role text;
BEGIN
  -- 角色守衛（鐵律：沒有這段＝任何登入者都能對全站發通知轟炸）
  SELECT role INTO v_role FROM public.users WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'title required';
  END IF;
  IF p_audience NOT IN ('teachers', 'all') THEN
    RAISE EXCEPTION 'invalid audience';
  END IF;
  RETURN public._broadcast_notification(p_title, p_body, p_link, p_audience);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.admin_broadcast_notification(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_broadcast_notification(text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_broadcast_notification(text, text, text, text) TO authenticated;

-- ── 4. 排程執行器（pg_cron 每分鐘呼叫）───────────────────────────────
CREATE OR REPLACE FUNCTION public.process_scheduled_notifications()
RETURNS integer AS $$
DECLARE
  r       record;
  v_next  timestamptz;
  v_step  interval;
  v_total integer := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.scheduled_notifications
    WHERE status = 'pending' AND send_at <= now()
    ORDER BY send_at
    FOR UPDATE SKIP LOCKED   -- 防兩個 cron 執行重疊時重複發送
  LOOP
    v_total := v_total + public._broadcast_notification(r.title, r.body, r.link, r.audience);

    IF r.repeat_rule = 'none' THEN
      UPDATE public.scheduled_notifications
        SET status = 'sent', last_sent_at = now()
        WHERE id = r.id;
    ELSE
      v_step := CASE r.repeat_rule
        WHEN 'daily'   THEN interval '1 day'
        WHEN 'weekly'  THEN interval '7 days'
        WHEN 'monthly' THEN interval '1 month'
      END;
      -- 從原設定時間推進到未來（保留原時刻；停擺補跑也只推進、不連發）
      v_next := r.send_at + v_step;
      WHILE v_next <= now() LOOP
        v_next := v_next + v_step;
      END LOOP;
      UPDATE public.scheduled_notifications
        SET send_at = v_next, last_sent_at = now()
        WHERE id = r.id;
    END IF;
  END LOOP;
  RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 守衛：只給排程（資料庫擁有者身分）呼叫
REVOKE ALL ON FUNCTION public.process_scheduled_notifications() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_scheduled_notifications() FROM anon;
REVOKE ALL ON FUNCTION public.process_scheduled_notifications() FROM authenticated;

-- ── 5. 掛排程（每分鐘輪詢；先解除同名舊排程，冪等）───────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('process-scheduled-notifications');
EXCEPTION WHEN OTHERS THEN NULL; -- 尚未存在就略過
END $$;

SELECT cron.schedule(
  'process-scheduled-notifications',
  '* * * * *',
  $$SELECT public.process_scheduled_notifications()$$
);

-- ═══════════════════════════════════════════════════════════════════
-- 驗證查詢（執行後看結果自我確認）
-- ═══════════════════════════════════════════════════════════════════
-- 1) 排程有掛上（應有一列，schedule = * * * * *）：
SELECT jobname, schedule, command FROM cron.job
 WHERE jobname = 'process-scheduled-notifications';

-- 2) 表與 RLS 政策存在（應各有一列）：
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'scheduled_notifications';

-- 3) RPC 有守衛（函式定義應含 admin only 的 RAISE EXCEPTION）：
-- SELECT pg_get_functiondef('public.admin_broadcast_notification(text,text,text,text)'::regprocedure);

-- 4) 端到端測排程（會真的發通知，測試時建議先只發給自己）：
--    a. 網頁後台建一筆 1-2 分鐘後的排程 → 等 2 分鐘 → 小鈴鐺應出現通知
--    b. 看排程執行紀錄：
-- SELECT jobname, status, return_message, start_time FROM cron.job_run_details
--  WHERE jobname = 'process-scheduled-notifications' ORDER BY start_time DESC LIMIT 5;
