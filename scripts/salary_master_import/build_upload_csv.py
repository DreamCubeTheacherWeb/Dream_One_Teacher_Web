"""
2026-10-19 薪資總表換新：把業主確認正確的總表轉成可上傳 Supabase 的暫存表 CSV。

輸入：data-private/salary_master_2026-10-19.csv（業主 10/19 貼上的原文，第一欄「來源列號」，被 .gitignore 排除）
輸出：data-private/salary_master_rows_upload.csv（欄名＝暫存表 public.salary_master_rows 的欄位，全部文字）
     並印出筆數、金額合計與 raw_checksum（上傳後在 SQL 端用同樣算法重算，必須一致）。

轉換規則與 5 月那次 scripts/import_salary_history.py 完全相同（課程種類對應、級別併入、
人數取整、已領>0 為 paid），唯一差別：業主 2026-10-19 同意更正 22 筆明顯打錯的年份，
原登記日期保留在備註。講師 instructor_id 不在這裡對應，由 SQL 端以 instructors.full_name 精確比對。
"""
import csv
import hashlib
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "data-private" / "salary_master_2026-10-19.csv"
OUT = ROOT / "data-private" / "salary_master_rows_upload.csv"
BATCH = "2026-10-19"

RAW_COLS = [  # (總表欄名, 暫存表欄名)
    ("月份", "raw_month"), ("講師名稱", "raw_instructor"), ("課程種類", "raw_course_kind"),
    ("日期", "raw_date"), ("登記人", "raw_registrar"), ("級別", "raw_level"),
    ("課程名稱", "raw_course_name"), ("備註", "raw_notes"), ("時數", "raw_hours"),
    ("人數", "raw_students"), ("薪資", "raw_salary"), ("獎金", "raw_bonus"),
    ("已領金額", "raw_paid"), ("課程自評", "raw_self_review"), ("學習進度", "raw_progress"),
    ("特殊狀況回報", "raw_incident"),
]
DERIVED_COLS = [
    "course_type", "role_in_session", "instructor_name", "instructor_role_at_time", "session_date",
    "course_name", "notes", "duration_hours", "student_count", "base_salary", "bonus", "paid_amount",
    "status", "registered_by_name", "self_review", "progress_note", "incident_report",
    "date_fixed", "original_date",
]
OUT_COLS = ["batch", "row_no"] + [c for _, c in RAW_COLS] + DERIVED_COLS

# 與 scripts/import_salary_history.py 相同
COURSE_MAP = {
    "合作課程 主講": ("collab_lead", "lead"), "常態課程": ("regular_basic", "lead"),
    "到府課程": ("onsite_2hr", "lead"), "其他": ("other", "other"), "營隊課程": ("camp", "lead"),
    "速解研究所": ("speed_training_lead", "lead"), "櫃台人員": ("counter", "counter"),
    "合作課程 助教": ("collab_assistant", "assistant"), "線上課程": ("online", "lead"),
    "到府家教課 or 到府揪團課": ("onsite_2hr", "lead"), "擺攤": ("event_booth", "other"),
    "營隊課程負責人": ("camp_director_5d", "project_lead"), "速解研究所 實體": ("speed_onsite", "lead"),
    "速解研究所｜實體課程": ("speed_onsite", "lead"), "速解研究所 到府": ("speed_onsite", "lead"),
    "速解研究所 線上": ("speed_online", "lead"), "速解研究所｜線上課程": ("speed_online", "lead"),
    "楓葉體驗課": ("other", "lead"), "學校社團": ("other", "lead"), "徵稿": ("other", "other"),
}
ROLE_MAP = {"S": "S", "A+": "A+", "A": "A", "B": "B", "實習講師": "實習", "實習": "實習",
            "C": "實習", "D": "實習", "無": None, "職員": None, "與等級無關": None}

# 業主 2026-10-19 同意更正的 22 筆年份（來源列號: (原日期, 更正後日期)）
DATE_FIXES = {550: ("2005/8/23", "2025/8/23"), 687: ("2005/8/31", "2025/8/31"),
              2310: ("2000/1/18", "2026/1/18")}
for _row, _day in [(2404, 28), (2405, 26), (2406, 26), (2407, 27), (2408, 27), (2409, 27), (2410, 27),
                   (2411, 27), (2412, 27), (2413, 28), (2414, 28), (2415, 28), (2416, 28), (2417, 28),
                   (2418, 30), (2419, 31), (2420, 31), (2421, 31), (2422, 31)]:
    DATE_FIXES[_row] = (f"2026/12/{_day}", f"2025/12/{_day}")


def num(s):
    s = (s or "").strip().replace(",", "")
    if not s or s == "-":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def fmt_num(x):
    if x is None:
        return ""
    return str(int(x)) if float(x).is_integer() else repr(round(x, 4))


