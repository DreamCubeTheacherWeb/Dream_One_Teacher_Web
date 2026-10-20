"""
2026-10-20 去重＋標已付款｜本機演練（臨時 PostgreSQL，跑完即刪，不連線上）

1. 沿用 rehearse_local.py 建出與正式庫相同的狀態：5 月舊匯入 → 03 換新總表 → 05 二十五筆推估更正，
   另有 3 筆網站端紀錄（必須全程不受影響），並補上 20261020130000 新增的 extra_fields 欄。
2. 沒套新 migration 就跑 06 → 必須被擋；套 migration 兩次 → 預演模式 06 必須拋 DRY_RUN_OK 且資料不動
   → 正式 06 → 逐項核對 → 重跑 06 必須被擋 → 新規則行為測試 → 權限 → 96 還原（必須與套 migration 前逐欄相同）
   → 再套一次 migration＋06（還原後可重來）。
兩種上傳情境各跑一輪：空白欄是空字串（A）、空白欄變 NULL（B）。
用法：python3 -I scripts/salary_master_import/rehearse_dedupe_paid.py
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("rehearse_local", HERE / "rehearse_local.py")
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
check = R.check

MIG = R.APP / "supabase" / "migrations" / "20261020150000_salary_anomaly_exact_duplicates.sql"
APPLY = HERE / "06_dedupe_and_mark_paid.sql"
ROLLBACK = HERE / "96_rollback_dedupe_and_mark_paid.sql"
OLD_RULE = HERE / "97_restore_old_anomaly_rule.sql"
QB = "2026-10-20 完全相同重複列（業主指示只留一筆）"

STATE_SQL = f"""
SELECT md5(coalesce((SELECT string_agg(t::text, E'\\n' ORDER BY t::text) FROM (SELECT * FROM public.class_sessions) t), ''))
    || '/' || (SELECT count(*) FROM public.class_sessions_quarantine WHERE quarantine_batch = '{QB}')
    || '/' || md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.detect_session_anomaly()'::regprocedure))
    || '/' || coalesce(to_regclass('public.salary_cleanup_20261020_backup')::text, 'no-backup')
"""
WEB_SQL = """
SELECT md5(string_agg(t::text, E'\\n' ORDER BY t::text))
  FROM (SELECT * FROM public.class_sessions WHERE source <> 'historical_import') t
