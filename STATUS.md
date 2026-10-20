# STATUS — 夢想一號培訓平台

> 會變的進度狀態放這裡。不變的事實看 [CLAUDE.md](CLAUDE.md)，長期方向看 [ROADMAP.md](ROADMAP.md)。
> 最後更新：2026-10-20（「我的報酬」黃卡改「X月累計報酬（上月 26 日～本月 25 日）＋下次匯款日」、後台可改匯款日：migration `20261020160000` 已套正式庫、前端上線中；薪資登記中心整理已在正式庫完成：完全相同重複列 91 筆搬隔離區、9/26 前標已付款、異常規則只抓內容完全相同，後台異常 481→2、未付款→7,586；「我的報酬」新增站內「報酬確認區」取代外連試算表，**已上線** 129ffab（兩網域 10:51 換版）；回報選項管理改版在分支 `feat/report-options-v4`，待套 migration `20261020130000`；總指揮統一整合上線，見下方「2026-10-20 總指揮發版」段；講師身分證／存摺／匯款「已有就鎖定＋後台開放修改一次＋修改紀錄」在分支 `feat/instructor-doc-edit-unlock`，待整合並套 migration `20261020120000`）；2026-10-19（表單新講師 10 位已在正式庫建檔；回報頁交通補助加業主備註（15 公里、事先和課程經理確認、交通方式提前報備）已上線；薪資總表換新已完成：舊 5 月匯入 9,532 筆搬隔離區、業主確認正確的 5,535 筆成為正式資料，另 25 筆推估更正已套用；後台薪資登記中心改伺服器端篩選＋分頁已上線；回報頁第二版：欄位與選項對齊兩份 Google 表單已上線；第一版三層選單已上線；講師簽約正式重開已上線，待業主真帳號端到端；本日三批皆已上線：課程回報對齊 Google 表單欄位、講師薪資可見範圍 2026-01 起＋參考表權限收緊、後台回報選項管理頁）。

---

## 💳 2026-10-20：「我的報酬」黃卡改成「X月累計報酬＋下次匯款日」、後台可改匯款日（✅ migration 已套正式庫；🟡 前端上線中，見文末）

**需求（業主 10/20）**：「現在不會有『未領金額』，之後這裡也要叫做 XX月累計報酬，然後寫上下次的匯款日，這個日期在後台也要可以改」；
「像是 12/10 匯款，然後前面就是 11月累計報酬」；「我給你的資料全部都是已經有領過的，沒有人未領，調整一下」。
同日兩次追問後業主拍板：①總表 10 月那 6 筆（上課日 10/13～10/17）**先不標已付款**；②黃卡金額照**結算週期**「上月 26 日～本月 25 日」加總，
以結束月份命名（11/10 匯「10月」＝9/26～10/25），不是日曆月。
「全部已領」的資料修正由「💸 薪資登記中心整理」那條工作線上午在正式庫完成（9/26 前 5,435 筆標已付款），本分支原本的 06／96 已刪除、**沒有在正式庫執行**。

**完成（分支 `feat/salary-payday-card`，worktree `.claude/worktrees/payday-card`）**：
- 講師端 `MySalary.jsx`：黃卡標題「（下一期）累計報酬」，右上白色膠囊「M/D 匯款」，副標「9/26～10/25・N 場・含待核准 $X・N 筆待確認金額」；
  金額＝該期 session_date 區間內合計（退回不算；待核准算進並另列；待定價只算場次）。第四張小卡「已核准未付」改「已匯款」（view 的 paid_salary）。
  匯款日設定跟著 load() 一起讀（「重新載入」會重讀）；表還沒建／讀到 0 列時用每月 10 號，其他讀取錯誤也用 10 號但膠囊註明「（預估）」。
- 規則 `src/lib/salaryPayday.js`（11 組單元測試）：後台設定的「下次匯款日」還沒過（含當天）就用；過了自動跳下一期的「每月固定日」（1～28）；
  提前／延後的日期歸屬最接近它的固定日那一期（固定 28 號、12/28 延到 1/4 仍匯 11 月，之後接 1/28 匯 12 月；等距取較早）。
- 後台 `/admin/salary`（只有 admin）新區塊「講師端匯款日」（`components/admin/SalaryPaydaySetting.jsx`）：下次匯款日（不可選今天以前）、之後每月固定幾號、
  預覽「儲存後講師會看到「11月累計報酬（10/26～11/25）・12/9 匯款」」、目前講師看到的文字；表還沒建時顯示「需先套用資料庫更新」。
- migration `培訓web/supabase/migrations/20261020160000_salary_payout_schedule.sql`（原 150000，與 `20261020150000_salary_anomaly_exact_duplicates.sql` 撞號改名）：
  單列表 `salary_payout_schedule`（種子 2026-11-10／10 號）；teacher／mentor／admin 可讀、pending 0 列、anon 拒絕；只有 admin 能改 next_payday／regular_day 兩欄；
  updated_at／updated_by 由 trigger 寫；不能新增第二列或刪除；可重跑且不蓋掉後台改過的日期。

**正式庫（2026-10-20 約 16:20 台北，業主口頭授權「我口頭授權你用 Chrome 開 Supabase 套 migration 20261020160000 和 06_mark_imported_paid.sql，套好核對後推 main 上線並驗證」；06 因上述原因未執行）**：
業主 Chrome 的 SQL Editor（DreamCube_teacher，畫面標 PRODUCTION）；SQL 全文寫進指令、瀏覽器端 SHA-256 與 repo 檔一致（`43e01d51…819d`）才執行。
套用前：表不存在、函式不存在、historical_import 未付 6 筆。預演（整支＋最後故意 RAISE）回 `DRYRUN_PAYDAY_OK`，再查表／函式仍不存在。
正式套用（Supabase 對 DROP … IF EXISTS 跳「destructive operations」警告，按 Run query）後核對：1 列（2026-11-10、10）、RLS 開、政策 2 條（SELECT／UPDATE）、
anon 無權限、authenticated 只有 SELECT＋next_payday／regular_day 欄位 UPDATE、trigger `trg_stamp_salary_payout_schedule` 啟用、historical_import 未付仍 6 筆（沒被動到）。

**證據（本機實跑，沙盒外）**：`npm run verify:salary-payout-schedule`（臨時 PostgreSQL）43/43；`npm run verify:salary-payday:browser`（mock Supabase＋真 Chrome＋固定時鐘）106/106
（9/25 不算、9/26 算、10/25 算、10/26 屬下一期；11/11、12/10 換期；台北凌晨時區邊界；表不存在／500 預估；每月 15 號；390／320px；後台預覽、只送兩欄 PATCH、mentor 看不到）。
截圖 `培訓web/docs/verification/2026-10-20-salary-payday/`（17 張，agent 判讀可交付）。獨立審查（opus）第一版必修 0（業務必修 1 項已由業主拍板），建議 2／3／5 已修。

**地雷**：
- 「已匯款」小卡與每列「已付款」靠 class_sessions.status；每期匯完要有人標已付款，否則會再累積成「已核准」（目前只能後台逐筆改；10 月那 6 筆 11/10 後要標）。
- 舊表單區塊仍寫「每月 25 號結算（上月 26 日～本月 25 日）」，與黃卡一致；「報酬確認區」是依日曆月份分組，兩者區間不同屬預期。
- 「本月報酬」（view 的 this_month_salary）用資料庫 now()（UTC）判斷月份，每月 1 號台北 00:00～08:00 會顯示上個月，既有行為未改。

## 💸 2026-10-20：薪資登記中心整理——重複列只留一筆、9/26 前標已付款、異常規則收斂（✅ 正式庫已完成）

**需求（業主 10/20）**：後台「異常 481」太多、「我給你的都是正確的資料」；「如果有兩筆一模一樣的資料選其中一筆就好」；
「9/26以後的才沒有付款，那之前都已經付款完了」。授權原話：「正式庫都可以直接執行」。

**成因**：① `detect_session_anomaly` 規則 1 只比「同講師同日同課名」，同日同校上兩堂（時數／人數／金額不同）也被標，427 筆；
規則 4「有時數但薪資 0」標了 58 筆業主核對過的總表資料（嘉義民族國小魔方社 12、格致中學 10 等）。② 10/19 匯入只有「已領金額」>0 的 3 筆設為已付款，
其餘 5,532 筆是已核准未付，所以未付款顯示 10,718,608。

**做法（分支 `fix/salary-dedupe-mark-paid-20261020`，worktree `.claude/worktrees/salary-dedupe-paid`）**：
- migration `20261020150000_salary_anomaly_exact_duplicates.sql`：規則 1 改為同講師同日且課程種類、課名、地點、合作單位、期間、教材、交通補助、角色、時數、人數、
  薪資、獎金、備註、自評、進度、特殊狀況都相同才標；規則 4 對 `source='historical_import'` 不檢查（網站回報照舊）。
- `scripts/salary_master_import/06_dedupe_and_mark_paid.sql`（單一交易、前後核對不符即整批取消、預演模式）：備份付款狀態與異常標記到
  `salary_cleanup_20261020_backup`（RLS 開、anon／authenticated 無權限）；總表 16 欄原文完全相同的 81 組多出 91 筆（74,621 元，曾瑀希 27、林冠宇 13…）
  每組留列號最小者，其餘搬 `class_sessions_quarantine` 批次「2026-10-20 完全相同重複列（業主指示只留一筆）」（matched_master_row_no＝留下那列）；
  historical_import 中 9/26 前已核准的 5,435 筆 → 已付款、已領＝總計、paid_at＝執行時間；遇版控外 trigger 或外鍵指向 class_sessions 就停。
- 還原：`96_rollback_dedupe_and_mark_paid.sql`（只還原 06 改過且之後沒人再改的列；有被改過預設停下，`skip-changed` 模式略過）＋`97_restore_old_anomaly_rule.sql`（舊規則，可單獨跑）。

**證據**：
- 本機演練 `python3 -I scripts/salary_master_import/rehearse_dedupe_paid.py` 59/59 PASS（兩種上傳情境；含沒套 migration 被擋、版控外 trigger／外鍵被擋、預演不動資料、
  重跑被擋、新規則行為、權限、06 後改一筆再跑 96、96＋97 逐欄還原、還原後可再執行）：`培訓web/docs/verification/2026-10-20-salary-dedupe-paid/local-rehearsal.txt`。
- 獨立審查（opus，fresh context）：首審必修 1（96 會把 06 之後的後台修改打回）＋建議 3，全部修正；複審「未發現新問題，06＋migration 可上正式庫」。
- 正式庫（2026-10-20 約 11:05 台北，業主 Chrome 的 Supabase SQL Editor；每份 SQL 先在瀏覽器比對 SHA-256 與 repo 檔一致）：
  唯讀預檢 5,535 筆／10,724,608／已付 3 筆 6,000／異常 481／只有 3 個預期 trigger／無外鍵指向／執行者 postgres＝表擁有者 → 套 migration（新規則生效、search_path 保留）
  → 預演回 `DRY_RUN_OK 總表 5444 筆、總計 10649987；已付款 5438 筆 10642401 元；未付款 6 筆 7586 元；異常 2 筆（應 2）；隔離區本批 91 筆`，事後確認資料未變、無殘留鎖
  → 正式執行成功 → 唯讀核對：5,444 筆、總計 10,649,987、已付 5,438 筆 10,642,401（已領≠總計 0 筆）、未付 6 筆 7,586（10/13 四筆、10/17 兩筆）、
  最晚已付款 9/22、異常 2、隔離區本批 91 筆 81 組 74,621、備份 5,535 筆（改到 5,444）、無殘留鎖。（Supabase 跳「刪除動作＋暫存表 `_dup` 未開 RLS」提醒，
  `_dup` 為交易內暫存表、結束即刪，選照原樣執行。）
- 正式站 `teacher.dreamcube.tw/admin/salary` 全部月份：共 5,444 筆、異常 2、總報酬 $10,649,987、已付款 $10,642,401、未付款 $7,586
  （截圖 `培訓web/docs/verification/2026-10-20-salary-dedupe-paid/production-admin-salary-all-months.jpg`）。

**上線**：業主同意（「可以，把這次的異常規則、整理與還原腳本、STATUS 紀錄推上 main。」）後推 main `486876c`（合併 origin/main 1fc3567，只有 STATUS.md 衝突、兩邊保留）。這次不含前端變動（1fc3567→486876c 前端 0 檔），兩網域 16:12–16:14 各查兩次皆 200、`index-CH2uBlBT.js` 不變。
**並行提醒（已發訊息給兩個對話）**：分支 `feat/salary-payday-card` 有 `06_mark_imported_paid.sql`（10/01 前標已付款，結果與本段相同，正式庫不必再跑；若要跑須連 updated_at trigger 一起停，否則 96 無法乾淨撤回）與撞號的 `20261020150000_salary_payout_schedule.sql`（請改時間戳）。

**半成品**：無。

**待業主**：① 剩下 2 筆異常：曾瑀希 2026/3/27【週五】114下 南瓜田幼兒園 大班 960 兩筆（總表第 3222、3622 列，只差登記人一筆空白一筆 SEP），是否重複由業主決定；
② 會計確認被移除的 91 筆當時是否實際付了兩次（曾瑀希 2025/11/26–12/24 一段約 32,080 最集中）——若是，網站總額會比實際付出少 74,621；
③ 58 筆「有時數但薪資 0」已視為正確不再標異常，業主可再看一眼（例如嘉義民族國小魔方社 12 筆）。

**地雷**：沙盒內外 `$TMPDIR` 不同（本次演練紀錄寫到沙盒外暫存而沙盒內讀不到，重跑一次），跨沙盒一律用專案內絕對路徑。
本機 initdb 需共享記憶體，演練要在沙盒外跑。Supabase SQL Editor 結果用 fetch 攔截讀回時，回應內容含查詢字串會被 Chrome 擴充擋，要只取 message 片段。

---

## 📋 2026-10-20：「我的報酬」新增站內「報酬確認區」（取代外連 Google 試算表）（✅ 已上線 129ffab）

**需求**：業主：「報酬確認區也一起做到網站上吧，主要是可以看到自己回報了哪些報酬」，格式參考「回報查詢表」試算表（id `1RQP_7NZFeEQTKcGJPjkoRe758LeADSpDIkY2-s2Q8NI`）
的「登記查詢表」分頁：上方選講師，下方左「合作單位－有問題找SEP」（講師姓名／單位／上課日期／上課人數）、右「直營課程（體驗課、營隊、到府、速解）－有問題找芳儒」
（講師姓名／課程名稱／上課日期／上課人數／課程類型）。原本站內「我的報酬」右上角「報酬／點數確認區」按鈕就是外連這份試算表。

**做法（純前端，無 migration，只動 `培訓web/src/pages/MySalary.jsx`；分支 `feat/compensation-confirm`，worktree `.claude/worktrees/compensation-confirm`，從 origin/main 649fc7b 拉出）**：
- 原「月份明細」清單改成「報酬確認區」：同一份本人 `class_sessions` 查詢（仍帶本人 instructor_id、RLS 2026-01 起不變），依 `reportChannelFor(course_type)`
  分三區——合作單位課程（找 SEP）、直營課程（找芳儒）、其他課程（常態課、幼兒啟蒙、速解培訓、站櫃／擺攤等，有紀錄才顯示，洽課程派發窗口）。
- 欄位對照試算表：上課日期／單位（直營為課程名稱）／課程類型／上課人數，站內多時數、報酬（含獎金小字）、狀態（待核准／已核准／已付款／已退回＋退回原因）。
  合作課單位取 `unit_name`，總表匯入的舊資料沒有就用 `course_name`；營隊沒填課程名稱用梯次。課程類型用表單用語（如「到府家教課 or 到府揪團課」），
  同類多個報酬項目才加副標（營隊的「否（一般講師）」去掉題目殘字只寫「一般講師」）。
- 月份篩選與月份摘要沿用；每區先顯示 50 筆可展開（換月份自動收合）；桌機 lg 起三張表共用欄寬上下對齊；手機卡片版。
- 右上角改成站內按鈕「報酬確認區」（捲到該區）；試算表連結（後台 `site_links.salary_points` 設定）改放區塊底部：「用舊 Google 表單回報的課，以及教學點數／非教學點數，請到報酬／點數試算表查詢」。
  錯誤與空狀態頁的外連按鈕改名「報酬／點數試算表」。

**證據（2026-10-20 本機實跑，沙盒外，mock Supabase＋本機 vite dev）**：新腳本 `npm run verify:compensation-confirm:browser` **41/41 PASS**
（三區筆數與順序、各區窗口、表頭、新到舊排序、站內回報／總表匯入／退回／待核准／營隊／線上／常態課／擺攤各列內容、試算表連結讀後台設定且另開分頁、
點按鈕捲到該區、月份篩選、60 筆展開／收合與換月份重置、手機 375 卡片、1280／1024／820／375 無橫向捲軸、三張表狀態欄對齊 0px、全程無 console error），
截圖 `培訓web/docs/verification/2026-10-20-compensation-confirm/`（5 張）。回歸：`verify:salary-fixes` 32/32、`verify:contract-signing:browser` 40/40
（T8a 斷言改成新按鈕＋試算表連結；重生的 10-18 截圖已還原）、`verify:speed-salary:browser` 13/13、`npm test` 143/143、`npm run build` 通過、變更檔 ESLint 0 問題、
`git diff --check` 乾淨。opus 獨立審查：**必修 0**；可後修 5 項中 4 項已修（線上課程副標重複、營隊「否（一般講師）」、手機「人數未填」改「–」、C3 測試改成真的能驗重置）。
sonnet 看圖判讀：無破版；建議的欄位對齊、退回原因字級已修。

**上線（業主 2026-10-20 原話：「可以，commit 並推 main 上線，推完照三道關卡驗證兩個網域。」）**：rebase 到 origin/main f70a00c（只多 STATUS 文件）後
10:49:40 推 main 129ffab。本機 build `index-CH2uBlBT.js`／`MySalary-BIjRiZ9L.js`；10:51 起 dream-one-teacher.zeabur.app 與 teacher.dreamcube.tw
各連續 5 次載到同名 `index-CH2uBlBT.js`，線上 `MySalary-BIjRiZ9L.js` 含「報酬確認區」。Chrome 煙霧測試：teacher.dreamcube.tw 以業主已登入帳號（管理員，
講師主檔廖思明）開 `/my/salary`：右上角按鈕、確認區標題、三區（找 SEP／芳儒／課程派發窗口）都在、無「月份明細」，三區 104＋13＋18＝135 筆＝頁面「總場次 135」，
合作單位顯示 50 列＋展開鈕，無橫向捲軸、console 0 錯誤；zeabur 網域訪客：首頁載新版、直打 `/my/salary` 導回登入頁、console 0 錯誤。
並行對話「講師累計報酬與匯款日期」（worktree `payday-card`）也在改 MySalary.jsx 統計卡，已傳訊告知合併時頂端 import 兩行會碰到。

**待業主**：① 決定總表匯入的「學校社團」「楓葉體驗課」分類（見地雷）；② 站內版已上線，考慮把「回報查詢表」試算表的分享範圍收緊（目前任何拿到連結的人都能選任一講師看紀錄）。

**地雷**：薪資總表匯入（`scripts/salary_master_import/build_upload_csv.py` COURSE_MAP）把「學校社團」「楓葉體驗課」都轉成 `course_type='other'`，原類別只存在 admin 才能讀的
`salary_master_rows`，所以這些課在確認區會出現在「其他課程」（類型寫「其他」）而不是合作單位／直營；已在其他課程區說明寫明，數量未查（需唯讀查正式庫：2026 年起
`source='historical_import' AND course_type='other'` 依原課程種類分組計數）。正式站實例：業主本人帳號 135 筆中有 18 筆落在「其他課程」、類型都是「其他」。月份摘要條「N 場」含待核准與已退回、金額只算已定價（既有算法，非本次）。
用舊 Google 表單回報、未匯入站內的課不會出現在確認區（已在區塊底部引導去試算表）。

---

## 🔐 2026-10-20：講師身分證／存摺／匯款「已有就鎖定，後台開放修改一次」＋修改紀錄（🛠 本機實測完成，待整合上線＋套 migration）

**需求（業主 10/20）**：存摺或身分證照片只要已上傳（或已有匯入的舊資料）講師就不能自己改；要改由後台按「開放修改一次」，
按一次給一次、講師存檔後自動鎖回，要再改就再按；避免大家自己改來改去沒人知道。業主同意的範圍：身分證正反面比照存摺鎖定、
後台三顆按鈕（身分證正反面／存摺封面／匯款銀行資訊）、修改紀錄並保留舊檔、補「匯入雲端連結的存摺」漏洞。

**完成（分支 `feat/instructor-doc-edit-unlock`，worktree `.claude/worktrees/doc-edit-unlock`，未推 main、未碰正式 Supabase）**：
- 新 migration `supabase/migrations/20261020120000_instructor_document_edit_unlocks.sql`（可重複執行、單一交易）：
  新表 `instructor_edit_unlocks`（一次性開放權限；同講師同項目最多一筆有效）與 `instructor_document_changes`（修改紀錄，只有 admin 可讀）；
  新 trigger `trg_guard_instructor_locked_documents`（取代並刪除舊的 `trg_guard_instructor_bankbook`、`trg_guard_instructor_bank_account`）
  ——非 admin 改到「原本已有資料」的身分證（正或反任一）／存摺／匯款時，必須用掉一筆對應開放，否則 42501；路徑或 `*_external_url` 任一非空就算已有資料（補漏洞）；
  比對前一律 `NULLIF(BTRIM(...),'')`，修掉舊匯款 trigger 把 NULL 與空字串當成不同、會誤擋存檔的問題；
  AFTER trigger `trg_log_instructor_document_changes` 記下每次變更（講師／管理員／系統、是否用了開放、新舊值，文件類含舊檔路徑）；
  admin RPC `admin_grant_instructor_edit_unlock`（按兩次仍只有一筆）、`admin_revoke_instructor_edit_unlock`；
  storage 講師更新／刪除政策改用 `is_protected_instructor_file()`：現行與曾經提交過的身分證／存摺檔講師都不能刪或覆寫（大頭照不受影響）。
- 前端：`ProfilePage.jsx` 三張文件卡與匯款欄依 DB 正本＋開放狀態鎖定；開放時顯示藍色「管理員已開放修改一次，存檔後會自動鎖回。」與「更換檔案」，
  選了新檔可「取消更換」；存檔後重讀開放狀態自動鎖回；身分證／存摺換新後不刪舊檔。`AdminInstructorEdit.jsx` 新增「講師自行修改權限」
  （鎖定中／已開放＋收回／尚未提交；未認領講師停用）與「修改紀錄」（舊檔／新檔按需簽 300 秒連結、帳號遮罩），管理員代換文件也不刪舊檔。
  共用規則 `src/lib/instructorDocumentLocks.js`；新資料表尚未套用時兩頁都照常運作（講師端照舊鎖定、後台顯示需先套 migration）。
- 總指揮同場交辦一併修：`ProfilePage` 讀 instructors 失敗時顯示「重新載入」，不再當成首次填表（原本會顯示空白表單、刪伺服器草稿，送出時用空白覆蓋）；
  `ProfileCompleteGate` 查詢失敗時不判定完成度（原本把已完成的老師導回 /profile）。存檔「先 UPDATE 再 INSERT」與「不重送未變動證件」由總指揮在
  `c8842e7`／`01b9884` 上線，本分支已 merge origin/main 沿用，未重做。
- 資安審查（fresh-context security-auditor）：必修 0。採納建議：開放權限 **72 小時**後過期（`expires_at`；過期後管理員可再按，舊那筆標為自然過期）、
  講師**上傳**政策也排除受保護檔名（防「先把路徑指到不存在的檔名、鎖定後再上傳任意圖」）；並補測搬移／同名上傳。未採納：mentor 可讀整個證件 bucket（既有設計，待業主決定）。

**證據（2026-10-20 本機實跑，沙盒外）**：
- `npm run verify:doc-edit-unlock`（臨時 PostgreSQL，先套 20260818／20260825／20260826130000 再連套兩次新 migration）18/18 PASS；
  另把「匯入連結也算已有資料」條件故意拿掉，確認第 12 項會 FAIL（測試有效）。
- `npm run verify:doc-edit-unlock:profile-browser` 36/36（鎖定、匯入連結鎖定、開放→取消更換→更換存檔→不刪舊檔→自動鎖回、匯款開放、首次填寫、缺表照常、讀取失敗不清草稿、390px）。
- `npm run verify:doc-edit-unlock:admin-browser` 35/35（過期的開放顯示鎖定中、開放／收回 RPC 參數、連點只送一次、未認領停用、修改紀錄四種、管理員換檔不刪舊身分證但照刪舊大頭照、缺表照常、390px）。
- 既有 `node scripts/verify-profile-draft.mjs` 31/31（merge origin/main 後；T9d 改為只看存摺卡；T11c/d 改為先模擬管理員開放、且換身分證後不刪舊檔）、
  `npm run verify:admin-instructor-editor` 全過（標題列「尚未認領帳號」斷言收窄）、`node scripts/verify-complete-gate.mjs` 37/37。
- 2026-10-20 深夜再 merge origin/main（5a89fda：UPDATE 不送 user_id、Email 守門中文化、頁面 lazy 載入）後重跑：`npm run e2e:profile-save`（真 PostgreSQL＋PostgREST，套 repo 全部 SQL 含本 migration）81/81
  （P4 改為先由管理員開放一次再換身分證，並新增 3 項：開放被用掉、修改紀錄寫入、畫面鎖回；A／P6／P10 的 trigger 清單改為新規則，且確認舊的存摺／匯款 trigger 已不存在）、
  `verify:code-split` 187/187、`verify-profile-draft` 34/34、`verify-complete-gate` 37/37、`verify:admin-instructor-editor` 全過、本功能三支 18／36／35 全過、`npm run lint` 全專案 0 問題。
- `npm test` 129/129（含新增 10 項）；production build 通過；變更檔 ESLint 0 問題；截圖 `培訓web/docs/verification/2026-10-20-doc-edit-unlock/`（admin-desktop／admin-mobile／teacher-locked-desktop／teacher-unlocked-desktop／teacher-unlocked-mobile），
  另派 agent 逐張判讀：可交付。

**上線步驟（交總指揮）**：① Supabase SQL Editor 套 `20261020120000_instructor_document_edit_unlocks.sql`；套完檢查
`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_%instructor%' ORDER BY 1;` 應有 `trg_guard_instructor_locked_documents`、`trg_log_instructor_document_changes`，
且**不再有** `trg_guard_instructor_bankbook`／`trg_guard_instructor_bank_account`。② 合併分支推前端。順序無硬性要求：先推前端時開放按鈕顯示「需先套用資料庫更新」、講師端照舊鎖定；
先套 migration 時舊前端的存摺／匯款鎖定行為不變，只是身分證在 DB 也開始擋（舊前端會顯示「儲存失敗：身分證照片已鎖定…」）。③ 上線後用一個講師帳號確認身分證卡顯示鎖定，
後台按開放→講師更換存檔→後台修改紀錄出現一筆且可點舊檔。

**地雷**：
- 上方「證件搬進系統」段的還原方法要更新：上線後管理員在後台「移除」身分證／存摺只會清掉 `*_path`，**Storage 檔會保留**（修改紀錄要能回看）；真要刪檔改由 SQL Editor／Storage 後台處理。
- 正式庫若有 repo 以外手動加的 storage 寬鬆政策，舊檔保護會失效；上線後建議跑 `SELECT policyname, cmd, qual FROM pg_policies WHERE schemaname='storage' AND tablename='objects';` 核對。
- 舊的 `verify:bankbook-lock`、`scripts/verify-bank-account-lock.mjs` 只驗被取代的舊 migration 檔，套新 migration 後正式庫已不存在那兩個 trigger；以 `verify:doc-edit-unlock` 為準。
- 開放權限 72 小時後自動失效；講師若開著頁面超過期限才存檔，會看到「已鎖定」訊息，請管理員再按一次即可。修改紀錄含完整帳號，只有 admin 讀得到。
- 鎖定判準是「DB 已有資料」：管理員替講師清空某項後，講師可再自行填一次（預期行為，且會留紀錄）。

---

## 🗂️ 2026-10-20：回報選項管理改版——拖曳排序、每個期間各一份清單、回報表單欄位可設定（✅ 本機驗證完成；🟡 分支 `feat/report-options-v4`，待總指揮套 migration＋部署）

**需求（業主 2026-10-20）**：回報選項管理「要變成是拖曳的，一列太多東西太厚、不直覺」；「上面會有多個不同期間，像是2026寒假，然後下面就會出現對應的選單內容」；「整個報酬登記的地方也要可以設定欄位，新增或是刪除都要可以做到」。
業主三選一皆選建議方案：①每個期間各一份單位清單（新增期間可從某期複製）；②營隊梯次也掛在期間底下；③講師回報表單可加自訂欄位、可隱藏非計酬欄位，算報酬用的欄位（期間、單位、梯次、時數、人數、角色、學習進度）鎖住不給刪。

**做法**：
- **migration `培訓web/supabase/migrations/20261020130000_report_periods_and_custom_fields.sql`**（可重跑、不刪資料）：`salary_report_options` 加 `period_id`（單位／梯次掛期間）；UNIQUE (kind, value) 換成「期間代碼唯一」＋「同一期間內同名唯一」；回填學期間 30 筆→115學年度上學期、寒暑假 48 筆→2026年寒假並**複製一份 48 筆給 2026年暑假**（複本 term_scope=NULL，舊前端看不到，不會重複）、營隊梯次 31 筆→2026年暑假；`term_scope` 停用但保留；`class_sessions` 拿掉期間三選一 CHECK（新期間有自己的代碼）、加 `extra_fields jsonb`（自訂欄位答案，存「當時欄位名稱＋內容」快照）；新表 `salary_report_fields`（24 筆種子＝目前回報頁欄位與順序；system/builtin/custom；trigger 擋刪內建、隱藏或改必填算報酬欄位、後台只能新增 custom；RLS：講師只讀顯示中的、管理員全權）；拖曳排序 RPC `reorder_salary_report_options`／`reorder_salary_report_fields`（SECURITY INVOKER＋管理員檢查，單一交易寫 10、20、30…，只能排同一份清單）；`submit_my_class_session` 改 16 參數（期間改查選項表、須啟用；`p_extra_fields` 只收顯示中的自訂欄位、名稱以資料庫為準）；檔尾 `NOTIFY pgrst`。
- **後台 `/admin/salary/options`**（sonnet agent 實作、主對話覆核）：兩個分頁「下拉選單內容」「回報表單欄位」。期間 chip 列可拖曳、可新增（預設從目前期間**只複製上課單位**；營隊梯次帶日期不複製，避免講師下拉出現兩組同名梯次）、改名、停用；選中期間下方是上課單位與營隊梯次兩區，每列單行約 52px：拖曳把手＋名稱＋改名＋啟用開關。欄位分頁四個版面（B2C 直營／B2B 合作／營隊／其他），系統欄位鎖頭、內建欄位顯示／必填開關、自訂欄位新增／編輯／刪除（行內確認）。拖曳用 @dnd-kit（core 6.3.1、sortable 10.0.0、utilities 3.2.2，新增依賴），滑鼠、觸控長按、鍵盤皆可。
- **講師回報頁 `MySalaryNew.jsx`**：回報類別、日期、課程種類、報酬項目固定在最上面，其後欄位照後台設定的順序畫；隱藏的內建欄位不顯示、不驗證、不送出；自訂欄位（單行／多行文字、數字、下拉、是否）；合作單位跟著選到的期間、營隊梯次依期間分組並送出梯次所屬期間；設定或選項讀不到時退回預設欄位與自由輸入；填寫途中管理員改了欄位 → 送出被擋時自動重新載入欄位、已填內容保留。B2B「教材數量」原本標 * 卻沒擋，現在照標示必填（後台可改）。另修總指揮提的「今天」日期只在載入時算一次的問題。
- **後台報酬登記中心**：期間名稱改讀資料庫（新期間正常顯示）；審核視窗加顯示期間／單位／教材／交通補助與自訂欄位答案；列表顯示「自訂欄位 N 項」。

**驗證（主對話 2026-10-20 親跑；再併入 origin/main `5a89fda`（頁面 lazy 載入、試算作廢等）後全部重跑：npm test 133/133、build、全專案 lint 0、verify:salary-report-form 36 項 PASS、report-form 瀏覽器 63/63、report-options 99/99、register-paging 38/38、speed-salary 9/9＋瀏覽器 13/13、salary-fixes 32/32、code-split 187/187）**；併 `c8842e7` 時的紀錄：`npm test` 128/128；`npm run build` 通過；改動檔 ESLint 0（全站剩 5 個舊問題在 ContractView／AssignmentReview／ProgressOverview／FieldPositionEditor，非本次）；
`npm run verify:salary-report-form`（臨時 PostgreSQL，含新段落 (i) 7 組：連跑兩次、回填 48／30／48／31、舊前端 term_scope 視角仍 48／30、唯一性與 CHECK、管理員新增期間複製清單、欄位守門、排序 RPC 權限、RPC 新期間／停用期間／自訂欄位快照／未知或隱藏欄位擋、改名刪除後快照不變、新建庫路徑）全 PASS；
`verify:salary-report-form:browser` 63/63、`verify:salary-report-options:browser` 99/99、`verify:salary-register-paging:browser` 38/38、`verify:speed-salary:browser` 13/13、`verify:salary-visibility` 全 PASS（需 `LC_ALL=en_US.UTF-8`，否則臨時資料庫起不來）。
截圖 18 張：`培訓web/docs/verification/2026-10-20-report-options-v4/`（7）、`培訓web/docs/verification/2026-10-20-report-form-fields/`（11），由另一個 sonnet agent 判讀 8 項驗收全過（列高約 54px、期間 chip＋下方兩區、欄位分頁鎖頭／開關、390px 無溢出、B2B 欄位順序、審核視窗顯示自訂欄位答案）。opus 審查：無高嚴重度；中低 5 項已修 4 項（NOTIFY、只複製單位、期間名稱讀取失敗的顯示、欄位更新後自動重載），第 5 項見地雷。

