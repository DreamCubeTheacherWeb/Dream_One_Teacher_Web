"""
薪資總表換新 2026-10-19｜第二批：業主同意的 25 筆「推估更正」（都不動金額）

業主 2026-10-19 指示：把握七成以上的推估修正套用到正式資料（人數 21 筆、巫婉榆時數、劉韶瑜日期、兩筆 -1 人數），
原值保留在備註；余睿 2 筆（2024/8）與侯十方（人數「1 0」）先不動。

本程式讀本機上傳檔核對每一列的原文（防止列號寫錯），產生：
  05_apply_inferred_fixes.sql   單一交易；每列「現值必須等於預期舊值、原文必須相符」，否則整批回滾
  95_rollback_inferred_fixes.sql 逐列改回舊值並拿掉備註裡的更正說明
用法：python3 -I -B scripts/salary_master_import/build_inferred_fixes.py
"""
import csv
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPLOAD = HERE.parents[1] / "data-private" / "salary_master_rows_upload.csv"
DAY = "2026-10-19"

# 人數寫成文字：加總其中的數字（侯十方 5408「1 0」不明確，不在此列）
STUDENT_TEXT_ROWS = [373, 374, 380, 381, 482, 483, 484, 485, 486, 810, 1846, 1848, 1849, 1851, 1852,
                     1853, 1854, 2791, 2794, 2795, 2796]
NEGATIVE_STUDENTS = {137: ("4", "同梯次其他講師都是 4 人"), 1778: ("0", "科博館櫃台列人數一律填 0")}
HOURS = {180: ("9", "同營隊 8/18～8/21 都是 9 小時、同樣 2,700 元")}
DATES = {2095: ("2026-01-17", "備註寫 2025年12月馬胎營隊，前後列皆為 2025/12～2026/1 的登記")}


