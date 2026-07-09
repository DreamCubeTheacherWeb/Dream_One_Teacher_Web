// Bauhaus 幾何成就徽章。單一 inline SVG，只用三原色＋黑白，
// 形狀只用圓/方/三角/線構成，統一圓形獎章外框（粗黑框 + 紙白底）。
// 用法：<BadgeIcon badgeKey="hours_50" size={72} />
// 對照 DESIGN.md §2/§4：無綠、無漸層、無柔陰影、圓角二元（圓或直角）。

const RED = '#D02020';
const BLUE = '#1040C0';
const YELLOW = '#F0C020';
const BLACK = '#121212';
const WHITE = '#FFFFFF';
const NONE = 'none';

// ── 夢想一號品牌母題（提煉自 public/logo.png：三原色積木堆成的「不可能三角形」）──
// brandTri：三色三角框（黃左／紅右／藍底），中央鏤空 —— logo 的招牌剪影。
// isoCube ：等角立方積木（頂黃／左藍／右紅）—— logo 的 building block、魔方本體。
const rnd = (n) => Math.round(n * 10) / 10;
function brandTri(cx, cy, s, sw = 3) {
  const T = [cx, cy - s];
  const L = [cx - 0.87 * s, cy + 0.5 * s];
  const R = [cx + 0.87 * s, cy + 0.5 * s];
  const f = 0.42;
  const t = [cx, cy - f * s];
  const l = [cx - 0.87 * f * s, cy + 0.5 * f * s];
  const r = [cx + 0.87 * f * s, cy + 0.5 * f * s];
  const P = (a) => `${rnd(a[0])},${rnd(a[1])}`;
  const quad = (a, b, c, d) => `${P(a)} ${P(b)} ${P(c)} ${P(d)}`;
  return [
    { t: 'poly', pts: quad(T, L, l, t), fill: YELLOW, sw }, // 左邊：黃
    { t: 'poly', pts: quad(L, R, r, l), fill: BLUE, sw },   // 底邊：藍
    { t: 'poly', pts: quad(R, T, t, r), fill: RED, sw },    // 右邊：紅
  ];
}
function isoCube(cx, cy, s, sw = 3) {
  const P = (x, y) => `${rnd(x)},${rnd(y)}`;
  const top = [P(cx, cy - s), P(cx + 0.87 * s, cy - 0.5 * s), P(cx, cy), P(cx - 0.87 * s, cy - 0.5 * s)].join(' ');
  const left = [P(cx - 0.87 * s, cy - 0.5 * s), P(cx, cy), P(cx, cy + s), P(cx - 0.87 * s, cy + 0.5 * s)].join(' ');
  const right = [P(cx, cy), P(cx + 0.87 * s, cy - 0.5 * s), P(cx + 0.87 * s, cy + 0.5 * s), P(cx, cy + s)].join(' ');
  return [
    { t: 'poly', pts: top, fill: YELLOW, sw },  // 頂面：黃
    { t: 'poly', pts: left, fill: BLUE, sw },   // 左面：藍
    { t: 'poly', pts: right, fill: RED, sw },   // 右面：紅
  ];
}

// ── 講師等級牌（字為主角）：圓形獎章＋一個大粗體字，色階分級（方向 A，2026-07-09 定案）──
const FONT = "'Outfit','Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif";