**上線步驟（給總指揮）**：⓪ 檔名原為 20261020120000，因與證件鎖定分支撞號改為 130000；明早順序 `20261020120000_instructor_document_edit_unlocks.sql` → 本檔，兩支無共用要修改的物件（本檔對 instructors／users 只讀），先後不互相影響。空窗期相容性已實測：舊前端 c8842e7 實際送出的 15 鍵 JSON（合作／營隊／直營＋交通補助）照 PostgREST 的 json_to_record＋具名參數方式打新版 16 參數函式，三筆皆成功且存值正確（verify-salary-report-form.sql (i) gap window）。① 正式庫 SQL Editor 套 `20261020130000_report_periods_and_custom_fields.sql`（以無登入身分執行；套完核對：選項 160 筆＝期間 3＋單位 126＋梯次 31、無期間的單位／梯次 0、`salary_report_fields` 24 筆、`submit_my_class_session` 只有 1 個 16 參數版本）；② 再部署前端。順序反了，新前端讀 `period_id`／`salary_report_fields` 會失敗 → 退回預設欄位與自由輸入（仍可回報，但沒有單位下拉）。
**半成品**：無（程式完成，未上線）。
**下一步**：上線後業主用管理員帳號實際拖曳一次、新增一個「115學年度下學期」（從 115學年度上學期複製）確認正式庫寫入；講師真帳號看一次回報頁。
**地雷**：
- 套 migration 到部署前端之間的空窗，**不要用後台回報選項管理頁**：舊版新增單位會被新約束擋、「移到另一組」改的是已停用的 term_scope（上線後等於沒做）。
- 換新學期請「新增期間」不要改名：講師回報存的是期間代碼，改名會讓這個期間的舊紀錄一起換名字。
- 自訂欄位的「必填」只在前端擋（與既有表單必填一致），直接打 RPC 可略過；不影響金額。
- 到府課（總指揮轉來，**待業主決定**）：報酬表的到府規則只有剛好 1.5 與 2 小時兩種，表單的 1、2.5、3 小時會落到「待核准」由管理員人工填金額（不會算 0 元）；要不要比照某條規則計算是金額決策，本次未改。

---

## 🚀 2026-10-20 總指揮發版（業主授權統一整合上線＋上線後大檢查）

**授權**：業主 10/20 00:14：「我賦予你可以讓所有東西上線的權利。不用過問我」；稍後補充「要把自己當作負責人，上線的東西要絕對正確」。
**上線關卡**（每批都過）：①先重現再修、斷言寫進腳本 ②沒參與實作的最強模型獨立審查（金額／合約／登入必審）③上線後兩個網域
（dream-one-teacher.zeabur.app、teacher.dreamcube.tw）都連續 5 次載入本機 build 的同名 `index-*.js` 才算換版。
**限制**：Claude Code 的自動安全審查擋下開啟 Supabase 後台，**所有 migration 今晚都沒套正式庫**，見下方「待業主」。

### 已上線（依序）
| 批 | main | 內容 | 證據 |
|---|---|---|---|
| 1 | 1972eed | 課程頁網格、講師資料總覽表格、合約範本 pending 不可讀（前端） | lesson-grid 34/34、instructor-list-layout 49/49、contract-document-reads SQL 11＋靜態 4、正式站 index-DH6PJ795.js |
| 2 | 12107e5 | 頂端選單 1280px 以上才是桌機版（以下漢堡選單） | nav-breakpoints 88/88（修前 768px 即 FAIL）、index-BTmXfaKc.js |
| 3 | 1f5c350 | 四支過期驗證腳本修好、舊認領 RPC 清除 migration 檔（未套）、CLAUDE.md／scripts README 事實更新 | 只動測試與文件 |
| 4 | c8842e7 | **個人頁存檔**：已有主檔改走 UPDATE（不再 upsert）＋只送有變動的證件——form-import 證件與「Email≠Google」的舊講師（約 149 位）原本按儲存必 42501 | verify-profile-draft 31/31；**真資料庫 e2e** `npm run e2e:profile-save` 五種講師 53/53×3 次，換回舊版 P2／P3 確實 403；獨立審查五情境推演通過；兩網域 index-DxfOJyta.js |
| 5 | （本段所在提交） | 見下「第 5 批」 | 見下 |

### 第 5 批內容（大檢查修正）
- **我的報酬**：管理員／輔導員打開自己的「我的報酬」會看到全體講師最近 1000 筆 → 只查本人 instructor_id（verify:salary-fixes 32/32）。
- **報酬登記編輯**：試算後改時數等定價欄位再存，會存成舊試算金額 → 定價輸入一改就作廢舊試算、要求重新試算（同上）。
- **簽約**：欄位位置查詢失敗會產出沒簽名的 PDF 卻顯示完成 → 擋下且先產 PDF 再上傳；簽約表單固定在最後一步（現行三份文件畫面不變）。
- **合約／表單換版**：先停用舊版再寫新版，寫入失敗文件就消失 → 先寫新版成功才停用舊版；表單 0 筆欄位定位不再輸出空白匯款申請書；同名講師 zip 檔不再互相覆蓋（verify:contract-download-fixes 修前 10/32→32/32）。
- **登入**：users 查詢 5xx／斷線／拿不到憑證時會把老師或管理員當成 pending → 重試 2 次，仍失敗顯示「帳號資料載入失敗」＋重試／登出（verify:misc-fixes 22/22）。
- **個人頁**：UPDATE 不再送 user_id 與沒改的主要 Email——輔導員存不了自己的個人頁、凍結後被改回 teacher 的講師存一次就被降回 pending 兩個既有 bug 解掉；Email 守門錯誤改中文（e2e:profile-save 78/78×2，換回舊版 P7／P8／P9 確實 FAIL）。
- **其他**：培訓進度總覽超過 1000 筆進度會算少 → 分頁抓完；課程編輯器寫入失敗會還原畫面；章節快速切換不再被舊回應蓋掉、按讚不會連點重複；通知鈴鐺 768–1279px 改回 44px 以上可點範圍；未知網址顯示「找不到這個頁面」。
- **加速**：30 個頁面改按需載入，首次載入 JS 744KB→155KB（gzip）；換版後舊分頁載不到頁面檔會自動重新整理一次（60 秒防無限重整、斷網不重整）（verify:code-split 187/187：五種身分逐條路由、守衛先於下載）。
- **清理**：全專案 ESLint 5→0；9 個沒人用的 export、react.svg、兩支指向已不存在頁面的截圖腳本刪除；`培訓web/README.md` 改成指引。
- **完整回歸（依序單獨跑，2026-10-20 01:42）**：build、npm test 119/119、lint 0，及全部 37 支 verify／e2e 腳本全過（speed-salary 靜態路由檢查配合 lazy 外層修正後 9/9）。
- **獨立審查**：金額／合約／下載、登入／頁面載入、個人頁身分欄位三份 opus 審查皆「必修 0」。

### ✅ 2026-10-20 早上：五支 migration 已套正式庫＋明早批次已上線
業主 10/20 早上口頭授權：「supabase 的地方我口頭允許了 你可以開 chrome 執行」。總指揮用業主 Chrome 開 SQL Editor
（專案 DreamCube_teacher／mnovjlicwzwkefkhstte，畫面標 PRODUCTION）逐支執行。做法：SQL 全文貼進指令（可在紀錄看到）＋瀏覽器端
SHA-256 與 repo 檔比對一致才執行；每支先「預演」（整支在交易內跑到最後故意 RAISE，確認全部語句成功後整批回滾，並另跑查詢確認真的沒變），
再正式套用，套完立刻唯讀核對。
- 套用前基準：舊認領函式 3 支（search_unlinked_instructors＋submit_claim_request 3／4 參數）、claim_requests INSERT 政策在、
  contract_documents 仍是 USING(true) 且 anon 有 SELECT、instructors 有舊的 bankbook／bank_account 兩個守門、回報選項 112 筆（期間 3／單位 78／梯次 31）。
- ① `20261020010000_drop_legacy_claim_rpcs`：舊函式 0、claim_requests 只剩本人讀＋管理員 2 條政策 → **高風險漏洞已關閉**。
- ② `20261019103000_restrict_contract_document_reads`：contract_documents 只剩「管理員管理」「已核准角色可讀」、anon 無 SELECT。
- ③ `20261020120000_instructor_document_edit_unlocks`：先查正式庫 instructor_uploads 的講師寫入政策恰為本檔重建的 3 條（無遺漏）；
  套後新守門 2 個在、舊 2 個移除、兩張新表在、3 條上傳政策都帶 is_protected_instructor_file。
- ④ `20261020130000_report_periods_and_custom_fields`：選項 160（期間 3／單位 126／梯次 31）、無期間的單位／梯次 0、回報欄位 24、
  submit_my_class_session 只剩 16 參數一版——與分支預期完全一致。
- ⑤ `20261020140000_revoke_mentor_signed_contract_reads`（業主在認領對話要求）：先查正式庫 contract-documents 的 SELECT 政策只有 1 條、
  無跨 bucket 政策（迴圈不會誤刪）；套後仍 1 條、已無「admin＋mentor 讀整個 bucket」條件、範本規則在。
- 五支全部套完後另跑一次獨立唯讀查詢，全部數值與上列一致。
- 前端：③④ 套完立刻推 `release/20261021-db-features`（649fc7b）到 main，舊前端＋新資料庫的空窗約 2 分鐘。
- 上線驗證：兩網域 10:22 連續 5 次載入 index-CYvVxNZX.js（＝本機 build）；訪客煙霧測試（首頁、找不到頁面、條款頁 chunk、console 0 錯誤）通過；
  以匿名身分唯讀打正式 API：contract_documents 回 42501 permission denied、search_unlinked_instructors 回 PGRST202（函式已不存在）。
- 待業主：管理員帳號實際拖曳一次回報選項＋新增一個期間；講師帳號看一次回報頁；後台對一位講師按「開放修改一次」試一次證件更換。

### 待業主（明早）
1. ~~**Supabase SQL Editor 依序套 migration**~~（✅ 已完成，見上段）（每支都可重跑、單一交易）：
   ① `20261019103000_restrict_contract_document_reads.sql`（合約範本 pending 不可讀；前端已上線，順序無硬性要求）
   ② `20261020010000_drop_legacy_claim_rpcs.sql`（刪 07 月舊認領 RPC＋客戶端寫入政策；**高風險漏洞**：任何剛登入的 Google 帳號可列出未認領講師並以手機末四碼綁主檔）
   ③ `20261020120000_instructor_document_edit_unlocks.sql`（分支 feat/instructor-doc-edit-unlock，證件鎖定＋後台開放修改一次；套完再上前端）
   ④ `20261020130000_report_periods_and_custom_fields.sql`（分支 feat/report-options-v4，回報選項拖曳排序＋期間清單＋自訂欄位；套完再上前端；套用到前端上線之間不要操作後台回報選項頁）
   套完各自的核對查詢寫在該分支 STATUS 段。③④ 套完告訴 Claude「已套用」即可上前端。**明早發版分支已備妥**：`release/20261021-db-features`（＝main 5a89fda＋證件鎖定＋回報選項，
   只有 STATUS.md 衝突、兩邊保留；已推 GitHub 備份），2026-10-20 02:25 依序單獨跑 43 項驗證全過（含 doc-edit-unlock 三支、
   e2e:profile-save 81/81、report-options 99/99——偶發的提示訊息時間差已修，重跑 3 次皆 99/99）。上線步驟：①②③④ 套完 → 確認
   origin/main 仍是 5a89fda（若前進就先 merge 再重跑）→ 推此分支到 main → 兩網域換版確認＋訪客煙霧測試。
2. 認領＋電子簽約（分支 feat/teacher-name-placeholder，HEAD a9d3ec3，可交付）：**不併入明早那批，單獨上線**。前提：業主在 Resend 驗證寄件網域＋建 API key；
   Supabase 確認 pg_net、pg_cron 已啟用，Vault 新增 resend_api_key、resend_from。之後依序套 `20261019233000_instructor_name_slots` →
   `20261020100000_claim_activation_esign_evidence`，**套完立刻推前端**（新舊前後端兩個方向都不相容）。已確認：明早先套 010000／120000／130000
   不影響這兩支（照正式庫實際順序模擬：verify-claim-activation-esign 219/219、e2e:onboarding 251/251）；與本批分支試合併只有 4 處新增型衝突，
   合併後 npm test 218/218、e2e:onboarding 251/251、e2e:profile-save 81/81 全過。上線後用測試講師實收驗證碼並查 email_delivery_log。
   法規待業主：R2 隱私權政策補「記錄 IP」與寄信服務商、R3 未成年講師電子簽署。
3. 業務決定：到府課時數 1／2.5／3 小時對不到報酬表規則（全部進「待核准」）；排行榜／徽章是否計入待審與被退回時數；mentor 是否該讀整個 instructor_uploads 與所有已簽合約。
4. 上線後找一位 form-import 講師實測個人頁存檔（真資料庫 e2e 已過，但正式庫可能有版控外的 trigger 改動）。

### 第二輪（可上線後修，已記錄來源）
合約換版殘留舊版無處停用、ContractView 兩版同時啟用時重複分頁、唯讀文件在最後一步可不讀完就送出、個人頁「需重新簽約」取版本未排序、
試算後改回原值誤要求人工調整、下載證書遇換版會靜默重整、主要 Email 比對未去空白／大小寫、mentor 改 Email 仍是英文錯誤、
銀行欄位鎖定逐字比對可能讓少數講師存不了檔（需唯讀查正式庫確認）。

---

## 🪪 2026-10-20：講師證件搬進系統儲存空間＋個人頁儲存修正（✅ 證件已在正式庫；✅ 程式修正已上線 c8842e7）

**需求**：業主看過 10/19 新講師建檔後說：「那些證件我會需要是真的存在資料庫並且在講師自己的資料那裡可以看到」。
業主同意連 5 位同樣只有雲端硬碟連結的舊老師一起做（侯十方、張世隆、黃于倫，以及已認領的侯宥圻、黃冠鈞）。

**查到的事實**：
- 講師個人頁（`ProfilePage.jsx`）的證件預覽只讀 `*_path`，也就是 Storage 裡的檔案。只有 `*_external_url`（雲端硬碟連結）的身分證、存摺，老師看不到圖，只有一個外連。
- 講師認領後，讀得到「自己主檔有登記路徑」的檔案（Storage 政策「Users can view files referenced by own instructor profile」）。後台代傳的檔案也算。
- **既有 bug（已在正式庫重現）**：個人頁用 `upsert(onConflict: user_id)` 儲存，Postgres 一定先跑 BEFORE INSERT 的 `guard_instructor_file_paths`。證件路徑不在 `instructors/<本人 uid>/` 的講師，只改文字也一律被擋（42501），包括 8 月 `form-import/` 匯入的 137 位、管理員在認領前代傳的。
  證據：在 SQL Editor 用「一定會取消的交易」模擬，舊送法回 `SIM_RESULT 42501 instructor file paths must remain inside the current user folder`；新送法（不帶未更動的證件欄位）回 `upsert_ok front_kept=t bankbook_kept=t`。三次模擬都已取消，正式庫沒有留下資料。

**程式修正（分支 `fix/profile-save-unchanged-docs`，worktree `.claude/worktrees/profile-save-docs`，commit `bb7c944`，已 rebase 到 `1f5c350`，未推 main）**：
- `src/lib/instructorProfile.js` 新增 `pickInstructorDocumentFields`／`omitUnchangedDocumentFields`。
- `ProfilePage.jsx` 記下載入時與每次成功儲存後 DB 的證件欄位。儲存時只送這次換掉或移除的證件，沒動的不送；upsert 只更新有送的欄位，所以 DB 原值保留。
- 驗證：`npm test` 114/114（新增 `instructorProfile.test.js` 6 項）。`verify-profile-draft.mjs` 31/31，新增 T11 四項：mock 照正式庫規則擋非本人資料夾的路徑。反向對照：改回舊送法時 T11 四項全 FAIL，錯誤文字與正式庫相同。原本的 T9c 斷言改成「存摺沒動就不送，有送也必須是 DB 正本」。變更檔 ESLint 0。
- fresh-context sonnet 審查：未發現誤清或誤留證件的問題，可上線。它查證過 PostgREST 單筆 upsert 的 `DO UPDATE SET` 只含有送的欄位。

**正式庫已做（2026-10-20 00:13–01:10 台北）**：
- 用業主的 Chrome 從雲端硬碟下載證件，經後台「編輯資料 → 選擇新圖片 → 儲存講師資料」上傳。共 **14 位、51 個檔**：今日新建 10 位 39 個檔；侯十方 4、黃于倫 4；侯宥圻、黃冠鈞「已認領那筆」各 2。
- 路徑：未認領的放 `instructors/<講師主檔 id>/<種類>/<uuid>`，已認領的放 `instructors/<user_id>/...`。
- 格式：林俊諺 3 張 HEIC、方羿淳 2 份單頁 PDF（身分證），用 macOS `sips` 轉成 JPEG 才上傳；其餘照原檔。
- 防放錯格：每位存檔前先比對每格預覽的長寬，存檔後用 SQL 總核對。結果 51/51 的「DB 大小＝Storage 物件大小＝本機下載大小」、路徑前綴正確、雲端硬碟連結 51/51 保留。
- 新建 10 位的其他欄位未被後台存檔改動：active、實習、未認領、銀行分欄空、表單時間、`bank_info_raw`、地區都在，4 筆上課紀錄仍掛著。
- 暫存的證件檔已全部刪除（`.claude/tmp-instructor-docs/` 內 0 個檔，`~/Downloads` 數量回到 899）。
- 還原：在後台該講師「編輯資料」對證件按「移除」再儲存，會清掉 `*_path` 並刪 Storage 檔，雲端硬碟連結不受影響。

**沒搬的、要業主決定的**：
- **張世隆**：身分證正面、存摺兩個雲端檔，這個 Chrome 帳號沒有下載權限（雲端回錯誤頁）。身分證反面那格是 6 頁 A4、檔名帶「備審」的 PDF，看起來傳錯檔，所以沒上傳。
- **藍恩熹**：身分證正面、反面、存摺三格上傳的是同一張圖（三檔指紋相同）。已照原樣搬進系統，請業主看一眼，要他補正確的檔。
- **重複主檔**：侯宥圻（`bbc9e1cc` 舊匯入、`06f95180`「樹懶老師侯宥圻」已認領）、黃冠鈞（`adbf7b06` 舊匯入、`822ae591` 已認領）各有兩筆。舊那筆有證件，已認領那筆原本沒有，這次補了身分證正反面。兩筆是否合併待業主決定，這次沒動。

**上線注意**：分支上線前，未認領且證件在 `instructors/<主檔 id>/` 或 `form-import/` 的講師，認領後在個人頁按儲存會失敗。這包括這次的 12 位與 8 月匯入的 137 位。建議盡快上線；上線後找一位證件在 `form-import/` 的講師實測一次個人頁儲存。

---

## 🧱 2026-10-20：課程頁章節改成網格（桌機一列 4 個）（✅ 正式環境已上線 1972eed）

**需求**：業主看「教你怎麼教 - 各種教學項目」課程頁截圖：「下方做成一列四個的呈現方式，不然這樣太長了」。

**改動**（只動 `培訓web/src/pages/LessonView.jsx`）：頁面寬度 `max-w-3xl`→`max-w-6xl`（說明文字仍限 `max-w-3xl` 保持好讀）；
章節卡片由單欄橫式改為網格 `grid-cols-2 md:grid-cols-3 lg:grid-cols-4`，卡片改直式（上：完成圈＋章節 N＋箭頭；中：標題／預覽各最多兩行；
下：hashtag／影片數／文章數標籤貼底，同列等高）；無章節時空狀態改在網格外渲染。資料讀取、連結、進度計算都沒動。

**證據（2026-10-20 本機實跑，沙盒外，mock Supabase）**：新腳本 `培訓web/scripts/verify-lesson-grid.mjs` 34/34 PASS——
1440／1280／1024 每列 4/4/1、820 每列 3/3/3、375 每列 2/2/2/2/1；同列高度差 0px、標題 ≤2 行、整頁無橫向捲軸、卡片最窄 166px（手機）；
已完成勾勾與「2 / 9 章節」、「4 影片」標籤正確、點卡片進入該章節、空課程顯示空狀態。章節區高度：桌機 555px（9 張卡片）。
截圖 `培訓web/docs/verification/2026-10-20-lesson-grid/`（6 張），fresh agent 看圖判讀：網格、陰影、截斷、對齊皆無問題。ESLint 該檔 0 問題。

**待辦**：業主同意後 commit 並上線（本 worktree 目前在 `security/restrict-contract-document-reads` 分支，上線需另拉到 main）。

**地雷（既有、非本次）**：頂部選單列在 768px 以上就切成桌機版（`Layout.jsx:135` `hidden md:flex`），管理員選單項目多，平板寬（約 820px）
時選單文字被擠成直排、右側使用者名稱被切掉；講師帳號項目較少是否也會擠到未驗。建議把切換點改到 `lg`。
同 worktree 另有並行工作的未提交改動（`InstructorList.jsx`、`verify-instructor-list-layout.mjs`），非本次，commit 時勿混入。

---

## 🧹 2026-10-20：後台「講師資料總覽」表格版面修正（✅ 正式環境已上線 1972eed）

**需求**：業主截圖「這個頁面下面的欄位看起來亂亂的，有一些還有奇怪的換行」——「未認領」「未取得」被擠成直排、表頭「速解資格」斷兩行、最右邊「預覽表單」被外框切掉。

**原因**：8 欄每格左右 24px 留白＋Email 獨立一欄，後台內容區最寬也只有 1216px（Layout `max-w-7xl`），整張表塞不下，標籤被擠成直排，外框 `overflow-hidden` 又把最右欄切掉。不是螢幕太小。

**改了什麼**（只動 `培訓web/src/pages/admin/InstructorList.jsx`）：
- Email 收進姓名欄下方（lg 最寬 14rem／xl 20rem，一般長度完整顯示、超長才截斷，滑過看全文），表格 8 欄→7 欄；留白 lg 10px／xl 16px；標籤、表頭、按鈕一律不換行。
- 綁定～操作 6 欄寬度貼齊內容（`w-px`），多出來的寬度給「講師」欄；「操作」表頭改靠左、對準按鈕。
- 表格改從 1024px（lg）起顯示，以下用卡片；1024–1279px 按鈕縮成「編輯／預覽」（aria-label 仍是完整名稱，舊驗證腳本不受影響）；外框改 `overflow-x-auto`，再擠也只會出現捲軸、不會切掉按鈕。
- 卡片版：綁定／解綁緊跟認領標籤、地區顯示「N 個縣市」（原本只有數字）、按鈕獨立一行對齊；地區摘要抽成共用 `RegionSummary`。

**證據（2026-10-20 本機實跑，沙盒外）**：新腳本 `node scripts/verify-instructor-list-layout.mjs` **49/49 PASS**（mock Supabase、1024／1280／1440 桌機＋900 平板：表頭 7 欄單行、28 個標籤單行、14 顆按鈕單行且沒被切、表格不超出外框、列高一致 69–70px、「操作」對準按鈕差 0px、精簡欄多餘空白 0px、一般長度 Email 不截斷、展開列跨 7 欄、卡片按鈕對齊；另派兩輪 agent 看截圖判讀，指出的欄距不均／操作標題錯位／卡片按鈕參差都已修）；截圖 `培訓web/docs/verification/2026-10-20-instructor-list-layout/`。回歸：`verify-claim-admin-ui` 6/6、`verify-admin-instructor-editor-ui` 3/3、`verify-contract-feature-enabled` 40/40（重生的 10-18 截圖已還原）、`npm run build` 通過、ESLint 0 問題。

**待業主**：同意後上線（本 worktree 目前在 `security/restrict-contract-document-reads` 分支且有並行對話的 `LessonView.jsx` 改動，上線要另開乾淨 worktree 從 origin/main 只帶這個檔）。

**地雷／順手發現（未處理）**：頂端導覽列在 900–1024px 寬時「我的課程」「後台管理」等會被擠成直排／兩行、「管理員」徽章斷行（`src/components/Layout.jsx`，所有頁共用，另案處理）。

---

## 🔒 2026-10-19：合約範本讀取只給已核准角色＋簽署 PDF 可信度評估（✅ 前端已上線 1972eed；🟡 migration 待業主套正式庫）

**來源**：10-18 簽約重開的資安審查提到兩筆既有設計債（非該次引入）：① `contract_documents` 的 SELECT 政策是 `USING (true)`、
storage 對 `contract-documents` bucket 非 `signed/` 路徑全體登入者可讀——任何 Google 帳號首次登入即為 `pending`，等於任何人登入後
直打 PostgREST／Storage API 就能列出並下載「講師委任報酬表」等範本；② 簽署 PDF 由瀏覽器產生再上傳，RPC 只驗存在不驗內容。

**第一部分（已實作，分支 `security/restrict-contract-document-reads`，未推 main、未碰正式 Supabase）**：
- 新 migration `supabase/migrations/20261019103000_restrict_contract_document_reads.sql`（可重複執行、只改政策）：
  `contract_documents` 讀取改為單一政策「Approved roles can read contract documents」＝`users.role IN ('teacher','mentor','admin')`，
  同時移除舊的 `USING (true)` 政策與後台若手動加過的其他 SELECT 專用政策（迴圈清掉，permissive 政策是 OR 關係，留著等於沒收緊），
  並 `REVOKE ALL … FROM anon`；管理員 FOR ALL 政策不動。storage 的「read contract documents scoped」重建：本人 `signed/<uid>/`、
  admin／mentor 整個 bucket 兩條規則原樣保留，**非 `signed/` 路徑（範本）改為只給已核准角色**。`contracts_setup.sql` 同步同一組政策。
- 前端：`featureFlags.canAccessInstructorContracts` 原本開關打開時對 pending 也回 true，待審帳號的個人頁會顯示「尚未簽約」區塊並查
  `contract_documents`（點進 `/contract` 又被導回待審頁）；改為只有 teacher／mentor（admin 永遠可）才為 true，與後端 RLS 一致。
  pending 可到達的路由只有 `/profile`（allowPending），其餘 `/contract`、`/contract/view`、所有 `/admin/*` 都會把 pending 導走，
  所以前端沒有任何 pending 需要讀 `contract_documents` 的路徑（驗證腳本有靜態檢查）。
- 新驗證腳本 `scripts/verify-contract-document-reads.{mjs,sql}`、npm `verify:contract-document-reads`。

**證據（2026-10-19 本機實跑，沙盒外）**：`npm run verify:contract-document-reads` SQL 11 項 PASS＋靜態 4 項：引導區先重現漏洞
（pending 讀到 6 列文件、5 個範本檔）→ migration 連跑兩次 → `contract_documents` 只剩 1 條 SELECT 政策＋管理員 FOR ALL、storage 讀取政策
1 條且含 teacher 條件、anon 無表級權限（直查回 42501、storage 0 列）；pending 文件 0 列、範本 0 檔、只看得到自己 `signed/` 底下那個檔、不能寫；
teacher 看到的列與收緊前相同（全部 6 列；簽約頁 3 份且順序 rules→compensation→contract；個人頁版本比對 3；合約檢視頁 4；匯款表單模板取到 v2），
範本 5 檔可讀、自己的簽署檔可讀、別人的 `signed/` 讀不到、不能寫；mentor 讀全部 6 列與 bucket 全部 9 檔（行為未變）；admin 讀全部、講師名單 1、
下載中心 2、增改刪照常；新建庫路徑（`contracts_setup.sql` 兩次＋再疊 migration）政策集合相同。另 `npm run verify:contract-signing`
16＋3 項 PASS、`npm run verify:contract-signing:browser` 40/40（截圖重生後已還原，不入本 commit）、`npm test` 74/74（新增 featureFlags 2 項）、
`npm run build` 通過、變更檔 ESLint 0 問題（全專案 5 個既有問題在 FieldPositionEditor／ContractView／AssignmentReview／ProgressOverview，非本次）、
`git diff --check` 乾淨。

**待業主**：① 在 Supabase SQL Editor 以單一交易套用 `20261019103000_restrict_contract_document_reads.sql`（只改政策、不動資料；
套用後 pending 帳號個人頁不再顯示簽約區塊、講師與管理員不受影響）；② 套完合併本分支到 main 推前端（順序無硬性要求：先套 migration 時，
pending 的個人頁查詢只是回 0 列不報錯；先推前端時 pending 單純看不到區塊）；③ 套用後用一個 pending 帳號對 `/rest/v1/contract_documents`
與 `/storage/v1/object/contract-documents/<範本路徑>` 各打一次確認拿不到，再用講師帳號開簽約頁確認三份文件仍載入。

**第二部分（評估，未實作）**：`培訓web/docs/decisions/2026-10-19-signed-pdf-trust-options.md`。結論：**建議先做輕量方案 B**
（範本上傳時記 SHA-256、已被引用的版本凍結不可改、RPC 寫入時由伺服器端把範本雜湊抄進 `instructor_contracts`、管理員可隨時重製 PDF，
估 0.5–1 天、零新基礎設施）；伺服器端套印（Edge Function）估 3–5 天，要新增 Deno 部署管線與嵌入繁中字型，留待法務要求「PDF 檔本身必須是正本」
或簽約量成長時再做。文件第 5 節另列「mentor 是否該讀 `signed/` 檔」：現況 mentor 可用 Storage API 列出並下載所有講師含個資的簽署 PDF，
但畫面上沒有合約入口（「畫面沒有、API 有」）；建議選②從 storage 政策拿掉 mentor 的整個 bucket 讀取，業主決定。

**地雷**：`contract_field_positions` 的 SELECT 仍是 `USING (true)`（只有座標、無個資，先不動）。驗證腳本在沙盒內會因 PostgreSQL 共享記憶體
（`shmget: Operation not permitted`）起不來，要在沙盒外跑並帶 `LC_ALL=C`。

---

## 👥 2026-10-19 晚：表單新講師 10 位建檔（✅ 正式庫已寫入）

**需求**：業主說「表單回應1」約第 213 列以後有新老師加入，請為他們建檔。來源是「講師 資料總表 23年啟用永久版」試算表的「表單回應1」分頁，最後一列是第 227 列。
**比對（唯讀）**：第 201～227 列共 27 位，以 Email 和姓名比對 `instructors`：有 17 位已有主檔（第 213 列曾唯銘、214 謝祐萱、216 黃于倫、222 蔣礪等），**10 位沒有**：
第 217 楊宙學、218 林俊諺、219 王晨瑄、220 劉浩鈞、221 方羿淳、223 藍恩熹、224 江鎧任、225 呂姿瑩、226 陳鈺昊、227 羅青昊。
10 位都沒有登入帳號（`auth.users`、`public.users` 皆無）。

**做法**：在 Supabase SQL Editor 跑單一交易（業主的 Chrome 分頁，業主在對話同意「10 位全部建」「上課紀錄要，順便掛上」）。
- 欄位對應與正規化沿用 `scripts/instructor_data_reconciliation.py`：clean、性別依身分證、生日、地區、bio_notes 組合、戶籍／通訊地址分欄、`nickname`＝Line 名字。
- 另有 3 處補充規則：手機少了開頭 0 就補回（試算表吃掉的）、「苗栗市」對到苗栗縣、Email 存小寫。
- 等級一律「實習」（10 位表單都選實習講師），`employment_status`＝`active`。身分證、存摺照片的 Drive 連結也寫入。
- 每列 `note_internal`＝「2026-10-19 依講師資料總表「表單回應1」第 N 列建檔（後台代建，未認領）」，之後就靠這句話找回這 10 筆。
- **銀行分欄（bank_code／name／branch／account）刻意留空**：手邊沒有金管會機構代號表，不猜；而且這些欄位寫入後講師本人就改不了。匯款原文存在 `bank_info_raw`。
- 同一交易把 3 位既有的 4 筆上課紀錄掛上 `instructor_id`（10/19 新總表匯入的：楊宙學 9/1 兩筆、藍恩熹 9/12、陳鈺昊 9/12），金額與狀態不動。

**證據**：
- 先跑預演（同一份腳本，結尾故意拋錯取消），回 `REHEARSAL_OK 主檔 10 身分證正面 10 反面 10 相片 9 存摺 10 上課紀錄 4`。之後查講師總數仍 265、未掛紀錄仍 4，確認沒留下東西。
- 正式跑回 Success。讀回核對：新列 10、講師總數 265→275、10 位皆未認領、Email 全庫唯一（首次 Google 登入能自動認領，不會撞名）、存摺連結 10、銀行分欄 10 位皆空、4 筆上課紀錄已掛上且仍是 approved（300／375／1950／1641）、未掛紀錄 0。
- 正式站 `teacher.dreamcube.tw/admin/instructors` 頁面文字可找到全部 10 個姓名。

**副作用（預期內）**：楊宙學 9/1 兩筆同日同課名（臺中科博館－預約課程，300 與 375），掛上講師後 `detect_session_anomaly` 把其中 375 那筆標為「同講師同日同課程名可能重複」。後台「異常」數會多 1，請業主看一眼是否真的是兩堂。

**待辦／地雷**：
- 藍恩熹：沒有身分證字號（表單填「沒有」，智利籍），地址只寫「台南」，匯款原文看不出銀行，講師照片沒上傳。需本人補資料；是否要居留證號請業主決定。
- 陳鈺昊：2010-05-01 生，未滿 18 歲。簽約是否需要法定代理人同意，請業主確認。
- 10 位第一次登入會被導到個人資料頁補銀行分欄（系統原本就這樣設計）。
- 還原方法：先把 `class_sessions` 中 `instructor_id` 屬於這 10 位（用上面那句 `note_internal` 找）的紀錄改回 null，再刪除 `note_internal like '2026-10-19 依講師資料總表「表單回應1」%' and user_id is null` 的列。
- 下次再有新表單回應，可照同一流程，從第 228 列往後比對。

---

## 🚗 2026-10-19：回報頁交通補助加業主備註（✅ 正式環境已上線）

