# scripts/ — 資料匯入與排程工具

前端建置與 Zeabur 部署**不依賴**這個資料夾；但其中 `wca-sync/` 是正在運作的排程，不能刪。
（前端的驗證腳本在 `培訓web/scripts/`，不在這裡。）

## 正在使用
- `wca-sync/sync.mjs` — WCA 成績自動同步。由 `.github/workflows/wca-sync.yml` 排程執行
  （每逢單數月 1 號 03:00 UTC ≈ 台北 11:00），不要手動改它的輸入輸出格式。

## 一次性工具（保留作為「資料當初怎麼進去的」紀錄，平常不會再跑）
- 2026-07 講師資料與薪資歷史初次匯入（依序）：
  1. `merge_instructors.py` — 合併「老師資料表」與「表單回應」兩份 CSV，產出
     `instructors_merged_preview.json`（中間檔，已被 .gitignore 忽略）
  2. `import_instructors.py` — 把合併後的講師資料寫入 Supabase `instructors` 表
  3. `import_salary_history.py` — 匯入薪資歷史
  4. `generate_rate_card_seed.py` — 產出 `seed_rate_card.sql`（費率種子）
  5. `push_rate_card.py` — 把費率推進 Supabase
- `instructor_data_reconciliation.py`（＋`test_…`）— 講師資料核對規則；新講師建檔沿用它（見 repo 根 STATUS.md 2026-10-19 段）。
- `salary_master_import/` — 2026-10-19 薪資總表換新：01→04 依序執行、05 套推估更正，`95_`／`99_` 是還原腳本。
- `course-first-station/` — 2026-07 第一站課程重建（含當時的區塊備份 JSON，還原用）。
- `mobile-verify/` — 2026-07 手機版驗證工具（用法見其 README）。

## ⚠️ 使用注意
- 匯入類腳本用 **service_role key**（從環境變數讀，非硬編碼）直連 Supabase，權限極高，
  會**繞過所有 RLS**。只有在明確要重跑匯入時才碰，跑完應輪換 key。
- 來源 CSV 含真人個資（身分證、聯絡方式、薪資），已被根 `.gitignore` 排除，不進版控。
- 若要再次匯入，先在測試資料上跑，逐筆查回比對後再對正式庫執行（見全域準則）。
