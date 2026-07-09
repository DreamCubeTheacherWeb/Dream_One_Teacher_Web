// 方塊引擎純邏輯層測試（不含 DOM 層 CubeRenderer）。
// 執行：node scripts/cube-engine.test.mjs
import {
  createCubeState,
  applyTurnToState,
  isSolvedState,
  genScramble,
  invertMoves,
  MOVE_TABLE,
  parseNotation,
  colorFacingWorld,
  findCubieAtPosition,
} from '../src/lib/cubeEngine.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(name);
    console.error(`✗ FAIL: ${name}`);
  }
}

// 1) 新建 state 是 solved
{
  const state = createCubeState();
  assert('新建 state 是 solved', isSolvedState(state));
  assert('新建 state 有 27 顆 cubie', state.length === 27);
}

// 2) 轉一步後非 solved，反轉後恢復
{
  const state = createCubeState();
  applyTurnToState(state, { axis: 1, layer: -1, dir: 1 }); // U
  assert('轉一步後非 solved', !isSolvedState(state));
  applyTurnToState(state, { axis: 1, layer: -1, dir: -1 }); // U'
  assert('反轉後恢復 solved', isSolvedState(state));
}

// 3) 迴圈 100 次：genScramble(15) 套用 → 非 solved → invertMoves 套用 → solved
{
  let allOk = true;
  for (let i = 0; i < 100; i++) {
    const state = createCubeState();
    const { moves } = genScramble(15);
    for (const m of moves) applyTurnToState(state, m);
    if (isSolvedState(state)) { allOk = false; console.error(`第 ${i} 輪：打亂後竟然是 solved`); break; }
    const inv = invertMoves(moves);
    for (const m of inv) applyTurnToState(state, m);
    if (!isSolvedState(state)) { allOk = false; console.error(`第 ${i} 輪：反轉後沒有還原`); break; }
  }
  assert('100 次 scramble→invert 皆能正確還原', allOk);
}

// 4) notation 與 moves 陣列數量一致性（一個 X2 對應兩筆 quarter turn）
{
  let allOk = true;
  for (let i = 0; i < 30; i++) {
    const { moves, notation } = genScramble(15);
    const tokens = notation.split(' ').filter(Boolean);
    const expectedMoveCount = tokens.reduce((sum, t) => sum + (t.endsWith('2') ? 2 : 1), 0);
    if (tokens.length !== 15 || moves.length !== expectedMoveCount) {
      allOk = false;
      console.error(`第 ${i} 輪：tokens=${tokens.length} moves=${moves.length} expected=${expectedMoveCount}`);
      break;
    }
  }
  assert('genScramble 的 notation 與 moves 數量一致（含 X2 雙轉）', allOk);
}

// 5) 同一面不連續出現
{
  let allOk = true;
  for (let i = 0; i < 30; i++) {
    const { notation } = genScramble(15);
    const tokens = notation.split(' ').filter(Boolean);
    for (let j = 1; j < tokens.length; j++) {
      if (tokens[j][0] === tokens[j - 1][0]) {
        allOk = false;
        console.error(`第 ${i} 輪：${tokens.join(' ')} 有連續同面`);
        break;
      }
    }
    if (!allOk) break;
  }
  assert('同一面不連續出現', allOk);
}

// ═══════════════════════════════════════════════════════════════════
// 方向鐵證測試（2026-07-08 新增）：懂方塊的老師會盯著代號對方向，方向錯了
// 馬上穿幫。這五條直接比對「貼紙顏色跑到哪裡」，是唯一權威，不信任何 dir 假設。
// 配色：U=白 D=黃 F=綠 B=藍 R=紅 L=橙。
// ═══════════════════════════════════════════════════════════════════

// 6) R → F 面最右一直行變黃(D)，U 面最右一直行變綠(F)
{
  const state = createCubeState();
  applyTurnToState(state, MOVE_TABLE.R);
  const cF = findCubieAtPosition(state, { x: 1, y: 0, z: 1 });
  const cU = findCubieAtPosition(state, { x: 1, y: -1, z: 0 });
  assert('R：F 面最右直行變黃(D)', !!cF && colorFacingWorld(cF, 2, 1) === 'yellow');
  assert('R：U 面最右直行變綠(F)', !!cU && colorFacingWorld(cU, 1, -1) === 'green');
}