**完成＋證據**：業主指示在講師回報頁的交通補助旁加備註「超過15公里才得以申請，需要事先和課程經理確認，交通方式也需提前報備確認」。
文字放在 `src/lib/salaryReportForm.js` 的 `TRANSPORT_SUBSIDY_NOTE`，`MySalaryNew.jsx` 在交通補助開關下方以紅色小字顯示（直營與營隊都有交通補助，兩邊都會出現；合作課沒有交通補助所以不顯示）。
**只提示、不擋送出**：15 公里沒有寫成驗證規則，講師填 12 km 仍可送出，由課程經理核薪時把關（業主沒有要求擋）。
`npm test` 97/97、ESLint（改動檔）0 錯、`npm run build` 通過；`npm run verify:salary-report-form:browser` 44/44 PASS（新增一項「交通補助旁顯示業主備註」，390px 手機無水平溢出），截圖在 `docs/verification/2026-10-19-salary-report-form-channel/`（`desktop-direct-transport.png`、`mobile-390-direct.png`）。
**上線**：使用者同意後推 main（`e9bb3cc`，22:31 台北）；22:32 正式站首頁改載 `index-BSkcL6t_.js`，之後連續 5 次（間隔 15 秒）皆為新版且含備註全文；正式站程式包與本機建置 md5 相同（`2961cee0c3b3cc22054394560248f6de`），即上線的就是本機實測過的那一版。正式站頁面需 Google 登入，未在正式站以講師身分開回報頁目視（登入需使用者本人帳號授權）。
**半成品**：無。
**下一步**：無（業主可登入後到「回報課程」頁目視確認）。
**地雷**：無新增。

---

## 💰 2026-10-19：薪資總表換新——舊匯入隔離、正確版成為正式資料（✅ 正式庫已完成）

**需求**：業主貼上「確定正確」的薪資總表（5,535 筆，2025/7 底～2026/10/17，192 位講師），指示「之前有異常的資料先獨立隔離起來，
之後再整理；先以這份為最新的讓大家可以查詢」，並問異常為何這麼多。業主同意方案：舊匯入整批搬隔離區、新表整份匯入、
22 筆打錯的年份更正並保留原文在備註；先本機演練＋線上唯讀預檢，有意外再停。

**異常成因（給業主的答覆）**：① 網站薪資是 5/15 從舊總表「所有薪資登記」一次匯入（9,551 列扣 19 列無日期＝9,532），之後沒同步，
2026/4 下旬起 1,864 筆網站上沒有；② `detect_session_anomaly` 規則 1「同講師同日同課名＝疑似重複」大量誤標（785 筆異常中 616 筆）；
③ 總表真手誤：年份打錯 22 筆（19 筆 2026/12 實為 2025/12、2000／2005 年各 1／2 筆）、鄭樺琛 32,000 填在備註（新表已改）、人數寫成文字 22 筆；
④ 新表 81 組 16 欄完全相同的列（多 91 筆、74,621 元），曾瑀希 2025/11/26–12/24 新竹康橋／康乃薾／南瓜田整段重貼 2～3 次約 32,080 元，**疑似重複發薪，待會計確認**
（清單 `data-private/待確認_完全相同的重複列.csv`，不進版控）。新舊重疊期間 3,570 筆逐欄相同，另 101 筆只差課程自評／特殊狀況回報（金額相同）。

**做法**：migration `培訓web/supabase/migrations/20261019120000_salary_master_quarantine.sql`（只建結構）：`salary_master_rows`（總表逐列原文＋換算欄，
`class_session_id` 預先產生並沿用為 class_sessions.id）與 `class_sessions_quarantine`（LIKE class_sessions＋批次／原因／時間／新總表對應列號）；
兩表 RLS 只給 admin SELECT，網站端無寫入權。隔離必須是另一張表：異常 trigger 規則 1 會拿整張 class_sessions 比對。
資料操作在 `scripts/salary_master_import/`：`build_upload_csv.py`（換算規則同 5 月 `import_salary_history.py`＋22 筆年份更正）、`01_preflight.sql`、
`02_check_upload.sql`、`03_apply.sql`（單一交易＋LOCK；原文與換算欄雙指紋、無 U+FFFD、筆數、金額合計任一不符即回滾；只動 source='historical_import'）、
`04_postcheck.sql`、`99_rollback.sql`（逐欄還原）、`repair_rows.py`、`rehearse_local.py`。同名講師：舊紀錄若固定掛同一位就沿用（黃冠鈞 157 筆），否則留空不亂配。

**本機演練**：臨時 PostgreSQL 依 migration 鏈建庫、照 5 月方式放回 9,532 筆＋3 筆網站紀錄，跑完整流程：61/61 PASS（空字串／NULL 兩種上傳情境、
切壞中文字會被擋並可修補、重跑被擋、權限、還原後 class_sessions 逐欄相同、還原後可再執行）。紀錄：`培訓web/docs/verification/2026-10-19-salary-master-import/local-rehearsal.txt`。

**正式環境證據（2026-10-19 14:40–14:55 台北，Claude 透過業主 Chrome 的 Supabase SQL Editor／Table Editor 操作；業主事前同意執行）**：
預檢 class_sessions 只有 historical_import 9,532 筆（薪資 17,170,952、獎金 1,747,477，與舊表模擬逐元相同）、無網站回報、無人改過、無外鍵指向、異常 785。
貼上的每份 SQL 都先以 SHA-256 比對與本機檔案一致才執行。Table Editor 匯入 CSV 後**原文指紋不符**：匯入工具分段讀檔，切點落在中文字中間造成 6 格 U+FFFD
（列 645、1255、1878、3364、3941、4234 各 1 格），以 `repair_rows.py` 只修那 6 格後雙指紋皆符、無亂碼。執行 03 回 Success。
事後核對：class_sessions＝5,535 筆（全來自新總表，薪資 10,271,061、獎金 453,547）；隔離區 9,532 筆（新總表有相同列 3,570、沒有 5,962：2023 年 1,901、
2024 年 2,258、2025 年 1,710、2026 年 87、其他年份 6）；講師對應 matched 5,232＋沿用舊對應 157＋找不到 146（60 個名字，多為永續營隊、行政、單次活動人員）；
22 筆年份更正正確；異常標記 785→479（重複規則 427、有時數無薪資 58）；講師 2026 起可見 3,214 筆。模擬講師登入：看到 56 筆＝應看 56 筆、2026 前 0、
隔離區 0、暫存表 0；外部匿名 REST 讀隔離區與暫存表皆 401 `42501`。

**第二批：25 筆推估更正（✅ 正式庫已完成，2026-10-19 晚）**：業主看過推估清單後指示「把握七成以上的推估修正套用到正式資料，原值保留在備註；
余睿 2 筆和侯十方先不動」。實際為 25 筆（我先前回報寫 26 是加總算錯，已向業主更正）：人數寫成文字 21 筆改為加總（如「30+30」→60、
「低年級18 高年級15」→33、「20人」→20）、人數 -1 兩筆（林毓翔→4、吳冠霖科博館櫃台→0）、巫婉榆 2025/8/22 康軒營隊時數 0→9、
劉韶瑜交通補助 2025/1/17→2026/1/17（備註「2025年12月馬胎營隊」）。每筆備註附「［原登記…，2026-10-19 業主同意推估為…］」。
`scripts/salary_master_import/build_inferred_fixes.py` 由上傳檔核對原文後產生 `05_apply_inferred_fixes.sql`（單一交易：原文、現值、未更正過三重比對，
薪資與獎金合計不變才提交）與 `95_rollback_inferred_fixes.sql`。本機演練 71/71（含重跑被擋、還原逐欄回原狀、可再套用）。
正式庫：貼上內容 SHA-256 與檔案一致後執行（Supabase 對交易內暫存表 `_fix` 跳 RLS 提醒，選照原樣執行；該表交易結束即刪除），回 Success；
唯讀核對 25 筆數值與備註全部正確、帶更正說明的列恰 25 筆、薪資 10,271,061／獎金 453,547 不變、總筆數 5,535。
推估清單與疑似重複清單：`data-private/待確認_可推估更正與疑似重複.csv`（不進版控）。

**待辦**：① 會計確認疑似重複登記（曾瑀希 2025/11/26–12/24 整段約 32,080、2025/12 到府約 4,450、2026/3/27 南瓜田 960；畢德煒 2026/7/27 靜心小學 12,400；陳宇浩 2025/8/26–27 共 1,350；陳柏睿 2024/2 王薇菁 4 筆年份）；余睿 2024/8 兩筆（可能是 2025/8，把握約六成）與侯十方人數「1 0」待業主確認；② 60 位對不到講師名單的人若需要在網站查薪資，先在講師名單建檔，再補 instructor_id；
③ 隔離區 5,962 筆「新總表沒有」待業主決定怎麼整理（大多是 2023/7～2025/7 中的歷史，新表沒涵蓋，不代表錯）；④ 排行榜／徽章讀 class_sessions 2023 起，
現在只剩 2025/7 底起的場次；⑤ 之後薪資以網站回報還是試算表為準要定案，否則會再次不同步。

**地雷**：Supabase Table Editor「Import data from CSV」會把多位元組中文字在分段處切壞成 U+FFFD，數字欄不受影響、筆數也對，只有逐字指紋抓得到——
之後用它匯入中文資料，一定要上傳後比對指紋。Chrome 擴充功能讀 SQL 結果時，含 `session` 等字的 JSON 鍵會被遮成「[BLOCKED: Sensitive key]」，要改名讀。

## 📄 2026-10-19：後台薪資登記中心改伺服器端篩選＋分頁（✅ 正式環境已上線）

**問題**：10/19 換新薪資總表後 `class_sessions` 有 5,535 筆（2024/02～2026/10），`/admin/salary`（`SalaryRegister.jsx`）只抓
`session_date` 最新 500 筆再在瀏覽器裡篩月份／狀態／異常，管理員看不到較早月份；待處理與異常數字也只算那 500 筆。是既有程式限制，不是資料問題。

**做法（純前端，無 migration、不改 RLS、不改資料；admin／mentor 權限照舊）**：新檔 `培訓web/src/lib/salaryRegisterQuery.js`
（純函式＋單元測試）。月份改送 `session_date >= 該月1日 AND < 下月1日`，狀態 `status=eq.`、異常 `is_anomaly=eq.true`、搜尋
`or=(instructor_name|course_name|course_type ilike "%字%")`（停止輸入 300ms 才送；搜尋字裡的 `, ( ) " \ % *` 換成單字元萬用字 `_`，
不會弄壞查詢）都在 Supabase 端過濾。列表每次 100 筆，底部「已顯示 X／Y 筆」＋「載入更多（再 N 筆）」。排序改由伺服器做：
`status` 升冪（enum 宣告順序 pending→approved→paid，等於舊版「待處理優先」）→ 日期新到舊 → id，分頁不漏不重。
統計卡（篩選筆數、總薪資、已付、未付）另外以 1,000 筆一段抓 `total_salary, paid_amount` 算整個篩選範圍，不是只算已載入那頁。
**行為變化**：① 預設月份＝最新一筆紀錄的月份（不會跑到未來月份），月份選單列出最早到本月每個月；② 「待處理 N」「異常 N」改為全庫數字
（HEAD＋count=exact），點下去會同時切到「全部月份」，早期月份的待辦也看得到；③ 標題「共 N 筆紀錄」是全庫筆數；④ 核准／修改儲存後
重載會保留已載入的筆數（以 1,000 筆一段重抓），不會跳回第 1 頁；查詢失敗顯示錯誤＋「重新載入」，從第 1 頁重來；⑤ 在某月份畫面新增
另一個月份的紀錄，存檔後自動切到那個月，看得到剛存的那筆；⑥ 搜尋只在目前選的月份裡找（要找某講師全部紀錄請先選「全部月份」）。
**多人同時操作**：「載入更多」每次多抓上一頁最後一筆當接縫，接縫位置變了（別人新增／刪除／改狀態讓排序移動）、總筆數變了、或出現重複，
就自動整批重抓到「已載入＋100 筆」，不漏筆、不重複、按鈕不會卡住；概況數字只採用最後一次請求的回應。

**驗證（2026-10-19 本 session 親跑，worktree `.claude/worktrees/salary-register-paging`）**：`npm test` 90/90（新增
`salaryRegisterQuery.test.js` 18 項：月份區間跨年、月份選單（含打錯成 2062 年／0202 年仍有本月）、預設月份、搜尋字清理、篩選與排序都送到
查詢端、分段抓資料在伺服器每次上限比 chunk 小時也不漏、分段之間有新增時不重複）；`npm run verify:salary-register-paging:browser`（新腳本，mock Supabase 照網址條件真的過濾／排序／分頁／計數，
放 5,535 筆、2025/08 有 607 筆，本機 vite dev，沙盒外）**38/38**：正常載入更多每次 1 個請求（offset 99、199…，101 筆含接縫）、
瀏覽中把 3 筆待核准改成已付款後按載入更多會自動重抓成伺服器現況且載到底 607 筆不卡、在 2026/10 新增 2025-08-15 的紀錄後自動切到 2025/08
並看到該筆（608 筆），以及選 2025/08 先顯示 100／607、統計卡為整月 607 筆、載入更多後 607 筆
全部看得到且順序與期望完全一致、狀態＋異常＋講師搜尋＋含逗號括號的搜尋、全部月份 100／5,535 且統計分 6 段抓完、點待處理切到全部月份
看得到 2025/03 的待處理、第 2 頁修改儲存後仍 200 筆、查詢失敗可重新載入、mentor 可進入、桌機與 390px 無水平溢出、390px 載入更多按鈕
滿版高度 ≥44px。截圖 11 張在 `培訓web/docs/verification/2026-10-19-salary-register-paging/`，由 sonnet agent 判讀：皆無跑版、錯誤框或截斷。
回歸：`verify:salary-report-form:browser` 37/37、`verify:salary-report-options:browser` 37/37（第一次跑 36/37 是「改名後畫面顯示新文字」
偶發時序，連跑兩次皆全過，與本改動無關）、`verify:speed-salary:browser` 13/13（該腳本 mock 補上 HEAD 計數，原本把 HEAD 當寫入回空值）。
`npm run build` 通過（2.38MB 單一 bundle 警告為既有）；變更檔 ESLint 0 問題；`git diff --check` 乾淨。

**審查**：fresh-context sonnet 審查員讀 diff：未發現會讓資料錯誤或頁面卡死的高風險問題；提出 6 個邊角問題，已修 5 個
（載入更多遇到別人同時改狀態會漏筆且按鈕卡住→接縫檢查＋自動重抓；分段抓取中途新增會重複→fetchRows 依 id 去重、統計多抓 id；
概況舊回應蓋新數字→請求序號；打錯遠未來日期時月份選單缺本月→上限本月後 24 個月並補打錯的月份；核准後重載 100 筆一段太多請求→改 1,000 筆一段），
另加「新增其他月份紀錄後自動切月」；未改的 1 個是「搜尋只在選定月份內」，屬設計選擇，已寫進行為變化⑥。

**正式環境證據（2026-10-19 21:32–21:40 台北）**：使用者指示「同意，把 fix/salary-register-paging 推上 main 上線，上線後確認正式站已換成新版」。
第一次推送被拒（另一條工作線剛推上回報表單第二版 `0019174`）；fetch 後合併為 `d019ee6`（STATUS.md 衝突兩段都保留），合併後重跑
`npm test` 97/97、build、ESLint、`verify:salary-register-paging:browser` 38/38、`verify:salary-report-form:browser` 43/43、
`verify:salary-report-options:browser` 37/37；推送前核對線上部署 `0019174` 是候選的祖先（不會回滾別人），13:32 UTC fast-forward 到 `main`。
GitHub deployment `7175179572` success（13:33:05 UTC），13:34:52 被另一條工作線的 STATUS 紀錄 commit `71e52ac`（接在 `d019ee6` 之後，含本次）取代。
每 60 秒探測兩個網址，13:33 起連續 5 次命中含「載入更多（再」的新程式包 `index-bEU2INyI.js`（SHA-256 前綴 `b97a12b1ee7b1d5b`；推送前為 `index-s08QVe72.js`，0 次命中）。
**真 PostgREST 語法實測**：以公開 anon key 對正式庫送與頁面相同的查詢（月份區間＋status＋is_anomaly＋`or=(…ilike."%A_B _%")`＋`order=status.asc,session_date.desc,id.desc`＋offset／limit）
回 HTTP 200（anon 受 RLS 為 0 筆，未讀到任何資料）、HEAD 計數 200；對照組不加引號送含逗號括號的 or 回 400 PGRST100——語法確認被正式 PostgREST 接受。
未送出任何寫入、未改正式資料。

