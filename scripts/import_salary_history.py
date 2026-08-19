"""
匯入「所有薪資登記.csv」歷史紀錄 → class_sessions

策略:
- 9551 筆全部視為歷史(source='historical_import', status 看 paid_amount)
- 不查 rate_card(歷史薪資已是定額),直接照 CSV 寫
- instructor_name → 對應 instructors.full_name → 帶 instructor_id(找不到就只留 name)
- 異常自動由 trigger 偵測
"""

import csv
import json
import os
import re
import ssl
import sys
from datetime import datetime, date
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

BASE = Path(__file__).resolve().parent.parent
CSV_PATH = BASE / "講師 資料總表 23年啟用永久版 - 所有薪資登記.csv"

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
COMMIT = "--commit" in sys.argv

SSL_CTX = ssl.create_default_context()


# 課程種類 → course_type + role
COURSE_MAP = {
    "合作課程 主講":        ("collab_lead", "lead"),
    "常態課程":             ("regular_basic", "lead"),
    "到府課程":             ("onsite_2hr", "lead"),
    "其他":                 ("other", "other"),
    "營隊課程":             ("camp", "lead"),
    "速解研究所":           ("speed_training_lead", "lead"),
    "櫃台人員":             ("counter", "counter"),
    "合作課程 助教":        ("collab_assistant", "assistant"),
    "線上課程":             ("online", "lead"),
    "到府家教課 or 到府揪團課": ("onsite_2hr", "lead"),
    "擺攤":                 ("event_booth", "other"),
    "營隊課程負責人":       ("camp_director_5d", "project_lead"),
    "速解研究所 實體":      ("speed_onsite", "lead"),
    "速解研究所｜實體課程": ("speed_onsite", "lead"),
    "速解研究所 到府":      ("speed_onsite", "lead"),
    "速解研究所 線上":      ("speed_online", "lead"),
    "速解研究所｜線上課程": ("speed_online", "lead"),
    "楓葉體驗課":           ("other", "lead"),
    "學校社團":             ("other", "lead"),
    "徵稿":                 ("other", "other"),
}

# 等級 normalize
def norm_role(s):
    if not s: return None
    s = s.strip()
    mapping = {
        "S":"S","A+":"A+","A":"A","B":"B",
        "實習講師":"實習","實習":"實習",
        "C":"實習","D":"實習",  # 舊等級併入實習
        "無":None,"職員":None,"與等級無關":None,
    }
    return mapping.get(s)


def num(s):
    if not s: return None
    s = str(s).strip().replace(",","")
    if not s or s == "-": return None
    try: return float(s)
    except: return None


def parse_date(s, fallback_month=None):
    if not s:
        # 用月份的第一天當 fallback
        if fallback_month:
            m = re.match(r"(\d{4})/(\d{1,2})", fallback_month)
            if m: return f"{m.group(1)}-{int(m.group(2)):02d}-01"
        return None
    s = str(s).strip()
    for fmt in ("%Y/%m/%d","%Y-%m-%d","%Y.%m.%d"):
        try: return datetime.strptime(s,fmt).date().isoformat()
        except: continue
    # 試試 YYYY/M(只有年月)
    m = re.match(r"(\d{4})/(\d{1,2})$", s)
    if m: return f"{m.group(1)}-{int(m.group(2)):02d}-01"
    return None


# ── 抓現有 instructors → name 對應 id
def http(method, path, body=None, prefer=None):
    url = f"{SUPABASE_URL}/rest/v1{path}"
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer: headers["Prefer"] = prefer
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body else None
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=60, context=SSL_CTX) as resp:
        text = resp.read().decode("utf-8")
        return resp.status, (json.loads(text) if text else None)


print("🔍 讀取 instructors 名單...")
_, instructors = http("GET", "/instructors?select=id,full_name&limit=1000", prefer="count=none")
name_to_id = {i["full_name"].strip(): i["id"] for i in (instructors or []) if i.get("full_name")}
print(f"   {len(name_to_id)} 位講師")

