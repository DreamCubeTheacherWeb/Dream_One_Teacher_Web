"""
薪資總表換新 2026-10-19｜本機演練（臨時 PostgreSQL，跑完即刪，不連線上）

1. 依 migration 鏈建出 class_sessions（2025_salary_system → 20260826 → 20261018120000 → 20261018150000）
2. 用 5 月舊總表、照當時 import_salary_history.py 的換算放入 9,532 筆 historical_import，
   再放 3 筆網站端紀錄（self_report／manual），模擬正式庫現況
3. 套新 migration 兩次 → 01 預檢 → 上傳 CSV（\\copy，模擬 Table Editor 匯入）→ 02 核對
   → 03 搬移＋匯入 → 再跑一次 03 必須被擋 → 04 事後核對 → 權限檢查 → 99 還原（必須與原狀逐欄相同）
   → 再跑一次 03（還原後可重來）
兩種上傳情境各跑一輪：空白欄是空字串（A）、空白欄變 NULL（B，Table Editor 可能如此處理）。
用法：python3 -I scripts/salary_master_import/rehearse_local.py
"""
import csv
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
APP = ROOT / "培訓web"
OLD_CSV = Path("/Users/lazylazy/Desktop/夢想一號/Dream_One_Teacher_Web/講師 資料總表 23年啟用永久版 - 所有薪資登記.csv")
INSTRUCTOR_NAMES = Path("/Users/lazylazy/Desktop/夢想一號/Dream_One_Teacher_Web/scripts/instructors_merged_preview.json")
UPLOAD_CSV = ROOT / "data-private" / "salary_master_rows_upload.csv"

spec = importlib.util.spec_from_file_location("build_upload_csv", HERE / "build_upload_csv.py")
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)

ENV = {**os.environ, "LC_ALL": "C", "LANG": "C"}
RESULTS = []


def check(label, ok, detail=""):
    RESULTS.append((label, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {label}{('  ' + str(detail)) if detail != '' else ''}")


class PG:
    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="salary-master-rehearsal-", dir=os.environ.get("TMPDIR")))
        subprocess.run(["initdb", "-D", str(self.dir / "data"), "-A", "trust", "-U", "postgres",
                        "--no-locale", "-E", "UTF8"], check=True, env=ENV, capture_output=True)
        self.proc = subprocess.Popen(
            ["postgres", "-D", str(self.dir / "data"), "-k", str(self.dir), "-p", "54329",
             "-c", "listen_addresses=", "-c", "fsync=off"],
            env=ENV, stdout=subprocess.DEVNULL, stderr=open(self.dir / "pg.log", "w"))
        for _ in range(100):
            if subprocess.run(["pg_isready", "-h", str(self.dir), "-p", "54329"], env=ENV,
                              capture_output=True).returncode == 0:
                return
            time.sleep(0.1)
        raise RuntimeError("PostgreSQL did not start:\n" + (self.dir / "pg.log").read_text())

    def psql(self, db, sql=None, file=None, expect_fail=False, raw=False):
        args = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", str(self.dir), "-p", "54329",
                "-U", "postgres", "-d", db, "-t", "-A"]
        args += ["-f", str(file)] if file else ["-c", sql]
        r = subprocess.run(args, env=ENV, capture_output=True, text=True, cwd=str(APP / "supabase"))
        if expect_fail:
            return r
        if r.returncode != 0:
            raise RuntimeError(f"psql failed ({file or sql[:80]}):\n{r.stderr}")
        return r if raw else r.stdout.strip()

    def json(self, db, file):
        return json.loads(self.psql(db, file=file))

    def close(self):
        self.proc.terminate()
        self.proc.wait(timeout=20)
        shutil.rmtree(self.dir, ignore_errors=True)


BOOTSTRAP = """
CREATE SCHEMA auth;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
-- 與 Supabase 相同：之後在 public 建的表預設把全部權限給 anon／authenticated（新 migration 必須自己 REVOKE）
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
CREATE TYPE public.instructor_role_enum AS ENUM ('S', 'A+', 'A', 'B', '實習');
CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, email text, role text);
GRANT SELECT ON public.users TO authenticated;
CREATE TABLE public.instructors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid UNIQUE REFERENCES auth.users(id),
  full_name text NOT NULL,
  instructor_role public.instructor_role_enum,
  speed_qualification text,
  employment_status text DEFAULT 'active'
);
GRANT SELECT ON public.instructors TO authenticated;
-- PostgreSQL 16 不接受 to_char 當衍生欄位；用 IMMUTABLE 包一層，讓 month_label 仍是衍生欄位（與正式庫相同性質）
CREATE FUNCTION public._month_label(d date) RETURNS text IMMUTABLE LANGUAGE sql AS $$ SELECT to_char(d, 'YYYY/MM') $$;
"""

