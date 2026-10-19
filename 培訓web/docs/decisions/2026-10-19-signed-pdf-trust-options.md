# 簽署 PDF 的可信度：兩條路給業主二選一（2026-10-19 評估，未實作）

> 來源：2026-10-18 講師簽約重開的資安審查提到的既有設計債。本文件只評估、不動程式。
> 相關程式：`src/pages/ContractSigningFlow.jsx`（`generateSignedPdfs`、`handleSubmit`）、
> `supabase/migrations/20261018180000_reopen_instructor_contract_signing.sql`（`submit_my_contract`）。

## 1. 現在是怎麼運作的，問題在哪

講師按「確認送出簽約」時，**所有事情都在講師的瀏覽器裡發生**：

1. 瀏覽器下載合約範本 PDF（`contract-documents` bucket 的 `docs/...`）。
2. 用 pdf-lib 把姓名、身分證、地址、電話（先用 canvas 畫成 PNG 圖）與簽名圖貼到管理員在定位器設好的座標上。
3. 把簽名 PNG 與貼好的 PDF 上傳到自己的 `signed/<uid>/` 資料夾。
4. 呼叫 `submit_my_contract`。RPC 會驗：登入、角色非 pending、30 分鐘內的 Email 驗證、文件版本等於目前啟用版本、
   檔案路徑在自己的資料夾、檔案真的存在。**但不看 PDF 內容。**

所以懂開發者工具的講師，可以在第 3 步把 PDF 換成改過的內容（例如改掉報酬條款），資料庫仍會記錄「已簽第 N 版」。

**威脅到底多大**：能動手的只有講師本人，改的是「自己手上那份 PDF」。公司這邊握有的證據是資料庫列
（簽了哪一版 `doc_versions`、填了什麼 `filled_*`、簽名圖、Email 驗證時間、IP、裝置），加上管理員上傳的範本原檔。
公司要能主張「他簽的就是第 N 版範本」，關鍵不在那份 PDF，而在**能否證明第 N 版範本自簽約後沒被改過**。
目前範本列與檔案都可由管理員覆寫，而且**沒有任何雜湊（檔案指紋）紀錄**。這才是現況最弱的一環。

## 2. 方案 A：伺服器端套印（Supabase Edge Function）

**做法**：講師只上傳簽名 PNG；由 Edge Function（Supabase 的雲端小程式）用 pdf-lib 以範本＋講師資料＋簽名圖產生 PDF、
算出範本的 SHA-256、上傳到 `signed/<uid>/`，再呼叫 `submit_my_contract` 把範本雜湊一併寫進 `instructor_contracts`。

**工程代價（估 3–5 個工作天，含驗證與部署學習）**：

| 項目 | 說明 |
|---|---|
| 全新基礎設施 | 本專案目前沒有任何 Edge Function（無 `supabase/functions/`、無 Supabase CLI 部署流程）。要新增 Deno 程式、CLI 部署、密鑰設定，且**不在 Zeabur 的自動部署內**，之後是第二條要維護的上線管線。 |
| 中文字型 | 前端現在把中文先畫成 PNG 貼上，是因為 pdf-lib 沒有字型檔畫不出中文。伺服器端要嵌入繁中字型（Noto Sans TC 單一字重約數 MB）＋ `@pdf-lib/fontkit`；字型檔要放 Storage 或打進函式包，函式包大小上限要先查官方文件確認（我沒有十足把握，標記待查）。 |
| 前端改動面 | `ContractSigningFlow.jsx` 刪掉約 100 行的 `generateSignedPdfs`／文字轉圖，改成呼叫函式並處理新錯誤碼；預覽畫面若要維持「所見即所得」，前端仍得保留一份產生邏輯或向函式要預覽。 |
| 資料庫 | `instructor_contracts` 加 `template_hashes jsonb`；`contract_documents` 加 `file_sha256`（管理員上傳時計算）；RPC 多一個參數或改為函式內以 service role 寫入。 |
| 驗證 | 現有 `verify-contract-signing-rpc` 要加函式層測試（Deno 測試或 mock），瀏覽器驗證 40 項要改走函式。 |
| 新的失敗模式 | 函式冷啟動、超時（大 PDF）、密鑰輪替；簽約量小（每月個位數）時執行費用可忽略。 |

