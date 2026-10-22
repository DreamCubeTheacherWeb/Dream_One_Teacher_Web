"""
總表匯入「其他」課程重新分類｜本機演練（臨時 PostgreSQL，跑完即刪，不連線上）

1. 用 rehearse_local.py 的做法建出 10/19 晚上的正式庫狀態：舊匯入 9,532 筆 → migration → 上傳暫存表
   → 03 搬移＋匯入 → 05 推估更正；跑 07_inspect_imported_other.sql，逐格對照「直接讀上傳 CSV 算的數字」（兩邊算法獨立）
2. 再套 10/20 上午正式庫已執行的 extra_fields 欄位 → 20261020150000 新異常規則 → 06 去重＋9/26 前標已付款，
   07 再對照一次（CSV 端同樣套去重與標已付款）
3. 08 楓葉體驗課改體驗課：四種異常情境必須擋下且資料逐欄不動；成功後整張表只差課程類型（連更新時間、異常標記
   都不變）、trigger 都已恢復且有作用；重跑不做任何事；08 之後跑 96 仍能完整撤回 06；98 還原後逐欄回到 08 之前
   且可重跑；還原後可再套 08；06 之前的狀態（12 筆）也能正確執行

用法：python3 -I scripts/salary_master_import/rehearse_reclassify_other.py
上傳 CSV 預設找 <repo>/data-private/salary_master_rows_upload.csv，不在就用環境變數 SALARY_UPLOAD_CSV 指定。
"""
import collections
import csv
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PORT = "54331"  # 與 rehearse_local.py（54329）錯開，兩支可同時跑


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


RL = load("rehearse_local")
F = load("build_inferred_fixes")
UPLOAD_CSV = Path(os.environ.get("SALARY_UPLOAD_CSV") or (ROOT / "data-private" / "salary_master_rows_upload.csv"))
RL.UPLOAD_CSV = F.UPLOAD = UPLOAD_CSV
ENV = RL.ENV
RESULTS = []


