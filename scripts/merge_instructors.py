"""
合併「老師資料表」+「表單回應」→ 產出乾淨的講師主檔預覽 JSON

規則:
- 以「姓名」為 key
- 表單回應有同名 → 欄位級覆蓋(表單有值用表單,空 fallback 老師資料表)
- 表單回應姓名怪怪的(非合理人名)→ 跳過該筆表單回應
- 老師資料表所有人都匯入(沒 email 的工讀生也保留)
- 文件保留 Google Drive 連結

輸出: scripts/instructors_merged_preview.json
"""

import csv
import json
import re
from pathlib import Path
from collections import OrderedDict

BASE = Path(__file__).resolve().parent.parent
TEACHER_CSV = BASE / "講師 資料總表 23年啟用永久版 - 老師資料表.csv"
FORM_CSV = BASE / "講師 資料總表 23年啟用永久版 - 表單回應 1.csv"
OUT_JSON = BASE / "scripts" / "instructors_merged_preview.json"
OUT_REPORT = BASE / "scripts" / "merge_report.txt"


def clean(v):
    """空字串、'-'、'無'、'沒有'、'尚未填寫'、'#N/A' 等視為缺值"""
    if v is None:
        return None
    s = str(v).strip()
    if s in ("", "-", "無", "沒有", "尚未填寫", "#N/A", "早就寫了",
             "沿用", "沿用去年", "沿用去年答案", "同上"):
        return None
    return s


def is_valid_name(name):
    """姓名合理性檢查:純中文 2~5 字,不含數字/空白/特殊符號"""
    if not name:
        return False
    s = name.strip()
    if not (2 <= len(s) <= 5):
        return False
    return bool(re.fullmatch(r"[一-鿿·]+", s))


# 「管理層級」→ employment_status 對應
EMPLOYMENT_MAP = {
    "老師": "active",
    "職員": "staff",
    "助教": "assistant",
    "冷凍": "frozen",
    "取消合作": "cancelled",
    "工讀生": "part_time",
}

# 「老師等級」→ instructor_role 對應(原 enum 只有 S/A+/A/B/實習)
# C 級是早期分類,實質等同實習
def normalize_role(raw):
    if not raw:
        return None
    s = str(raw).strip()
    # 嚴格匹配的優先
    if s in ("S", "A+", "A", "B"):
        return s
    # 模糊匹配:含「實習」「C級」「C 級」「C級講師」皆視為實習
    if "實習" in s or "C級" in s or "C 級" in s:
        return "實習"
    # 其他(職員 / 無 / 垃圾字串)→ NULL
    return None


# ── 1. 載入老師資料表 ─────────────────────────────────────────
teacher_rows = {}
with open(TEACHER_CSV, encoding="utf-8") as f:
    for r in csv.DictReader(f):
        name = clean(r.get("姓名"))
        if not name:
            continue  # 跳過完全沒姓名的列
        teacher_rows[name] = r

print(f"📋 老師資料表載入: {len(teacher_rows)} 筆")


# ── 2. 載入表單回應,過濾髒資料 ─────────────────────────────────
form_rows = {}
form_dirty = []
with open(FORM_CSV, encoding="utf-8") as f:
    for r in csv.DictReader(f):
        raw_name = clean(r.get("姓名"))
        if not raw_name:
            continue
        if not is_valid_name(raw_name):
            form_dirty.append(raw_name)
            continue
        # 若同名出現多次,留最後一筆(通常是最新)
        form_rows[raw_name] = r

print(f"📝 表單回應載入: {len(form_rows)} 筆(已過濾 {len(form_dirty)} 筆髒資料)")


# ── 3. 合併:以老師資料表為基底,有表單回應就欄位級覆蓋 ─────────
def pick(form_val, teacher_val):
    """欄位級 fallback:表單有值用表單,否則用老師資料表"""
    fv = clean(form_val)
    if fv is not None:
        return fv
    return clean(teacher_val)


merged = []
overlap_names = set(form_rows.keys()) & set(teacher_rows.keys())
form_only = set(form_rows.keys()) - set(teacher_rows.keys())

