# scripts/ — 一次性資料匯入工具

這批 Python 腳本是**一次性**的講師資料匯入工具，已完成階段性任務（把試算表裡的
講師名單與薪資歷史匯進 Supabase）。保留在這裡作為「資料當初怎麼進去的」參考文件，
平常不會再跑。日常開發與部署**不依賴**它們。

## 執行過的資料匯入管線（依序）
1. `merge_instructors.py` — 合併「老師資料表」與「表單回應」兩份 CSV，產出
   `instructors_merged_preview.json`（中間檔，已被 .gitignore 忽略）
2. `import_instructors.py` — 把合併後的講師資料寫入 Supabase `instructors` 表
3. `import_salary_history.py` — 匯入薪資歷史
4. `generate_rate_card_seed.py` — 產出 `seed_rate_card.sql`（費率種子）
5. `push_rate_card.py` — 把費率推進 Supabase

## ⚠️ 使用注意
- 這些腳本用 **service_role key**（從環境變數讀，非硬編碼）直連 Supabase，權限極高，
  會**繞過所有 RLS**。只有在明確要重跑匯入時才碰，跑完應輪換 key。
- 來源 CSV 含真人個資（身分證、聯絡方式、薪資），已被根 `.gitignore` 排除，不進版控。
- 若要再次匯入，先在測試資料上跑，逐筆查回比對後再對正式庫執行（見全域準則）。
