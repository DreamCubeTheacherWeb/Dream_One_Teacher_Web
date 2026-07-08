import { useState, useEffect, useRef, useCallback } from 'react';
import { Timer as TimerIcon, AlertTriangle, KeyRound, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import {
    CubeRenderer, genScramble, formatCubeTime, isSolvedState, parseNotation,
    MOVE_TABLE, ALL_MOVES, TWIST_LETTERS,
} from '../lib/cubeEngine';

const HOLD_MS = 300;

const MODE_STORAGE_KEY = 'cube_mode';
const KEYMAP_STORAGE_KEY = 'cube_keymap_v2';
const OLD_KEYMAP_STORAGE_KEY = 'cube_keymap_v1';
const TILE_ORDER_STORAGE_KEY = 'cube_tile_order_v1';

// 預設格子排列（使用者拍板）：第一列 R F L、第二列 U D B、第三列 M。
// x/y 翻面固定另起一列，不參與排序。
const DEFAULT_TILE_ORDER = ['R', 'F', 'L', 'U', 'D', 'B', 'M'];

// 打亂編排器：token 上限（避免無限累加）。
const BUILDER_TOKEN_LIMIT = 40;

// 18 個轉面/翻面動作（U/D/L/R/F/B/M/x/y × 順轉/逆轉），衍生自 cubeEngine 的
// ALL_MOVES，保證與 3D 引擎的 axis/layer/dir 對照永遠一致（單一事實來源）。
// x/y 是整顆換視角（layer==='all'），不計步數；其餘（含 M）計步數。
const FACE_ACTIONS = ALL_MOVES.flatMap((m) => {
    const countsAsMove = m.layer !== 'all';
    return [
        { id: `${m.letter}_CW`, axis: m.axis, layer: m.layer, dir: m.dir, label: m.letter, countsAsMove },
        { id: `${m.letter}_CCW`, axis: m.axis, layer: m.layer, dir: -m.dir, label: `${m.letter}'`, countsAsMove },
    ];
});

const CONTROL_ACTIONS = ['startStop', 'pause', 'discard'];

const ACTION_LABELS = {
    ...Object.fromEntries(FACE_ACTIONS.map((a) => [a.id, a.label])),
    startStop: '起錶／停錶',
    pause: '暫停／繼續',
    discard: '放棄',
};

// 預設鍵位（csTimer 精神）：轉面＝代號字母鍵，Shift＝反轉；
// 起錶／停錶＝Space；暫停＝P；放棄＝Esc。
const DEFAULT_KEYMAP = {
    U_CW: { code: 'KeyU', shift: false }, U_CCW: { code: 'KeyU', shift: true },
    D_CW: { code: 'KeyD', shift: false }, D_CCW: { code: 'KeyD', shift: true },
    L_CW: { code: 'KeyL', shift: false }, L_CCW: { code: 'KeyL', shift: true },
    R_CW: { code: 'KeyR', shift: false }, R_CCW: { code: 'KeyR', shift: true },
    F_CW: { code: 'KeyF', shift: false }, F_CCW: { code: 'KeyF', shift: true },
    B_CW: { code: 'KeyB', shift: false }, B_CCW: { code: 'KeyB', shift: true },
    M_CW: { code: 'KeyM', shift: false }, M_CCW: { code: 'KeyM', shift: true },
    x_CW: { code: 'KeyX', shift: false }, x_CCW: { code: 'KeyX', shift: true },
    y_CW: { code: 'KeyY', shift: false }, y_CCW: { code: 'KeyY', shift: true },
    startStop: { code: 'Space', shift: false },
    pause: { code: 'KeyP', shift: false },
    discard: { code: 'Escape', shift: false },
};

const ALL_KEYMAP_IDS = [...FACE_ACTIONS.map((a) => a.id), ...CONTROL_ACTIONS];

function loadModeFromStorage() {
    try {
        const raw = localStorage.getItem(MODE_STORAGE_KEY);
        return raw === 'physical' ? 'physical' : 'virtual';
    } catch {
        return 'virtual';
    }
}

function isValidBinding(v) {
    return !!v && typeof v.code === 'string' && typeof v.shift === 'boolean';
}

// 讀鍵位設定：v2 存在且完整就直接用；否則嘗試從 v1 遷移（保留舊有綁定、新動作
// 補預設）；都沒有或資料壞掉就回全預設。存檔一律寫回 v2。
function loadKeymapFromStorage() {
    try {
        const raw = localStorage.getItem(KEYMAP_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (ALL_KEYMAP_IDS.every((id) => isValidBinding(parsed?.[id]))) return parsed;
            return { ...DEFAULT_KEYMAP };
        }
        const oldRaw = localStorage.getItem(OLD_KEYMAP_STORAGE_KEY);
        if (oldRaw) {
            const oldParsed = JSON.parse(oldRaw);
            const merged = {};
            for (const id of ALL_KEYMAP_IDS) {
                merged[id] = isValidBinding(oldParsed?.[id]) ? oldParsed[id] : DEFAULT_KEYMAP[id];
            }
            return merged;
        }
        return { ...DEFAULT_KEYMAP };
    } catch {
        return { ...DEFAULT_KEYMAP };
    }
}

// 讀格子排列：驗證元素齊全（7 個代號各恰好一次），不齊就回預設。
function loadTileOrderFromStorage() {
    try {
        const raw = localStorage.getItem(TILE_ORDER_STORAGE_KEY);
        if (!raw) return [...DEFAULT_TILE_ORDER];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length !== DEFAULT_TILE_ORDER.length) return [...DEFAULT_TILE_ORDER];
        const set = new Set(parsed);
        if (set.size !== DEFAULT_TILE_ORDER.length || !DEFAULT_TILE_ORDER.every((l) => set.has(l))) {
            return [...DEFAULT_TILE_ORDER];
        }
        return parsed;
    } catch {
        return [...DEFAULT_TILE_ORDER];
    }
}

// 螢幕按鈕區預設展開狀態：觸控裝置（粗指標）預設展開，滑鼠桌機預設收合
// （桌機多半用鍵盤操作，收合減少視覺雜訊）。
function loadFaceSectionDefault() {
    try {
        return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    } catch {
        return false;
    }
}

function codeToLabel(code) {
    if (!code) return '?';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Arrow')) return code.slice(5);
    if (code === 'Space') return 'Space';
    if (code === 'Escape') return 'Esc';
    return code;
}

function keyLabel(binding) {
    if (!binding) return '未設定';
    const base = codeToLabel(binding.code);
    return binding.shift ? `Shift + ${base}` : base;
}

// 平均去頭尾：去掉最快、最慢各 1 筆，其餘取平均（Ao5/Ao12 共用同一邏輯）。
function trimmedAverage(times) {
    if (times.length < 3) return null;
    const sorted = [...times].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    const sum = trimmed.reduce((s, v) => s + v, 0);
    return sum / trimmed.length;
}

