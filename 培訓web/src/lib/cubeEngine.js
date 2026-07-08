// ═══════════════════════════════════════════════════════════════════
// 方塊競速：3D 魔術方塊引擎（2026-07-08）
// ───────────────────────────────────────────────────────────────────
// 分兩層：
//   1) 純邏輯層（createCubeState / applyTurnToState / isSolvedState /
//      genScramble / invertMoves）——不碰 DOM，可在 Node 直接測試。
//   2) DOM 渲染層（CubeRenderer class）——把純邏輯層的狀態畫成可拖曳、
//      可轉動的 3D 方塊。
// 矩陣運算（column-major，同 CSS matrix3d）與還原判定演算法移植自已驗證
// 可動的參考實作，邏輯不變，只是把像素座標換成單位座標（S=1），DOM 層
// 顯示時再乘上像素大小。
// ═══════════════════════════════════════════════════════════════════

// ── 內部矩陣工具（不對外匯出） ─────────────────────────────────────────
function ident(tx = 0, ty = 0, tz = 0) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
}

function mul(A, B) {
  const C = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k];
      C[c * 4 + r] = s;
    }
  }
  return C;
}

function rotMat(axis, rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  if (axis === 0) return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === 1) return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function snap(M) {
  return M.map((v) => Math.round(v));
}

// ── 純邏輯層 ──────────────────────────────────────────────────────────

// 建立 27 顆 cubie，單位座標（S=1）。home 與初始 M 皆為 x,y,z ∈ {-1,0,1}。
export function createCubeState() {
  const cubies = [];
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        cubies.push({ home: [x, y, z], M: ident(x, y, z) });
      }
    }
  }
  return cubies;
}

// 把一個轉層動作套用到 state（就地修改），回傳同一個 state 方便鏈式呼叫。
// move: { axis: 0|1|2, layer: -1|0|1|'all', dir: 1|-1 }
// layer==='all' 用於 x/y 整顆翻面（三層一起轉，見 MOVE_TABLE 的 x/y 定義）。
export function applyTurnToState(state, { axis, layer, dir }) {
  const R = rotMat(axis, dir * (Math.PI / 2));
  for (const c of state) {
    if (layer !== 'all' && Math.round(c.M[12 + axis]) !== layer) continue;
    c.M = snap(mul(R, c.M));
  }
  return state;
}

// 是否還原：對每個外層面，該面 9 格「對應到自己 home 座標的那格顏色」必須一致。
export function isSolvedState(state) {
  for (let a = 0; a < 3; a++) {
    for (let s = -1; s <= 1; s += 2) {
      let seen = null;
      for (const c of state) {
        if (Math.round(c.M[12 + a]) !== s) continue;
        let hc = -1;
        let hs = 0;
        for (let col = 0; col < 3; col++) {
          const v = Math.round(s * c.M[col * 4 + a]);
          if (v !== 0) { hc = col; hs = v; }
        }
        const color = c.home[hc] === hs ? `${hc},${hs}` : 'inner';
        if (seen === null) seen = color;
        else if (seen !== color) return false;
      }
    }
  }
  return true;
}

// ── 代號對照表（單一事實來源）──────────────────────────────────────────
// dir 是「該代號本身（不加 '）」在 rotMat() 裡對應的旋轉方向，也就是
// 「從該面正面看的順時針」。魔術方塊每面的『順時針』方向不能假設同號，
// 必須逐面驗證（同軸兩面從正面看方向相反）——這裡的每個 dir 都已用
// scripts/cube-engine.test.mjs 的行為鐵證測試（比對貼紙顏色跑到哪裡）反推校正過，
// 不是憑座標軸符號直接假設。CubeTimer.jsx 的按鈕／鍵盤／手動輸入解析全部
// 查這張表，不得另外硬寫 dir。
// M 方向跟隨 L（同軸同 dir）；x 跟隨 R；y 跟隨 U（WCA 慣例：x~R、y~U、z~F）。
export const MOVE_TABLE = {
  U: { letter: 'U', axis: 1, layer: -1, dir: -1 },
  D: { letter: 'D', axis: 1, layer: 1, dir: 1 },
  L: { letter: 'L', axis: 0, layer: -1, dir: -1 },
  R: { letter: 'R', axis: 0, layer: 1, dir: 1 },
  F: { letter: 'F', axis: 2, layer: 1, dir: 1 },
  B: { letter: 'B', axis: 2, layer: -1, dir: -1 },
  M: { letter: 'M', axis: 0, layer: 0, dir: -1 },
  x: { letter: 'x', axis: 0, layer: 'all', dir: 1 },
  y: { letter: 'y', axis: 1, layer: 'all', dir: -1 },
};

