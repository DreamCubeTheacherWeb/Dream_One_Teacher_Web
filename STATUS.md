# STATUS — 夢想一號培訓平台

> 會變的進度狀態放這裡。不變的事實看 [CLAUDE.md](CLAUDE.md)，長期方向看 [ROADMAP.md](ROADMAP.md)。
> 最後更新：2026-07-09（認領自動核准＋身分證末四碼＋等級自動帶入 已 commit＋push、兩份 SQL 已由業主套用；Fable 5）。

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
- [ ] npm audit 的 5 個漏洞（react-router 等 4 high）：`npm audit fix` 會升 react-router-dom
      主版本，**需測 23 條路由沒壞**才能上，別盲修。
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
