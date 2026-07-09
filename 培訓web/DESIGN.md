# DESIGN.md — Bauhaus 設計系統（2026-07-09 全站改版）

> 全站視覺的**唯一事實來源**。改任何頁面的樣式前先讀這份。
> Token 定義在 `tailwind.config.js`（colors/boxShadow/fontFamily）與 `src/index.css`（`.bh-*` 配方）。

## 1. core 理念

頁面是**幾何構成**，不是排版：圓形、方形、三角形；三原色＋黑白；粗黑框；硬陰影。
形隨機能——每個裝飾都直接、可解釋，禁止曖昧的柔化效果。

## 2. Token（只准引用，不准散寫色碼）

| Token | 值 | Tailwind class |
|---|---|---|
| 紅 | #D02020 | `bg-bauhaus-red` / `text-bauhaus-red` / `border-bauhaus-red` |
| 藍 | #1040C0 | `bg-bauhaus-blue` … |
| 黃 | #F0C020 | `bg-bauhaus-yellow` … |
| 黑（前景/邊框） | #121212 | `bauhaus-black` |
| 紙白（全站底） | #F0F0F0 | `bauhaus-paper` |
| 靜音灰 | #E0E0E0 | `bauhaus-muted` |
| 奶油黃（展開內容底） | #FFF9C4 | `bauhaus-cream` |
| 硬陰影 | 3/4/6/8px 黑色純位移 | `shadow-hard-sm` / `shadow-hard` / `shadow-hard-md` / `shadow-hard-lg`；深色底上用 `shadow-hard-white` |

**語意色對照**（Bauhaus 沒有綠色，全站統一）：
- 成功／完成 → 藍底白字，或黃底黑字＋黑色 Check 圖示
- 警告／待處理 → 黃底黑字
- 錯誤／危險／刪除 → 紅底白字
- 中性／停用 → `bauhaus-muted` 底黑字

## 3. 字體與字級

- 字體已在 `index.html` 載入：**Outfit**（英數）＋ **Noto Sans TC**（中文），`font-sans` 已指向兩者。
- 中文沒有大小寫，`uppercase` 只影響英數——照寫無妨；`tracking-widest` 中文同樣有效。
- 標題：`font-black`（900）＋ `tracking-tight`＋ `leading-[0.95]`。
- 行銷型頁面（HomePage hero、登入、PendingApproval）：`text-4xl sm:text-5xl lg:text-7xl`。
- 功能型頁面（admin、表單、清單）標題：`text-2xl lg:text-4xl font-black`，不要 8xl（資料密度優先）。
- 小標籤／欄位名：`.bh-label`（12px 全大寫寬字距）。
- 內文：`font-medium leading-relaxed`。

## 4. 形狀鐵律

- 圓角**二元**：`rounded-none`（預設）或 `rounded-full`（圓形徽章、頭像、pill 按鈕）。
  **禁止** `rounded-sm/md/lg/xl/2xl/3xl`。
- 邊框：`border-2`（手機）→ `lg:border-4`（桌機），一律 `border-bauhaus-black`。
  區段分隔用 `border-b-4 border-bauhaus-black`。
- 陰影：只准 `shadow-hard*` 系列。**禁止** `shadow-sm/md/lg/xl/2xl`（柔陰影）。
- **禁止漸層**（`bg-gradient-*` 一律移除，換成純色塊或幾何拼色）。

## 5. 共用配方（`src/index.css` 已定義，優先使用）

| class | 用途 |
|---|---|
| `.bh-card`（＋`.bh-card-hover`） | 白底黑框硬陰影卡片 |
| `.bh-btn` ＋ `.bh-btn-red/blue/yellow/outline` | 按鈕（含按壓下沉、focus ring、disabled） |
| `.bh-btn-ghost` | 無框輕量按鈕 |
| `.bh-input` | 輸入框／select／textarea |
| `.bh-label` | 表單小標 |
| `.bh-chip` | 徽章／篩選 chip |

按鈕形狀：預設方形；要 pill 就在 `.bh-btn` 後面補 `rounded-full`（utilities 會蓋過去）。

## 6. 常見元件寫法

