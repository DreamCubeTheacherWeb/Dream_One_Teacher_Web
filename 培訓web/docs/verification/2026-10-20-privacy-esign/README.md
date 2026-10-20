# 隱私權政策補電子簽署個資項目：驗證紀錄（2026-10-20）

依據：`docs/specs/2026-10-20-esign-legal-copy.md` 紅燈 R2（個資法 §8 告知義務）、§5-d `esign-privacy-notice-v1`。
狀態：已改完、未上線，等業主審新舊對照。

## 怎麼驗
`npm run build` 後執行 `node scripts/verify-privacy-policy-esign.mjs`（需要本機開連接埠；Claude 沙盒內要在沙盒外跑）。
腳本以正式版建置（vite preview）開 `/privacy`，Supabase 請求一律回空結果，不連正式資料庫。

## 結果（2026-10-20 實跑，ALL PASS）
桌機 1440×900、手機 390×844 各 15 項：
- 頁面含「電子簽署紀錄：」「簽名影像」「Email 驗證碼的驗證時間」「IP 位址」「User Agent（瀏覽器與裝置資訊）」「證明簽約事實、處理契約爭議」「合作結束後 15 年」「使用 Resend 寄送電子郵件」
- 頁面不含「一樣的法律效力」「與親簽效力相同」「等同親筆簽名」，也不顯示內部註記「待業主確認」
- 整頁 scrollWidth − clientWidth：桌機 html=0、body=0；390px html=0、body=0；沒有元素超出視窗寬度
- 無 JS 錯誤

## 截圖
- 整頁：`privacy-desktop.png`、`privacy-mobile-390.png`
- 新增段落所在區塊特寫：`privacy-{desktop,mobile-390}-{data-categories,purposes,use-scope,providers}.png`
