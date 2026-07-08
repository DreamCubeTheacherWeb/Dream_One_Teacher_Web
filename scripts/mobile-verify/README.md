# 手機版確定性驗證腳本

## 這是什麼

`verify.mjs` 是培訓web(React 19 + Vite 7 + Supabase anon 直連)的手機版回歸測試腳本。
用 Playwright 開真的 Chromium,實際捲動/截圖/量尺寸,而不是憑印象猜「應該沒問題」。

**核心問題**:全站登入只有 Google OAuth,自動化測試沒辦法真的走一遍登入流程。
**解法**:繞過登入,而不是模擬登入——

1. 用 `context.addInitScript` 在頁面載入前,把一個合法的假 session 塞進
   `localStorage` 的 `sb-<project-ref>-auth-token` key(supabase-js v2 的預設
   storageKey 格式)。session 的 `expires_at` 設在一年後,讓 GoTrueClient 初始化時
   判定「還沒過期」,不會嘗試打 refresh token 的網路請求。
2. 用 `context.route('**/*', ...)` 攔截所有打到 `*.supabase.co` 的請求,回假資料:
   - `rest/v1/users` 回一筆 `role: 'admin'` 的使用者列,讓 `AuthContext.fetchProfile`
     判定角色是 admin,才能走遍所有受保護頁面(含 `/admin/*`)。
   - 其他 `rest/v1/*`(含 `rpc/*`)一律回空陣列 `[]`;如果請求的 `Accept` header
     帶 `vnd.pgrst.object+json`(代表呼叫端用了 `.single()`/`.maybeSingle()`),
     改回傳 `null`,讓頁面判定「查無資料」進入空狀態,不會把空陣列誤當成一個物件。
   - `storage/v1/*` 一律回 404(沒有真的檔案可簽 URL)。
   - 非 `localhost`、非 `*.supabase.co` 的請求一律 `abort()`(字型、分析等第三方外連)。

這支腳本本身不需要真的登入,也不需要任何真實 Supabase 資料——純粹是「假資料 + 真渲染」
的白屏/溢出/JS 錯誤回歸測試。

## 怎麼跑

```bash
cd 培訓web && npm run build   # 先確保 dist/ 是最新的,腳本吃 build 好的產物
node scripts/mobile-verify/verify.mjs
```

腳本會自己:
1. 讀 `培訓web/.env` 拿 Supabase URL,推算 project ref 與 localStorage key。
2. 用 `培訓web/node_modules/.bin/vite preview --port 4199 --strictPort` 起本地伺服器
   (cwd 設為 `培訓web`,吃已 build 好的 `dist/`)。
3. 用 `培訓web/node_modules/playwright-core`(專案本來就有這個依賴,是某個套件的
   transitive dependency,不是額外裝的)開 headless Chromium,跑完兩種 viewport
   (390×844、375×667)各測 11 個頁面。
4. 結束時關掉 preview server。

跑完印出每條斷言一行 `PASS/FAIL | 頁面 | 寬度 | 斷言名 | 實測值`,最後一行
`SUMMARY: X passed, Y failed`;同樣內容也寫進
`scratchpad/mobile-shots/results.txt`(路徑寫死在腳本裡,是 session 專屬的暫存目錄,
之後這支腳本如果要長期用,可以考慮把輸出路徑改成可傳參數或相對路徑)。
全頁截圖存在同一個 `mobile-shots/` 目錄。有任何 FAIL,process exit code 是 1。

全程約 1-2 分鐘跑完(21 頁面 × 3 個基本斷言 + 首頁 3 項手機互動測試)。

## 測試涵蓋

- 11 個頁面(首頁、課程列表、排行榜、個人資料、我的薪資、新增薪資紀錄、合約簽署、
  後台總覽、講師名單、認領審核、待審核頁),每頁 × 2 種 viewport:
  - **無橫向溢出**:`document.body.scrollWidth <= window.innerWidth + 1`
  - **沒有白屏**:`#root` 的 innerText 長度 > 20 字;若卡在 loading 骨架(`.animate-pulse`
    / `.animate-spin` / 文字含「載入中」)也算過(見下方「已知限制」)
  - **無 pageerror**:特別是 `ReferenceError`,這條是 2026-07-08 修的 6 處
    `Icon is not defined` 白屏 bug 的回歸驗證
- 只在 390 寬這輪、在首頁額外測:
  - 漢堡選單按鈕觸控區 ≥ 44×44px
  - 點開手機選單、量選單裡每個連結/按鈕高度 ≥ 44px
  - 點開通知鈴鐺、確認面板完全落在 viewport 內(x ≥ 0 且 x+width ≤ 390)

## 踩過的坑(寫給以後改這支腳本的人)

`Layout.jsx` 的桌面導覽(`hidden md:flex`)與手機導覽(`flex md:hidden`)是**兩份獨立
渲染**,通知鈴鐺(`NotificationBell`)因此在 DOM 裡會出現兩個實例——桌面那個在窄螢幕下
只是被 CSS `display:none` 藏起來,並沒有真的不存在。第一版腳本用
`document.querySelectorAll('button').find(b => b.querySelector('svg.lucide-bell'))`
抓到的是文件順序中「第一個」符合的按鈕,也就是被藏起來的桌面版那個——點了它,狀態確實
切換了,但畫面上什麼都看不到,量出來的 boundingClientRect 是全 0,而 `x=0, width=0`
剛好滿足了「x>=0 且 x+width<=390」這個寫得太寬鬆的斷言,變成一個**看起來 PASS、實際上
沒測到任何東西**的假陽性(截圖檔案 `bell-open-390.png` 當時根本沒有面板,一眼就看得出來)。

修法有兩處,缺一不可:
1. 找按鈕/元素時一律加上「`getBoundingClientRect().width > 0 && height > 0`」的可見性
   過濾,不能只看選擇器是否命中。
2. 斷言本身也要求 `panelRect.width > 0`,而不是只檢查座標落在範圍內——不然下次同類型的
   bug 又會用「座標剛好是 0,兩個條件都滿足」的方式蒙混過關。

## 已知限制

- 這是**假資料渲染測試**,不是資料正確性測試。所有 `rest/v1/*`(除了 `users`)都回
  `[]`/`null`,所以看到的清單、金額、進度數字全部是空的——這是預期行為,不代表真實資料
  也是空的。
- 幾個頁面(`instructor_contracts`、`contract_documents`、`instructor_salary_summary`
  等)用了 `.single()`(不是 `.maybeSingle()`)去查可能不存在的列。真實 PostgREST 對
  `.single()` 查無資料時是回 406 錯誤,這支 mock 為了簡化統一回 `null`(200)。目前追過
  的頁面(`ContractSigningFlow.jsx` 等)都有 `|| ''` / `if (data)` 這類防呆,不會因此
  crash,但嚴格說這不是 100% 貼合真實 PostgREST 行為,只是「不會白屏」意義下的近似。
- 沒有測試表單送出、檔案上傳、簽名板等寫入類互動——這支腳本只驗「頁面能不能正常渲染」,
  不驗業務邏輯。
- 目前 21 個頁面 × viewport 全部空狀態渲染都正常,**沒有**觸發「loading 骨架也算過」
  這條備援規則,所以那條規則本身還沒被真實案例驗證過,只是防禦性設計。