SNAPSHOT_SQL = """
SELECT md5(string_agg(t::text, E'\\n' ORDER BY t::text)) FROM (
  SELECT id, course_type, course_name, location, instructor_id, instructor_name, role_in_session,
         instructor_role_at_time, session_date, month_label, duration_hours, student_count, base_salary, bonus,
         total_salary, paid_amount, status, registered_by_name, self_review, progress_note, incident_report,
         notes, source, created_at, pricing_status
    FROM public.class_sessions) t
"""


def old_rows():
    rows = list(csv.DictReader(open(OLD_CSV, encoding="utf-8")))
    out = []
    for r in rows:
        name = (r.get("講師名稱") or "").strip()
        if not name:
            continue
        kind = (r.get("課程種類") or "").strip()
        course_type, role = B.COURSE_MAP.get(kind, ("other", "other"))
        date = B.parse_date(r.get("日期"), fallback_month=r.get("月份"))
        if not date:
            continue
        sal, bon, paid = B.num(r.get("薪資")) or 0, B.num(r.get("獎金")) or 0, B.num(r.get("已領金額")) or 0
        st = B.num(r.get("人數"))
        out.append({
            "course_type": course_type, "course_name": (r.get("課程名稱") or "").strip(),
            "instructor_name": name, "role_in_session": role,
            "instructor_role_at_time": B.ROLE_MAP.get((r.get("級別") or "").strip()) or "",
            "session_date": date, "duration_hours": B.fmt_num(B.num(r.get("時數"))),
            "student_count": str(int(st)) if st else "", "base_salary": B.fmt_num(sal),
            "bonus": B.fmt_num(bon), "paid_amount": B.fmt_num(paid),
            "status": "paid" if paid > 0 else "approved",
            "registered_by_name": (r.get("登記人") or "").strip(),
            "self_review": (r.get("課程自評") or "").strip(),
            "progress_note": (r.get("學習進度（常態課必填）") or "").strip(),
            "incident_report": (r.get("特殊狀況回報") or "").strip(),
            "notes": (r.get("備註") or "").strip(),
        })
    return out