// 7) U → F 面最上一橫排變紅(R)
{
  const state = createCubeState();
  applyTurnToState(state, MOVE_TABLE.U);
  const cF = findCubieAtPosition(state, { x: 0, y: -1, z: 1 });
  assert('U：F 面最上橫排變紅(R)', !!cF && colorFacingWorld(cF, 2, 1) === 'red');
}

// 8) F → U 面最靠前一橫排變橙(L)
{
  const state = createCubeState();
  applyTurnToState(state, MOVE_TABLE.F);
  const cU = findCubieAtPosition(state, { x: 0, y: -1, z: 1 });
  assert('F：U 面最靠前橫排變橙(L)', !!cU && colorFacingWorld(cU, 1, -1) === 'orange');
}

// 6b/6c/6d) D/L/B 也各自直接驗證一次（非題目要求的 5 條，但同軸兩面方向相反，
// 不驗證容易在修正 U 之後漏了對稱面，故補上，鎖住迴歸）。
{
  const state = createCubeState();
  applyTurnToState(state, MOVE_TABLE.D);
  const c = findCubieAtPosition(state, { x: 0, y: 1, z: 1 });
  assert('D：F 面最下橫排變橙(L)', !!c && colorFacingWorld(c, 2, 1) === 'orange');
}
{
  const state = createCubeState();
  applyTurnToState(state, MOVE_TABLE.L);
  const c = findCubieAtPosition(state, { x: -1, y: 0, z: 1 });
  assert('L：F 面中間偏左變白(U)', !!c && colorFacingWorld(c, 2, 1) === 'white');
}
{
  const state = createCubeState();
  applyTurnToState(state, MOVE_TABLE.B);
  const c = findCubieAtPosition(state, { x: 0, y: -1, z: -1 });
  assert('B：U 面最靠後橫排變紅(R)', !!c && colorFacingWorld(c, 1, -1) === 'red');
}

// 9) M（跟隨 L）→ 前面中間一直行變白(U)
{
  const state = createCubeState();
  applyTurnToState(state, MOVE_TABLE.M);
  const cF = findCubieAtPosition(state, { x: 0, y: 0, z: 1 });
  assert('M：前面中間直行變白(U)', !!cF && colorFacingWorld(cF, 2, 1) === 'white');
}

// 10) x（跟隨 R）→ 前面整面變黃(D)，仍 solved；y（跟隨 U）→ 前面整面變紅(R)，仍 solved
{
  const state = createCubeState();
  applyTurnToState(state, MOVE_TABLE.x);
  const samples = [{ x: -1, y: -1, z: 1 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }];
  const allYellow = samples.every((p) => {
    const c = findCubieAtPosition(state, p);
    return !!c && colorFacingWorld(c, 2, 1) === 'yellow';
  });
  assert('x：前面整面變黃(D)', allYellow);
  assert('x：套用後仍是 solved', isSolvedState(state));
}
{
  const state = createCubeState();
  applyTurnToState(state, MOVE_TABLE.y);
  const samples = [{ x: -1, y: -1, z: 1 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }];
  const allRed = samples.every((p) => {
    const c = findCubieAtPosition(state, p);
    return !!c && colorFacingWorld(c, 2, 1) === 'red';
  });
  assert('y：前面整面變紅(R)', allRed);
  assert('y：套用後仍是 solved', isSolvedState(state));
}

// 11) M/x/y 反演測試：轉一次再轉反方向一次，回到 solved
for (const letter of ['M', 'x', 'y']) {
  const state = createCubeState();
  const def = MOVE_TABLE[letter];
  applyTurnToState(state, def);
  applyTurnToState(state, { axis: def.axis, layer: def.layer, dir: -def.dir });
  assert(`${letter} 反轉後還原`, isSolvedState(state));
}

// 12) M/x/y 連轉 4 次同方向 = 週期 4，回到 solved
for (const letter of ['M', 'x', 'y']) {
  const state = createCubeState();
  const def = MOVE_TABLE[letter];
  for (let i = 0; i < 4; i++) applyTurnToState(state, def);
  assert(`${letter} 連轉 4 次回到 solved`, isSolvedState(state));
}

// ═══════════════════════════════════════════════════════════════════
// parseNotation 測試
// ═══════════════════════════════════════════════════════════════════

