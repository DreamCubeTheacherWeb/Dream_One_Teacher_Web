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
| `npm start` | `vite preview`，Zeabur 啟動用 |

## 🔐 權限模型（改任何 Supabase 相關程式前必讀）
權限邊界**100% 靠後端**：Supabase RLS 政策 + `SECURITY DEFINER` 函式內的角色檢查。
前端的 admin 路由守衛只是體驗層，不是安全防線。因此：
- 新增任何 RPC（SECURITY DEFINER 函式）→ **函式體開頭必加** `auth.uid()` 的角色檢查，
  否則預設對所有登入者開放（曾因此出現「任何人可刪任意帳號」的致命洞，見 STATUS 地雷）。
- 新增 Storage bucket → SELECT 政策必須有 per-user 條件，不可只寫 `bucket_id = '...'`。
- 敏感資料表（薪資、合約、個資）→ RLS 必須真的擋，不能只靠前端不顯示。

## ⚠️ SQL 遷移檔的執行順序陷阱
`培訓web/supabase/` 有 16 個 SQL 檔。**檔名前綴的 2024/2025/2026 不代表執行順序**
（`2026_remittance_form_setup.sql` 實際比 `2025_instructor_claim.sql` 更早跑）。
真正順序見 [STATUS.md](STATUS.md) 的 SQL 清單。新增遷移檔請用 `YYYY-MM-DD_描述.sql`
格式（如 `2026-07-07_security_hardening.sql`），別再用會誤導的數字前綴。

## 部署（Zeabur）
**正式站網址：https://dream-one-teacher.zeabur.app**（2026-07-09 業主提供）。
push main → Zeabur 自動部署，約 40–60 秒換版；驗部署慣例＝curl 首頁抓
`assets/index-*.js` 檔名，grep 新功能字串是否在 bundle 內。
存在**三份可能打架的設定**：根 `Dockerfile`（nginx 靜態伺服）、根 `zbpack.json`
（`cd 培訓web` 後 build）、`培訓web/zbpack.json`（不含 cd）。實際生效哪份取決於
Zeabur 專案的 Root Directory 設定，需登入後台確認（見 STATUS 地雷／待辦）。

## 地雷速查（詳情與待辦在 STATUS.md）
1. `培訓web/.env` 被 git 追蹤（內容只有 anon key，非機密外洩，但屬衛生問題）
2. 前端建立 notifications（client INSERT）→ 可偽造，過渡已加 RLS，長期要改 trigger
3. 5 個檔案 >800 行（CanvasEditor 1145、ProfilePage 1015、LessonDetail 919…）
4. `MySalary.jsx` 與 `MySalaryNew.jsx` 疑似遷移未收尾，兩個都掛在路由
5. bundle 2MB（無 code-splitting）；48 個 lint 問題（部分已修，見 STATUS）
6. 約 60 處 Supabase 呼叫不檢查 error → 失敗時靜默顯示空狀態，難除錯

## 工作紀律（沿用全域準則）
- 碰錢／線上 Supabase／對外發送／刪資料 → 動手前先問使用者。
- 前端視覺改動用 Playwright 實測截圖驗證，不要叫使用者當眼睛。
- 收尾更新 STATUS.md（完成+證據／半成品／下一步／地雷四欄）。
- 「完成」必附證據（實跑輸出、截圖路徑、線上 URL）；沒驗證就寫「已改完，未驗證」。
