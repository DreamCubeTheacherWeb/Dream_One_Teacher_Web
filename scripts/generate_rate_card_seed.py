"""
從 PDF 報酬表整理成 salary_rate_card seed SQL
輸出: scripts/seed_rate_card.sql

course_type 命名規則(snake_case 英文,前端再 map 中文 label):
  regular_basic / regular_advanced       — 實體常態 初階 / 進階
  online                                  — 線上課程
  overseas_online                         — 國外一對一線上
  onsite_2hr / onsite_1_5hr               — 到府課程 2hr / 1.5hr 一節
  collab_lead / collab_assistant / collab_project — 合作課程 主講 / 助教 / 專案
  camp                                    — 冬夏令營 / 到府營隊
  speed_onsite / speed_online             — 速解到府 / 線上
  speed_training_lead / speed_training_assistant — 速解培訓班 主講 / 助教
  speed_camp                              — 速解 / 全英文營隊
  kids_lead / kids_assistant              — 幼兒啟蒙 主講 / 助教
  camp_director_5d / 4d / 2d              — 營隊負責人 五/四/二日
  cert_head_judge / cert_sub_judge        — 魔術方塊認證 主裁 / 助裁
  counter / event_booth                    — 櫃台 / 擺攤
  special_lecture_recorded / unrecorded   — 特殊講座 有紀錄 / 無紀錄
"""

from pathlib import Path

OUT = Path(__file__).resolve().parent / "seed_rate_card.sql"
EFFECTIVE_FROM = "2025-01-01"

rows = []

# ── 實體常態 初階(體驗課程)── 1.5 hr/節,時薪
basic = [
    # (students, S, A+, A, B, 實習)
    (8, 900, 875, 850, 825, None),
    (7, 800, 775, 750, 725, None),
    (6, 700, 675, 650, 625, None),
    (5, 600, 575, 550, 525, None),
    (4, 500, 475, 450, 425, 400),
    (3, 400, 375, 350, 325, 300),
    (2, 350, 325, 300, 275, 250),
    (1, 300, 275, 250, 225, 200),
]
for s, *prices in basic:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            rows.append(("regular_basic", role, 1.5, s, s, "hourly", rate, "實體常態-初階"))

# ── 實體常態 進階 ── 1.5 hr/節,時薪
adv = [
    (8, 1035, 875, 850, 825, None),
    (7, 920, 775, 750, 725, None),
    (6, 805, 675, 650, 625, None),
    (5, 690, 575, 550, 525, None),
    (4, 575, 475, 450, 425, 400),
    (3, 460, 375, 350, 325, 300),
    (2, 403, 325, 300, 275, 250),
    (1, 345, 275, 250, 225, 200),
]
for s, *prices in adv:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            rows.append(("regular_advanced", role, 1.5, s, s, "hourly", rate, "實體常態-進階"))

# ── 線上課程 ── 2 hr/節,時薪
online = [
    (4, 700, 675, 650, 625, None),
    (3, 600, 575, 550, 525, None),
    (2, 500, 475, 450, 425, None),
    (1, 400, 375, 350, 325, None),
]
for s, *prices in online:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            rows.append(("online", role, 2, s, s, "hourly", rate, "線上課程"))

# ── 國外一對一線上 ── 0.75 hr, 1 學生, 800 三等級同價
for role in ["S", "A+", "A"]:
    rows.append(("overseas_online", role, 0.75, 1, 1, "hourly", 800, "國外一對一線上"))

# ── 到府課程 2hr/節 ── 時薪
onsite2 = [
    (6, 800, 775, 750, None, None),
    (5, 750, 725, 700, None, None),
    (4, 700, 675, 650, 625, 600),
    (3, 650, 625, 600, 575, 550),
    (2, 600, 575, 550, 525, 500),
    (1, 550, 525, 500, 475, 450),
]
for s, *prices in onsite2:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            rows.append(("onsite_2hr", role, 2, s, s, "hourly", rate, "到府課程 2hr/節"))

# ── 到府課程 1.5hr/節 ── 場次費(一節)
onsite15 = [
    (2, 1050, 950, 850, 770, 720),
    (1, 1000, 900, 800, 720, 670),
]
for s, *prices in onsite15:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            rows.append(("onsite_1_5hr", role, 1.5, s, s, "per_session", rate, "到府課程 1.5hr/節(一節計)"))

# ── 合作課程 專案 ── negotiable, 5+ 學生
rows.append(("collab_project", None, None, 5, None, "negotiable", None, "合作專案-依負責人書面約定"))

# ── 合作課程 主講 ── 時薪, 5+ 學生
for role, rate in [("S", 800), ("A+", 700), ("A", 600), ("B", 500), ("實習", 450)]:
    rows.append(("collab_lead", role, None, 5, None, "hourly", rate, "合作課程 主講"))

# ── 合作課程 助教 ── 時薪, S/A+ 不得擔任
for role, rate in [("A", 400), ("B", 350), ("實習", 300)]:
    rows.append(("collab_assistant", role, None, None, None, "hourly", rate, "合作課程 助教"))