def q(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def build():
    rows = {int(r["row_no"]): r for r in csv.DictReader(open(UPLOAD, encoding="utf-8"))}
    fixes = []  # (row_no, field, raw_field, raw_value, expect_old, new_value, tag)
    for n in STUDENT_TEXT_ROWS:
        raw = rows[n]["raw_students"]
        nums = re.findall(r"\d+", raw)
        assert raw.strip() and not re.fullmatch(r"-?\d+", raw.strip()) and nums, (n, raw)
        new = str(sum(int(x) for x in nums))
        fixes.append((n, "student_count", "raw_students", raw, None, new,
                      f"［原登記人數「{raw}」，{DAY} 業主同意推估為 {new}］"))
    for n, (new, why) in NEGATIVE_STUDENTS.items():
        raw = rows[n]["raw_students"]
        assert raw.strip() == "-1", (n, raw)
        fixes.append((n, "student_count", "raw_students", raw, "-1", new,
                      f"［原登記人數 -1，{DAY} 業主同意推估為 {new}（{why}）］"))
    for n, (new, why) in HOURS.items():
        raw = rows[n]["raw_hours"]
        assert raw.strip() == "0.0", (n, raw)
        fixes.append((n, "duration_hours", "raw_hours", raw, "0", new,
                      f"［原登記時數 0，{DAY} 業主同意推估為 {new}（{why}）］"))
    for n, (new, why) in DATES.items():
        raw = rows[n]["raw_date"]
        assert raw.strip() == "2025/1/17", (n, raw)
        fixes.append((n, "session_date", "raw_date", raw, "2025-01-17", new,
                      f"［原登記日期 {raw}，{DAY} 業主同意推估為 {new.replace('-', '/').replace('/0', '/')}（{why}）］"))
    assert len(fixes) == 25, len(fixes)
    return fixes


def values_sql(fixes):
    return ",\n".join(
        f"  ({q(str(n))}, {q(field)}, {q(raw_field)}, {q(raw)}, {q(old)}, {q(new)}, {q(tag)})"
        for n, field, raw_field, raw, old, new, tag in fixes)


def apply_sql(fixes):
    return f"""-- 薪資總表換新 2026-10-19｜步驟 5：業主同意的 25 筆推估更正（單一交易，不動任何金額）
-- 由 build_inferred_fixes.py 產生，請勿手改。還原見 95_rollback_inferred_fixes.sql。
BEGIN;
SET LOCAL lock_timeout = '15s';
LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _fix (row_no text, field text, raw_field text, raw_value text, expect_old text, new_value text, tag text)
  ON COMMIT DROP;
INSERT INTO _fix VALUES
{values_sql(fixes)};

DO $$
DECLARE
  v_rows   int;
  v_bad    int;
  v_upd    int := 0;
  v_n      int;
  v_base0  numeric;
  v_bonus0 numeric;
  v_base1  numeric;
  v_bonus1 numeric;
BEGIN
  SELECT count(*) INTO v_rows FROM _fix;
  IF v_rows <> 25 THEN RAISE EXCEPTION '更正清單應為 25 筆，實際 %', v_rows; END IF;

  -- 每一列：暫存表原文必須相符（防列號寫錯）、正式表現值必須等於預期舊值、備註裡還沒有這次的更正說明
  SELECT count(*) INTO v_bad
    FROM _fix f
    LEFT JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
    LEFT JOIN public.class_sessions cs ON cs.id = m.class_session_id
   WHERE cs.id IS NULL
      OR (CASE f.raw_field WHEN 'raw_students' THEN m.raw_students WHEN 'raw_hours' THEN m.raw_hours ELSE m.raw_date END)
         IS DISTINCT FROM f.raw_value
      OR NOT (CASE f.field
                WHEN 'student_count'  THEN cs.student_count  IS NOT DISTINCT FROM f.expect_old::int
                WHEN 'duration_hours' THEN cs.duration_hours IS NOT DISTINCT FROM f.expect_old::numeric
                WHEN 'session_date'   THEN cs.session_date   IS NOT DISTINCT FROM f.expect_old::date
              END)
      OR strpos(coalesce(cs.notes, ''), f.tag) > 0;
  IF v_bad <> 0 THEN RAISE EXCEPTION '有 % 列與預期不符（原文、現值或已更正過），整批不執行', v_bad; END IF;

  SELECT sum(base_salary), sum(bonus) INTO v_base0, v_bonus0 FROM public.class_sessions;

  UPDATE public.class_sessions cs
     SET student_count = f.new_value::int, notes = concat_ws(' ', nullif(cs.notes, ''), f.tag)
    FROM _fix f JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
   WHERE cs.id = m.class_session_id AND f.field = 'student_count';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_upd := v_upd + v_n;

  UPDATE public.class_sessions cs
     SET duration_hours = f.new_value::numeric, notes = concat_ws(' ', nullif(cs.notes, ''), f.tag)
    FROM _fix f JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
   WHERE cs.id = m.class_session_id AND f.field = 'duration_hours';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_upd := v_upd + v_n;

  UPDATE public.class_sessions cs
     SET session_date = f.new_value::date, notes = concat_ws(' ', nullif(cs.notes, ''), f.tag)
    FROM _fix f JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
   WHERE cs.id = m.class_session_id AND f.field = 'session_date';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_upd := v_upd + v_n;

  SELECT sum(base_salary), sum(bonus) INTO v_base1, v_bonus1 FROM public.class_sessions;
  IF v_upd <> 25 OR v_base1 IS DISTINCT FROM v_base0 OR v_bonus1 IS DISTINCT FROM v_bonus0 THEN
    RAISE EXCEPTION '更正結果不符：更新 % 列（應為 25）、薪資 %→%、獎金 %→%', v_upd, v_base0, v_base1, v_bonus0, v_bonus1;
  END IF;
  RAISE NOTICE '完成：更正 % 列，薪資與獎金合計不變', v_upd;
END $$;

COMMIT;
"""


def rollback_sql(fixes):
    return f"""-- 薪資總表換新 2026-10-19｜還原步驟 5：把 25 筆推估更正改回原值並拿掉備註裡的更正說明（單一交易）
-- 由 build_inferred_fixes.py 產生，請勿手改。
BEGIN;
SET LOCAL lock_timeout = '15s';
LOCK TABLE public.class_sessions IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _fix (row_no text, field text, raw_field text, raw_value text, expect_old text, new_value text, tag text)
  ON COMMIT DROP;
INSERT INTO _fix VALUES
{values_sql(fixes)};

DO $$
DECLARE
  v_bad int;
  v_upd int := 0;
  v_n   int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM _fix f
    LEFT JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
    LEFT JOIN public.class_sessions cs ON cs.id = m.class_session_id
   WHERE cs.id IS NULL OR strpos(coalesce(cs.notes, ''), f.tag) = 0;
  IF v_bad <> 0 THEN RAISE EXCEPTION '有 % 列找不到這次的更正說明，整批不還原', v_bad; END IF;

  UPDATE public.class_sessions cs
     SET student_count = f.expect_old::int,
         notes = nullif(btrim(replace(cs.notes, f.tag, '')), '')
    FROM _fix f JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
   WHERE cs.id = m.class_session_id AND f.field = 'student_count';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_upd := v_upd + v_n;

  UPDATE public.class_sessions cs
     SET duration_hours = f.expect_old::numeric,
         notes = nullif(btrim(replace(cs.notes, f.tag, '')), '')
    FROM _fix f JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
   WHERE cs.id = m.class_session_id AND f.field = 'duration_hours';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_upd := v_upd + v_n;

  UPDATE public.class_sessions cs
     SET session_date = f.expect_old::date,
         notes = nullif(btrim(replace(cs.notes, f.tag, '')), '')
    FROM _fix f JOIN public.salary_master_rows m ON m.batch = '2026-10-19' AND m.row_no = f.row_no
   WHERE cs.id = m.class_session_id AND f.field = 'session_date';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_upd := v_upd + v_n;

  IF v_upd <> 25 THEN RAISE EXCEPTION '還原筆數不符：%（應為 25）', v_upd; END IF;
  RAISE NOTICE '還原完成：% 列', v_upd;
END $$;

COMMIT;
"""


if __name__ == "__main__":
    fixes = build()
    (HERE / "05_apply_inferred_fixes.sql").write_text(apply_sql(fixes), encoding="utf-8")
    (HERE / "95_rollback_inferred_fixes.sql").write_text(rollback_sql(fixes), encoding="utf-8")
    for f in fixes:
        print(f[0], f[1], repr(f[3]), "→", f[5])
