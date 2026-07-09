import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import { BADGE_CATEGORIES, CATEGORY_ORDER } from '../../lib/badges';
import BadgeVisual from '../../components/BadgeVisual';
import { compressImage } from '../../lib/imageCompress';
import {
    Award, Plus, Edit2, Trash2, Eye, EyeOff, X, Save, Search, ChevronDown,
    CircleCheck, CircleX, RotateCcw, Sparkles, ImageUp, ImageOff,
} from 'lucide-react';

// rule_metric 下拉：對應 get_teacher_badge_stats 欄位。lteDefault=true 代表「越小越好」，
// 新增時預設 operator 選 lte（例如秒數、名次類指標）。
const METRIC_OPTIONS = [
    { value: 'total_hours', label: '接課時數', lteDefault: false },
    { value: 'session_count', label: '場次', lteDefault: false },
    { value: 'student_reach', label: '觸及人次', lteDefault: false },
    { value: 'course_type_count', label: '課型數', lteDefault: false },
    { value: 'lead_count', label: '主講場次', lteDefault: false },
    { value: 'assistant_count', label: '助教場次', lteDefault: false },
    { value: 'region_count', label: '縣市數', lteDefault: false },
    { value: 'tenure_years', label: '年資', lteDefault: false },
    { value: 'wca_event_count', label: 'WCA 項目數', lteDefault: false },
    { value: 'wca_333_single', label: '3x3 單次成績（cs，越小越好）', lteDefault: true },
    { value: 'cube_best_ms', label: '競速最佳成績（ms，越小越好）', lteDefault: true },
    { value: 'cube_keyboard_solves', label: '鍵盤解次數', lteDefault: false },
    { value: 'max_day_sessions', label: '單日最多場', lteDefault: false },
    { value: 'max_session_hours', label: '單場最長時數', lteDefault: false },
    { value: 'streak_months', label: '連續月數', lteDefault: false },
];
const METRIC_MAP = Object.fromEntries(METRIC_OPTIONS.map((m) => [m.value, m]));

const EMPTY_FORM = {
    key: '', emoji: '', name: '', category: 'teaching', description: '',
    rule_type: 'threshold', rule_metric: 'total_hours', rule_operator: 'gte', rule_threshold: '',
    active: true, image_path: null,
};

function ruleSummary(def) {
    if (def.rule_type === 'threshold') {
        const label = METRIC_MAP[def.rule_metric]?.label || def.rule_metric || '（未設定）';
        const op = def.rule_operator === 'lte' ? '≤' : '≥';
        return `${label} ${op} ${def.rule_threshold ?? '—'}`;
    }
    if (def.rule_type === 'special') return `特殊判定：${def.rule_special || '—'}（程式寫死）`;
    return '純手動頒發';
}

const sortDefs = (defs) => [...(defs || [])].sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
});

