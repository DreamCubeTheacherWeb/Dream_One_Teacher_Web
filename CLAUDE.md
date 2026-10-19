# 夢想一號 — 師資培訓平台（CLAUDE.md）

> 這份放「不會變的事實」與「地雷」。會變的進度狀態看 [STATUS.md](STATUS.md)；
> 長期方向看 [ROADMAP.md](ROADMAP.md)。接手的模型：先讀這三份再動手。

## 這是什麼
夢想一號魔術方塊教學公司的**師資培訓平台**（training website / LMS）。
核心價值＝把外部／兼職講師「培訓好、認證好」；圍繞它長出了行政支援層
（合約簽署、薪資登記、匯款申請書）。定位以使用者 2026-07-07 拍板為準：
**它是培訓網站，不是營運系統**——行政功能是支撐，保持精簡穩定，不擴張成派案／排課系統。

## ⚠️ 目錄結構陷阱（最容易踩）
**所有程式碼都在子目錄 `培訓web/` 裡**，不是 repo 根目錄。
- 開發：`cd 培訓web && npm run dev`
- repo 根目錄只有部署設定（Dockerfile、zbpack.json）與資料匯入腳本 `scripts/`

## 技術棧（事實，勿臆測）
- 前端：React 19 + Vite 7 + react-router-dom 7 + Tailwind CSS 3
- 後端：Supabase（Postgres + Auth + Storage），前端用 **anon key 直連**
- 富文本：react-quill-new；PDF：pdf-lib / react-pdf；簽名：signature_pad；拖拉：react-rnd
- 登入：**Google OAuth only**（其他登入方式已於 commit 86e30f1 移除）
- 角色：`admin` / `mentor` / `teacher` / `pending`，存在 Supabase `users.role`

## 指令（都在 `培訓web/` 下跑）
| 指令 | 用途 |
|---|---|
| `npm run dev` | 本地開發 |
| `npm run build` | 產生 dist/（Vite） |
| `npm run lint` | ESLint |
| `npm test` | 單元測試（node --test，`src/**/*.test.js`） |
| `npm run verify:*`／`node scripts/verify-*.mjs` | 各功能的驗證腳本：mock Supabase＋Playwright 或本機暫時 PostgreSQL，不碰正式庫；瀏覽器與 PostgreSQL 類要在沙盒外跑（PostgreSQL 類加 `LC_ALL=C`） |
| `npm start` | `vite preview`，Zeabur 啟動用 |

## 🔐 權限模型（改任何 Supabase 相關程式前必讀）
權限邊界**100% 靠後端**：Supabase RLS 政策 + `SECURITY DEFINER` 函式內的角色檢查。
前端的 admin 路由守衛只是體驗層，不是安全防線。因此：
- 新增任何 RPC（SECURITY DEFINER 函式）→ **函式體開頭必加** `auth.uid()` 的角色檢查，
  否則預設對所有登入者開放（曾因此出現「任何人可刪任意帳號」的致命洞，見 STATUS 地雷）。
- 新增 Storage bucket → SELECT 政策必須有 per-user 條件，不可只寫 `bucket_id = '...'`。
- 敏感資料表（薪資、合約、個資）→ RLS 必須真的擋，不能只靠前端不顯示。

## ⚠️ SQL 遷移檔的執行順序陷阱
- `培訓web/supabase/*.sql`（約 40 個，2026-08 以前）：**檔名前綴的 2024/2025/2026 不代表執行順序**
  （`2026_remittance_form_setup.sql` 實際比 `2025_instructor_claim.sql` 更早跑），真正順序見 [STATUS.md](STATUS.md) 的 SQL 清單。
- `培訓web/supabase/migrations/`（2026-08 起）：新遷移檔一律放這裡，檔名 `YYYYMMDDHHMMSS_描述.sql`（14 碼時間戳），
  寫成可重複執行，並附一支 `scripts/verify-*.{mjs,sql}` 在本機暫時 PostgreSQL 先重現問題、再套兩次驗證。
- **正式庫由業主在 Supabase SQL Editor 套用**：Claude Code 的自動安全審查會擋下開啟 Supabase 後台（2026-10-20 實測），
  所以 migration 推上 main 不等於已生效；STATUS.md 要寫明「待業主套用」與套用順序。

## 部署（Zeabur）
**正式站網址：https://dream-one-teacher.zeabur.app 與 https://teacher.dreamcube.tw**（同一份部署）。
push main → Zeabur 自動部署，約 40–60 秒換版。驗部署慣例：本機 `npm run build` 產生的 `dist/assets/index-*.js`
檔名＝正式站首頁載入的檔名（Vite 依內容算雜湊，任何頁面改動都會連動入口檔名），再連續 5 次確認都是新檔名；
要 grep 特徵字串時先對本機 dist 確認抓得到。
實際生效的是 **Zeabur 靜態託管（回應標頭 `server: Caddy`）**，CSP 等標頭來自 `培訓web/public/_headers`。
根 `Dockerfile`（nginx）約九成確定沒在用，但內嵌一份和 `_headers` 相同的 CSP——改 CSP 時兩邊同步，
或等業主在 Zeabur 後台確認 Root Directory 後刪掉 Dockerfile 與根 `zbpack.json`（保留 `培訓web/zbpack.json`）。

## 地雷速查（詳情與待辦在 STATUS.md）
1. `培訓web/.env` 被 git 追蹤（內容只有 Supabase URL＋anon key，非機密）。**不要直接 `git rm --cached`**：
   正式站建置很可能就靠這個檔，先確認 Zeabur 後台有設 `VITE_SUPABASE_*` 才能移除。
2. 7 個檔案 >800 行：CubeTimer 1815、CanvasEditor 1783、ProfilePage 1403、SalaryRegister 1174、InstructorList 1113、
   LessonDetail 934、DownloadCenter 805。
3. 很多 Supabase 呼叫不檢查 error → 失敗時靜默顯示空狀態（甚至當成「查無資料」走錯流程），新寫的程式一律檢查。
4. 換流程時舊的 SECURITY DEFINER 函式要明確 DROP，否則會一直留在正式庫被任何登入者呼叫
   （2026-10-20 發現 07 月舊認領 RPC 仍在，見 migration `20261020010000`）。
5. `/my/salary`（MySalary.jsx，清單）與 `/my/salary/new`（MySalaryNew.jsx，回報表單）是兩個不同頁，不是重複。
6. 頂端選單在 1280px 以上才是桌機版，以下用漢堡選單（管理員 7 個項目，1024px 會擠爆）；加選單項目後跑
   `node scripts/verify-nav-breakpoints.mjs`。

## 工作紀律（沿用全域準則）
- 碰錢／線上 Supabase／對外發送／刪資料 → 動手前先問使用者。
- 前端視覺改動用 Playwright 實測截圖驗證，不要叫使用者當眼睛。
- 收尾更新 STATUS.md（完成+證據／半成品／下一步／地雷四欄）。
- 「完成」必附證據（實跑輸出、截圖路徑、線上 URL）；沒驗證就寫「已改完，未驗證」。