# 處理老師資料表中所有人
for name, t in teacher_rows.items():
    f = form_rows.get(name, {})

    # employment_status 從老師資料表的「管理層級」推斷
    management = clean(t.get("管理層級"))
    employment_status = EMPLOYMENT_MAP.get(management) if management else None

    # instructor_role(等級)
    role_raw = clean(t.get("老師等級"))
    instructor_role = normalize_role(role_raw)

    record = OrderedDict([
        ("full_name", name),
        ("employment_status", employment_status),
        ("employment_status_raw", management),  # 保留原始字串以便檢查
        ("instructor_role", instructor_role),
        ("instructor_role_raw", role_raw),

        # 基本資料
        ("gender", pick(f.get("性別"), None)),  # 老師資料表沒這欄,只有表單可能有
        ("birth_date", pick(f.get("出生年月日"), t.get("出生年月日"))),
        ("id_number", pick(f.get("身份證字號"), t.get("身份證字號"))),

        # 聯絡方式
        ("phone_mobile", pick(f.get("手機號碼"), t.get("手機號碼"))),
        ("phone_home", pick(f.get("家電號碼"), t.get("家電號碼"))),
        ("email_primary", pick(f.get("電子郵件"), t.get("信箱"))),
        ("email_secondary", pick(f.get("電子郵件地址"), None)),
        ("address_registered", pick(f.get("戶籍地址"), t.get("戶籍地址"))),
        ("address_mailing", pick(f.get("通訊地址"), t.get("通訊地址"))),
        ("school_info", pick(f.get("目前就讀學校、科系、年級"), t.get("目前就讀學校、科系、年級"))),

        # Line / 社群
        ("line_name", clean(f.get("Line 名字"))),
        ("line_id", clean(f.get("Line ID"))),
        ("facebook_url", clean(f.get("個人臉書網址 (加教師日誌社群用)"))),

        # 個人經歷
        ("bio_personal_experience", clean(f.get("個人經歷 "))),
        ("bio_teaching_experience", clean(f.get("授課經驗"))),
        ("teaching_philosophy", clean(f.get("教學理念 "))),

        # 接課
        ("teaching_freq_semester", clean(f.get("(學期間) 接課頻率調查， 作答數字部分即可"))),
        ("teaching_freq_vacation", clean(f.get("(寒暑期) 接課頻率調查， 作答數字部分即可"))),
        ("teaching_regions_raw",
            clean(f.get("接課地區調查， 作答縣市即可")) or clean(t.get("接課地區"))),

        # 其他
        ("shirt_size", clean(f.get("衣服尺寸"))),
        ("bank_info_raw", clean(f.get("匯款帳戶資料 (辦華南銀行帳戶才不會每月被扣15元手續費)"))),
        ("note_to_team", clean(f.get("有沒有想對夢想一號說的話"))),
        ("convenience_store_code", clean(f.get("超商代號 (名稱+代號)"))),
        ("convenience_store_family", clean(f.get("聯絡超商 (全家)"))),
        ("convenience_store_711", clean(f.get("聯絡超商 (711)"))),

        # 表單時間戳記
        ("form_submitted_at", clean(f.get("時間戳記"))),

        # 文件(Google Drive 連結)
        ("id_front_external_url", clean(f.get("身分證正面"))),
        ("id_back_external_url", clean(f.get("身分證反面 "))),
        ("photo_external_url", clean(f.get("講師相片上傳 (舊老師非必要)"))),
        ("bankbook_external_url", clean(f.get("存摺封面"))),

        # 來源旗標
        ("has_form_response", name in form_rows),
    ])
    merged.append(record)

# 手動覆寫:已知特殊個案
# 洪紹恆已被開除(打小朋友),標記為 cancelled;email 是垃圾字串清掉
MANUAL_OVERRIDES = {
    "洪紹恆": {
        "employment_status": "cancelled",
        "employment_status_raw": "取消合作(手動標註)",
        "email_primary_clear": True,  # 清掉 "早就寫了"
        "note_internal": "已開除:對學生不當體罰",
    },
}

