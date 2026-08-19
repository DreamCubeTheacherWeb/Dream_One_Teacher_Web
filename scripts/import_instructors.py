"""
匯入 instructors_merged_preview.json → Supabase instructors 表(upsert 模式)

策略:
  1. 先讀取現有 instructors 全部資料,建 email_primary → id 對應表
  2. 對每筆 CSV 資料:
     - 若 email 對到現有列 → UPDATE 該列(保留 id、user_id、created_at),用 CSV 資料覆蓋其他欄位
     - 若沒對到 → INSERT 新列
  3. 完全不會 DELETE 任何現有資料

使用方式:
  # 1. dry run(只印不寫,顯示會配對到哪些現有列)
  SUPABASE_URL=https://xxx.supabase.co \\
  SUPABASE_SERVICE_ROLE_KEY=eyJ... \\
  python3 scripts/import_instructors.py

  # 2. 真的寫入
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \\
  python3 scripts/import_instructors.py --commit

⚠️ 跑完請輪換 service_role key
"""

import json
import os
import re
import ssl
import sys
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import quote
from urllib.error import HTTPError

# 使用系統 CA 驗證 Supabase 憑證與 hostname；若本機缺 CA，請設定 SSL_CERT_FILE，
# 不得為了讓匯入成功而關閉驗證，否則 service-role key 會暴露給中間人。
SSL_CTX = ssl.create_default_context()

BASE = Path(__file__).resolve().parent.parent
IN_JSON = BASE / "scripts" / "instructors_merged_preview.json"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
COMMIT = "--commit" in sys.argv

if not SUPABASE_URL or not SERVICE_KEY:
    print("❌ 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 環境變數")
    sys.exit(1)


# ──── 縣市 enum 正規化 ────────────────────────────────────────
TW_COUNTIES = {
    "臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市",
    "基隆市", "新竹市", "嘉義市",
    "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣",
    "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣",
    "澎湖縣", "金門縣", "連江縣",
}
REGION_ALIAS = {
    "雙北": ["臺北市", "新北市"],
    "臺北": ["臺北市"], "台北": ["臺北市"], "台北市": ["臺北市"],
    "新北": ["新北市"],
    "桃園": ["桃園市"],
    "臺中": ["臺中市"], "台中": ["臺中市"], "台中市": ["臺中市"],
    "臺南": ["臺南市"], "台南": ["臺南市"],
    "高雄": ["高雄市"],
    "基隆": ["基隆市"],
    "新竹": ["新竹市"],
    "嘉義": ["嘉義市"],
    "苗栗": ["苗栗縣"], "彰化": ["彰化縣"], "南投": ["南投縣"],
    "雲林": ["雲林縣"], "屏東": ["屏東縣"], "宜蘭": ["宜蘭縣"],
    "花蓮": ["花蓮縣"], "臺東": ["臺東縣"], "台東": ["臺東縣"],
    "澎湖": ["澎湖縣"], "金門": ["金門縣"], "連江": ["連江縣"],
    "員林市": ["彰化縣"], "竹北市": ["新竹縣"],
}


def parse_regions(raw):
    if not raw:
        return None
    parts = re.split(r"[,，、\s]+", str(raw).strip())
    result, seen = [], set()
    for p in parts:
        p = p.strip()
        if not p:
            continue
        norm = p.replace("台", "臺")
        candidates = []
        if norm in TW_COUNTIES:
            candidates = [norm]
        elif norm in REGION_ALIAS:
            candidates = REGION_ALIAS[norm]
        elif p in REGION_ALIAS:
            candidates = REGION_ALIAS[p]
        for r in candidates:
            if r not in seen:
                result.append(r); seen.add(r)
    return result or None


def parse_date(s):
    if not s:
        return None
    s = str(s).strip()
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_timestamp(s):
    if not s:
        return None
    s = str(s).strip()
    is_pm = "下午" in s
    s = re.sub(r"\s+", " ", s.replace("上午", "").replace("下午", "").strip())
    try:
        dt = datetime.strptime(s, "%Y/%m/%d %H:%M:%S")
        if is_pm and dt.hour < 12:
            dt = dt.replace(hour=dt.hour + 12)
        elif not is_pm and dt.hour == 12:
            dt = dt.replace(hour=0)
        return dt.isoformat() + "+08:00"
    except ValueError:
        return None