# ── 讀 CSV 轉欄位
with open(CSV_PATH, encoding="utf-8") as f:
    rows = list(csv.DictReader(f))
print(f"\n📥 讀入 {len(rows)} 筆薪資紀錄")

sessions = []
unmapped_course = set()
unmatched_names = set()

for r in rows:
    name = (r.get("講師名稱") or "").strip()
    if not name:
        continue

    course_kind = (r.get("課程種類") or "").strip()
    if course_kind in COURSE_MAP:
        course_type, role_in_session = COURSE_MAP[course_kind]
    else:
        course_type, role_in_session = "other", "other"
        if course_kind: unmapped_course.add(course_kind)

    base_sal = num(r.get("薪資")) or 0
    bonus    = num(r.get("獎金")) or 0
    paid     = num(r.get("已領金額")) or 0

    # status
    if paid > 0:
        status = "paid"
    else:
        status = "approved"  # 管理員登記的歷史 = 已核准

    instructor_id = name_to_id.get(name)
    if not instructor_id:
        unmatched_names.add(name)

    session_date = parse_date(r.get("日期"), fallback_month=r.get("月份"))
    if not session_date:
        continue  # 沒日期沒月份的跳過

    sessions.append({
        "course_type": course_type,
        "course_name": (r.get("課程名稱") or "").strip() or None,
        "location": None,
        "instructor_id": instructor_id,
        "instructor_name": name,
        "role_in_session": role_in_session,
        "instructor_role_at_time": norm_role(r.get("級別")),
        "session_date": session_date,
        "duration_hours": num(r.get("時數")),
        "student_count": int(num(r.get("人數"))) if num(r.get("人數")) else None,
        "base_salary": base_sal,
        "bonus": bonus,
        "paid_amount": paid,
        "status": status,
        "registered_by_name": (r.get("登記人") or "").strip() or None,
        "self_review": (r.get("課程自評") or "").strip() or None,
        "progress_note": (r.get("學習進度（常態課必填）") or "").strip() or None,
        "incident_report": (r.get("特殊狀況回報") or "").strip() or None,
        "notes": (r.get("備註") or "").strip() or None,
        "source": "historical_import",
    })

print(f"✅ 轉換完成: {len(sessions)} 筆")
if unmapped_course:
    print(f"⚠️ 未對應的課程種類: {unmapped_course}")
if unmatched_names:
    print(f"⚠️ {len(unmatched_names)} 位姓名未對應到 instructor_id (前 5: {list(unmatched_names)[:5]})")

if not COMMIT:
    print("\n🔍 DRY RUN(沒加 --commit)")
    print("\n前 2 筆預覽:")
    for s in sessions[:2]:
        print(json.dumps(s, ensure_ascii=False, indent=2))
    sys.exit(0)

# ── 統一 keys + 批次寫入
all_keys = set()
for s in sessions:
    all_keys.update(s.keys())
sessions = [{k: r.get(k) for k in all_keys} for r in sessions]

print(f"\n📤 開始寫入 (共 {len(sessions)} 筆)")
ok = fail = 0
BATCH = 200
endpoint = f"{SUPABASE_URL}/rest/v1/class_sessions"
hdr = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

for i in range(0, len(sessions), BATCH):
    batch = sessions[i:i+BATCH]
    req = Request(endpoint, data=json.dumps(batch, ensure_ascii=False).encode("utf-8"),
                  headers=hdr, method="POST")
    try:
        with urlopen(req, timeout=120, context=SSL_CTX) as resp:
            if resp.status in (200,201,204):
                ok += len(batch)
                if (i//BATCH) % 5 == 0:
                    print(f"  ✓ 批次 {i//BATCH+1}: 累計 {ok}")
            else:
                fail += len(batch)
    except HTTPError as e:
        fail += len(batch)
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"  ✗ 批次 {i//BATCH+1}: HTTP {e.code} — {body}")
        if fail > 1000: # 太多錯,停止
            print("失敗太多,中止")
            break

print(f"\n結果: 成功 {ok} / 失敗 {fail}")