**管理員帳號實查（2026-10-19 晚，使用者在自己的 Chrome 登入 `teacher.dreamcube.tw` 後，經 Claude in Chrome 只看不改）**：
程式包 `index-bEU2INyI.js`；標題「共 5,535 筆紀錄」；預設月份 2026/10（6 筆，已顯示全部 6 筆）；月份選單 34 項（全部月份＋2026/10～2024/02）；
選 2025/08 先「已顯示 100／607 筆」、統計卡篩選筆數 607，按 6 次載入更多到「已顯示全部 607 筆」，607 列日期全在 2025-08、按鈕消失；
排序檢查 604 筆已核准在前、3 筆已付款在後且同狀態內日期新到舊（正式庫 enum 順序 approved < paid 成立；全庫目前 0 筆待處理，故「待處理」按鈕未出現、
pending 排最前無法在正式資料上看到）；2025/08 內搜尋第一位講師 → 已顯示全部 29 筆、全是該講師且都在 8 月；搜尋「A,B (」→ 沒有符合的紀錄、無錯誤；
「異常 480」按鈕 → 自動切全部月份、已顯示 100／480 筆、第一頁跨 5 個月且每列都是異常紅底；重新載入後 console 0 個錯誤。檢查完已還原 2026/10、清空搜尋並關閉分頁。
注意：`dream-one-teacher.zeabur.app` 與 `teacher.dreamcube.tw` 登入狀態不共用（不同網域各自登入）。

**還沒驗到的**：手機 390px 寬只在 mock 驗過（未調整使用者 Chrome 視窗大小）；「待處理」按鈕與待核准排最前因正式庫目前 0 筆待處理，等有講師回報時自然會看到。
**地雷**：`npm run verify:speed-salary:browser` 在講師回報頁那段找不到 `input[inputmode="decimal"]`（回報頁第二版把 B2C 時數改成下拉），
乾淨的 `origin/main` `0019174` 同樣失敗，屬第二版未同步更新的舊腳本，非本次引入；後台那段的 HEAD 計數 mock 已由本次補上。
→ 已修（分支 `fix/speed-salary-verify-v2-form`，只改測試腳本）：講師段改照第二版三層選課（B2C → 速解研究所｜實體課程）、
填課程名稱／時數下拉／人數；未取得資格那段改為時數人數都填好、只剩「沒有速解資格」才待核薪，並驗送出的課程類型；`npm run build` 後 13/13 PASS、ESLint 0。

## 🧭 2026-10-19（第三版）：全站「薪資」改「報酬」、合作單位分寒暑假／學期間、期間文字照表單、到府課免選報酬項目（✅ 正式環境已上線）

**需求（業主 2026-10-19 晚間）**：① 全部提到「薪資」的部分改成「報酬」；② B2B 寒暑假和學期間兩題分開，後台可各自改，選到某個期間時下面的單位選項對應好；
③ 寒假／學期間／暑假文字要和表單一樣（2026年寒假、115學年度上學期、2026年暑假），後台可設定、好設定且直覺；④ B2C 上課日期欄位位置固定，不要跳來跳去；
⑤ 到府課不要「報酬項目」（同時有到府 1.5 又可選時數很怪）。

**做法**：
- **migration `supabase/migrations/20261019220000_partner_units_by_term_and_period_labels.sql`**（可重複執行，只加欄位與回填，不刪資料、不動 RLS／RPC）：
  `salary_report_options` 加 `term_scope`（vacation＝寒暑假、semester＝學期間；只有 partner_unit 有值）；回填 10/18 種子的 78 個單位（名稱含「115上」或 sort_order ≥ 490 → 學期間，
  其餘寒暑假 → 48／30）；加 CHECK（合作單位必有組別且只能是這兩值，其他種類必為 NULL；**明寫 IS NOT NULL**，否則 NULL 會讓 CHECK 放行——隔離庫測出來才補的）；
  期間三列 label 只在仍是預設「寒假／學期間／暑假」時改成表單文字，管理員改過的不覆寫。`2025_salary_system.sql` 同步欄位與索引。UNIQUE (kind, value) 不變 → 同一單位名稱不能同時在兩組。
- **講師回報頁 `MySalaryNew.jsx`**：上課日期固定在「回報類別」之後第二格，三個類別都一樣；選期間才出現對應那組單位（未選期間時下拉停用並提示「請先選擇教學課程期間」；
  換期間會清掉已選單位；選項還沒有 term_scope 時退回整份清單不擋回報）；到府課不顯示報酬項目，時數 ≤ 1.5 自動送 `onsite_1_5hr`、其餘 `onsite_2hr`（`deriveCourseType`）。
- **後台回報選項管理頁**（sonnet agent 實作，主對話覆核）：合作單位分頁改兩顆切換鈕「寒暑假清單／學期間清單」各自新增、組內排序、每列可「移到另一組」；
  期間分頁改三列固定卡片（用途／講師會看到的文字／帶出哪組清單）＋說明「每學期開始前改成當期名稱，例如 115學年度下學期、2027年寒假」。
- **「薪資」→「報酬」**：`MySalary.jsx`、`MySalaryNew.jsx`、`SalaryRegister.jsx`（頁名改「報酬登記中心」）、`Dashboard.jsx`、`NotificationManager.jsx`、`PrivacyPolicy.jsx`、`salary.js`、
  `SalaryReportOptionsManager.jsx`、`salaryReportOptions.js` 與相關驗證腳本；程式識別字（salary）與網址（/admin/salary）不變。「核薪」「待核薪」沒有「薪資」二字，維持原樣。

**驗證（主對話 2026-10-19 親跑）**：`npm test` 106/106；`npm run verify:salary-report-form`（隔離 PostgreSQL）全 PASS，含新增 (g) 回填 48／30、含 115上 的列全在學期間、
預設期間文字已改、管理員改過的保留、migration 連跑兩次；(h) CHECK 擋無組別／怪組別／非合作單位帶組別；新建庫路徑 2025 → 20260826 → 20261018 → 20261019 可用；
`verify:salary-report-form:browser` 50/50（新增：日期固定第二格 ×3 類別、到府無報酬項目、時數 2→onsite_2hr／1.5→onsite_1_5hr、期間文字照表單、選寒假只列寒暑假清單、
改學期間清掉已選單位、未選期間提示）；`verify:salary-report-options:browser` 56/56；`npm run build` 通過；ESLint 0；`git diff --check` 乾淨；src 內「薪資」0 處。
截圖：`docs/verification/2026-10-19-salary-report-form-channel/`（10 張）與 `docs/verification/2026-10-18-salary-report-options/`（6 張，本次覆寫）。

**追加（2026-10-19 深夜，業主：「核薪／待核薪改成核准和待核准，有薪這個字全名不就是薪資嗎」）**：介面文字「待核薪」→「待核准」、「核薪」→「核准」、
「時薪」→「每小時」；後台報酬登記中心原本「（待核薪 N）」改為「（N 筆尚無金額）」，保留「還沒有金額」這個資訊（否則與既有的「待核准」狀態分不出來）。
`pricing_status=needs_review` 的意義不變（仍是管理員要填金額），只是講師與管理員看到的字一樣叫「待核准」。驗證：`npm test` 106/106、變更檔 ESLint 0、
`verify-speed-salary-ui` 9/9、`verify:salary-report-form:browser` 51/51、build 通過；src／scripts 內「薪」字 0 處（另一條工作線的 `salaryRegisterQuery.js` 註解除外）。
**上線證據**：業主「可以，推上 main 部署」後 `52f2b4a` fast-forward 推上 `main`（15:39 UTC），GitHub deployment `7178131174` success（15:40:50 UTC）；
每 60 秒探測正式站，15:41 起連續 5 次命中 `index-CX0z0Cbk.js`（SHA-256 前綴 `37d682368cc6e644`），內含「筆尚無金額」、不含「核薪／待核薪／時薪」。

**正式環境證據（2026-10-19 23:15–23:32 台北）**：業主指示「可以，幫我把 migration 貼進 Supabase SQL Editor，我按 Run，然後推上 main 部署」，
隨後明確要求「你按 Run」。Claude 透過 Chrome 擴充功能在 DreamCube_teacher（PRODUCTION，ref `mnovjlicwzwkefkhstte`）SQL Editor 先跑唯讀核對：
term_scope 欄位 0、合作單位 78、sort_order ≥ 490 者 30、含「115上」28、期間文字仍為預設、種子後無新增單位——與 migration 假設一致；
再以 `BEGIN … COMMIT` 單一交易套用 `20261019220000`，回 Success；套用後核對：欄位 1、約束 1、寒暑假 48、學期間 30、無組別 0、非合作單位帶組別 0、
總數 112 不變、三個期間文字為「2026年寒假／115學年度上學期／2026年暑假」、學期間不含「115上」者 2（與種子相符）。
接著 `e781745` fast-forward 推上 `main`（15:23 UTC），GitHub deployment `7177831901` success（15:24:44 UTC）；每 60 秒探測正式站，15:28 起連續 5 次
命中新程式包 `index-65O15yza.js`（SHA-256 前綴 `93388917308a7dd7`），內含「請先選擇教學課程期間，再選單位」與「報酬登記中心」、不含「薪資登記中心」。
驗證過程未送出任何回報、未改既有回報資料。

**原上線順序（已照做）**：① 業主在 Supabase SQL Editor 套 `20261019220000_partner_units_by_term_and_period_labels.sql`（只加欄位、回填、改三個 label）；
② 再推 main。順序反了，新前端 select 的 `term_scope` 欄位不存在 → 選項讀取失敗 → 退回自由輸入（可回報但沒有下拉）。先套 migration 時舊前端照常運作。
套完可在後台「回報選項管理 → 合作單位」確認兩組筆數 48／30，分錯的用「移到另一組」調整。

## 🧭 2026-10-19（第二版）：回報頁欄位與選項對齊兩份 Google 表單（✅ 正式環境已上線）

**需求**：業主看過第一版後：「選項和欄位要和表單裡面一樣呀，像是 b2b 的怎麼會變成是還要填寫課程名稱呢？應該本來表單裡面沒有對吧」。
另問「後台可以審核的地方在哪裡」（答：後台首頁「薪資登記中心」`/admin/salary`，上方「待核准」篩選鈕，點任一筆打開「審核／編輯薪資紀錄」視窗核薪、改狀態）。

**依據**：實際抓下兩份表單的題目（B2C：`forms/d/e/1FAIpQLScKSEUXDctk1cqB7UqDc7CwY9I0g8e6T1XBaX-52c6C5GdTjg`；B2B：`forms.gle/CBfwjZv34vT35nZTA`，
兩者都在 `site_links` 種子裡）。B2B 表單欄位：講師名字、課程講師身分別（主講／助教）、上課日期、講師級別、教學課程期間、上課單位、時數、人數、
教材數量、特殊狀況；**沒有**課程名稱、地點、角色、自評、進度。B2C 表單：到府／速解／體驗區段有課程種類（5 選項）、課程名稱、時數（1／1.5／2／2.5／3／其他）、
人數、交通補助、特殊狀況；營隊區段有是否為營隊負責人、營隊梯次、人數、交通補助、特殊狀況，沒有時數。

**做法（純前端，無 migration）**：
- `constants.js`：回報類別改三個——B2C 直營課程部／B2B 合作單位課程／其他課程（兩份表單都沒有的課：常態課、幼兒啟蒙、速解培訓、站櫃／擺攤、認證、特殊講座，
  維持原本完整欄位）。B2C 課程種類六項與表單一字不差（到府家教課 or 到府揪團課、線上課程、體驗課、速解研究所｜實體課程、速解研究所｜線上課程、寒暑假營隊 二日營、五日營）。
  第三層照表單問法：合作課叫「課程講師身分別」（合作課程 主講／助教，專案不列給講師）、營隊叫「是否為營隊負責人」（否（一般講師）／否（速解營）／是（5／4／2 日營負責人））。
- `salaryReportForm.js`：新增 `reportLayoutFor`／`reportFieldsFor`／`roleForCourseType`／`validateReportBasics`／`buildReportBasicParams`：
  各版面只顯示、只送出表單有的欄位；角色由報酬項目推定（助教類→助教、負責人→負責人）；表單必填（B2C 課程名稱＋時數＋人數、B2B 時數＋人數、營隊人數）前端擋。
- `MySalaryNew.jsx` 重寫版面：姓名與級別改顯示在頁首籤條（表單要填、站內自動帶）；B2C 時數改下拉＋「其他」自填；特殊狀況欄名照各表單；預設落在 B2C 到府家教課。
  後台登記頁與列表未動。

**驗證（主對話 2026-10-19 親跑）**：`npm test` 81/81（新增 12 項）；`verify:salary-report-form:browser` 43/43（新增 13 項：三類備註、B2C 種類一字不差、
到府欄位組合、體驗課隱藏第三層、時數「其他」、營隊問法與欄位、B2B 無課程名稱／課程種類／交通補助、其他課程完整欄位、三版必填訊息、送出內容含 role／course_name／hours）；
`npm run build` 通過；ESLint 0 問題；`git diff --check` 乾淨。截圖 10 張在 `培訓web/docs/verification/2026-10-19-salary-report-form-channel/`，sonnet agent 判讀：
B2B／營隊／到府／390px 皆符合表單欄位且無破版（到府圖底部紅字為腳本殘留訊息，同前）。

**正式環境證據（2026-10-19 21:28–21:35 台北）**：業主指示「可以，把回報頁第二版推上 main 部署」後，`cfd2051`＋併入主線的 `0019174` fast-forward
推上 `main`，GitHub deployment `7175079852`（13:28:54 UTC）；每 60 秒探測正式站，13:29 起連續 5 次命中含「B2B 合作單位課程」的新程式包
（`index-CCEdhvoH.js`，13:33 另一條工作線的 `d019ee6` 上線後換成 `index-bEU2INyI.js`，SHA-256 前綴 `b97a12b1ee7b1d5b`，仍含第二版字串；
`git merge-base --is-ancestor 0019174 d019ee6` 為真，線上版本包含本次）。上線後未送出任何回報、未改正式資料。

**待辦**：① 真講師帳號開 `/my/salary/new` 看一次；② 「其他課程」這一類是否要保留、裡面的課要不要也做成表單樣式，請業主決定。

## 🧭 2026-10-19（第一版）：回報頁課程類型改三層選單（B2B／B2C → 課程類型 → 報酬項目）（✅ 正式環境已上線，已被第二版取代）

**需求**：業主 2026-10-19 看回報頁截圖：課程類型應是常態課、營隊、到府課、合作單位、線上課程、速解課、站櫃；合作單位要像 Google 表單那樣
選了才跑出單位下拉、選項後台可管。隨後改口：「照我本來給你的 Sheet，讓大家填寫格式和本來一樣，上面多一個選項是 b2b b2c，然後後面備注
什麼樣的課程類型應該要選哪一個」，並給了 B2C 表單連結（`forms/d/e/1FAIpQLScKSEUXDctk1cqB7UqDc7CwY9I0g8e6T1XBaX-52c6C5GdTjg`）。

**現況釐清**：合作單位下拉與 78 筆選項 10/18 已照 sheet 做好、後台 `/admin/salary/options` 可管；截圖裡沒出現是因為當時選的是
「實體常態-初階」，只有合作課型才會顯示。問題出在第一格「課程類型」直接列 27 個報酬規則代碼，講師看不出合作課在哪。

**做法（純前端，無 migration，`class_sessions.course_type` 照舊存報酬規則代碼）**：`src/lib/constants.js` 新增 `REPORT_CHANNELS`
（B2C 直營課程／B2B 合作單位，各附備註）、`COURSE_CATEGORIES`（課程類型用表單用語：常態課、到府家教課／到府揪團課、線上課程、體驗課、
速解研究所｜實體課程、速解研究所｜線上課程、寒暑假營隊、站櫃／擺攤、其他；B2B 只有合作單位課程）與查詢函式。`MySalaryNew.jsx` 第一格改
「回報類別」並在下方列兩行備註，第二格「課程類型」依類別過濾，第三格「報酬項目」只在該類型有多個報酬規則時出現（體驗課、速解線上只有一個
就自動帶入不顯示）；切換類別或類型時自動落到該組第一個項目，期間／單位／梯次／交通補助等條件欄位照舊依 course_type 判斷。
後台登記頁與列表未動（管理員仍用完整 27 項）。**分組是我先排的，待業主確認**：速解營隊放「寒暑假營隊」、幼兒啟蒙放「常態課」、
擺攤與站櫃同組、認證助裁／特殊講座／其他放「其他」。

**驗證（主對話 2026-10-19 親跑）**：`npm test` 74/74（新增 `constants.test.js`：每個 course_type 恰屬一類、合作課全在 B2B）；
`npm run verify:salary-report-form:browser`（mock Supabase＋本機 dev，沙盒外）37/37，含新增 7 項（預設 B2C、備註兩行、B2C 類型清單
照表單用語、常態課顯示第三層、體驗課隱藏第三層、切 B2B 立即出現上課單位與期間、切回 B2C 回到初階）＋原 30 項全過；
`npm run build` 通過；變更檔 ESLint 0 問題；`git diff --check` 乾淨。截圖 9 張在 `培訓web/docs/verification/2026-10-19-salary-report-form-channel/`，
由 sonnet agent 判讀：桌機 B2B／B2C 與 390px 皆無破版、備註可讀（截圖 2 底部的紅色錯誤條是腳本先填 501 觸發、再改 12.35 未重送的殘留訊息，10/18 版亦同，非本次引入）。

**正式環境證據（2026-10-19 10:55–11:01 台北）**：業主指示「分組照你排的可以，commit 並推上 main 部署」後，`62895ee` 由
`feat/salary-report-channel-select` fast-forward 推上 `main`，GitHub deployment `7164631750` production success（02:56:07 UTC）；
每 60 秒探測正式站，02:56 起連續 5 次命中新程式包 `/assets/index-s08QVe72.js`（SHA-256 前綴 `568ed22be60a7e37`），內含「B2C 直營課程」。
本機 dist 雜湊不同是因為本機工作區當時混有另一條工作線的未提交檔（featureFlags 等），非正式站異常。上線後未送出任何回報、未改正式資料。

**待辦／注意**：① 業主實際用講師帳號開 `/my/salary/new` 看一眼三層選單（本次驗證是 mock 資料）；② 本 worktree 另有一批
「合約文件讀取權限收緊」的未提交檔（`20261019103000_restrict_contract_document_reads.sql`、featureFlags、contracts_setup.sql、
verify-contract-document-reads.*、package.json），屬另一條工作線，本次 commit 已刻意避開；該線稍後已自行提交為 `417c1a9`。

## ✍️ 2026-10-18：講師簽約正式重開——受控寫入 RPC＋恢復 Email 身分驗證（✅ 正式環境已上線 2026-10-19）

**業主決定**：個人資料關卡體檢全過後，業主選「正式重開：補寫入通道，並恢復 Email 身分驗證；我會去 Supabase 改信件模板並設定 SMTP」。

**為什麼不能只按開關**：8/19 資安修補（已套正式庫）移除了講師對 `instructor_contracts` 的 INSERT 政策，
`contracts_setup.sql` 明寫恢復前必須改由可信 RPC 建立；只把 `featureFlags.INSTRUCTOR_CONTRACTS_ENABLED` 改 true，
老師走完流程會在最後一步被 RLS 擋下。另 `ContractSigningFlow.jsx` 的 `OTP_BYPASS_FOR_TESTING` 自 7/09 起為 true（免驗證）。

**做法**：
- 新 migration `supabase/migrations/20261018180000_reopen_instructor_contract_signing.sql`（可重複執行）：冪等補 `verified_at`／`verify_method`
  欄位；建 `submit_my_contract(...)`（SECURITY DEFINER、空 search_path、先 DROP 同名多載）為簽約唯一寫入通道，函式內依序檢查：
  登入、角色非 pending、**Email 驗證只認 JWT `amr` 裡 otp／magiclink 且 30 分鐘內的紀錄**（不信任 client 任何「已驗證」欄位）、
  輸入長度、文件版本必須等於目前啟用版本（只算 `doc_category<>'form'`，行政表單不屬簽約）、fill_sign 文件必附簽署 PDF、
  簽名檔與 PDF 必須在自己的 `signed/<uid>/` 底下且 `storage.objects` 真的存在、IP 由 `cf-connecting-ip`／`x-forwarded-for` header 取；
  同一交易＋advisory lock 作廢舊約、寫入新約。REVOKE anon、GRANT authenticated；**不新增任何 INSERT／UPDATE policy**。
  `contracts_setup.sql` 同步放入同一份函式。
- 前端：`featureFlags.js` 開關改 true；`ContractSigningFlow.jsx` 的 `OTP_BYPASS_FOR_TESTING` 改 false（常數保留，但後端獨立驗證，改 true 也繞不過）、
  刪 client 作廢舊約與 ipify、送出改呼叫 `rpc('submit_my_contract')`，四種錯誤代碼對應白話文案；載入文件加 `doc_category='contract'`。
  `ProfilePage.jsx` 合約版本比對同樣排除行政表單（否則已簽約講師會永遠看到「合約文件已更新」）。
- 驗證腳本：新 `scripts/verify-contract-signing-rpc.{mjs,sql}`（隔離 PostgreSQL）；`verify-contract-feature-paused.mjs` 改名
  `verify-contract-feature-enabled.mjs` 並改為啟用預期（T7–T10 報酬頁／後台填表／下載中心原樣保留）。package.json 新增
  `verify:contract-signing`、`verify:contract-signing:browser`。

**證據（主對話於 2026-10-18 親自重跑）**：`npm test` 59/59；`verify:contract-signing` SQL 16 項 PASS（migration 連跑兩次、anon 無 EXECUTE、
pending／無 amr／amr 過期／版本不符／路徑越界／檔案未上傳／缺 PDF／輸入不合法全被擋、成功案作廢舊約且 verified_at＝amr 時間、
authenticated 直接 INSERT 仍被 RLS 拒、新建庫路徑可用）＋靜態檢查 3 項；`verify:contract-signing:browser` 真瀏覽器 40/40
（個人頁簽約區塊、合約通知、簽約頁最後一步出現 Email 驗證且無「測試模式」、未驗證不可送出、講師只走 RPC、390px 無溢出、後台上傳會通知），
截圖 9 張在 `docs/verification/2026-10-18-contract-reopen/`；改動檔 ESLint 0 error、`git diff --check` 乾淨。
security-auditor 審查：0 阻斷；amr 行為已對照 supabase/auth 原始碼（verify 一律建新 session、method=otp；refresh 不延長 timestamp）。

**正式環境證據（2026-10-19）**：業主已改 Supabase Magic Link 模板（`{{ .Token }}`）並設定 SMTP。migration 由 Claude 透過 Chrome 擴充功能
貼進 DreamCube_teacher 的 SQL Editor、業主親按 Run（Success）；anon 探測 `submit_my_contract` 回 42501 permission denied（函式存在、匿名被擋；
套用前同探測回 PGRST202 找不到）。分支併入 main 快轉推送 `8f84be2..073d745`，GitHub deployment `7164265290` production success；
正式站載入 `index-E52GxsdS.js`，SHA-256 `4da021ed6018da4639ff2…` 與本機 build 逐位元一致，連續 3 次抓取皆含 `submit_my_contract`；
以正式站 bundle 跑 `verify-complete-gate.mjs` 37/37。**待業主真帳號端到端**：個人資料 → 簽約 → 收驗證碼 → 輸 6 碼 → 簽名送出 → 合約檢視頁有紀錄；
若出現「請先完成 Email 身分驗證」代表正式環境 JWT 無 otp 紀錄（amr 假設不成立），回報即查。

**⚠️ 2026-10-19 上線後探測發現阻斷**：以 anon 對 `/auth/v1/otp`（info@dropout.tw、create_user=false）探測回 422
`email_provider_disabled`「Email logins are disabled」——Supabase 的 **Email 登入提供者目前關閉**（7/09 探測時為開啟，中間被關掉）。
不開啟的話講師按「寄送驗證碼」會失敗、無人能完成簽約。需業主在 Dashboard → Authentication → Sign In / Providers → Email 開啟
（本站只用 Google 登入畫面，簽約 OTP 呼叫帶 shouldCreateUser=false，不會因此開放註冊；但依資安審查備註，開啟後任何既有帳號的信箱
都可走 magic link 登入，信箱被盜＝帳號被盜，業主已知情）。開啟後再寄一次測試碼確認信內有 6 碼，才進行真帳號端到端。

**原上線順序（已完成）**：① 業主在 Supabase Dashboard：Authentication → Email Templates → Magic Link 模板把 `{{ .ConfirmationURL }}` 換成
`{{ .Token }}`（7/09 診斷：這是驗證碼寄不出的根因）；Project Settings → Auth → SMTP 接 Resend（內建 2 封／小時不夠用）。
② 正式庫套 `20261018180000_reopen_instructor_contract_signing.sql`（**先 RPC 後前端**；只建函式，不動既有資料）。③ 合併本分支到 main（Zeabur 自動部署）。
④ 業主在後台確認啟用中的合約文件是新版、簽名欄位已在定位器擺好（8/27 修復後受影響版本要重擺）。⑤ 真帳號端到端：收信→輸 6 碼→簽名→合約檢視頁有紀錄；
這一步同時驗證 amr 假設（若出現「請先完成 Email 身分驗證」即代表正式環境 JWT 無 otp 紀錄，回報我查）。

**審查提到的既有設計債（非本次引入，未處理）**：簽署 PDF 由瀏覽器產生再上傳，RPC 只驗存在不驗內容（法律依據應以 doc_versions＋範本為準，
長期可改伺服器端套印）；`contract_documents` SELECT 對 pending 也開放（任何 Google 帳號登入可讀合約範本）；mentor 可讀所有 `signed/` 檔但看不到合約列；
開 Email OTP 等於多一條不經 Google 的登入路徑（信箱被盜＝帳號被盜）；後台上傳通知的 insert 未檢查 error。

## 🗂️ 2026-10-18：後台回報選項管理頁（✅ 正式環境已上線）

**需求**：業主 2026-10-18：「後台管理員也會需要可以定義這些欄位，像是哪些選單的欄位可以有哪些選項可以選」。講師回報頁的三個下拉
（教學課程期間、上課單位、營隊梯次）選項存在 `salary_report_options`，原本只能進 Supabase 改，沒有管理畫面。

**做法**：新頁 `/admin/salary/options`（`src/pages/admin/SalaryReportOptionsManager.jsx`，路由 adminOnly，mentor 與講師會被導走）。
入口：薪資登記中心頁首「回報選項管理」按鈕（只有 admin 看得到）、後台首頁多一張卡片。三個分頁籤各列全部選項（停用的灰色＋刪除線）；
可新增（value 自動＝文字、排序＝目前最大＋10）、改名、上移／下移（交換兩筆排序值）、停用／啟用。**不提供刪除**（舊回報的上課單位是文字快照，
停用即可，畫面有說明）。教學課程期間的 value 是固定代碼（winter_break／semester／summer_break），該籤只能改名與啟用、不能新增。
合作單位／營隊梯次改名時 value 一起改（講師回報存的是 value，不同步的話舊名會繼續寫進新回報）；期間改名只改 label。
每個資料庫呼叫都檢查 error；更新用 `.select()` 確認真的更新到列（RLS 擋下時不會靜默成功）；文字空白或超過 200 字、同分頁重複會擋，
伺服器回唯一鍵衝突（23505）顯示友善訊息。純函式在 `src/lib/salaryReportOptions.js`（排序、驗證、下一個排序值、上移下移）。

**驗證**：`npm test` 69/69（含新增 10 項選項純函式測試）；`npm run build` 通過；變更檔 ESLint 0 問題；`git diff --check` 乾淨。
`npm run verify:salary-report-options:browser`（mock Supabase＋本機 dev，沙盒外執行）37/37：三籤切換、期間籤無新增、新增 payload
（kind／value／label／sort_order）、改名／停用／啟用／上移／下移送出的 update 內容、空白／超長／重複被擋、23505 與「更新 0 筆」訊息、
teacher 與 mentor 進頁被導走、mentor 看不到入口、390px 三籤皆無水平溢出且所有操作熱區 ≥44px。
截圖在 `培訓web/docs/verification/2026-10-18-salary-report-options/`（桌機 3 張＋390px 1 張）。

**上線邊界**：純前端，無 migration；RLS 早已存在於 `20261018120000_align_salary_report_with_forms.sql`（admin 可增改刪、已核准角色只讀啟用項），
推前端即可。尚未對真實 Supabase 實操過（驗證用 mock），上線後請 admin 登入實際加／停用一筆確認。

---

**正式環境證據（2026-10-18 22:34–22:39 台北）**：業主指示「把後台回報選項管理頁推上線」後，`3efa1f5` fast-forward 推上 `main`，
GitHub deployment `7155998549`（14:34:23 UTC）；每 60 秒探測連續 5 次命中 `/assets/index-CDQApnMb.js`（2,366,882 bytes、SHA-256 前綴
`e86f33ea771ba24b`），`dream-one-teacher.zeabur.app` 與 `teacher.dreamcube.tw` 相同且與本機 build 逐位元一致，bundle 含「回報選項管理」。
純前端發布，未改 Supabase。**待業主**：用管理員帳號實際新增一筆、停用一筆，確認對正式庫的寫入正常（本機只用 mock 驗過）。

## 🔒 2026-10-18：講師只看 2026 年 1 月起的薪資紀錄＋參考表限已核准角色（✅ 正式環境已上線）

**需求**：業主 2026-10-18 指示「講師薪資可以看到的資料範圍先從 2026 年一月開始就好，那之前的有些可能還要整理」，並要求「權限的部分幫我檢查一下」。

**做法**：migration `supabase/migrations/20261018150000_limit_instructor_salary_visibility.sql`（可重複執行）：
① 新函式 `instructor_salary_visible_from()` 回傳 `2026-01-01`（之後要往前開放只需 `CREATE OR REPLACE` 改日期，不必重寫政策）；
② 重建 `class_sessions` 的講師 SELECT 政策為「自己的紀錄 且 `session_date >= 門檻`」，限 authenticated；admin／mentor 政策不動；
`instructor_salary_summary` 是 security_invoker view，講師端總場次／總薪資自動只算門檻後的紀錄；SECURITY DEFINER 的回報、試算、排行榜函式不受影響。
③ 資安審查（security-auditor）指出：站點 Google 登入即自動建 `pending` 帳號，而 `salary_rate_card` 與新建的 `salary_report_options`
的 SELECT 政策是 `TO authenticated USING (true)`，等於任何人登入就能讀全公司報酬表與 78 個合作單位清單。本 migration 把兩表 SELECT
改為 `users.role IN ('teacher','mentor','admin')`。前端：講師「我的報酬」月份明細加一行「目前只顯示 2026 年 1 月起的課程紀錄」，回報頁
日期欄 `min=2026-01-01`（後端 RPC 未擋更早日期，只是前端提示）。

**驗證**：`LC_ALL=C npm run verify:salary-visibility`（隔離 PostgreSQL，引導區複製正式庫現行政策）8/8 PASS：migration 連跑兩次、政策數正確、
門檻函式 anon 無 EXECUTE、講師只看到自己 2026-01-01 與之後的紀錄且彙總跟著變、看不到別人、管理員仍看全部（含 2025）、anon 零、
回報 RPC 照常且新紀錄本人看得到、pending 帳號讀不到報酬表／選項表／紀錄而 teacher 讀得到。`npm test` 59/59、變更檔 ESLint 0、build 通過。
（本機跑驗證腳本若遇 `postmaster became multithreaded` 要帶 `LC_ALL=C`。）

**正式庫現況（2026-10-18 唯讀查詢）**：`users.role` CHECK 含 mentor；目前 mentor 0 人、teacher 2、pending 1、admin 14。報酬表的管理政策在線上叫
「Staff can manage rate card」（admin＋mentor），與原始碼「Admins can manage rate card」不同，是後台另行放寬過的。

**正式環境證據（2026-10-18 22:10–22:23 台北）**：業主指示「請套用講師可見範圍與參考表權限的 migration 到正式庫，套完推前端上線」後，
在 Supabase SQL Editor 以單一交易套用 `20261018150000_limit_instructor_salary_visibility.sql`，回 Success。套用後核對：門檻函式回 `2026-01-01`、
class_sessions 政策 2 條且講師 SELECT 條件含 `session_date >= instructor_salary_visible_from()`、報酬表與選項表各只剩一條「Approved roles」SELECT 政策。
**發現並當場修正**：Supabase 預設權限會自動把新函式 EXECUTE 給 anon，`REVOKE FROM PUBLIC` 擋不到——外部匿名呼叫門檻函式一度回 200；
已手動 `REVOKE … FROM anon`（查到 anon=false、authenticated=true，外部再呼叫回 401 `42501`），migration 檔同步改為明寫 anon（commit `bde11f4`）。
外部匿名讀 class_sessions／salary_rate_card 回空陣列、salary_report_options 回 401。前端 `20e2c46` 推上 `main`，GitHub deployment
`7155808916`（14:18:50 UTC）；每 60 秒探測連續 5 次命中 `/assets/index-C27VOsNp.js`（2,355,287 bytes、SHA-256 前綴 `94c417e17b2151ab`），
兩個正式網域相同且與本機 build 逐位元一致，bundle 含「2026 年 1 月起」提示。未以講師帳號實機登入檢視（無講師測試帳號）。

**待業主決定**：①資安審查的「高・條件式」：mentor 對 class_sessions 是 FOR ALL（可改任何人薪資、
刪回報），目前 mentor 0 人所以休眠，但 CHECK 允許新增 mentor；若 mentor 定位是「可看不可改薪資」，應把寫入收成 admin only；
②「低」：`quote_salary` 收了 `p_role_in_session` 但沒用，助教回報會照主講規則試算，核薪時要看角色。

---

## 📋 2026-10-18：課程回報對齊 Google 表單欄位（✅ 正式環境已上線）

**問題**：站內「我的報酬 → 登記課程回報」缺公司兩份 Google 課後回報表單有的欄位——B2B 合作單位表單的
「教學課程期間」「本次上課單位名稱」「本次發出教材數量」，以及 B2C 直營表單的「是否申請交通補助（單趟公里數）」、
營隊表單的「營隊梯次」，講師因此還不能完全改用站內回報。

**做法**：新 migration `supabase/migrations/20261018120000_align_salary_report_with_forms.sql`（可重複執行）：
`class_sessions` 加 `term_period`、`unit_name`、`materials_issued`、`transport_subsidy_requested`（預設 false）、
`transport_distance_km`，以具名 CHECK 擋錯誤期間、超過 200 字、公里數不在 (0, 500]、未申請卻有公里數；新增
`salary_report_options` 選項表（RLS：登入者只讀啟用中選項、只有 admin 可增改刪、anon 無權限），種入教學期間 3、
合作單位 78（寒暑假 48＋學期間 30，分隔列不入庫）、營隊梯次 31，重跑不覆寫管理員改過的名稱或停用狀態。
`submit_my_class_session` 先 DROP 舊 10 參數簽章再建 15 參數新版（避免同名多載讓 PostgREST 呼叫歧義），
權限、SECURITY DEFINER、空 `search_path` 與既有驗證原樣保留；合作課（`collab_*`）必填期間與單位、營隊
（`camp`／`camp_director_*`／`speed_camp`）必填梯次、勾交通補助必填公里數（四捨五入到 0.1）、未勾時公里數強制 NULL。
交通補助在合作課以外的課型都可申請（後端對任何課型皆接受）。課程類型新增 `trial`（體驗課，表單 B 的課程種類之一；業主 2026-10-18 指示「體驗課也可以回報」）：migration 以 `negotiable` 模式、無金額種入報酬表，回報後為「待核薪」，金額由管理員核薪時填。`quote_salary` 未動。`2025_salary_system.sql` 同步新欄位、約束與選項表結構（種子與 RPC 仍在 migration）。
前端回報頁依課型顯示條件欄位：合作課→期間＋單位下拉（含「其它」自填）＋教材數量；營隊→梯次下拉（含「其它」）；
營隊與直營→交通補助開關（表單 B 兩段都有），勾選才出現單趟公里數；合作課不顯示；選項讀取失敗自動改為自由輸入，不擋回報；只送出目前課型看得到的欄位。
後台 `/admin/salary` 桌機表格與手機卡片顯示期間、單位／梯次、教材、「交通補助：申請 ・ 單趟 X km」（只顯示，不改核薪）。

**驗證**：`npm run verify:salary-report-form`（隔離 PostgreSQL）：migration 連跑三次無誤且舊紀錄平順補預設值、
`pg_proc` 只剩一個 `submit_my_class_session`、anon 對 RPC 與選項表零權限（catalog＋實際呼叫）、講師讀不到停用選項且
寫不進選項表、15 種錯誤輸入全被擋、直營／合作／營隊各成功一筆且新欄位正確、舊前端 10 參數呼叫直營課仍可用、
種子 3／78／31、體驗課可回報且為待核薪、新建庫路徑（2025 → 20260826 → 20261018）可用。`npm run verify:salary-report-form:browser`
（mock Supabase＋本機 dev）30/30：三種課型條件欄位切換、前端驗證訊息、送出參數、選項失敗退回自由輸入、
390px 回報頁與後台皆無水平溢出；截圖在 `培訓web/docs/verification/2026-10-18-salary-report-form/`。
`npm test` 59/59、production build、變更檔 ESLint 0 問題、既有薪資靜態檢查 9/9、`git diff --check` 通過。
以上由主對話於 2026-10-18 親自重跑確認（SQL 驗證 10 項 PASS＋15 種錯誤輸入、瀏覽器 30/30、截圖 8 張實際存在）。

**正式環境證據（2026-10-18 21:50 台北）**：業主指示「可以上線 體驗課也可以回報」後，先在 Supabase 後台 SQL Editor（業主本人登入的
Chrome 分頁）以 `BEGIN … COMMIT` 單一交易套用 `20261018120000_align_salary_report_with_forms.sql`，回 Success。
套用前核對：class_sessions 9,532 筆、有效報酬規則 206、舊 10 參數函式 1 個、新欄位 0、選項表不存在。套用後核對：9,532 筆未變、
5 新欄位、4 具名 CHECK、`submit_my_class_session` 只剩 15 參數版本（anon 無 EXECUTE、authenticated 有）、選項表 RLS 開啟＋2 條政策、
anon 不可讀、種子 3／78／31、體驗課議價列 1（有效規則 206→207）。外部匿名 REST 呼叫新簽章回 401 `42501`、讀選項表回 401。
接著 `758a43b` fast-forward 推上 `main`，GitHub deployment `7155492640` 於 13:51:31 UTC success；每 60 秒探測連續 5 次命中新程式包
`/assets/index-DssrE7WL.js`（2,355,076 bytes、SHA-256 前綴 `5c40339e186173ce`），`dream-one-teacher.zeabur.app` 與
`teacher.dreamcube.tw` 兩站相同且與乾淨本機 build 逐位元一致，bundle 內含「體驗課」與 `salary_report_options`。
驗證過程未送出任何回報、未改任何正式資料。

**上線邊界（原文留存）**：順序：**先套 migration，再發前端**（新前端呼叫新簽章，反過來所有回報都會
送不出）。先套 migration 時舊前端仍可回報直營課，但合作課／營隊會被新規則擋下並顯示「請選擇上課單位／營隊梯次」，
所以 migration 套完要緊接著發前端，空窗越短越好。之後新增學期合作單位或營隊梯次＝在 `salary_report_options`
新增一列（舊選項改 `is_active=false`，不要刪），目前還沒有後台管理畫面，需由管理員在 Supabase 後台操作。

**已知小事**：`2025_salary_system.sql` 的 `month_label` 以 `to_char()` 當 generated column，PostgreSQL 16 會拒絕建表
（既有問題，非本次引入；正式庫已存在不受影響）。新建庫測試只把這一行換成一般欄位後驗證，原檔未修。

## 📝 2026-08-27：同頁重複合約欄位儲存修復（✅ 正式環境已上線，2026-10-18 驗證）

**問題與根因**：表單欄位定位器允許同一個資料欄位在同頁出現多次，例如
匯款申請書的申請人姓名與聯絡人姓名；但 `contract_field_positions` 的唯一約束
禁止 `(doc_type, doc_version, field_type, page_number)` 重複，因此儲存兩個同頁「姓名」時
回報 `duplicate key value violates unique constraint`。舊儲存流程另分成先刪除、再新增兩個
請求，若新增失敗會留下已被清空的排版。

**修正**：新增 migration
`supabase/migrations/20260827105756_allow_duplicate_contract_field_positions.sql`，移除過度嚴格的
複合唯一約束，保留每筆 UUID 主鍵；新增 `SECURITY INVOKER`、只授權 authenticated 的
`replace_contract_field_positions` RPC，並在函式內再檢查 admin 角色。前端改為以單一 RPC
交易取代分開 DELETE/INSERT，任何一筆失敗都回滾；同一文件以 transaction advisory lock
序列化並行儲存，並補回非唯一 `(doc_type, doc_version)` 索引；`contracts_setup.sql` 也同步新建與
舊庫重跑行為。

**驗證**：隔離 PostgreSQL 實際建立舊唯一約束後連續兩次套用 migration，同頁重複姓名儲存、
其他文件版本不受影響、無效新資料交易回滾、非 admin 拒絕、anon 無 RPC 權限全部通過；
前端專項確認儲存已只走 RPC。`npm test` 53/53、production build、變更檔 ESLint
0 error（`FieldPositionEditor` 保留 1 個既有 Hook dependency warning）、`git diff --check` 全數通過。

**正式環境證據（2026-10-18 唯讀驗證）**：功能提交已以 `3267377` 併入 `main`（2026-08-27 19:20，
與本分支 `87188a6` 內容逐檔相同，`git diff` 為空），Zeabur 自動部署後正式站
`dream-one-teacher.zeabur.app` 載入 `/assets/index-C1g3ZmNU.js`，bundle 內含
`replace_contract_field_positions` 呼叫。正式 Supabase 專案 `mnovjlicwzwkefkhstte` 以 anon key 帶
正確參數名呼叫該 RPC 回 HTTP 401 `42501 permission denied for function`，證明函式已存在且匿名者被擋；
（以 `{}` 空參數呼叫會回 PGRST202 找不到函式，那是參數不符的假陰性，不能拿來判斷）。
本次驗證未寫入任何資料。此段原寫「已建置未上線」是文件未同步，非功能未上線。

**殘留邊界**：原錯誤流程若已先成功 DELETE，這次修正無法自動還原尚未儲存的畫面座標；
受影響的文件版本需在定位器重新擺放一次並儲存。

## 💰 2026-08-26：恢復講師回報與管理端薪資登記（✅ 正式環境已上線）

**轉換體驗**：「我的報酬」重新以站內「登記課程回報」為主要入口，講師選擇課程、
日期、時數與人數後立即看到報酬試算、採用資格與單價，不需自行填薪資。舊的直營／合作單位
Google 表單保留在「仍在使用舊表單？」折疊備援區，並提醒同一堂課只能擇一管道回報，降低
立即切換的摩擦與重複送出風險。

**核薪與登記**：後台 `/admin/salary` 已解除「尚未啟用」遮罩，改為待處理優先、待核薪與異常
快速篩選；手機改用可點選卡片，桌機保留明細表格。管理員可重新依報酬表試算、核准、付款、
退回回報，或填寫原因後人工調整。未取得資格、議價或無匹配規則的回報會保留為「待核薪」，金額為
`NULL` 而不是 0 元，未定價前不能直接核准。速解課依「速解老師／速解大師」資格、一般課依
講師等級選用報酬表，每筆資格、費率與定價依據均留快照。

**資料庫邊界**：新 migration
`supabase/migrations/20260826105841_restore_salary_workflow.sql` 建立受控的 `quote_salary` 與
`submit_my_class_session` RPC。講師不能從客戶端作假身分、資格快照或金額；匿名無執行權限，
authenticated 僅能試算自己，而安全定義者函式固定空 `search_path`。資料庫同步擋下未來日期、
負時數／過大時數、人數邊界、未支援課程、常態課缺學習進度、未留原因人工改價與待核薪直接核准。

**驗證**：隔離 PostgreSQL 實際重複套 migration，報酬試算、資格快照、交叉講師禁止與上述邊界
全數通過；薪資靜態規則 9/9、薪資桌機／390px 手機實際操作 13/13、合約停用與舊表單過渡
邊界 32/32、最新主線單元測試 53/53、安全強化、存摺鎖定、管理員講師編輯、講師認領、供應商匯出與
production build 均通過。
變更檔案 ESLint、Impeccable detector 與 `git diff --check` 皆為 0 問題；全站 lint 仍有 3 個舊 React Hook error
與 2 個 warning，都位於本次未修改檔案。桌機與手機截圖已實際檢視，無水平溢出。

**正式 Supabase**：專案 `mnovjlicwzwkefkhstte` 已在單一 transaction 套用 migration
`20260826105841_restore_salary_workflow.sql`。Preflight／postflight 的講師、報酬規則與課程紀錄筆數均維持
265／206／9,532；catalog 已確認 RPC、8 個定價快照欄位、trigger、`security_invoker`、固定空
`search_path` 與 anon／authenticated 權限符合預期，匿名正式 REST 呼叫回報 RPC 另回 HTTP 401。

**正式前端證據**：功能 commit `d439bc0` 已 fast-forward 推入 `main`，Zeabur production deployment
`6106389370` 於 2026-08-26 14:52:33 UTC 回報 success。`teacher.dreamcube.tw` 與
`dream-one-teacher.zeabur.app` 均載入 `/assets/index-BxFKWhfL.js`（2,346,676 bytes、SHA-256
`4994cf970ed4b14ea210984200aab1772b7860e854ce8f56c82d7af40c3f1873`）與
`/assets/index-D04hQ-Mu.css`，兩站資產和乾淨本機 production build 逐位元一致。兩站的
`/my/salary`、`/my/salary/new`、`/admin/salary`、`/admin/salary/export` 均回傳正式 SPA，live bundle
同時命中新 RPC、舊表單轉換提醒與供應商 CSV。正式已登入實機另確認講師回報頁會即時顯示待核薪結果、
管理端薪資登記中心無停用遮罩，兩頁 console 0 error；驗證過程沒有送出課程或變更薪資資料。

---

## 👤 2026-08-26：初次登入舊資料對照、外部頭像與缺項提示（✅ 正式環境已上線）

**需求與做法**：講師初次登入後，個人資料頁新增預設收合的「舊匯入資料」對照區，僅顯示本人主檔中
既有的 Line 名稱、接課地區原文、舊經歷／理念、匯款原文等欄位，不顯示管理員內部備註，也不會用舊值
覆蓋目前表單。頭像改為 Storage 檔案優先、HTTPS／Google Drive `photo_external_url` 次之，外部圖失敗時
再回到預設頭像；外部圖請求不帶 referrer。完整度橫幅直接列出缺少欄位與已完成項數，送出驗證也改用
同一份 `getInstructorProfileCompletion()` 規則，避免講師儲存後才發現仍被關卡擋下。

**驗證**：`npm test` 44/44、任務範圍 ESLint、`npm run build`、`npm run verify:claim-flow` 全綠；
`verify-complete-gate.mjs` 擴充後 37/37，實際瀏覽器確認缺項只列「講師暱稱／存摺封面」、4 筆舊資料
可展開，以及外部頭像 fallback。桌機 1280×1000、手機 390×844 截圖已檢查，無溢位。Impeccable detector
只回報 `Layout.jsx` 既有、非本次修改的手機選單 `border-t-4`。

**正式環境證據與邊界**：功能 commit `cc5330b` 已 fast-forward 推入 `main`；Zeabur production
deployment `6106147468` 於 2026-08-26 14:39:46 UTC 回報 success。`teacher.dreamcube.tw` 與 Zeabur
網域均載入 `/assets/index-CQFR1E4p.js`，大小 2,295,559 bytes、SHA-256
`9d7a68871af8fcfe3b70754e21adec66042432a74fd7f1ae2720f528020a6128`，與乾淨本機 build 完全一致；
正式 bundle 命中舊資料、缺項與外部頭像文案，隔離 mock Supabase 的正式站 DOM 回歸 37/37，桌機與
390px 手機截圖已人工檢查。本次未修改 Supabase schema、RLS、RPC、Storage 或正式講師資料；原工作目錄
既有報告與 `STATUS.md` WIP 未納入發布。

---

## 📊 2026-08-26：報酬供應商 CSV 條件匯出（✅ 正式環境已上線）

**需求與做法**：新增管理員專用 `/admin/salary/export`，可不選老師匯出全部、搜尋後單選／複選老師、
依課程日期起迄縮小到區間內有報酬紀錄者，並依目前講師等級篩選。日期留白時不要求已有薪資紀錄；
有日期時以 `class_sessions.session_date` 與 `instructor_id` 對應主檔，同一老師即使有多堂課也只輸出一列。

**CSV 格式**：對齊財務部 16 欄供應商範例，保留首列空白列、原標題與空白欄，使用 UTF-8 BOM／CRLF；
群組固定為個人 `Z007`、國籍 `TW`，姓名、身分證、地址、電話、銀行代號／帳號與 Email 由
`instructors` 取值。主檔目前沒有「夥伴號碼」，因此保留欄位但留白且在畫面提示，不自行編號。
預覽只顯示銀行帳號末四碼，並列出每位講師缺少的必要匯出欄位；頁面與路由只對 admin 開放。

**本機證據**：匯出純函式測試 9/9；整合最新主線後全套單元測試 53/53 通過（欄數、編碼／換行、跳脫、單／複選、
日期、等級、缺漏與檔名）；production build 與變更檔 ESLint 通過；真 Chrome 驗證下載檔名／內容、日期＋等級交集、老師搜尋選取、
390px 無頁面水平溢出與 44px 操作熱區，mentor 直接網址會被導回首頁。安全性、存摺鎖定、講師認領與
完整度關卡 37/37 回歸亦通過；Impeccable detector 0 項。

**正式環境證據與邊界**：功能 commit `731d6a0` 已 fast-forward 推入 `main`，對應 Zeabur deployment
`6a8efb6b04336e45712015bd` 回報 success；後續主線純狀態文件 deployment `6a8efb9e04336e45712015d8`
亦於 2026-08-26 14:44:15 UTC 成功。`teacher.dreamcube.tw` 與 `dream-one-teacher.zeabur.app` 均載入
`/assets/index-BJqMOWUe.js`，SHA-256 皆為 `37e7cc1406abc0c762f0faa76c6e30507d276960ac41a04054332a1bd33e8eb3`；
兩站 `/admin/salary/export` 回傳正式 SPA，live bundle 實際包含路由、功能名稱與篩選匯出文案。本功能
未新增或套用 Supabase migration，也未變更正式資料；另一個獨立的薪資流程提交未納入本次發布。

---

## 👤 2026-08-26：既有講師本人核對與資料自動帶入（✅ 正式環境已上線）

**需求與流程**：Google 登入先以主要或備用 Email 對應講師主檔；唯一命中時維持原本的直接認領。
Email 未命中且尚無主檔時，不再直接進入空白個人資料，而是顯示「新進／非新進」：8/25 後才加入
講師群組者選新進並建立資料送審；非新進者輸入原主檔姓名、完整手機號碼與身分證末四碼，三項唯一
命中且主檔為啟用、未認領時，立即綁定目前 Google 帳號、升為 teacher 並帶入既有資料，不進審核。
既有主要聯絡 Email 會保留，不會被此次登入 Gmail 覆寫。

**安全邊界**：新增 `claim_existing_instructor_by_identity` SECURITY DEFINER RPC，只允許已登入的
pending 帳號呼叫；不提供候選名單、不回傳單欄命中狀態，失敗訊息一律為三項核對未通過。每個帳號
第五次失敗後鎖定 24 小時；匿名無執行權限。停用、已認領或不唯一的主檔都不會被綁定。另補上主要／
備用 Email 的正規化索引與登入、Auth hook、首次建帳三個決策點，避免備用 Email 已存在卻被當成新人。
既有管理欄位 trigger 只新增「未認領主檔綁定目前本人」例外；RLS 仍讓 pending 直接更新主檔為 0 row，
本人也不能解除連結或更動其他管理欄位。

**本機證據**：隔離 PostgreSQL 實際套用前一版與本次 migration，通過 Email 主要／備用認領、本人
三項核對、原 Email 保留、冪等、停用、衝突、五次鎖定及 anon／authenticated 權限回歸；靜態 Auth
規則 12/12、390px 真 Chrome 新進／非新進與成功帶入 5/5、既有自動認領 12/12、完整度關卡 34/34、
單元測試 42/42、production build、變更檔 ESLint 與 `git diff --check` 均通過。全站 lint 仍有本次
未修改的 4 個舊檔 React Hook error 與 2 個 warning；本次變更檔為 0 問題。

**正式環境證據**：正式 Supabase 專案 `mnovjlicwzwkefkhstte` 已成功套用 migration
`20260826140000_recover_existing_instructor_identity_claim.sql`。catalog postflight 確認認領 RPC、
SECURITY DEFINER、固定 `search_path`、anon 禁止、authenticated 允許、限速表、備用 Email 索引與
`instructors` RLS 均符合預期；正式匿名 REST 呼叫另回 401，證明未登入者不能執行認領。功能 commit
`70235d3` 已 fast-forward 推入 `main`，Zeabur check 於 2026-08-26 08:58:27 UTC 成功。正式網域
`teacher.dreamcube.tw` 與 Zeabur 網域皆載入 `/assets/index-eOM6h17c.js`（SHA-256
`5349e771dca37ea8f2c40ee985b69e60f071d457fa262c1f707f2468ce178458`），兩站 bundle 完全相同，且實際
包含 `claim_existing_instructor_by_identity`、身分選擇、8/25 備註與「新進／非新進」文案。

**資料邊界**：本次 migration 與部署不會跳過本人核對直接改綁正式講師。蔡宜津以 `yijin` Google
帳號登入後選「非新進」，輸入原主檔的完整手機與身分證末四碼，唯一命中即由 RPC 自動綁定、升為
teacher 並帶入原講師資料，不需要後台審核。

---

## ✅ 2026-08-26：管理員可完整編輯講師主檔（正式環境已上線）

**需求與做法**：在既有 `/admin/instructors` 講師資料總覽的桌機列與手機卡新增「編輯資料」入口，
但只對 `admin` 顯示；新路由 `/admin/instructors/:instructorId/edit` 也以 `adminOnly` 守衛，mentor
直接輸入網址會被導回首頁。編輯頁涵蓋帳號／業務狀態、基本聯絡資料、教學地區與經歷、匯款、WCA、
內部備註、身分證正反面、講師照片與存摺封面；可維護已認領或未認領的所有講師主檔，沒有新增欄位。
管理員上傳新文件時會先更新主檔引用，再清理舊 Storage 物件；資料庫更新失敗則回滾本次新上傳。

**權限邊界**：新增 migration `supabase/migrations/20260826130000_admin_instructor_editor_access.sql`，
明確重建 admin 全權 policy（含 `USING`＋`WITH CHECK`），並用 restrictive policy 限制非 admin 只能
更新／新增自己的主檔，mentor 即使能讀總覽也不能代改別人。Storage 另允許 admin 移除講師舊檔，
以及講師本人讀取管理員在未認領階段上傳、之後被自己主檔引用的文件；搭配 file-path trigger，
非 admin 更換文件時只能寫進自己的帳號路徑，避免用竄改主檔路徑讀取別人的證件。

**本機證據**：production build、變更檔針對性 ESLint、42/42 單元測試、原講師主檔／自動填表瀏覽器
回歸皆通過。新瀏覽器回歸實證：admin 有入口並送出 PATCH、390px 無水平溢出且儲存鈕熱區 ≥44px；
mentor 無入口、直連被擋且 0 PATCH。暫時 PostgreSQL 實際套新 migration，證明 mentor 更新別人為
0 row、本人資料仍可更新、admin 可更新任意講師與刪除舊檔、講師可讀自己主檔引用的匯入檔且不可
竄改成其他路徑。既有 `verify:security`、存摺鎖定與匯款鎖定資料庫回歸亦全數通過。
全站 lint 仍有 4 個既有 React Hook error 與 2 個 warning，均位於本次未修改的 5 個舊檔；
本次變更檔單獨 lint 為 0 問題。

**正式環境證據**：先於 Supabase `mnovjlicwzwkefkhstte` 套用 migration，再發布 commit
`9775d91`。套用前後講師數量均為 265（已認領 11、未認領 254）；四個 `instructors` policy、
五個 Storage policy、file-path trigger 與 function 權限稽核皆符合預期。交易回滾回歸證明 mentor
更新他人為 0 row、admin 更新未認領講師為 1 row，且正式資料零殘留。Security Advisor 為 0 error；
新 policy／trigger 未增加 warning。Zeabur production deployment `6099368338` 成功，正式網域與 Zeabur
網域均載入 `/assets/index-C_3sZBAw.js`，SHA-256 與本機 production build 一致。管理員實機由「主檔未認領
254」進入清單，確認 254 筆均有「編輯資料」，並成功開啟未認領講師完整表單；儲存按鈕可用、console
0 error，驗證時未按儲存，沒有改動正式資料。

---

## 🔒 2026-08-25：匯款銀行資訊存過即鎖定＋提示改為講師群組（✅ 前端已部署；⚠️ SQL 待業主套正式庫）

**需求與做法**：業主要求匯款資料與存摺封面「存過一次後講師不可再改，要改請於講師群組提出」。
存摺封面已於 8/18 鎖定，但匯款五欄（戶名／銀行別／分行／代碼／帳號）先前講師可隨時改、DB 無保護。
本次比照存摺做兩層：`ProfilePage.jsx` 在 DB 已有 `bank_account_number` 且非 admin 時五欄 `disabled`
灰底＋黃色提示；伺服器草稿不得覆蓋已鎖定欄位；新增
`supabase/migrations/20260825120000_lock_instructor_bank_account_after_first_save.sql`
（BEFORE UPDATE trigger，非 admin 改任一欄→42501；admin／service role 不受限）。
兩處提示統一為「如需修改，請於講師群組提出。」（存摺原寫「聯繫管理員」，一併改）。

**證據**：`node scripts/verify-bank-account-lock.mjs`（本機臨時 Postgres 套 migration）
→ `PASS: bank account lock database guard`；`node scripts/verify-profile-draft.mjs` 27/27 PASS
（新增 T10a–f：五欄唯讀、提示文字、草稿不覆蓋、首次可填、admin 可編輯、存摺提示文字）；
截圖 `培訓web/scripts/shots/bank-locked-teacher.png` 判讀灰底與提示框正常；ESLint 通過。

**⚠️ 待業主 1 步**：Supabase SQL Editor 貼上執行上述 migration，再跑
`SELECT tgname FROM pg_trigger WHERE tgname = 'trg_guard_instructor_bank_account';` 應回 1 列。
套完之前，鎖定只有前端擋（繞過畫面仍可改），不會壞但不完整。

**地雷**：鎖定判準是「DB 已有銀行帳號」；管理員替講師清空帳號後，講師可重新填寫一次（預期行為）。
本機 `wip/20260812-2128-main` 分支另有大量未部署改動，本次刻意只從 origin/main 分出 `feat/lock-bank-account` 上線這一項。

---

## 🏦 2026-08-25：匯款資料完整度與最新值填表（✅ 已上線）

**需求與修正**：表單下載中心新增「匯款資料完成狀態」，逐位檢查匯款戶名、銀行、
分行、帳號、銀行代碼與存摺封面，可一鍵篩選齊全／尚未完整名單；大頭照繼續為選填。
存摺不論來自受控 Storage 或已匯入的 Google Drive 連結都會計入完整度，銀行代碼允許最新
匯款清冊實際存在的 6 或 7 碼。畫面不再顯示「可從既有資料帶入」或「舊匯款帳戶資料」，
避免已完成的結構化回填在後台被誤解為仍需人工處理。

**下載資料一致性**：講師名單與表單下載中心的單筆、批次下載，都會在產生 PDF 前依
`instructors.id` 重新讀取資料庫最新值；不會使用網頁載入時的舊快照。未認領講師也可以主檔
`id` 完成下載稽核，`target_user_id` 可合法為空，不再只覆蓋已認領帳號。

**驗證**：42/42 單元測試、34/34 資料完整度關卡瀏覽器回歸、27/27 合約停用與後台填表
瀏覽器回歸、存摺首次上傳／修改需管理員的資料庫防護測試、本次檔案針對性 ESLint、production
build 與 `git diff --check` 皆通過。桌機與 390px 手機後台截圖已實際檢視，無水平溢出。
全站 lint 仍有 5 個未修改舊檔案的 React Hook 錯誤與 3 個警告，與本次差異無關。

**正式發布證據與邊界**：功能提交 `8636279` 已快轉推送 `main`；GitHub deployment `6077830788`
由 Zeabur 回報 production success。`dream-one-teacher.zeabur.app` 與 `teacher.dreamcube.tw`
均載入 `index-q_RL3BWI.js`，SHA-256 與乾淨本機 build 同為
`51c1b36a92cd904b09b4eb94e8b0bf9bb0c234dc1585ccb834080a1c5735e979`，正式 bundle 命中匯款完整度、
即時讀取最新值與 6／7 碼校驗字串。本次發布未修改 Supabase schema、正式講師資料或
Storage 物件；Chrome 當下為未登入狀態，因此未用真實 Google 帳號產生正式下載稽核寫入，
管理端行為以完全 mock Supabase 的真 Chrome 回歸與逐位元一致正式 bundle 共同覆蓋。

---

## 🧩 2026-08-24：講師舊資料結構化對帳（✅ 已上線）

**問題與根因**：表單下載中心以 22 個新結構欄位計算完整度，但舊匯入程式把戶籍地址寫進通訊地址、
把真正通訊地址暫存在經歷欄，且未將暱稱、身分證性別碼、舊匯款自由文字拆入新欄位，造成 263 位講師
只有 1 位真正符合目前的完整度規則；這不是其餘講師都沒交資料。最新版 Google 表單另有 9 筆較新的
回應，當中可替正式庫再補回 2 位講師的 Line、經歷與身分證文件連結。

**已完成的安全對帳**：新增不覆寫既有值的本機對帳工具，以 Email 優先、唯一姓名次之配對最新版
表單與老師總表；銀行資料只接受「7 碼機構代號／帳號／同名戶名」三者都唯一且可由金管會金融機構
資料核對的列。Dry run 顯示 260 位可安全改善，包含暱稱 257 位、身分證性別碼 234 位、戶籍地址
56 位、已確認的銀行結構欄位 67 位、已知地址對調 14 位及最新版表單新增文件 2 位；其餘 3 碼銀行
代號、戶名不一致、缺存摺等情況維持待本人確認，不猜值、不覆寫已填資料。大頭照仍為選填。

**程式修正與驗證**：未來匯入會把戶籍／通訊地址放入正確欄位、組合經歷、補安全暱稱與性別碼，
並只補空欄位；下載中心會把「可從既有資料帶入」與真正缺少分開顯示，PDF 暱稱也會沿用 Line 名稱
或姓名。Python 對帳測試 7/7、前端測試 39/39、針對性 ESLint、production build、UI 回歸與
`git diff --check` 均通過；完整度關卡 34/34、登入認領 9/9、資安隔離資料庫回歸也全部通過。

**正式資料證據**：正式寫入前確認 263 位講師、260 筆 patch 全部存在且 `updated_at` 衝突為 0；
同一交易先完成 260 筆 rollback rehearsal（persisted 0），再以相同防衝突條件正式 commit 260 筆。
Postflight 維持 263 位講師，結構完整者由修正後基準 1 位增至 15 位，暱稱 263 位、性別 240 位、
戶籍地址 221 位、五項銀行結構資料 69 位；身分證正面 146 位、反面 144 位、存摺封面 38 位，
與來源預期一致。仍有 95 位保留舊匯款自由文字、未安全拆分；這些繼續由講師本人確認，不猜值。

**正式發布證據**：功能提交 `ead8d48` 與回填紀錄提交 `9fcf17f` 已推送 `main`；GitHub deployment
`6059268873` 由 Zeabur 回報 production success。`dream-one-teacher.zeabur.app` 與
`teacher.dreamcube.tw` 均載入 `index-DWfWf44I.js`，大小 2,251,892 bytes，SHA-256 與本機 build
同為 `3a07d1383f2571398b216dd0a40ddb747bbf239713d91cc73bd9d5a79afbae51`；正式 bundle 命中
「可從既有資料帶入／整理」、「尚未轉成正式欄位」與「舊匯款帳戶資料」。正式首頁無 console error，
未登入直連下載後台會回首頁，匿名 REST 查詢 `instructors` 維持 HTTP 200 空陣列，未因回填暴露個資。

---

## 👤 2026-08-24：講師主檔與 Google 帳號認領併軌（✅ 已上線）

**核心模型**：`public.instructors` 統一作為講師本人、文件、銀行與薪資資料的主檔；
`instructors.user_id` 只表示 Google 帳號是否已認領，不再用「邀請名單」判斷講師是否存在。
已匯入或後台建立、Email 唯一且狀態可用的講師，第一次 Google 登入即自動認領並取得講師權限，
同一帳號後續登入直接沿用；完全未建檔的新帳號才以 `pending` 建立，填完必填資料後由管理員核准。
`frozen` 與 `cancelled` 講師會在 Auth hook、認領 RPC 與內容 RLS 三層被拒絕。

**管理與資料完整度**：帳號後台改為顯示所有帳號及講師主檔的「已認領／未認領」狀態，舊的講師
邀請／認領申請頁退出導覽。表單下載與文件完成度直接遍歷所有講師主檔，不要求 `user_id`；既有匯入的
`*_external_url` 與之後上傳的 Storage path 都算文件，大頭照維持選填，必填文件固定為身分證正反面與
存摺封面。現有 401 個 `drive.google.com/open` 分享頁會先轉成 Google Drive 可跨來源讀取的文件下載網址，
再於產 PDF 時實際讀取並嵌入；圖片會正規化，PDF 則嵌入第一頁。讀取失敗時明確要求重新上傳，不會
靜默產生缺圖表單。其他網域或非 HTTPS
外部網址不會被當成已完成文件，避免後台產表替任意網址發出請求。
講師主檔的主要 Email 對非管理員鎖定為目前 Google Auth Email，避免 pending 帳號製造別人的重複主檔。

**相容與防漏**：既有 `teacher` 舊名單會先轉成講師主檔；歷史 `admin`／`mentor` 帳號資料只保留為
staff 首次登入的一次性相容入口，登入後立即消耗，不重新引入講師邀請名單。Email 衝突帳號會停在
唯讀協助頁，不能進入新主檔建立流程；解除認領只移除帳號連結並暫停原 teacher 角色，不刪講師文件、
薪資或歷史資料，同一 Google 帳號下次登入可重新認領。

**驗證**：37/37 單元測試、9/9 靜態 Auth／主檔規則、隔離 PostgreSQL migration 與權限測試、
12/12 首次／重複認領瀏覽器情境、34/34 個資完整度與公告例外瀏覽器情境、管理後台與未認領主檔
瀏覽器回歸均通過；測試亦實際下載外部身分證正反面及存摺圖片並產生可載入 PDF。變更檔案的針對性
ESLint、production build 與 `git diff --check` 通過。全站 lint 剩 5 個既有未修改檔案的 hook/compiler
錯誤與 3 個警告，與本次變更無關。

**正式環境證據**：`2026-08-24_align_instructor_claim_flow.sql` 已以單一 transaction 套用至
Supabase production。套用前後均為 263 位講師、12 位已認領、251 位未認領、3 位停用；舊 teacher
invite 為 0，migration 所需資料表與欄位無缺漏。Postflight 確認 12 個敏感函式皆為
`SECURITY DEFINER` 且固定空 `search_path`，Auth hook 只授權 `supabase_auth_admin`，anon／authenticated
不可直接執行；停用講師殘留 teacher 權限、下載稽核未回填筆數均為 0，兩個 trigger、公告 RLS、
Email 與下載稽核索引皆生效。Before User Created hook 在 Dashboard 顯示 Enabled 並指向
`public.hook_allow_known_google_signup`；模擬未建檔 Google 帳號會放行，重複 Email、停用與已認領主檔
分別回 409／403／409。Security Advisor 重跑為 0 errors；30 個 warnings 中 28 個為發布前基準，
新增 2 個為具函式內身份檢查的 authenticated `SECURITY DEFINER` RPC 通用提醒。

程式提交 `b93be40` 已快轉推送 `main`，GitHub deployment `6058481812` 由 Zeabur 回報 production
success。`dream-one-teacher.zeabur.app` 與 `teacher.dreamcube.tw` 均載入
`index-NyEvJ5A3.js`，大小 2,250,451 bytes，SHA-256 與乾淨 build 同為
`8d5f3973479652edac0f249756090a46b6348a840d69093a9b4f986c590cbdef`。正式首頁正常渲染且無 console
錯誤；匿名直連 `/courses`、`/admin/instructors`、`/profile` 均回登入首頁，匿名 REST 查詢講師與下載
稽核資料皆為空陣列，直接呼叫認領與 Auth hook RPC 均回 HTTP 401。此次 production smoke 未實際建立
新的 Google Auth 帳號，避免為驗證產生正式帳號或認領異動；首次登入各分支由正式函式模擬、完整隔離
PostgreSQL 測試與逐位元一致的正式前端 bundle 共同覆蓋。

---

## 📢 2026-08-23：公告區域登入與講師權限限制（✅ 已上線）

**需求與修正**：公開首頁不再查詢或顯示公告，待審核帳號同樣看不到；只有已登入且角色為
`teacher`、`mentor` 或 `admin` 的帳號會看到公告區域。公告詳情路由也套用相同守衛，避免未登入或
待審核使用者知道網址後直接開啟。後端同步移除匿名讀取 policy 與表權限，已發布公告只允許上述
核准角色讀取；管理員保留原有草稿與 CRUD 權限。`authenticated` 的表權限另收斂為必要的
`SELECT`／`INSERT`／`UPDATE`／`DELETE`，不再殘留可繞過 RLS 的 `TRUNCATE`。

**證據**：乾淨 `origin/main` worktree 的 31/31 單元測試、針對性 ESLint、production build、
`git diff --check` 通過；完全 mock Supabase 的瀏覽器回歸 6/6，覆蓋匿名、待審核與核准講師的首頁
及公告直連。隔離 PostgreSQL 套用同一 migration，確認匿名／待審核不可讀、teacher／mentor／admin
可讀已發布公告。正式 Supabase catalog 重驗 RLS 已開啟、匿名無任何表權限、核准角色 SELECT policy
已生效；匿名 REST 查詢回傳 HTTP 401 `permission denied for table announcements`。重新執行
Supabase Security Advisor 為 0 errors；28 個既有 SECURITY DEFINER 函式警告與本次公告變更無關。

**正式環境證據**：功能提交 `1740a04` 已推送 `main`，GitHub deployment `6048279809` 由 Zeabur
回報 production success。`dream-one-teacher.zeabur.app` 與 `teacher.dreamcube.tw` 均載入
`index-CE9CHGnH.js`，SHA-256 與乾淨 build 同為
`076a3cc138f4489e94be240531ab42600519619a517ef0704a443fde1e1998ce`。正式站匿名首頁實際確認沒有
公告區域，匿名直連公告網址會回到首頁；正式 bundle 與通過 6 種角色／路由情境的本機 bundle
逐位元一致。

---

## 📚 2026-08-23：導航列「教材資源」與後台網址管理（✅ 已上線）

**需求與做法**：講師桌面與手機導航列新增「教材資源」，點擊後在新分頁直接開啟
`https://dreamone-teaching-materials.vercel.app/`。網址沿用既有受 RLS 保護的 `site_links` 表，
設定 key 為 `teaching_materials`；尚無資料列或讀取失敗時使用指定網址作為安全預設值。原後台
「薪資頁連結」擴充為「網站連結管理」，管理員可編輯教材資源網址，首次儲存以 upsert 建立設定列；
導航名稱固定為「教材資源」，不會因後台誤改文案而漂移。只接受不含帳密的 HTTP／HTTPS 網址，
拒絕 `javascript:`、`data:` 與其他可執行／非網頁協定。教材入口沿用 `ProfileCompleteGate` 的
個人資料完成度；講師未完成時桌機與手機皆顯示真正停用、沒有 href 的入口，完成儲存後即時解鎖。
管理員與輔導員維持既有門檻豁免。

**證據**：指定教材站目前 HTTP 200，頁面標題為「夢想一號魔術方塊學院 - 魔術方塊教材系統」。
純函式安全測試連同乾淨 `origin/main` 既有測試共 29/29；本次檔案針對性 ESLint、production build 與
`git diff --check` 通過。完全 mock Supabase 的真 Chrome 回歸 22/22：覆蓋無 DB 列時的預設網址、
新分頁、後台預填與 upsert payload、重新載入後採用新網址、1280／1440px 桌面導航不重疊、
390px 手機導航無溢出且入口高度至少 44px、未完成講師的桌機／手機入口無法點擊且不存在外部連結，
以及儲存完整資料後即時解鎖並採用後台網址，page error 為 0。截圖在
`/tmp/dream-one-teaching-materials-navigation/`。

**正式環境證據與邊界**：功能提交 `4f4a104` 已推送 `main`，GitHub deployment `6047589224`
由 Zeabur 回報 production success。正式站與乾淨發布 build 均載入 `index-Cs5nekxh.js`，SHA-256
皆為 `a9c6af14e1882e2c8dc711ce12b7ebe22f147045e66e002288309618b24313b7`；正式 bundle 命中
`teaching_materials`、指定教材網址與個人資料未完成鎖定提示。沿用已上線的 `site_links` 表與既有
「登入可讀、僅 admin 可寫」RLS，不需新 migration，且未寫入正式 Supabase。即使正式庫尚無
`teaching_materials` 列，導航仍會使用指定預設網址；管理員第一次在後台儲存後才建立設定列。

---

## 🧾 2026-08-23：講師端合約／薪資入口暫停與後台自動填表（✅ 已上線）

**需求與修正**：合約簽署尚未正式開放，因此講師個人頁不再顯示合約簽署區塊、狀態、提醒或重簽
限制，舊的合約通知不會顯示或計入未讀；講師直連合約檢視／簽署路徑會回到個人資料。講師導覽列也
移除「我的薪資」，直連既有薪資頁同樣回到個人資料。管理端的合約管理與講師資料仍保留；講師名單
新增啟用中表單模板選擇及每位講師的「下載表單」，以既有自動填表邏輯產出 PDF，並寫入下載稽核紀錄。

**證據**：乾淨 `origin/main` worktree 的針對性 ESLint、26/26 單元測試、production build 與
`git diff --check` 通過。完全 mock Supabase 的真瀏覽器回歸 19/19：講師端合約區塊、通知、查詢、
寫入、薪資導覽與直連路徑皆停用；管理員仍可進入合約後台，並於桌機與 390px 手機版下載實際嵌入
講師資料的 PDF，頁面水平溢出為 0。全站 lint 仍有未修改基準檔案中的 6 個錯誤與 4 個警告。

**正式環境證據**：功能提交 `09ad0f3` 已推送 `main`，並包含在最新程式提交 `3981a14`；GitHub
deployment `6047578662` 由 Zeabur 回報 production success。正式站與乾淨 build 均載入
`index-DLeCQL0N.js`，SHA-256 同為
`b065e2a4c027cb4c7c591b39cdd2ba3968fdb27ed956004bbf8938c91f05dd76`，正式 bundle 命中
「講師資料自動填表」、「下載表單」與未設定模板提示；公開首頁實際瀏覽為 HTTP 200 且頁面錯誤為 0。

**正式環境邊界**：本次只更新前端、管理端既有 PDF 產生流程與回歸腳本，未修改 Supabase schema、
RLS、Auth、正式講師資料或 Storage 物件；正式站驗證只讀取公開頁面與靜態資產，管理端下載回歸使用
完全 mock Supabase，未對正式資料寫入或產生下載稽核紀錄。

## 🗂️ 2026-08-23：課程大分類與分類層級權限（✅ 已上線）

**需求與完成內容**：`我的課程` 在原課程卡片前新增一層「課程大分類」，使用者先看到自己有權限的
大分類，進入後才看到分類內課程。後台新增獨立的大分類管理頁，可設定名稱、說明、排序、發佈狀態與
「全部／實習／正式」可見對象；課程編輯頁可指定所屬大分類，原本每門課程的可見對象仍保留，實際
權限取大分類與課程條件的交集。既有課程套 migration 時會自動歸入已發佈的「講師培訓課程」，不會
因新增必填分類而消失。

**權限邊界**：新增 `course_categories` 與 `courses.category_id`，並以 RLS 同步限制分類、課程、章節、
內容、進度、作業、培訓狀態、章節留言與留言按讚。一般講師即使知道課程或章節 UUID，也必須符合
分類可見對象、課程可見對象、已發佈狀態與既有完整個資門檻；管理員保留草稿與完整 CRUD 權限。

**證據**：隔離 PostgreSQL 真正套用 migration，驗證管理員、實習講師、正式講師、資料未完整講師
四種身份與所有下游資料表的直接讀取，共同限制與既有課程回填皆通過。針對性 ESLint、26/26 單元測試、
production build、`git diff --check` 通過；Impeccable 掃描無問題。真瀏覽器以 1440px 與 390px 驗證
大分類首頁及分類內課程頁，手機水平溢出為 0、瀏覽器錯誤為 0。

**正式環境證據**：正式 Supabase 已先以單一 transaction 套用
`20260823094617_add_course_categories.sql`；catalog 驗證確認 9 張相關資料表皆維持 RLS、
6 門既有課程全數完成回填且 `category_id` 為必填。程式提交 `9b3d774` 已推送 `main`，GitHub deployment
`6047173245` 由 Zeabur 回報 production success；正式站與乾淨 build 的 `index-BCl4DyZx.js` SHA-256
皆為 `18ee3671d345c9d76532e5bfabb2f890b5922e85a6504545a74f790266b3b75c`。登入正式站實測可先看到
「講師培訓課程」大分類、進入後讀取 6 門課程，後台可設定名稱、說明、排序、發佈與可見對象。

## 🎞️ 2026-08-23：YouTube 播放清單嵌入修復（✅ 已上線）

**問題與修正**：內容編輯器原本只會把單支影片、`youtu.be` 與 Shorts 轉成 YouTube embed URL；
`playlist?list=...` 被原樣放進 iframe 後會遭 YouTube 拒絕連線。現在統一由
`src/lib/youtube.js` 解析，完整播放清單改成 `embed/videoseries?list=...`；從清單內分享的單支
影片也會保留 `list` 與 `index`。舊版內容編輯器、畫布編輯器、前台課程頁與作業審核頁均使用
同一個 helper，既有資料不需重存即可在顯示時轉換。

**證據**：乾淨 `origin/main` worktree 的 26/26 測試、針對性 ESLint、production build 與
`git diff --check` 通過；`AssignmentReview.jsx` 的 `fetchAll` 宣告順序 lint error 已確認存在於發布前
基準版本，本次未擴大修正。功能 commit `17ffb85` 已推送 `main`，GitHub deployment
`6046192137` 由 Zeabur 回報 production success。正式站與乾淨 build 均載入
`index-B1ZuFdT5.js`，大小同為 2,260,328 bytes，SHA-256 同為
`e34331ec4b7f0ecfe59f780282d848479e17b3e2a92df5fe5512540e1219d317`；正式 bundle 命中
`embed/videoseries?list=` 播放清單轉換邏輯。

**正式環境邊界**：本次只更新前端網址解析與測試，未修改 Supabase schema、資料、RLS 或 Storage，
不需 SQL migration。

## 🛡️ 2026-08-19：Codex Security 全專案修復（🚀 正式發布中）

**完成**：新增 canonical migration `20260819140407_security_hardening_release.sql`，把個人資料完整度
改為 DB authorization，限制講師更動管理欄位、作業回饋讀取範圍、合約與通知 client 偽造，並用
trigger／受控 RPC 建立通知。已存存摺不得由講師覆寫或刪除；文字草稿改存受 RLS 保護的 server-side
table，檔案延後到按下儲存才上傳。大頭照維持選填，身分證正反面與存摺仍為必填關卡。

富文本儲存與顯示加入 DOMPurify allowlist，私密 PDF worker 改用同版本同源 bundle；Docker build
context 改 allowlist 並加 CSP／安全 headers；高權限匯入工具恢復 TLS 驗證。正式 Supabase 已在每日
備份可用的前提下，以單一 transaction 套用 migration；catalog 驗證確認 RLS、trigger、Storage
policy、合約與 WCA grants 已生效。WCA 新值已安全擷取，但 GitHub Actions Secret 的瀏覽器更新仍待
完成；在完成前排程同步會暫時失敗，不得恢復 Git 歷史中的舊值。

**本機證據**：`npm test` 29/29；完整度／富文本真瀏覽器、草稿／檔案／存摺、管理欄位過濾與
`npm run verify:security` 均通過。Production build 與本次檔案針對性 ESLint 通過；全專案 lint 的
既有錯誤另行追蹤。合約功能繼續維持關閉，重開前仍需可信任 OTP、文件 hash 與簽署證據流程。

## 👤 2026-08-19：講師大頭照改為選填＋銀行資料缺漏核對（✅ 已上線）
**需求**：大頭照不可再作為首次填寫完成或跨頁瀏覽的必填條件；同時要找出 production 最多人缺漏的
資料項目，交付可人工核對的講師名單，避免把舊格式資料誤判為完全沒有填。

**修正**：`profileCompletion.js` 的必要文件只保留身分證正面、身分證反面與存摺封面；個人頁送出時
不再攔截缺少大頭照，並明確標示「大頭照為選填，可稍後補上」。身分證與存摺的必填、存摺首次儲存後
鎖定及公告頁例外均維持不變。production 只讀盤點 263 位講師後，最多缺漏的是五個銀行結構欄位，
以銀行戶名為核對代表共 261 位；其中 160 位仍有舊銀行自由文字、35 位有存摺封面，不能直接判定為
完全無銀行資料。已另產出只含姓名與存在旗標、不含帳號／證號／文件連結的 XLSX 核對表。

**證據**：本次三支程式與測試檔針對性 ESLint、`git diff --check`、production build 通過；完整資料
關卡本機與正式網址各 33/33 通過，包含「只缺大頭照可瀏覽課程、顯示選填提示、仍可成功儲存」以及
六個未完成樣本在四個受保護頁面全部導回個人資料。草稿／Storage 回歸 20/20、存摺資料庫鎖定測試
通過。程式提交 `0e32072` 已推送 `main`；GitHub deployment `5967366051` 由 Zeabur 回報 production
success。正式站與本機皆載入 `index-DRCL97t-.js`，大小同為 2,225,698 bytes，SHA-256 同為
`ce1b252c0c4da97446b7a13b866145560f4882553935ae73d2f50f4892f90783`，正式 bundle 命中新的選填提示，
舊的大頭照必填提示已消失。

**正式環境邊界**：本次只更新前端與測試，未修改 Supabase schema、RLS、Auth、講師資料或 Storage
物件。缺漏核對僅執行 production 讀取；正式網址回歸完全攔截 Supabase 請求，沒有寫入正式資料。

## 🔤 2026-08-15：畫布多行縮排與字級選取穩定性（✅ 已上線）
**問題**：文字框反白多行後按 Tab 只會處理選取錨點所在的第一列；一般段落又使用只影響首行的
`text-indent`，同段落換行文字看起來不會一起移動。字級輸入框／常用字級取得焦點後會取代原本的
文字選取，套用 18px 等尺寸時又因 `<font>` 換成 `<span>` 而讓瀏覽器範圍失效，造成反白跳走或套用失敗。

**修正**：Tab／Shift+Tab 改為收集選取範圍相交的所有段落與清單項目；一般文字用整段
`margin-left` 進退 2em，清單維持真正的巢狀階層。字級工具列在操作前保存文字範圍，DOM 格式轉換後
依文字位移精確重建反白範圍，並把字級／縮排結果即時同步回畫布 state，沿用既有 800ms 自動儲存。

**證據**：新增文字縮排／格式純函式測試，連同既有畫布測試共 19/19 通過；本次五支程式與測試檔
針對性 ESLint 0 問題、production build 與 `git diff --check` 通過。完全 mock Supabase 的真瀏覽器
回歸通過：三段一般文字 Tab／Shift+Tab 全數同步、三項清單同步建立／解除階層；反白三行後以輸入框
18→20px，再用常用尺寸選回 18px，每次三行字級都正確且反白內容全程不變；自動儲存狀態顯示已儲存，
收到對應 PATCH，瀏覽器錯誤 0。全站 lint 仍有未修改檔案中的 12 個既有錯誤與 6 個警告；Impeccable
只回報兩個本次未新增的既有底部面板 `border-t-2` 警告。程式提交 `85d6407` 已推送至 `main`；
GitHub deployment `5920843022` 由 Zeabur 回報 production success。正式站與乾淨發布 build 皆載入
`index-DWBZvzXS.js`，大小同為 2,222,457 bytes，SHA-256 同為
`8d34dafe333ec2f5c0432df2e8d45f8329b213fe268b9506ebaef17f17ac77f3`；正式首頁正常渲染且瀏覽器錯誤 0。

**正式環境邊界**：已完成 push／Zeabur 部署；未修改正式 Supabase，不需 SQL migration。文字操作
回歸使用完全 mock Supabase，正式站驗證只讀取公開首頁與靜態資產，未修改課程內容。

## 👤 2026-08-14：首次登入資料門檻與再次填寫安全修正（✅ 已上線）
**問題**：戶籍地址雖是表單必填，卻漏在跨頁完成度門檻；講師剛補齊資料後第一次換頁會被舊狀態
彈回；無基準資訊的舊 localStorage 草稿可能蓋掉較新的 DB 值；照片／證件替換與移除會先刪 Storage
舊檔，若新檔上傳或後續儲存失敗，DB 可能指向已刪除物件。公告頁原本就是產品允許的例外，維持不變。

**修正**：表單驗證與跨頁門檻改共用 `profileCompletion.js`，納入戶籍地址；門檻的查詢結果綁定
使用者與路徑，儲存成功另發完成度事件，避免舊狀態搶先導頁。草稿升級為 v2 envelope，保存 DB
基準快照；基準不同或既有 DB 遇到無基準的舊草稿時，以 DB 為準。檔案流程改為先上傳新檔，
成功儲存 instructors 新路徑後才刪除排隊中的舊檔；只按移除、尚未儲存時不碰 Storage。

**證據**：針對性 ESLint 與 `git diff --check` 通過；production build 通過。真瀏覽器關卡回歸
6/6（含戶籍地址、公告例外、第一次換頁），草稿／Storage 回歸 14/14（含舊草稿、DB 更新、上傳失敗、
成功替換順序與未儲存移除）。全站 lint 的 12 個錯誤與 6 個警告皆在未修改檔案。程式提交
`5bd406c` 已推送 `main`，GitHub deployment `5908504460` 由 Zeabur 回報 production success；正式站
bundle `index-CapDLJDa.js` 與本機皆為 2,219,805 bytes，SHA-256 同為
`e1fed6ff0f3fcb9e9e31cc3eaa9c50b654f937e09a70e12d163b7942c7852a2c`。正式 bundle 搭配完全攔截
Supabase 的假講師 session 驗證 5/5，未寫入正式資料。

**正式環境邊界**：本次只有前端程式與測試，未修改正式 Supabase schema、資料、RLS 或 Storage 物件。

## ↔️ 2026-08-14：畫布多選統一縮放（✅ 已上線）
**需求**：多選物件後要能像 Canva 一樣直接拖曳選取框控制點；拖曳左右邊只改整組寬度、上下邊只改
整組高度，拖曳四角則等比例調整整組大小，並保留各物件之間的位置比例，不建立永久群組。

**做法**：多選外框新增四邊與四角共八個可操作控制點。縮放開始時保存各元素起始幾何，之後以共同
錨點與比例同步換算 `x/y/width/height`；左右／上方維持畫布邊界，所有物件遵守既有最小尺寸，線條與
箭頭沿用較小的最小高度。縮放時暫停一般拖曳與距離標示，`Esc`／pointer cancel 會還原起始幾何；
鎖定元素不能混入暫時多選縮放。尺寸變更沿用畫布 800ms 自動儲存，不增加 Group 或新資料格式。

**證據**：畫布選取＋持久化純函式單元測試 14/14；本次三支程式檔針對性 ESLint 0 問題；
`git diff --check` 與 production build 通過。完全 mock Supabase 的真瀏覽器操作驗證通過：八個控制點
全部可見；右側拖曳讓整組 `320×220→440×220` 且個別高度不變；下側拖曳讓整組
`320×220→320×310` 且個別寬度不變；右下角讓整組與兩個元素的寬高精確放大 1.25 倍；三種操作
均收到兩筆自動 PATCH 並顯示「已儲存」。Impeccable 檢查未發現本次新增控制點問題；發布工作樹的
全站 lint 仍是未修改檔案中的 13 個既有錯誤與 6 個警告。程式提交 `00c6196` 已推送至 `main`；
GitHub deployment `5907948528` 由 Zeabur 回報 production success。正式站已換成
`index-BJNNaT_9.js`，線上與乾淨發布建置的 bundle 皆為 2,219,372 bytes，SHA-256 同為
`f236de9208c669ed1ae8f22ed28ba54cce061768ace546bfaf15ba8087634612`。正式站登入實機以 Cmd+A
選取 15 個未鎖定元素，八個縮放控制點與操作提示全部出現；Esc 清除後控制點歸零，瀏覽器錯誤 0。

**正式環境邊界**：已完成 push／Zeabur 部署；未修改正式 Supabase，不需 SQL migration。正式站
驗證只讀取畫面與暫時選取元素，未拖曳、未儲存、未修改課程內容。

## 💾 2026-08-14：畫布自動儲存與離開前保護（✅ 已上線）
**需求**：畫布內容不應依賴使用者記得按「儲存」；拖曳、縮放、文字輸入、樣式調整、新增、複製等
變更都要自動保存，避免未按按鈕或直接返回後必須重做。

**做法**：沿用既有 `contents` 寫入格式，載入時建立每個元素的儲存指紋，之後只保存真正有變動、
新增或因刪除而重排的元素。操作停止 800ms 後自動儲存，文字框與按鈕文字在輸入時就同步進 React
state；所有寫入以 queue 串行化，新元素另存 client ID→DB ID 對照，避免連續編輯造成重複 INSERT。
頂部新增「準備自動儲存／自動儲存中／已儲存時間／失敗」狀態與手動重試；返回、切換傳統模式、
頁面切到背景時會立即 flush，關閉仍有未存內容的頁面則觸發瀏覽器離開警告。

**證據**：畫布選取＋持久化純函式單元測試 10/10；本次五支檔案針對性 ESLint 0 問題；
production build 通過。完全 mock Supabase 的 1440px 真瀏覽器測試通過：初始載入 0 寫入、方向鍵移動
自動 PATCH、失敗狀態與重試、新增元素只 POST 一次、後續文字輸入以新 DB ID PATCH、800ms 內直接
返回仍先寫完才離開；狀態列無擠壓或溢出。發布工作樹全站 lint 的 13 個既有錯誤與 6 個警告均位於
未修改檔案。程式提交 `ecc062c` 隨發布提交 `00c6196` 推送至 `main`，GitHub deployment
`5907948528` 由 Zeabur 回報 production success；正式 bundle 已命中 `canvas-autosave-status` 與
「自動儲存中」字串。登入正式畫布實機確認初始狀態顯示「所有變更已儲存」，瀏覽器錯誤 0。

**正式環境邊界**：已完成 push／Zeabur 部署；未修改正式 Supabase，不需 SQL migration。正式站
驗證未製造內容變更，因此沒有觸發正式資料寫入。

## 🖱️ 2026-08-14：畫布框選與暫時多選（✅ 已上線）
**需求**：畫布空白處可像 PPT／Figma 一樣拖曳框選所有相交的未鎖定元素；多選後可一起移動、
刪除、複製貼上、方向鍵微調，並支援 Shift 加減選、Esc／空白取消與 Cmd/Ctrl+A 全選未鎖定元素。

**做法**：`CanvasEditor` 將原本單一 `selectedId` 擴充為暫時的 `selectedIds` 集合，框選與群組外框
只存在編輯器狀態，不會建立或儲存 Group。群組拖曳以各元素起始座標加共同位移同步更新，整組維持
畫布左右／上方邊界；鎖定元素不參與框選、全選、拖曳或方向鍵移動。新增內部剪貼簿支援
Cmd/Ctrl+C、Cmd/Ctrl+V，刪除只確認一次；既有鎖定狀態也會寫入 `position_data`，重新開啟後仍有效。

**證據**：純函式單元測試 5/5；本次三支程式檔針對性 ESLint 0 問題；production build 通過；
真瀏覽器逐項通過框選相交、鎖定排除、群組拖曳、Shift 加減選、全選、方向鍵、複製貼上、群組刪除、
Esc 與空白取消，並完成 1440px 畫面檢查。全站 lint 仍被 13 個既有錯誤與 6 個警告擋住，
均位於本次未修改檔案。程式提交 `e90415b` 已推送至 `main`；GitHub deployment `5900314758`
由 Zeabur 回報 production success。正式站已換成 `index-DI0Uc3uw.js`，線上與本機通過測試的 bundle
皆為 2,211,543 bytes，SHA-256 同為
`14a407e68a8e2a76390ca91b49b36500aef1454e99b3aebb536e6284f1da737b`。正式站登入實機確認拖曳框選
2 個相交元素、Shift 減選／加選、Cmd+A 全選 51 個未鎖定元素與 Esc 清空均生效，瀏覽器錯誤 0；
驗證過程未按儲存、未刪除正式資料。

**正式環境邊界**：已完成 push／Zeabur 部署；本次未修改正式 Supabase。鎖定欄位沿用既有
`contents.position_data` JSON，不需 SQL migration；框選本身不會建立或儲存 Group。

## 🚧 2026-08-14：講師前台簽約功能暫停（✅ 已上線）
**需求**：合約內容調整期間，前台講師暫時不能使用簽約功能，後台管理仍保留。

**做法**：新增集中開關 `src/lib/featureFlags.js`，目前設為關閉。講師個人頁不再
查詢或顯示簽約狀態；舊的合約通知不顯示、不計入未讀數；登入時不再新增簽約提醒；
直接開啟 `/contract` 或 `/contract/view/:id` 會導回 `/profile`。管理員仍可進入合約後台與
查看已簽合約；在暫停期間上傳新版合約文件也不會發通知給講師。既有合約與通知資料均未刪除，
未來調整完可由同一開關恢復。

**證據**：`npm run build` 通過；本次改動檔案的針對性 ESLint 與 `git diff --check` 通過；
`scripts/verify-contract-feature-paused.mjs` 真瀏覽器回歸 **9/9** 通過，覆蓋入口隱藏、通知過濾、
直連封鎖、講師端零合約查詢／通知寫入，以及管理員檢視與後台保留。視覺截圖人工檢查通過；
既有個人資料草稿與 DB 載入回歸也是 **9/9** 通過。程式提交 `2f56844`，測試依賴補齊提交
`205f1b4` 已推送至 `main`；GitHub deployment `5899886227` 由 Zeabur 回報 production success。
正式站已換成 `index-D9zYHs1H.js`，線上與本機通過測試的 bundle 皆為 2,211,450 bytes，
SHA-256 同為 `78af9e98b78e6dfad265a118291a87a9d5c19631881874b7307080362d3fc0d5`，並命中
「前台簽約功能暫停中／未通知講師」新字串。

**正式環境邊界**：已完成 push／Zeabur 部署；本次未修改 Supabase 資料或權限。這是前台功能暫停，
不是後端權限撤銷；若未來要把合約 API 也強制停用，需另行設計並授權套用正式資料庫變更。

## 🔒 2026-08-12：講師等級僅限管理員設定（✅ 程式已推送＋正式 DB 已驗＋前端已上線）
**需求**：首次註冊或剛登入的講師只能看到系統帶入的講師等級，不可選擇或修改；只有管理員可設定。**盤點結果**：正式站目前的個人頁已是唯讀標籤，管理端 `InstructorList`／`TeacherManager` 的等級選單也有 admin 限制；既有 `2026-07-09_claim_id_and_role.sql` 定義 `trg_guard_instructor_role`，非 admin 新增時強制實習、更新時保留舊值。此次再把 `instructor_role` 從講師端草稿與 upsert payload 完全剔除，避免手改 localStorage 或攔截前端請求夾帶等級。新增 `src/lib/instructorProfile.js` 與 `scripts/verify-instructor-role-guard.mjs` 作為回歸防線。

**證據**：專項權限檢查 5/5、個人資料草稿瀏覽器回歸 9/9、針對性 ESLint 0 錯誤、`npm run build` 成功；程式提交 `66e2788` 已推送至 `main`。2026-08-14 已登入正確的正式 Supabase 專案 `DreamCube_teacher` 實機確認：`instructors` RLS 已啟用、`trg_guard_instructor_role` 為啟用狀態，函式內容與版控 SQL 一致；另以子交易回滾測試證明非 admin 更新等級會保留原值、admin 更新則會放行，測試更新已全數回滾，沒有留下正式資料變更。`public.users` 現有 15 帳號皆為 admin，其中 12 個已綁講師主檔；業主已確認這 15 個帳號確實全部都是管理員，角色資料無須校正。2026-08-14 正式站已隨簽約暫停版更新為 `index-D9zYHs1H.js`，實機確認 bundle 仍含「如需變更請聯繫管理員／首次註冊預設」。

## 📎 2026-07-14：個人資料頁上傳文件跨頁保留（✅ 已上線）
本機草稿改為一併保存大頭照與證件的 Storage metadata，重新進入頁面時依「DB＋草稿」合併結果重建簽名預覽；資料載入 effect 僅依 `user.id` 觸發，避免 token refresh 用 DB 舊值覆蓋尚未送出的表單。程式提交 `4239939` 已在 `main`；乾淨環境 `npm run build` 通過，正式站已換為 `index-CestCUpL.js`，線上資產 HTTP 200 且大小與本地建置一致（2,212,006 bytes）。

## 🏆 2026-07-14：個人資料頁成就牆預設收合（✅ 已上線）
「我的教學成就」的 `collapsed` 初始狀態由 `false` 改為 `true`，進入個人資料頁時預設收起，原有點擊展開／收合行為不變。最終 `main` 程式提交為 `5150bda`；相對前一正式版的淨程式差異僅此一行。乾淨環境 `npm ci`＋`npm run build` 通過，正式站已換為 `index-CzAB1z8r.js`，線上資產 HTTP 200 且大小與本地建置一致（2,212,184 bytes）。

## 🏠 2026-07-10 深夜：首頁佈告欄重排（兩次迭代）＋手機視覺優化（✅ 全部上線，最終 bundle index-B3iMwuhO.js 已驗）
**業主回報**：佈告欄緊接 Hero 突兀。第一版移頁尾（b0d70aa）後業主指定改放「願景與使命」正下方＝**最終順序 Hero→願景使命→佈告欄→團隊→活動回顧→實體據點→CTA**（b3dc7af，佈告欄白底＋底部黑框、置中徽章「最新消息」）。
**手機視覺優化（業主指示「優化一下手機視覺」，667dde7）**：ui-designer agent 執行、主對話抽查——六區塊 py-20→py-14 md:py-20、標題群 mb-12→mb-8 md:mb-12、容器 px-6→px-4 sm:px-6、Hero 統計區收緊；**375px 頁長 7601→7173px，桌機（md:+）零變化**；純間距 24 行、無違禁樣式（DESIGN.md 合規）。
**證據**：全站手機稽核 44 檢查 0 溢出/0 錯誤/0 空白（僅存 6 旗標＝已知 20px 勾選框基線）；兩輪 Playwright 截圖 agent 判讀通過＋主對話親手 ls/diff/grep 抽查；build/lint 綠；線上 bundle index-B3iMwuhO.js 含 6 處 `py-14 md:py-20`。

## 🏆 2026-07-10 深夜：WCA 自動同步端到端跑通（✅ 資料已進正式庫）
業主跑完 autosync SQL＋主對話代生密鑰（`openssl rand -hex 32`，業主以 upsert 存入 wca_sync_config；第一次貼歪、重貼後驗證通過）。**主對話手動執行 sync.mjs（業主授權）：117 位有 WCA ID 講師全數抓取成功（0 查無 0 失敗），sync_wca_results 回報寫入 900 筆**。讀回驗證：get_wca_leaderboard 對 anon 回 authentication required（RLS 正常），畫面待業主登入 /leaderboard 看。
**⏳ 唯一殘留**：GitHub 3 密鑰未設（gh token 無權代設）→ 排程自動重跑尚未生效，目前資料已最新、不設不會壞。`WCA_SYNC_SECRET=[REDACTED - store only in Supabase and CI secrets]`（另兩個值=.env 的 URL/anon key）。說明文件已交付業主：`/Users/lazylazy/Desktop/夢想一號/WCA自動同步說明.pdf`。

## 🐛 2026-07-10 深夜：認領清單修復上線（✅＝5dc2f71）
7/9 已修好的「徽章有數字、清單空白」（PGRST200 嵌入失敗）獲業主點頭隨本批上線。端到端待業主登入 /admin/claims 看清單有渲染。

---

## 🏠 2026-07-10：首頁新增「活動回顧」＋「實體據點」兩區塊（✅ 已 commit＋push 上線＝24a4fd1，線上 bundle index-nlo15c0J.js＋6 圖 200 已驗）
**業主指示**：把官網 Google Sites 的「實體據點」與「活動回顧」內容搬到自建培訓網站首頁，排版不同沒關係、好看為主、風格要一致；照片可截圖、地圖放 Google Maps 連結。
**做了什麼（只動 `src/pages/HomePage.jsx`＋新增 6 張圖）**：TEAM 相簿與 CTA 之間插入兩段——
1. **活動回顧**（bauhaus-paper 底）：4 張卡片。第三屆學員賽＝真照片；形象廣告／進駐科教館／規模最大學員賽＝**原官網是 YouTube 影片**，故用官方封面縮圖＋紅色播放鍵，整卡連去 YouTube（J9SAYtSQiZk／KxuKryrr9Ak／Gu9B3hjm9FE）。
2. **實體據點**（白底）：科教館、自然科學博物館兩卡＝照片＋名稱＋「（開放參觀，歡迎來玩）」＋地址＋黑底「地圖位置」鈕（Google Maps search API 連結，新分頁）。
**照片來源**：Google Sites 圖 curl 直抓 403（CSP），改用 Playwright 開已發布頁面 element screenshot，再 sips 縮 1200px＋轉 JPEG（6 張共 1.2MB，原 ~10MB）。
**✅ 證據**：build 綠、HomePage lint 0；Playwright 桌機 1280＋手機 375 截 4 張經 agent 判讀 0 問題（圖片皆載入、播放鍵正確、無橫向溢出、Bauhaus 一致）；線上 bundle 含「實體據點/活動回顧/觀看影片」＋3 YouTube 連結，6 圖皆 200。
**⚠️ 文案初稿待業主過目**：活動說明我修了原站錯字並微調語氣；地址為公開資訊（科教館 台北士林士商路189號、科博館 台中北區館前路1號）。要改字直接說。

---

## ✅ 2026-07-10：WCA 自動同步「前端已上線」，但探測發現 SQL 未套用（前端＝db1a30b，線上 bundle index-C8CamFg6.js 已驗）
業主 2026-07-10 說「幫我上線＋測試，SQL 應該都跑了」。**手術式 commit db1a30b**（只含 WCA 線：sync.mjs＋workflow＋autosync SQL＋TeacherManager 篩選/wca_id 編輯＋移除 WcaManager／路由／NavCard＋ProfilePage 文案；**排除**同工作區的 ClaimRequests bug 線與 course-first-station）→ push 上線。
**測試發現（關鍵）**：線上探測 `get_wca_sync_targets` PGRST202、`instructors.wca_synced_at` 42703 → **`2026-07-10_wca_autosync.sql` 業主其實還沒跑**，自動抓取目前休眠。前端非破壞性（只讀既有 wca_results／寫既有 wca_id，不依賴新 RPC），既有成績照常顯示。
**引擎已驗**：dry-run 打真 WCA API，Feliks Zemdegs 15 項、centiseconds 正確。
**⚠️ 待業主 3 步才會真的自動跑**：(1) Supabase 跑 `2026-07-10_wca_autosync.sql`；(2) `SELECT secret FROM wca_sync_config;` 讀密鑰；(3) GitHub → Settings → Secrets → Actions 設 `SUPABASE_URL`／`SUPABASE_ANON_KEY`（值在 .env）／`WCA_SYNC_SECRET`（=步驟2）。**主對話 gh token 無 secrets 權限（403）代設不了**。設完可在 Actions 手動 Run 一次、或找主對話幫觸發驗端到端。

---

## 🪪 2026-07-10：後台講師姓名顯示舊名修復（✅ SQL 已建置；⏳ 未套用／未 commit，待業主跑 1 步 SQL）
**業主回報**：個人頁把姓名從「大大」改成「懶懶」，後台「講師名單管理」(TeacherManager) 仍顯示舊名「大大」。
**根因（agent 追資料流＋主對話核對 schema）**：姓名存兩處且無同步——`users.name`（Google OAuth
首次登入由 handle_new_user 帶入，之後永不更新；後台講師表 TeacherManager.jsx:699/499 與認領審核
ClaimRequests.jsx:153 讀這份）vs `instructors.full_name`（個人頁 ProfilePage.jsx:363 存檔唯一寫入的
姓名欄）。個人頁只 upsert instructors.full_name、從不寫 users.name，兩者無 trigger/RPC 同步 →
users.name 永遠停在註冊時舊名。**系統性問題**：任何登入過又改過名字的帳號都會對不上。
**修法（純 SQL，不動前端）**：新檔 `培訓web/supabase/2026-07-10_sync_instructor_name.sql`——
(1) AFTER INSERT/UPDATE OF full_name trigger 把 instructors.full_name 同步進 users.name（只在非空白
且值有變時寫）；(2) 一次性回填修正現有所有對不上的帳號。冪等可重跑。同步好後後台/認領清單自動顯示
正確名，前端零改動零部署。
**驗證**：欄位名已對 setup.sql（users.name）/instructors_setup.sql（instructors.full_name、user_id
UNIQUE）核實無誤；SQL 未在真 DB 跑（碰線上，待業主）。
**⚠️ 待業主 1 步**：Supabase SQL Editor 貼上該檔執行 → 檔尾三段驗證查詢確認（trigger 存在、業主帳號
回「懶懶」、殘留對不上 0 列）。**副作用（預期內）**：回填會把所有登入帳號的後台顯示名改成各自個人頁
填的姓名（多數是修正、少數若 Google 名與正式姓名本就不同者會一起被統一為 full_name）。

---

## 🤖 2026-07-10：WCA 成績改「自動同步官方資料」（✅ 已建置＋核心引擎實測正確；⏳ 未 commit／未上線；待業主 3 步設定）
業主 2026-07-10 再轉向：不要手動代填，改由程式**每兩個月自動抓 WCA 官方最新成績**（正確性優先，不用 AI＝用官方數字原封搬）；收進講師資料頁、可移除舊 WCA 管理頁；決定「每兩個月、不要手動按鈕」。

**可行性已查證（researcher 實打 API）**：WCA persons API 公開免驗證，`GET /api/v0/persons/{id}` 回 personal_records（single/average per event），單位＝centiseconds 與本專案 DB 一致。**引擎已實測**：何俊霖三階抓回 19.08/23.27＝與先前手動填的完全一致；Mats Valk 13 項正確。

**已建置（未 commit）**：
- `scripts/wca-sync/sync.mjs` — 抓取+解析引擎（只同步 15 標準時間項目；--dry-run 可本機測）。
- `.github/workflows/wca-sync.yml` — 每兩個月（cron `0 3 1 */2 *`）＋手動觸發。
- `培訓web/supabase/2026-07-10_wca_autosync.sql`（**未套用**）— 秘鑰保護的 `get_wca_sync_targets` / `sync_wca_results`（覆蓋制）＋ `wca_sync_config`（RLS 全鎖、自動產生隨機秘鑰）＋ `instructors.wca_synced_at`。刻意不用 service_role，改共用秘鑰（資安審過：無「無秘鑰可利用」漏洞；已修預設秘鑰 footgun＋fail-open）。
- 前端：`TeacherManager.jsx` 加「有 WCA 成績」篩選＋可編輯 wca_id（含匯入無登入講師）；移除 `WcaManager.jsx`＋`/admin/wca` 路由＋Dashboard NavCard；`ProfilePage.jsx` 文案改「系統自動抓取」。

**驗證**：build ✓、eslint 綠（改動檔）、引擎 dry-run 對真實 API 正確、無殘留 WcaManager 引用。**未驗**：SQL 未在真 DB 跑、端到端排程未實跑、前端畫面待業主登入看。

**⚠️ 業主要做的 3 步（上線後）**：(1) Supabase SQL Editor 跑 `2026-07-10_wca_autosync.sql`；(2) `SELECT secret FROM wca_sync_config;` 讀出隨機秘鑰；(3) GitHub repo → Settings → Secrets → Actions 設三個：`SUPABASE_URL`、`SUPABASE_ANON_KEY`（值在 培訓web/.env）、`WCA_SYNC_SECRET`（= 步驟 2 讀到的）。設完可在 GitHub Actions 手動 Run 一次驗證。

---

## 🏆 2026-07-10：WCA 成績改「後台代填」，關閉老師自填（✅ 已 commit＋push 上線＝473a55c＋SQL 業主已套用＋線上 bundle 已驗；端到端待業主登入操作）
**線上驗證（bundle index-DJsVYg90.js）**：✅ 含「後台代填」「由管理員在後台為你登錄」「admin_upsert_wca_results」；
✅ 舊自填空狀態「尚未新增任何項目」與舊 RPC 呼叫「upsert_my_wca_results」皆已從 bundle 消失（正是預期）。

### 🔧 追加（同日）：後台 WcaManager 改「清單式維護台」（✅ 已 commit＋push 上線＝9e73744＋線上 bundle index-BfJz7l13.js 已驗）
業主回報：舊版「搜尋一個人才看得到一個」無法維護整批。改為 master-detail：
- 進頁即列出「所有有 WCA 資料」講師（wca_id 有值 或 有成績列）；不再逐一搜尋。
- 統計列（有 WCA 資料 N／尚未登錄成績 N／篩選顯示 N）＋「只看尚未登錄成績」勾選＋清單搜尋（姓名/暱稱/WCA ID）。
- 左清單（可捲、sticky）＋右編輯區（桌機並排、手機堆疊）；每列顯示成績筆數、待登錄/已停權標記。
- 線上驗證：✅ 統計列/待登錄篩選/清單搜尋/空狀態四字串皆在；舊「輸入姓名或暱稱搜尋」下拉已消失。
- **未做（待業主決定）**：更大作法＝用 WCA ID 自動抓官方成績（自動同步取代手動代填）。可行性中等
  （WCA 無正式個人成績即時 API，通常靠官方匯出檔比對），業主點頭再研究。
**業主指示（2026-07-10）**：個人頁 WCA 區塊，講師只能填「WCA 選手編號」，不再自己新增項目與成績；
各項目成績改由 admin 在後台針對每位講師個別登錄。

**改了三處**：
1. `培訓web/src/pages/ProfilePage.jsx` — 移除「各項目成績」自填表格＋送出邏輯＋相關 state/handler/import；
   只留 WCA ID 欄位，文案改「成績由後台登錄」。停權（hide_from_leaderboard）鎖定行為保留。
2. `培訓web/src/pages/admin/WcaManager.jsx` — 在既有「搜尋講師→明細」面板加「各項目成績（後台代填）」
   編輯區：新增/修改/刪除列＋儲存（項目下拉沿用 15 個時間制項目 WCA_SELF_EVENTS；覆蓋制）。
3. `培訓web/supabase/2026-07-10_wca_admin_manage.sql`（**新檔，尚未套用**）— (a) 新增 admin 專用寫入
   函式 `admin_upsert_wca_results(instructor,results)`（含 admin 角色守衛、replace 語意）；
   (b) **撤銷** `upsert_my_wca_results` 對 authenticated 的執行權（安全關鍵：光移前端不夠，
   登入者仍可直接呼叫該 RPC 塞成績，必須從後端斷）。

**驗證**：`npm run build` ✓（4.18s）、`eslint` 兩檔皆綠（ProfilePage 只剩既有的函式 hoisting 舊警告，
非本次新增）。**未驗**：頁面視覺/端到端（OAuth-only + 真實 Supabase 資料，自動化登入不到，需業主登入看）。

**⚠️ 上線順序（重要）**：SQL 要先在 Supabase SQL Editor 跑，再部署前端。若前端先上，後台「儲存成績」
會因函式不存在而失敗。SQL 由業主（或授權後）套用——碰線上資料庫，未自行執行。
**⚠️ commit 注意**：ProfilePage.jsx 歷史上有並行線改動，commit 前 `git status`/`git diff` 只挑本次 WCA 改動。

---

## 🎨 2026-07-09：表單下載中心講師列排版優化＋「還缺什麼資料」（✅ 已上線 commit f4d5b95；線上 bundle index-BSy0C_BU.js 已驗含本次字串；真實資料渲染待業主登入看）

**業主指示**：講師清單排版有點亂想優化；完成率希望能「就地看到還缺什麼資料」。

**只動一支檔 `src/pages/admin/DownloadCenter.jsx`**：
1. **每列排版重整**：右側統一成「百分比＋細進度條」（<40 紅／40–79 黃／≥80 藍）或藍底「齊全」徽章，與下方「下載」鈕垂直對齊等寬；姓名/暱稱/等級同一行、email·電話一行。
2. **新增「還缺什麼資料」**：未齊全者在 email 下方列出「還缺 N 項」＋紅底缺項標籤（如 戶籍地址、身分證正面…），超過 6 項顯示「＋還有 N 項」可展開/收合（新增 `expandedIds` state）。標題列加「· 資料齊全 N 位」統計。
3. **修正完整度定義（與 ProfilePage 對齊）**：原本把 `instructor_role`（講師等級）算進完成率，但等級由系統／管理員指派、講師本人填不了 → 會永遠壓低完成率且列出他填不了的欄位；已移除。並補上 ProfilePage 有要求但這裡漏掉的 `household_address`（戶籍地址）。**⚠️ 副作用**：多數講師顯示的完成率%會與舊版略不同（通常微升，因少了一格填不了的欄位）。

**✅ 證據**：`npm run build` 綠燈（4.6s）；`eslint DownloadCenter.jsx` 0 error（1 warning＝既有 useEffect/loadData 基線）；還原真實 class 的 HTML mock 經 Playwright 桌機 1280＋手機 375 截圖，agent 判讀六項驗收全過、無破版無水平溢出（`scratchpad/dc-desktop.png`、`dc-mobile375.png`）。

**✅ 已上線**：2026-07-10 push main → Zeabur 換版，正式站 bundle `index-BSy0C_BU.js` 固定字串檢查命中「接課頻率(學期)/(寒暑假)、還缺、資料齊全」。
**⚠️ 待業主**：admin 頁 Google OAuth 自動化登不進，真實資料渲染需業主登入 https://dream-one-teacher.zeabur.app/admin/download 看一眼（確認缺項標籤對得上真人資料、%數字合理）。

---

## 📄 2026-07-09 深夜：表單下載中心「獨立表單模板管理」（✅ 已改完＋build/lint 綠燈；⏳ 未 commit/push，端到端待業主登入測）

**業主回報**：想在「表單下載中心」自己設定要下載的文件，但目前新增文件的入口只在「合約管理」，
且分類預設是 contract → 新增的文件都跑去合約，表單中心獨立不了。

**根因**：合約與表單共用同一張表 `contract_documents`，靠 `doc_category`（contract/form）區分；
「新增文件」只存在 ContractAdmin，預設 `doc_category='contract'`，忘了改下拉就落到合約。表單下載
中心舊「管理模板」按鈕其實是連去合約頁。

**做了什麼（只動 `src/pages/admin/DownloadCenter.jsx`，一支檔）**：頁內內建獨立「表單模板管理」面板——
新增表單／上傳 PDF／定位欄位／刪除都在表單中心完成，**新增的文件一律 `doc_category='form'` 固定**
（無下拉、不會漏到合約）、`doc_mode='fill_sign'`（可定位欄位）。表單是後台下載用，**上傳不發講師通知**
（與合約版上傳的差異）。撤掉連去合約頁的「管理模板」連結，改成頁內展開／收合。共用既有
`FieldPositionEditor` 與 `formGenerator`。

**✅ 證據**：`npm run build` 綠燈（11.46s）；`eslint DownloadCenter.jsx` 0 errors（1 warning 為既有
useEffect/loadData，非新增）。

**⚠️ 未驗 / 待業主**：admin 頁在 Google OAuth 後自動化無法登入實測——需業主登入走一次：管理表單模板
→新增表單→上傳 PDF→定位欄位→回下載中心確認該表單出現、批次下載產檔正確。（`contract_documents`
的 admin INSERT/DELETE RLS 沿用 ContractAdmin 既有可用路徑，同權限。）

---

## 🐛 2026-07-09 深夜：認領審核清單「徽章有數字、清單空白」修復（✅ 已改完＋build/lint/線上探測驗證；未 commit、未部署）

**業主回報**：/admin/claims 分頁「待審核 1」但清單顯示「目前沒有待審核的申請」。
**根因（線上 PostgREST 探測實證）**：`ClaimRequests.jsx` 清單查詢用嵌入語法
`requester:requester_user_id(id,name,email,role)` 取申請人資料，但該 FK 指向 `auth.users`
（非 public.users），PostgREST 找不到 public schema 內的關聯 → 整條查詢回 **400 PGRST200**
→ `setClaims([])` → 清單全空；計數查詢（無嵌入）正常 → 徽章照顯示。
**＝這個審核清單其實從來沒成功渲染過任何一筆 claim**，先前多為自動核准、少有 pending 停留才沒被發現。
**修法（純前端，不動 SQL）**：清單查詢改抓純欄位 `requester_user_id`，另查 `public.users`
（admin 依 RLS 可讀全表）補回 name/role/email 併回每筆；instructor 嵌入正常保留。
**✅ 證據**：線上 anon 探測——舊寫法回 400、新寫法回 200；`npm run build` 綠燈；
本檔 lint 1 問題＝既有基線（useEffect 呼叫 load，非本次改動）零新增。
**⚠️ 下一步**：真渲染需 admin 部署後開頁確認（RLS 擋 anon 讀該表，自動化測不到）。尚未 commit／部署——等業主點頭。

---

## 🚧 2026-07-09 深夜：薪資登記頁整頁反灰「尚未啟用，敬請期待」（✅ 業主拍板已 push 上線）

**業主指示**：薪資登記的地方整頁反灰，加遮罩＋白字「尚未啟用，敬請期待」。
**做了什麼**：只動 `src/pages/admin/SalaryRegister.jsx`（`/admin/salary`）——內容層加
`grayscale + opacity-60 + pointer-events-none`（反灰且點不到任何按鈕），上面蓋半透明黑遮罩
＋白色粗體置中文字；頁面鎖高不捲動。**要重新啟用時照檔內註解還原三個 class 即可**（一分鐘的事）。
**✅ 證據**：確定性腳本 12/12 PASS（遮罩文字可見且純白、頁面中心點擊命中遮罩非按鈕、
「新增薪資紀錄」按鈕 pointer-events=none、375px 手機無破版）；截圖
`培訓web/scripts/shots/salary-mask-desktop.png`／`salary-mask-mobile375.png`，agent 判讀
兩張 4 項全過（導覽列不被蓋、內容反灰、文字置中可讀、無破版）；build 綠燈、lint 零新增。
**⚠️ 殘留範圍**：老師端「我的薪資」`/my/salary` 與後台 Dashboard 的「薪資登記中心」入口卡
**都還沒遮**（業主尚未回覆要不要一併處理）。

---

## 🎚️ 2026-07-09 深夜：後台切講師等級「立刻彈回」修復（✅ 已修＋回歸測試；業主回報的 bug）

**業主症狀**：/admin/teachers 講師名單管理切等級切不動（無錯誤訊息）。
**根因（非 trigger、非權限）**：5d417fe 數字消歧義改版把 instructorMap 改成雙 key
（`inst.id`＋`user:<user_id>`）、畫面讀 `user:` 前綴 key，但兩處等級切換的 optimistic
更新仍寫回**無前綴的舊 key**（TeacherManager.jsx 原 :549/:694）→ 寫進去的值畫面讀不到，
下拉當場彈回舊值。**DB 的 PATCH 其實有送出**＝業主先前切的等級很可能已存進資料庫，只是畫面騙人。
**修法**：optimistic 更新寫回 `user:` 前綴＋`id` 兩把 key（含 id，去重邏輯不受影響）。
**證據（主對話親跑）**：新回歸腳本 `scripts/verify-level-switch.mjs`（假 admin＋mock）
修復版 **2/2 PASS**（PATCH body 含新等級＋下拉維持不彈回）；**換回舊版程式同測試 A2 失敗
（B→彈回 B）＝症狀復現、測試有效**；build 綠燈、eslint 0。
**⚠️ 未驗**：guard_instructor_role trigger 對真 admin 的放行（mock 攔下 PATCH 測不到 DB 層）
——業主部署後在頁面實切一次＋重新整理，若仍彈回才需查 trigger（診斷 SQL 已給過）。
**📌 順帶觀察（另一問題，未處理）**：業主截圖中刪除鈕 `delete_user_completely` 回 409
Conflict——疑 FK 擋刪除，待另行診斷。
**同場澄清**：「填完資料才能看其他頁」關卡（ProfileCompleteGate）健在——線上 bundle 字串
＋本機 3 情境重演（`scripts/verify-complete-gate.mjs` 3/3）皆證實；業主測不到是因為
admin/mentor 依設計免檢查。

---

## 🪪 2026-07-09 晚：認領自動核准（手機＋身分證末四碼）＋等級自動帶入（✅ 已 commit＋push；SQL 已套用）

**業主需求三連**：① 名冊上的老師認領後不必人工審核；② 登入後「已是夢想一號老師」用
姓名＋電話＋身分證末四碼比對，避免用別的信箱登入變孤兒帳號；③ 等級不讓老師自選，
認領者沿用名冊原等級、全新老師預設「實習」。

**做了什麼**：
- **SQL①** `2026-07-09_claim_auto_approve.sql`：`submit_claim_request` 改成「手機末四碼與名冊
  相符即當場綁定＋核准」；新增 `auto_attempts` 猜錯計數（5 次鎖死轉人工）；
  **B2＝堵漏**：原 `search_unlinked_instructors` 把手機後四碼當 `••••1234` 公開（等於把密碼
  展示）＋可用後四碼過濾＝對答機 → 改成只回「已登記手機」中性提示、停用後四碼過濾（向後
  相容，保留兩參數簽章，線上舊前端不壞）。
- **SQL②** `2026-07-09_claim_id_and_role.sql`：`submit_claim_request` 加第 4 參數
  `id_last4_input`，改成「名冊有登記的每項祕密（手機／身分證末四碼）都要對、至少對一項」才
  自動核准；新增 `guard_instructor_role` trigger 強制「非 admin 不能自訂/竄改自己 instructor_role」
  （INSERT 一律實習、UPDATE 保持原值；service role 匯入與 admin 放行）＝連繞過畫面直打 API 也擋。
- **前端** `ProfilePage.jsx`：認領 modal 加身分證末四碼欄、文案改「立即啟用（不需審核）」、
  移除搜尋的末四碼輸入；等級欄改唯讀（新人顯示「實習」）；`instructor_role` 移出必填。

**✅ 證據**：兩輪 security-auditor 複審——第一份揪出「後四碼＝公開密碼」阻斷洞（已修 B2）、
第二份 10 項全過無阻斷（trigger 不誤傷匯入/後台、REST 繞過改等級被擋均成立）；`npm run build`
綠燈、ProfilePage lint 4＝基線零新增；anon 探測確認正式庫有 `household_address` 欄（並行線戶籍
功能不會壞存檔）。SQL 兩份業主 2026-07-09 已貼入正式庫。

**🔗 與既有「填完才能瀏覽」關卡的關係（2026-07-09 補課）**：本以為要新做「資料填完才放行」
關卡，查核後發現 **`components/ProfileCompleteGate.jsx` 早就在做**（HEAD commit 095911f、
掛在 Layout，全站硬擋未填完者導回 /profile、admin/mentor 免）——**認領自動核准的老師一樣被它擋**，
不需另做。已撤回一版重複實作。**唯一順手修**：把 `instructor_role` 移出該關卡的必填清單
（等級改系統指派後老師填不了它，名冊等級為空的列被認領後會永遠卡關）＝commit 見下。

**⚠️ 未驗 / 待辦**：
- 真帳號 OAuth 認領端到端（自動化擋 OAuth，需業主人測：搜名字→填手機＋身分證末四碼→立即啟用）。
- 建議業主在 SQL Editor 跑一次體檢查詢確認 `search_masked_ok=true`（第一份搜尋遮罩是否生效）；
  不確定就把 SQL① 再貼一次（冪等、可安全重跑）。
- 低風險備註（非阻斷）：`find_unlinked_instructor_by_my_email` 仍回本人自己那筆的手機末四碼
  （只對本人、不可被利用），末四碼升格密碼後日後值得順手也遮；auto_attempts 綁帳號，
  多開 Google 帳號可重置計數（只對「只有手機、無身分證」的舊列有意義）。

---

## 📝 2026-07-09 晚：個人資料頁「換頁資料不見」修復＋新增戶籍地址（✅ 已改完＋實測；隨認領線同批 commit＋push 上線，業主授權「兩條一起上」）

**業主回報**：個人頁（含匯款銀行資訊）填一填，切下一頁資料就整個不見，湊不齊一次完整送出。
**診斷（主對話 anon 探測＋讀碼）**：不是資料庫問題——存檔會寫入的 40 欄全部在線上、
`instructor_role`/`tw_county` enum 線上都接受表單送的值（連職員/工讀生也接受，只是 repo SQL 過期）、
`user_id` 有 UNIQUE、自我 upsert 的 RLS 也在。真因＝`ProfilePage.jsx` **完全沒有草稿機制**，
表單只活在 React state，一換頁/重整就蒸發。

**做了什麼（只動 `src/pages/ProfilePage.jsx`＋1 支新 SQL）**：
1. **草稿自動暫存**：hydrated 後表單一變動即寫 `localStorage['profile_draft_<uid>']`（只存文字欄位，
   排除檔案路徑）；載入時把草稿蓋回 DB 版之上；**成功送出後清除草稿**＋更新 savedSnapshot。
   → 站內換頁/重整資料自動還原。另加 `beforeunload` 在關分頁/強制重整時跳原生未儲存警告。
   （站內「確定離開」自訂彈窗需 data router，本 App 是 `<BrowserRouter>` 不支援 `useBlocker`，
   但草稿已讓站內換頁不掉資料，故不做 router 遷移。）
2. **戶籍地址（業主指定必填）**：通訊地址旁新增欄位＋「同通訊地址」一鍵帶入鈕；
   加進 `REQUIRED_FIELDS`、`INITIAL_FORM`。新 SQL `2026-07-09_household_address.sql`
   （`ADD COLUMN IF NOT EXISTS household_address text`，冪等、不動 RLS）。

**✅ 證據（主對話親跑）**：`node scripts/verify-profile-draft.mjs` **9/9 PASS**（假 session＋mock
Supabase 真瀏覽器：填三欄→重整/profile→全還原、同通訊地址帶入、戶籍欄存在、既有講師載 DB 值
不被草稿干擾、草稿確實寫入 localStorage）；`npm run build` 綠燈；ProfilePage lint 4＝改動前 4（零新增）。

**⚠️ 上線順序鐵律（否則會製造出跟原本一樣的「存不了」）**：`household_address` 設為必填、
存檔 payload 一定會送這欄——**必須先讓業主把 `2026-07-09_household_address.sql` 貼上線上執行，
確認欄位建好，才能部署前端**；反過來會讓「column does not exist」害全體存檔失敗。
**待業主**：(1) 跑該 SQL；(2) 同意後才 push 部署；(3) 真帳號實走一次（OAuth 擋自動化）。
**副作用（業主已選必填）**：既有 245 位講師下次編輯任何資料時，也會被要求補填戶籍地址才存得了。

---

## 🧪 2026-07-09 晚：簽約暫免 Email 驗證（測試期開關，業主指示開放老師測流程）

**做了什麼**（只動 `src/pages/ContractSigningFlow.jsx`）：檔頂 `OTP_BYPASS_FOR_TESTING = true`
開關——開著時隱藏 EmailOtpGate、顯示黃色「測試模式」提示、簽名只需勾兩個同意框；
送出的合約 `verify_method` 誠實記 `'none'`（verified_at null），與正式驗證的 `'email_otp'`
可區分。**恢復驗證＝把開關改回 false（一個字），等 Email 模板＋Resend 設好後做。**
**證據**：mock Playwright 6/6 PASS（提示出現、OTP 元件消失、勾兩框即解鎖簽名、零錯誤，
腳本 scratchpad/verify-otp-bypass.mjs）；build 綠燈、eslint 0。
**⚠️ 提醒**：免驗證期間的簽署缺「本人驗證」證據，法律效力較弱——測試期資料建議
之後清掉或標記，正式簽約等驗證恢復。

---

## 📄 2026-07-09 晚：簽約頁兩件事（翻頁跳頂已修未 commit；OTP 寄送診斷中）

**1. 合約翻頁跳回頂部（✅ 已修，未 commit）**：根因＝react-pdf 換頁空窗期 PDF 容器高度
塌陷、瀏覽器把 scrollY 夾回上方。修法（只動 `src/components/DocumentViewer.jsx`）：
onRenderSuccess 記錄頁高、換頁用 minHeight 撐住；goToPage 後平滑捲到新頁頂端
（初始載入與 zoom modal 不受影響）。證據（主對話親跑腳本）：修前手機翻頁
scrollY 345→0（完全復現）；修後 345→345、容器 top 33px；桌機 860→370、top 16px；
0 pageerror；build 綠燈、eslint 0。腳本 scratchpad/verify-docviewer-scroll.mjs。
**⚠️ commit 時注意**：ProfilePage.jsx 有並行線（WCA 自填）未收尾改動，只挑 DocumentViewer。

**2. 簽約 OTP「不會寄驗證碼」診斷（2026-07-09 晚，主對話 anon 探測）**：
- `/auth/v1/otp` 對 info@dropout.tw 實測 **HTTP 200**＝Email provider 其實已開、寄送管道通
  （STATUS 舊待辦「開 Email provider」可能已被業主完成，或早已開）。
- 已真寄一封測試信到 info@dropout.tw，等業主查收裁決三種可能：
  (a) 沒收到＝內建 SMTP 送達問題；(b) 收到但只有連結沒 6 碼＝**Email 模板缺 {{ .Token }}**
  （Supabase 預設 Magic Link 模板只放連結，前端卻要求輸 6 碼——最可疑）；
  (c) 收到含 6 碼＝功能正常，先前可能撞每小時 2 封的內建量限。
- **✅ 裁決＝(b)**（業主 2026-07-09 晚證實：收到信但只有連結沒 6 碼）→ 修法＝Supabase
  Dashboard → Authentication → Email Templates → Magic Link 模板把 `{{ .ConfirmationURL }}`
  換成 `{{ .Token }}`（官方文件證實，本專案僅 Google 登入、magic link 無他用，安全）。
  已給業主逐步操作指南＋繁中模板範本，等他改完重測。
- 額度問題（業主證實會常用）：內建 email 官方明定 **2 封/小時、非 production 用**。
  解法＝接 Resend SMTP（host smtp.resend.com / user `resend` / password=API key / port 465），
  接上後 Supabase 預設限速升 30/hr 且可在 Rate Limits 頁再調高。Resend 免費方案
  100 封/日、3000 封/月、**限 1 個驗證網域**——九豆帳號的網域名額若已被占用，
  夢想一號要另開免費帳號驗 dreamcube.tw（SPF＋DKIM DNS 記錄）。
  來源：supabase.com/docs/guides/auth/auth-smtp、resend.com/docs/send-with-smtp（2026-07-09 查）。

---

## 🚑 2026-07-09 晚：部署失敗搶修（✅ 已修＝cc4a2a7）

**事故**：16901c7 把 ProfilePage/BadgeManager 改為 import `BadgeVisual`／`imageCompress`，
但兩個**新檔案沒 git add**（留在未追蹤清單）→ push 後 Zeabur build「Could not resolve
../components/BadgeVisual」失敗，其後所有部署（含兩個 docs commit）連環失敗。
**線上未受害**：Zeabur 部署失敗不換版，正式站一直停在最後成功版（index-BOLDJDfk.js，
含講師名單改版＋純圓角 34 檔）。
**修法**：`cc4a2a7` 只補這兩個檔（隔離 build 驗證綠燈、eslint 0 才 push）；
WcaManager.jsx＋App.jsx 路由改動屬徽章線未收尾，仍留工作區未 commit。
**教訓（給並行各線）**：commit 前 `git status` 要看**未追蹤區**——改了既有檔引用新檔時，
新檔忘了 add 就是「本地 build 過、線上炸」的經典型態。

---

## 🔵 2026-07-09 晚：全站圓角化改版（業主指示「大多數圓角矩形、少數直角點綴」）— ✅ 業主拍板「直接全部上線」，已 commit＋push（9e4ba97 純圓角 34 檔＋16901c7 混線 2 檔搭載徽章線迭代）

**做了什麼**：Bauhaus 語言保留（三原色/黑框/硬陰影），圓角從「二元直角」改為刻度制——
大卡 `rounded-2xl`／按鈕輸入 tab `rounded-xl`／chip `rounded-lg`；直角只留幾何裝飾、色帶、
checkbox。共用配方（index.css `.bh-*`）改一次全站生效＋9 路 agent 掃 inline 直角與裸黑框
（36 檔）＋跨批次分歧統一（icon 容器一律 rounded-lg、TeacherManager 手機 tab 換行破版改
獨立框 pattern、DevLogin 小徽章降刻度）。DESIGN.md §4/§6 已同步改版。

**證據（主對話親跑/親抽查）**：build ✓ 8.32s；lint 25＝基線；mobile-audit 44 檢查＝基線
6 旗標（0 溢出/0 pageerror/0 空白頁；期間曾出現偶發 pageerror，查明是背景 dev server 與
稽核搶資源，關掉後穩定乾淨）；視覺判讀 agent 全站掃過（需修 4 類全數處理，其中 checkbox
屬原生元件忽略 border-radius 的假問題，已如實記入 DESIGN.md §6）；TeacherManager 修復後
390px 複驗通過（六鈕 44px、獨立圓角框）。順手修：/my/salary email 連結熱區 18px→44px。

**⚠️ 打包注意（混線檔）**：`ProfilePage.jsx`＋`admin/BadgeManager.jsx` 混有徽章線未提交
迭代（BadgeIcon→BadgeVisual、圖示上傳）；`admin/TeacherManager.jsx` 混有「數字消歧義」線
未提交改動（見下段）。同檔無法拆 commit——需分包如實標註，或等各線收尾。CubeTimer 的
「成績公開度/歷史紀錄」該線已自行 commit，無衝突。

---

## 👥 2026-07-09：講師名單管理頁數字消歧義（方案 A，✅ 已 commit＋push 上線＝5d417fe）

**上線紀錄**：業主 2026-07-09 說「上」→ index 手術 commit `5d417fe`（只含本任務 12 個
hunk，同檔並行圓角線的 8 個 hunk 留在工作區未動）→ push，Zeabur 自動部署。
commit 前以 `git checkout-index` 隔離拷貝實測 staged 版本 build 綠燈＋bundle 含新字串。
✅ 線上 bundle 已驗證（業主提供網址 https://dream-one-teacher.zeabur.app，
index-BOLDJDfk.js 含「已登入講師/講師名冊/其他狀態/未填狀態」四字串各 1 處；
網址與驗部署慣例已補進 CLAUDE.md 部署節）。
同日：`2026-07-09_lesson_tags.sql` 業主已貼線上，anon 探測 lessons.tags 欄位存在 ✓
（hashtag 線＝commit 9e48b4f 的後端半邊補齊）。

**背景**：業主看 /admin/teachers 困惑——統計卡「講師 2」vs 分頁「講師 (245)」打架；
且冷凍/工讀生/職員/助教/未填狀態的未登入講師在該頁任何分頁都看不到（另頁講師名冊看得到）。
**改動（只動 `src/pages/admin/TeacherManager.jsx`）**：統計卡「講師」→「已登入講師」；
分頁「講師」→「講師名冊」；新增「其他狀態」分頁（未綁定且非 active/cancelled，含 NULL，
身份欄顯示中文狀態：冷凍/工讀生/職員/助教/未填狀態）；順修去重潛伏 bug
（instructorMap 雙 key 讓已綁定講師被 Object.values 算兩次）。
**證據（主對話親跑）**：build 綠燈、lint 25＝基線且本檔單跑 0 問題、確定性 Playwright
**18/18 PASS**（假 session＋10 筆設計 mock：各分頁計數、其他狀態五標籤、去重斷言
「已綁定 cancelled 只算一次」、375 無溢出零 pageerror；腳本
scratchpad/verify-teacher-manager.mjs，截圖 tm-shots/ 5 張，agent 判讀「可交付」）。
**⚠️ commit 注意**：工作區同時有另一並行線的全站圓角改版（36 檔含本檔）——
commit 時要用 git index 手術只挑本任務的 hunk，或等圓角線收尾一起核對。
**未結案（同題延伸）**：線上 active 243 vs 新整理資料 163 的落差待業主跑
`SELECT employment_status, count(*) FROM public.instructors GROUP BY 1;` 裁決——
若線上幾乎全 active，代表 7/8 六類狀態整理＋資料補全尚未推上線上（匯入工具在 scripts/）。

---

## 🖊️ 2026-07-09：畫布編輯器改版—工具列移到底部＋任意 px 字級（✅ 已 commit＋push 上線＝51fadb3）

**做了什麼**（只動 `src/components/CanvasEditor.jsx`）：
- 文字格式工具列與元素控制列從「頂部 sticky」改為**固定在畫面底部**（border 翻上緣、
  調色盤改向上彈出 `dropUp`）。
- 字級從 7 檔固定尺寸改為**任意 8–200px**：A−/A＋ 步進 ±2px、px 直接輸入（Enter 套用）、
  常用尺寸下拉（12–96px）；游標移動即時顯示目前字級。
  實作手法：execCommand fontSize 7 → 換成 `<span style="font-size:Npx">`（既有 size=7 內容
  先標記保護不誤換）。

**證據**：偽 session＋全量攔截 Supabase 的 Playwright 實測 **7/7 PASS**（工具列貼底 y=900、
33px 套用、A＋ 33→35、調色盤向上開）＋ 2 張截圖 agent 判讀通過；build 綠燈、lint 25＝基線。
測試腳本手法沿用 scripts/mobile-verify（零線上寫入）。

**✅ 已上線（業主口頭核准「直接上線」）**：commit `51fadb3` 單檔提交（核對過 9 個 hunk
無夾帶）→ push → Zeabur 自動部署，40 秒後正式站換新 bundle（index-D5als5R8.js），
已 grep 確認新編輯器程式碼在線上 bundle 內。

**追加（同日）：課程章節列表頁修復（`src/pages/LessonView.jsx`，未 commit）**——
業主反映列表卡片顯示 `{"caption": ""}`（圖片區塊內部 JSON 外洩當預覽）與「58 文章」
（畫布區塊誤當文章數）。修法：預覽只取第一段 ≥20 字的真內文（跳過圖片 JSON／圖形／
按鈕／短標題）；畫布課程徽章改「閱讀約 N 分鐘」（總字數/400 估算），傳統課程維持 N 文章。
證據：mock Playwright 6/6 PASS（無 JSON 外洩、9 課列出、預覽正常、時間徽章出現）＋
build 綠燈。lint 33（+8 全來自並行徽章/通知線的未收尾檔案，LessonView/CanvasEditor 零問題）。
**✅ 已上線**：commit `b10f983` 單檔 push，40 秒換新 bundle（index-BN8plal-.js），
已 grep 確認「閱讀約」字串在線上程式包內。

**再追加（同日）：章節 hashtag 功能（✅ 已 commit＋push 上線＝9e48b4f，40 秒換版
index-CercocM5.js，已 grep 實證；SQL `2026-07-09_lesson_tags.sql` 待業主貼）**——業主不要閱讀分鐘，改要自由 hashtag。
① 新 SQL `2026-07-09_lesson_tags.sql`：lessons 加 `tags text[]`（冪等、不碰 RLS，**待業主貼**）；
② 後台 `/admin/cms/:courseId` 每課新增 hashtag 編輯列（chips＋輸入 Enter 加入、× 移除，
   即存 DB；欄位未建時儲存會提示先跑 SQL）——`CMSManager.jsx`；
③ 前台章節卡片顯示 `#標籤`（黃chip），移除「閱讀約 N 分鐘」，傳統課程維持 N 文章——
   `LessonView.jsx`（SQL 未跑前讀不到 tags 就不顯示，不會壞）。
證據：mock Playwright 8/8 PASS（前台三標籤顯示、分鐘已除、後台新增/刪除的 PATCH 內容
逐一驗證 `{"tags":[...]}`）；build 綠燈；兩檔 lint 零問題。

---

## 🔔 2026-07-09：廣播通知中心（admin 隨時發＋排程發小鈴鐺通知）— ✅ SQL 已套用＋已上線

**做了什麼**：新 admin 頁 `/admin/notifications`（Dashboard 系統管理區有入口卡）——
① 立即發送：標題/內文/連結/對象（全體講師 teacher+mentor／全站非 pending），confirm 後
呼叫 `admin_broadcast_notification` RPC（含 admin 守衛）；② 排程發送：指定時間＋可選
每天/每週/每月重複，存 `scheduled_notifications` 表（RLS 只限 admin），pg_cron 每分鐘輪詢
`process_scheduled_notifications()` 到期發送；排程清單可取消。通知 type 沿用
'announcement'，小鈴鐺前端零改動。

**改動檔案**：新 `培訓web/supabase/2026-07-09_notification_center.sql`（表＋RLS＋3 函式＋
cron，全含守衛，冪等）、新 `src/pages/admin/NotificationManager.jsx`、`App.jsx`（route）、
`admin/Dashboard.jsx`（NavCard）——後兩檔為純增量（diff 已核）。

**證據（主對話親跑/親查）**：eslint 三檔 0 問題、`npm run build` ✓ built in 5.66s、
Playwright 假 session 實開頁 10/10 過（1280/375 無白屏無溢出、按鈕 48px、降級提示與
空狀態正常、border-radius 0），截圖 scratchpad/notif-shots/ 兩張親手 ls 核實。

**進度**：SQL ✅ 使用者 2026-07-09 已貼入正式 Supabase 執行、回報無錯誤；前端 ✅ 已單獨
commit＋push（index 手術分線，只含通知中心 4 檔，不含徽章線）。**剩最後一步（人測）**：
部署完成後用 admin 帳號開 /admin/notifications 發一則通知看小鈴鐺是否出現、再排一筆
2 分鐘後的排程確認 pg_cron 自動送達（cron.job_run_details 可查執行紀錄）。

**地雷**：pg_cron 用 UTC 但 send_at 是 timestamptz 前端已轉，無時差問題；排程送達最多晚
1 分鐘；App.jsx／Dashboard.jsx 同檔還有並行線（徽章/薪資連結）未提交改動，commit 要分開或
確認並行線已收尾。SQL 未跑前頁面會顯示黃色「後端 SQL 尚未套用」提示（刻意設計，非 bug）。

---

## 💰 2026-07-09：薪資頁改三顆按鈕＋後台連結管理＋每月薪資提醒排程（✅ 已 commit＋push 上線；SQL 已套用）

**背景**：公司暫停用網站登記薪資，改用兩份 Google 表單收單（直營課程／合作單位）。
每月 25 號結算（計算區間＝上月 26 日～本月 25 日），逾期併入下月。

**做了什麼**：
- `src/pages/MySalary.jsx`：加 `SALARY_PAGE_PAUSED = true` 開關＋新元件 `SalaryFormLinks`
  ——頁面只剩**三顆** Bauhaus 大按鈕（紅=直營課程表單、藍=合作單位表單、
  黃=報酬/點數確認區→使用者指定的 Google 試算表）＋黃底備註卡
  （結算規則／匯款帳戶更新告知芳儒／報酬以 hi@dreamcube.tw 信件為準）。
  **原統計/表格程式碼一行未刪**（unreachable 保留），開關改回 false 即恢復。
  連結從 `site_links` 表讀，讀不到自動 fallback 檔內預設值（SQL 沒上線頁面照樣能用）。
- 新後台頁 `/admin/salary-links`（`admin/SalaryLinksManager.jsx`）：編輯三顆按鈕的
  標題/說明/網址（存檔用 upsert，缺列也存得進去）；表未建時顯示明確提示。
  App.jsx＋Dashboard.jsx 純加行掛路由與入口卡。
- 新 SQL `2026-07-09_site_links.sql`：site_links 表＋RLS（登入可讀、admin 可寫）＋seed 三列。
- 新 SQL `2026-07-09_salary_reminder_cron.sql`：pg_cron 每月 18、22 號台北 09:00 對全體
  teacher/mentor 發站內通知「薪資登記提醒」（連 /my/salary；同日防重複；函式有 REVOKE 守衛）。
  使用者 2026-07-09 確認「提醒還是要」。

**✅ 證據（主對話親跑）**：build 綠燈；lint 25=基線零新增；確定性腳本 **29/29 PASS**
（三顆按鈕 href/target、舊 UI 隱藏、375 無溢出、熱區 104px、備註卡三行＋mailto、
admin 頁 fallback 提示），截圖 4 張經 fresh agent 判讀（scratchpad/salary-links-shots/）。
並行徽章線檔案以 git diff 核實零誤動（Dashboard.jsx 唯一既有行修改是徽章線自己的 Award import）。

**✅ SQL 已套用（2026-07-09 使用者親跑，主對話 anon 探測核實）**：site_links 表存在且
RLS 擋 anon（回 `[]`）；send_salary_reminder 函式存在且守衛生效（anon 呼叫回 42501
permission denied，非 PGRST202）。cron.job 兩列無法用 anon 查，屬未驗（低風險）。

**⚠️ 等使用者做**：
1. **確認報酬試算表的共用設定**＝「知道連結的使用者：檢視者」，否則講師點「報酬/點數確認區」會卡在要求存取權。
2. 部署後開 /my/salary 與 /admin/salary-links 各看一眼（OAuth 擋自動化，真帳號只能人測）。

**上線方式備註**：工作區當時有三條並行線（本線＋徽章＋通知中心）共用 App.jsx/Dashboard.jsx，
本次 commit 用 git index 手術只納入本線的行（兩檔中徽章/通知中心的 import、route、NavCard
未進 commit，避免引用未 commit 檔案炸 build）；那兩條線的工作區改動原封未動。

**💣 注意**：提醒是「站內鈴鐺通知」，講師要開網站才看得到；要 email/LINE 主動推播需另外接。
`/my/salary/new`（登記課程回報頁）路由保留但已無 UI 入口。備註卡與按鈕說明文案屬新文案初稿，待使用者過目。
Google Sheet 資料直接呈現到官網的研究已完成（方案 A 發布 CSV／方案 D 同步進 Supabase 兩條路），
使用者 2026-07-09 決定先不做，改為直接外連試算表。

---

## 🎨 2026-07-09：全站 Bauhaus 視覺大改版（✅ 業主本地過目後已 commit＋push 上線）

**上線備註**：分兩個 commit——①Bauhaus 改版本體；②Leaderboard.jsx＋wca.js（此檔同時含
並行 session 的「WCA 全能王」功能接線，無法拆檔，如實分開標註）。
**⚠️ 全能王分頁上線後會顯示錯誤/空狀態**，直到 `2026-07-09_gamify_compute.sql` 跑進正式
Supabase（anon 探測確認 RPC 尚不存在，PGRST202；程式有降級處理不會炸頁）。該 SQL 屬並行
線未收尾工作，本線未審查其權限守衛，跑之前建議照慣例過一輪。

**做了什麼**：依業主提供的 Bauhaus design system prompt，全站 25 頁改版——三原色
（紅 #D02020／藍 #1040C0／黃 #F0C020）＋黑框直角＋硬陰影＋幾何裝飾，字體 Outfit（英數）
＋ Noto Sans TC（中文）。共改 37 檔＋新增 `培訓web/DESIGN.md`（設計規範書，含 token、
`.bh-*` 共用配方、語意色對照、危險區清單——**日後改版面先讀它**）。
Token 集中在 `tailwind.config.js`＋`index.css` @layer components，頁面只引用不散寫。

**✅ 證據（全部主對話親跑或親手抽查）**：
- `npm run build` 綠燈 ✓ built in 6.47s；`npm run lint` **25 problems＝基線、零新增**。
- `node scripts/mobile-audit.mjs`：44 檢查（22 路由×375/390），**0 橫向溢出／0 pageerror／
  0 空白頁**，剩 6 旗標＝改版前既有已知非問題（mock 年份空 pill、20px 勾選框）。
- 樣板（Layout＋首頁）與全站各 1 輪 fresh agent 截圖判讀通過（桌機 1280×8 頁＋手機 22 路由），
  截圖檔存在性親手 ls 核實。判讀抓到的 2 處「透明度淡化違反鐵律」（InstructorList 篩選 chip、
  `.bh-btn` disabled 態）已修並重跑稽核回歸。
- 危險區（課程畫布 CanvasViewer、cubeEngine `.dc-*`、SignaturePad canvas、react-pdf 內部）
  逐一以 git diff 驗證**零改動**；觸控熱區 min-h-[44px] 數量逐檔前後一致。

**⚠️ 未驗**：真帳號 OAuth 登入後的實資料畫面（mock 只能驗空/假資料）；modal／hover 態
未逐一截圖；第一站畫布課程以真資料的渲染（程式碼未動，理論不受影響但沒親眼看）。

**💣 本次地雷**：
1. **並行 session 正在做徽章/WCA 全能王功能**：`src/lib/wca.js` 的改動、未追蹤的
   `src/lib/badges.js`＋`2026-07-09_badges_foundation.sql`＋`2026-07-09_gamify_compute.sql`
   ＋`2026-07-09_leaderboard_hide.sql` 都是**那條線的，不屬於本次改版**。
   commit 時務必分開，別把兩條線混進同一個 commit。
2. `scripts/mobile-audit.mjs:76` 已放行 Google Fonts 域名（否則新字體讓 44 檢查全誤報
   ERR_FAILED）。
3. 設計鐵律：禁 `rounded-lg/xl` 系、禁柔陰影、禁漸層、禁透明度淡化——新寫頁面照
   `DESIGN.md` §4/§8，別讓舊 SaaS 風格回流。

---

## 🏆 2026-07-09：排行榜擴充—課程分類 + WCA 世界賽成績（已 commit＋push＋SQL 上線＝commit 4655b4b）

**做了什麼**：排行榜從單一維度擴充成「上層分類 tab＋次選」——
① 教學時數細分：**總時數 / 大班課(合作機構) / 小班課(自家教學)**；
② 新增 **WCA 賽事榜**：117 位講師、15 個項目最佳成績，可依項目＋單次/平均排行。

**✅ 已上線（附證據）**
- **SQL 已套正式 Supabase**（業主 2026-07-09 親跑，驗證 A 無異常、可上線）：
  `2026-07-09_leaderboard_expansion.sql`（`get_teaching_leaderboard_v2(year,category)`、
  instructors 加 `wca_id/wca_name`、`wca_results` 表＋RLS 只讀、`get_wca_events()`／
  `get_wca_leaderboard(event,type)`；冪等、含權限守衛）＋ `2026-07-09_wca_results_import.sql`
  （117 位、900 筆成績，中文名對 full_name、ON CONFLICT 可重跑）。
- **前端已 push**（Zeabur 自動部署）：`src/pages/Leaderboard.jsx` 重寫（三頂層 tab）、
  新 `src/lib/wca.js`（15 項中文＋centiseconds 格式化）、`LeaderboardView.jsx` 加
  `showRankTitle` 旗標修「歷屆教學王稱號誤植到方塊/WCA 榜」bug。
  證據：build 綠燈、lint 25=25 零新增、mock Playwright 全通過（含確定性斷言：稱號僅教學榜
  第1名 count=1、cube/WCA count=0）、9 張截圖獨立 agent 判讀通過。
- **WCA 比對方法**：下載官方匯出(v2_190) 用中文名對 242 位老師 → 單一命中 110(台)、
  多候選 8、查無 122；業主逐一核對確認清單(Artifact)，剔除外國撞名(林庭安/朱柏宇)、
  王浩宇跳過、紅色 7 位指定 wca_id。scratchpad 有 wca-match-review.csv／detail.json。

**⚠️ 未驗 / 待辦**
- **線上實測未做**：Google OAuth 擋 Playwright，最終「開頁面看排行對不對」需業主人工走一次
  （部署完成後開 /leaderboard，切三分類＋WCA 項目）。
- 課程分類 camp_director/special_lecture 歸屬屬判斷題，映射寫在 expansion SQL 檔頭可一行調整。
- WCA 排除了 333fm/333mbf(非時間編碼)＋magic/mmagic/333ft(已停辦)；查無 122 位需老師自填
  WCA ID 才補得齊（本次未做自填欄位，長期可加）。

---

## 📱 2026-07-09：手機版體驗總檢＋觸控熱區全站修復（本次，已 commit＋push）

**背景**：使用者要求以「總管」身分，趁多個並行 session 執行時檢查其成果，並通盤檢視
手機版操作、直接規劃執行調整後上線。**實情**：整個 session（約 30 分鐘）其他並行
session **從未落任何檔案**（HEAD 未動、工作區無他人變更）→ 無他人成果可整合；本次
交付的是手機版總檢與修復。

**做了什麼（15 個 .jsx，桌面版行為不變）**：
- 建手機稽核長期資產 `培訓web/scripts/mobile-audit.mjs`（沿用 cube-verify 的假 session＋
  mock Supabase 手法，跨 22 路由 × 375/390 寬自動查橫向溢出／pageerror／熱區 <44px＋全頁截圖）。
- **老師端 6 處熱區**：全站 logo 連結（Layout）、課程返回連結（LessonView）、薪資返回
  連結（MySalaryNew）、榮譽榜/方塊競速分頁鈕（Leaderboard TabButton）、方塊競速模式鈕
  （CubeTimer ModeButton）、個人頁換照片圓鈕（ProfilePage 36→44px）皆補足 ≥44px。
- **MySalary 空狀態**改精緻卡片（圖示＋標題＋說明＋「登記課程回報」CTA），與 contract 頁一致。
- **admin 8 頁熱區**（TeacherManager／InstructorList／AnnouncementManager／SalaryRegister／
  CMSManager／ContractAdmin／DownloadCenter／ClaimRequests）：分頁鈕、篩選 chip、列動作
  圖示鈕、返回鈕、勾選框皆補 `min-h-[44px]`／放大熱區。

**證據（主對話親跑 + 兩輪 fresh agent 判圖）**：
- `node scripts/mobile-audit.mjs` 前後對照：熱區旗標 **44→6**，且 **0 橫向溢出／0 白屏
  crash／0 空白頁**（44 檢查）；剩 6 旗標經查全屬非問題（leaderboard 3 顆空白 YearPill＝
  mock 年份沒帶值的假象、admin-salary/admin-cms 的 20px 勾選框＝務實上限）。
- 視覺 agent 兩輪判讀截圖：第一輪確認「完成度高、無破版」；修復後第二輪（11 張重點圖）
  確認「視覺乾淨、可上線、無回歸，所有 min-h 按鈕文字垂直置中」。
- `npm run build` 綠燈 `✓ built in ~5s`；`npm run lint` **25 problems＝基線、零新增**。

**mock 假象已查證、非 bug（不需改）**：手機日期框顯示 mm/dd/yyyy＝測試 Chrome 是 en-US 語系，
真台灣用戶手機 zh-TW 會顯示本地格式；/pending 截圖＝home＝mock 用 admin 角色被 PendingApproval
守衛導離（真 pending 用戶會看到等待頁）。

**未做 / 留給後續**：admin 統計卡「全寬過高」的密度收斂（次要視覺、動 Dashboard 會與功能
session 撞檔，刻意略過）；admin-instructors 彩色 chip 加 min-h 後略偏胖（觀感偏好，非缺陷）。

---

## 🔍 2026-07-09：認領講師故障＋名單人數不一致 診斷結果

**✅ 已修復（2026-07-09，使用者親跑 SQL，線上探測確認生效）**：
`2025_instructor_claim.sql`（認領功能全套）＋ `2026-07-09_mentor_instructor_read.sql`
（mentor 可讀講師名冊）已由使用者貼入 Supabase 執行。修復後線上實測：
search_unlinked_instructors 回 `[]`（原 PGRST202 不存在）、instructor_claim_requests
表存在且 RLS 正常擋 anon（原 PGRST205 不存在）。
**尚待人測**：登入網站實搜「侯宥圻＋6712」走完認領流程（OAuth 擋自動化）。
**仍未結案**：38 個薪資姓名比對（見下方成因 2）等使用者裁決後出修正 SQL。

**線上實測（用 anon key 唯讀探測正式 Supabase，證據＝API 回應）**：
- ✅ 已在線上：`delete_user_completely`（含 admin 守衛版）、`get_teacher_stats`、
  `get_teaching_leaderboard`、`get_teaching_years`、`get_cube_leaderboard`
  ——即 security_hardening／gamification／teaching_leaderboard／cube_speed 四份 SQL
  **其實都已套用**（下方舊段落「尚未套用」的警告已過時，僅 esign 欄位未驗）。
- ❌ 不在線上：`2025_instructor_claim.sql` 的 8 個函式＋`instructor_claim_requests` 表
  **全部不存在**＝這份 SQL 從未跑過 → 「認領講師資料」搜尋報
  `Could not find the function public.search_unlinked_instructors`。
  該檔已審（冪等、與現行 schema 相容、8 函式皆有守衛），**整份貼進 SQL Editor 執行即修**。
- 順帶：線上沒有 `teachers` 表（前端也沒人查它，無影響）。

**名單人數不一致的三個成因（離線重演 9,551 筆薪資 CSV 得出，腳本在
scratchpad/replay_leaderboard.py，可重跑）**：
1. 榮譽榜漏斗：主檔 251 位 → CSV 有課且姓名比對到 192 → 上榜 189
   （59 位主檔講師在薪資表完全沒課；3 位只剩科教館/科博館課被過濾）。
2. **38 個薪資表姓名比對不到主檔**（約 91 堂課的 instructor_id 是 NULL、榜上看不到），
   其中 9 組高度疑似同人異字：吳宜蓁↔吳珮蓁、林芸芷↔林沄芷、王士恆↔王士恒、
   賴柏沅↔賴柏廷、陳宥均↔陳宥瑄、陳弈心↔陳奕心、陳彥碩↔陳奕碩、黃于倫↔黃于瑄、
   侯佑祈↔侯宥圻(?)；最大宗是李思誼 38 堂（主檔查無此人）。名單要人工裁決後修資料。
3. TeacherManager（/admin/teachers）預設停在「待審核」分頁，要切分頁才看得到全部。

**潛在缺口（待使用者拍板）**：`instructors` 表 RLS 只允許 admin 讀全表
（instructors_setup.sql:140-158 無 mentor 政策），但 /admin/instructors 頁面 mentor
也進得去 → mentor 帳號開這頁會近乎空白。若有 mentor 帳號在用，需補一條 SELECT 政策。

---

## 🚀 2026-07-08：手機優化＋方塊競速已 commit＋push 上線（commit 7c28766、2d1b226）

已推上 GitHub main，Zeabur 應自動部署。**這批帶了 6 處白屏 crash 修復，是上線的主要理由。**
截圖／驗證殘渣已補進 .gitignore（`培訓web/scripts/shots/`、`*.png`）不再進版控。
**上線後仍待使用者手動處理（沿用前一批的兩件，非本次新增）**：
1. Supabase 開 Email provider（否則合約簽署 OTP 寄不出）。
2. 跑 `培訓web/supabase/2026-07-08_teaching_leaderboard.sql`（否則榮譽榜載入失敗）。
方塊競速的 `2026-07-08_cube_speed.sql` v2 已於稍早由使用者套用線上，無新增 SQL。

---

## ✅ 2026-07-08 晚：全站手機版優化（27 檔，已 commit＋push＝上方 7c28766）

**做了什麼**（全部桌面版行為不變，手機用 md: 斷點分流）：
- 全域基本盤：viewport-fit=cover；html/body 禁橫向滾動；互動元件 touch-action 消 300ms 延遲；
  <768px 小字輸入框自動升 16px（防 iOS 聚焦強制放大）；100vh 全域映射成 100dvh（防網址列伸縮跳版）。
- 觸控可用性：漢堡/鈴鐺/選單項/tab/審核鈕等熱區補到 ≥44px；hover 才出現的刪除鈕改手機常駐
  （ProfilePage 證件刪除、EditorComponent 圖片刪除、HomePage 團隊照說明）。
- 版面修復：通知面板 375px 溢出修正（Layout.jsx）；PendingApproval 按鈕列 flex-wrap（原本會裁切）；
  InstructorList「新增講師」與 ClaimRequests「拒絕」modal 補 max-h+捲動（原本矮螢幕送出鈕被吃掉）；
  SignaturePad 簽名 modal 高度防護＋手機縮小 canvas；MySalary 表格加手機卡片版；
  無響應式前綴的多欄 grid 補 sm: 斷點；公告內文圖片/表格防溢出。
- 畫布課程（LessonDetail）：手機新增「放大檢視⇄適合寬度」切換（縮到 <0.6 倍才出現，桌面零改變）。
- OTP/表單輸入：inputMode/autoComplete/pattern 補齊（數字鍵盤、驗證碼自動填入）。
- CanvasEditor/FieldPositionEditor：手機顯示「桌面工具」提示條（不擋操作；觸控拖曳明確不做，工程過大）。
- **順手修掉 6 處會白屏的舊 crash**（已在 main 上）：MySalary BigStat、ProfilePage Section＋文件上傳、
  admin Dashboard NavCard、ContractAdmin StatCard、CanvasEditor 圖形選單、ContractView InfoRow——
  全是「元件沒接 icon prop 卻 render `<Icon />`」的未定義變數錯誤（= 地雷 6 的真相，該地雷可銷）。

**證據**：
- build 綠燈 `✓ built in 6.19s`；lint 25 問題與 HEAD 基線完全一致（worktree 快照對照，零新增）。
- 主對話親跑 `node scripts/mobile-verify/verify.mjs`：**69/69 PASS**（11 頁 × 375/390 寬 ×
  無橫向溢出/無白屏/無 pageerror ＋ 漢堡/選單/鈴鐺互動量測）。
- 24 張截圖由 fresh agent 逐張判讀全數合格（scratchpad/mobile-shots/，admin 導覽卡 icon 修復
  在截圖上肉眼確認）。
- 新增長期資產：`scripts/mobile-verify/`（手機回歸驗證腳本，偽造 session＋mock Supabase，
  不碰線上資料，跑法見該目錄 README）。

**已知限制**：mock 全空資料，寫入類互動（簽名實劃、檔案上傳、表單送出）未實測；
真帳號的端到端手機實測建議在 Email provider 開通後做一次。

---

## ✅ 2026-07-08 深夜：方塊競速（老師間競速計時＋排名，已 commit＋push＝上方 7c28766）

**做了什麼**：新頁 `/cube`「方塊競速」——自製 CSS 3D 魔術方塊（`src/lib/cubeEngine.js`，
純六色、零套件）、比賽式流程（15 步打亂顯示轉法譜 → 按住空白鍵 0.3 秒放開起錶 →
鍵盤 U/D/L/R/F/B（Shift 反轉）或按鈕轉面 → 解開自動停錶）、成績送出 `cube_solves` 表、
頁內 Top10＋我的最佳/最近 5 次；導覽列桌機/手機各加入口（Timer icon）；排行榜頁加
「教學排行｜方塊競速」分頁（LeaderboardView 改成 metric 可注入，預設行為不變）。

**證據**（主對話親跑/親讀）：
- 引擎數學 Node 測試 `node 培訓web/scripts/cube-engine.test.mjs`：7/7 PASS
  （含 100 輪隨機打亂→反走→還原）。
- 真瀏覽器 Playwright（dev server＋`scripts/cube-harness.html`）：6/6 PASS
  （27 cubie／54 貼紙／打亂非還原態／反走復原／零 JS error）；截圖 2 張由 fresh agent
  判讀合格（純六色、無圖示、立體正常）。
- `npm run build` 綠燈 ✓ built in 6.30s；eslint 新檔 0 新增錯誤。
- SQL 檔主對話逐行親讀：RLS 三件（insert/select 只限本人）、SECURITY DEFINER 函式含
  auth 守衛＋REVOKE/GRANT，符合本專案權限慣例。

**等使用者**：
1. ~~跑 `2026-07-08_cube_speed.sql`~~ ✅ 使用者已於 2026-07-08 貼入 Supabase 執行成功（v2 版）。
2. 上線後用真帳號實測一輪：打亂→計時→解開→送出→排行榜出現（OAuth 擋自動化，只能人測）。

**已知限制**（檔頭註解也有寫）：計時在前端，技術上可偽造成績——內部娛樂功能，可接受；
CHECK 約束只擋離譜值（<3 秒、<10 步）。

**2026-07-08 深夜 v2 改版（使用者試玩後追加需求）**：
- **雙模式**：「鍵盤模式」（虛擬方塊，解開自動停錶）／「實體計時」（csTimer 式：
  給打亂譜、老師拿真方塊、手動起停錶，不打亂也能純計時）。成績表加 `mode` 欄分榜。
- **暫停／繼續**（預設 P 鍵）與**放棄**（Esc）；計時改分段累計。
- **15 個按鍵全部可自訂**（12 轉面＋起停／暫停／放棄，localStorage 記憶，含衝突檢查
  與恢復預設）；Ao5／Ao12 統計（csTimer 算法：去頭尾取平均）。
- SQL 檔同步改版（v1→v2 冪等補救：move_count 改 nullable、加 mode 欄、
  函式改 `get_cube_leaderboard(p_mode)`）——**已跑過 v1 的話直接重跑整份即可**。
- 證據：真頁面 E2E `培訓web/scripts/cube-verify.mjs`（長期資產）**24/24 PASS**
  （主對話親跑；含鍵盤解題自動停錶、暫停凍結、改鍵→reload 持久化、實體流程、
  雙模式分榜寫入），引擎測試 7/7、build 綠燈、eslint 0、截圖 agent 判讀可交付。

**2026-07-09 v6 改版（成績公開/私人開關＋完整歷史紀錄）——✅ 已上線（commit 05caa90）**
業主貼完 SQL 後說「上線」：主對話 anon 探測核實 is_public 欄位已在正式庫（200，
非 400 column not found）→ 只 commit 方塊線 3 檔（CubeTimer.jsx／cube-verify.mjs／
新 SQL 檔）→ 隔離 worktree 以該 commit 原樣建置綠燈 → push（9e48b4f..05caa90，
自動部署生效）。**待業主人測**：送一筆私人成績確認不上榜、歷史紀錄看得到它。
- 送出成績可選「公開到排行榜」或「只存自己的紀錄」（偏好記 localStorage）；
  **排行榜只計公開、個人統計含私人**（統計區有註明）。防呆：線上還沒跑新 SQL 時
  自動降級為不帶 is_public 的送出並提示，不會炸。
- 「我的紀錄」新增可展開**完整歷史**：分頁 20 筆＋載入更多，每列成績/日期/步數/
  公開私人 chip，列高 ≥44px、375/390 無溢出。
- 新 SQL `2026-07-09_cube_public_flag.sql`（冪等；is_public 欄 default true＝既有成績
  視為公開；排行榜函式加過濾；先貼 SQL 或先部署皆安全）——**待使用者貼**。
- 證據（主對話親跑）：E2E **89/89**、引擎 44/44、build 綠燈、eslint 0、SQL 逐行親讀。
- 環境註記：實作期間另一並行線正將全站由直角改回圓角（DESIGN.md 同步在改），
  本次新增 UI 已跟隨現場最新樣式。

**2026-07-09 v5 改版（完整國際代號＋鍵帽重設計）——✅ 已上線（commit e993dcb）**
業主同日說「ok 上線」：只 commit 方塊線 4 檔（CubeTimer.jsx／cubeEngine.js／兩支測試
腳本），薪資線／徽章線的未 commit 檔案完全未動；push 前在隔離 worktree 以該 commit
原樣建置綠燈才推（91080de..e993dcb，Zeabur 自動部署）。**待業主人測**：部署完成後
開 /cube 玩一輪（OAuth 擋自動化）。SQL 無新增需求（cube_speed v2 早已在線上）。
- 補齊 3x3 完整代號：新增 **E、S、z、六個寬層 Rw/Lw/Uw/Dw/Fw/Bw**（共 18 種轉法）。
  先派研究員查 WCA 官方規則＋3 個社群來源交叉確認（M/E/S 為社群標準：M→L、E→D、S→F；
  x/y/z 為 WCA 官方 12a4a）。方向由**九條等價式測試**鎖死（x≡R M' L'、Rw≡R M' 等），
  引擎測試 32→**44 全綠**。parseNotation 大小寫有語義（小寫 r＝寬層 Rw）。
- 螢幕按鈕重設計：**鍵帽風格、遵循全站新 Bauhaus 設計系統**（黑框直角硬陰影，agent
  正確以 DESIGN.md 否決了我開的通用樣式）；四組分區（轉面/中層藍/翻面黃/寬層收合進階）；
  E/S/寬層計步、z 不計；keymap 升 v3（+18 動作，寬層預設未綁定）、排序改 6 面字母 v2、
  排譜鍵盤同步分組。評審回饋「寬層虛線框」與上輪同型問題，主對話已改實線＋去透明度。
- 證據（主對話親跑）：引擎 44/44、E2E **76/76**（36 顆鍵帽逐顆 ≥44px、375/390 無溢出、
  Rw 計步 z 不計步、builder 排 Rw' 可套用）、build 綠燈、eslint 0；截圖評審「可交付、
  較舊版明顯升級」。

**2026-07-08 深夜 v4 改版（UX 重構，使用者授權主導）**：
- 一張主遊戲卡整合「打亂列→3D 舞台（狀態 pill）→計時器 hero」；**單一主行動按鈕
  隨狀態變**（打亂→按住準備→暫停/停錶→送出/再來一場），永遠提示下一步。
- **自訂打亂改按鈕排譜**（9 字母鍵＋'/2/⌫/清空，移除文字輸入框）。
- 螢幕按鈕區可收合（觸控裝置預設展開、桌機預設收合）；排行榜＋個人紀錄桌機併排，
  stat tiles（最佳/Ao5/Ao12/次數）。
- 手機達標（mobile-ux 準則）：全按鈕熱區 ≥44px（boundingBox 實測）、375/390 無橫向
  溢出、:active 回饋、無 modal 無 hover-only。
- 主對話依 UX 評審回饋追修 3 處：**螢幕轉面鍵在自由玩狀態被誤鎖**（disabled 條件與
  鍵盤閘門統一，手機自由玩本來根本按不了）、翻面列虛線誤讀為停用（改實線＋說明字）、
  手機分頁文字換行（sm 以下縮短）。
- 證據（主對話親跑）：E2E **56/56**（原 38 行為＋按鈕排譜＋主鈕四態＋手機量測）、
  引擎 32/32、build 綠燈、eslint 0；三張截圖（桌機/390/375）UX 評審判「可交付」。

**2026-07-08 深夜 v3 改版（國際代號＋進階轉向＋品牌 logo）**：
- 轉面按鈕改國際代號成對格子（R｜R'…），排列照使用者指定 R F L／U D B／M，
  另有「翻面」列 x｜x'、y｜y'；**7 個格子順序可由老師自訂**（localStorage）。
- 新增 **M 中層**與 **x/y 整顆翻面**（引擎支援 layer 0 與 'all'；x/y 不計步數）；
  按鍵設定同步新增 6 個動作（keymap 升 v2、v1 自動遷移）。
- **轉向物理校正**：建立 MOVE_TABLE 單一事實來源，9 個代號的方向用 5 條
  「行為鐵證測試」釘死（如「R 後前面右排=黃」），測試當場抓到 2 處符號錯誤。
- **打亂可手動輸入**轉法譜（含全形字元正規化：Ｒ’→R'），非法代號報錯不套用。
- **白面中心貼紙印公司 logo**（public/logo.png，4x 特寫截圖確認置中不變形）。
- 證據（主對話親跑）：引擎測試 **32/32**、真頁面 E2E **38/38**、build 綠燈、
  eslint 0；截圖 agent 判讀通過。SQL 無變動（v2 已由使用者套用）。

**2026-07-08 深夜補修 2 個 bug**（使用者實測回報方塊看不見）：
1. 方塊舞台高度歸零——引擎注入的 `.dc-stage{height:100%}` 蓋掉 Tailwind `h-72`，
   auto 高父層下塌成 0。修法：引擎不再指定容器尺寸（`cubeEngine.js`），尺寸交還呼叫端。
2. 鍵盤/按鈕在未計時狀態完全沒反應（原設計只允許計時中轉面）。改為：閒置與成績出爐後
   可自由玩；打亂動畫中→起錶前維持鎖定（防偷解，`CubeTimer.jsx` handleFaceTurn）。
   證據：借 `scripts/mobile-verify` 的假 session 手法直開 `/cube` 真頁面，互動測試
   **7/7 PASS**（鍵盤轉面／反轉復原／打亂譜顯示／打亂後鎖定／降級提示／零 pageerror，
   dev 與 build 後 preview 雙環境），全頁截圖 agent 判讀「修復成功」。

---

## 🚨 2026-07-08 已 push 到 main（commit e49ac53、febebd6）— 上線前必做兩件事

已推上 GitHub，若 Zeabur 自動部署，這批就會上線。**上線後要能正常運作，先做**：
1. **Supabase 開 Email provider（Authentication → Providers → Email）**——否則合約簽署的
   OTP 驗證碼寄不出，**老師會卡在驗證那步簽不了名**。這是最急、影響最大的一項。
2. **跑 `培訓web/supabase/2026-07-08_teaching_leaderboard.sql`**——否則「講師榮譽榜」與個人頁
   「我的教學成就」會顯示載入失敗（函式還沒建）。
（先前已跑：資安、gamification、esign 三份 SQL。）

**本次改版重點**：排行榜從「學習排名」改為「接課榮譽榜」（點數＝接課時數×10＋里程碑、
歷屆/年度切換、年度教學王稱號）；個人頁徽章從學習型改為接課里程碑；已刪 lib/badges.js。
資料源＝class_sessions（薪資系統的接課登記）。點數/里程碑公式集中在 src/lib/leaderboard.js。

---

## ✅ 本次完成（附證據）

| 項目 | 證據 |
|---|---|
| 四方體檢（建置／衛生／品質／資安） | 見下方「地雷」與「下一步」皆源自此 |
| 資安 3 漏洞修復 SQL 寫好 | `培訓web/supabase/2026-07-07_security_hardening.sql`（含攻擊重演驗證段）**⚠️ 尚未套用到正式 Supabase** |
| 程式碼去重：COURSE_LABELS/ROLE_LABELS | 新增 `src/lib/constants.js`，三檔改用 import（`diff` 確認三份原本逐字相同） |
| 修合約簽署頁吞錯 | `ContractSigningFlow.jsx` 加 `loadError` state＋錯誤畫面；失敗不再顯示空白簽約頁 |
| 修 CanvasEditor useEffect 缺依賴陣列 | `CanvasEditor.jsx:713` 補依賴陣列，不再每 render 重掛 keydown 監聽 |
| 清 lint 機械錯誤 | lint 親測 **48→26 問題**（error 40→18），build **綠燈** `✓ built in 5.42s` |
| 建立角色判斷模組（供後續採用） | 新增 `src/lib/roles.js`（isAdmin/isStaff/isMentor） |
| repo 衛生：垃圾檔移出 git 視線 | `.gitignore` 補規則，39 個截圖／debug 殘渣已忽略；`scripts/README.md` 記錄匯入工具 |
| 交接文件三件套 | `CLAUDE.md`、`STATUS.md`、`ROADMAP.md` |

> 說明：以上程式碼改動**已存檔、build/lint 已親測，但尚未 commit、尚未瀏覽器實測、
> 尚未部署**。commit 與部署留給使用者決定（碰線上環境依準則要先問）。

### ✅ 另一條線：「魔術方塊老師的第一站」課程內容重建（2026-07-07）

- **做了什麼**：舊 Google Sites 頁（培訓文章後台／魔術方塊老師第一站）內容重新搬上
  培訓課程。發現 6 月那次搬遷 (1) 畫布絕對定位導致跑版 (2) 內容被刪節約 8 成。
  本次從原始頁全文重建：**8 課、41 個直排卡片區塊**（響應式、無畫布定位）、13 張圖
  （沿用已上傳的 Storage）、27 個連結按鈕；**6 課要交作業**（歡迎自我介紹／SOP 默寫／
  八步驟教案／三明治演練／突發情境題／學習心得），執行長團隊、講師群組 2 課不用。
  兩句通關密語彩蛋（貓咪企鵝翻跟斗、馬鈴薯）已保留。
- **證據**：
  - 零遺漏驗證：原始頁 324 個 DOM 元素逐一比對「線上回讀資料」全數通過
    （驗證器在 `scripts/course-first-station/compose_v2.py`）
  - 視覺驗收：8 課 × 桌機1280/手機375 共 16 張截圖，agent 逐張判讀通過
    （以真實編譯 CSS＋LessonDetail 同構 DOM 渲染）
  - 舊資料完整備份：`scripts/course-first-station/backup-old-111-blocks.json`（可還原，
    還原步驟見同目錄 README）
- **等使用者**：8 個課次已設為發布，但**課程總開關 `is_published` 仍是 false**——
  請用 admin 帳號逐課過目，沒問題就在後台把課程發布（一鍵）。

**2026-07-08 改版（現行）**：使用者指定改回「與原始頁一模一樣」的**畫布模式復刻**。
已用 Playwright 量測原始頁 323 個元素幾何（座標/字級/顏色/按鈕底色/清單編號），
等比縮放重建為 **353 個畫布區塊**（含課首深灰標題帶、頂部照片橫幅、16 個虛線佔位框），
已寫入線上 DB。證據：線上回讀零遺漏驗證通過（含兩句通關密語）＋ 8 課復刻截圖 vs
原頁截圖由 agent 三輪比對通過。07-07 的直排卡片版備份在
`scripts/course-first-station/backup-flow-41-blocks.json` 可回滾；重建管線與注意事項
（橫幅直連 Google 圖床、L2 圖 data URI 內嵌）見同目錄 README。課程總開關仍等使用者開。

**2026-07-09 再修（現行＝v3）**：使用者反映字太小＋要求影片區獨立成課。
① 字級放大 15%（桌機顯示≈原頁實體字大小），因字大會撐高文字框，改用兩段式重排：
Playwright 實測 307 個文字框放大後的真實高度 → 欄位感知堆疊演算法重排 y 座標
（同排對齊、左右欄各自下推、文字互疊檢查=0）。
② 課程切成 **9 課**：新增第 8 課「教你怎麼教影片」（lesson id `5e65c1f2`，不設作業），
原「下一站」內容獨立為第 9 課「下一站：正式講師培訓」（作業=學習心得）。
③ 橫幅與 L2 總覽圖皆改 data URI 內嵌（原直連 Google 圖床載入慢且可能失效，地雷已消）。
證據：線上回讀 352 區塊零遺漏驗證通過＋9 課復刻截圖 agent 比對通過（唯一問題＝橫幅
載入慢，已用內嵌解決）。版本檔：`pushed-canvas-v3-352-blocks.json`＋`generate_v3.py`。

### ✅ 第三條線：遊戲化 + 電子簽名本人驗證（2026-07-07，交接 session 續作）

- **成就徽章**：8 個徽章（初次啟程／勤學不倦／學而不厭／作業達人／人氣王／熱心交流／
  培訓結業／資深講師），定義集中在 `src/lib/badges.js` 好調門檻；講師個人頁新增「我的成就」
  區塊（已解鎖彩色、未解鎖灰階＋條件）。
- **排行榜**：新頁 `src/pages/Leaderboard.jsx`，4 維度切換（完成章節／獲讚／作業數／完訓課程）、
  前三名金銀銅 podium、自己那列高亮；導覽列已加入口（`/leaderboard`）。
- **完成培訓證明**：completed_courses≥1 時個人頁出現「下載完成培訓證明」，用 pdf-lib 產 PDF 證書
  （`src/lib/certificate.js`，中文走 canvas→PNG 手法）。
- **後端**：新增聚合函式 `get_teacher_stats()`（`supabase/2026-07-07_gamification.sql`），
  徽章與排行榜共用、不新增可寫表。**⚠️ 尚未套用線上**。
- **電子簽名本人驗證**：簽名前用 Supabase Email 驗證碼（`src/components/EmailOtpGate.jsx`），
  通過才解鎖簽名，並在合約寫入 `verified_at`/`verify_method`
  （欄位 SQL：`supabase/2026-07-07_esign_verification.sql`，**尚未套用線上**）。
- **順修 2 個簽約 bug**：(1) 講師等級空白不再讓人默默卡死，改顯示「請聯繫管理員」；
  (2) 沒設簽名欄位座標時擋下送出，不再產生「沒有簽名卻顯示成功」的無效合約。
- **證據**：build 親測綠燈 `✓ built in 5.07s`；4 個新檔皆存在；徽章解鎖邏輯 Node 實跑正確。
  **未做**：真資料與瀏覽器實測（get_teacher_stats 尚未上線＋Google OAuth 擋 Playwright 登入），
  需 SQL 上線後登入走一次。

---

## 🚧 半成品 / 需使用者出手的事

1. ~~**🔴 最急：資安 SQL 要套用到正式 Supabase**~~ ✅ **2026-07-09 線上實測確認已套用**
   （delete_user_completely 已含 admin 守衛，見最上方診斷段）。gamification 與
   teaching_leaderboard 同樣已上線。改為最急：**跑 `2025_instructor_claim.sql`**（認領功能全斷）。
   （以下原文留存）（我沒有存取權，無法代跑）。
   到 Supabase SQL Editor 貼上 `2026-07-07_security_hardening.sql` 整份執行，
   再照檔尾「攻擊重演」段用非 admin 測試帳號驗證漏洞已堵。**在套用前，任何登入者
   （含 pending）都能刪任意帳號、下載全體講師合約 PDF——這是真實可被利用的洞。**
2. **另外兩份新 SQL 也要貼進 Supabase**（新功能要它們才會通）：
   `2026-07-07_gamification.sql`（排行榜/徽章聚合函式）、
   `2026-07-07_esign_verification.sql`（簽名驗證欄位）。跑完各檔尾有驗證查詢。
   若報「欄位不存在」代表線上 schema 與檔案有落差，回報錯誤訊息我修。
   （三份 SQL 合計＝資安 1＋新功能 2，彼此獨立、順序不拘，資安那份最急。）
3. **電子簽名本人驗證上線前三關**：(a) Supabase 後台要**開 Email auth provider**，OTP 才寄得出；
   (b) 內建寄信有速率限制，正式上線量大建議接自有 SMTP（如 Resend）；
   (c) 需用真帳號**端到端實測**一次簽約（收信→輸碼→簽名→查合約有 verified_at）。
4. **法律確認（黃燈）**：「email 驗證＋手寫簽名」屬台灣《電子簽章法》一般電子簽章，有效力但
   **不推定本人親簽**（只有政府核可憑證的數位簽章才推定）。一般師資合約通常足夠，
   高價值合約建議諮詢律師。詳見 `scratchpad/esign-research.md`。
5. ~~**手機版優化這批要不要 commit＋push**~~ ✅ **2026-07-08 晚已 commit＋push（7c28766、
   2d1b226）**，含 6 處白屏 crash 修復。剩「開 Email provider＋跑 teaching_leaderboard.sql」
   兩件見最上方 🚀 段。
6. **`.env` 是否從版控移除**：目前被 git 追蹤，內容只有 anon key（非機密，資安查證過），
   不急。要清的話 `git rm --cached 培訓web/.env`（檔案留著、只是不再追蹤）。
7. **第一站課程發布**：內容已重建並驗證完畢（見上），課程總開關留給你確認後自己開。
   發布後建議把舊 Google Sites 頁加註「已搬遷」，避免兩處版本漂移。

---

## 📋 下一步（技術面，對應 ROADMAP Horizon 1，可交給任何模型分批做）

- [ ] 錯誤處理系統化：約 60 處 Supabase 呼叫只取 `data` 不檢查 `error`，失敗時靜默顯示
      空狀態、難除錯。建議做一個共用查詢 helper 統一處理。
- [ ] bundle code-splitting：目前 2MB 單一 chunk（gzip 633KB），用動態 import 拆分。
- [ ] 5 個 >800 行大檔逐步拆分（CanvasEditor 1145、ProfilePage 1015、LessonDetail 919、
      admin/InstructorList 867、admin/TeacherManager 820）。
- [ ] 剩餘 18 個 lint error（immutability/set-state-in-effect/purity）逐一評估修復。
- [ ] 採用 `src/lib/roles.js`：把 9 處散落的 `role === 'admin'` 字串比對換成 helper
      （有安全含義，改完要測）。
- [ ] npm audit 剩 1 個 Quill low（上游尚無新 Quill 版本）；現階段已對儲存與顯示 HTML
      加 DOMPurify。上游釋出修復後再升級並重跑編輯器回歸。
- [ ] 部署設定三份收斂成一份（Dockerfile／根 zbpack／培訓web zbpack），對齊 Zeabur 後台。
- [ ] 補 `docs/`：合約、薪資、匯款、認領流程都停在開案期沒文件。

---

## 💣 地雷（動到相關區域前先看這裡）

1. **權限 100% 靠後端 RLS/RPC**：新增 SECURITY DEFINER 函式必加角色守衛、新 Storage
   bucket 的 SELECT 必加 per-user 條件，否則預設對所有登入者開放（已出過致命洞）。
2. **SQL 遷移檔名前綴會騙人**：2024/2025/2026 前綴 ≠ 執行順序。真實順序：
   `setup.sql`(02-15) → 一批 02-21/02-22 檔 → `contracts_setup.sql`(03-01) →
   `2024_instructors_extend`→`2025_salary_system`→`2026_remittance_form_setup`→
   `2025_instructor_claim`(依實際 mtime，05 月)。新檔一律用 `YYYY-MM-DD_描述.sql`。
3. **`teacher` vs `instructor` 雙軌主檔**：teachers/instructors/claims 三套管理頁概念未收斂，
   新功能易在資料層打架。併軌策略需使用者拍板（ROADMAP §5）。
4. **`MySalary.jsx` vs `MySalaryNew.jsx`**：疑似遷移未收尾，兩個都掛路由，何者淘汰待確認。
5. **前端建立 notifications 可被偽造**：過渡 RLS 已加固（見資安 SQL），長期要改 server 端
   trigger／SECURITY DEFINER 產生、前端禁止 INSERT。
6. ~~展示元件的 icon prop 從未 render~~ **已於 2026-07-08 查明並修復**：真相是這些元件
   render 了 `<Icon />` 但沒接 icon prop（未定義變數），會讓整頁白屏 crash，不是「靜默沒畫」。
   6 處全修（見上方手機優化段），Playwright 已驗證頁面正常渲染且 icon 顯示。
7. **後台編輯器會吃掉第一站的自訂 HTML**：第一站課程的團隊卡片牆／按鈕群／作業框
   是手寫 HTML（flex＋inline style），用後台 quill 文字編輯器打開重存會把結構簡化掉。
   要改字直接改資料庫或交給 AI，詳見 `scripts/course-first-station/README.md`。