# ──── HTTP helper ────────────────────────────────────────────
def http(method, path, body=None, prefer=None):
    url = f"{SUPABASE_URL}/rest/v1{path}"
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body else None
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=30, context=SSL_CTX) as resp:
        text = resp.read().decode("utf-8")
        return resp.status, (json.loads(text) if text else None)


# ──── 1. 讀取現有 instructors ─────────────────────────────────
print("🔍 讀取現有 instructors...")
try:
    status, existing = http(
        "GET",
        "/instructors?select=id,user_id,full_name,email_primary",
        prefer="count=exact",
    )
except HTTPError as e:
    print(f"❌ 無法讀取 instructors: {e.code} — {e.read().decode('utf-8', errors='replace')}")
    sys.exit(1)

existing = existing or []
print(f"   現有 {len(existing)} 筆")
for r in existing:
    print(f"   - {r['full_name']!r} | email={r.get('email_primary')!r} | user_id={r.get('user_id')}")

# 手動 alias:DB 暱稱 → 真實姓名(CSV 用真實姓名)
NAME_ALIAS = {
    "Agent Fong": "王丰",
}

# 建索引:email → existing,以及 full_name(套 alias 後)→ existing
email_index = {}
name_index = {}
for r in existing:
    e = (r.get("email_primary") or "").strip().lower()
    if e:
        email_index[e] = r
    raw_name = (r.get("full_name") or "").strip()
    canonical_name = NAME_ALIAS.get(raw_name, raw_name)
    if canonical_name:
        name_index[canonical_name] = r


# ──── 2. 載入合併資料並轉欄位 ─────────────────────────────────
with open(IN_JSON, encoding="utf-8") as f:
    merged = json.load(f)
print(f"\n📥 載入 {len(merged)} 筆合併資料")


def to_row(r):
    regions = parse_regions(r.get("teaching_regions_raw"))
    row = {
        "full_name": r["full_name"],
        "employment_status": r.get("employment_status"),
        "instructor_role": r.get("instructor_role"),
        "birth_date": parse_date(r.get("birth_date")),
        "id_number": r.get("id_number"),
        "phone_mobile": r.get("phone_mobile"),
        "phone_home": r.get("phone_home"),
        "email_primary": r.get("email_primary"),
        "email_secondary": r.get("email_secondary"),
        "address": r.get("address_registered"),
        "line_id": r.get("line_id"),
        "line_name": r.get("line_name"),
        "facebook_url": r.get("facebook_url"),
        "school_info": r.get("school_info"),
        "bio_personal_experience": r.get("bio_personal_experience"),
        "bio_teaching_experience": r.get("bio_teaching_experience"),
        "teaching_philosophy": r.get("teaching_philosophy"),
        "teaching_freq_semester": r.get("teaching_freq_semester"),
        "teaching_freq_vacation": r.get("teaching_freq_vacation"),
        "teaching_regions": regions,
        "teaching_regions_raw": r.get("teaching_regions_raw"),
        "shirt_size": r.get("shirt_size"),
        "bank_info_raw": r.get("bank_info_raw"),
        "convenience_store_code": r.get("convenience_store_code"),
        "convenience_store_family": r.get("convenience_store_family"),
        "convenience_store_711": r.get("convenience_store_711"),
        "note_to_team": r.get("note_to_team"),
        "note_internal": r.get("note_internal"),
        "form_submitted_at": parse_timestamp(r.get("form_submitted_at")),
        "id_front_external_url": r.get("id_front_external_url"),
        "id_back_external_url": r.get("id_back_external_url"),
        "photo_external_url": r.get("photo_external_url"),
        "bankbook_external_url": r.get("bankbook_external_url"),
        "bio_notes": (
            f"[通訊地址] {r['address_mailing']}"
            if r.get("address_mailing") and r.get("address_mailing") != r.get("address_registered")
            else None
        ),
    }
    return {k: v for k, v in row.items() if v is not None}