// U/D/L/R/F/B → {letter, axis, layer, dir}。CubeTimer.jsx 的鍵盤/按鈕與 genScramble 共用。
export const FACE_MOVES = ['U', 'D', 'L', 'R', 'F', 'B'].map((l) => MOVE_TABLE[l]);

// 可自訂排列的 7 個轉面格子（含 M，不含 x/y 翻面列）。
export const TILE_LETTERS = ['U', 'D', 'L', 'R', 'F', 'B', 'M'];
// 翻面（整顆換視角）：固定順序，不參與格子排序。
export const TWIST_LETTERS = ['x', 'y'];
// 給 CubeTimer 建立按鍵設定表用：9 個代號的完整定義。
export const ALL_MOVES = [...TILE_LETTERS, ...TWIST_LETTERS].map((l) => MOVE_TABLE[l]);

// 比賽式打亂：n 步 notation（一個 X2 算一步，但對應兩筆 quarter turn）。
// 規則：同一面不連續出現；1/3 機率正轉、1/3 逆轉（'）、1/3 雙轉（2）。只用六個基本面
// （U D L R F B），不含 M/x/y——WCA 比賽打亂譜本來就不含中層與整顆翻面。
export function genScramble(n = 15) {
  const moves = [];
  const tokens = [];
  let lastLetter = null;
  for (let i = 0; i < n; i++) {
    let face;
    do {
      face = FACE_MOVES[Math.floor(Math.random() * FACE_MOVES.length)];
    } while (face.letter === lastLetter);
    lastLetter = face.letter;

    const kind = Math.floor(Math.random() * 3); // 0 正轉 / 1 逆轉 / 2 雙轉
    if (kind === 0) {
      moves.push({ axis: face.axis, layer: face.layer, dir: face.dir });
      tokens.push(face.letter);
    } else if (kind === 1) {
      moves.push({ axis: face.axis, layer: face.layer, dir: -face.dir });
      tokens.push(`${face.letter}'`);
    } else {
      moves.push({ axis: face.axis, layer: face.layer, dir: face.dir });
      moves.push({ axis: face.axis, layer: face.layer, dir: face.dir });
      tokens.push(`${face.letter}2`);
    }
  }
  return { moves, notation: tokens.join(' ') };
}

// 反向序列：順序反過來、每一步方向反轉。
export function invertMoves(moves) {
  return moves.slice().reverse().map((m) => ({ axis: m.axis, layer: m.layer, dir: -m.dir }));
}

// ── 打亂譜解析（手動輸入）───────────────────────────────────────────────
// 全形字元正規化：Ｒ→R、ｘ→x、２→2 這類「全形 ASCII 區」(U+FF01–FF5E) 一律
// 用固定偏移量折回半形；再額外把常見全形/彎引號（＇’‘｀）折成半形撇號 '。
const FULLWIDTH_OFFSET = 0xFEE0;
function normalizeNotationChars(input) {
  let out = '';
  for (const ch of String(input)) {
    const code = ch.codePointAt(0);
    if (code >= 0xFF01 && code <= 0xFF5E) {
      out += String.fromCodePoint(code - FULLWIDTH_OFFSET);
    } else if (ch === '’' || ch === '‘' || ch === '`') {
      out += "'";
    } else if (ch === '　') {
      out += ' '; // 全形空白
    } else {
      out += ch;
    }
  }
  return out;
}