**得到什麼**：PDF 本身由公司這邊產生，講師碰不到；每筆合約都附範本雜湊。

## 3. 方案 B：輕量——以「文件版本＋範本雜湊」當法律依據，PDF 只當講師留存用

**做法**（估 0.5–1 個工作天）：

1. `contract_documents` 加 `file_sha256`：管理員在後台上傳範本時，瀏覽器用 Web Crypto 算雜湊一起寫入。
2. 加一道資料庫觸發器：**只要某版本已被任何一筆 `instructor_contracts` 引用，就禁止改它的 `file_path`／`file_sha256`**，
   並把 storage 對已引用範本的覆寫（UPDATE／DELETE）擋掉。範本從此「簽過就凍結」。
3. `submit_my_contract` 在寫入時，從 `contract_documents` 把當下各版本的雜湊抄進 `instructor_contracts.template_hashes`
   （伺服器端抄，講師改不了）。
4. 合約檢視頁顯示「依據範本第 N 版，指紋 xxxx…」；管理員端加「重製 PDF」按鈕，用範本＋資料庫欄位＋簽名圖
   隨時重新產生一份正本（沿用現有 `formGenerator.js` 的做法，仍在瀏覽器跑，不需新基礎設施）。

**得到什麼**：證據鏈變成「凍結的範本（雜湊）＋資料庫欄位＋簽名圖＋Email 驗證時間」，PDF 隨時可重製；
講師手上那份即使改過，也對不上公司這邊的範本指紋與欄位。

**弱點**：講師持有的 PDF 不等於公司正本；若日後法務或會計要求「那一份檔案本身就是正本」，B 不夠，要走 A。
電子簽章法上的證據力如何認定，建議請真律師看一眼（我不是律師，這一段信心約七成）。

## 4. 建議：先做 B，A 留作條件觸發

- **為什麼**：威脅是講師改自己手上的副本，公司的立足點是「證明範本沒變＋資料庫紀錄」。B 用約四分之一的成本、
  零新基礎設施就補上這塊；A 多出來的價值只在「PDF 檔本身必須是正本」這個需求成立時才顯現。
- **何時升級到 A**：法務／會計明確要求正本必須是單一檔案；或簽約量成長到需要批次產生；或之後本來就要導入 Edge Function 做別的事。
- **B 的順序**：先凍結範本（第 2 點）再抄雜湊（第 3 點），否則抄到的雜湊沒有約束力。

## 5. 另一題請業主決定：輔導員（mentor）該不該讀 `signed/` 檔

**現況**：storage 讀取政策讓 mentor 可讀整個 `contract-documents` bucket，**包含所有講師的 `signed/<uid>/`
（簽名圖、含身分證字號／地址／電話的簽署 PDF）**，而且可以用 Storage API 列出整個資料夾；
但 `instructor_contracts` 資料列只開給管理員與本人，所以 mentor 在畫面上看不到任何合約入口，等於「畫面沒有、API 有」。
目前正式庫 mentor 0 人（2026-10-18 查），風險休眠中，但角色 CHECK 允許新增。

| 選項 | 改動 | 適合的情況 |
|---|---|---|
| ① mentor 可看合約 | 把 `instructor_contracts` SELECT 開給 mentor、後台合約頁對 mentor 開放，畫面與 API 一致 | 輔導員要負責帶簽約、追蹤誰沒簽 |
| ② mentor 不看合約（**我建議**） | 從 storage 政策的「整個 bucket」分支拿掉 mentor，只留 admin；mentor 仍透過已核准角色分支讀範本 | 輔導員只管教學，不經手個資（個資最小化） |

②是同一條政策改一個字，可與下一批 migration 一起上。

## 6. 順帶記錄（本次未動）

- `contract_field_positions` 的 SELECT 仍是 `USING (true)`：內容只有欄位座標，無個資，低風險，先不動。
- 開啟 Email OTP 後多了一條不經 Google 的登入路徑（信箱被盜＝帳號被盜），審查時已提，與本題無關但一併留痕。
