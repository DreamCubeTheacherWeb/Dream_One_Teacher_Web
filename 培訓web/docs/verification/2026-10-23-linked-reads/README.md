# 2026-10-23 資安審查修正（第一輪「必修 1、建議 5」＋第二輪「必修 1、建議 3」）的驗證輸出

分支 `fix/esign-owner-decisions`（已合併 origin/main `20654ec`）。全部在本機隔離 PostgreSQL／假 Supabase／mock 上跑，正式庫一筆都沒動。
以下是第二輪修完後（HEAD 見 STATUS.md）重跑的結果。

| 檔案 | 指令 | 結果 |
|---|---|---|
| verify-claim-activation-esign.txt | `node scripts/verify-claim-activation-esign.mjs` | 365/365 PASS |
| verify-claim-activation-esign-production-order.txt | 同上，加 `E2E_MIGRATION_ORDER`＝正式庫順序（…→140000→233000→100000→120000→20261023100000） | 365/365 PASS |
| mutation-drop-role-check.txt | `--mutate=drop-role-check`（拿掉 20261023100000 的角色條件） | 353/365，12 項 FAIL（pending 綁定者讀得到上課、報酬、統計、排行榜、徽章、影像；底版比對也抓到） |
| mutation-drop-claim-records-check.txt | `--mutate=drop-claim-records-check`（拿掉「已有紀錄的空位不能姓名認領」） | 362/365，3 項 FAIL |
| mutation-v2-hide-base.txt | `--mutate=v2-hide-base`（v2 改用 2026-07-09_leaderboard_hide.sql 當底版） | 363/365，2 項 FAIL（底版比對、teacher 的線上／速解／幼兒三類沒資料） |
| mutation-old-otp-lockout-count.txt | `--mutate=old-otp-lockout-count`（暫停寄碼改回「只算錯滿 5 次的組數」） | 361/365，4 項 FAIL（每組錯 4 次換碼 4 輪沒被暫停） |
| verify-esign-production-order.txt | `npm run verify:esign-production-order`（primary／variant 兩種順序） | 70/70 PASS |
| verify-payout-bank-export-browser.txt | `node scripts/verify-payout-bank-export-browser.mjs`（含第 7 段：帳號未啟用的講師不匯） | 131/131 PASS |
| verify-salary-sessions-paid-browser.txt | `node scripts/verify-salary-sessions-paid-browser.mjs` | 57/57 PASS |
| verify-about-me-dashboard.txt | `node scripts/verify-about-me-dashboard.mjs`（含排行榜 mock） | 69/69 PASS |
| e2e-onboarding-runs1.txt | `npm run e2e:onboarding -- --runs=1`（真瀏覽器） | 294 PASS／0 FAIL（已知問題 1：簽約驗證後關頁 60 秒內要等冷卻） |
| e2e-profile-save.txt | `npm run e2e:profile-save`（commit 後、src 乾淨時跑） | 見檔尾總結 |

底版比對（第二輪必修）：20261023100000 重寫的 get_teaching_leaderboard_v2／get_teaching_leaderboard／get_teacher_badge_stats，
拿掉新增的 pending 區塊後與正式版來源檔（gamify_compute／teaching_leaderboard／gamify_compute）空白正規化後完全相同；
正式版來源檔的內文 md5 前 8 碼等於總指揮在正式庫量到的 7793d208／8a6745a6／94435c44；套完後資料庫裡的內文就是 23 檔的版本，
三支都是 SECURITY DEFINER、search_path=public、anon 不能執行。

突變測試說明：只在暫存複本上改 SQL（不動 repo 檔），測試中途單獨重跑的 migration 也套同一條修補；修補對不到就直接報錯，確保突變真的生效。

沒驗到的：真的寄信（本機 pg_net 是替身，只能在正式庫預演時驗）、Google 登入本身、正式庫的 pg_net 安裝與權限。