// 38 枚徽章的幾何描述（每筆一個形狀）。座標系 viewBox 0 0 100 100，中心 (50,50)；
// 圓形獎章外框由元件統一畫，這裡只放章內內容。
const ICONS = {
  // ── 教學里程碑 ─────────────────────────
  hours_50: [ // 接課新星：迷你品牌三角（logo）＋一顆黃色新星火花＝加入夢想一號
    ...brandTri(45, 55, 20),
    { t: 'poly', pts: '72,21 75.5,26.5 81,30 75.5,33.5 72,39 68.5,33.5 63,30 68.5,26.5', fill: YELLOW, sw: 3 },
  ],
  hours_100: [ // 百時講師：紅色六芒星（兩三角疊）
    { t: 'tri', cx: 50, cy: 47, size: 22, fill: RED, sw: 5 },
    { t: 'tri', cx: 50, cy: 53, size: 22, rot: 180, fill: RED, sw: 5 },
  ],
  hours_300: [ // 教學好手：火焰＝紅大三角內套黃小三角
    { t: 'tri', cx: 50, cy: 56, size: 26, fill: RED, sw: 5 },
    { t: 'tri', cx: 50, cy: 50, size: 13, fill: YELLOW, sw: 4 },
  ],
  hours_500: [ // 魔方宗師：品牌不可能三角（logo）＋黑色皇冠＝戴上公司徽記的宗師
    ...brandTri(50, 57, 25),
    { t: 'poly', pts: '36,29 40,20 45,26 50,15 55,26 60,20 64,29 64,31 36,31', fill: BLACK, sw: 3 },
  ],
  sessions_100: [ // 百場老手：同心圓靶（黑/紅/黃）
    { t: 'circle', cx: 50, cy: 50, r: 32, fill: WHITE, sw: 5 },
    { t: 'circle', cx: 50, cy: 50, r: 21, fill: RED, sw: 4 },
    { t: 'circle', cx: 50, cy: 50, r: 10, fill: YELLOW, sw: 4 },
  ],
  sessions_300: [ // 場次鐵人：懸掛獎牌＝頂端兩條紅緞帶＋藍圓獎章＋中央黃星
    { t: 'poly', pts: '42,44 50,44 40,24 32,24', fill: RED, sw: 3 },
    { t: 'poly', pts: '58,44 50,44 60,24 68,24', fill: RED, sw: 3 },
    { t: 'circle', cx: 50, cy: 60, r: 20, fill: BLUE, sw: 5 },
    { t: 'poly', pts: '50,51 53.5,56.5 59,60 53.5,63.5 50,69 46.5,63.5 41,60 46.5,56.5', fill: YELLOW, sw: 3 },
  ],
  reach_500: [ // 春風化雨：三個交疊圓（紅藍黃＝人群）
    { t: 'circle', cx: 40, cy: 44, r: 19, fill: RED, op: 0.88 },
    { t: 'circle', cx: 60, cy: 44, r: 19, fill: BLUE, op: 0.88 },
    { t: 'circle', cx: 50, cy: 62, r: 19, fill: YELLOW, op: 0.88 },
  ],
  reach_2000: [ // 萬人導師：黑色列柱＋黃三角山牆（神殿）
    { t: 'tri', cx: 50, cy: 34, size: 18, fill: YELLOW },
    { t: 'rect', cx: 50, cy: 66, w: 54, h: 8, fill: BLACK },
    { t: 'rect', cx: 30, cy: 54, w: 6, h: 20, fill: BLACK },
    { t: 'rect', cx: 43, cy: 54, w: 6, h: 20, fill: BLACK },
    { t: 'rect', cx: 57, cy: 54, w: 6, h: 20, fill: BLACK },
    { t: 'rect', cx: 70, cy: 54, w: 6, h: 20, fill: BLACK },
  ],
  coursetype_5: [ // 斜槓講師：正方形對角線切成紅/藍兩半
    { t: 'poly', pts: '30,30 70,30 30,70', fill: RED },
    { t: 'poly', pts: '70,30 70,70 30,70', fill: BLUE },
  ],
  coursetype_10: [ // 全能教師：紅圓＋藍方＋黃三角三形並置
    { t: 'circle', cx: 28, cy: 56, r: 10, fill: RED },
    { t: 'rect', cx: 50, cy: 56, w: 20, h: 20, fill: BLUE },
    { t: 'tri', cx: 72, cy: 50, size: 11, fill: YELLOW },
  ],
  // ── WCA・方塊競速 ─────────────────────
  wca_certified: [ // WCA認證：品牌等角魔方積木（logo block）＋黑色打勾＝認證通過
    ...isoCube(50, 42, 18),
    { t: 'polyline', pts: '36,64 45,74 68,52', stroke: BLACK, sw: 6 },
  ],
  wca_sub10: [ // 向上紅色雙箭號
    { t: 'polyline', pts: '30,58 50,40 70,58', stroke: RED, sw: 7 },
    { t: 'polyline', pts: '30,72 50,54 70,72', stroke: RED, sw: 7 },
  ],
  wca_sub8: [ // 藍色菱形（旋轉方）＋黑框
    { t: 'rect', cx: 50, cy: 50, w: 38, h: 38, rot: 45, fill: BLUE, sw: 5 },
  ],
  wca_allround10: [ // 三個旋轉方塊風車（紅藍黃）
    { t: 'rect', cx: 50, cy: 32, w: 16, h: 16, rot: 20, fill: RED },
    { t: 'rect', cx: 66, cy: 60, w: 16, h: 16, rot: 140, fill: BLUE },
    { t: 'rect', cx: 34, cy: 60, w: 16, h: 16, rot: 260, fill: YELLOW },
  ],
  wca_bf: [ // 盲解大師：白方塊（魔方）＋橫過眼睛的黑色蒙眼帶
    { t: 'rect', cx: 50, cy: 50, w: 44, h: 44, fill: WHITE, sw: 5 },
    { t: 'rect', cx: 50, cy: 46, w: 52, h: 12, fill: BLACK, sw: 0 },
  ],
  wca_bigcube: (() => { // 3x3 小方格陣
    const cols = [RED, YELLOW, BLUE, BLUE, RED, YELLOW, YELLOW, BLUE, RED];
    const pos = [30, 50, 70];
    const cells = [];
    pos.forEach((cy, r) => pos.forEach((cx, c) => {
      cells.push({ t: 'rect', cx, cy, w: 16, h: 16, fill: cols[r * 3 + c], sw: 3 });
    }));
    return cells;
  })(),
  cube_sub20: [ // 內部競速達標：品牌等角魔方積木＋頂面三顆黑點（骰／魔方）
    ...isoCube(50, 48, 22),
    { t: 'circle', cx: 50, cy: 35, r: 3, fill: BLACK, sw: 0 },
    { t: 'circle', cx: 44, cy: 40, r: 3, fill: BLACK, sw: 0 },
    { t: 'circle', cx: 56, cy: 40, r: 3, fill: BLACK, sw: 0 },
  ],
  cube_kb50: [ // 兩排小方格（鍵盤）
    { t: 'rect', cx: 31, cy: 43, w: 14, h: 14, fill: BLUE, sw: 3 },
    { t: 'rect', cx: 51, cy: 43, w: 14, h: 14, fill: BLUE, sw: 3 },
    { t: 'rect', cx: 71, cy: 43, w: 14, h: 14, fill: BLUE, sw: 3 },
    { t: 'rect', cx: 31, cy: 63, w: 14, h: 14, fill: RED, sw: 3 },
    { t: 'rect', cx: 51, cy: 63, w: 14, h: 14, fill: RED, sw: 3 },
    { t: 'rect', cx: 71, cy: 63, w: 14, h: 14, fill: RED, sw: 3 },
  ],
  // ── 等級・年資 ─────────────────────────
  // 五級講師階梯（低→高）：極簡色牌，圓形獎章＋大粗體字，靠底色與字面分高低
  intern: [ // 實習：白底黑「實」，最樸素，沿用外框自帶的白底
    { t: 'text', x: 50, y: 51, size: 46, str: '實', fill: BLACK, ls: -1 },
  ],
  level_b: [ // B 級：藍底白「B」
    { t: 'circle', cx: 50, cy: 50, r: 44, fill: BLUE, sw: 6 },
    { t: 'text', x: 50, y: 51, size: 50, str: 'B', fill: WHITE, ls: -1 },
  ],
  level_a: [ // A 級：藍底白「A」
    { t: 'circle', cx: 50, cy: 50, r: 44, fill: BLUE, sw: 6 },
    { t: 'text', x: 50, y: 51, size: 50, str: 'A', fill: WHITE, ls: -1 },
  ],
  level_aplus: [ // A+ 級：藍底白「A+」，兩字元縮字級塞下
    { t: 'circle', cx: 50, cy: 50, r: 44, fill: BLUE, sw: 6 },
    { t: 'text', x: 50, y: 51, size: 36, str: 'A+', fill: WHITE, ls: -2 },
  ],
  level_s: [ // S 級：黃底黑「S」＋頂端黑皇冠封頂
    { t: 'circle', cx: 50, cy: 50, r: 44, fill: YELLOW, sw: 6 },
    { t: 'poly', pts: '35,24 41.75,11 47,18 50,8 53,18 58.25,11 65,24 65,26 35,26', fill: BLACK, sw: 2 },
    { t: 'text', x: 50, y: 55, size: 50, str: 'S', fill: BLACK, ls: -1 },
  ],
  tenure_1: [ // 一年有成：單一黑圓環
    { t: 'circle', cx: 50, cy: 50, r: 26, fill: NONE, sw: 8 },
  ],
  tenure_3: [ // 三年老鳥：三層蛋糕（紅藍黃橫條堆疊）
    { t: 'rect', cx: 50, cy: 34, w: 26, h: 14, fill: YELLOW },
    { t: 'rect', cx: 50, cy: 50, w: 40, h: 14, fill: BLUE },
    { t: 'rect', cx: 50, cy: 66, w: 54, h: 14, fill: RED },
  ],
  tenure_5: [ // 五年元老：黑三角山＋黃三角峰
    { t: 'tri', cx: 50, cy: 60, size: 32, fill: BLACK, sw: 5 },
    { t: 'tri', cx: 50, cy: 34, size: 13, fill: YELLOW, sw: 4 },
  ],
  founder: [ // 創始元老：品牌不可能三角（logo）＋中央黃圓＝從原點打造這家公司
    ...brandTri(50, 54, 27),
    { t: 'circle', cx: 50, cy: 54, r: 8, fill: YELLOW, sw: 3 },
  ],
  // ── 地域・角色 ─────────────────────────
  region_3: [ // 跨縣市教學：三個並排小方（紅藍黃）
    { t: 'rect', cx: 30, cy: 50, w: 16, h: 16, fill: RED },
    { t: 'rect', cx: 50, cy: 50, w: 16, h: 16, fill: BLUE },
    { t: 'rect', cx: 70, cy: 50, w: 16, h: 16, fill: YELLOW },
  ],
  region_6: [ // 全台走透透：藍色箭矢（方+三角，速度感）
    { t: 'rect', cx: 40, cy: 50, w: 32, h: 11, fill: BLUE },
    { t: 'tri', cx: 72, cy: 50, size: 15, rot: 90, fill: BLUE },
  ],
  region_offshore: [ // 離島特派員：紅三角帆＋黑波浪線
    { t: 'tri', cx: 45, cy: 46, size: 19, rot: -8, fill: RED, sw: 5 },
    { t: 'rect', cx: 45, cy: 68, w: 6, h: 24, fill: BLACK },
    { t: 'polyline', pts: '24,78 34,72 44,78 54,72 64,78 74,72', stroke: BLACK, sw: 5 },
  ],
  lead_100: [ // 首席主講：麥克風＝紅圓網頭＋黑色網格線＋細桿＋底座
    { t: 'rect', cx: 50, cy: 64, w: 7, h: 24, fill: BLACK },
    { t: 'rect', cx: 50, cy: 78, w: 26, h: 6, fill: BLACK },
    { t: 'circle', cx: 50, cy: 38, r: 15, fill: RED, sw: 4 },
    { t: 'line', x1: 41, y1: 34, x2: 59, y2: 34, stroke: BLACK, sw: 2.5 },
    { t: 'line', x1: 40, y1: 39, x2: 60, y2: 39, stroke: BLACK, sw: 2.5 },
    { t: 'line', x1: 41, y1: 44, x2: 59, y2: 44, stroke: BLACK, sw: 2.5 },
  ],
  assist_100: [ // 最佳綠葉：莖上兩片藍三角葉
    { t: 'line', x1: 50, y1: 74, x2: 50, y2: 32, stroke: BLACK, sw: 6 },
    { t: 'tri', cx: 36, cy: 50, size: 12, rot: -45, fill: BLUE },
    { t: 'tri', cx: 64, cy: 50, size: 12, rot: 45, fill: BLUE },
  ],
  streak_6: [ // 全勤連擊：三顆紅火三角一排
    { t: 'tri', cx: 32, cy: 55, size: 12, fill: RED },
    { t: 'tri', cx: 50, cy: 50, size: 14, fill: RED },
    { t: 'tri', cx: 68, cy: 55, size: 12, fill: RED },
  ],
  // ── 搞笑・彩蛋 ─────────────────────────
  gore_4day: [ // 爆肝場記：歪斜黑方＋兩個小方（X眼，累癱）
    { t: 'rect', cx: 50, cy: 54, w: 44, h: 32, rot: -8, fill: BLACK },
    {
      t: 'group', rot: -8, cx: 50, cy: 54, children: [
        { t: 'line', x1: 36, y1: 46, x2: 44, y2: 54, stroke: WHITE, sw: 4 },
        { t: 'line', x1: 44, y1: 46, x2: 36, y2: 54, stroke: WHITE, sw: 4 },
        { t: 'line', x1: 56, y1: 46, x2: 64, y2: 54, stroke: WHITE, sw: 4 },
        { t: 'line', x1: 64, y1: 46, x2: 56, y2: 54, stroke: WHITE, sw: 4 },
      ],
    },
  ],
  marathon_6h: [ // 馬拉松教學：三個向前紅 chevron（動態）
    { t: 'polyline', pts: '34,32 50,50 34,68', stroke: RED, sw: 7 },
    { t: 'polyline', pts: '50,32 66,50 50,68', stroke: RED, sw: 7 },
    { t: 'polyline', pts: '66,32 82,50 66,68', stroke: RED, sw: 7 },
  ],
  turtle: [ // 龜速也是速度：藍半圓龜殼＋黑線腳＋小方頭
    { t: 'path', d: 'M 24 58 A 26 26 0 0 1 76 58 Z', fill: BLUE, sw: 5 },
    { t: 'line', x1: 30, y1: 66, x2: 22, y2: 76, stroke: BLACK, sw: 5 },
    { t: 'line', x1: 70, y1: 66, x2: 78, y2: 76, stroke: BLACK, sw: 5 },
    { t: 'rect', cx: 50, cy: 68, w: 13, h: 10, fill: WHITE },
  ],
  otaku: [ // 阿宅認證：兩個方框眼鏡＋黑鼻樑條
    { t: 'rect', cx: 32, cy: 50, w: 22, h: 18, fill: WHITE },
    { t: 'rect', cx: 68, cy: 50, w: 22, h: 18, fill: WHITE },
    { t: 'rect', cx: 50, cy: 50, w: 8, h: 6, fill: BLACK },
  ],
  potato: [ // 馬鈴薯：黃色圓潤塊＋兩黑點眼
    { t: 'ellipse', cx: 50, cy: 52, rx: 30, ry: 22, rot: -6, fill: YELLOW },
    { t: 'circle', cx: 40, cy: 48, r: 4, fill: BLACK, sw: 0 },
    { t: 'circle', cx: 58, cy: 48, r: 4, fill: BLACK, sw: 0 },
  ],
  catpenguin: [ // 貓咪企鵝翻跟斗：黑圓＋兩三角耳＋黃三角嘴
    { t: 'circle', cx: 50, cy: 54, r: 26, fill: BLACK },
    { t: 'tri', cx: 36, cy: 32, size: 9, fill: BLACK },
    { t: 'tri', cx: 64, cy: 32, size: 9, fill: BLACK },
    { t: 'tri', cx: 50, cy: 58, size: 9, rot: 180, fill: YELLOW },
  ],
  nightowl: [ // 夜貓講師：黃色新月（圓減偏移圓）＋藍小圓眼
    { t: 'circle', cx: 48, cy: 46, r: 22, fill: YELLOW },
    { t: 'circle', cx: 60, cy: 40, r: 20, fill: WHITE, sw: 0 },
    { t: 'circle', cx: 40, cy: 54, r: 5, fill: BLUE, sw: 0 },
  ],
  ghost: [], // 查無此人：外框畫成虛線、章內留空（見元件本體）
};