# 表單回應裡有、老師資料表沒有的人(理論上少,但要報告出來)
for name in form_only:
    f = form_rows[name]
    record = OrderedDict([
        ("full_name", name),
        ("employment_status", None),
        ("employment_status_raw", None),
        ("instructor_role", normalize_role(clean(f.get("講師身分")))),
        ("instructor_role_raw", clean(f.get("講師身分"))),
        ("gender", None),
        ("birth_date", clean(f.get("出生年月日"))),
        ("id_number", clean(f.get("身份證字號"))),
        ("phone_mobile", clean(f.get("手機號碼"))),
        ("phone_home", clean(f.get("家電號碼"))),
        ("email_primary", clean(f.get("電子郵件"))),
        ("email_secondary", clean(f.get("電子郵件地址"))),
        ("address_registered", clean(f.get("戶籍地址"))),
        ("address_mailing", clean(f.get("通訊地址"))),
        ("school_info", clean(f.get("目前就讀學校、科系、年級"))),
        ("line_name", clean(f.get("Line 名字"))),
        ("line_id", clean(f.get("Line ID"))),
        ("facebook_url", clean(f.get("個人臉書網址 (加教師日誌社群用)"))),
        ("bio_personal_experience", clean(f.get("個人經歷 "))),
        ("bio_teaching_experience", clean(f.get("授課經驗"))),
        ("teaching_philosophy", clean(f.get("教學理念 "))),
        ("teaching_freq_semester", clean(f.get("(學期間) 接課頻率調查， 作答數字部分即可"))),
        ("teaching_freq_vacation", clean(f.get("(寒暑期) 接課頻率調查， 作答數字部分即可"))),
        ("teaching_regions_raw", clean(f.get("接課地區調查， 作答縣市即可"))),
        ("shirt_size", clean(f.get("衣服尺寸"))),
        ("bank_info_raw", clean(f.get("匯款帳戶資料 (辦華南銀行帳戶才不會每月被扣15元手續費)"))),
        ("note_to_team", clean(f.get("有沒有想對夢想一號說的話"))),
        ("convenience_store_code", clean(f.get("超商代號 (名稱+代號)"))),
        ("convenience_store_family", clean(f.get("聯絡超商 (全家)"))),
        ("convenience_store_711", clean(f.get("聯絡超商 (711)"))),
        ("form_submitted_at", clean(f.get("時間戳記"))),
        ("id_front_external_url", clean(f.get("身分證正面"))),
        ("id_back_external_url", clean(f.get("身分證反面 "))),
        ("photo_external_url", clean(f.get("講師相片上傳 (舊老師非必要)"))),
        ("bankbook_external_url", clean(f.get("存摺封面"))),
        ("has_form_response", True),
        ("source_only", "form_only"),
        ("note_internal", None),
    ])
    merged.append(record)

# 套用手動覆寫
for r in merged:
    name = r["full_name"]
    if name in MANUAL_OVERRIDES:
        ov = MANUAL_OVERRIDES[name]
        if ov.get("email_primary_clear"):
            r["email_primary"] = None
        for k, v in ov.items():
            if k in ("email_primary_clear",):
                continue
            r[k] = v


# ── 4. 輸出 JSON ─────────────────────────────────────────────
OUT_JSON.parent.mkdir(exist_ok=True)
with open(OUT_JSON, "w", encoding="utf-8") as f:
    json.dump(merged, f, ensure_ascii=False, indent=2)


# ── 5. 統計報告 ─────────────────────────────────────────────
status_counts = {}
role_counts = {}
email_missing = []
both_empty = []
for r in merged:
    s = r["employment_status_raw"] or "(空白)"
    status_counts[s] = status_counts.get(s, 0) + 1
    rl = r["instructor_role_raw"] or "(空白)"
    role_counts[rl] = role_counts.get(rl, 0) + 1
    if not r["email_primary"]:
        email_missing.append(r["full_name"])
    non_empty = sum(1 for v in r.values() if v not in (None, "", False))
    if non_empty <= 3:  # 只有姓名 + 一兩個欄位
        both_empty.append(r["full_name"])

lines = [
    f"=== 合併結果報告 ===",
    f"總筆數: {len(merged)}",
    f"  - 老師資料表 ∩ 表單回應: {len(overlap_names)} 筆",
    f"  - 只有老師資料表: {len(teacher_rows) - len(overlap_names)} 筆",
    f"  - 只有表單回應: {len(form_only)} 筆",
    f"",
    f"被過濾的表單回應髒資料: {len(form_dirty)} 筆",
]
if form_dirty:
    lines.append("  範例(前 5 個):")
    for d in form_dirty[:5]:
        lines.append(f"    - {repr(d[:60])}")

lines.append("")
lines.append("管理層級分布:")
for k, v in sorted(status_counts.items(), key=lambda x: -x[1]):
    lines.append(f"  {k}: {v}")

lines.append("")
lines.append("老師等級分布:")
for k, v in sorted(role_counts.items(), key=lambda x: -x[1]):
    lines.append(f"  {k}: {v}")

lines.append("")
lines.append(f"沒有 email 的人: {len(email_missing)} 位")
if email_missing:
    lines.append(f"  例: {', '.join(email_missing[:10])}")

lines.append("")
lines.append(f"只有姓名 + 1~2 個欄位(資料極稀少)的人: {len(both_empty)} 位")
if both_empty:
    lines.append(f"  例: {', '.join(both_empty[:10])}")

report = "\n".join(lines)
print()
print(report)
OUT_REPORT.write_text(report, encoding="utf-8")
print(f"\n✅ 已輸出: {OUT_JSON.name}")
print(f"✅ 已輸出: {OUT_REPORT.name}")
