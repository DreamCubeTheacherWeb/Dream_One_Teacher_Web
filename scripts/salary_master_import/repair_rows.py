"""
薪資總表換新 2026-10-19｜修補上傳時被弄壞的欄位

Supabase Table Editor 的「Import data from CSV」會把檔案切段讀取，切點落在中文字中間時，
那個字會變成 U+FFFD 亂碼（2026-10-19 實際發生 6 列各 1 欄）。這支程式依本機上傳檔產生
只修那幾格的 UPDATE（值用 dollar-quote，不需跳脫），貼進 SQL Editor 執行後再跑 02_check_upload.sql，
raw_checksum／derived_checksum 都要回到預期值、replacement_char_rows 為 0。

用法：python3 -I -B scripts/salary_master_import/repair_rows.py 645:raw_course_name 1255:raw_notes ...
"""
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UPLOAD = ROOT / "data-private" / "salary_master_rows_upload.csv"
ALLOWED = None  # 由上傳檔表頭決定


def build_sql(pairs, upload=UPLOAD):
    with open(upload, encoding="utf-8") as f:
        rows = {r["row_no"]: r for r in csv.DictReader(f)}
    cols = set(next(iter(rows.values())).keys()) - {"batch", "row_no"}
    lines = ["-- 薪資總表換新 2026-10-19｜修補上傳時被切壞的欄位（只動 salary_master_rows 暫存表）", "BEGIN;"]
    for pair in pairs:
        row_no, col = pair.split(":")
        if col not in cols or row_no not in rows:
            raise SystemExit(f"不認得的欄位或列號：{pair}")
        value = rows[row_no][col]
        if "$v$" in value:
            raise SystemExit(f"值含 $v$，請換 dollar-quote 標記：{pair}")
        lines.append(
            f"UPDATE public.salary_master_rows SET {col} = $v${value}$v$ "
            f"WHERE batch = '2026-10-19' AND row_no = '{row_no}' AND strpos(coalesce({col}, ''), chr(65533)) > 0;")
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.stdout.write(build_sql(sys.argv[1:]))
