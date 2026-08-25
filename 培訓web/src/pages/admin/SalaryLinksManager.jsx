import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { ArrowLeft, Link2, Save, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { isSafeHttpUrl, TEACHING_MATERIALS_LINK } from '../../lib/siteLinks';

// 固定顯示順序（比資料庫預設排序更明確；未來若新增其他 key，補進這個陣列即可）。
const KNOWN_KEYS = [TEACHING_MATERIALS_LINK.key, 'salary_direct', 'salary_partner', 'salary_points'];

// 教材資源與備用報酬表單外連網址的後台編輯頁。資料表 site_links 由
// supabase/2026-07-09_site_links.sql 建立；表不存在時顯示明確提示而非空白頁。
const SalaryLinksManager = () => {
    const [loading, setLoading] = useState(true);
    const [tableMissing, setTableMissing] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [rows, setRows] = useState([]); // [{ key, label, description, url }]
    const [savingKey, setSavingKey] = useState(null);
    const [rowStatus, setRowStatus] = useState({}); // key -> { type: 'success'|'error', msg }
    const [rowError, setRowError] = useState({}); // key -> 驗證錯誤文字（url 格式）

    useEffect(() => {
        let active = true;
        (async () => {
            setLoading(true);
            setLoadError('');
            setTableMissing(false);
            const { data, error } = await supabase
                .from('site_links')
                .select('key, label, description, url, updated_at')
                .in('key', KNOWN_KEYS);

            if (!active) return;

            if (error) {
                // 42P01 = undefined_table；訊息裡通常也會含 "does not exist"
                if (error.code === '42P01' || /does not exist/i.test(error.message || '')) {
                    setTableMissing(true);
                } else {
                    setLoadError(error.message);
                }
                setLoading(false);
                return;
            }

            const byKey = new Map((data || []).map((r) => [r.key, r]));
            setRows(KNOWN_KEYS.map((k) => (
                byKey.get(k)
                || (k === TEACHING_MATERIALS_LINK.key ? { ...TEACHING_MATERIALS_LINK } : { key: k, label: '', description: '', url: '' })
            )));
            setLoading(false);
        })();
        return () => { active = false; };
    }, []);

    const updateRow = (key, field, value) => {
        setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
    };

    const handleSave = async (key) => {
        const row = rows.find((r) => r.key === key);
        if (!row) return;

        if (!row.label.trim() || !row.url.trim()) {
            setRowError((prev) => ({ ...prev, [key]: '標題與網址不可空白' }));
            return;
        }
        if (!isSafeHttpUrl(row.url)) {
            setRowError((prev) => ({ ...prev, [key]: '網址格式不正確，需含 https:// 開頭' }));
            return;
        }
        setRowError((prev) => ({ ...prev, [key]: '' }));

        setSavingKey(key);
        setRowStatus((prev) => ({ ...prev, [key]: null }));
        // upsert：列不存在也存得進去（例如 SQL seed 版本較舊、缺新加入的 key）
        const { error } = await supabase
            .from('site_links')
            .upsert({
                key,
                label: row.label.trim(),
                description: row.description?.trim() || null,
                url: row.url.trim(),
                updated_at: new Date().toISOString(),
            });
        setSavingKey(null);

        if (error) {
            setRowStatus((prev) => ({ ...prev, [key]: { type: 'error', msg: '儲存失敗：' + error.message } }));
            return;
        }
        setRowStatus((prev) => ({ ...prev, [key]: { type: 'success', msg: '已儲存' } }));
    };

    return (
        <div className="p-4 sm:p-8 max-w-3xl mx-auto">
            <Link to="/admin" className="inline-flex items-center gap-1 text-sm font-bold text-bauhaus-black/60 hover:text-bauhaus-black mb-4 min-h-[44px]">
                <ArrowLeft className="w-4 h-4" /> 返回後台
            </Link>

            <div className="mb-8">
                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">網站連結管理</h1>
                <p className="text-bauhaus-black/60 mt-1 text-sm font-medium">
                    編輯導航列的「教材資源」網址，以及備用報酬表單的外部連結。
                </p>
            </div>

            {loading && (
                <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>
            )}

            {!loading && tableMissing && (
                <div className="bh-card p-6 flex items-start gap-3 bg-bauhaus-yellow">
                    <AlertTriangle className="w-6 h-6 text-bauhaus-black shrink-0 mt-0.5" />
                    <div>
                        <div className="font-black text-bauhaus-black">資料表尚未建立</div>
                        <p className="text-sm font-medium text-bauhaus-black/80 mt-1">
                            請先在 Supabase 執行 <code className="bg-white/60 px-1">supabase/2026-07-09_site_links.sql</code>，建立
                            <code className="bg-white/60 px-1">site_links</code> 資料表後再回來編輯。
                        </p>
                    </div>
                </div>
            )}

            {!loading && !tableMissing && loadError && (
                <div className="bh-card p-6 bg-bauhaus-red text-white">
                    <div className="font-black">讀取失敗</div>
                    <p className="text-sm font-medium mt-1">{loadError}</p>
                </div>
            )}

            {!loading && !tableMissing && !loadError && (
                <div className="space-y-6">
                    {rows.map((row) => {
                        const status = rowStatus[row.key];
                        const err = rowError[row.key];
                        const isTeachingMaterials = row.key === TEACHING_MATERIALS_LINK.key;
                        return (
                            <div key={row.key} className="bh-card p-6">
                                <div className="flex items-center gap-2 mb-4">
                                    <Link2 className="w-4 h-4 text-bauhaus-black/50" />
                                    <span className="bh-label text-bauhaus-black/50">{row.key}</span>
                                </div>
                                {isTeachingMaterials ? (
                                    <div className="bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl p-4">
                                        <div className="font-black text-bauhaus-black">教材資源</div>
                                        <p className="text-sm font-medium text-bauhaus-black/70 mt-1">
                                            顯示在講師桌面與手機導航列，點擊後會在新分頁開啟。
                                        </p>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div>
                                            <label className="bh-label block mb-1">標題</label>
                                            <input
                                                type="text"
                                                value={row.label}
                                                onChange={(e) => updateRow(row.key, 'label', e.target.value)}
                                                className="bh-input"
                                                placeholder="例：直營課程"
                                            />
                                        </div>
                                        <div>
                                            <label className="bh-label block mb-1">說明</label>
                                            <input
                                                type="text"
                                                value={row.description || ''}
                                                onChange={(e) => updateRow(row.key, 'description', e.target.value)}
                                                className="bh-input"
                                                placeholder="例：營隊、體驗課、到府課、速解課"
                                            />
                                        </div>
                                    </div>
                                )}
                                <div className="mt-4">
                                    <label className="bh-label block mb-1">{isTeachingMaterials ? '教材資源網址' : '表單網址'}</label>
                                    <input
                                        id={isTeachingMaterials ? 'teaching-materials-url' : undefined}
                                        type="text"
                                        value={row.url}
                                        onChange={(e) => updateRow(row.key, 'url', e.target.value)}
                                        className="bh-input"
                                        placeholder={isTeachingMaterials ? TEACHING_MATERIALS_LINK.url : 'https://docs.google.com/forms/...'}
                                    />
                                    {err && <p className="text-xs font-bold text-bauhaus-red mt-1">{err}</p>}
                                </div>
                                <div className="flex items-center justify-between mt-5">
                                    <div className="min-h-[20px]">
                                        {status?.type === 'success' && (
                                            <span className="inline-flex items-center gap-1 text-sm font-bold text-bauhaus-blue">
                                                <CheckCircle2 className="w-4 h-4" /> {status.msg}
                                            </span>
                                        )}
                                        {status?.type === 'error' && (
                                            <span className="inline-flex items-center gap-1 text-sm font-bold text-bauhaus-red">
                                                <XCircle className="w-4 h-4" /> {status.msg}
                                            </span>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => handleSave(row.key)}
                                        disabled={savingKey === row.key}
                                        className="bh-btn bh-btn-blue px-6 py-2.5"
                                    >
                                        <Save className="w-4 h-4" /> {savingKey === row.key ? '儲存中...' : '儲存'}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default SalaryLinksManager;
