-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  徽章系統地基（第 1 波）：資料驅動的徽章清單 + 手動頒發
-- ───────────────────────────────────────────────────────────────────
-- 目標：讓徽章「存在資料庫、可後台增刪」，並支援手動頒發/收回給特定講師。
--   badge_definitions：徽章清單（後台可 CRUD）。rule_type =
--     threshold（里程碑型：某統計 ≥/≤ 門檻，後台可自建）｜
--     special（特殊邏輯：破10秒/盲解/離島/彩蛋…判定寫在程式，後台可改名/開關但不可新增）｜
--     manual（純手動頒發，如密語彩蛋）。
--   badge_overrides：對特定講師「強制給(granted)/強制拿掉(revoked)」，覆蓋自動判定。
-- 權限：登入者可讀（前台成就牆要用）；只有 admin 可寫（RLS 擋）。
-- 冪等：ON CONFLICT DO NOTHING（重跑不覆蓋後台已改過的徽章）。
-- ⚠️ 本波只建「資料與權限」；自動判定的統計函式與前端成就牆在後續波次。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 徽章清單表 ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.badge_definitions (
  key           text PRIMARY KEY,
  name          text NOT NULL,
  emoji         text NOT NULL,
  category      text NOT NULL,                       -- teaching|wca_cube|level_tenure|region_role|fun
  description   text,
  rule_type     text NOT NULL DEFAULT 'manual',      -- threshold|special|manual
  rule_metric   text,                                -- threshold 用：total_hours/session_count/...
  rule_threshold numeric,                            -- threshold 用：門檻值
  rule_operator text DEFAULT 'gte',                  -- gte（越多越好）|lte（越小越好，如秒數）
  rule_special  text,                                -- special 用：對應程式裡的判定代碼
  active        boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 2. 手動頒發/收回表 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.badge_overrides (
  id            bigserial PRIMARY KEY,
  instructor_id uuid NOT NULL REFERENCES public.instructors(id) ON DELETE CASCADE,
  badge_key     text NOT NULL REFERENCES public.badge_definitions(key) ON DELETE CASCADE,
  state         text NOT NULL CHECK (state IN ('granted','revoked')),
  note          text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instructor_id, badge_key)
);
CREATE INDEX IF NOT EXISTS idx_badge_overrides_instructor ON public.badge_overrides (instructor_id);

-- ── 3. RLS：登入者可讀；只有 admin 可寫 ─────────────────────────────
ALTER TABLE public.badge_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.badge_overrides   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "badge_defs read"  ON public.badge_definitions;
DROP POLICY IF EXISTS "badge_defs admin" ON public.badge_definitions;
CREATE POLICY "badge_defs read"  ON public.badge_definitions FOR SELECT
  USING (auth.uid() IS NOT NULL);