// 把使用者輸入的轉法譜文字轉成 moves + 正規化 tokens。
// 規則：token = 代號 + 可選 "'"（逆轉）或 "2"（雙轉，算一個顯示 token 但對應兩筆 quarter turn）。
// 大小寫都收：U/D/L/R/F/B/M 正規化為大寫，x/y 正規化為小寫。
// 成功回傳 { moves, tokens }；失敗回傳 { error: true, badToken }（badToken 為看不懂的原始 token）。
export function parseNotation(input) {
  const normalized = normalizeNotationChars(input == null ? '' : input);
  const rawTokens = normalized.trim().split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0) return { error: true, badToken: '' };

  const moves = [];
  const tokens = [];
  for (const raw of rawTokens) {
    const letterChar = raw[0] || '';
    const isTwist = letterChar === 'x' || letterChar === 'X' || letterChar === 'y' || letterChar === 'Y';
    const canonical = isTwist ? letterChar.toLowerCase() : letterChar.toUpperCase();
    const def = MOVE_TABLE[canonical];
    const suffix = raw.slice(1);
    if (!def || !['', "'", '2'].includes(suffix)) {
      return { error: true, badToken: raw };
    }
    if (suffix === '') {
      moves.push({ axis: def.axis, layer: def.layer, dir: def.dir });
      tokens.push(canonical);
    } else if (suffix === "'") {
      moves.push({ axis: def.axis, layer: def.layer, dir: -def.dir });
      tokens.push(`${canonical}'`);
    } else {
      moves.push({ axis: def.axis, layer: def.layer, dir: def.dir });
      moves.push({ axis: def.axis, layer: def.layer, dir: def.dir });
      tokens.push(`${canonical}2`);
    }
  }
  return { moves, tokens };
}

// ── 測試/查詢用純函式：貼紙顏色 ─────────────────────────────────────────
// 純邏輯層的顏色名稱對照（DOM 層另有一份十六進位色碼，見下方 FACE_COLORS）。
const FACE_COLOR_NAMES = {
  '1,-1': 'white', '1,1': 'yellow', '2,1': 'green', '2,-1': 'blue', '0,1': 'red', '0,-1': 'orange',
};

// 查某顆 cubie「目前」朝世界方向 (axis, sign) 的貼紙顏色。
// 回傳顏色名稱字串；若該面其實沒有貼紙（理論上不該發生在外層 cubie 上）回傳 'inner'；
// 若找不到任何對應（不應發生）回傳 null。
export function colorFacingWorld(cubie, axis, sign) {
  let hc = -1;
  let hs = 0;
  for (let col = 0; col < 3; col++) {
    const v = Math.round(sign * cubie.M[col * 4 + axis]);
    if (v !== 0) { hc = col; hs = v; }
  }
  if (hc === -1) return null;
  if (cubie.home[hc] !== hs) return 'inner';
  return FACE_COLOR_NAMES[`${hc},${hs}`] || null;
}

// 依「目前」位置（不是 home）找出某顆 cubie，供測試用。pos: {x,y,z} ∈ {-1,0,1}。
export function findCubieAtPosition(state, pos) {
  const want = [pos.x, pos.y, pos.z];
  return state.find((c) => want.every((v, a) => Math.round(c.M[12 + a]) === v)) || null;
}

// 計時器顯示格式：<60s 顯示 "12.34"；>=60s 顯示 "1:05.32"。
export function formatCubeTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  const totalCs = Math.round(value / 10);
  const cs = String(totalCs % 100).padStart(2, '0');
  const totalSec = Math.floor(totalCs / 100);
  if (totalSec < 60) return `${totalSec}.${cs}`;
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, '0');
  return `${min}:${sec}.${cs}`;
}

// ── DOM 渲染層 ────────────────────────────────────────────────────────

// 經典六色貼紙（key 為 "axis,sign"，對應 U/D/F/B/R/L）
const FACE_COLORS = {
  '1,-1': '#f4f5f7', // 白 · 上 U
  '1,1': '#ffd21e',  // 黃 · 下 D
  '2,1': '#2ba15c',  // 綠 · 前 F
  '2,-1': '#2d6cdf', // 藍 · 後 B
  '0,1': '#e5383f',  // 紅 · 右 R
  '0,-1': '#ff8c1a', // 橙 · 左 L
};