const BadgeManager = () => {
    const { user } = useAuth();
    const [tab, setTab] = useState('list'); // 'list' | 'grant'

    // ── 分頁 A：徽章清單 ──────────────────────────────────────────────
    const [definitions, setDefinitions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingKey, setEditingKey] = useState(null); // 'new' | 現有 key
    const [form, setForm] = useState(EMPTY_FORM);
    const [formErr, setFormErr] = useState('');
    const [saving, setSaving] = useState(false);
    const [uploadingIcon, setUploadingIcon] = useState(false);

    // 上傳徽章圖示：壓縮到 256px PNG，存進公開 bucket badge_icons，成功後把
    // image_path 寫進表單 state（真正落地 badge_definitions 要按「儲存」）。
    // 若表單已有舊圖，換圖時順手清掉舊檔（非必要但避免孤兒檔案堆積）。
    const handleIconUpload = async (file) => {
        if (!file) return;
        setFormErr('');
        setUploadingIcon(true);
        try {
            const blob = await compressImage(file, 256);
            const path = `badges/${form.key || 'new'}-${crypto.randomUUID()}.png`;
            const { error } = await supabase.storage.from('badge_icons').upload(path, blob, {
                upsert: true,
                contentType: 'image/png',
            });
            if (error) { setFormErr('圖示上傳失敗：' + error.message); return; }
            const oldPath = form.image_path;
            setForm((f) => ({ ...f, image_path: path }));
            if (oldPath) await supabase.storage.from('badge_icons').remove([oldPath]);
        } catch (err) {
            setFormErr('圖示處理失敗：' + err.message);
        } finally {
            setUploadingIcon(false);
        }
    };

    const handleIconRemove = async () => {
        const oldPath = form.image_path;
        setForm((f) => ({ ...f, image_path: null }));
        if (oldPath) await supabase.storage.from('badge_icons').remove([oldPath]);
    };

    const fetchDefinitions = async () => {
        setLoading(true);
        const { data, error } = await supabase.from('badge_definitions').select('*');
        if (error) console.error('讀取徽章清單失敗', error);
        setDefinitions(sortDefs(data));
        setLoading(false);
    };

    useEffect(() => {
        (async () => {
            setLoading(true);
            const { data, error } = await supabase.from('badge_definitions').select('*');
            if (error) console.error('讀取徽章清單失敗', error);
            setDefinitions(sortDefs(data));
            setLoading(false);
        })();
    }, []);

    const editingDef = editingKey && editingKey !== 'new'
        ? definitions.find((d) => d.key === editingKey)
        : null;
    const isSpecial = editingDef?.rule_type === 'special';

    const openCreate = () => {
        setEditingKey('new');
        setForm(EMPTY_FORM);
        setFormErr('');
        setModalOpen(true);
    };

    const openEdit = (def) => {
        setEditingKey(def.key);
        setForm({
            key: def.key,
            emoji: def.emoji || '',
            name: def.name || '',
            category: def.category || 'teaching',
            description: def.description || '',
            rule_type: def.rule_type,
            rule_metric: def.rule_metric || 'total_hours',
            rule_operator: def.rule_operator || 'gte',
            rule_threshold: def.rule_threshold ?? '',
            active: !!def.active,
            image_path: def.image_path || null,
        });
        setFormErr('');
        setModalOpen(true);
    };

    const closeModal = () => {
        setModalOpen(false);
        setEditingKey(null);
        setForm(EMPTY_FORM);
        setFormErr('');
    };

    const handleMetricChange = (metric) => {
        const m = METRIC_MAP[metric];
        setForm((f) => ({ ...f, rule_metric: metric, rule_operator: m?.lteDefault ? 'lte' : 'gte' }));
    };

    const handleSave = async () => {
        setFormErr('');
        if (!form.name.trim()) return setFormErr('請填寫名稱');
        if (!form.emoji.trim()) return setFormErr('請填寫 emoji');
        if (editingKey === 'new') {
            if (!/^[a-zA-Z0-9_]+$/.test(form.key.trim())) return setFormErr('key 只能是英數與底線，且必填');
        }
        if (!isSpecial && form.rule_type === 'threshold') {
            if (!form.rule_metric) return setFormErr('請選擇判定指標');
            if (form.rule_threshold === '' || Number.isNaN(Number(form.rule_threshold))) return setFormErr('請填寫門檻數值');
        }

        setSaving(true);
        const basePayload = {
            emoji: form.emoji.trim(),
            name: form.name.trim(),
            category: form.category,
            description: form.description.trim() || null,
            active: form.active,
            image_path: form.image_path || null,
        };

        let payload;
        if (isSpecial) {
            // special 徽章：判定邏輯不可改，只准改名稱/emoji/說明/分類/啟用
            payload = basePayload;
        } else if (form.rule_type === 'threshold') {
            payload = {
                ...basePayload,
                rule_type: 'threshold',
                rule_metric: form.rule_metric,
                rule_operator: form.rule_operator,
                rule_threshold: Number(form.rule_threshold),
                rule_special: null,
            };
        } else {
            payload = {
                ...basePayload,
                rule_type: 'manual',
                rule_metric: null,
                rule_operator: 'gte',
                rule_threshold: null,
                rule_special: null,
            };
        }

        let error;
        if (editingKey === 'new') {
            ({ error } = await supabase.from('badge_definitions').insert({ key: form.key.trim(), sort_order: definitions.length, ...payload }));
        } else {
            ({ error } = await supabase.from('badge_definitions').update(payload).eq('key', editingKey));
        }
        setSaving(false);
        if (error) { setFormErr('儲存失敗：' + error.message); return; }
        closeModal();
        fetchDefinitions();
    };

    const toggleActive = async (def) => {
        const next = !def.active;
        setDefinitions((defs) => defs.map((d) => (d.key === def.key ? { ...d, active: next } : d)));
        const { error } = await supabase.from('badge_definitions').update({ active: next }).eq('key', def.key);
        if (error) {
            alert('切換啟用狀態失敗：' + error.message);
            setDefinitions((defs) => defs.map((d) => (d.key === def.key ? { ...d, active: !next } : d)));
        }
    };

    const handleDelete = async (def) => {
        if (!window.confirm(`確定要刪除徽章「${def.name}」嗎？\n所有講師曾被手動頒發/收回過這個徽章的紀錄也會一併被刪除（無法復原）。建議優先考慮「停用」而不是刪除。`)) return;
        const { error } = await supabase.from('badge_definitions').delete().eq('key', def.key);
        if (error) { alert('刪除失敗：' + error.message); return; }
        setDefinitions((defs) => defs.filter((d) => d.key !== def.key));
    };

    // ── 分頁 B：手動頒發／收回 ────────────────────────────────────────
    const [instructors, setInstructors] = useState([]);
    const [instructorsLoaded, setInstructorsLoaded] = useState(false);
    const [instructorSearch, setInstructorSearch] = useState('');
    const [showDropdown, setShowDropdown] = useState(false);
    const [selectedInstructor, setSelectedInstructor] = useState(null);
    const [overrideMap, setOverrideMap] = useState({}); // badge_key -> 'granted'|'revoked'
    const [overrideLoading, setOverrideLoading] = useState(false);
    const [actingKey, setActingKey] = useState(null);

    useEffect(() => {
        if (tab !== 'grant' || instructorsLoaded) return;
        (async () => {
            const { data } = await supabase.from('instructors').select('id, full_name, employment_status').order('full_name');
            setInstructors(data || []);
            setInstructorsLoaded(true);
        })();
    }, [tab, instructorsLoaded]);

    const filteredInstructors = useMemo(() => {
        const s = instructorSearch.trim().toLowerCase();
        if (!s) return instructors.slice(0, 30);
        return instructors.filter((i) => i.full_name?.toLowerCase().includes(s)).slice(0, 30);
    }, [instructors, instructorSearch]);

    const loadOverrides = async (instructorId) => {
        setOverrideLoading(true);
        const { data } = await supabase.from('badge_overrides').select('badge_key, state').eq('instructor_id', instructorId);
        setOverrideMap(Object.fromEntries((data || []).map((o) => [o.badge_key, o.state])));
        setOverrideLoading(false);
    };

    const selectInstructor = (inst) => {
        setSelectedInstructor(inst);
        setInstructorSearch(inst.full_name);
        setShowDropdown(false);
        loadOverrides(inst.id);
    };

    const setOverride = async (def, state) => {
        if (!selectedInstructor) return;
        setActingKey(def.key);
        const { error } = await supabase.from('badge_overrides').upsert({
            instructor_id: selectedInstructor.id,
            badge_key: def.key,
            state,
            created_by: user?.id || null,
        }, { onConflict: 'instructor_id,badge_key' });
        setActingKey(null);
        if (error) { alert('操作失敗：' + error.message); return; }
        setOverrideMap((m) => ({ ...m, [def.key]: state }));
    };

    const clearOverride = async (def) => {
        if (!selectedInstructor) return;
        setActingKey(def.key);
        const { error } = await supabase.from('badge_overrides')
            .delete().eq('instructor_id', selectedInstructor.id).eq('badge_key', def.key);
        setActingKey(null);
        if (error) { alert('清除失敗：' + error.message); return; }
        setOverrideMap((m) => { const n = { ...m }; delete n[def.key]; return n; });
    };

    const grantableBadges = useMemo(() => definitions.filter((d) => d.active), [definitions]);

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>;

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight flex items-center gap-2">
                    <Award className="w-7 h-7 lg:w-9 lg:h-9" /> 徽章管理
                </h1>
                <p className="text-bauhaus-black/60 font-medium mt-1">管理徽章清單規則，或手動頒發／收回特定講師的徽章</p>
            </div>

            {/* 分頁 tab */}
            <div className="inline-flex border-2 lg:border-4 border-bauhaus-black rounded-xl overflow-hidden divide-x-2 lg:divide-x-4 divide-bauhaus-black mb-6">
                <button
                    data-testid="badge-tab-list"
                    onClick={() => setTab('list')}
                    className={`min-h-[44px] px-4 sm:px-5 py-2.5 font-bold text-sm uppercase tracking-wide transition-colors ${tab === 'list' ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-cream'}`}
                >
                    徽章清單管理
                </button>
                <button
                    data-testid="badge-tab-grant"
                    onClick={() => setTab('grant')}
                    className={`min-h-[44px] px-4 sm:px-5 py-2.5 font-bold text-sm uppercase tracking-wide transition-colors ${tab === 'grant' ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-cream'}`}
                >
                    手動頒發／收回
                </button>
            </div>

            {tab === 'list' && (
                <div data-testid="badge-panel-list">
                    <div className="flex justify-end mb-4">
                        <button onClick={openCreate} className="bh-btn bh-btn-blue px-6 py-3">
                            <Plus className="w-5 h-5" /> 新增徽章
                        </button>
                    </div>

                    <div className="bh-card overflow-hidden">
                        {/* 手機卡片 */}
                        <div className="md:hidden divide-y-2 divide-bauhaus-black/20">
                            {definitions.map((def) => (
                                <div key={def.key} className="p-4">
                                    <div className="flex items-center gap-2">
                                        <BadgeVisual badge={def} size={36} className="shrink-0" />
                                        <div className="min-w-0 flex-1">
                                            <div className="font-bold text-bauhaus-black truncate">{def.name}</div>
                                            <div className="text-xs text-bauhaus-black/40">{BADGE_CATEGORIES[def.category]?.label || def.category}</div>
                                        </div>
                                    </div>
                                    <div className="text-xs text-bauhaus-black/60 mt-2">{ruleSummary(def)}</div>
                                    <div className="flex items-center justify-between mt-3">
                                        <button
                                            onClick={() => toggleActive(def)}
                                            className={`bh-chip ${def.active ? 'bg-bauhaus-blue text-white' : 'bg-bauhaus-muted text-bauhaus-black'}`}
                                        >
                                            {def.active ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                                            {def.active ? '啟用中' : '已停用'}
                                        </button>
                                        <div className="flex items-center gap-1">
                                            <button onClick={() => openEdit(def)} className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-bauhaus-black/40 hover:text-bauhaus-blue transition-colors">
                                                <Edit2 className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => handleDelete(def)} className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-bauhaus-black/40 hover:text-bauhaus-red transition-colors">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {definitions.length === 0 && (
                                <div className="py-16 text-center">
                                    <Sparkles className="w-10 h-10 text-bauhaus-black/20 mx-auto mb-3" />
                                    <p className="text-bauhaus-black/40 font-bold">尚未建立任何徽章</p>
                                </div>
                            )}
                        </div>

                        {/* 桌機表格 */}
                        <div className="hidden md:block overflow-x-auto">
                            <table className="w-full text-left">
                                <thead className="bg-bauhaus-black text-white text-xs font-bold uppercase tracking-wider">
                                    <tr>
                                        <th className="px-4 py-4">徽章</th>
                                        <th className="px-4 py-4">分類</th>
                                        <th className="px-4 py-4">類型</th>
                                        <th className="px-4 py-4">條件</th>
                                        <th className="px-4 py-4">狀態</th>
                                        <th className="px-4 py-4 text-right">操作</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y-2 divide-bauhaus-black/20">
                                    {definitions.map((def) => (
                                        <tr key={def.key} className="hover:bg-bauhaus-cream transition-colors">
                                            <td className="px-4 py-4">
                                                <div className="flex items-center gap-2">
                                                    <BadgeVisual badge={def} size={36} className="shrink-0" />
                                                    <div>
                                                        <div className="font-bold text-bauhaus-black">{def.name}</div>
                                                        <div className="text-[11px] text-bauhaus-black/40">{def.key}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-4 text-sm font-bold text-bauhaus-black/70">{BADGE_CATEGORIES[def.category]?.label || def.category}</td>
                                            <td className="px-4 py-4">
                                                <span className={`bh-chip ${def.rule_type === 'threshold' ? 'bg-bauhaus-blue text-white' : def.rule_type === 'special' ? 'bg-bauhaus-black text-white' : 'bg-bauhaus-muted text-bauhaus-black'}`}>
                                                    {def.rule_type === 'threshold' ? '里程碑' : def.rule_type === 'special' ? '特殊邏輯' : '純手動'}
                                                </span>
                                            </td>
                                            <td className="px-4 py-4 text-xs text-bauhaus-black/60 max-w-[220px]">{ruleSummary(def)}</td>
                                            <td className="px-4 py-4">
                                                <button
                                                    onClick={() => toggleActive(def)}
                                                    className={`bh-chip ${def.active ? 'bg-bauhaus-blue text-white' : 'bg-bauhaus-muted text-bauhaus-black'}`}
                                                >
                                                    {def.active ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                                                    {def.active ? '啟用中' : '已停用'}
                                                </button>
                                            </td>
                                            <td className="px-4 py-4 text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    <button onClick={() => openEdit(def)} className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-bauhaus-black/40 hover:text-bauhaus-blue transition-colors">
                                                        <Edit2 className="w-4 h-4" />
                                                    </button>
                                                    <button onClick={() => handleDelete(def)} className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-bauhaus-black/40 hover:text-bauhaus-red transition-colors">
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {definitions.length === 0 && (
                                <div className="py-16 text-center">
                                    <Sparkles className="w-10 h-10 text-bauhaus-black/20 mx-auto mb-3" />
                                    <p className="text-bauhaus-black/40 font-bold">尚未建立任何徽章</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {tab === 'grant' && (
                <div data-testid="badge-panel-grant">
                    <div className="bh-card p-4 sm:p-6 mb-6 relative">
                        <label className="bh-label block mb-1">選擇講師</label>
                        <div className="relative">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-bauhaus-black/40" />
                            <input
                                type="text"
                                data-testid="badge-instructor-search"
                                placeholder="輸入姓名搜尋⋯⋯"
                                value={instructorSearch}
                                onChange={(e) => { setInstructorSearch(e.target.value); setShowDropdown(true); if (selectedInstructor) setSelectedInstructor(null); }}
                                onFocus={() => setShowDropdown(true)}
                                className="bh-input pl-12 pr-10 py-3"
                            />
                            <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-bauhaus-black/30 pointer-events-none" />
                        </div>
                        {showDropdown && (
                            <div data-testid="badge-instructor-dropdown" className="absolute z-20 left-0 right-0 mt-1 mx-4 sm:mx-6 bg-white border-2 border-bauhaus-black rounded-2xl shadow-hard max-h-72 overflow-y-auto">
                                {filteredInstructors.length === 0 && (
                                    <div className="px-4 py-3 text-sm text-bauhaus-black/40 font-bold">查無符合的講師</div>
                                )}
                                {filteredInstructors.map((inst) => (
                                    <button
                                        key={inst.id}
                                        onClick={() => selectInstructor(inst)}
                                        className="w-full text-left px-4 py-3 hover:bg-bauhaus-cream transition-colors border-b border-bauhaus-black/10 last:border-b-0"
                                    >
                                        <span className="font-bold text-bauhaus-black">{inst.full_name}</span>
                                        {inst.employment_status && (
                                            <span className="ml-2 text-xs text-bauhaus-black/40">{inst.employment_status}</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {!selectedInstructor && (
                        <div className="py-16 text-center bg-bauhaus-paper border-2 border-dashed border-bauhaus-black/30 rounded-2xl">
                            <Award className="w-10 h-10 text-bauhaus-black/20 mx-auto mb-3" />
                            <p className="text-bauhaus-black/40 font-bold">請先搜尋並選擇一位講師</p>
                        </div>
                    )}

                    {selectedInstructor && (
                        <div data-testid="badge-grant-list" className="bh-card overflow-hidden">
                            <div className="p-4 border-b-2 lg:border-b-4 border-bauhaus-black flex items-center gap-2">
                                <span className="font-black text-bauhaus-black">{selectedInstructor.full_name}</span>
                                <span className="text-xs text-bauhaus-black/40">的徽章覆蓋設定</span>
                                {overrideLoading && <span className="text-xs text-bauhaus-black/30 ml-2">載入中...</span>}
                            </div>
                            <div className="divide-y-2 divide-bauhaus-black/20">
                                {grantableBadges.map((def) => {
                                    const state = overrideMap[def.key];
                                    const acting = actingKey === def.key;
                                    return (
                                        <div key={def.key} data-testid={`badge-grant-row-${def.key}`} className="p-4 flex flex-wrap items-center gap-3">
                                            <BadgeVisual badge={def} size={36} className="shrink-0" />
                                            <div className="min-w-[140px]">
                                                <div className="font-bold text-bauhaus-black text-sm">{def.name}</div>
                                                <div className="text-[11px] text-bauhaus-black/40">{BADGE_CATEGORIES[def.category]?.label}</div>
                                            </div>
                                            <span className={`bh-chip ${state === 'granted' ? 'bg-bauhaus-blue text-white' : state === 'revoked' ? 'bg-bauhaus-red text-white' : 'bg-bauhaus-muted text-bauhaus-black'}`}>
                                                {state === 'granted' ? '已頒發' : state === 'revoked' ? '已收回' : '依規則自動'}
                                            </span>
                                            <div className="flex items-center gap-2 ml-auto">
                                                <button
                                                    disabled={acting}
                                                    onClick={() => setOverride(def, 'granted')}
                                                    className="bh-btn bh-btn-blue px-3 py-2 text-xs disabled:opacity-50"
                                                >
                                                    <CircleCheck className="w-4 h-4" /> 頒發
                                                </button>
                                                <button
                                                    disabled={acting}
                                                    onClick={() => setOverride(def, 'revoked')}
                                                    className="bh-btn bh-btn-red px-3 py-2 text-xs disabled:opacity-50"
                                                >
                                                    <CircleX className="w-4 h-4" /> 收回
                                                </button>
                                                {state && (
                                                    <button
                                                        disabled={acting}
                                                        onClick={() => clearOverride(def)}
                                                        className="bh-btn bh-btn-outline px-3 py-2 text-xs disabled:opacity-50"
                                                    >
                                                        <RotateCcw className="w-4 h-4" /> 清除覆蓋
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* 新增／編輯 Modal */}
            {modalOpen && (
                <div className="fixed inset-0 z-50 bg-bauhaus-black/60 flex items-center justify-center p-4" onClick={closeModal}>
                    <div data-testid="badge-modal" className="bh-card shadow-hard-lg w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                        <div className="p-4 sm:p-5 border-b-2 lg:border-b-4 border-bauhaus-black flex items-center justify-between bg-bauhaus-black text-white">
                            <h3 className="font-black uppercase tracking-wide text-sm flex items-center gap-2">
                                <Award className="w-5 h-5" /> {editingKey === 'new' ? '新增徽章' : '編輯徽章'}
                            </h3>
                            <button onClick={closeModal} className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center hover:opacity-70">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-4 sm:p-6 space-y-4">
                            {formErr && (
                                <div className="bg-bauhaus-red/10 border-2 border-bauhaus-red px-3 py-2 text-sm font-bold text-bauhaus-red">{formErr}</div>
                            )}

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="bh-label block mb-1">Key（唯一識別）</label>
                                    <input
                                        type="text"
                                        value={form.key}
                                        disabled={editingKey !== 'new'}
                                        onChange={(e) => setForm({ ...form, key: e.target.value })}
                                        className="bh-input disabled:opacity-50"
                                        placeholder="hours_50"
                                    />
                                </div>
                                <div>
                                    <label className="bh-label block mb-1">Emoji</label>
                                    <input
                                        type="text"
                                        value={form.emoji}
                                        onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                                        className="bh-input"
                                        placeholder="🌱"
                                    />
                                    <p className="text-[11px] text-bauhaus-black/40 mt-1">沒上傳圖示時的備用顯示</p>
                                </div>
                            </div>

                            <div>
                                <label className="bh-label block mb-1">圖示（上傳 PNG，選填）</label>
                                <div className="flex items-center gap-3">
                                    <div className="w-14 h-14 shrink-0 rounded-full border-2 border-bauhaus-black bg-bauhaus-muted flex items-center justify-center overflow-hidden">
                                        <BadgeVisual badge={{ key: form.key, image_path: form.image_path }} size={52} />
                                    </div>
                                    <label className="bh-btn bh-btn-outline px-4 py-2 text-sm cursor-pointer">
                                        <ImageUp className="w-4 h-4" />
                                        {uploadingIcon ? '上傳中...' : (form.image_path ? '更換圖示' : '上傳圖示')}
                                        <input
                                            type="file"
                                            accept="image/png,image/*"
                                            className="hidden"
                                            disabled={uploadingIcon}
                                            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleIconUpload(f); }}
                                        />
                                    </label>
                                    {form.image_path && (
                                        <button
                                            type="button"
                                            onClick={handleIconRemove}
                                            disabled={uploadingIcon}
                                            className="bh-btn bh-btn-outline px-4 py-2 text-sm disabled:opacity-50"
                                        >
                                            <ImageOff className="w-4 h-4" /> 移除圖示
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div>
                                <label className="bh-label block mb-1">名稱</label>
                                <input
                                    type="text"
                                    value={form.name}
                                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                                    className="bh-input"
                                    placeholder="接課新星"
                                />
                            </div>

                            <div>
                                <label className="bh-label block mb-1">分類</label>
                                <select
                                    value={form.category}
                                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                                    className="bh-input"
                                >
                                    {CATEGORY_ORDER.map((cat) => (
                                        <option key={cat} value={cat}>{BADGE_CATEGORIES[cat].label}</option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="bh-label block mb-1">說明</label>
                                <textarea
                                    value={form.description}
                                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                                    className="bh-input min-h-[70px]"
                                    placeholder="接課滿 50 小時"
                                />
                            </div>

                            {isSpecial ? (
                                <div className="border-2 border-bauhaus-black/20 bg-bauhaus-muted rounded-xl p-3">
                                    <div className="text-xs font-bold text-bauhaus-black/60 mb-1">判定類型</div>
                                    <div className="text-sm font-bold text-bauhaus-black">特殊邏輯（程式寫死，不可在後台新增或修改判定條件）</div>
                                    <div className="text-xs text-bauhaus-black/50 mt-1">rule_special：{editingDef?.rule_special}</div>
                                </div>
                            ) : (
                                <>
                                    <div>
                                        <label className="bh-label block mb-1">判定類型</label>
                                        <select
                                            data-testid="badge-rule-type"
                                            value={form.rule_type}
                                            onChange={(e) => setForm({ ...form, rule_type: e.target.value })}
                                            className="bh-input"
                                        >
                                            <option value="threshold">里程碑（達到某統計門檻）</option>
                                            <option value="manual">純手動頒發</option>
                                        </select>
                                    </div>

                                    {form.rule_type === 'threshold' && (
                                        <div data-testid="badge-threshold-fields" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                            <div className="sm:col-span-2">
                                                <label className="bh-label block mb-1">判定指標</label>
                                                <select
                                                    data-testid="badge-rule-metric"
                                                    value={form.rule_metric}
                                                    onChange={(e) => handleMetricChange(e.target.value)}
                                                    className="bh-input"
                                                >
                                                    {METRIC_OPTIONS.map((m) => (
                                                        <option key={m.value} value={m.value}>{m.label}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div>
                                                <label className="bh-label block mb-1">比較</label>
                                                <select
                                                    data-testid="badge-rule-operator"
                                                    value={form.rule_operator}
                                                    onChange={(e) => setForm({ ...form, rule_operator: e.target.value })}
                                                    className="bh-input"
                                                >
                                                    <option value="gte">≥（越多越好）</option>
                                                    <option value="lte">≤（越少越好）</option>
                                                </select>
                                            </div>
                                            <div className="sm:col-span-3">
                                                <label className="bh-label block mb-1">門檻數值</label>
                                                <input
                                                    type="number"
                                                    data-testid="badge-rule-threshold"
                                                    value={form.rule_threshold}
                                                    onChange={(e) => setForm({ ...form, rule_threshold: e.target.value })}
                                                    className="bh-input"
                                                    placeholder="50"
                                                />
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}

                            <label className="flex items-center gap-2 text-sm font-bold text-bauhaus-black cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={form.active}
                                    onChange={(e) => setForm({ ...form, active: e.target.checked })}
                                    className="w-4 h-4 border-2 border-bauhaus-black rounded-none text-bauhaus-blue"
                                />
                                啟用（顯示在前台成就牆並參與判定）
                            </label>

                            <div className="flex justify-end pt-2">
                                <button onClick={handleSave} disabled={saving} className="bh-btn bh-btn-blue px-8 py-2.5 disabled:opacity-50">
                                    <Save className="w-4 h-4" /> {saving ? '儲存中...' : '儲存'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default BadgeManager;
