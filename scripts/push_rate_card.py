"""直接把報酬表(206 筆)POST 進 Supabase salary_rate_card"""
import json
import os
import ssl
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

EFFECTIVE_FROM = "2025-01-01"
rows = []


def add(course_type, role, dur, smin, smax, mode, rate, note):
    rows.append({
        "course_type": course_type,
        "instructor_role": role,
        "duration_hours": dur,
        "student_count_min": smin,
        "student_count_max": smax,
        "pricing_mode": mode,
        "rate": rate,
        "effective_from": EFFECTIVE_FROM,
        "note": note,
    })


# 實體常態 初階
for s, *prices in [
    (8, 900, 875, 850, 825, None), (7, 800, 775, 750, 725, None),
    (6, 700, 675, 650, 625, None), (5, 600, 575, 550, 525, None),
    (4, 500, 475, 450, 425, 400), (3, 400, 375, 350, 325, 300),
    (2, 350, 325, 300, 275, 250), (1, 300, 275, 250, 225, 200),
]:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            add("regular_basic", role, 1.5, s, s, "hourly", rate, "實體常態-初階")

# 實體常態 進階
for s, *prices in [
    (8, 1035, 875, 850, 825, None), (7, 920, 775, 750, 725, None),
    (6, 805, 675, 650, 625, None), (5, 690, 575, 550, 525, None),
    (4, 575, 475, 450, 425, 400), (3, 460, 375, 350, 325, 300),
    (2, 403, 325, 300, 275, 250), (1, 345, 275, 250, 225, 200),
]:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            add("regular_advanced", role, 1.5, s, s, "hourly", rate, "實體常態-進階")

# 線上
for s, *prices in [(4, 700, 675, 650, 625, None), (3, 600, 575, 550, 525, None),
                   (2, 500, 475, 450, 425, None), (1, 400, 375, 350, 325, None)]:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            add("online", role, 2, s, s, "hourly", rate, "線上課程")

# 國外 1對1
for role in ["S", "A+", "A"]:
    add("overseas_online", role, 0.75, 1, 1, "hourly", 800, "國外一對一線上")

# 到府 2hr
for s, *prices in [
    (6, 800, 775, 750, None, None), (5, 750, 725, 700, None, None),
    (4, 700, 675, 650, 625, 600), (3, 650, 625, 600, 575, 550),
    (2, 600, 575, 550, 525, 500), (1, 550, 525, 500, 475, 450),
]:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            add("onsite_2hr", role, 2, s, s, "hourly", rate, "到府課程 2hr/節")

# 到府 1.5hr(per_session)
for s, *prices in [(2, 1050, 950, 850, 770, 720), (1, 1000, 900, 800, 720, 670)]:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            add("onsite_1_5hr", role, 1.5, s, s, "per_session", rate, "到府 1.5hr/節(一節計)")

# 合作專案
add("collab_project", None, None, 5, None, "negotiable", None, "合作專案-依負責人書面約定")

# 合作主講
for role, rate in [("S", 800), ("A+", 700), ("A", 600), ("B", 500), ("實習", 450)]:
    add("collab_lead", role, None, 5, None, "hourly", rate, "合作課程 主講")

# 合作助教(S/A+ 不得)
for role, rate in [("A", 400), ("B", 350), ("實習", 300)]:
    add("collab_assistant", role, None, None, None, "hourly", rate, "合作課程 助教")

# 冬夏令營
for s, *prices in [
    (8, 420, 400, 380, 360, None), (7, 390, 370, 350, 330, None),
    (6, 360, 340, 320, 300, None), (5, 330, 310, 290, 270, 250),
    (4, 300, 280, 260, 240, 220), (3, 270, 250, 230, 210, 200),
]:
    for role, rate in zip(["S", "A+", "A", "B", "實習"], prices):
        if rate is not None:
            add("camp", role, 8, s, s, "hourly", rate, "冬夏令營 / 到府營隊")