// 未知 key 的中性 fallback：黑圓環＋黑色菱形，不含任何分類色。
const FALLBACK = [
  { t: 'circle', cx: 50, cy: 50, r: 24, fill: NONE, sw: 5 },
  { t: 'rect', cx: 50, cy: 50, w: 22, h: 22, rot: 45, fill: BLACK },
];

function triPoints(cx, cy, size) {
  const r = size;
  const p1 = [cx, cy - r];
  const p2 = [cx - r * 0.87, cy + r * 0.5];
  const p3 = [cx + r * 0.87, cy + r * 0.5];
  return [p1, p2, p3].map((p) => p.join(',')).join(' ');
}

function renderShape(s, i) {
  const stroke = s.stroke ?? BLACK;
  const sw = s.sw ?? 4;
  const fill = s.fill ?? BLACK;
  switch (s.t) {
    case 'circle':
      return (
        <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill={fill} stroke={stroke}
          strokeWidth={sw} fillOpacity={s.op} />
      );
    case 'ellipse':
      return (
        <ellipse key={i} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} fill={fill} stroke={stroke}
          strokeWidth={sw} transform={s.rot ? `rotate(${s.rot} ${s.cx} ${s.cy})` : undefined} />
      );
    case 'rect':
      return (
        <rect key={i} x={s.cx - s.w / 2} y={s.cy - s.h / 2} width={s.w} height={s.h}
          fill={fill} stroke={stroke} strokeWidth={sw}
          transform={s.rot ? `rotate(${s.rot} ${s.cx} ${s.cy})` : undefined} />
      );
    case 'tri':
      return (
        <polygon key={i} points={triPoints(s.cx, s.cy, s.size)} fill={fill} stroke={stroke}
          strokeWidth={sw} strokeLinejoin="round"
          transform={s.rot ? `rotate(${s.rot} ${s.cx} ${s.cy})` : undefined} />
      );
    case 'poly':
      return <polygon key={i} points={s.pts} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />;
    case 'text':
      return (
        <text key={i} x={s.x} y={s.y} fontSize={s.size} fontWeight={s.weight ?? 900}
          fill={s.fill ?? BLACK} textAnchor="middle" dominantBaseline="central"
          fontFamily={FONT} letterSpacing={s.ls ?? -0.5}>
          {s.str}
        </text>
      );
    case 'polyline':
      return (
        <polyline key={i} points={s.pts} fill="none" stroke={stroke} strokeWidth={sw}
          strokeLinecap="round" strokeLinejoin="round" />
      );
    case 'line':
      return <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={stroke} strokeWidth={sw} strokeLinecap="round" />;
    case 'path':
      return <path key={i} d={s.d} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />;
    case 'group':
      return (
        <g key={i} transform={`rotate(${s.rot} ${s.cx} ${s.cy})`}>
          {s.children.map((c, j) => renderShape(c, j))}
        </g>
      );
    default:
      return null;
  }
}

/**
 * 幾何 Bauhaus 成就徽章：單一 inline SVG，圓形獎章（紙白底＋粗黑框）內含幾何字符。
 * 只用 #D02020 / #1040C0 / #F0C020 / #121212 / 白，形狀只用圓/方/三角/線，直角或正圓。
 * @param {{badgeKey: string, size?: number, className?: string}} props
 *   badgeKey — 對應 badge_definitions.key（38 個既定 key）；未知 key 顯示中性 fallback 章。
 */
export default function BadgeIcon({ badgeKey, size = 72, className = '' }) {
  const isGhost = badgeKey === 'ghost';
  const list = isGhost ? [] : (ICONS[badgeKey] || FALLBACK);
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={badgeKey || 'badge'}
    >
      <circle
        cx="50" cy="50" r="44"
        fill={WHITE}
        stroke={BLACK}
        strokeWidth={isGhost ? 5 : 6}
        strokeDasharray={isGhost ? '8 6' : undefined}
      />
      {list.map((s, i) => renderShape(s, i))}
    </svg>
  );
}