function computeAoN(recentRowsDesc, n) {
    if (recentRowsDesc.length < n) return null;
    return trimmedAverage(recentRowsDesc.slice(0, n).map((r) => r.time_ms));
}

// 打亂編排器：把最後一個 token 的字尾在「無 / 2」之間切換（'2' 修飾鍵）。
function toggleTwoSuffix(token) {
    const base = token.replace(/2$/, '').replace(/'$/, '');
    return token.endsWith('2') ? base : `${base}2`;
}

// 打亂編排器：把最後一個 token 的字尾在「無 / '」之間切換（' 修飾鍵）。
function toggleApostropheSuffix(token) {
    const base = token.replace(/2$/, '').replace(/'$/, '');
    return token.endsWith("'") ? base : `${base}'`;
}

// ── 模組層小元件（避免每次 render 重建，符合 react-hooks/static-components）──
const ModeButton = ({ active, onClick, testId, children }) => (
    <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${
            active ? 'bg-slate-900 text-white shadow-sm' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:text-slate-700'
        }`}
    >
        {children}
    </button>
);

const KeyRow = ({ label, binding, capturing, onStart, testId }) => (
    <button
        type="button"
        onClick={onStart}
        data-testid={testId}
        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-sm font-bold font-mono transition-colors ${
            capturing ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
        }`}
    >
        <span>{label}</span>
        <kbd className="px-2 py-0.5 rounded-md bg-white border border-slate-300 text-xs font-mono text-slate-500">
            {capturing ? '請按新按鍵…' : keyLabel(binding)}
        </kbd>
    </button>
);

const StatTile = ({ label, value, testId }) => (
    <div className="text-center px-2 py-3 rounded-2xl bg-slate-50" data-testid={testId}>
        <div className="text-[11px] text-slate-400 font-bold mb-1">{label}</div>
        <div className="text-base sm:text-lg font-mono font-black text-slate-800 truncate">{value}</div>
    </div>
);

const CubeTimer = () => {
    const { user } = useAuth();

    const stageRef = useRef(null);
    const rendererRef = useRef(null);

    const phaseRef = useRef('idle'); // idle | armed | running | paused | stopped
    const readyRef = useRef(false);
    const moveCountRef = useRef(0);
    const segmentStartRef = useRef(0);
    const accumulatedRef = useRef(0);
    const rafRef = useRef(null);
    const armTimeoutRef = useRef(null);
    const scrambleTokensRef = useRef([]);
    const scramblingRef = useRef(false);
    const capturingRef = useRef(null);

    const [scrambleTokens, setScrambleTokens] = useState([]);
    const [scrambling, setScrambling] = useState(false);
    const [ready, setReady] = useState(false);
    const [phase, setPhase] = useState('idle');
    const [displayMs, setDisplayMs] = useState(0);
    const [moveCount, setMoveCount] = useState(0);
    const [cubeSolved, setCubeSolved] = useState(true);

    const [customPanelOpen, setCustomPanelOpen] = useState(false);
    const [builderTokens, setBuilderTokens] = useState([]);
    const [builderError, setBuilderError] = useState('');

    const [mode, setMode] = useState(() => loadModeFromStorage());
    const modeRef = useRef(mode);
    const [modeSwitchWarning, setModeSwitchWarning] = useState('');

    const [keymap, setKeymap] = useState(() => loadKeymapFromStorage());
    const keymapRef = useRef(keymap);
    const [keySettingsOpen, setKeySettingsOpen] = useState(false);
    const [capturingAction, setCapturingAction] = useState(null);
    const [conflictMsg, setConflictMsg] = useState('');

    const [tileOrder, setTileOrder] = useState(() => loadTileOrderFromStorage());
    const [faceSectionOpen, setFaceSectionOpen] = useState(() => loadFaceSectionDefault());

    const [lastResult, setLastResult] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [submitted, setSubmitted] = useState(false);

    const [leaderboard, setLeaderboard] = useState([]);
    const [leaderboardState, setLeaderboardState] = useState('loading'); // loading | ok | unavailable | error
    const [myBest, setMyBest] = useState(null);
    const [myRecent, setMyRecent] = useState([]);
    const [myCount, setMyCount] = useState(null);
    const [myStatsState, setMyStatsState] = useState('loading');

    const setPhaseBoth = useCallback((next) => {
        phaseRef.current = next;
        setPhase(next);
    }, []);

    const setReadyBoth = useCallback((next) => {
        readyRef.current = next;
        setReady(next);
    }, []);

    const setModeBoth = useCallback((next) => {
        modeRef.current = next;
        setMode(next);
    }, []);

    const setCapturingBoth = useCallback((next) => {
        capturingRef.current = next;
        setCapturingAction(next);
    }, []);

    // ── localStorage 持久化 ───────────────────────────────────────────
    useEffect(() => {
        try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* 私密模式等情況忽略 */ }
    }, [mode]);

    useEffect(() => {
        keymapRef.current = keymap;
        try { localStorage.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(keymap)); } catch { /* 忽略 */ }
    }, [keymap]);

    useEffect(() => {
        try { localStorage.setItem(TILE_ORDER_STORAGE_KEY, JSON.stringify(tileOrder)); } catch { /* 忽略 */ }
    }, [tileOrder]);

    // ── 計時流程（分段累計，支援暫停/繼續）────────────────────────────
    const startTick = useCallback(() => {
        const tick = () => {
            setDisplayMs(accumulatedRef.current + (performance.now() - segmentStartRef.current));
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
    }, []);

    const startRunning = useCallback(() => {
        setPhaseBoth('running');
        setReadyBoth(false);
        moveCountRef.current = 0;
        setMoveCount(0);
        accumulatedRef.current = 0;
        segmentStartRef.current = performance.now();
        setDisplayMs(0);
        startTick();
    }, [setPhaseBoth, setReadyBoth, startTick]);

    const armStart = useCallback(() => {
        // 實體計時不必先打亂即可起錶；鍵盤模式仍需打亂完成（ready）才能起錶。
        if (modeRef.current === 'virtual' && !readyRef.current) return;
        if (phaseRef.current !== 'idle' && phaseRef.current !== 'stopped') return;
        if (armTimeoutRef.current) return;
        armTimeoutRef.current = setTimeout(() => {
            armTimeoutRef.current = null;
            setPhaseBoth('armed');
        }, HOLD_MS);
    }, [setPhaseBoth]);

    const releaseStart = useCallback(() => {
        if (armTimeoutRef.current) {
            clearTimeout(armTimeoutRef.current);
            armTimeoutRef.current = null;
            return;
        }
        if (phaseRef.current === 'armed') {
            startRunning();
        }
    }, [startRunning]);

    const stopTimer = useCallback(() => {
        if (phaseRef.current !== 'running') return;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        const elapsed = accumulatedRef.current + (performance.now() - segmentStartRef.current);
        setPhaseBoth('stopped');
        setDisplayMs(elapsed);
        setLastResult({
            timeMs: Math.max(1, Math.round(elapsed)),
            moveCount: modeRef.current === 'physical' ? null : moveCountRef.current,
            scramble: scrambleTokensRef.current.join(' '),
            mode: modeRef.current,
        });
        setSubmitted(false);
        setSubmitError('');
    }, [setPhaseBoth]);

    const togglePause = useCallback(() => {
        if (phaseRef.current === 'running') {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            accumulatedRef.current += performance.now() - segmentStartRef.current;
            setDisplayMs(accumulatedRef.current);
            setPhaseBoth('paused');
        } else if (phaseRef.current === 'paused') {
            segmentStartRef.current = performance.now();
            setPhaseBoth('running');
            startTick();
        }
    }, [setPhaseBoth, startTick]);

    // countsAsMove：x/y 是整顆換視角（握法變了，不是轉層），不計步數；其餘（含 M）計步數。
    const handleFaceTurn = useCallback((axis, layer, dir, countsAsMove = true) => {
        if (modeRef.current === 'physical') return; // 實體模式鍵盤/按鈕轉面不作用
        const renderer = rendererRef.current;
        if (!renderer) return;
        if (phaseRef.current === 'running') {
            if (countsAsMove) {
                moveCountRef.current += 1;
                setMoveCount(moveCountRef.current);
            }
            renderer.turn({ axis, layer, dir }, 170);
            return;
        }
        // 打亂動畫中／打亂完成等待起錶／按住準備中／暫停中 → 鎖定，防止偷解或偷轉
        if (scramblingRef.current || readyRef.current || phaseRef.current === 'armed' || phaseRef.current === 'paused') return;
        // 其餘（尚未打亂、或成績已出爐）開放自由玩，不計步數
        renderer.turn({ axis, layer, dir }, 170);
    }, []);

    const abortCurrent = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        if (armTimeoutRef.current) {
            clearTimeout(armTimeoutRef.current);
            armTimeoutRef.current = null;
        }
        accumulatedRef.current = 0;
        moveCountRef.current = 0;
        setMoveCount(0);
        setDisplayMs(0);
        setLastResult(null);
        setSubmitted(false);
        setSubmitError('');
        setPhaseBoth('idle');
        setReadyBoth(false);
        setScrambleTokens([]);
        scrambleTokensRef.current = [];
        rendererRef.current?.reset();
    }, [setPhaseBoth, setReadyBoth]);

    // ── 排行榜 / 個人紀錄（依模式過濾）─────────────────────────────────
    const loadLeaderboard = useCallback(async (modeArg) => {
        setLeaderboardState('loading');
        try {
            const { data, error } = await supabase.rpc('get_cube_leaderboard', { p_mode: modeArg });
            if (error) {
                if (error.code === '42883' || error.code === '42P01') {
                    setLeaderboardState('unavailable');
                    return;
                }
                throw error;
            }
            setLeaderboard(data || []);
            setLeaderboardState('ok');
        } catch (err) {
            console.error('Cube leaderboard load failed:', err);
            setLeaderboardState('error');
        }
    }, []);

    const loadMyStats = useCallback(async (modeArg) => {
        if (!user) return;
        setMyStatsState('loading');
        try {
            const [recentRes, bestRes] = await Promise.all([
                supabase.from('cube_solves').select('id,time_ms,move_count,created_at', { count: 'exact' }).eq('mode', modeArg).order('created_at', { ascending: false }).limit(12),
                supabase.from('cube_solves').select('time_ms').eq('mode', modeArg).order('time_ms', { ascending: true }).limit(1),
            ]);
            if (recentRes.error) throw recentRes.error;
            if (bestRes.error) throw bestRes.error;
            setMyRecent(recentRes.data || []);
            setMyCount(typeof recentRes.count === 'number' ? recentRes.count : (recentRes.data ? recentRes.data.length : null));
            setMyBest(bestRes.data && bestRes.data[0] ? bestRes.data[0].time_ms : null);
            setMyStatsState('ok');
        } catch (err) {
            if (err.code === '42P01') {
                setMyStatsState('unavailable');
            } else {
                console.error('Cube my-stats load failed:', err);
                setMyStatsState('error');
            }
        }
    }, [user]);

    // ── 打亂（隨機 / 打亂編排器）/ 送出 / 放棄 / 模式切換 ────────────────
    const resetForNewScramble = useCallback(() => {
        scramblingRef.current = true;
        setScrambling(true);
        setReadyBoth(false);
        setPhaseBoth('idle');
        setLastResult(null);
        setSubmitted(false);
        setSubmitError('');
        setBuilderError('');
        moveCountRef.current = 0;
        setMoveCount(0);
        setDisplayMs(0);
        accumulatedRef.current = 0;
    }, [setPhaseBoth, setReadyBoth]);

    const handleNewScramble = useCallback(async () => {
        resetForNewScramble();

        const { moves, notation } = genScramble(15);
        const tokens = notation.split(' ');
        scrambleTokensRef.current = tokens;
        setScrambleTokens(tokens);

        const renderer = rendererRef.current;
        if (renderer) {
            renderer.reset();
            await renderer.applyScramble(moves);
        }

        scramblingRef.current = false;
        setScrambling(false);
        setReadyBoth(true);
    }, [resetForNewScramble, setReadyBoth]);

    // 再來一場：鍵盤模式自動重新打亂（直接進 ready）；實體模式回到可隨時按住起錶的狀態。
    const handleAgain = useCallback(async () => {
        abortCurrent();
        if (modeRef.current === 'virtual') {
            await handleNewScramble();
        }
    }, [abortCurrent, handleNewScramble]);

    const handleBuilderApply = useCallback(async () => {
        if (builderTokens.length === 0) return;
        const parsed = parseNotation(builderTokens.join(' '));
        if (parsed.error) {
            setBuilderError(`看不懂的代號：${parsed.badToken || '（空白）'}`);
            return;
        }

        resetForNewScramble();

        const renderer = rendererRef.current;
        if (renderer) {
            renderer.reset();
            await renderer.applyScramble(parsed.moves);
        }

        scramblingRef.current = false;
        setScrambling(false);

        if (renderer && isSolvedState(renderer.state)) {
            setScrambleTokens([]);
            scrambleTokensRef.current = [];
            setBuilderError('這組打亂沒有改變方塊狀態');
            return;
        }

        scrambleTokensRef.current = parsed.tokens;
        setScrambleTokens(parsed.tokens);
        setReadyBoth(true);
    }, [builderTokens, resetForNewScramble, setReadyBoth]);

    // ── 打亂編排器：按鈕排出打亂譜（取代文字輸入框）───────────────────
    const appendBuilderToken = useCallback((letter) => {
        setBuilderError('');
        setBuilderTokens((prev) => (prev.length >= BUILDER_TOKEN_LIMIT ? prev : [...prev, letter]));
    }, []);

    const applyApostrophe = useCallback(() => {
        setBuilderError('');
        setBuilderTokens((prev) => {
            if (prev.length === 0) return prev;
            const arr = prev.slice();
            arr[arr.length - 1] = toggleApostropheSuffix(arr[arr.length - 1]);
            return arr;
        });
    }, []);

    const applyTwo = useCallback(() => {
        setBuilderError('');
        setBuilderTokens((prev) => {
            if (prev.length === 0) return prev;
            const arr = prev.slice();
            arr[arr.length - 1] = toggleTwoSuffix(arr[arr.length - 1]);
            return arr;
        });
    }, []);

    const backspaceToken = useCallback(() => {
        setBuilderError('');
        setBuilderTokens((prev) => prev.slice(0, -1));
    }, []);

    const clearBuilderTokens = useCallback(() => {
        setBuilderError('');
        setBuilderTokens([]);
    }, []);

    const handleModeChange = useCallback((next) => {
        if (next === modeRef.current) return;
        if (phaseRef.current === 'running' || phaseRef.current === 'paused' || phaseRef.current === 'armed') {
            setModeSwitchWarning('請先結束或放棄本次計時，才能切換模式。');
            return;
        }
        setModeSwitchWarning('');
        setModeBoth(next);
        setLastResult(null);
        setSubmitted(false);
        setSubmitError('');
        setScrambleTokens([]);
        scrambleTokensRef.current = [];
        setBuilderTokens([]);
        setBuilderError('');
        setReadyBoth(false);
        setDisplayMs(0);
        rendererRef.current?.reset();
    }, [setModeBoth, setReadyBoth]);

    const handleSubmit = useCallback(async () => {
        if (!lastResult) return;
        setSubmitting(true);
        setSubmitError('');
        try {
            const { error } = await supabase.from('cube_solves').insert({
                time_ms: lastResult.timeMs,
                move_count: lastResult.moveCount,
                scramble: lastResult.scramble || null,
                mode: lastResult.mode,
            });
            if (error) throw error;
            setSubmitted(true);
            loadLeaderboard(lastResult.mode);
            loadMyStats(lastResult.mode);
        } catch (err) {
            console.error('Cube solve submit failed:', err);
            if (err.code === '42P01') {
                setSubmitError('成績上傳功能待資料庫更新後開放。');
            } else {
                setSubmitError(`送出失敗：${err.message || '未知錯誤'}`);
            }
        } finally {
            setSubmitting(false);
        }
    }, [lastResult, loadLeaderboard, loadMyStats]);

    // ── 按鍵設定：綁定 / 衝突檢查 / 恢復預設 ──────────────────────────
    const rebindAction = useCallback((actionId, binding) => {
        const conflictEntry = Object.entries(keymapRef.current).find(
            ([id, b]) => id !== actionId && b.code === binding.code && b.shift === binding.shift
        );
        if (conflictEntry) {
            setConflictMsg(`此鍵已被「${ACTION_LABELS[conflictEntry[0]]}」使用`);
            return;
        }
        setConflictMsg('');
        setKeymap((prev) => ({ ...prev, [actionId]: binding }));
    }, []);

    const resetKeymap = useCallback(() => {
        setKeymap({ ...DEFAULT_KEYMAP });
        setConflictMsg('');
        setCapturingBoth(null);
    }, [setCapturingBoth]);

    const startCapture = useCallback((actionId) => {
        setConflictMsg('');
        setCapturingBoth(actionId);
    }, [setCapturingBoth]);

    // ── 按鈕排列：↔ 交換相鄰位置 ────────────────────────────────────
    const moveTile = useCallback((letter, dir) => {
        setTileOrder((prev) => {
            const idx = prev.indexOf(letter);
            const next = idx + dir;
            if (idx === -1 || next < 0 || next >= prev.length) return prev;
            const arr = prev.slice();
            [arr[idx], arr[next]] = [arr[next], arr[idx]];
            return arr;
        });
    }, []);

    // ── 初始化 3D 方塊渲染器 ───────────────────────────────────────────
    useEffect(() => {
        if (!stageRef.current) return undefined;
        const renderer = new CubeRenderer(stageRef.current, {
            size: 42,
            onSolvedChange: (isSolved) => {
                setCubeSolved(isSolved);
                if (isSolved) stopTimer();
            },
        });
        rendererRef.current = renderer;
        return () => {
            renderer.destroy();
            rendererRef.current = null;
        };
    }, [stopTimer]);

    // ── 鍵盤：依自訂 keymap 判斷動作（起錶/停錶/暫停/放棄/轉面）─────────
    useEffect(() => {
        const onKeyDown = (e) => {
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            if (capturingRef.current) {
                e.preventDefault();
                const actionId = capturingRef.current;
                setCapturingBoth(null);
                if (e.code === 'Escape') return; // 取消擷取，不綁定
                rebindAction(actionId, { code: e.code, shift: e.shiftKey });
                return;
            }

            const km = keymapRef.current;
            const matches = (id) => {
                const b = km[id];
                return !!b && b.code === e.code && b.shift === e.shiftKey;
            };

            if (matches('discard')) {
                e.preventDefault();
                if (!e.repeat && (phaseRef.current === 'running' || phaseRef.current === 'paused')) {
                    abortCurrent();
                }
                return;
            }
            if (matches('pause')) {
                e.preventDefault();
                if (!e.repeat) togglePause();
                return;
            }
            if (matches('startStop')) {
                e.preventDefault();
                if (e.repeat) return;
                if (phaseRef.current === 'running') {
                    if (modeRef.current === 'physical') stopTimer();
                    return;
                }
                armStart();
                return;
            }
            if (modeRef.current === 'virtual') {
                const faceAction = FACE_ACTIONS.find((a) => matches(a.id));
                if (faceAction) {
                    e.preventDefault();
                    handleFaceTurn(faceAction.axis, faceAction.layer, faceAction.dir, faceAction.countsAsMove);
                }
            }
        };
        const onKeyUp = (e) => {
            if (capturingRef.current) return;
            const b = keymapRef.current.startStop;
            if (b && b.code === e.code) {
                e.preventDefault();
                releaseStart();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, [armStart, releaseStart, handleFaceTurn, togglePause, abortCurrent, stopTimer, rebindAction, setCapturingBoth]);

    // ── 離開頁面清計時器 ────────────────────────────────────────────
    useEffect(() => () => {
        if (armTimeoutRef.current) clearTimeout(armTimeoutRef.current);
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
    }, []);

    // ── 排行榜 / 個人紀錄：首次載入＋模式切換時重新載入 ─────────────────
    useEffect(() => {
        loadLeaderboard(mode);
        loadMyStats(mode);
    }, [mode, loadLeaderboard, loadMyStats]);

    const isVirtual = mode === 'virtual';
    const scrambleBusy = scrambling || phase === 'running' || phase === 'armed' || phase === 'paused';
    // 螢幕轉面鍵的鎖定條件：與 handleFaceTurn 的鍵盤閘門一致——
    // 打亂中／等待起錶／按住準備／暫停中鎖定；計時中與自由玩（未打亂、成績出爐後）可按。
    const turnButtonsDisabled = scrambling || ready || phase === 'armed' || phase === 'paused';
    const ao5 = computeAoN(myRecent, 5);
    const ao12 = computeAoN(myRecent, 12);
    const legendMoveKeys = [...tileOrder, ...TWIST_LETTERS].map((l) => keyLabel(keymap[`${l}_CW`])).join(' ');
    const legendText = `起錶／停錶 ${keyLabel(keymap.startStop)}・暫停 ${keyLabel(keymap.pause)}・放棄 ${keyLabel(keymap.discard)}`
        + (isVirtual ? `・轉面 ${legendMoveKeys}（Shift 反轉）` : '');

    // ── 狀態 pill（整齊／已打亂／計時中／已暫停）────────────────────────
    const cubeStatusLabel = phase === 'running' ? '計時中' : phase === 'paused' ? '已暫停' : cubeSolved ? '整齊' : '已打亂';
    const cubeStatusClasses = {
        計時中: 'bg-blue-100 text-blue-700',
        已暫停: 'bg-amber-100 text-amber-700',
        已打亂: 'bg-orange-100 text-orange-700',
        整齊: 'bg-slate-100 text-slate-500',
    }[cubeStatusLabel];

    // ── 單一主行動按鈕：永遠告訴使用者下一步 ─────────────────────────────
    const primaryMode = phase === 'stopped'
        ? 'stopped'
        : phase === 'paused'
            ? 'paused'
            : phase === 'running'
                ? 'running'
                : (isVirtual && !ready)
                    ? 'needScramble'
                    : 'hold'; // phase idle/armed 且（虛擬已 ready 或 實體不需 ready）

    let primaryLabel = '';
    let primaryColorClass = 'bg-blue-600 hover:bg-blue-700';
    let primaryHandlers = {};
    let primaryDisabled = false;
    let secondaryLabel = null;
    let secondaryColorClass = 'bg-slate-100 text-slate-700 hover:bg-slate-200';
    let secondaryHandlers = {};

    if (primaryMode === 'needScramble') {
        primaryLabel = scrambling ? '打亂中…' : '🎲 打亂';
        primaryHandlers = { onClick: handleNewScramble };
        primaryDisabled = scrambleBusy;
    } else if (primaryMode === 'hold') {
        primaryLabel = phase === 'armed' ? '放開開始！' : '按住準備・放開開始';
        primaryColorClass = phase === 'armed' ? 'bg-emerald-500' : 'bg-blue-600 hover:bg-blue-700';
        primaryHandlers = {
            onPointerDown: (e) => { e.preventDefault(); armStart(); },
            onPointerUp: releaseStart,
            onPointerLeave: releaseStart,
        };
        if (!isVirtual) {
            secondaryLabel = '🎲 打亂';
            secondaryHandlers = { onClick: handleNewScramble };
            secondaryColorClass = 'bg-slate-100 text-slate-700 hover:bg-slate-200';
        }
    } else if (primaryMode === 'running') {
        if (isVirtual) {
            primaryLabel = '⏸ 暫停';
            primaryHandlers = { onClick: togglePause };
            secondaryLabel = '✕ 放棄';
            secondaryHandlers = { onClick: abortCurrent };
            secondaryColorClass = 'bg-red-50 text-red-600 hover:bg-red-100';
        } else {
            primaryLabel = '■ 停錶';
            primaryColorClass = 'bg-red-600 hover:bg-red-700';
            primaryHandlers = { onClick: stopTimer };
            secondaryLabel = '⏸ 暫停';
            secondaryHandlers = { onClick: togglePause };
        }
    } else if (primaryMode === 'paused') {
        primaryLabel = '▶ 繼續';
        primaryHandlers = { onClick: togglePause };
        secondaryLabel = '✕ 放棄';
        secondaryHandlers = { onClick: abortCurrent };
        secondaryColorClass = 'bg-red-50 text-red-600 hover:bg-red-100';
    } else if (primaryMode === 'stopped') {
        if (submitted) {
            primaryLabel = '🎲 再來一場';
            primaryHandlers = { onClick: handleAgain };
        } else {
            primaryLabel = submitting ? '送出中…' : '送出成績';
            primaryHandlers = { onClick: handleSubmit };
            primaryDisabled = submitting;
            secondaryLabel = '🎲 再來一場';
            secondaryHandlers = { onClick: handleAgain };
        }
    }

    const statusText = phase === 'paused'
        ? '已暫停，按繼續鍵恢復'
        : phase === 'running'
            ? (isVirtual ? `步數 ${moveCount}` : '解開後按「■ 停錶」結束')
            : phase === 'stopped'
                ? (submitted ? '已送出，可以再來一場' : '確認成績：送出或不算重來')
                : primaryMode === 'needScramble'
                    ? '請先打亂才能開始計時'
                    : `按住主按鈕（或鍵盤「${keyLabel(keymap.startStop)}」）0.3 秒準備，放開開始`;

    return (
        <div className="p-4 sm:p-8 max-w-4xl mx-auto" data-cube-phase={phase} data-cube-mode={mode}>
            <div className="mb-5">
                <h1 className="text-2xl sm:text-3xl font-black text-slate-900 flex items-center gap-2">
                    <TimerIcon className="w-7 h-7 text-blue-600" />
                    方塊競速
                </h1>
                <p className="text-slate-500 text-sm mt-1">打亂、計時、解開，跟其他老師比比看。</p>
            </div>

            {/* 模式切換 */}
            <section className="mb-5">
                <div className="flex gap-2 bg-slate-100 rounded-2xl p-1.5">
                    <ModeButton active={isVirtual} onClick={() => handleModeChange('virtual')} testId="cube-mode-virtual">
                        鍵盤模式<span className="hidden sm:inline">・虛擬方塊</span>
                    </ModeButton>
                    <ModeButton active={!isVirtual} onClick={() => handleModeChange('physical')} testId="cube-mode-physical">
                        實體計時<span className="hidden sm:inline">・自己的方塊</span>
                    </ModeButton>
                </div>
                {modeSwitchWarning && (
                    <p className="text-sm text-amber-600 mt-2 flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        {modeSwitchWarning}
                    </p>
                )}
                <p className="text-xs text-slate-400 mt-2">
                    {isVirtual ? '打亂虛擬方塊，用鍵盤轉面解開，自動計時。' : '拿你自己的實體方塊計時，畫面只是打亂示意，轉面請用手轉。'}
                </p>
            </section>

            {/* 主遊戲卡：打亂列＋3D 舞台＋計時器 hero 整合成一張卡 */}
            <section className="bg-white rounded-3xl border border-slate-200 shadow-sm p-4 sm:p-6 mb-6" data-testid="cube-game-card">
                {/* A. 打亂列 */}
                <div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            data-testid="cube-scramble-random"
                            onClick={handleNewScramble}
                            disabled={scrambleBusy}
                            className="px-4 py-2.5 min-h-[44px] rounded-xl bg-slate-900 text-white text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800 transition-colors active:scale-[0.97] [-webkit-tap-highlight-color:transparent]"
                        >
                            {scrambling ? '打亂中…' : '🎲 隨機打亂'}
                        </button>
                        <button
                            type="button"
                            data-testid="cube-scramble-custom-toggle"
                            onClick={() => setCustomPanelOpen((v) => !v)}
                            aria-pressed={customPanelOpen}
                            className={`px-4 py-2.5 min-h-[44px] rounded-xl text-sm font-bold transition-colors active:scale-[0.97] [-webkit-tap-highlight-color:transparent] border ${
                                customPanelOpen ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 border-transparent'
                            }`}
                        >
                            ✏️ 自己排
                        </button>
                    </div>

                    {scrambleTokens.length > 0 ? (
                        <div
                            className={`flex flex-wrap gap-1.5 font-mono font-bold mt-3 ${isVirtual ? 'text-sm' : 'text-lg sm:text-xl'}`}
                            data-testid="cube-scramble-tokens"
                        >
                            {scrambleTokens.map((t, i) => (
                                <span key={`${i}-${t}`} className="px-2 py-1 rounded-lg bg-slate-100 text-slate-700">{t}</span>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-slate-400 mt-3">
                            {isVirtual
                                ? '按「🎲 隨機打亂」或「✏️ 自己排」，開始一次計時挑戰。'
                                : '實體計時可直接按住主按鈕開始，不必打亂；想要打亂譜可按「🎲 隨機打亂」或「✏️ 自己排」。'}
                        </p>
                    )}

                    {customPanelOpen && (
                        <div className="mt-4 p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3" data-testid="cube-builder-panel">
                            <div className="flex flex-wrap gap-1.5 font-mono text-sm min-h-[2rem] items-center" data-testid="cube-builder-tokens">
                                {builderTokens.length === 0 ? (
                                    <span className="cube-builder-hint text-slate-400 text-sm font-sans">按下面的按鈕排出打亂</span>
                                ) : (
                                    builderTokens.map((t, i) => (
                                        <span key={`${i}-${t}`} className="cube-builder-chip px-2 py-1 rounded-lg bg-white border border-slate-200 font-bold">{t}</span>
                                    ))
                                )}
                            </div>
                            <div className="flex flex-wrap gap-2" data-testid="cube-builder-keys">
                                {[...tileOrder, ...TWIST_LETTERS].map((letter) => (
                                    <button
                                        key={letter}
                                        type="button"
                                        data-testid={`cube-builder-key-${letter}`}
                                        onClick={() => appendBuilderToken(letter)}
                                        disabled={scrambleBusy || builderTokens.length >= BUILDER_TOKEN_LIMIT}
                                        className="min-w-[44px] min-h-[44px] px-2 rounded-xl bg-white border border-slate-200 font-mono font-bold text-sm hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.97] transition-transform [-webkit-tap-highlight-color:transparent]"
                                    >
                                        {letter}
                                    </button>
                                ))}
                            </div>
                            <div className="flex flex-wrap gap-2" data-testid="cube-builder-mods">
                                <button
                                    type="button"
                                    data-testid="cube-builder-mod-apostrophe"
                                    onClick={applyApostrophe}
                                    disabled={scrambleBusy || builderTokens.length === 0}
                                    className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-slate-200 text-slate-700 font-mono font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-300 active:scale-[0.97] transition-transform [-webkit-tap-highlight-color:transparent]"
                                >
                                    &apos;
                                </button>
                                <button
                                    type="button"
                                    data-testid="cube-builder-mod-two"
                                    onClick={applyTwo}
                                    disabled={scrambleBusy || builderTokens.length === 0}
                                    className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-slate-200 text-slate-700 font-mono font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-300 active:scale-[0.97] transition-transform [-webkit-tap-highlight-color:transparent]"
                                >
                                    2
                                </button>
                                <button
                                    type="button"
                                    data-testid="cube-builder-mod-backspace"
                                    onClick={backspaceToken}
                                    disabled={scrambleBusy || builderTokens.length === 0}
                                    className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-slate-200 text-slate-700 font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-300 active:scale-[0.97] transition-transform [-webkit-tap-highlight-color:transparent]"
                                >
                                    ⌫
                                </button>
                                <button
                                    type="button"
                                    data-testid="cube-builder-mod-clear"
                                    onClick={clearBuilderTokens}
                                    disabled={scrambleBusy || builderTokens.length === 0}
                                    className="min-h-[44px] px-3 rounded-xl bg-slate-200 text-slate-700 text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-300 active:scale-[0.97] transition-transform [-webkit-tap-highlight-color:transparent]"
                                >
                                    清空
                                </button>
                            </div>
                            {builderError && (
                                <p className="text-sm text-red-600 flex items-center gap-1.5" data-testid="cube-builder-error">
                                    <AlertTriangle className="w-4 h-4 shrink-0" />
                                    {builderError}
                                </p>
                            )}
                            <button
                                type="button"
                                data-testid="cube-builder-apply"
                                onClick={handleBuilderApply}
                                disabled={scrambleBusy || builderTokens.length === 0}
                                className="w-full sm:w-auto px-4 py-2.5 min-h-[44px] rounded-xl bg-slate-900 text-white text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800 transition-colors active:scale-[0.97] [-webkit-tap-highlight-color:transparent]"
                            >
                                {scrambling ? '套用中…' : '套用此打亂'}
                            </button>
                        </div>
                    )}
                </div>

                {/* B. 3D 舞台 */}
                <div className="mt-5 pt-5 border-t border-slate-100">
                    <div className="relative">
                        <div ref={stageRef} className="w-full h-72 sm:h-80 rounded-2xl bg-slate-50 select-none" />
                        <span
                            data-testid="cube-status-pill"
                            className={`absolute top-3 right-3 px-3 py-1 rounded-full text-xs font-bold ${cubeStatusClasses}`}
                        >
                            {cubeStatusLabel}
                        </span>
                    </div>
                    <p className="text-center text-xs text-slate-400 mt-2">按住拖曳可旋轉視角</p>
                </div>

                {/* C. 計時器 hero */}
                <div className="mt-5 pt-5 border-t border-slate-100 text-center">
                    <div
                        data-testid="cube-timer-display"
                        className={`text-5xl sm:text-6xl font-black tabular-nums font-mono transition-colors ${
                            phase === 'armed' ? 'text-emerald-500' : phase === 'paused' ? 'text-amber-500' : 'text-slate-900'
                        }`}
                    >
                        {formatCubeTime(displayMs)}
                    </div>
                    <p className="text-sm text-slate-400 mt-2" data-testid="cube-status-text">{statusText}</p>

                    {lastResult && (
                        <div className="mt-3" data-testid="cube-result-panel">
                            <div className="flex items-baseline justify-center gap-3 flex-wrap">
                                <span className="text-2xl font-black tabular-nums font-mono text-blue-600" data-testid="cube-result-time">
                                    {formatCubeTime(lastResult.timeMs)}
                                </span>
                                {lastResult.moveCount != null && <span className="text-sm text-slate-500">{lastResult.moveCount} 步</span>}
                                <span className="text-xs text-slate-400 font-bold px-2 py-0.5 rounded-full bg-slate-100">
                                    {lastResult.mode === 'physical' ? '實體計時' : '鍵盤模式'}
                                </span>
                            </div>
                            {submitError && (
                                <p className="text-sm text-red-600 mt-2 flex items-center justify-center gap-1.5">
                                    <AlertTriangle className="w-4 h-4 shrink-0" />
                                    {submitError}
                                </p>
                            )}
                            {submitted && (
                                <p className="text-sm text-emerald-600 font-bold mt-2" data-testid="cube-submit-success">
                                    已送出，排行榜已更新！
                                </p>
                            )}
                        </div>
                    )}

                    <div className="mt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
                        <button
                            type="button"
                            data-testid="cube-primary-action"
                            {...primaryHandlers}
                            disabled={primaryDisabled}
                            className={`w-full sm:w-auto px-8 min-h-[56px] rounded-2xl font-bold text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.97] [-webkit-tap-highlight-color:transparent] ${primaryColorClass}`}
                        >
                            {primaryLabel}
                        </button>
                        {secondaryLabel && (
                            <button
                                type="button"
                                data-testid="cube-secondary-action"
                                {...secondaryHandlers}
                                className={`px-5 py-3 min-h-[44px] rounded-2xl font-bold transition-colors active:scale-[0.97] [-webkit-tap-highlight-color:transparent] ${secondaryColorClass}`}
                            >
                                {secondaryLabel}
                            </button>
                        )}
                    </div>
                    {primaryMode === 'stopped' && !submitted && (
                        <button
                            type="button"
                            data-testid="cube-discard-result"
                            onClick={abortCurrent}
                            className="mt-3 inline-block py-2 px-1 text-sm font-bold text-slate-400 hover:text-slate-600 underline underline-offset-2 [-webkit-tap-highlight-color:transparent]"
                        >
                            不算
                        </button>
                    )}
                </div>
            </section>

            {/* 螢幕轉面按鈕區（僅鍵盤模式，可收合） */}
            {isVirtual && (
                <section className="bg-white rounded-3xl border border-slate-200 shadow-sm p-5 sm:p-6 mb-6">
                    <button
                        type="button"
                        onClick={() => setFaceSectionOpen((v) => !v)}
                        data-testid="cube-face-toggle"
                        className="w-full flex items-center justify-between gap-3"
                    >
                        <span className="font-bold text-slate-800">🖱 螢幕按鈕</span>
                        <span className="text-xs text-slate-400 font-bold">{faceSectionOpen ? '收合 ▲' : '展開 ▼'}</span>
                    </button>

                    {faceSectionOpen && (
                        <div className="mt-4">
                            <p className="hidden md:block text-center text-xs text-slate-400 mb-3" data-testid="cube-key-legend">
                                {legendText}
                            </p>
                            <div className="grid grid-cols-3 gap-2" data-testid="cube-face-buttons">
                                {tileOrder.map((letter) => {
                                    const def = MOVE_TABLE[letter];
                                    return (
                                        <div
                                            key={letter}
                                            className="flex items-center justify-center gap-1 border border-slate-200 rounded-xl px-2 py-2"
                                            data-testid={`cube-tile-${letter}`}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => handleFaceTurn(def.axis, def.layer, def.dir)}
                                                disabled={turnButtonsDisabled}
                                                aria-label={`${letter} 順轉`}
                                                data-testid={`cube-btn-${letter}`}
                                                className="min-w-[40px] min-h-[40px] px-2 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-bold font-mono"
                                            >
                                                {letter}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleFaceTurn(def.axis, def.layer, -def.dir)}
                                                disabled={turnButtonsDisabled}
                                                aria-label={`${letter} 逆轉`}
                                                data-testid={`cube-btn-${letter}-prime`}
                                                className="min-w-[40px] min-h-[40px] px-2 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-bold font-mono"
                                            >
                                                {letter}&apos;
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                            <p className="mt-3 mb-1 text-xs text-slate-400 font-bold">翻面（整顆換視角，不計步數）</p>
                            <div className="grid grid-cols-4 gap-2" data-testid="cube-twist-buttons">
                                {TWIST_LETTERS.map((letter) => {
                                    const def = MOVE_TABLE[letter];
                                    return (
                                        <div
                                            key={letter}
                                            className="col-span-2 flex items-center justify-center gap-1 border border-amber-200 rounded-xl px-2 py-2"
                                            data-testid={`cube-tile-${letter}`}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => handleFaceTurn(def.axis, def.layer, def.dir, false)}
                                                disabled={turnButtonsDisabled}
                                                aria-label={`整顆換視角 ${letter}`}
                                                data-testid={`cube-btn-${letter}`}
                                                className="min-w-[40px] min-h-[40px] px-2 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-bold font-mono text-amber-700"
                                            >
                                                {letter}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleFaceTurn(def.axis, def.layer, -def.dir, false)}
                                                disabled={turnButtonsDisabled}
                                                aria-label={`整顆換視角 ${letter} 反向`}
                                                data-testid={`cube-btn-${letter}-prime`}
                                                className="min-w-[40px] min-h-[40px] px-2 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-bold font-mono text-amber-700"
                                            >
                                                {letter}&apos;
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </section>
            )}

            {/* 成績與紀錄 */}
            <section className="grid md:grid-cols-2 gap-6 mb-6">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-5 sm:p-6">
                    <h2 className="font-bold text-slate-800 mb-3">
                        排行榜 Top 10 <span className="text-xs text-slate-400 font-normal">・{isVirtual ? '鍵盤模式' : '實體計時'}</span>
                    </h2>
                    {leaderboardState === 'loading' && <p className="text-sm text-slate-400">載入中…</p>}
                    {leaderboardState === 'unavailable' && <p className="text-sm text-slate-400">排行榜功能待資料庫更新後開放。</p>}
                    {leaderboardState === 'error' && (
                        <p className="text-sm text-red-500 flex items-center gap-1.5">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            排行榜載入失敗，請稍後再試。
                        </p>
                    )}
                    {leaderboardState === 'ok' && (
                        leaderboard.length === 0 ? (
                            <p className="text-sm text-slate-400">還沒有人送出成績，當第一個吧！</p>
                        ) : (
                            <div className="divide-y divide-slate-100">
                                {leaderboard.slice(0, 10).map((row) => {
                                    const isMe = row.user_id === user?.id;
                                    return (
                                        <div key={row.user_id} className={`flex items-center gap-3 py-2.5 ${isMe ? 'bg-blue-50/80 -mx-2 px-2 rounded-xl' : ''}`}>
                                            <span className={`w-8 text-center font-black tabular-nums ${isMe ? 'text-blue-600' : 'text-slate-300'}`}>{row.rank}</span>
                                            <span className={`flex-1 truncate font-bold ${isMe ? 'text-blue-700' : 'text-slate-700'}`}>{row.display_name || '匿名老師'}</span>
                                            <span className={`font-mono font-black tabular-nums ${isMe ? 'text-blue-700' : 'text-slate-800'}`}>{formatCubeTime(row.best_ms)}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )
                    )}
                </div>

                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-5 sm:p-6">
                    <h2 className="font-bold text-slate-800 mb-3">我的紀錄</h2>
                    <div className="grid grid-cols-4 gap-2 mb-4" data-testid="cube-my-stats">
                        <StatTile
                            testId="cube-stat-best"
                            label="最佳"
                            value={myStatsState === 'ok' ? (myBest != null ? formatCubeTime(myBest) : '—') : myStatsState === 'loading' ? '…' : myStatsState === 'unavailable' ? '待開放' : '失敗'}
                        />
                        <StatTile
                            testId="cube-stat-ao5"
                            label="Ao5"
                            value={myStatsState === 'ok' ? (ao5 != null ? formatCubeTime(ao5) : '—') : '…'}
                        />
                        <StatTile
                            testId="cube-stat-ao12"
                            label="Ao12"
                            value={myStatsState === 'ok' ? (ao12 != null ? formatCubeTime(ao12) : '—') : '…'}
                        />
                        <StatTile
                            testId="cube-stat-count"
                            label="次數"
                            value={myStatsState === 'ok' ? (myCount != null ? String(myCount) : '—') : '…'}
                        />
                    </div>
                    <div>
                        <div className="text-xs text-slate-400 font-bold mb-1">我的最近 5 次</div>
                        {myStatsState === 'ok' && myRecent.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {myRecent.slice(0, 5).map((r) => (
                                    <span key={r.id} className="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 text-xs font-mono font-bold">{formatCubeTime(r.time_ms)}</span>
                                ))}
                            </div>
                        )}
                        {myStatsState === 'ok' && myRecent.length === 0 && <span className="text-sm text-slate-400">還沒有紀錄</span>}
                    </div>
                </div>
            </section>

            {/* 設定（按鍵設定＋按鈕排列，移到頁面最下方，可摺疊） */}
            <section className="bg-white rounded-3xl border border-slate-200 shadow-sm p-5 sm:p-6">
                <button
                    type="button"
                    onClick={() => setKeySettingsOpen((v) => !v)}
                    data-testid="cube-key-settings-toggle"
                    className="w-full flex items-center justify-between gap-3"
                >
                    <span className="font-bold text-slate-800 flex items-center gap-2">
                        <KeyRound className="w-4 h-4 text-slate-400" />
                        按鍵設定
                    </span>
                    <span className="text-xs text-slate-400 font-bold">{keySettingsOpen ? '收合 ▲' : '展開 ▼'}</span>
                </button>

                {keySettingsOpen && (
                    <div className="mt-4 space-y-5">
                        {conflictMsg && (
                            <p className="text-sm text-red-600 flex items-center gap-1.5" data-testid="cube-keymap-conflict">
                                <AlertTriangle className="w-4 h-4 shrink-0" />
                                {conflictMsg}
                            </p>
                        )}
                        {capturingAction && (
                            <p className="text-sm text-blue-600 font-bold">請按下想綁定的新按鍵…（Esc 取消）</p>
                        )}
                        <div>
                            <h3 className="text-xs font-bold text-slate-400 mb-2">轉面（僅鍵盤模式作用，代號＝國際標準轉法記號）</h3>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {FACE_ACTIONS.map((a) => (
                                    <KeyRow
                                        key={a.id}
                                        label={a.label}
                                        binding={keymap[a.id]}
                                        capturing={capturingAction === a.id}
                                        onStart={() => startCapture(a.id)}
                                        testId={`cube-keyrow-${a.id}`}
                                    />
                                ))}
                            </div>
                        </div>
                        <div>
                            <h3 className="text-xs font-bold text-slate-400 mb-2">控制</h3>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                {CONTROL_ACTIONS.map((id) => (
                                    <KeyRow
                                        key={id}
                                        label={ACTION_LABELS[id]}
                                        binding={keymap[id]}
                                        capturing={capturingAction === id}
                                        onStart={() => startCapture(id)}
                                        testId={`cube-keyrow-${id}`}
                                    />
                                ))}
                            </div>
                        </div>
                        <div>
                            <h3 className="text-xs font-bold text-slate-400 mb-2">按鈕排列（轉面格子順序，x/y 翻面固定不排序）</h3>
                            <div className="space-y-1.5 max-w-xs">
                                {tileOrder.map((letter, idx) => (
                                    <div
                                        key={letter}
                                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50"
                                        data-testid={`cube-tile-order-row-${letter}`}
                                    >
                                        <span className="font-mono font-bold text-slate-700">{letter}</span>
                                        <div className="flex gap-1">
                                            <button
                                                type="button"
                                                onClick={() => moveTile(letter, -1)}
                                                disabled={idx === 0}
                                                aria-label={`${letter} 往左移`}
                                                data-testid={`cube-tile-move-left-${letter}`}
                                                className="p-1.5 rounded-lg bg-white border border-slate-200 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-100"
                                            >
                                                <ChevronLeft className="w-4 h-4" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => moveTile(letter, 1)}
                                                disabled={idx === tileOrder.length - 1}
                                                aria-label={`${letter} 往右移`}
                                                data-testid={`cube-tile-move-right-${letter}`}
                                                className="p-1.5 rounded-lg bg-white border border-slate-200 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-100"
                                            >
                                                <ChevronRight className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={resetKeymap}
                            data-testid="cube-keymap-reset"
                            className="px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-sm font-bold hover:bg-slate-200 transition-colors flex items-center gap-1.5"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            全部恢復預設
                        </button>
                    </div>
                )}
            </section>
        </div>
    );
};

export default CubeTimer;