# 速解到府
for s, m, b in [(5, 1350, 1250), (4, 1200, 1100), (3, 1050, 950), (2, 900, 800), (1, 750, 650)]:
    add("speed_onsite", "速解大師", 1.5, s, s, "hourly", m, "速解到府")
    add("speed_onsite", "基礎速解講師", 1.5, s, s, "hourly", b, "速解到府")

# 速解線上
for s, m, b in [(3, 750, 650), (2, 650, 550), (1, 550, 450)]:
    add("speed_online", "速解大師", 1.5, s, s, "hourly", m, "速解線上")
    add("speed_online", "基礎速解講師", 1.5, s, s, "hourly", b, "速解線上")

# 速解培訓
add("speed_training_lead", None, 2, 6, None, "hourly", 800, "主講 6+ 組")
add("speed_training_lead", None, 2, 4, 5, "hourly", 750, "主講 4-5 組")
add("speed_training_lead", None, 2, 1, 3, "hourly", 700, "主講 1-3 組")
add("speed_training_assistant", None, 2, 3, 4, "hourly", 550, "助教 3-4 組")
add("speed_training_assistant", None, 2, 1, 2, "hourly", 500, "助教 1-2 組")

# 速解營隊
for s, m, b in [(8, 650, 600), (7, 600, 550), (6, 550, 500),
                (5, 500, 450), (4, 450, 400), (3, 400, 350)]:
    add("speed_camp", "速解大師", 8, s, s, "hourly", m, "速解 / 全英文營隊")
    add("speed_camp", "基礎速解講師", 8, s, s, "hourly", b, "速解 / 全英文營隊")

# 幼兒
add("kids_lead", None, None, 5, None, "hourly", 960, "幼兒啟蒙 主講")
add("kids_assistant", None, None, None, None, "hourly", 420, "幼兒啟蒙 助教")

# 營隊負責人
add("camp_director_5d", None, None, None, None, "fixed", 1500, "營隊負責人 五日")
add("camp_director_4d", None, None, None, None, "fixed", 1200, "營隊負責人 四日")
add("camp_director_2d", None, None, None, None, "fixed", 500, "營隊負責人 二日")

# 其他
add("cert_sub_judge", None, None, None, None, "hourly", 230, "魔術方塊認證 助理裁判")
add("counter", None, None, None, None, "hourly", 200, "實體教室櫃員")
add("event_booth", None, None, None, None, "hourly", 200, "擺攤活動")
add("special_lecture_recorded", None, None, None, None, "hourly", 1000, "特殊講座 有紀錄")
add("special_lecture_unrecorded", None, None, None, None, "hourly", 500, "特殊講座 無紀錄")


print(f"準備寫入 {len(rows)} 筆")

# 統一所有 keys(PostgREST 批次 INSERT 要求 key 一致)
all_keys = set()
for r in rows:
    all_keys.update(r.keys())
rows = [{k: r.get(k) for k in all_keys} for r in rows]

endpoint = f"{SUPABASE_URL}/rest/v1/salary_rate_card"
headers = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

BATCH = 100
ok = fail = 0
for i in range(0, len(rows), BATCH):
    batch = rows[i:i+BATCH]
    req = Request(endpoint, data=json.dumps(batch, ensure_ascii=False).encode("utf-8"),
                  headers=headers, method="POST")
    try:
        with urlopen(req, timeout=30, context=SSL_CTX) as resp:
            if resp.status in (200, 201, 204):
                ok += len(batch)
                print(f"  ✓ 批次 {i//BATCH+1}: {len(batch)} 筆")
            else:
                fail += len(batch)
                print(f"  ✗ 批次 {i//BATCH+1}: HTTP {resp.status}")
    except HTTPError as e:
        fail += len(batch)
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"  ✗ 批次 {i//BATCH+1}: HTTP {e.code} — {body}")

print(f"\n結果: 成功 {ok} / 失敗 {fail}")