# ── 冬夏令營 / 到府營隊 ── 時薪, 一天 8 hr
camp = [
    (8, 420, 400, 380, 360, None),
    (7, 390, 370, 350, 330, None),
    (6, 360, 340, 320, 300, None),
    (5, 330, 310, 290, 270, 250),
    (4, 300, 280, 260, 240, 220),
    (3, 270, 250, 230, 210, 200),
]
for s, *prices in camp:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            rows.append(("camp", role, 8, s, s, "hourly", rate, "冬夏令營 / 到府營隊"))

# ── 速解到府課程 ── 1.5 hr,速解大師 / 基礎速解講師
speed_onsite = [
    (5, 1350, 1250),
    (4, 1200, 1100),
    (3, 1050, 950),
    (2, 900, 800),
    (1, 750, 650),
]
for s, master, basic_r in speed_onsite:
    rows.append(("speed_onsite", "速解大師", 1.5, s, s, "hourly", master, "速解到府"))
    rows.append(("speed_onsite", "基礎速解講師", 1.5, s, s, "hourly", basic_r, "速解到府"))

# ── 速解線上課程 ── 1.5 hr
speed_online = [
    (3, 750, 650),
    (2, 650, 550),
    (1, 550, 450),
]
for s, master, basic_r in speed_online:
    rows.append(("speed_online", "速解大師", 1.5, s, s, "hourly", master, "速解線上"))
    rows.append(("speed_online", "基礎速解講師", 1.5, s, s, "hourly", basic_r, "速解線上"))

# ── 速解培訓班 ── 2 hr, 主講 / 助教按帶課組數計
speed_training = [
    # (role_label, student_min, student_max, rate, note)
    (None, 6, None, 800, "主講 6+ 組"),
    (None, 4, 5, 750, "主講 4-5 組"),
    (None, 1, 3, 700, "主講 1-3 組"),
]
for r, s_min, s_max, rate, note in speed_training:
    rows.append(("speed_training_lead", None, 2, s_min, s_max, "hourly", rate, note))
for r, s_min, s_max, rate, note in [(None, 3, 4, 550, "助教 3-4 組"), (None, 1, 2, 500, "助教 1-2 組")]:
    rows.append(("speed_training_assistant", None, 2, s_min, s_max, "hourly", rate, note))

# ── 速解營隊 / 全英文營隊 ── 8 hr/天
speed_camp = [
    (8, 650, 600),
    (7, 600, 550),
    (6, 550, 500),
    (5, 500, 450),
    (4, 450, 400),
    (3, 400, 350),
]
for s, master, basic_r in speed_camp:
    rows.append(("speed_camp", "速解大師", 8, s, s, "hourly", master, "速解 / 全英文營隊"))
    rows.append(("speed_camp", "基礎速解講師", 8, s, s, "hourly", basic_r, "速解 / 全英文營隊"))

# ── 幼兒啟蒙課程 ── 1~1.5 hr, 5+ 學生
rows.append(("kids_lead", None, None, 5, None, "hourly", 960, "幼兒啟蒙 主講"))
rows.append(("kids_assistant", None, None, None, None, "hourly", 420, "幼兒啟蒙 助教"))

# ── 營隊負責人薪資 ── 固定金額
rows.append(("camp_director_5d", None, None, None, None, "fixed", 1500, "營隊負責人 五日"))
rows.append(("camp_director_4d", None, None, None, None, "fixed", 1200, "營隊負責人 四日"))
rows.append(("camp_director_2d", None, None, None, None, "fixed", 500, "營隊負責人 二日"))

# ── 其他(依時數計)──
rows.append(("cert_sub_judge", None, None, None, None, "hourly", 230, "魔術方塊認證 助理裁判"))
rows.append(("counter", None, None, None, None, "hourly", 200, "實體教室櫃員"))
rows.append(("event_booth", None, None, None, None, "hourly", 200, "擺攤活動"))
rows.append(("special_lecture_recorded", None, None, None, None, "hourly", 1000, "特殊講座 有紀錄"))
rows.append(("special_lecture_unrecorded", None, None, None, None, "hourly", 500, "特殊講座 無紀錄"))


# ── 產生 SQL ──
def sql_val(v):
    if v is None:
        return "NULL"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return str(v)


lines = [
    "-- ═══════════════════════════════════════════════════════════════",
    "-- salary_rate_card seed (2025 年報酬表)",
    f"-- {len(rows)} 筆規則",
    "-- ═══════════════════════════════════════════════════════════════",
    "",
    "INSERT INTO public.salary_rate_card",
    "  (course_type, instructor_role, duration_hours, student_count_min, student_count_max, pricing_mode, rate, effective_from, note)",
    "VALUES",
]

value_lines = []
for ct, role, dur, smin, smax, mode, rate, note in rows:
    value_lines.append(
        f"  ({sql_val(ct)}, {sql_val(role)}, {sql_val(dur)}, "
        f"{sql_val(smin)}, {sql_val(smax)}, {sql_val(mode)}, "
        f"{sql_val(rate)}, '{EFFECTIVE_FROM}', {sql_val(note)})"
    )

lines.append(",\n".join(value_lines) + ";")

OUT.write_text("\n".join(lines), encoding="utf-8")
print(f"✅ 共 {len(rows)} 筆規則,已輸出 {OUT.name}")

# 統計
from collections import Counter
ct_count = Counter(r[0] for r in rows)
print("\n各課程類型筆數:")
for k, v in sorted(ct_count.items(), key=lambda x: -x[1]):
    print(f"  {k}: {v}")
