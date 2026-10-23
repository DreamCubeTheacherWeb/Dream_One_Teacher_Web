# 2026-10-23 資安審查「必修 1、建議 5」修正的驗證輸出

分支 `fix/esign-owner-decisions`（已合併 origin/main `20654ec`）。全部在本機隔離 PostgreSQL／假 Supabase 上跑，正式庫一筆都沒動。

| 檔案 | 指令 | 結果 |
|---|---|---|
| verify-claim-activation-esign.txt | `node scripts/verify-claim-activation-esign.mjs` | 348/348 PASS（新增「linked reads」38 項、「OTP abuse limits」16 項、「consent hardening」7 項等） |
| mutation-drop-role-check.txt | 同上 `--mutate=drop-role-check`（拿掉 20261023100000 的角色條件） | 340/348，8 項 FAIL（pending 綁定者讀得到上課紀錄、報酬彙總、成就統計、排行榜、徽章、空位影像） |
| mutation-drop-claim-records-check.txt | 同上 `--mutate=drop-claim-records-check`（拿掉「已有紀錄的空位不能姓名認領」） | 345/348，3 項 FAIL（有上課紀錄的空位被同名者認領成功、只剩隔離區紀錄的空位也被認領） |
| verify-claim-activation-esign-production-order.txt | 同上，加 `E2E_MIGRATION_ORDER`＝正式庫順序（…→140000→233000→100000→120000→20261023100000） | 348/348 PASS |
| verify-esign-production-order.txt | `npm run verify:esign-production-order`（primary／variant 兩種順序） | 70/70 PASS |
| e2e-onboarding-runs1.txt | `npm run e2e:onboarding -- --runs=1`（真瀏覽器） | 290 PASS／0 FAIL（已知問題 1：簽約驗證後關頁 60 秒內要等冷卻） |

突變測試說明：只在暫存複本上改 SQL（不動 repo 檔），而且測試中途單獨重跑的 migration 也套同一條修補；修補對不到就直接報錯，確保突變真的生效。
「drop-claim-records-check」那次，認領成功的同名者仍讀不到該空位的上課紀錄（20261023100000 的角色條件兜住），兩層防線各自都測得到。

重現的正式庫型態（總指揮 10/23 唯讀預檢）：`name_slot = true`、email／身分證／手機／銀行帳號四項全空、但 class_sessions 有紀錄的空位（測試 R1）。

沒驗到的：真的寄信（本機 pg_net 是替身，只能在正式庫預演時驗）、Google 登入本身、正式庫的 pg_net 安裝與權限。
