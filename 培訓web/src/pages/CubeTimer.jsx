import { useState, useEffect, useRef, useCallback } from 'react';
import { Timer as TimerIcon, AlertTriangle, KeyRound, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import {
    CubeRenderer, genScramble, formatCubeTime, isSolvedState, parseNotation,
    MOVE_TABLE, ALL_MOVES, TILE_LETTERS, MID_LETTERS, TWIST_LETTERS, WIDE_LETTERS,
} from '../lib/cubeEngine';

const HOLD_MS = 300;

// 送出成績時「公開到排行榜／只存自己的紀錄」的偏好，記住上次選擇；首次預設公開。
const SUBMIT_PUBLIC_STORAGE_KEY = 'cube_submit_public';
// 完整歷史：每頁筆數（依 created_at desc 分頁）。
const HISTORY_PAGE_SIZE = 20;

const MODE_STORAGE_KEY = 'cube_mode';
// keymap v3（2026-07-09）：新增 E/S/z 與 12 個寬層動作。v3 缺鍵時往下遷移
// 補齊（v2→v3、v1→v3），不遺失使用者原本的自訂鍵位。
const KEYMAP_STORAGE_KEY = 'cube_keymap_v3';
const OLD_KEYMAP_STORAGE_KEY = 'cube_keymap_v2';
const OLDER_KEYMAP_STORAGE_KEY = 'cube_keymap_v1';
// 按鈕排列 v2（2026-07-09）：從「7 格」改為「6 個轉面字母」（M 移入中層固定組，
// 不再參與排序）。v1 讀到時只取其中 6 個面字母的相對順序遷移。
const TILE_ORDER_STORAGE_KEY = 'cube_tile_order_v2';
const OLD_TILE_ORDER_STORAGE_KEY = 'cube_tile_order_v1';

// 預設轉面排列（使用者拍板）：R F L U D B。
const DEFAULT_TILE_ORDER = ['R', 'F', 'L', 'U', 'D', 'B'];

// 打亂編排器：token 上限（避免無限累加）。
const BUILDER_TOKEN_LIMIT = 40;

// 36 個轉面/中層/翻面/寬層動作（U/D/L/R/F/B/M/E/S/x/y/z/Rw/Lw/Uw/Dw/Fw/Bw ×
// 順轉/逆轉），衍生自 cubeEngine 的 ALL_MOVES，保證與 3D 引擎的 axis/layer/dir
// 對照永遠一致（單一事實來源）。ALL_MOVES 的固定順序＝轉面(6)→中層(3)→
// 翻面(3)→寬層(6)，故可直接切片分組，不必另外過濾。
// x/y/z 是整顆換視角（layer==='all'），不計步數；其餘（含 M/E/S/寬層）計步數。
const FACE_ACTIONS = ALL_MOVES.flatMap((m) => {
    const countsAsMove = m.layer !== 'all';
    return [
        { id: `${m.letter}_CW`, axis: m.axis, layer: m.layer, dir: m.dir, label: m.letter, countsAsMove },
        { id: `${m.letter}_CCW`, axis: m.axis, layer: m.layer, dir: -m.dir, label: `${m.letter}'`, countsAsMove },
    ];
});
const FACE_TURN_ACTIONS = FACE_ACTIONS.slice(0, TILE_LETTERS.length * 2);
const MID_ACTIONS = FACE_ACTIONS.slice(TILE_LETTERS.length * 2, (TILE_LETTERS.length + MID_LETTERS.length) * 2);
const TWIST_ACTIONS = FACE_ACTIONS.slice(
    (TILE_LETTERS.length + MID_LETTERS.length) * 2,
    (TILE_LETTERS.length + MID_LETTERS.length + TWIST_LETTERS.length) * 2
);
const WIDE_ACTIONS = FACE_ACTIONS.slice((TILE_LETTERS.length + MID_LETTERS.length + TWIST_LETTERS.length) * 2);

const CONTROL_ACTIONS = ['startStop', 'pause', 'discard'];

const ACTION_LABELS = {
    ...Object.fromEntries(FACE_ACTIONS.map((a) => [a.id, a.label])),
    startStop: '起錶／停錶',
    pause: '暫停／繼續',
    discard: '放棄',
};

// 預設鍵位（csTimer 精神）：轉面／中層＝代號字母鍵，Shift＝反轉；
// 起錶／停錶＝Space；暫停＝P；放棄＝Esc。寬層 12 個動作預設不綁定（null）——
// 鍵盤字母不夠用，使用者可在設定面板自行擷取綁定；null 代表「未設定」。
const DEFAULT_KEYMAP = {
    U_CW: { code: 'KeyU', shift: false }, U_CCW: { code: 'KeyU', shift: true },
    D_CW: { code: 'KeyD', shift: false }, D_CCW: { code: 'KeyD', shift: true },
    L_CW: { code: 'KeyL', shift: false }, L_CCW: { code: 'KeyL', shift: true },
    R_CW: { code: 'KeyR', shift: false }, R_CCW: { code: 'KeyR', shift: true },
    F_CW: { code: 'KeyF', shift: false }, F_CCW: { code: 'KeyF', shift: true },
    B_CW: { code: 'KeyB', shift: false }, B_CCW: { code: 'KeyB', shift: true },
    M_CW: { code: 'KeyM', shift: false }, M_CCW: { code: 'KeyM', shift: true },
    E_CW: { code: 'KeyE', shift: false }, E_CCW: { code: 'KeyE', shift: true },
    S_CW: { code: 'KeyS', shift: false }, S_CCW: { code: 'KeyS', shift: true },
    x_CW: { code: 'KeyX', shift: false }, x_CCW: { code: 'KeyX', shift: true },
    y_CW: { code: 'KeyY', shift: false }, y_CCW: { code: 'KeyY', shift: true },
    z_CW: { code: 'KeyZ', shift: false }, z_CCW: { code: 'KeyZ', shift: true },
    Rw_CW: null, Rw_CCW: null,
    Lw_CW: null, Lw_CCW: null,
    Uw_CW: null, Uw_CCW: null,
    Dw_CW: null, Dw_CCW: null,
    Fw_CW: null, Fw_CCW: null,
    Bw_CW: null, Bw_CCW: null,
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

// 讀「送出成績時是否公開」偏好：沒存過視為第一次，預設公開；存過就照存的值。
function loadSubmitPublicFromStorage() {
    try {
        const raw = localStorage.getItem(SUBMIT_PUBLIC_STORAGE_KEY);
        return raw === null ? true : raw === 'true';
    } catch {
        return true;
    }
}

// 完整歷史列的時間顯示：台灣習慣 M/D HH:mm（24 小時制，Asia/Taipei 時區，
// 用 hourCycle:'h23' 明確指定，避免 hour12:false 在部分 locale 對午夜輸出 24:00 的已知怪癖）。
function formatHistoryDateTime(iso) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Taipei',
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(new Date(iso));
        const get = (type) => parts.find((p) => p.type === type)?.value || '';
        return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
    } catch {
        return '';
    }
}