# ──── 3. 配對 + 分類 ─────────────────────────────────────────
to_update = []  # (existing_id, row_data)
to_insert = []
match_log = []

for r in merged:
    row = to_row(r)
    email = (row.get("email_primary") or "").strip().lower()
    name = (row.get("full_name") or "").strip()
    ex = None
    matched_by = None

    if email and email in email_index:
        ex = email_index[email]
        matched_by = f"email={email}"
    elif name and name in name_index:
        ex = name_index[name]
        matched_by = f"name={name}"

    if ex is not None:
        for skip in ("user_id", "id", "created_at"):
            row.pop(skip, None)
        to_update.append((ex["id"], row))
        match_log.append(
            f"  🔗 UPDATE: CSV「{r['full_name']}」 → DB「{ex['full_name']}」({matched_by})"
        )
    else:
        to_insert.append(row)

print(f"\n=== 配對結果 ===")
print(f"  將 UPDATE(email 對到現有列): {len(to_update)} 筆")
print(f"  將 INSERT(新資料): {len(to_insert)} 筆")
if match_log:
    print("\n配對明細:")
    for m in match_log:
        print(m)


# ──── 4. Dry run 或實際寫入 ────────────────────────────────────
if not COMMIT:
    print("\n🔍 DRY RUN(沒加 --commit,只印不寫)")
    print("\n前 2 筆 INSERT 預覽:")
    for r in to_insert[:2]:
        print(json.dumps(r, ensure_ascii=False, indent=2))
        print("---")
    print(f"\n要實際寫入請加 --commit")
    sys.exit(0)


# 寫入
print("\n📤 開始寫入 Supabase...")

# UPDATE 用 PATCH /instructors?id=eq.<id>
update_ok = update_fail = 0
for ex_id, row in to_update:
    try:
        status, _ = http(
            "PATCH",
            f"/instructors?id=eq.{ex_id}",
            body=row,
            prefer="return=minimal",
        )
        if status in (200, 204):
            update_ok += 1
        else:
            update_fail += 1
            print(f"  ✗ UPDATE {row.get('full_name')} 失敗: HTTP {status}")
    except HTTPError as e:
        update_fail += 1
        body_text = e.read().decode("utf-8", errors="replace")[:300]
        print(f"  ✗ UPDATE {row.get('full_name')} 失敗: HTTP {e.code} — {body_text}")

print(f"  UPDATE 完成: 成功 {update_ok} / 失敗 {update_fail}")

# INSERT 批次
# PostgREST 要求批次內所有物件 key 一致,先 union 所有 keys 並補齊
all_keys = set()
for r in to_insert:
    all_keys.update(r.keys())
to_insert = [{k: r.get(k) for k in all_keys} for r in to_insert]

insert_ok = insert_fail = 0
errors = []
BATCH = 50
for i in range(0, len(to_insert), BATCH):
    batch = to_insert[i:i+BATCH]
    try:
        status, _ = http("POST", "/instructors", body=batch, prefer="return=minimal")
        if status in (200, 201, 204):
            insert_ok += len(batch)
            print(f"  ✓ INSERT 批次 {i//BATCH + 1}: {len(batch)} 筆")
        else:
            insert_fail += len(batch)
            errors.append(f"批次 {i//BATCH + 1}: HTTP {status}")
    except HTTPError as e:
        insert_fail += len(batch)
        body_text = e.read().decode("utf-8", errors="replace")[:500]
        errors.append(f"批次 {i//BATCH + 1}: HTTP {e.code} — {body_text}")
        print(f"  ✗ INSERT 批次 {i//BATCH + 1} 失敗: {e.code} — {body_text[:200]}")

print(f"\n=== 最終結果 ===")
print(f"  UPDATE: {update_ok} 成功 / {update_fail} 失敗")
print(f"  INSERT: {insert_ok} 成功 / {insert_fail} 失敗")
if errors:
    print(f"\n錯誤明細:")
    for e in errors[:10]:
        print(f"  - {e}")