def check(label, ok, detail=""):
    RESULTS.append((label, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {label}{('  ' + str(detail)) if detail != '' else ''}")


class PG(RL.PG):
    """與 rehearse_local.PG 相同，只換 port。"""

    def __init__(self):
        if subprocess.run(["lsof", f"-iTCP:{PORT}", "-sTCP:LISTEN"], capture_output=True).stdout:
            raise RuntimeError(f"port {PORT} 已被占用，先確認是誰在用")
        self.dir = Path(tempfile.mkdtemp(prefix="reclassify-other-rehearsal-", dir=os.environ.get("TMPDIR")))
        subprocess.run(["initdb", "-D", str(self.dir / "data"), "-A", "trust", "-U", "postgres",
                        "--no-locale", "-E", "UTF8"], check=True, env=ENV, capture_output=True)
        self.proc = subprocess.Popen(
            ["postgres", "-D", str(self.dir / "data"), "-k", str(self.dir), "-p", PORT,
             "-c", "listen_addresses=", "-c", "fsync=off"],
            env=ENV, stdout=subprocess.DEVNULL, stderr=open(self.dir / "pg.log", "w"))
        for _ in range(100):
            if subprocess.run(["pg_isready", "-h", str(self.dir), "-p", PORT], env=ENV,
                              capture_output=True).returncode == 0:
                return
            time.sleep(0.1)
        raise RuntimeError("PostgreSQL did not start:\n" + (self.dir / "pg.log").read_text())

    def psql(self, db, sql=None, file=None, expect_fail=False, raw=False, sep=None):
        args = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", str(self.dir), "-p", PORT,
                "-U", "postgres", "-d", db, "-t", "-A"]
        if sep:
            args += ["-F", sep]
        args += ["-f", str(file)] if file else ["-c", sql]
        r = subprocess.run(args, env=ENV, capture_output=True, text=True, cwd=str(RL.APP / "supabase"))
        if expect_fail:
            return r
        if r.returncode != 0:
            raise RuntimeError(f"psql failed ({file or sql[:80]}):\n{r.stderr}")
        return r if raw else r.stdout.strip()


def build_production_like(pg, db):
    RL.build_db(pg, db, False)
    pg.psql(db, file=RL.APP / "supabase" / "migrations" / "20261019120000_salary_master_quarantine.sql")
    RL.load_upload(pg, db, False)
    pg.psql(db, file=HERE / "03_apply.sql")
    pg.psql(db, file=HERE / "05_apply_inferred_fixes.sql")


RAW_COLS = [c for _, c in RL.B.RAW_COLS]
MIG_ANOMALY = RL.APP / "supabase" / "migrations" / "20261020150000_salary_anomaly_exact_duplicates.sql"
APPLY = HERE / "08_reclassify_maple_trial.sql"
ROLLBACK = HERE / "98_rollback_reclassify_maple_trial.sql"
MAPLE = ("SELECT cs.course_type FROM public.salary_master_rows m JOIN public.class_sessions cs "
         "ON cs.id = m.class_session_id WHERE m.batch = '2026-10-19' AND btrim(m.raw_course_kind) = '楓葉體驗課'")
EXCLUDE = "'course_type'"
FULL_SQL = "SELECT md5(string_agg(to_jsonb(cs)::text, E'\\n' ORDER BY cs.id)) FROM public.class_sessions cs"
MINUS_SQL = f"SELECT md5(string_agg((to_jsonb(cs) - {EXCLUDE})::text, E'\\n' ORDER BY cs.id)) FROM public.class_sessions cs"
REST_SQL = FULL_SQL + f" WHERE cs.id NOT IN (SELECT m.class_session_id FROM public.salary_master_rows m " \
           f"WHERE m.batch = '2026-10-19' AND btrim(m.raw_course_kind) = '楓葉體驗課')"
ANOMALY_SQL = ("SELECT coalesce(string_agg(cs.id || ':' || cs.is_anomaly || ':' || cs.anomaly_reasons::text, ',' ORDER BY cs.id), '') "
               "FROM public.class_sessions cs")
TRIG_SQL = ("SELECT string_agg(tgname || '=' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger "
            "WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal")
MONEY_SQL = ("SELECT count(*) || '/' || sum(base_salary) || '/' || sum(bonus) || '/' || sum(total_salary) || '/' || "
             "sum(paid_amount) || '/' || count(*) FILTER (WHERE status = 'paid') || '/' || "
             "count(*) FILTER (WHERE status = 'approved') || '/' || count(*) FILTER (WHERE status = 'pending') "
             "FROM public.class_sessions")


def expected_from_csv(post06=False):
    """不經資料庫，直接從上傳 CSV 算出 07 應有的數字（套上 05 的日期推估；post06 再套 06 的去重與 9/26 前標已付款）。"""
    date_fix = {str(n): new for n, field, _, _, _, new, _ in F.build() if field == "session_date"}
    rows = sorted(csv.DictReader(open(UPLOAD_CSV, encoding="utf-8")), key=lambda x: int(x["row_no"]))
    for r in rows:
        r["session_date"] = date_fix.get(r["row_no"], r["session_date"])
    if post06:
        seen, kept = set(), []
        for r in rows:
            k = tuple(r[c] for c in RAW_COLS)
            if k not in seen:
                seen.add(k)
                kept.append(r)
        rows = kept
        for r in rows:
            if r["status"] == "approved" and r["session_date"] < "2026-09-26":
                r["status"] = "paid"
                r["paid_amount"] = str(float(r["base_salary"] or 0) + float(r["bonus"] or 0))
    other = [r for r in rows if r["course_type"] == "other"]
    cur = [r for r in other if r["session_date"] >= "2026-01-01"]

    def agg(items):
        f = lambda k: round(sum(float(r[k] or 0) for r in items), 2)
        st = collections.Counter(r["status"] for r in items)
        return {"rows": len(items), "instructors": len({r["instructor_name"] for r in items}),
                "base": f("base_salary"), "bonus": f("bonus"), "paid": f("paid_amount"),
                "pending": st["pending"], "approved": st["approved"], "paid_st": st["paid"],
                "range": f"{min(r['session_date'] for r in items)}～{max(r['session_date'] for r in items)}"}

    by_kind = collections.defaultdict(list)
    for r in cur:
        by_kind[r["raw_course_kind"].strip() or "（總表空白）"].append(r)
    sec1 = {k: agg(v) for k, v in by_kind.items()}
    sec1["＝ 合計"] = agg(cur)
    by_name = collections.defaultdict(list)
    for r in cur:
        if r["raw_course_kind"].strip() == "其他":
            by_name[r["course_name"].strip() or "（無課程名稱）"].append(r)
    sec2 = {k: agg(v) for k, v in by_name.items()}
    return sec1, sec2, len(other) - len(cur), 5535


def run_inspect(pg, db):
    sep = "\x1f"
    out = pg.psql(db, file=HERE / "07_inspect_imported_other.sql", sep=sep)
    table = [line.split(sep) for line in out.splitlines() if line]
    sections = collections.defaultdict(dict)
    for row in table:
        sections[row[0]][row[1]] = row
    return table, sections


def same(row, exp):
    num = lambda s: round(float(s), 2) if s != "" else None
    got = {"rows": int(row[2]), "instructors": int(row[3]), "base": num(row[4]), "bonus": num(row[5]),
           "paid": num(row[6]), "pending": int(row[7]), "approved": int(row[8]), "paid_st": int(row[9]),
           "range": row[10]}
    return got == exp, got


def check_inspect(pg, db, label, post06):
    sec1_exp, sec2_exp, pre2026, staged = expected_from_csv(post06)
    table, sec = run_inspect(pg, db)
    s1, s2, s3 = sec.get("1 依總表原始課程種類", {}), sec.get("2 總表寫「其他」的課程名稱", {}), sec.get("3 檢查", {})
    check(f"[{label}] 07 區塊 1：分組項目與 CSV 相同", set(s1) == set(sec1_exp), sorted(set(s1) ^ set(sec1_exp)))
    for k, exp in sorted(sec1_exp.items()):
        ok, got = same(s1[k], exp) if k in s1 else (False, None)
        check(f"[{label}] 07 區塊 1「{k}」數字與 CSV 相同", ok,
              got if not ok else f"{exp['rows']} 筆、薪資 {exp['base']:.0f}、已付款 {exp['paid_st']} 筆")
    check(f"[{label}] 07 區塊 2：課程名稱項目與 CSV 相同", set(s2) == set(sec2_exp), sorted(set(s2) ^ set(sec2_exp)))
    bad2 = [k for k, exp in sec2_exp.items() if k not in s2 or not same(s2[k], exp)[0]]
    check(f"[{label}] 07 區塊 2：{len(sec2_exp)} 個課程名稱數字全部相同", not bad2, bad2[:5])
    vals = {k: int(v[2]) for k, v in s3.items()}
    check(f"[{label}] 07 區塊 3：類型被改過 0、非 legacy 0、對不到暫存列 0、2026 前與暫存列筆數相同",
          vals.get("匯入後課程類型已被改過的總表列（2026 起）") == 0
          and vals.get("上面「其他」列中 pricing_status 不是 legacy") == 0
          and vals.get("上面「其他」列中對不到總表暫存列") == 0
          and vals.get("2026 年以前的總表「其他」列（講師端看不到）") == pre2026
          and vals.get("總表暫存列筆數（batch 2026-10-19）") == staged, vals)
    snap = pg.psql(db, FULL_SQL)
    pg.psql(db, file=HERE / "07_inspect_imported_other.sql")
    check(f"[{label}] 07 是唯讀：再跑一次後 class_sessions 逐欄不變", pg.psql(db, FULL_SQL) == snap)
    return table


def clone(pg, src, name):
    pg.psql("postgres", f"CREATE DATABASE {name} TEMPLATE {src}")
    return name


def maple_types(pg, db):
    return collections.Counter(pg.psql(db, MAPLE).split())


def blocked(pg, db, label, setup_sql, expect_text):
    c = clone(pg, db, f"blk_{len(RESULTS)}")
    pg.psql(c, setup_sql)
    before = pg.psql(c, FULL_SQL)
    r = pg.psql(c, file=APPLY, expect_fail=True)
    check(label, r.returncode != 0 and expect_text in r.stderr and pg.psql(c, FULL_SQL) == before,
          r.stderr.strip().splitlines()[-1][-90:] if r.stderr.strip() else r.returncode)


def rehearse_apply(pg, db, label, expect_n):
    full0, minus0, rest0, anom0, money0, trig0 = (pg.psql(db, s) for s in (FULL_SQL, MINUS_SQL, REST_SQL, ANOMALY_SQL, MONEY_SQL, TRIG_SQL))
    check(f"[{label}] 執行前三個 trigger 都是啟用狀態", trig0.count("=O") == 3, trig0)
    r = pg.psql(db, file=APPLY, raw=True)
    check(f"[{label}] 08 執行成功", r.returncode == 0, r.stderr.strip()[-120:])
    check(f"[{label}] 08 結果摘要顯示 trial {expect_n} 筆", f"08 楓葉體驗課|trial|{expect_n}|" in r.stdout, r.stdout.strip())
    t = maple_types(pg, db)
    check(f"[{label}] 楓葉體驗課 {expect_n} 筆都是 trial、沒有 other", t == {"trial": expect_n}, dict(t))
    check(f"[{label}] 除了課程類型，整張表逐欄不變（含楓葉列的更新時間、異常標記）", pg.psql(db, MINUS_SQL) == minus0)
    check(f"[{label}] 三個 trigger 都已恢復啟用", pg.psql(db, TRIG_SQL) == trig0, pg.psql(db, TRIG_SQL))
    check(f"[{label}] 楓葉以外的列連更新時間都不變", pg.psql(db, REST_SQL) == rest0)
    check(f"[{label}] 整張表筆數、薪資、獎金、總計、已領、各狀態筆數不變", pg.psql(db, MONEY_SQL) == money0, money0)
    flips = sum(a != b for a, b in zip(anom0.split(","), pg.psql(db, ANOMALY_SQL).split(",")))
    check(f"[{label}] 異常標記 0 筆變動", flips == 0, flips)
    probe = pg.psql(db, "BEGIN; UPDATE public.class_sessions SET notes = notes WHERE id = (SELECT class_session_id "
                        "FROM public.salary_master_rows WHERE row_no = '2533') RETURNING updated_at > now() - interval '1 minute'; ROLLBACK;")
    check(f"[{label}] 恢復後更新時間 trigger 真的有作用（試改一筆，交易回滾）", probe.strip().startswith("t"), probe)
    full1 = pg.psql(db, FULL_SQL)
    r2 = pg.psql(db, file=APPLY, raw=True)
    check(f"[{label}] 08 重跑：不做任何變更（連更新時間都不動）", r2.returncode == 0 and pg.psql(db, FULL_SQL) == full1
          and "已經是體驗課" in r2.stderr, r2.stderr.strip()[-80:])
    return full0, minus0, anom0, money0


def main():
    if not UPLOAD_CSV.exists():
        sys.exit(f"找不到上傳 CSV：{UPLOAD_CSV}（用 SALARY_UPLOAD_CSV 指定）")
    pg = PG()
    try:
        db = "reclassify_other"
        build_production_like(pg, db)
        check("模擬 10/19 晚上狀態：總表匯入 5,535 筆", pg.psql(db, "SELECT count(*) FROM public.class_sessions "
                                                       "WHERE source = 'historical_import'") == "5535")
        check_inspect(pg, db, "10/19 狀態", post06=False)
        pre06 = clone(pg, db, "pre06")

        # 正式庫 10/20 上午 11:05 已套：extra_fields 欄位（20261020130000）→ 新異常規則 → 06 去重＋9/26 前標已付款
        pg.psql(db, "ALTER TABLE public.class_sessions ADD COLUMN IF NOT EXISTS extra_fields jsonb")
        pg.psql(db, file=MIG_ANOMALY)
        pg.psql(db, file=HERE / "06_dedupe_and_mark_paid.sql")
        check("模擬正式庫現況：06 後總表 5,444 筆", pg.psql(db, "SELECT count(*) FROM public.class_sessions "
                                                   "WHERE source = 'historical_import'") == "5444")
        table = check_inspect(pg, db, "正式庫現況", post06=True)
        check("正式庫現況：楓葉體驗課剩 11 筆 other（第 2543 列在隔離區）", maple_types(pg, db) == {"other": 11}
              and pg.psql(db, "SELECT count(*) FROM public.class_sessions_quarantine q JOIN public.salary_master_rows m "
                              "ON m.class_session_id = q.id WHERE m.row_no = '2543'") == "1")

        blocked(pg, db, "擋下：class_sessions 有版控外的 trigger，資料不動",
                "CREATE FUNCTION public._fake() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; "
                "CREATE TRIGGER trg_fake_notify AFTER UPDATE ON public.class_sessions FOR EACH ROW EXECUTE FUNCTION public._fake()",
                "trg_fake_notify")
        blocked(pg, db, "擋下：執行前有 trigger 被關掉（不會默默打開），資料不動",
                "ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly", "不是啟用狀態")
        blocked(pg, db, "擋下：有一筆楓葉被改成人工定價（非 legacy），資料不動",
                "UPDATE public.class_sessions SET pricing_status = 'manual_override', manual_adjustment_reason = 'test' "
                "WHERE id = (SELECT class_session_id FROM public.salary_master_rows WHERE row_no = '2533')",
                "定價狀態不是 legacy")
        blocked(pg, db, "擋下：有一筆楓葉已被改成別的課程類型，資料不動",
                "UPDATE public.class_sessions SET course_type = 'camp' "
                "WHERE id = (SELECT class_session_id FROM public.salary_master_rows WHERE row_no = '2533')",
                "已被改成其他課程類型")
        blocked(pg, db, "擋下：有一列楓葉既不在 class_sessions 也不在隔離區，資料不動",
                "DELETE FROM public.class_sessions WHERE id = (SELECT class_session_id FROM public.salary_master_rows "
                "WHERE row_no = '2533')", "既不在 class_sessions 也不在隔離區")

        clone(pg, db, "pre_apply")
        full0, minus0, anom0, money0 = rehearse_apply(pg, db, "正式庫現況", 11)
        # 審查必修項：08 之後若要撤回 06，96 必須仍能完整還原這 11 筆的付款狀態（不能把它們當成 06 之後被改過）
        c96 = clone(pg, db, "after08_rollback06")
        r = pg.psql(c96, file=HERE / "96_rollback_dedupe_and_mark_paid.sql", raw=True, expect_fail=True)
        st = pg.psql(c96, "SELECT count(*) || '/' || count(*) FILTER (WHERE cs.status = 'approved' AND cs.paid_amount = 0 "
                          "AND cs.paid_at IS NULL) || '/' || count(*) FILTER (WHERE cs.course_type = 'trial') "
                          "FROM public.salary_master_rows m JOIN public.class_sessions cs ON cs.id = m.class_session_id "
                          "WHERE m.batch = '2026-10-19' AND btrim(m.raw_course_kind) = '楓葉體驗課'")
        check("08 之後跑 96（預設模式）仍成功：楓葉 12 筆都回到 06 前的未付款，課程類型維持體驗課",
              r.returncode == 0 and "略過 0 筆" in r.stderr and st == "12/12/11", (st, r.stderr.strip()[-120:]))
        pg.psql(c96, file=APPLY)
        check("96 之後再跑一次 08：搬回的第 2543 列也改成體驗課（12 筆 trial）", maple_types(pg, c96) == {"trial": 12},
              dict(maple_types(pg, c96)))
        # 反向對照：審查前的寫法（不暫停 trigger、比對時放過 updated_at／異常標記），08 之後 96 會被擋
        old = APPLY.read_text(encoding="utf-8")
        for line in ("  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_class_sessions_updated_at;\n",
                     "  ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;\n"):
            assert old.count(line) == 1
            old = old.replace(line, "")
        assert old.count("(to_jsonb(cs) - 'course_type')") == 2
        old = old.replace("(to_jsonb(cs) - 'course_type')",
                          "(to_jsonb(cs) - ARRAY['course_type', 'updated_at', 'is_anomaly', 'anomaly_reasons'])")
        old_path = pg.dir / "08_before_review.sql"
        old_path.write_text(old, encoding="utf-8")
        cold = clone(pg, "pre_apply", "old08_rollback06")
        pg.psql(cold, file=old_path)
        r = pg.psql(cold, file=HERE / "96_rollback_dedupe_and_mark_paid.sql", raw=True, expect_fail=True)
        check("反向對照：審查前的 08（會改到更新時間）之後跑 96 會被擋「06 之後有 11 筆被改過」",
              r.returncode != 0 and "06 之後有 11 筆被改過" in r.stderr, r.stderr.strip()[-100:])
        after = run_inspect(pg, db)[1]
        s1 = after["1 依總表原始課程種類"]
        before_total = next(int(r[2]) for r in table if r[1] == "＝ 合計")
        check("08 後 07 區塊 1：楓葉體驗課不再出現、合計少 11 筆", "楓葉體驗課" not in s1
              and int(s1["＝ 合計"][2]) == before_total - 11, (before_total, s1["＝ 合計"][2]))

        r = pg.psql(db, file=ROLLBACK, raw=True)
        check("98 還原執行成功、摘要顯示 other 11 筆", r.returncode == 0 and "98 還原楓葉體驗課|other|11|" in r.stdout,
              (r.stdout.strip(), r.stderr.strip()[-120:]))
        check("98 還原後：整張表逐欄回到 08 之前（含更新時間、異常標記）、trigger 都已恢復",
              pg.psql(db, FULL_SQL) == full0 and pg.psql(db, TRIG_SQL).count("=O") == 3)
        full_rb = pg.psql(db, FULL_SQL)
        r = pg.psql(db, file=ROLLBACK, raw=True)
        check("98 重跑：不做任何變更", r.returncode == 0 and pg.psql(db, FULL_SQL) == full_rb and "已經是「其他」" in r.stderr)
        r = pg.psql(db, file=APPLY, raw=True)
        check("還原後可再次執行 08", r.returncode == 0 and maple_types(pg, db) == {"trial": 11})

        rehearse_apply(pg, pre06, "06 之前的狀態", 12)
    finally:
        pg.close()
    failed = [l for l, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} PASS")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