function isValidBinding(v) {
    return !!v && typeof v.code === 'string' && typeof v.shift === 'boolean';
}

// 寬層動作允許明確的「未設定」（null）；其餘動作仍要求是合法的按鍵綁定。
function isValidBindingOrNull(v) {
    return v === null || isValidBinding(v);
}

// 用某一份舊 keymap 資料疊上預設值：舊資料裡每個 id 若合法（含明確 null）就採用，
// 否則補預設。用於 v1/v2 → v3 遷移，也用於 v3 資料不完整時的自我修復。
function mergeKeymapFrom(oldParsed) {
    const merged = { ...DEFAULT_KEYMAP };
    if (oldParsed && typeof oldParsed === 'object') {
        for (const id of ALL_KEYMAP_IDS) {
            if (isValidBindingOrNull(oldParsed[id])) merged[id] = oldParsed[id];
        }
    }
    return merged;
}

// 讀鍵位設定：v3 存在且完整就直接用；否則依序嘗試從 v2、v1 遷移（保留舊有
// 綁定、新動作補預設）；都沒有或資料壞掉就回全預設。存檔一律寫回 v3。
function loadKeymapFromStorage() {
    try {
        const raw = localStorage.getItem(KEYMAP_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (ALL_KEYMAP_IDS.every((id) => isValidBindingOrNull(parsed?.[id]))) return parsed;
            return mergeKeymapFrom(parsed);
        }
        const v2Raw = localStorage.getItem(OLD_KEYMAP_STORAGE_KEY);
        if (v2Raw) return mergeKeymapFrom(JSON.parse(v2Raw));
        const v1Raw = localStorage.getItem(OLDER_KEYMAP_STORAGE_KEY);
        if (v1Raw) return mergeKeymapFrom(JSON.parse(v1Raw));
        return { ...DEFAULT_KEYMAP };
    } catch {
        return { ...DEFAULT_KEYMAP };
    }
}

function isValidTileOrder(arr) {
    if (!Array.isArray(arr) || arr.length !== DEFAULT_TILE_ORDER.length) return false;
    const set = new Set(arr);
    return set.size === DEFAULT_TILE_ORDER.length && DEFAULT_TILE_ORDER.every((l) => set.has(l));
}