// 13) 基本解析：大小寫、'、2、M/x/y
// 2026-07-09 升級：大小寫變得有語義（大寫 UDLRFB=外層／小寫 udlrfb=寬層），
// 這條原本斷言「r2 → R2」的舊行為已隨新規格改變——r2 現在正確應解析成 Rw2
// （小寫 r＝寬層），此為規格要求的刻意改動，非回歸。
{
  const r = parseNotation("r2 x X' m U");
  assert('parseNotation 基本解析成功', !r.error);
  if (!r.error) {
    assert('parseNotation tokens 正規化正確（小寫 r＝寬層 Rw）', r.tokens.join(' ') === "Rw2 x x' M U");
    assert('parseNotation moves 數量正確（Rw2 佔 2 筆）', r.moves.length === 6);
  }
}

// 14) 全形字元正規化：Ｒ Ｕ Ｒ’ Ｕ２
{
  const r = parseNotation('Ｒ Ｕ Ｒ’ Ｕ２');
  assert('parseNotation 全形輸入成功', !r.error);
  if (!r.error) {
    assert('parseNotation 全形正規化為 R U R\' U2', r.tokens.join(' ') === "R U R' U2");
  }
}

// 15) 錯誤代號：R Q → 錯誤且 badToken 含 Q
{
  const r = parseNotation('R Q');
  assert('parseNotation 遇到非法代號回傳 error', r.error === true);
  assert('parseNotation badToken 含 Q', r.badToken === 'Q');
}

// 16) 寬層寫法都收，一律正規化為 Rw 這種「大寫字母+小寫 w」形式
{
  const variants = ["Rw", "RW", "rw", "rW"];
  const allOk = variants.every((t) => {
    const r = parseNotation(t);
    return !r.error && r.tokens.join(' ') === 'Rw';
  });
  assert('parseNotation：Rw/RW/rw/rW 都正規化為 Rw', allOk);
}

// 17) M/E/S、x/y/z 大小寫都收，各自正規化為大寫/小寫
{
  const r1 = parseNotation('e S m');
  assert('parseNotation：e S m 正規化為 E S M', !r1.error && r1.tokens.join(' ') === 'E S M');
  const r2 = parseNotation("Z y' X");
  assert("parseNotation：Z y' X 正規化為 z y' x", !r2.error && r2.tokens.join(' ') === "z y' x");
}

// ═══════════════════════════════════════════════════════════════════
// 等價式測試（2026-07-09 新增）：新代號的方向唯一權威。用「兩序列分別從
// 還原態套用後全部 cubie 矩陣相等」比對，不信任何 dir 假設。九條全綠才算
// 方向正確；任何一條變紅代表 E/S/z/寬層的 MOVE_TABLE 方向定義錯了。
// ═══════════════════════════════════════════════════════════════════
function applySeq(defs) {
  // defs: [[letter, prime], ...]
  const state = createCubeState();
  for (const [letter, prime] of defs) {
    const def = MOVE_TABLE[letter];
    applyTurnToState(state, { axis: def.axis, layer: def.layer, dir: prime ? -def.dir : def.dir });
  }
  return state;
}
function statesEqual(a, b) {
  return a.length === b.length && a.every((c, i) => c.M.every((v, k) => v === b[i].M[k]));
}
const EQUIV_CASES = [
  ["x ≡ R M' L'", [['x', false]], [['R', false], ['M', true], ['L', true]]],
  ["y ≡ U E' D'", [['y', false]], [['U', false], ['E', true], ['D', true]]],
  ["z ≡ F S B'", [['z', false]], [['F', false], ['S', false], ['B', true]]],
  ["Rw ≡ R M'", [['Rw', false]], [['R', false], ['M', true]]],
  ['Lw ≡ L M', [['Lw', false]], [['L', false], ['M', false]]],
  ["Uw ≡ U E'", [['Uw', false]], [['U', false], ['E', true]]],
  ['Dw ≡ D E', [['Dw', false]], [['D', false], ['E', false]]],
  ['Fw ≡ F S', [['Fw', false]], [['F', false], ['S', false]]],
  ["Bw ≡ B S'", [['Bw', false]], [['B', false], ['S', true]]],
];
for (const [name, seqA, seqB] of EQUIV_CASES) {
  assert(name, statesEqual(applySeq(seqA), applySeq(seqB)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('失敗項目:', failures.join(', '));
  process.exit(1);
} else {
  console.log('全部 PASS ✓');
}