const FACE_TRANSFORMS = {
  '2,1': (half) => `translateZ(${half}px)`,
  '2,-1': (half) => `rotateY(180deg) translateZ(${half}px)`,
  '0,1': (half) => `rotateY(90deg) translateZ(${half}px)`,
  '0,-1': (half) => `rotateY(-90deg) translateZ(${half}px)`,
  '1,-1': (half) => `rotateX(90deg) translateZ(${half}px)`,
  '1,1': (half) => `rotateX(-90deg) translateZ(${half}px)`,
};

const STYLE_ID = 'dc-cube-engine-style';

function ensureStyleInjected() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .dc-stage{position:relative;touch-action:none;cursor:grab;overflow:hidden;}
    /* 容器尺寸由呼叫端決定（例如 Tailwind h-72）。這裡不可寫 height:100%——
       注入的 style 排在 Tailwind 之後，會蓋掉呼叫端的高度、在 auto 高父層下歸零。 */
    .dc-stage.dc-grabbing{cursor:grabbing;}
    .dc-scene{width:100%;height:100%;display:grid;place-items:center;perspective:1000px;}
    .dc-cube{position:relative;width:0;height:0;transform-style:preserve-3d;}
    .dc-cubie{position:absolute;transform-style:preserve-3d;}
    .dc-face{position:absolute;inset:0;background:#0b0c10;border-radius:6px;backface-visibility:hidden;}
    .dc-sticker{position:absolute;inset:3px;border-radius:6px;
      background-image:linear-gradient(155deg, rgba(255,255,255,.28) 0%, rgba(255,255,255,0) 42%, rgba(0,0,0,.10) 100%);}
  `;
  document.head.appendChild(style);
}

function toCssMatrix(M, S) {
  const out = M.slice();
  out[12] *= S;
  out[13] *= S;
  out[14] *= S;
  return `matrix3d(${out.join(',')})`;
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

export class CubeRenderer {
  constructor(container, { size = 60, onSolvedChange } = {}) {
    this.container = container;
    this.S = size;
    this.onSolvedChange = typeof onSolvedChange === 'function' ? onSolvedChange : () => {};
    this.state = createCubeState();
    this.queue = [];
    this.busy = false;
    this.rx = -26;
    this.ry = -34;
    this._rafId = null;
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;

    ensureStyleInjected();
    this._buildDom();
    this._renderAll();
    this._applyView();
    this._bindDrag();
  }

  _buildDom() {
    this.container.classList.add('dc-stage');
    this.container.innerHTML = '';

    const scene = document.createElement('div');
    scene.className = 'dc-scene';

    const cubeEl = document.createElement('div');
    cubeEl.className = 'dc-cube';
    this.cubeEl = cubeEl;

    const half = this.S / 2;
    this.els = this.state.map((c) => {
      const el = document.createElement('div');
      el.className = 'dc-cubie';
      el.style.width = `${this.S}px`;
      el.style.height = `${this.S}px`;
      el.style.left = `${-half}px`;
      el.style.top = `${-half}px`;

      Object.keys(FACE_TRANSFORMS).forEach((key) => {
        const [axisStr, signStr] = key.split(',');
        const axis = Number(axisStr);
        const sign = Number(signStr);
        const face = document.createElement('div');
        face.className = 'dc-face';
        face.style.transform = FACE_TRANSFORMS[key](half);
        if (c.home[axis] === sign) {
          const sticker = document.createElement('div');
          sticker.className = 'dc-sticker';
          sticker.style.backgroundColor = FACE_COLORS[key];
          // 白色中心（U 面正中央那顆）貼公司 logo：只有這一格，其他中心不動。
          if (key === '1,-1' && c.home[0] === 0 && c.home[1] === -1 && c.home[2] === 0) {
            sticker.style.backgroundImage = "url('/logo.png')";
            sticker.style.backgroundSize = '72% 72%';
            sticker.style.backgroundPosition = 'center';
            sticker.style.backgroundRepeat = 'no-repeat';
          }
          face.appendChild(sticker);
        }
        el.appendChild(face);
      });

      cubeEl.appendChild(el);
      return el;
    });

    scene.appendChild(cubeEl);
    this.container.appendChild(scene);
  }

  _renderAll() {
    this.state.forEach((c, i) => {
      this.els[i].style.transform = toCssMatrix(c.M, this.S);
    });
  }

  _applyView() {
    this.cubeEl.style.transform = `rotateX(${this.rx}deg) rotateY(${this.ry}deg)`;
  }

  _bindDrag() {
    this._onPointerDown = (e) => {
      if (e.target.closest && e.target.closest('button, input')) return;
      this._dragging = true;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this.container.classList.add('dc-grabbing');
      this.container.setPointerCapture?.(e.pointerId);
    };
    this._onPointerMove = (e) => {
      if (!this._dragging) return;
      this.ry += (e.clientX - this._lastX) * 0.42;
      this.rx -= (e.clientY - this._lastY) * 0.42;
      this.rx = Math.max(-85, Math.min(85, this.rx));
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this._applyView();
    };
    this._onPointerUp = () => {
      this._dragging = false;
      this.container.classList.remove('dc-grabbing');
    };
    this.container.addEventListener('pointerdown', this._onPointerDown);
    this.container.addEventListener('pointermove', this._onPointerMove);
    this.container.addEventListener('pointerup', this._onPointerUp);
    this.container.addEventListener('pointercancel', this._onPointerUp);
  }

  setView(rx, ry) {
    this.rx = rx;
    this.ry = ry;
    this._applyView();
  }

  // 轉一步，回傳 Promise；呼叫會排入佇列依序執行（rAF 動畫）。
  turn(move, durMs = 170) {
    return new Promise((resolve) => {
      this.queue.push({ move, dur: durMs, resolve });
      this._pump();
    });
  }

  // 快速連續套用一串打亂動作（依序、短時長動畫）。
  async applyScramble(moves) {
    for (const move of moves) {
      await this.turn(move, 90); // 打亂動作本來就要依序播放，故意逐步 await
    }
  }

  _pump() {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    const { move, dur, resolve } = this.queue.shift();
    this._execMove(move, dur, () => {
      this.busy = false;
      this.onSolvedChange(isSolvedState(this.state));
      resolve();
      this._pump();
    });
  }

  _execMove(move, dur, done) {
    const { axis, layer, dir } = move;
    const targets = [];
    this.state.forEach((c, i) => {
      if (layer === 'all' || Math.round(c.M[12 + axis]) === layer) targets.push(i);
    });
    const total = dir * (Math.PI / 2);

    const finish = () => {
      const R = rotMat(axis, total);
      targets.forEach((i) => {
        this.state[i].M = snap(mul(R, this.state[i].M));
        this.els[i].style.transform = toCssMatrix(this.state[i].M, this.S);
      });
      done();
    };

    if (!dur || dur <= 0) {
      finish();
      return;
    }

    const start = performance.now();
    const frame = (ts) => {
      const p = Math.min(1, (ts - start) / dur);
      const R = rotMat(axis, total * ease(p));
      targets.forEach((i) => {
        const tempM = mul(R, this.state[i].M);
        this.els[i].style.transform = toCssMatrix(tempM, this.S);
      });
      if (p < 1) {
        this._rafId = requestAnimationFrame(frame);
      } else {
        finish();
      }
    };
    this._rafId = requestAnimationFrame(frame);
  }

  // 直接歸位（不動畫），清掉佇列。
  reset() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.queue = [];
    this.busy = false;
    this.state = createCubeState();
    this._renderAll();
    this.onSolvedChange(true);
  }

  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.queue = [];
    if (this._onPointerDown) {
      this.container.removeEventListener('pointerdown', this._onPointerDown);
      this.container.removeEventListener('pointermove', this._onPointerMove);
      this.container.removeEventListener('pointerup', this._onPointerUp);
      this.container.removeEventListener('pointercancel', this._onPointerUp);
    }
    this.container.classList.remove('dc-stage', 'dc-grabbing');
    this.container.innerHTML = '';
  }
}