// 讀轉面排列：v2 驗證元素齊全（6 個面字母各恰好一次）就直接用；否則嘗試從舊版
// v1（7 格含 M）遷移，取其中 6 個面字母的相對順序；都不齊就回預設。
function loadTileOrderFromStorage() {
    try {
        const raw = localStorage.getItem(TILE_ORDER_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return isValidTileOrder(parsed) ? parsed : [...DEFAULT_TILE_ORDER];
        }
        const oldRaw = localStorage.getItem(OLD_TILE_ORDER_STORAGE_KEY);
        if (oldRaw) {
            const oldParsed = JSON.parse(oldRaw);
            if (Array.isArray(oldParsed)) {
                const migrated = oldParsed.filter((l) => DEFAULT_TILE_ORDER.includes(l));
                if (isValidTileOrder(migrated)) return migrated;
            }
        }
        return [...DEFAULT_TILE_ORDER];
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
        className={`flex-1 px-4 py-2.5 min-h-[44px] text-sm font-bold uppercase tracking-wide transition-colors duration-200 ${
            active ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
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
        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border-2 text-sm font-bold font-mono transition-colors duration-200 ${
            capturing ? 'border-bauhaus-blue bg-bauhaus-blue/10 text-bauhaus-blue' : 'border-bauhaus-black bg-white text-bauhaus-black hover:bg-bauhaus-muted'
        }`}
    >
        <span>{label}</span>
        <kbd className="px-2 py-0.5 rounded-lg bg-white border-2 border-bauhaus-black text-xs font-mono text-bauhaus-black/60">
            {capturing ? '請按新按鍵…' : keyLabel(binding)}
        </kbd>
    </button>
);

const StatTile = ({ label, value, testId }) => (
    <div className="text-center px-2 py-3 rounded-lg border-2 border-bauhaus-black bg-white" data-testid={testId}>
        <div className="text-[11px] text-bauhaus-black/40 font-bold mb-1">{label}</div>
        <div className="text-base sm:text-lg font-mono font-black tabular-nums text-bauhaus-black truncate">{value}</div>
    </div>
);

// ── 螢幕轉面鍵帽（keycap）：2026-07-09 重新設計 ─────────────────────────
// 取代舊版「格子包兩顆小鈕」；每顆鍵帽獨立顯示完整代號（R、R'、Rw、M、x'…），
// 遵循站內 Bauhaus 形狀鐵律（圓角依 DESIGN.md §4 刻度取 rounded-xl、border-bauhaus-*、
// shadow-hard-sm，不用柔陰影），按下用位移+去陰影模擬鍵帽下沉。各組用邊框色/底色微調
// 區分語意（轉面＝黑；中層＝藍；翻面＝黃；寬層＝虛線灰，Bauhaus 沒有綠色，
// 見 DESIGN.md，改用虛線邊框表達「進階/次要」而非另開色系）。
const KEYCAP_BASE = 'min-w-[44px] min-h-[44px] w-full flex items-center justify-center rounded-xl border-2 font-mono font-bold text-sm shadow-hard-sm transition-all duration-200 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-hard-sm disabled:active:translate-x-0 disabled:active:translate-y-0 [-webkit-tap-highlight-color:transparent]';
const KEYCAP_TINTS = {
    face: 'bg-white border-bauhaus-black text-bauhaus-black hover:bg-bauhaus-muted',
    mid: 'bg-bauhaus-blue/5 border-bauhaus-blue text-bauhaus-blue hover:bg-bauhaus-blue/10',
    twist: 'bg-bauhaus-yellow/10 border-bauhaus-yellow text-bauhaus-black hover:bg-bauhaus-yellow/20',
    wide: 'bg-white border-bauhaus-black text-bauhaus-black hover:bg-bauhaus-muted',
};

const Keycap = ({ label, onClick, disabled, ariaLabel, testId, tint }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        className={`${KEYCAP_BASE} ${KEYCAP_TINTS[tint]}`}
    >
        {label}
    </button>
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
    const [builderWideOpen, setBuilderWideOpen] = useState(false);

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
    const [wideSectionOpen, setWideSectionOpen] = useState(false);

    const [lastResult, setLastResult] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [submitted, setSubmitted] = useState(false);
    // 送出成績時「公開／私人」偏好與送出結果（給成功訊息用字區分）。
    const [submitPublic, setSubmitPublic] = useState(() => loadSubmitPublicFromStorage());
    const [lastSubmitWasPublic, setLastSubmitWasPublic] = useState(true);
    const [submitDowngradeNotice, setSubmitDowngradeNotice] = useState('');

    const [leaderboard, setLeaderboard] = useState([]);
    const [leaderboardState, setLeaderboardState] = useState('loading'); // loading | ok | unavailable | error
    const [myBest, setMyBest] = useState(null);
    const [myRecent, setMyRecent] = useState([]);
    const [myCount, setMyCount] = useState(null);
    const [myStatsState, setMyStatsState] = useState('loading');

    // 完整歷史（依模式過濾、依 created_at desc 分頁載入）。
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyRows, setHistoryRows] = useState([]);
    const [historyOffset, setHistoryOffset] = useState(0);
    const [historyHasMore, setHistoryHasMore] = useState(true);
    const [historyState, setHistoryState] = useState('idle'); // idle | loading | ok | error

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

    useEffect(() => {
        try { localStorage.setItem(SUBMIT_PUBLIC_STORAGE_KEY, submitPublic ? 'true' : 'false'); } catch { /* 忽略 */ }
    }, [submitPublic]);

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

    // 完整歷史：依模式過濾、依 created_at desc 分頁載入一頁（offsetArg===0 視為重新載入，
    // 取代既有列表；否則附加在後面，供「載入更多」使用）。
    const loadHistoryPage = useCallback(async (modeArg, offsetArg) => {
        if (!user) return;
        setHistoryState('loading');
        try {
            const { data, error } = await supabase
                .from('cube_solves')
                .select('id,time_ms,move_count,created_at,is_public')
                .eq('mode', modeArg)
                .order('created_at', { ascending: false })
                .range(offsetArg, offsetArg + HISTORY_PAGE_SIZE - 1);
            if (error) throw error;
            const rows = data || [];
            setHistoryRows((prev) => (offsetArg === 0 ? rows : [...prev, ...rows]));
            setHistoryHasMore(rows.length === HISTORY_PAGE_SIZE);
            setHistoryOffset(offsetArg + rows.length);
            setHistoryState('ok');
        } catch (err) {
            console.error('Cube history load failed:', err);
            setHistoryState('error');
        }
    }, [user]);

    const toggleHistory = useCallback(() => {
        setHistoryOpen((prevOpen) => {
            const next = !prevOpen;
            if (next && historyRows.length === 0) loadHistoryPage(modeRef.current, 0);
            return next;
        });
    }, [historyRows.length, loadHistoryPage]);

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
        setSubmitDowngradeNotice('');
        const basePayload = {
            time_ms: lastResult.timeMs,
            move_count: lastResult.moveCount,
            scramble: lastResult.scramble || null,
            mode: lastResult.mode,
        };
        const wantsPublic = submitPublic;
        try {
            const first = await supabase.from('cube_solves').insert({ ...basePayload, is_public: wantsPublic });
            if (first.error) {
                // 防呆降級：資料庫尚未跑過新增 is_public 欄位的遷移時，改用不含該欄位的
                // payload 重試一次（沿用資料庫預設值＝公開），成功後在訊息旁註明待補。
                const msg = `${first.error.message || ''} ${first.error.code || ''}`.toLowerCase();
                if (msg.includes('is_public') || msg.includes('column')) {
                    const retry = await supabase.from('cube_solves').insert(basePayload);
                    if (retry.error) throw retry.error;
                    setSubmitDowngradeNotice('公開設定待資料庫更新後生效');
                } else {
                    throw first.error;
                }
            }
            setLastSubmitWasPublic(wantsPublic);
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
    }, [lastResult, submitPublic, loadLeaderboard, loadMyStats]);

    // ── 按鍵設定：綁定 / 衝突檢查 / 恢復預設 ──────────────────────────
    const rebindAction = useCallback((actionId, binding) => {
        // 寬層動作預設 null（未設定），不參與衝突檢查，找衝突時先濾掉 null。
        const conflictEntry = Object.entries(keymapRef.current).find(
            ([id, b]) => id !== actionId && b && b.code === binding.code && b.shift === binding.shift
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

    // ── 完整歷史：模式切換時清空舊列表；若面板本來是展開的，直接重新載入第一頁 ──
    useEffect(() => {
        setHistoryRows([]);
        setHistoryOffset(0);
        setHistoryHasMore(true);
        setHistoryState('idle');
        if (historyOpen) loadHistoryPage(mode, 0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    const isVirtual = mode === 'virtual';
    const scrambleBusy = scrambling || phase === 'running' || phase === 'armed' || phase === 'paused';
    // 螢幕轉面鍵的鎖定條件：與 handleFaceTurn 的鍵盤閘門一致——
    // 打亂中／等待起錶／按住準備／暫停中鎖定；計時中與自由玩（未打亂、成績出爐後）可按。
    const turnButtonsDisabled = scrambling || ready || phase === 'armed' || phase === 'paused';
    const ao5 = computeAoN(myRecent, 5);
    const ao12 = computeAoN(myRecent, 12);
    // 寬層畫面顯示順序跟隨使用者的轉面自訂順序（tileOrder），例如 R 排第一就
    // Rw 也排第一；螢幕按鈕、打亂編排器的「＋寬層」列、按鍵設定的寬層分組皆共用。
    const wideOrder = tileOrder.map((l) => `${l}w`);
    // 圖例行避免爆長：固定列出預設字母＋提示語，不逐一展開目前的自訂鍵位。
    const legendText = `起錶／停錶 ${keyLabel(keymap.startStop)}・暫停 ${keyLabel(keymap.pause)}・放棄 ${keyLabel(keymap.discard)}`
        + (isVirtual ? '・轉面 U D L R F B（Shift 反轉）・更多鍵位見設定' : '');

    // ── 狀態 pill（整齊／已打亂／計時中／已暫停）────────────────────────
    const cubeStatusLabel = phase === 'running' ? '計時中' : phase === 'paused' ? '已暫停' : cubeSolved ? '整齊' : '已打亂';
    const cubeStatusClasses = {
        計時中: 'bg-bauhaus-blue text-white border-2 border-bauhaus-black',
        已暫停: 'bg-bauhaus-yellow text-bauhaus-black border-2 border-bauhaus-black',
        已打亂: 'bg-white text-bauhaus-black border-2 border-bauhaus-black',
        整齊: 'bg-bauhaus-muted text-bauhaus-black/50 border-2 border-bauhaus-black/10',
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

    // 主行動按鈕語意色：準備中（打亂／按住準備／已暫停）黃、進行中（計時中）紅、完成（停錶後送出）藍。
    let primaryLabel = '';
    let primaryColorClass = 'bg-bauhaus-blue text-white hover:bg-bauhaus-blue/90';
    let primaryHandlers = {};
    let primaryDisabled = false;
    let secondaryLabel = null;
    let secondaryColorClass = 'bg-bauhaus-muted text-bauhaus-black hover:bg-bauhaus-black/10';
    let secondaryHandlers = {};

    if (primaryMode === 'needScramble') {
        primaryLabel = scrambling ? '打亂中…' : '🎲 打亂';
        primaryColorClass = 'bg-bauhaus-yellow text-bauhaus-black hover:bg-bauhaus-yellow/90';
        primaryHandlers = { onClick: handleNewScramble };
        primaryDisabled = scrambleBusy;
    } else if (primaryMode === 'hold') {
        primaryLabel = phase === 'armed' ? '放開開始！' : '按住準備・放開開始';
        primaryColorClass = 'bg-bauhaus-yellow text-bauhaus-black hover:bg-bauhaus-yellow/90';
        primaryHandlers = {
            onPointerDown: (e) => { e.preventDefault(); armStart(); },
            onPointerUp: releaseStart,
            onPointerLeave: releaseStart,
        };
        if (!isVirtual) {
            secondaryLabel = '🎲 打亂';
            secondaryHandlers = { onClick: handleNewScramble };
            secondaryColorClass = 'bg-bauhaus-muted text-bauhaus-black hover:bg-bauhaus-black/10';
        }
    } else if (primaryMode === 'running') {
        primaryColorClass = 'bg-bauhaus-red text-white hover:bg-bauhaus-red/90';
        if (isVirtual) {
            primaryLabel = '⏸ 暫停';
            primaryHandlers = { onClick: togglePause };
            secondaryLabel = '✕ 放棄';
            secondaryHandlers = { onClick: abortCurrent };
            secondaryColorClass = 'bg-bauhaus-red/10 text-bauhaus-red hover:bg-bauhaus-red/20';
        } else {
            primaryLabel = '■ 停錶';
            primaryHandlers = { onClick: stopTimer };
            secondaryLabel = '⏸ 暫停';
            secondaryHandlers = { onClick: togglePause };
        }
    } else if (primaryMode === 'paused') {
        primaryLabel = '▶ 繼續';
        primaryColorClass = 'bg-bauhaus-yellow text-bauhaus-black hover:bg-bauhaus-yellow/90';
        primaryHandlers = { onClick: togglePause };
        secondaryLabel = '✕ 放棄';
        secondaryHandlers = { onClick: abortCurrent };
        secondaryColorClass = 'bg-bauhaus-red/10 text-bauhaus-red hover:bg-bauhaus-red/20';
    } else if (primaryMode === 'stopped') {
        primaryColorClass = 'bg-bauhaus-blue text-white hover:bg-bauhaus-blue/90';
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
                <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black flex items-center gap-2">
                    <TimerIcon className="w-7 h-7 text-bauhaus-blue" />
                    方塊競速
                </h1>
                <p className="text-bauhaus-black/50 text-sm mt-1">打亂、計時、解開，跟其他老師比比看。</p>
            </div>

            {/* 模式切換 */}
            <section className="mb-5">
                <div className="flex rounded-xl overflow-hidden border-2 lg:border-4 border-bauhaus-black divide-x-2 divide-bauhaus-black">
                    <ModeButton active={isVirtual} onClick={() => handleModeChange('virtual')} testId="cube-mode-virtual">
                        鍵盤模式<span className="hidden sm:inline">・虛擬方塊</span>
                    </ModeButton>
                    <ModeButton active={!isVirtual} onClick={() => handleModeChange('physical')} testId="cube-mode-physical">
                        實體計時<span className="hidden sm:inline">・自己的方塊</span>
                    </ModeButton>
                </div>
                {modeSwitchWarning && (
                    <p className="text-sm font-bold text-bauhaus-black bg-bauhaus-yellow rounded-lg border-2 border-bauhaus-black px-3 py-2 mt-2 flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        {modeSwitchWarning}
                    </p>
                )}
                <p className="text-xs text-bauhaus-black/50 mt-2">
                    {isVirtual ? '打亂虛擬方塊，用鍵盤轉面解開，自動計時。' : '拿你自己的實體方塊計時，畫面只是打亂示意，轉面請用手轉。'}
                </p>
            </section>

            {/* 主遊戲卡：打亂列＋3D 舞台＋計時器 hero 整合成一張卡 */}
            <section className="bg-white rounded-2xl border-2 lg:border-4 border-bauhaus-black shadow-hard lg:shadow-hard-lg p-4 sm:p-6 mb-6" data-testid="cube-game-card">
                {/* A. 打亂列 */}
                <div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            data-testid="cube-scramble-random"
                            onClick={handleNewScramble}
                            disabled={scrambleBusy}
                            className="px-4 py-2.5 min-h-[44px] rounded-xl border-2 border-bauhaus-black shadow-hard-sm bg-bauhaus-black text-white text-sm font-bold uppercase tracking-wide disabled:opacity-40 disabled:cursor-not-allowed hover:bg-bauhaus-black/90 transition-all duration-200 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none [-webkit-tap-highlight-color:transparent]"
                        >
                            {scrambling ? '打亂中…' : '🎲 隨機打亂'}
                        </button>
                        <button
                            type="button"
                            data-testid="cube-scramble-custom-toggle"
                            onClick={() => setCustomPanelOpen((v) => !v)}
                            aria-pressed={customPanelOpen}
                            className={`px-4 py-2.5 min-h-[44px] rounded-xl text-sm font-bold uppercase tracking-wide transition-colors duration-200 [-webkit-tap-highlight-color:transparent] border-2 ${
                                customPanelOpen ? 'bg-bauhaus-blue/10 text-bauhaus-blue border-bauhaus-blue' : 'bg-white text-bauhaus-black border-bauhaus-black hover:bg-bauhaus-muted'
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
                                <span key={`${i}-${t}`} className="px-2 py-1 rounded-lg border-2 border-bauhaus-black/10 bg-bauhaus-muted text-bauhaus-black">{t}</span>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-bauhaus-black/50 mt-3">
                            {isVirtual
                                ? '按「🎲 隨機打亂」或「✏️ 自己排」，開始一次計時挑戰。'
                                : '實體計時可直接按住主按鈕開始，不必打亂；想要打亂譜可按「🎲 隨機打亂」或「✏️ 自己排」。'}
                        </p>
                    )}

                    {customPanelOpen && (
                        <div className="mt-4 p-4 rounded-2xl bg-bauhaus-cream border-2 border-bauhaus-black space-y-3" data-testid="cube-builder-panel">
                            <div className="flex flex-wrap gap-1.5 font-mono text-sm min-h-[2rem] items-center" data-testid="cube-builder-tokens">
                                {builderTokens.length === 0 ? (
                                    <span className="cube-builder-hint text-bauhaus-black/40 text-sm font-sans">按下面的按鈕排出打亂</span>
                                ) : (
                                    builderTokens.map((t, i) => (
                                        <span key={`${i}-${t}`} className="cube-builder-chip px-2 py-1 rounded-lg bg-white border-2 border-bauhaus-black font-bold">{t}</span>
                                    ))
                                )}
                            </div>
                            {/* 轉面（自訂順序）＋ M E S ＋ x y z 常駐；寬層鍵藏在「＋寬層」小切換內 */}
                            <div className="flex flex-wrap gap-2" data-testid="cube-builder-keys">
                                {[...tileOrder, ...MID_LETTERS, ...TWIST_LETTERS].map((letter) => (
                                    <button
                                        key={letter}
                                        type="button"
                                        data-testid={`cube-builder-key-${letter}`}
                                        onClick={() => appendBuilderToken(letter)}
                                        disabled={scrambleBusy || builderTokens.length >= BUILDER_TOKEN_LIMIT}
                                        className="min-w-[44px] min-h-[44px] px-2 rounded-xl bg-white border-2 border-bauhaus-black font-mono font-bold text-sm hover:bg-bauhaus-muted disabled:opacity-30 disabled:cursor-not-allowed active:translate-x-[1px] active:translate-y-[1px] transition-all duration-200 [-webkit-tap-highlight-color:transparent]"
                                    >
                                        {letter}
                                    </button>
                                ))}
                            </div>
                            <div>
                                <button
                                    type="button"
                                    onClick={() => setBuilderWideOpen((v) => !v)}
                                    data-testid="cube-builder-wide-toggle"
                                    className="text-xs font-bold text-bauhaus-black/50 underline underline-offset-2 [-webkit-tap-highlight-color:transparent]"
                                >
                                    {builderWideOpen ? '收合寬層 ▲' : '＋ 寬層'}
                                </button>
                                {builderWideOpen && (
                                    <div className="flex flex-wrap gap-2 mt-2" data-testid="cube-builder-wide-keys">
                                        {wideOrder.map((letter) => (
                                            <button
                                                key={letter}
                                                type="button"
                                                data-testid={`cube-builder-key-${letter}`}
                                                onClick={() => appendBuilderToken(letter)}
                                                disabled={scrambleBusy || builderTokens.length >= BUILDER_TOKEN_LIMIT}
                                                className="min-w-[44px] min-h-[44px] px-2 rounded-xl bg-white border-2 border-bauhaus-black font-mono font-bold text-sm text-bauhaus-black hover:bg-bauhaus-muted disabled:opacity-30 disabled:cursor-not-allowed active:translate-x-[1px] active:translate-y-[1px] transition-all duration-200 [-webkit-tap-highlight-color:transparent]"
                                            >
                                                {letter}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-2" data-testid="cube-builder-mods">
                                <button
                                    type="button"
                                    data-testid="cube-builder-mod-apostrophe"
                                    onClick={applyApostrophe}
                                    disabled={scrambleBusy || builderTokens.length === 0}
                                    className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-bauhaus-muted text-bauhaus-black font-mono font-bold border-2 border-bauhaus-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-bauhaus-black/10 active:translate-x-[1px] active:translate-y-[1px] transition-all duration-200 [-webkit-tap-highlight-color:transparent]"
                                >
                                    &apos;
                                </button>
                                <button
                                    type="button"
                                    data-testid="cube-builder-mod-two"
                                    onClick={applyTwo}
                                    disabled={scrambleBusy || builderTokens.length === 0}
                                    className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-bauhaus-muted text-bauhaus-black font-mono font-bold border-2 border-bauhaus-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-bauhaus-black/10 active:translate-x-[1px] active:translate-y-[1px] transition-all duration-200 [-webkit-tap-highlight-color:transparent]"
                                >
                                    2
                                </button>
                                <button
                                    type="button"
                                    data-testid="cube-builder-mod-backspace"
                                    onClick={backspaceToken}
                                    disabled={scrambleBusy || builderTokens.length === 0}
                                    className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-bauhaus-muted text-bauhaus-black font-bold border-2 border-bauhaus-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-bauhaus-black/10 active:translate-x-[1px] active:translate-y-[1px] transition-all duration-200 [-webkit-tap-highlight-color:transparent]"
                                >
                                    ⌫
                                </button>
                                <button
                                    type="button"
                                    data-testid="cube-builder-mod-clear"
                                    onClick={clearBuilderTokens}
                                    disabled={scrambleBusy || builderTokens.length === 0}
                                    className="min-h-[44px] px-3 rounded-xl bg-bauhaus-muted text-bauhaus-black text-sm font-bold border-2 border-bauhaus-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-bauhaus-black/10 active:translate-x-[1px] active:translate-y-[1px] transition-all duration-200 [-webkit-tap-highlight-color:transparent]"
                                >
                                    清空
                                </button>
                            </div>
                            {builderError && (
                                <p className="text-sm text-bauhaus-red flex items-center gap-1.5" data-testid="cube-builder-error">
                                    <AlertTriangle className="w-4 h-4 shrink-0" />
                                    {builderError}
                                </p>
                            )}
                            <button
                                type="button"
                                data-testid="cube-builder-apply"
                                onClick={handleBuilderApply}
                                disabled={scrambleBusy || builderTokens.length === 0}
                                className="w-full sm:w-auto px-4 py-2.5 min-h-[44px] rounded-xl border-2 border-bauhaus-black shadow-hard-sm bg-bauhaus-black text-white text-sm font-bold uppercase tracking-wide disabled:opacity-40 disabled:cursor-not-allowed hover:bg-bauhaus-black/90 transition-all duration-200 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none [-webkit-tap-highlight-color:transparent]"
                            >
                                {scrambling ? '套用中…' : '套用此打亂'}
                            </button>
                        </div>
                    )}
                </div>

                {/* B. 3D 舞台 */}
                <div className="mt-5 pt-5 border-t-2 border-bauhaus-black/10">
                    <div className="relative">
                        <div ref={stageRef} className="w-full h-72 sm:h-80 rounded-2xl border-2 border-bauhaus-black bg-bauhaus-muted select-none" />
                        <span
                            data-testid="cube-status-pill"
                            className={`absolute top-3 right-3 px-3 py-1 rounded-full text-xs font-bold ${cubeStatusClasses}`}
                        >
                            {cubeStatusLabel}
                        </span>
                    </div>
                    <p className="text-center text-xs text-bauhaus-black/50 mt-2">按住拖曳可旋轉視角</p>
                </div>

                {/* C. 計時器 hero */}
                <div className="mt-5 pt-5 border-t-2 border-bauhaus-black/10 text-center">
                    <div
                        data-testid="cube-timer-display"
                        className={`text-5xl sm:text-6xl font-black tabular-nums font-mono transition-colors duration-200 ${
                            phase === 'armed' || phase === 'paused' ? 'text-bauhaus-yellow' : 'text-bauhaus-black'
                        }`}
                    >
                        {formatCubeTime(displayMs)}
                    </div>
                    <p className="text-sm text-bauhaus-black/50 mt-2" data-testid="cube-status-text">{statusText}</p>

                    {lastResult && (
                        <div className="mt-3" data-testid="cube-result-panel">
                            <div className="flex items-baseline justify-center gap-3 flex-wrap">
                                <span className="text-2xl font-black tabular-nums font-mono text-bauhaus-blue" data-testid="cube-result-time">
                                    {formatCubeTime(lastResult.timeMs)}
                                </span>
                                {lastResult.moveCount != null && <span className="text-sm text-bauhaus-black/50">{lastResult.moveCount} 步</span>}
                                <span className="text-xs text-bauhaus-black/60 font-bold px-2 py-0.5 rounded-full bg-bauhaus-muted border-2 border-bauhaus-black/10">
                                    {lastResult.mode === 'physical' ? '實體計時' : '鍵盤模式'}
                                </span>
                            </div>
                            {!submitted && (
                                <div className="mt-3 max-w-xs mx-auto" data-testid="cube-submit-visibility">
                                    <div className="flex border-2 border-bauhaus-black divide-x-2 divide-bauhaus-black">
                                        <button
                                            type="button"
                                            onClick={() => setSubmitPublic(true)}
                                            disabled={submitting}
                                            data-testid="cube-submit-public-btn"
                                            aria-pressed={submitPublic}
                                            className={`flex-1 px-3 py-2 min-h-[44px] text-xs font-bold uppercase tracking-wide transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${
                                                submitPublic ? 'bg-bauhaus-blue text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
                                            }`}
                                        >
                                            公開到排行榜
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setSubmitPublic(false)}
                                            disabled={submitting}
                                            data-testid="cube-submit-private-btn"
                                            aria-pressed={!submitPublic}
                                            className={`flex-1 px-3 py-2 min-h-[44px] text-xs font-bold uppercase tracking-wide transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${
                                                !submitPublic ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
                                            }`}
                                        >
                                            只存自己的紀錄
                                        </button>
                                    </div>
                                    <p className="text-xs text-bauhaus-black/50 mt-1.5" data-testid="cube-submit-visibility-hint">
                                        {submitPublic ? '會出現在排行榜上，其他老師看得到你的名次。' : '只有你自己看得到這筆成績，不會上排行榜。'}
                                    </p>
                                </div>
                            )}
                            {submitError && (
                                <p className="text-sm text-bauhaus-red mt-2 flex items-center justify-center gap-1.5">
                                    <AlertTriangle className="w-4 h-4 shrink-0" />
                                    {submitError}
                                </p>
                            )}
                            {submitted && (
                                <div className="mt-2">
                                    <p className="text-sm text-bauhaus-blue font-bold" data-testid="cube-submit-success">
                                        {lastSubmitWasPublic ? '已送出，排行榜已更新！' : '已存入你的紀錄（未公開）'}
                                    </p>
                                    {submitDowngradeNotice && (
                                        <p className="text-xs text-bauhaus-black/40 mt-1" data-testid="cube-submit-downgrade-notice">
                                            {submitDowngradeNotice}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="mt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
                        <button
                            type="button"
                            data-testid="cube-primary-action"
                            {...primaryHandlers}
                            disabled={primaryDisabled}
                            className={`w-full sm:w-auto px-8 min-h-[56px] rounded-xl border-2 border-bauhaus-black shadow-hard font-bold uppercase tracking-wide transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed active:translate-x-[2px] active:translate-y-[2px] active:shadow-none [-webkit-tap-highlight-color:transparent] ${primaryColorClass}`}
                        >
                            {primaryLabel}
                        </button>
                        {secondaryLabel && (
                            <button
                                type="button"
                                data-testid="cube-secondary-action"
                                {...secondaryHandlers}
                                className={`px-5 py-3 min-h-[44px] rounded-xl border-2 border-bauhaus-black font-bold uppercase tracking-wide transition-colors duration-200 [-webkit-tap-highlight-color:transparent] ${secondaryColorClass}`}
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
                            className="mt-3 inline-block py-2 px-1 text-sm font-bold text-bauhaus-black/40 hover:text-bauhaus-black underline underline-offset-2 [-webkit-tap-highlight-color:transparent]"
                        >
                            不算
                        </button>
                    )}
                </div>
            </section>

            {/* 螢幕轉面按鈕區（僅鍵盤模式，可收合）── 2026-07-09 鍵帽（keycap）重新設計：
                獨立鍵帽取代舊版「格子包兩顆小鈕」，各組用邊框/底色微調區分語意。 */}
            {isVirtual && (
                <section className="bg-white rounded-2xl border-2 lg:border-4 border-bauhaus-black shadow-hard p-5 sm:p-6 mb-6">
                    <button
                        type="button"
                        onClick={() => setFaceSectionOpen((v) => !v)}
                        data-testid="cube-face-toggle"
                        className="w-full flex items-center justify-between gap-3"
                    >
                        <span className="font-bold text-bauhaus-black">🖱 螢幕按鈕</span>
                        <span className="text-xs text-bauhaus-black/40 font-bold">{faceSectionOpen ? '收合 ▲' : '展開 ▼'}</span>
                    </button>

                    {faceSectionOpen && (
                        <div className="mt-4 space-y-5">
                            <p className="hidden md:block text-center text-xs text-bauhaus-black/50" data-testid="cube-key-legend">
                                {legendText}
                            </p>

                            {/* 轉面：第一排順轉、第二排逆轉，同欄同字母；375px 下自動改 3 欄 4 排 */}
                            <div>
                                <p className="text-xs font-bold text-bauhaus-black/40 mb-2">轉面</p>
                                <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 sm:gap-2" data-testid="cube-face-keycaps">
                                    {tileOrder.map((letter) => {
                                        const def = MOVE_TABLE[letter];
                                        return (
                                            <Keycap
                                                key={`${letter}-cw`}
                                                label={letter}
                                                tint="face"
                                                onClick={() => handleFaceTurn(def.axis, def.layer, def.dir)}
                                                disabled={turnButtonsDisabled}
                                                ariaLabel={`${letter} 順轉`}
                                                testId={`cube-btn-${letter}`}
                                            />
                                        );
                                    })}
                                    {tileOrder.map((letter) => {
                                        const def = MOVE_TABLE[letter];
                                        return (
                                            <Keycap
                                                key={`${letter}-ccw`}
                                                label={`${letter}'`}
                                                tint="face"
                                                onClick={() => handleFaceTurn(def.axis, def.layer, -def.dir)}
                                                disabled={turnButtonsDisabled}
                                                ariaLabel={`${letter} 逆轉`}
                                                testId={`cube-btn-${letter}-prime`}
                                            />
                                        );
                                    })}
                                </div>
                            </div>

                            {/* 中層 + 翻面 並排 */}
                            <div className="grid grid-cols-2 gap-2 sm:gap-4">
                                <div>
                                    <p className="text-xs font-bold text-bauhaus-blue mb-2">中層</p>
                                    <div className="grid grid-cols-3 gap-1 sm:gap-1.5" data-testid="cube-mid-keycaps">
                                        {MID_LETTERS.map((letter) => {
                                            const def = MOVE_TABLE[letter];
                                            return (
                                                <Keycap
                                                    key={`${letter}-cw`}
                                                    label={letter}
                                                    tint="mid"
                                                    onClick={() => handleFaceTurn(def.axis, def.layer, def.dir)}
                                                    disabled={turnButtonsDisabled}
                                                    ariaLabel={`${letter} 順轉`}
                                                    testId={`cube-btn-${letter}`}
                                                />
                                            );
                                        })}
                                        {MID_LETTERS.map((letter) => {
                                            const def = MOVE_TABLE[letter];
                                            return (
                                                <Keycap
                                                    key={`${letter}-ccw`}
                                                    label={`${letter}'`}
                                                    tint="mid"
                                                    onClick={() => handleFaceTurn(def.axis, def.layer, -def.dir)}
                                                    disabled={turnButtonsDisabled}
                                                    ariaLabel={`${letter} 逆轉`}
                                                    testId={`cube-btn-${letter}-prime`}
                                                />
                                            );
                                        })}
                                    </div>
                                </div>
                                <div>
                                    <p className="text-xs font-bold text-bauhaus-black/60 mb-2">翻面（換視角，不計步）</p>
                                    <div className="grid grid-cols-3 gap-1 sm:gap-1.5" data-testid="cube-twist-keycaps">
                                        {TWIST_LETTERS.map((letter) => {
                                            const def = MOVE_TABLE[letter];
                                            return (
                                                <Keycap
                                                    key={`${letter}-cw`}
                                                    label={letter}
                                                    tint="twist"
                                                    onClick={() => handleFaceTurn(def.axis, def.layer, def.dir, false)}
                                                    disabled={turnButtonsDisabled}
                                                    ariaLabel={`整顆換視角 ${letter}`}
                                                    testId={`cube-btn-${letter}`}
                                                />
                                            );
                                        })}
                                        {TWIST_LETTERS.map((letter) => {
                                            const def = MOVE_TABLE[letter];
                                            return (
                                                <Keycap
                                                    key={`${letter}-ccw`}
                                                    label={`${letter}'`}
                                                    tint="twist"
                                                    onClick={() => handleFaceTurn(def.axis, def.layer, -def.dir, false)}
                                                    disabled={turnButtonsDisabled}
                                                    ariaLabel={`整顆換視角 ${letter} 反向`}
                                                    testId={`cube-btn-${letter}-prime`}
                                                />
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            {/* 寬層：預設收合，展開後跟隨轉面自訂順序（R 排第一，Rw 也排第一） */}
                            <div>
                                <button
                                    type="button"
                                    onClick={() => setWideSectionOpen((v) => !v)}
                                    data-testid="cube-wide-toggle"
                                    className="w-full flex items-center justify-between gap-3 text-xs font-bold text-bauhaus-black/50 [-webkit-tap-highlight-color:transparent]"
                                >
                                    <span>進階・寬層轉</span>
                                    <span>{wideSectionOpen ? '收合 ▲' : '展開 ▼'}</span>
                                </button>
                                {wideSectionOpen && (
                                    <div className="mt-2">
                                        <p className="text-[11px] text-bauhaus-black/40 mb-2">寬層＝外層＋中層一起轉</p>
                                        <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 sm:gap-2" data-testid="cube-wide-keycaps">
                                            {wideOrder.map((letter) => {
                                                const def = MOVE_TABLE[letter];
                                                return (
                                                    <Keycap
                                                        key={`${letter}-cw`}
                                                        label={letter}
                                                        tint="wide"
                                                        onClick={() => handleFaceTurn(def.axis, def.layer, def.dir)}
                                                        disabled={turnButtonsDisabled}
                                                        ariaLabel={`${letter} 順轉`}
                                                        testId={`cube-btn-${letter}`}
                                                    />
                                                );
                                            })}
                                            {wideOrder.map((letter) => {
                                                const def = MOVE_TABLE[letter];
                                                return (
                                                    <Keycap
                                                        key={`${letter}-ccw`}
                                                        label={`${letter}'`}
                                                        tint="wide"
                                                        onClick={() => handleFaceTurn(def.axis, def.layer, -def.dir)}
                                                        disabled={turnButtonsDisabled}
                                                        ariaLabel={`${letter} 逆轉`}
                                                        testId={`cube-btn-${letter}-prime`}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </section>
            )}

            {/* 成績與紀錄 */}
            <section className="grid md:grid-cols-2 gap-6 mb-6">
                <div className="bg-white rounded-2xl border-2 lg:border-4 border-bauhaus-black shadow-hard p-5 sm:p-6">
                    <h2 className="font-bold text-bauhaus-black mb-3">
                        排行榜 Top 10 <span className="text-xs text-bauhaus-black/40 font-normal">・{isVirtual ? '鍵盤模式' : '實體計時'}</span>
                    </h2>
                    {leaderboardState === 'loading' && <p className="text-sm text-bauhaus-black/40">載入中…</p>}
                    {leaderboardState === 'unavailable' && <p className="text-sm text-bauhaus-black/40">排行榜功能待資料庫更新後開放。</p>}
                    {leaderboardState === 'error' && (
                        <p className="text-sm text-bauhaus-red flex items-center gap-1.5">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            排行榜載入失敗，請稍後再試。
                        </p>
                    )}
                    {leaderboardState === 'ok' && (
                        leaderboard.length === 0 ? (
                            <p className="text-sm text-bauhaus-black/40">還沒有人送出成績，當第一個吧！</p>
                        ) : (
                            <div className="divide-y-2 divide-bauhaus-black/10">
                                {leaderboard.slice(0, 10).map((row) => {
                                    const isMe = row.user_id === user?.id;
                                    return (
                                        <div key={row.user_id} className={`flex items-center gap-3 py-2.5 ${isMe ? 'bg-bauhaus-blue/10 -mx-2 px-2' : ''}`}>
                                            <span className={`w-8 text-center font-black tabular-nums ${isMe ? 'text-bauhaus-blue' : 'text-bauhaus-black/30'}`}>{row.rank}</span>
                                            <span className={`flex-1 truncate font-bold ${isMe ? 'text-bauhaus-blue' : 'text-bauhaus-black'}`}>{row.display_name || '匿名老師'}</span>
                                            <span className={`font-mono font-black tabular-nums ${isMe ? 'text-bauhaus-blue' : 'text-bauhaus-black'}`}>{formatCubeTime(row.best_ms)}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )
                    )}
                </div>

                <div className="bg-white rounded-2xl border-2 lg:border-4 border-bauhaus-black shadow-hard p-5 sm:p-6">
                    <h2 className="font-bold text-bauhaus-black mb-3">我的紀錄</h2>
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
                    <p className="text-[11px] text-bauhaus-black/30 mb-3" data-testid="cube-stats-note">統計含未公開成績；排行榜只計公開。</p>
                    <div>
                        <div className="text-xs text-bauhaus-black/40 font-bold mb-1">我的最近 5 次</div>
                        {myStatsState === 'ok' && myRecent.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {myRecent.slice(0, 5).map((r) => (
                                    <span key={r.id} className="px-2 py-1 rounded-lg border-2 border-bauhaus-black/10 bg-bauhaus-muted text-bauhaus-black text-xs font-mono font-bold">{formatCubeTime(r.time_ms)}</span>
                                ))}
                            </div>
                        )}
                        {myStatsState === 'ok' && myRecent.length === 0 && <span className="text-sm text-bauhaus-black/40">還沒有紀錄</span>}
                    </div>

                    {/* 完整歷史：預設收合，展開後依模式過濾、依時間新到舊分頁載入（每頁 20 筆） */}
                    <div className="mt-4 pt-4 border-t-2 border-bauhaus-black/10">
                        <button
                            type="button"
                            onClick={toggleHistory}
                            data-testid="cube-history-toggle"
                            className="w-full flex items-center justify-between gap-3"
                        >
                            <span className="text-xs font-bold text-bauhaus-black/60">完整歷史</span>
                            <span className="text-xs text-bauhaus-black/40 font-bold">{historyOpen ? '收合 ▲' : '展開 ▼'}</span>
                        </button>

                        {historyOpen && (
                            <div className="mt-3" data-testid="cube-history-panel">
                                {historyState === 'loading' && historyRows.length === 0 && (
                                    <p className="text-sm text-bauhaus-black/40 py-2">載入中…</p>
                                )}
                                {historyState === 'error' && (
                                    <p className="text-sm text-bauhaus-red py-2 flex items-center gap-1.5">
                                        <AlertTriangle className="w-4 h-4 shrink-0" />
                                        載入失敗，請稍後再試。
                                    </p>
                                )}
                                {historyState === 'ok' && historyRows.length === 0 && (
                                    <p className="text-sm text-bauhaus-black/40 py-2" data-testid="cube-history-empty">還沒有紀錄，解一顆吧</p>
                                )}
                                {historyRows.length > 0 && (
                                    <div data-testid="cube-history-rows">
                                        {historyRows.map((row) => (
                                            <div
                                                key={row.id}
                                                data-testid={`cube-history-row-${row.id}`}
                                                className="flex flex-wrap items-center gap-x-3 gap-y-1 min-h-[44px] py-2 border-b border-bauhaus-black/10 last:border-b-0"
                                            >
                                                <span className="font-mono font-black text-sm sm:text-base tabular-nums text-bauhaus-black" data-testid="cube-history-row-time">
                                                    {formatCubeTime(row.time_ms)}
                                                </span>
                                                <span className="text-xs text-bauhaus-black/50 font-mono">{formatHistoryDateTime(row.created_at)}</span>
                                                {row.move_count != null && (
                                                    <span className="text-xs text-bauhaus-black/40">{row.move_count} 步</span>
                                                )}
                                                <span
                                                    data-testid="cube-history-row-visibility"
                                                    className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border-2 uppercase tracking-wide ${
                                                        row.is_public === false
                                                            ? 'bg-bauhaus-muted text-bauhaus-black/50 border-bauhaus-black/20'
                                                            : 'bg-bauhaus-blue/10 text-bauhaus-blue border-bauhaus-blue'
                                                    }`}
                                                >
                                                    {row.is_public === false ? '私人' : '公開'}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {historyRows.length > 0 && (
                                    historyHasMore ? (
                                        <button
                                            type="button"
                                            data-testid="cube-history-load-more"
                                            onClick={() => loadHistoryPage(mode, historyOffset)}
                                            disabled={historyState === 'loading'}
                                            className="mt-2 w-full py-2 min-h-[44px] rounded-xl border-2 border-bauhaus-black bg-white text-sm font-bold text-bauhaus-black hover:bg-bauhaus-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-200"
                                        >
                                            {historyState === 'loading' ? '載入中…' : '載入更多'}
                                        </button>
                                    ) : (
                                        <p className="text-xs text-bauhaus-black/30 text-center mt-2" data-testid="cube-history-end">到底了</p>
                                    )
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </section>

            {/* 設定（按鍵設定＋按鈕排列，移到頁面最下方，可摺疊） */}
            <section className="bg-white rounded-2xl border-2 lg:border-4 border-bauhaus-black shadow-hard p-5 sm:p-6">
                <button
                    type="button"
                    onClick={() => setKeySettingsOpen((v) => !v)}
                    data-testid="cube-key-settings-toggle"
                    className="w-full flex items-center justify-between gap-3"
                >
                    <span className="font-bold text-bauhaus-black flex items-center gap-2">
                        <KeyRound className="w-4 h-4 text-bauhaus-black/40" />
                        按鍵設定
                    </span>
                    <span className="text-xs text-bauhaus-black/40 font-bold">{keySettingsOpen ? '收合 ▲' : '展開 ▼'}</span>
                </button>

                {keySettingsOpen && (
                    <div className="mt-4 space-y-5">
                        {conflictMsg && (
                            <p className="text-sm text-bauhaus-red flex items-center gap-1.5" data-testid="cube-keymap-conflict">
                                <AlertTriangle className="w-4 h-4 shrink-0" />
                                {conflictMsg}
                            </p>
                        )}
                        {capturingAction && (
                            <p className="text-sm text-bauhaus-blue font-bold">請按下想綁定的新按鍵…（Esc 取消）</p>
                        )}
                        <div>
                            <h3 className="text-xs font-bold text-bauhaus-black/40 mb-2">轉面（僅鍵盤模式作用，代號＝國際標準轉法記號）</h3>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {FACE_TURN_ACTIONS.map((a) => (
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
                            <h3 className="text-xs font-bold text-bauhaus-black/40 mb-2">中層</h3>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {MID_ACTIONS.map((a) => (
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
                            <h3 className="text-xs font-bold text-bauhaus-black/40 mb-2">翻面（換視角，不計步）</h3>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {TWIST_ACTIONS.map((a) => (
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
                            <h3 className="text-xs font-bold text-bauhaus-black/40 mb-2">寬層（外層＋中層一起轉；預設未設定，可自行綁定）</h3>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {WIDE_ACTIONS.map((a) => (
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
                            <h3 className="text-xs font-bold text-bauhaus-black/40 mb-2">控制</h3>
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
                            <h3 className="text-xs font-bold text-bauhaus-black/40 mb-2">
                                按鈕排列（轉面 6 字母順序；M/E/S 中層固定、x/y/z 翻面固定、寬層跟隨此順序，皆不參與排序）
                            </h3>
                            <div className="space-y-1.5 max-w-xs">
                                {tileOrder.map((letter, idx) => (
                                    <div
                                        key={letter}
                                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border-2 border-bauhaus-black bg-white"
                                        data-testid={`cube-tile-order-row-${letter}`}
                                    >
                                        <span className="font-mono font-bold text-bauhaus-black">{letter}</span>
                                        <div className="flex gap-1">
                                            <button
                                                type="button"
                                                onClick={() => moveTile(letter, -1)}
                                                disabled={idx === 0}
                                                aria-label={`${letter} 往左移`}
                                                data-testid={`cube-tile-move-left-${letter}`}
                                                className="p-1.5 rounded-xl bg-white border-2 border-bauhaus-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-bauhaus-muted"
                                            >
                                                <ChevronLeft className="w-4 h-4" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => moveTile(letter, 1)}
                                                disabled={idx === tileOrder.length - 1}
                                                aria-label={`${letter} 往右移`}
                                                data-testid={`cube-tile-move-right-${letter}`}
                                                className="p-1.5 rounded-xl bg-white border-2 border-bauhaus-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-bauhaus-muted"
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
                            className="px-4 py-2 rounded-xl border-2 border-bauhaus-black bg-bauhaus-muted text-bauhaus-black text-sm font-bold hover:bg-bauhaus-black/10 transition-colors duration-200 flex items-center gap-1.5"
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
