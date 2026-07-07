# STATUS — 夢想一號培訓平台

> 會變的進度狀態放這裡。不變的事實看 [CLAUDE.md](CLAUDE.md)，長期方向看 [ROADMAP.md](ROADMAP.md)。
> 最後更新：2026-07-08（交接整理 + 遊戲化改版 session，Fable 5）。

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

1. **🔴 最急：資安 SQL 要套用到正式 Supabase**（我沒有存取權，無法代跑）。
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
5. **本次程式碼改動要不要 commit＋部署**：一批改檔＋多個新檔已在工作區。要我 commit
   請說一聲；部署到 Zeabur 前也要你點頭。
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
6. **展示元件的 icon prop 從未 render**（BigStat/StatCard/NavCard/Section/InfoRow）：
   可能是圖示本該顯示卻靜默沒畫。工程師只清了未用綁定、未改行為，待確認是否為 UI bug。
7. **後台編輯器會吃掉第一站的自訂 HTML**：第一站課程的團隊卡片牆／按鈕群／作業框
   是手寫 HTML（flex＋inline style），用後台 quill 文字編輯器打開重存會把結構簡化掉。
   要改字直接改資料庫或交給 AI，詳見 `scripts/course-first-station/README.md`。
