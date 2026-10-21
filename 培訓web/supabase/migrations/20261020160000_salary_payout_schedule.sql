-- ═══════════════════════════════════════════════════════════════════
-- 2026-10-20 講師「我的報酬」黃卡改成「X月累計報酬＋下次匯款日」（業主需求）
--   業主：「像是 12/10 匯款，前面就是 11月累計報酬」；匯款日要能在後台改。
--   一期＝結算週期「上月 26 日～本月 25 日」，以結束月份命名（11 月＝10/26～11/25），隔月匯款日匯（業主 10/20 確認）。
--
--   salary_payout_schedule：全站只有一列（id 固定 true）
--     next_payday  下次匯款日（後台可改；遇假日提前／延後就改這個）
--     regular_day  每月固定匯款日（1～28）；next_payday 過了，前端自動跳到下一期的這一天
--   權限：已核准角色（teacher／mentor／admin）可讀；只有 admin 可改這兩欄；
--         updated_at／updated_by 由 trigger 寫，前端送什麼都不算。
--   前端讀不到這張表時（尚未套用）會退回「每月 10 號」，頁面照常運作。
-- 本檔可重複執行；重跑不會覆蓋後台已改過的日期。
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.salary_payout_schedule (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  next_payday  date NOT NULL,
  regular_day  smallint NOT NULL DEFAULT 10 CHECK (regular_day BETWEEN 1 AND 28),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES auth.users (id) ON DELETE SET NULL
);

COMMENT ON TABLE public.salary_payout_schedule IS
  '講師報酬匯款日（單列）。前端顯示下次匯款日要匯的那一期（上月 26 日～本月 25 日）累計報酬與匯款日；日期過了自動跳下一期的 regular_day。';

INSERT INTO public.salary_payout_schedule (id, next_payday, regular_day)
VALUES (true, DATE '2026-11-10', 10)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.stamp_salary_payout_schedule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_salary_payout_schedule() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_stamp_salary_payout_schedule ON public.salary_payout_schedule;
CREATE TRIGGER trg_stamp_salary_payout_schedule
  BEFORE UPDATE ON public.salary_payout_schedule
  FOR EACH ROW EXECUTE FUNCTION public.stamp_salary_payout_schedule();

ALTER TABLE public.salary_payout_schedule ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.salary_payout_schedule FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.salary_payout_schedule TO authenticated;
GRANT UPDATE (next_payday, regular_day) ON TABLE public.salary_payout_schedule TO authenticated;

DROP POLICY IF EXISTS "Approved roles can view salary payout schedule" ON public.salary_payout_schedule;
CREATE POLICY "Approved roles can view salary payout schedule"
  ON public.salary_payout_schedule FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role IN ('teacher', 'mentor', 'admin')
    )
  );

DROP POLICY IF EXISTS "Admins can update salary payout schedule" ON public.salary_payout_schedule;
CREATE POLICY "Admins can update salary payout schedule"
  ON public.salary_payout_schedule FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

NOTIFY pgrst, 'reload schema';