"""
HIST_SQL = """
SELECT json_build_object(
  'n', count(*), 'total', sum(total_salary),
  'paid_n', count(*) FILTER (WHERE status = 'paid'), 'paid_sum', sum(paid_amount) FILTER (WHERE status = 'paid'),
  'unpaid_n', count(*) FILTER (WHERE status <> 'paid'), 'unpaid_sum', sum(total_salary) FILTER (WHERE status <> 'paid'),
  'unpaid_min_date', min(session_date) FILTER (WHERE status <> 'paid'),
  'paid_max_date', max(session_date) FILTER (WHERE status = 'paid'),
  'anomaly', count(*) FILTER (WHERE is_anomaly),
  'paid_amount_mismatch', count(*) FILTER (WHERE status = 'paid' AND paid_amount <> total_salary),
  'paid_at_null', count(*) FILTER (WHERE status = 'paid' AND paid_at IS NULL)
) FROM public.class_sessions WHERE source = 'historical_import'
"""


def prepare(pg, label, null_empty):
    db = f"dedupe_{label.lower()}"
    R.build_db(pg, db, null_empty)
    pg.psql(db, file=R.APP / "supabase" / "migrations" / "20261019120000_salary_master_quarantine.sql")
    R.load_upload(pg, db, null_empty)
    pg.psql(db, file=HERE / "03_apply.sql")
    pg.psql(db, file=HERE / "05_apply_inferred_fixes.sql")
    # 20261020130000 對 class_sessions 只加了 extra_fields（正式庫已套）；隔離區沒有這欄
    pg.psql(db, "ALTER TABLE public.class_sessions ADD COLUMN IF NOT EXISTS extra_fields jsonb")
    return db


def with_mode(pg, path, line_old, line_new, name):
    text = path.read_text(encoding="utf-8")
    assert text.count(line_old) == 1, line_old
    out = pg.dir / name
    out.write_text(text.replace(line_old, line_new), encoding="utf-8")
    return out


def clone(pg, src, name):
    pg.psql("postgres", f"CREATE DATABASE {name} TEMPLATE {src}")
    return name


def as_role(pg, db, role, sql):
    return pg.psql(db, f"BEGIN; SET LOCAL ROLE {role}; {sql}; ROLLBACK;", expect_fail=True)


def rehearse(pg, label, null_empty):
    print(f"\n══ 情境 {label}：空白欄 {'變 NULL' if null_empty else '為空字串'} ══")
    db = prepare(pg, label, null_empty)
    before = pg.psql(db, "SELECT count(*) || '/' || sum(total_salary) || '/' || count(*) FILTER (WHERE status = 'paid') "
                         "|| '/' || count(*) FILTER (WHERE is_anomaly) FROM public.class_sessions WHERE source = 'historical_import'")
    n, total, paid, anomaly = before.split("/")
    check("模擬正式庫：總表 5,535 筆、總計 10,724,608、已付款 3 筆",
          (int(n), float(total), int(paid)) == (5535, 10724608, 3), before)
    print(f"      （舊規則下異常 {anomaly} 筆；正式庫畫面為 481，差異來自本機講師名單與正式庫不同）")
    web0 = pg.psql(db, WEB_SQL)
    s_pre = pg.psql(db, STATE_SQL)

    r = pg.psql(db, file=APPLY, expect_fail=True)
    check("沒套新 migration 就跑 06 會被擋、資料不動",
          r.returncode != 0 and "請先套用 migration" in r.stderr and pg.psql(db, STATE_SQL) == s_pre, r.stderr.strip()[-80:])

    pg.psql(db, file=MIG)
    pg.psql(db, file=MIG)
    check("新 migration 連跑兩次無誤", True)
    s_mig = pg.psql(db, STATE_SQL)

    pg.psql(db, "CREATE FUNCTION public._fake_notify() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; "
                "CREATE TRIGGER trg_fake_paid_notify AFTER UPDATE ON public.class_sessions "
                "FOR EACH ROW EXECUTE FUNCTION public._fake_notify()")
    r = pg.psql(db, file=APPLY, expect_fail=True)
    pg.psql(db, "DROP TRIGGER trg_fake_paid_notify ON public.class_sessions; DROP FUNCTION public._fake_notify()")
    check("正式庫若有版控外的 trigger（例如發通知）06 會停下、資料不動",
          r.returncode != 0 and "trg_fake_paid_notify" in r.stderr and pg.psql(db, STATE_SQL) == s_mig,
          r.stderr.strip()[-80:])

    c = clone(pg, db, f"{db}_fk")
    pg.psql(c, "CREATE TABLE public._child (id serial PRIMARY KEY, cs uuid REFERENCES public.class_sessions(id) ON DELETE CASCADE)")
    s_c = pg.psql(c, STATE_SQL)
    r = pg.psql(c, file=APPLY, expect_fail=True)
    check("有外鍵指向 class_sessions 時 06 會停下、資料不動",
          r.returncode != 0 and "有外鍵指向 class_sessions" in r.stderr and pg.psql(c, STATE_SQL) == s_c, r.stderr.strip()[-80:])

    c = clone(pg, db, f"{db}_old_rule")
    pg.psql(c, file=OLD_RULE)
    check("97 可單獨換回舊規則（migration 套了但 06 沒跑時）、資料不動", pg.psql(c, STATE_SQL) == s_pre)

    dry = pg.dir / f"{db}_dry.sql"
    text = APPLY.read_text(encoding="utf-8")
    marker = "SELECT set_config('salary_cleanup.mode', 'apply', true);"
    assert text.count(marker) == 1
    dry.write_text(text.replace(marker, marker.replace("'apply'", "'dry-run'")), encoding="utf-8")
    r = pg.psql(db, file=dry, expect_fail=True)
    check("預演模式：拋出 DRY_RUN_OK 且資料完全不動", r.returncode != 0 and "DRY_RUN_OK" in r.stderr
          and pg.psql(db, STATE_SQL) == s_mig, r.stderr.strip()[-160:])

    r = pg.psql(db, file=APPLY, raw=True)
    check("06 正式執行成功（APPLY_OK）", "APPLY_OK" in r.stderr, r.stderr.strip()[-200:])

    h = json.loads(pg.psql(db, HIST_SQL))
    check("總表 5,444 筆（少 91）、總計 10,649,987（少 74,621）", h["n"] == 5444 and float(h["total"]) == 10649987, h)
    check("已付款 5,438 筆、已付金額 10,642,401；每筆已付＝總計、都有付款時間",
          h["paid_n"] == 5438 and float(h["paid_sum"]) == 10642401 and h["paid_amount_mismatch"] == 0
          and h["paid_at_null"] == 3, h)
    check("未付款只剩 9/26 以後 6 筆、7,586 元；最晚的已付款在 9/26 之前",
          h["unpaid_n"] == 6 and float(h["unpaid_sum"]) == 7586 and h["unpaid_min_date"] >= "2026-09-26"
          and h["paid_max_date"] < "2026-09-26", h)
    flagged = pg.psql(db, "SELECT coalesce(string_agg(m.row_no, ',' ORDER BY m.row_no::int), '') FROM public.class_sessions cs "
                          "JOIN public.salary_master_rows m ON m.class_session_id = cs.id WHERE cs.is_anomaly")
    zeng = pg.psql(db, "SELECT count(*) FROM public.class_sessions cs JOIN public.salary_master_rows m ON m.class_session_id = cs.id "
                       "WHERE m.row_no IN ('3222', '3622') AND cs.instructor_id IS NOT NULL")
    check("異常只剩曾瑀希 2026/3/27 南瓜田兩筆（或講師未對應時 0 筆）",
          flagged == ("3222,3622" if zeng == "2" else ""), f"異常列號＝{flagged or '無'}（曾瑀希已對應 {zeng} 筆）")
    q = pg.psql(db, f"SELECT count(*) || '/' || count(DISTINCT matched_master_row_no) || '/' || sum(total_salary) "
                    f"|| '/' || count(*) FILTER (WHERE quarantine_reason LIKE '總表第 % 列與第 % 列完全相同%') "
                    f"FROM public.class_sessions_quarantine WHERE quarantine_batch = '{QB}'")
    qn, qk, qsum, qreason = q.split("/")
    check("隔離區本批 91 筆、對應 81 個留下的列、金額 74,621、原因有寫列號",
          (int(qn), int(qk), float(qsum), int(qreason)) == (91, 81, 74621, 91), q)
    kept = pg.psql(db, f"SELECT count(*) FROM public.class_sessions_quarantine q JOIN public.salary_master_rows m "
                       f"ON m.batch = '2026-10-19' AND m.row_no = q.matched_master_row_no "
                       f"JOIN public.class_sessions cs ON cs.id = m.class_session_id WHERE q.quarantine_batch = '{QB}'")
    check("每筆搬走的列，對應的留下那筆仍在正式資料中", kept == "91", kept)
    check("網站端紀錄完全不動", pg.psql(db, WEB_SQL) == web0)
    s_after = pg.psql(db, STATE_SQL)

    r = pg.psql(db, file=APPLY, expect_fail=True)
    check("06 重跑會被擋、資料不動", r.returncode != 0 and "已經執行過" in r.stderr and pg.psql(db, STATE_SQL) == s_after,
          r.stderr.strip()[-80:])

    # 新規則行為：講師重複送出一模一樣的回報 → 標異常；只差時數 → 不標；網站回報有時數沒薪資 → 照舊標
    rule = pg.psql(db, """
      BEGIN;
      CREATE TEMP TABLE _src ON COMMIT DROP AS SELECT * FROM public.class_sessions WHERE course_name = '網站回報 A';
      INSERT INTO public.class_sessions (course_type, instructor_id, instructor_name, session_date, duration_hours,
        base_salary, source, status, pricing_status, course_name)
      SELECT course_type, instructor_id, instructor_name, session_date, duration_hours, base_salary, source, status,
             pricing_status, course_name FROM _src
      UNION ALL
      SELECT course_type, instructor_id, instructor_name, session_date, duration_hours + 1, base_salary, source, status,
             pricing_status, course_name FROM _src
      UNION ALL
      SELECT course_type, instructor_id, instructor_name, session_date, 2, 0, source, status, pricing_status,
             '網站回報 零元' FROM _src;
      -- 合作課回報常不帶課程名：同日兩校各上一堂（其他都一樣）不算重複；同一校再送一次才算
      INSERT INTO public.class_sessions (course_type, instructor_id, instructor_name, session_date, duration_hours,
        base_salary, source, status, pricing_status, course_name, unit_name)
      SELECT 'collab_lead', instructor_id, instructor_name, session_date, 1, 600, 'self_report', 'pending', 'legacy', NULL, u
        FROM _src, unnest(ARRAY['甲國小', '乙國小', '乙國小']) WITH ORDINALITY AS t(u, o) ORDER BY o;
      SELECT string_agg(unit_name || '=' || is_anomaly, ' ' ORDER BY unit_name DESC, is_anomaly)
        FROM public.class_sessions WHERE unit_name IN ('甲國小', '乙國小');
      SELECT string_agg(course_name || '/' || duration_hours::float8 || 'h/' || base_salary::float8 || '=' || is_anomaly || ':'
                        || array_to_string(anomaly_reasons, '+'), ' | ' ORDER BY created_at, course_name, duration_hours, is_anomaly)
        FROM public.class_sessions WHERE course_name IN ('網站回報 A', '網站回報 零元');
      ROLLBACK;
    """)
    check("新規則：一模一樣的第二份回報會標「內容完全相同」",
          "網站回報 A/1.5h/450=true:同講師同日有內容完全相同的紀錄，可能重複登記" in rule
          and "網站回報 A/1.5h/450=false:" in rule, rule)
    check("新規則：同日同講師但時數不同的回報不會被標", "網站回報 A/2.5h/450=false:" in rule, rule)
    check("新規則：課名空白、同日不同合作單位不算重複；同單位再送一次才標",
          "甲國小=false 乙國小=false 乙國小=true" in rule, rule)
    check("新規則：網站回報有時數沒薪資照舊標異常（且不算重複）", "網站回報 零元/2h/0=true:有時數但薪資為 0 |" in rule + " |", rule)
    check("規則測試已撤銷、資料不動", pg.psql(db, STATE_SQL) == s_after)

    for role in ("authenticated", "anon"):
        r = as_role(pg, db, role, "SELECT count(*) FROM public.salary_cleanup_20261020_backup")
        check(f"權限：{role} 讀不到備份表", r.returncode != 0 and "permission denied" in r.stderr, r.stderr.strip()[-60:])

    rb_line = "SELECT set_config('salary_cleanup.rollback_mode', 'apply', true);"
    r = pg.psql(db, file=with_mode(pg, ROLLBACK, rb_line, rb_line.replace("'apply'", "'dry-run'"), f"{db}_rb_dry.sql"),
                expect_fail=True)
    check("96 預演：拋出 DRY_RUN_OK 且資料完全不動",
          r.returncode != 0 and "DRY_RUN_OK 搬回 91 筆" in r.stderr and pg.psql(db, STATE_SQL) == s_after,
          r.stderr.strip()[-120:])

    # 06 之後後台把一筆 9/26 以後的課標成已付款 → 96 預設停下；skip-changed 只略過那筆
    c = clone(pg, db, f"{db}_changed")
    pg.psql(c, "UPDATE public.class_sessions SET status = 'paid', paid_amount = total_salary, paid_at = now() "
               "WHERE id = (SELECT id FROM public.class_sessions WHERE source = 'historical_import' "
               "AND session_date >= DATE '2026-09-26' ORDER BY id LIMIT 1)")
    s_c = pg.psql(c, STATE_SQL)
    r = pg.psql(c, file=ROLLBACK, expect_fail=True)
    check("06 之後有人改過資料：96 預設整批停下、資料不動",
          r.returncode != 0 and "06 之後有 1 筆被改過" in r.stderr and pg.psql(c, STATE_SQL) == s_c, r.stderr.strip()[-100:])
    r = pg.psql(c, file=with_mode(pg, ROLLBACK, rb_line, rb_line.replace("'apply'", "'skip-changed'"), f"{db}_rb_skip.sql"),
                raw=True)
    after_skip = pg.psql(c, "SELECT count(*) || '/' || count(*) FILTER (WHERE status = 'paid') || '/' || "
                            "count(*) FILTER (WHERE status = 'paid' AND session_date >= DATE '2026-09-26') "
                            "FROM public.class_sessions WHERE source = 'historical_import'")
    check("skip-changed：其他列還原（5,535 筆、原本 3 筆已付款），後台後來標的那筆保持已付款",
          "略過 1 筆" in r.stderr and after_skip == "5535/4/1", f"{after_skip} {r.stderr.strip()[-80:]}")

    pg.psql(db, file=ROLLBACK)
    pg.psql(db, file=OLD_RULE)
    s_back = pg.psql(db, STATE_SQL)
    check("96＋97 還原後 class_sessions 逐欄相同、隔離區本批清空、舊異常規則換回、備份表已刪", s_back == s_pre,
          f"{s_back} vs {s_pre}")
    check("還原後網站端紀錄仍完全不動", pg.psql(db, WEB_SQL) == web0)

    pg.psql(db, file=MIG)
    r = pg.psql(db, file=APPLY, raw=True)
    h2 = json.loads(pg.psql(db, HIST_SQL))
    check("還原後可再次執行，結果與第一次相同",
          "APPLY_OK" in r.stderr and h2 == h, h2)
    return h


def main():
    if not R.UPLOAD_CSV.exists():
        sys.exit(f"找不到上傳檔 {R.UPLOAD_CSV}")
    pg = R.PG()
    try:
        a = rehearse(pg, "A", null_empty=False)
        b = rehearse(pg, "B", null_empty=True)
        check("兩種上傳情境結果一致", a == b)
    finally:
        pg.close()
    failed = [l for l, ok in R.RESULTS if not ok]
    print(f"\n{len(R.RESULTS) - len(failed)}/{len(R.RESULTS)} PASS")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