def build_db(pg, db, null_empty):
    pg.psql("postgres", f"CREATE DATABASE {db}")
    pg.psql(db, BOOTSTRAP)
    base = (APP / "supabase" / "2025_salary_system.sql").read_text(encoding="utf-8")
    target = "to_char(session_date, 'YYYY/MM')"
    assert target in base, "month_label expression not found"
    base_path = pg.dir / "base.sql"
    base_path.write_text(base.replace(target, "public._month_label(session_date)"), encoding="utf-8")
    pg.psql(db, file=base_path)
    for mig in ["20260826105841_restore_salary_workflow.sql", "20261018120000_align_salary_report_with_forms.sql",
                "20261018150000_limit_instructor_salary_visibility.sql"]:
        pg.psql(db, file=APP / "supabase" / "migrations" / mig)

    names = sorted({(x.get("full_name") or "").strip() for x in json.load(open(INSTRUCTOR_NAMES, encoding="utf-8"))} - {""})
    inst_csv = pg.dir / f"{db}_instructors.csv"
    with open(inst_csv, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        for n in names:
            w.writerow([n])
    pg.psql(db, f"\\copy public.instructors (full_name) FROM '{inst_csv}' CSV")

    rows = old_rows()
    hist_csv = pg.dir / f"{db}_historical.csv"
    cols = list(rows[0].keys())
    with open(hist_csv, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        for r in rows:
            w.writerow([r[c] for c in cols])
    # 依 CSV 順序寫入，instructor_id 以名字對應（與 5 月相同：對不到就留空）
    pg.psql(db, f"""
      CREATE TABLE _h ({', '.join(f'{c} text' for c in cols)}, ord serial);
    """)
    pg.psql(db, f"\\copy _h ({', '.join(cols)}) FROM '{hist_csv}' CSV")
    pg.psql(db, """
      INSERT INTO public.class_sessions (course_type, course_name, instructor_id, instructor_name, role_in_session,
        instructor_role_at_time, session_date, duration_hours, student_count, base_salary, bonus, paid_amount,
        status, registered_by_name, self_review, progress_note, incident_report, notes, source, created_at, updated_at)
      SELECT h.course_type, nullif(h.course_name, ''), i.id, h.instructor_name, h.role_in_session::public.session_role_enum,
        nullif(h.instructor_role_at_time, ''), h.session_date::date, nullif(h.duration_hours, '')::numeric,
        nullif(h.student_count, '')::int, coalesce(nullif(h.base_salary, ''), '0')::numeric,
        coalesce(nullif(h.bonus, ''), '0')::numeric, coalesce(nullif(h.paid_amount, ''), '0')::numeric,
        h.status::public.session_status_enum, nullif(h.registered_by_name, ''), nullif(h.self_review, ''),
        nullif(h.progress_note, ''), nullif(h.incident_report, ''), nullif(h.notes, ''), 'historical_import',
        '2026-05-15 12:00+08', '2026-05-15 12:00+08'
        FROM _h h LEFT JOIN public.instructors i ON i.full_name = h.instructor_name
       ORDER BY h.ord;
      DROP TABLE _h;
      -- 網站端紀錄（講師回報 2 筆、後台手動 1 筆），必須全程不受影響
      INSERT INTO auth.users (id, email) VALUES
        ('00000000-0000-4000-8000-000000000001', 'teacher@test.local'),
        ('00000000-0000-4000-8000-000000000003', 'admin@test.local');
      INSERT INTO public.users (id, name, email, role) VALUES
        ('00000000-0000-4000-8000-000000000001', '楊宗興', 'teacher@test.local', 'teacher'),
        ('00000000-0000-4000-8000-000000000003', '管理員', 'admin@test.local', 'admin');
      UPDATE public.instructors SET user_id = '00000000-0000-4000-8000-000000000001' WHERE full_name = '楊宗興';
      INSERT INTO public.class_sessions (course_type, instructor_id, instructor_name, session_date, duration_hours,
        base_salary, source, status, pricing_status, course_name)
      SELECT 'regular_basic', id, '楊宗興', DATE '2026-10-18', 1.5, 450, 'self_report',
             'approved'::public.session_status_enum, 'legacy', '網站回報 A'
        FROM public.instructors WHERE full_name = '楊宗興'
      UNION ALL
      SELECT 'onsite_2hr', id, '楊宗興', DATE '2026-10-19', 2, 900, 'self_report', 'approved', 'legacy', '網站回報 B'
        FROM public.instructors WHERE full_name = '楊宗興'
      UNION ALL
      SELECT 'other', NULL, '後台手動', DATE '2026-09-30', 0, 500, 'manual', 'approved', 'legacy', '後台手動 C';
    """)
    # 同名兩位講師：王威皓（舊紀錄已掛在其中一位 → 沿用）、温浩志（新面孔、兩位同名且無舊紀錄 → 留空不亂配）
    pg.psql(db, "INSERT INTO public.instructors (full_name) VALUES ('王威皓'), ('温浩志'), ('温浩志')")
    return len(rows)


def load_upload(pg, db, null_empty):
    with open(UPLOAD_CSV, encoding="utf-8") as f:
        header = next(csv.reader(f))
    pg.psql(db, f"\\copy public.salary_master_rows ({', '.join(header)}) FROM '{UPLOAD_CSV}' CSV HEADER")
    if null_empty:
        sets = ", ".join(f"{c} = nullif({c}, '')" for c in header)
        pg.psql(db, f"UPDATE public.salary_master_rows SET {sets}")


def rehearse(pg, label, null_empty):
    db = f"rehearsal_{label.lower()}"
    print(f"\n══ 情境 {label}：空白欄 {'變 NULL' if null_empty else '為空字串'} ══")
    hist_n = build_db(pg, db, null_empty)
    check("模擬正式庫：歷史匯入筆數 = 9,532", hist_n == 9532, hist_n)
    snap_before = pg.psql(db, SNAPSHOT_SQL)

    mig = APP / "supabase" / "migrations" / "20261019120000_salary_master_quarantine.sql"
    pg.psql(db, file=mig)
    pg.psql(db, file=mig)
    check("migration 連跑兩次無誤", True)
    pre = pg.json(db, HERE / "01_preflight.sql")
    check("01 預檢：historical 9,532、網站端 3 筆", pre["historical"]["rows"] == 9532
          and pre["by_source"].get("self_report") == 2 and pre["by_source"].get("manual") == 1, pre["by_source"])
    check("01 預檢：沒有其他表以外鍵指向 class_sessions", pre["fk_into_class_sessions"] == [])
    print("      預檢 anomaly:", pre["anomaly"], pre["anomaly_reasons"])

    load_upload(pg, db, null_empty)
    # 模擬正式環境實際發生的狀況：上傳工具把中文字切壞成 U+FFFD（原文欄與換算欄各一格）
    pg.psql(db, "UPDATE public.salary_master_rows SET raw_course_kind = '合作課程 ' || chr(65533) || chr(65533) || chr(65533) || '講' "
                "WHERE row_no = '1878'; UPDATE public.salary_master_rows SET notes = notes || chr(65533) WHERE row_no = '3364'")
    bad = pg.json(db, HERE / "02_check_upload.sql")
    check("02 上傳核對：切壞的中文字會被抓到（兩種指紋都不符、亂碼 2 列）",
          bad["raw_checksum"] != "9f352eadbbd4e1947b9b78f624483b58"
          and bad["derived_checksum"] != "918701e66d70059cf5b1d39ab2b6d95d" and bad["replacement_char_rows"] == 2)
    blocked = pg.psql(db, file=HERE / "03_apply.sql", expect_fail=True)
    check("03 遇到切壞的暫存表會拒絕執行、資料不動", blocked.returncode != 0 and "不符" in blocked.stderr
          and pg.psql(db, "SELECT count(*) FROM public.class_sessions WHERE source = 'historical_import'") == "9532")
    spec_r = importlib.util.spec_from_file_location("repair_rows", HERE / "repair_rows.py")
    R = importlib.util.module_from_spec(spec_r)
    spec_r.loader.exec_module(R)
    repair = pg.dir / f"{db}_repair.sql"
    repair.write_text(R.build_sql(["1878:raw_course_kind", "3364:notes"]), encoding="utf-8")
    pg.psql(db, file=repair)
    up = pg.json(db, HERE / "02_check_upload.sql")
    check("修補後兩種指紋回到預期、無亂碼", up["derived_checksum"] == "918701e66d70059cf5b1d39ab2b6d95d"
          and up["replacement_char_rows"] == 0)
    check("02 上傳核對：5,535 筆、列號不重複", up["rows"] == 5535 and up["distinct_row_no"] == 5535)
    check("02 上傳核對：原文 checksum 與本機相同", up["raw_checksum"] == "9f352eadbbd4e1947b9b78f624483b58", up["raw_checksum"])
    check("02 上傳核對：薪資／獎金／已領合計", float(up["base_salary_sum"]) == 10271061 and float(up["bonus_sum"]) == 453547
          and float(up["paid_sum"]) == 6000)
    check("02 上傳核對：22 筆年份更正、無壞日期／狀態／角色", up["date_fixed"] == 22 and up["bad_session_date"] == 0
          and up["bad_status"] == 0 and up["bad_role"] == 0 and up["empty_name"] == 0)
    check("02 上傳核對：同名講師被列為 ambiguous", {"王威皓", "温浩志"} <= {x["name"] for x in up["names_ambiguous"]})
    print(f"      名字對應：{up['names_matched']}/{up['names_total']} 位唯一對應、{len(up['names_unmatched'])} 位找不到、"
          f"{len(up['names_ambiguous'])} 位同名")
    check("02 上傳核對：網站端紀錄與新總表重疊會被列出", isinstance(up["overlap_with_website_rows"], list),
          up["overlap_with_website_rows"])

    pg.psql(db, file=HERE / "03_apply.sql")
    check("03 搬移＋匯入成功", True)
    again = pg.psql(db, file=HERE / "03_apply.sql", expect_fail=True)
    check("03 重跑會被擋（已匯入過）", again.returncode != 0 and "已經匯入過" in again.stderr, again.stderr.strip()[-80:])

    post = pg.json(db, HERE / "04_postcheck.sql")
    src = post["class_sessions_by_source"]
    check("04 核對：class_sessions = 新總表 5,535 ＋ 網站端 3", src.get("historical_import") == 5535
          and src.get("self_report") == 2 and src.get("manual") == 1, src)
    check("04 核對：新總表每列都在 class_sessions、金額合計一致", post["master_rows_in_class_sessions"] == 5535
          and float(post["class_sessions_master_base_sum"]) == 10271061
          and float(post["class_sessions_master_bonus_sum"]) == 453547 and post["historical_not_from_master"] == 0)
    q = post["quarantine"]
    check("04 核對：隔離區 9,532 筆", q["rows"] == 9532, q)
    print(f"      隔離區：新總表有相同列 {q['matched_in_master']}、新總表沒有 {q['not_in_master']}；"
          f"沒有的依年份 {post['quarantine_not_in_master_by_year']}")
    print(f"      講師對應：{post['instructor_match']}；講師可見（2026 起且有對應）{post['teacher_visible_rows']} 筆")
    print(f"      匯入後 anomaly：{post['anomaly_now']} {post['anomaly_reasons_now']}")
    fixed = post["date_fixed_rows"]
    check("04 核對：22 筆年份已更正（無 2026-12、無 2020 年前）", len(fixed) == 22
          and all(not x["to"].startswith("2026-12") and x["to"] >= "2020" for x in fixed))
    prev = pg.psql(db, "SELECT count(DISTINCT q.instructor_id) || '/' || count(DISTINCT cs.instructor_id) || '/' || "
                       "bool_and(cs.instructor_id = q.instructor_id) FROM public.class_sessions cs, "
                       "(SELECT DISTINCT instructor_id FROM public.class_sessions_quarantine WHERE instructor_name = '王威皓') q "
                       "WHERE cs.instructor_name = '王威皓' AND cs.source = 'historical_import'")
    check("04 核對：同名但舊紀錄有固定對應者（王威皓）沿用舊對應", prev == "1/1/true", prev)
    amb = pg.psql(db, "SELECT count(*) FILTER (WHERE instructor_id IS NOT NULL) || '/' || count(*) FROM public.class_sessions "
                      "WHERE instructor_name = '温浩志' AND source = 'historical_import'")
    check("04 核對：同名且無舊對應者（温浩志）一律留空不亂配", amb.startswith("0/") and amb != "0/0", amb)
    web = pg.psql(db, "SELECT string_agg(course_name, ',' ORDER BY course_name) FROM public.class_sessions WHERE source <> 'historical_import'")
    check("04 核對：網站端 3 筆原封不動", sorted(web.split(",")) == sorted(["網站回報 A", "網站回報 B", "後台手動 C"]), web)

    # 權限：講師、匿名讀不到暫存表與隔離區，admin 讀得到；網站端任何人都不能寫
    def as_user(uid, sql, role="authenticated"):
        claim = f"SET LOCAL request.jwt.claim.sub = '{uid}';" if uid else ""
        return pg.psql(db, f"BEGIN; SET LOCAL ROLE {role}; {claim} {sql}; ROLLBACK;", expect_fail=True)
    t1 = as_user("00000000-0000-4000-8000-000000000001", "SELECT count(*) FROM public.class_sessions_quarantine")
    t2 = as_user("00000000-0000-4000-8000-000000000001", "SELECT count(*) FROM public.salary_master_rows")
    check("權限：講師讀隔離區與暫存表都是 0 筆", t1.returncode == 0 and t1.stdout.strip() == "0"
          and t2.returncode == 0 and t2.stdout.strip() == "0", (t1.stdout.strip(), t2.stdout.strip()))
    a1 = as_user("00000000-0000-4000-8000-000000000003", "SELECT count(*) FROM public.class_sessions_quarantine")
    a2 = as_user("00000000-0000-4000-8000-000000000003", "SELECT count(*) FROM public.salary_master_rows")
    check("權限：admin 讀得到隔離區 9,532、暫存表 5,535", a1.stdout.strip() == "9532" and a2.stdout.strip() == "5535",
          (a1.stdout.strip(), a2.stdout.strip()))
    an = as_user(None, "SELECT count(*) FROM public.class_sessions_quarantine", role="anon")
    check("權限：匿名讀隔離區被拒", an.returncode != 0 and "permission denied" in an.stderr)
    w1 = as_user("00000000-0000-4000-8000-000000000003", "DELETE FROM public.class_sessions_quarantine")
    w2 = as_user("00000000-0000-4000-8000-000000000003", "UPDATE public.salary_master_rows SET notes = 'x'")
    check("權限：網站端（含 admin）不能刪改隔離區與暫存表", w1.returncode != 0 and w2.returncode != 0
          and "permission denied" in w1.stderr and "permission denied" in w2.stderr)
    tv = as_user("00000000-0000-4000-8000-000000000001", "SELECT count(*) FROM public.class_sessions")
    exp = pg.psql(db, "SELECT count(*) FROM public.class_sessions cs JOIN public.instructors i ON i.id = cs.instructor_id "
                      "WHERE i.full_name = '楊宗興' AND cs.session_date >= DATE '2026-01-01'")
    check("權限：講師看到自己 2026 起的紀錄（含新總表＋網站回報）", tv.returncode == 0 and tv.stdout.strip() == exp,
          (tv.stdout.strip(), exp))

    # 第二批：25 筆推估更正（05）與其還原（95）
    spec_f = importlib.util.spec_from_file_location("build_inferred_fixes", HERE / "build_inferred_fixes.py")
    F = importlib.util.module_from_spec(spec_f)
    spec_f.loader.exec_module(F)
    fixes = F.build()
    snap_pre05 = pg.psql(db, SNAPSHOT_SQL)
    sums_pre05 = pg.psql(db, "SELECT sum(base_salary) || '/' || sum(bonus) FROM public.class_sessions")
    pg.psql(db, file=HERE / "05_apply_inferred_fixes.sql")
    def fix_state(n, field):
        return pg.psql(db, f"SELECT coalesce(cs.{field}::text, 'NULL') || '|' || coalesce(cs.notes, '') FROM public.class_sessions cs "
                           f"JOIN public.salary_master_rows m ON m.class_session_id = cs.id AND m.batch = '2026-10-19' "
                           f"WHERE m.row_no = '{n}'")
    ok_new = all(fix_state(n, field).split("|", 1)[0] in (new, new + ".00") and tag in fix_state(n, field)
                 for n, field, _, _, _, new, tag in fixes)
    check("05 推估更正：25 列都變成推估值、備註留有原值說明", ok_new)
    check("05 推估更正：薪資與獎金合計不變",
          pg.psql(db, "SELECT sum(base_salary) || '/' || sum(bonus) FROM public.class_sessions") == sums_pre05, sums_pre05)
    again05 = pg.psql(db, file=HERE / "05_apply_inferred_fixes.sql", expect_fail=True)
    check("05 重跑會被擋（已更正過）", again05.returncode != 0 and "不符" in again05.stderr)
    pg.psql(db, file=HERE / "95_rollback_inferred_fixes.sql")
    check("95 還原：class_sessions 逐欄回到更正前", pg.psql(db, SNAPSHOT_SQL) == snap_pre05)
    pg.psql(db, file=HERE / "05_apply_inferred_fixes.sql")
    check("95 還原後可再次執行 05", all(tag in fix_state(n, field) for n, field, _, _, _, _, tag in fixes))

    pg.psql(db, file=HERE / "99_rollback.sql")
    snap_after = pg.psql(db, SNAPSHOT_SQL)
    src2 = pg.psql(db, "SELECT string_agg(source || '=' || c, ',' ORDER BY source) FROM (SELECT source, count(*) c FROM public.class_sessions GROUP BY 1) x")
    check("99 還原：class_sessions 逐欄回到原狀（含 id、建立時間、衍生欄位）", snap_after == snap_before, src2)
    qn = pg.psql(db, "SELECT count(*) FROM public.class_sessions_quarantine")
    check("99 還原：隔離區清空、暫存表保留", qn == "0"
          and pg.psql(db, "SELECT count(*) FROM public.salary_master_rows WHERE imported_at IS NULL") == "5535")
    pg.psql(db, file=HERE / "03_apply.sql")
    post2 = pg.json(db, HERE / "04_postcheck.sql")
    check("還原後可再次執行 03，結果與第一次相同", post2["quarantine"] == post["quarantine"]
          and post2["class_sessions_by_source"] == post["class_sessions_by_source"])
    return post


def main():
    if not UPLOAD_CSV.exists():
        sys.exit("先跑 build_upload_csv.py 產生上傳檔")
    pg = PG()
    try:
        a = rehearse(pg, "A", null_empty=False)
        b = rehearse(pg, "B", null_empty=True)
        check("兩種上傳情境結果一致", a["quarantine"] == b["quarantine"] and a["instructor_match"] == b["instructor_match"]
              and a["anomaly_now"] == b["anomaly_now"])
    finally:
        pg.close()
    failed = [l for l, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} PASS")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