CREATE POLICY "badge_defs admin" ON public.badge_definitions FOR ALL
  USING      (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

DROP POLICY IF EXISTS "badge_ovr read"  ON public.badge_overrides;
DROP POLICY IF EXISTS "badge_ovr admin" ON public.badge_overrides;
CREATE POLICY "badge_ovr read"  ON public.badge_overrides FOR SELECT
  USING (auth.uid() IS NOT NULL);
CREATE POLICY "badge_ovr admin" ON public.badge_overrides FOR ALL
  USING      (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

-- ── 4. Seed 38 個徽章（重跑不覆蓋後台已改的）───────────────────────────
INSERT INTO public.badge_definitions
  (key, emoji, name, category, description, rule_type, rule_metric, rule_threshold, rule_operator, rule_special, sort_order)
VALUES
  ('hours_50','🌱','接課新星','teaching','接課滿 50 小時','threshold','total_hours',50,'gte',NULL,0),
  ('hours_100','⭐','百時講師','teaching','接課滿 100 小時','threshold','total_hours',100,'gte',NULL,1),
  ('hours_300','🔥','教學好手','teaching','接課滿 300 小時','threshold','total_hours',300,'gte',NULL,2),
  ('hours_500','👑','魔方宗師','teaching','接課滿 500 小時','threshold','total_hours',500,'gte',NULL,3),
  ('sessions_100','🎯','百場老手','teaching','接課滿 100 場','threshold','session_count',100,'gte',NULL,4),
  ('sessions_300','🎖️','場次鐵人','teaching','接課滿 300 場','threshold','session_count',300,'gte',NULL,5),
  ('reach_500','👥','春風化雨','teaching','教過 500 人次','threshold','student_reach',500,'gte',NULL,6),
  ('reach_2000','🏛️','萬人導師','teaching','教過 2000 人次','threshold','student_reach',2000,'gte',NULL,7),
  ('coursetype_5','🃏','斜槓講師','teaching','教過 5 種課型','threshold','course_type_count',5,'gte',NULL,8),
  ('coursetype_10','🎨','全能教師','teaching','教過 10 種課型','threshold','course_type_count',10,'gte',NULL,9),
  ('wca_certified','🏅','WCA 認證選手','wca_cube','有綁定 WCA 帳號並有成績','threshold','wca_event_count',1,'gte',NULL,10),
  ('wca_sub10','🚀','光速小子','wca_cube','3x3 單次破 10 秒','threshold','wca_333_single',1000,'lte',NULL,11),
  ('wca_sub8','💎','頂尖選手','wca_cube','3x3 單次破 8 秒','threshold','wca_333_single',800,'lte',NULL,12),
  ('wca_allround10','🌀','全能玩家','wca_cube','10 個以上項目有成績','threshold','wca_event_count',10,'gte',NULL,13),
  ('wca_bf','🧿','盲解大師','wca_cube','有三階盲解成績','special',NULL,NULL,'gte','wca_has_bf',14),
  ('wca_bigcube','🐘','大魔王馴獸師','wca_cube','有 6x6 或 7x7 成績','special',NULL,NULL,'gte','wca_has_bigcube',15),
  ('cube_sub20','🎲','內部競速達標','wca_cube','方塊競速破 20 秒','threshold','cube_best_ms',20000,'lte',NULL,16),
  ('cube_kb50','⌨️','鍵盤俠','wca_cube','鍵盤模式解出 50 次','threshold','cube_keyboard_solves',50,'gte',NULL,17),
  ('level_s','🌟','S 級講師','level_tenure','講師等級 S','special',NULL,NULL,'gte','level_s',18),
  ('level_a','✨','A 級講師','level_tenure','講師等級 A+ / A','special',NULL,NULL,'gte','level_a',19),
  ('tenure_1','🗓️','一年有成','level_tenure','加入滿 1 年','threshold','tenure_years',1,'gte',NULL,20),
  ('tenure_3','🎂','三年老鳥','level_tenure','加入滿 3 年','threshold','tenure_years',3,'gte',NULL,21),
  ('tenure_5','🏔️','五年元老','level_tenure','加入滿 5 年','threshold','tenure_years',5,'gte',NULL,22),
  ('founder','🦖','創始元老','level_tenure','最早加入的一批講師','special',NULL,NULL,'gte','founder',23),
  ('region_3','🗺️','跨縣市教學','region_role','教過 3 個縣市','threshold','region_count',3,'gte',NULL,24),
  ('region_6','🚄','全台走透透','region_role','教過 6 個縣市','threshold','region_count',6,'gte',NULL,25),
  ('region_offshore','⛴️','離島特派員','region_role','教過離島縣市','special',NULL,NULL,'gte','region_offshore',26),
  ('lead_100','🎤','首席主講','region_role','主講 100 場','threshold','lead_count',100,'gte',NULL,27),
  ('assist_100','🌿','最佳綠葉','region_role','助教 100 場','threshold','assistant_count',100,'gte',NULL,28),
  ('streak_6','🔥','全勤連擊','region_role','連續 6 個月有接課','special',NULL,NULL,'gte','streak_6',29),
  ('gore_4day','🧟','爆肝場記','fun','同一天教超過 4 場','special',NULL,NULL,'gte','day_4sessions',30),
  ('marathon_6h','🏃','馬拉松教學','fun','單場超過 6 小時','special',NULL,NULL,'gte','marathon_6h',31),
  ('turtle','🐢','龜速也是速度','fun','有 WCA 成績但 3x3 慢於 60 秒（自嘲款）','special',NULL,NULL,'gte','wca_turtle',32),
  ('otaku','🤓','阿宅認證','fun','15 個以上項目有成績','threshold','wca_event_count',15,'gte',NULL,33),
  ('potato','🥔','馬鈴薯','fun','輸入通關密語解鎖（沿用課程哏）','manual',NULL,NULL,'gte',NULL,34),
  ('catpenguin','🐱','貓咪企鵝翻跟斗','fun','輸入通關密語解鎖（沿用課程哏）','manual',NULL,NULL,'gte',NULL,35),
  ('nightowl','🌙','夜貓講師','fun','半夜還在玩方塊競速','special',NULL,NULL,'gte','nightowl',36),
  ('ghost','🫥','查無此人','fun','資料齊全卻查無 WCA（純耍笨款，管理員頒發）','manual',NULL,NULL,'gte',NULL,37)
ON CONFLICT (key) DO NOTHING;

-- ── 驗證 ────────────────────────────────────────────────────────────
SELECT category, COUNT(*) AS 徽章數 FROM public.badge_definitions GROUP BY category ORDER BY category;
SELECT rule_type, COUNT(*) FROM public.badge_definitions GROUP BY rule_type;
-- 應共 38 個徽章。