def parse_date(s, fallback_month=None):
    s = (s or "").strip()
    if not s:
        m = re.match(r"(\d{4})/(\d{1,2})", fallback_month or "")
        return f"{m.group(1)}-{int(m.group(2)):02d}-01" if m else None
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    m = re.match(r"(\d{4})/(\d{1,2})$", s)
    return f"{m.group(1)}-{int(m.group(2)):02d}-01" if m else None


def strip_or_empty(s):
    return (s or "").strip()


def raw_checksum(rows):
    """與 SQL 端相同：依 row_no 排序，各欄以 \\x1f 相接，列以 \\n 相接後取 md5。"""
    lines = []
    for r in sorted(rows, key=lambda x: int(x["row_no"])):
        lines.append("\x1f".join([r["row_no"]] + [r[c] for _, c in RAW_COLS]))
    return hashlib.md5("\n".join(lines).encode("utf-8")).hexdigest()


def derived_checksum(rows):
    """換算欄位的指紋（同樣的算法套在 DERIVED_COLS）。上傳工具若弄壞中文字，原文與換算欄都要抓得到。"""
    lines = []
    for r in sorted(rows, key=lambda x: int(x["row_no"])):
        lines.append("\x1f".join([r["row_no"]] + [r[c] for c in DERIVED_COLS]))
    return hashlib.md5("\n".join(lines).encode("utf-8")).hexdigest()


def main():
    src = list(csv.DictReader(open(SRC, encoding="utf-8-sig")))
    out, fixed, problems = [], 0, []
    for r in src:
        row_no = int(r["來源列號"])
        o = {"batch": BATCH, "row_no": str(row_no)}
        for zh, en in RAW_COLS:
            o[en] = r.get(zh) or ""
        name = strip_or_empty(r["講師名稱"])
        if not name:
            problems.append(f"列 {row_no} 沒有講師名稱")
        kind = strip_or_empty(r["課程種類"])
        course_type, role = COURSE_MAP.get(kind, ("other", "other"))
        raw_date = strip_or_empty(r["日期"])
        date_text, original = raw_date, ""
        notes = strip_or_empty(r["備註"])
        if row_no in DATE_FIXES:
            want_old, new_date = DATE_FIXES[row_no]
            if raw_date != want_old:
                problems.append(f"列 {row_no} 原日期應為 {want_old}，實際 {raw_date}")
            date_text, original = new_date, raw_date
            tag = f"［原登記日期 {raw_date}，2026-10-19 業主同意更正為 {new_date}］"
            notes = f"{notes} {tag}".strip()
            fixed += 1
        session_date = parse_date(date_text, fallback_month=r["月份"])
        if not session_date:
            problems.append(f"列 {row_no} 日期無法解析：{raw_date!r}")
        sal, bon, paid = num(r["薪資"]) or 0, num(r["獎金"]) or 0, num(r["已領金額"]) or 0
        students = num(r["人數"])
        o.update({
            "course_type": course_type, "role_in_session": role, "instructor_name": name,
            "instructor_role_at_time": ROLE_MAP.get(strip_or_empty(r["級別"])) or "",
            "session_date": session_date or "", "course_name": strip_or_empty(r["課程名稱"]),
            "notes": notes, "duration_hours": fmt_num(num(r["時數"])),
            "student_count": str(int(students)) if students else "",
            "base_salary": fmt_num(sal), "bonus": fmt_num(bon), "paid_amount": fmt_num(paid),
            "status": "paid" if paid > 0 else "approved",
            "registered_by_name": strip_or_empty(r["登記人"]), "self_review": strip_or_empty(r["課程自評"]),
            "progress_note": strip_or_empty(r["學習進度"]), "incident_report": strip_or_empty(r["特殊狀況回報"]),
            "date_fixed": "true" if original else "false", "original_date": original,
        })
        out.append(o)
    if fixed != len(DATE_FIXES):
        problems.append(f"年份更正只套到 {fixed}/{len(DATE_FIXES)} 筆")
    if problems:
        print("\n".join(problems))
        sys.exit(1)
    with open(OUT, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=OUT_COLS, quoting=csv.QUOTE_ALL)
        w.writeheader()
        w.writerows(out)
    total = lambda k: sum(float(o[k] or 0) for o in out)
    print(f"rows={len(out)} date_fixed={fixed} base_salary_sum={total('base_salary'):.0f} "
          f"bonus_sum={total('bonus'):.0f} paid_sum={total('paid_amount'):.0f} "
          f"paid_status={sum(o['status'] == 'paid' for o in out)} raw_checksum={raw_checksum(out)} "
          f"derived_checksum={derived_checksum(out)}")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