- **分頁 tab**：選中＝`bg-bauhaus-black text-white`（或區段主色底），未選＝白底黑框；容器用 `border-2 border-bauhaus-black` 包起來，格與格 `divide-x-2 divide-bauhaus-black`，全部直角。
- **表格**：`border-2 lg:border-4 border-bauhaus-black`；表頭 `bg-bauhaus-black text-white uppercase tracking-wider text-xs`；列分隔 `divide-y-2 divide-bauhaus-black/20`；hover 列 `hover:bg-bauhaus-cream`。
- **Modal**：面板＝`bh-card` 加大陰影 `shadow-hard-lg`；標題列底色用區段主色；遮罩 `bg-bauhaus-black/60`（不模糊）。
- **空狀態**：幾何圖形（圓／方／三角一組）＋ `font-black` 標題＋一句說明＋一顆 `.bh-btn` CTA。
- **stat 卡**：數字 `font-black text-4xl`＋`tabular-nums`；卡片角落放 8-16px 幾何裝飾（紅圓／藍方／黃三角輪替；三角用 `clip-path:polygon(50% 0%,0% 100%,100% 100%)`）。
- **頭像／人像**：`rounded-full` ＋ `border-2 border-bauhaus-black`；裝飾性圖片可 `grayscale hover:grayscale-0`（功能性圖片如證件照、課程截圖**不要**灰階）。
- **通知鈴鐺／icon 鈕**：方形黑框容器；未讀數＝紅底白字方形小塊。
- **色塊區段**（行銷型頁面用）：整段 `bg-bauhaus-blue/red/yellow` 純色底；深色底上文字白色、卡片用 `shadow-hard-white`；黃底上一律黑字。admin 頁維持紙白底，靠卡片與黑框做層次。
- **幾何 logo**（Layout 導覽列）：紅圓＋藍方＋黃三角三個 16px 圖形並排，加公司 logo 圖。

## 7. 動效

- `duration-200`／`duration-300`＋`ease-out`，機械、果斷。
- 按鈕按壓：`active:translate-x-[2px] active:translate-y-[2px] active:shadow-none`（`.bh-btn` 已內建）。
- 卡片 hover：`-translate-y-1`。禁止彈跳／模糊／發光。
- 既有的 `lb-fade-up`、`otp-pop` keyframes 保留可用。

## 8. 改造鐵律（動手前必讀）

1. **只改外觀不改行為**：不動 state、handler、資料流、路由；JSX 結構僅允許為裝飾加減元素。
2. **觸控熱區不得縮水**：所有 `min-h-[44px]`／`min-w-[44px]`／`p-3` 熱區類 class 原封保留（2026-07-09 剛全站修完）。
3. **響應式前綴保留**：既有 `sm:`/`md:`/`lg:` 斷點分流照抄，只換視覺值。
4. **語意色不亂套**：照 §2 語意對照表換色，紅色只給錯誤／刪除／強調，不要把成功訊息改成紅的。
5. 深色底（藍/紅/黑）上的文字一律白；黃底上一律黑（對比度）。

## 9. 危險區（碰到這些檔案照規定來）

| 檔案 | 限制 |
|---|---|
| `src/pages/LessonDetail.jsx:744-908`（CanvasViewer） | 課程畫布內容來自 DB 絕對定位渲染：`absolute`＋inline style 座標、`dangerouslySetInnerHTML`、`.lesson-content`/`.canvas-text-view` 注入 CSS **全部不能動**；只能改頁面外框（header、返回鈕、進度條等 chrome） |
| `src/components/CanvasEditor.jsx` | 編輯器拖拉座標邏輯不能動；只准改工具列按鈕／面板配色圓角 |
| `src/lib/cubeEngine.js` | 3D 引擎注入的 `.dc-*` 樣式**整檔不碰**；CubeTimer 外層 UI 可改 |
| `src/index.css` quill 覆寫 | 已改成黑框直角，不要再動 `.ql-*` 內部 |
| `src/components/SignaturePad.jsx` | canvas 尺寸／DPI 邏輯不動，容器 flex／尺寸保留，只改框線配色 |
| `react-pdf`（DocumentViewer／FieldPositionEditor） | 套件內部 class 不碰，只改外層容器 |
