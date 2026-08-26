import { createElement, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
    ArrowLeft, CheckCircle2, ExternalLink, FileImage, GraduationCap,
    Landmark, Loader2, Save, ShieldCheck, Trash2, Upload, UserRound,
} from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';

const TW_REGIONS = {
    '北部': ['臺北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '宜蘭縣'],
    '中部': ['臺中市', '苗栗縣', '彰化縣', '南投縣', '雲林縣'],
    '南部': ['臺南市', '高雄市', '嘉義市', '嘉義縣', '屏東縣'],
    '東部': ['花蓮縣', '臺東縣'],
    '離島': ['澎湖縣', '金門縣', '連江縣'],
};

const ROLE_OPTIONS = [
    { value: '', label: '未設定' },
    { value: 'S', label: 'S 級' },
    { value: 'A+', label: 'A+ 級' },
    { value: 'A', label: 'A 級' },
    { value: 'B', label: 'B 級' },
    { value: '實習', label: '實習' },
];

const STATUS_OPTIONS = [
    { value: '', label: '未設定' },
    { value: 'active', label: '講師' },
    { value: 'staff', label: '職員' },
    { value: 'assistant', label: '助教' },
    { value: 'part_time', label: '工讀生' },
    { value: 'frozen', label: '冷凍' },
    { value: 'cancelled', label: '已離職／停止合作' },
];

const SPEED_OPTIONS = [
    { value: '', label: '未設定' },
    { value: 'speed_teacher', label: '速解講師' },
    { value: 'speed_master', label: '速解師傅' },
];

const DOCUMENT_TYPES = [
    { key: 'photo', label: '講師照片' },
    { key: 'id_front', label: '身分證正面' },
    { key: 'id_back', label: '身分證反面' },
    { key: 'bankbook', label: '存摺封面' },
];
const ALLOWED_IMAGE_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
]);

const EDITABLE_FIELDS = [
    'full_name', 'nickname', 'gender', 'birth_date', 'id_number',
    'phone_mobile', 'phone_home', 'line_id', 'line_name', 'address',
    'household_address', 'email_primary', 'email_secondary', 'facebook_url',
    'school_info', 'shirt_size', 'convenience_store_code',
    'convenience_store_family', 'convenience_store_711',
    'employment_status', 'instructor_role', 'speed_qualification',
    'teaching_freq_semester', 'teaching_freq_vacation', 'teaching_regions',
    'teaching_regions_raw', 'bio_personal_experience', 'bio_teaching_experience',
    'teaching_philosophy', 'bio_notes', 'note_to_team', 'note_internal',
    'bank_account_name', 'bank_name', 'bank_branch', 'bank_code',
    'bank_account_number', 'bank_info_raw', 'wca_id', 'wca_name',
    'hide_from_leaderboard', 'form_submitted_at',
    ...DOCUMENT_TYPES.flatMap(({ key }) => [
        `${key}_path`, `${key}_mime`, `${key}_size`, `${key}_uploaded_at`,
        `${key}_external_url`,
    ]),
];

const emptyForm = () => Object.fromEntries(EDITABLE_FIELDS.map((field) => [
    field,
    field === 'teaching_regions' ? [] : field === 'hide_from_leaderboard' ? false : '',
]));

const toDateTimeLocal = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
};

const normalizeForm = (row) => {
    const next = emptyForm();
    EDITABLE_FIELDS.forEach((field) => {
        if (field === 'form_submitted_at') next[field] = toDateTimeLocal(row[field]);
        else if (field === 'teaching_regions') next[field] = row[field] || [];
        else if (field === 'hide_from_leaderboard') next[field] = Boolean(row[field]);
        else next[field] = row[field] ?? '';
    });
    return next;
};

const documentPathFields = (key) => [
    `${key}_path`, `${key}_mime`, `${key}_size`, `${key}_uploaded_at`,
];

const AdminInstructorEdit = () => {
    const { instructorId } = useParams();
    const navigate = useNavigate();
    const [instructor, setInstructor] = useState(null);
    const [form, setForm] = useState(emptyForm);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [previews, setPreviews] = useState({});
    const [pendingFiles, setPendingFiles] = useState({});
    const [obsoletePaths, setObsoletePaths] = useState([]);
    const blobUrls = useRef(new Set());

    useEffect(() => {
        let active = true;
        const load = async () => {
            setLoading(true);
            const { data, error: loadError } = await supabase
                .from('instructors')
                .select('*')
                .eq('id', instructorId)
                .single();

            if (!active) return;
            if (loadError) {
                setError(`讀取講師資料失敗：${loadError.message}`);
                setLoading(false);
                return;
            }

            setInstructor(data);
            setForm(normalizeForm(data));
            const nextPreviews = {};
            await Promise.all(DOCUMENT_TYPES.map(async ({ key }) => {
                if (!data[`${key}_path`]) return;
                const { data: signed } = await supabase.storage
                    .from('instructor_uploads')
                    .createSignedUrl(data[`${key}_path`], 3600);
                if (signed?.signedUrl) nextPreviews[key] = signed.signedUrl;
            }));
            if (active) {
                setPreviews(nextPreviews);
                setLoading(false);
            }
        };
        load();
        return () => { active = false; };
    }, [instructorId]);

    useEffect(() => () => {
        blobUrls.current.forEach((url) => URL.revokeObjectURL(url));
    }, []);

    const updateField = (field, value) => {
        setForm((current) => ({ ...current, [field]: value }));
        setSuccess('');
    };

    const toggleRegion = (county) => {
        setForm((current) => ({
            ...current,
            teaching_regions: current.teaching_regions.includes(county)
                ? current.teaching_regions.filter((region) => region !== county)
                : [...current.teaching_regions, county],
        }));
        setSuccess('');
    };

    const selectArea = (counties) => {
        setForm((current) => {
            const allSelected = counties.every((county) => current.teaching_regions.includes(county));
            const selected = new Set(current.teaching_regions);
            counties.forEach((county) => allSelected ? selected.delete(county) : selected.add(county));
            return { ...current, teaching_regions: [...selected] };
        });
        setSuccess('');
    };

    const chooseDocument = (key, file) => {
        if (!file) return;
        if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
            setError('文件僅接受 JPEG、PNG、GIF、WebP 或 HEIC 圖片。');
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            setError('單一文件不可超過 20MB。');
            return;
        }

        const previousBlob = previews[key]?.startsWith('blob:') ? previews[key] : null;
        if (previousBlob) {
            URL.revokeObjectURL(previousBlob);
            blobUrls.current.delete(previousBlob);
        }
        const blobUrl = URL.createObjectURL(file);
        blobUrls.current.add(blobUrl);
        setPendingFiles((current) => ({ ...current, [key]: file }));
        setPreviews((current) => ({ ...current, [key]: blobUrl }));
        setError('');
        setSuccess('');
    };

    const removeDocument = (key) => {
        const currentPath = form[`${key}_path`];
        if (currentPath) setObsoletePaths((current) => [...new Set([...current, currentPath])]);
        const currentPreview = previews[key];
        if (currentPreview?.startsWith('blob:')) {
            URL.revokeObjectURL(currentPreview);
            blobUrls.current.delete(currentPreview);
        }
        setPendingFiles((current) => {
            const next = { ...current };
            delete next[key];
            return next;
        });
        setPreviews((current) => {
            const next = { ...current };
            delete next[key];
            return next;
        });
        setForm((current) => {
            const next = { ...current };
            documentPathFields(key).forEach((field) => { next[field] = ''; });
            return next;
        });
        setSuccess('');
    };

    const validateExternalUrls = () => {
        for (const { key, label } of DOCUMENT_TYPES) {
            const value = form[`${key}_external_url`]?.trim();
            if (!value) continue;
            try {
                const url = new URL(value);
                if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
            } catch {
                return `${label}的既有文件連結必須是未夾帶帳密的 HTTPS 網址。`;
            }
        }
        return '';
    };

    const save = async () => {
        setError('');
        setSuccess('');
        if (!form.full_name.trim()) {
            setError('姓名不可留白。');
            return;
        }
        if (form.bank_code && !/^\d{6,7}$/.test(form.bank_code)) {
            setError('銀行代碼若有填寫，必須是 6 或 7 碼數字。');
            return;
        }
        const externalUrlError = validateExternalUrls();
        if (externalUrlError) {
            setError(externalUrlError);
            return;
        }

        setSaving(true);
        const next = { ...form };
        const uploadedPaths = [];
        const pathsToRemove = new Set(obsoletePaths);

        try {
            for (const [key, file] of Object.entries(pendingFiles)) {
                const extension = file.name.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'img';
                const ownerKey = instructor.user_id || instructor.id;
                const path = `instructors/${ownerKey}/${key}/${crypto.randomUUID()}.${extension}`;
                const { error: uploadError } = await supabase.storage
                    .from('instructor_uploads')
                    .upload(path, file);
                if (uploadError) throw uploadError;
                uploadedPaths.push(path);
                if (next[`${key}_path`]) pathsToRemove.add(next[`${key}_path`]);
                next[`${key}_path`] = path;
                next[`${key}_mime`] = file.type;
                next[`${key}_size`] = file.size;
                next[`${key}_uploaded_at`] = new Date().toISOString();
            }

            const payload = {};
            EDITABLE_FIELDS.forEach((field) => {
                if (field === 'teaching_regions') payload[field] = next[field] || [];
                else if (field === 'hide_from_leaderboard') payload[field] = Boolean(next[field]);
                else if (field === 'form_submitted_at') payload[field] = next[field] ? new Date(next[field]).toISOString() : null;
                else if (field === 'email_primary') payload[field] = next[field]?.trim().toLowerCase() || null;
                else if (typeof next[field] === 'string') payload[field] = next[field].trim() || null;
                else payload[field] = next[field] ?? null;
            });

            const { data, error: updateError } = await supabase
                .from('instructors')
                .update(payload)
                .eq('id', instructor.id)
                .select('*')
                .single();
            if (updateError) throw updateError;

            if (pathsToRemove.size) {
                const { error: cleanupError } = await supabase.storage
                    .from('instructor_uploads')
                    .remove([...pathsToRemove]);
                if (cleanupError) console.error('清理講師舊文件失敗：', cleanupError.message);
            }

            blobUrls.current.forEach((url) => URL.revokeObjectURL(url));
            blobUrls.current.clear();
            setInstructor(data);
            setForm(normalizeForm(data));
            setPendingFiles({});
            setObsoletePaths([]);
            const refreshedPreviews = {};
            await Promise.all(DOCUMENT_TYPES.map(async ({ key }) => {
                if (!data[`${key}_path`]) return;
                const { data: signed } = await supabase.storage
                    .from('instructor_uploads')
                    .createSignedUrl(data[`${key}_path`], 3600);
                if (signed?.signedUrl) refreshedPreviews[key] = signed.signedUrl;
            }));
            setPreviews(refreshedPreviews);
            setSuccess('講師資料已更新。');
        } catch (saveError) {
            if (uploadedPaths.length) {
                const { error: rollbackError } = await supabase.storage
                    .from('instructor_uploads')
                    .remove(uploadedPaths);
                if (rollbackError) console.error('回滾新上傳文件失敗：', rollbackError.message);
            }
            setError(`儲存失敗：${saveError.message}`);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <div className="p-12 flex items-center justify-center gap-2 font-bold text-bauhaus-black/60"><Loader2 className="w-5 h-5 animate-spin" />載入講師資料中⋯</div>;
    }

    if (!instructor) {
        return (
            <div className="p-4 sm:p-8 max-w-3xl mx-auto">
                <div className="bh-card p-6 bg-bauhaus-red text-white font-bold">{error || '找不到此講師。'}</div>
                <Link to="/admin/instructors" className="bh-btn bh-btn-outline px-4 py-2.5 mt-5"><ArrowLeft className="w-4 h-4" />返回講師資料總覽</Link>
            </div>
        );
    }

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto pb-28">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-7">
                <div>
                    <button type="button" onClick={() => navigate('/admin/instructors')} className="bh-btn bh-btn-ghost px-0 py-2 mb-2">
                        <ArrowLeft className="w-4 h-4" />返回講師資料總覽
                    </button>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">編輯講師資料</h1>
                    <p className="text-bauhaus-black/60 mt-1 font-medium">{instructor.full_name}・{instructor.user_id ? '已認領帳號' : '尚未認領帳號'}</p>
                </div>
                <div className="bh-chip bg-bauhaus-blue text-white px-4 py-2.5">
                    <ShieldCheck className="w-4 h-4" />僅管理員可編輯
                </div>
            </div>

            <div className="bh-card bg-bauhaus-yellow px-4 py-3 mb-6 text-sm font-bold text-bauhaus-black">
                這裡可維護匯入主檔與講師本人填寫的資料；輔導員只能在總覽查看，無法開啟本頁或寫入資料。
            </div>

            {error && <div role="alert" className="bh-card bg-bauhaus-red text-white px-4 py-3 mb-5 font-bold">{error}</div>}
            {success && <div role="status" className="bh-card bg-bauhaus-blue text-white px-4 py-3 mb-5 font-bold flex items-center gap-2"><CheckCircle2 className="w-5 h-5" />{success}</div>}

            <div className="space-y-6">
                <Section icon={ShieldCheck} title="帳號與管理狀態">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <ReadOnly label="主檔 ID" value={instructor.id} />
                        <ReadOnly label="認領帳號 ID" value={instructor.user_id || '尚未認領'} />
                        <ReadOnly label="建檔時間" value={instructor.created_at || '—'} />
                        <ReadOnly label="最近更新" value={instructor.updated_at || '—'} />
                        <ReadOnly label="WCA 最近同步" value={instructor.wca_synced_at || '尚未同步'} />
                        <Field label="原表單提交時間"><input type="datetime-local" value={form.form_submitted_at} onChange={(event) => updateField('form_submitted_at', event.target.value)} className="bh-input" /></Field>
                        <Field label="業務狀態" hint="設為冷凍或已離職時，既有講師帳號會停止內容存取。"><Select value={form.employment_status} options={STATUS_OPTIONS} onChange={(value) => updateField('employment_status', value)} /></Field>
                        <Field label="講師等級"><Select value={form.instructor_role} options={ROLE_OPTIONS} onChange={(value) => updateField('instructor_role', value)} /></Field>
                        <Field label="速解資格"><Select value={form.speed_qualification} options={SPEED_OPTIONS} onChange={(value) => updateField('speed_qualification', value)} /></Field>
                    </div>
                    <label className="mt-4 flex items-center gap-3 border-2 border-bauhaus-black rounded-xl bg-white px-4 py-3 min-h-[48px] cursor-pointer">
                        <input type="checkbox" checked={form.hide_from_leaderboard} onChange={(event) => updateField('hide_from_leaderboard', event.target.checked)} className="w-5 h-5 accent-bauhaus-blue" />
                        <span className="font-bold text-bauhaus-black">不顯示於排行榜</span>
                    </label>
                    <div className="mt-4"><Field label="管理員內部備註"><Textarea value={form.note_internal} onChange={(value) => updateField('note_internal', value)} rows={3} /></Field></div>
                </Section>

                <Section icon={UserRound} title="基本與聯絡資料">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        <TextField label="姓名" value={form.full_name} required onChange={(value) => updateField('full_name', value)} />
                        <TextField label="講師暱稱" value={form.nickname} onChange={(value) => updateField('nickname', value)} />
                        <Field label="性別"><Select value={form.gender} options={[{ value: '', label: '未設定' }, { value: '男', label: '男' }, { value: '女', label: '女' }, { value: '其他', label: '其他' }]} onChange={(value) => updateField('gender', value)} /></Field>
                        <Field label="出生年月日"><input type="date" value={form.birth_date} onChange={(event) => updateField('birth_date', event.target.value)} className="bh-input" /></Field>
                        <TextField label="身分證字號" value={form.id_number} onChange={(value) => updateField('id_number', value.toUpperCase())} />
                        <TextField label="手機號碼" value={form.phone_mobile} type="tel" onChange={(value) => updateField('phone_mobile', value)} />
                        <TextField label="家用電話" value={form.phone_home} type="tel" onChange={(value) => updateField('phone_home', value)} />
                        <TextField label="Line ID" value={form.line_id} onChange={(value) => updateField('line_id', value)} />
                        <TextField label="Line 名稱" value={form.line_name} onChange={(value) => updateField('line_name', value)} />
                        <TextField label="主要 Email" value={form.email_primary} type="email" hint="未認領時作為 Google 帳號認領鍵；已認領後不會連帶修改 Google 帳號 Email。" onChange={(value) => updateField('email_primary', value)} />
                        <TextField label="備用 Email" value={form.email_secondary} type="email" onChange={(value) => updateField('email_secondary', value)} />
                        <TextField label="Facebook 網址" value={form.facebook_url} type="url" onChange={(value) => updateField('facebook_url', value)} />
                        <TextField label="通訊地址" value={form.address} onChange={(value) => updateField('address', value)} />
                        <TextField label="戶籍地址" value={form.household_address} onChange={(value) => updateField('household_address', value)} />
                        <TextField label="就讀學校／科系" value={form.school_info} onChange={(value) => updateField('school_info', value)} />
                        <TextField label="衣服尺寸" value={form.shirt_size} onChange={(value) => updateField('shirt_size', value)} />
                        <TextField label="超商代碼原始資料" value={form.convenience_store_code} onChange={(value) => updateField('convenience_store_code', value)} />
                        <TextField label="全家店號" value={form.convenience_store_family} onChange={(value) => updateField('convenience_store_family', value)} />
                        <TextField label="7-11 店號" value={form.convenience_store_711} onChange={(value) => updateField('convenience_store_711', value)} />
                    </div>
                </Section>

                <Section icon={GraduationCap} title="教學與經歷資料">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <TextField label="接課頻率（學期間）" value={form.teaching_freq_semester} onChange={(value) => updateField('teaching_freq_semester', value)} />
                        <TextField label="接課頻率（寒暑假）" value={form.teaching_freq_vacation} onChange={(value) => updateField('teaching_freq_vacation', value)} />
                    </div>
                    <div className="mt-5 space-y-3">
                        <div className="bh-label">可接課地區（已選 {form.teaching_regions.length} 個）</div>
                        {Object.entries(TW_REGIONS).map(([area, counties]) => (
                            <div key={area} className="border-2 border-bauhaus-black rounded-xl bg-bauhaus-muted p-3">
                                <button type="button" onClick={() => selectArea(counties)} className="bh-btn bh-btn-outline px-3 py-2 text-xs mb-2">{area}全選／取消</button>
                                <div className="flex flex-wrap gap-2">
                                    {counties.map((county) => (
                                        <label key={county} className={`bh-chip cursor-pointer ${form.teaching_regions.includes(county) ? 'bg-bauhaus-blue text-white' : 'bg-white text-bauhaus-black'}`}>
                                            <input type="checkbox" className="sr-only" checked={form.teaching_regions.includes(county)} onChange={() => toggleRegion(county)} />{county}
                                        </label>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
                        <TextField label="接課地區原始資料" value={form.teaching_regions_raw} onChange={(value) => updateField('teaching_regions_raw', value)} />
                        <TextField label="WCA 選手編號" value={form.wca_id} onChange={(value) => updateField('wca_id', value)} />
                        <TextField label="WCA 登記姓名" value={form.wca_name} onChange={(value) => updateField('wca_name', value)} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
                        <Field label="個人經歷"><Textarea value={form.bio_personal_experience} onChange={(value) => updateField('bio_personal_experience', value)} /></Field>
                        <Field label="授課經驗"><Textarea value={form.bio_teaching_experience} onChange={(value) => updateField('bio_teaching_experience', value)} /></Field>
                        <Field label="教學理念"><Textarea value={form.teaching_philosophy} onChange={(value) => updateField('teaching_philosophy', value)} /></Field>
                        <Field label="經歷／理念整合欄"><Textarea value={form.bio_notes} onChange={(value) => updateField('bio_notes', value)} /></Field>
                        <div className="md:col-span-2"><Field label="想對團隊說的話"><Textarea value={form.note_to_team} onChange={(value) => updateField('note_to_team', value)} rows={3} /></Field></div>
                    </div>
                </Section>

                <Section icon={Landmark} title="匯款資料">
                    <div className="bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl px-4 py-3 mb-4 text-sm font-bold">
                        管理員可替講師更正已鎖定的匯款資料；一般講師與輔導員無法從這裡修改。
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <TextField label="匯款戶名" value={form.bank_account_name} onChange={(value) => updateField('bank_account_name', value)} />
                        <TextField label="銀行別" value={form.bank_name} onChange={(value) => updateField('bank_name', value)} />
                        <TextField label="分行別" value={form.bank_branch} onChange={(value) => updateField('bank_branch', value)} />
                        <TextField label="銀行代碼（6–7 碼）" value={form.bank_code} inputMode="numeric" onChange={(value) => updateField('bank_code', value.replace(/\D/g, '').slice(0, 7))} />
                        <TextField label="銀行帳號（含檢查碼）" value={form.bank_account_number} onChange={(value) => updateField('bank_account_number', value.replace(/[^0-9-]/g, ''))} />
                        <TextField label="舊匯款資料原文" value={form.bank_info_raw} onChange={(value) => updateField('bank_info_raw', value)} />
                    </div>
                </Section>

                <Section icon={FileImage} title="講師文件">
                    <p className="text-sm text-bauhaus-black/60 font-medium mb-4">可替換或移除 Storage 文件，也可維護歷史 Google Drive 連結。新檔會在儲存整份資料時一併上傳。</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {DOCUMENT_TYPES.map(({ key, label }) => (
                            <DocumentEditor
                                key={key}
                                label={label}
                                preview={previews[key]}
                                externalUrl={form[`${key}_external_url`]}
                                pending={Boolean(pendingFiles[key])}
                                onFile={(file) => chooseDocument(key, file)}
                                onRemove={() => removeDocument(key)}
                                onExternalUrl={(value) => updateField(`${key}_external_url`, value)}
                            />
                        ))}
                    </div>
                </Section>
            </div>

            <div className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t-4 border-bauhaus-black px-4 py-3">
                <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
                    <span className="hidden sm:block text-sm font-bold text-bauhaus-black/60">儲存後會立即更新講師主檔與表單帶入資料</span>
                    <div className="flex gap-2 ml-auto">
                        <Link to="/admin/instructors" className="bh-btn bh-btn-outline px-4 py-2.5">取消</Link>
                        <button type="button" onClick={save} disabled={saving} className="bh-btn bh-btn-blue px-5 py-2.5" data-testid="save-instructor">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}{saving ? '儲存中⋯' : '儲存講師資料'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const Section = ({ icon, title, children }) => (
    <section className="bh-card overflow-hidden">
        <div className="bg-bauhaus-black text-white px-5 py-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-bauhaus-yellow text-bauhaus-black flex items-center justify-center">{createElement(icon, { className: 'w-5 h-5' })}</div>
            <h2 className="text-lg font-black tracking-wide">{title}</h2>
        </div>
        <div className="p-4 sm:p-6">{children}</div>
    </section>
);

const Field = ({ label, required = false, hint, children }) => (
    <label className="block">
        <span className="bh-label block mb-1">{label}{required && <span className="text-bauhaus-red"> *</span>}</span>
        {children}
        {hint && <span className="block mt-1 text-xs font-medium leading-relaxed text-bauhaus-black/50">{hint}</span>}
    </label>
);

const TextField = ({ label, value, onChange, type = 'text', required = false, inputMode, hint }) => (
    <Field label={label} required={required} hint={hint}>
        <input type={type} value={value || ''} onChange={(event) => onChange(event.target.value)} className="bh-input" inputMode={inputMode} />
    </Field>
);

const Textarea = ({ value, onChange, rows = 4 }) => (
    <textarea value={value || ''} onChange={(event) => onChange(event.target.value)} rows={rows} className="bh-input resize-y" />
);

const Select = ({ value, options, onChange }) => (
    <select value={value || ''} onChange={(event) => onChange(event.target.value)} className="bh-input bg-white">
        {options.map((option) => <option key={option.value || 'empty'} value={option.value}>{option.label}</option>)}
    </select>
);

const ReadOnly = ({ label, value }) => (
    <div>
        <div className="bh-label mb-1">{label}</div>
        <div className="min-h-[48px] border-2 border-bauhaus-black/30 rounded-xl bg-bauhaus-muted px-3 py-3 font-mono text-xs break-all text-bauhaus-black/70">{value}</div>
    </div>
);

const DocumentEditor = ({ label, preview, externalUrl, pending, onFile, onRemove, onExternalUrl }) => (
    <div className="border-2 border-bauhaus-black rounded-2xl p-4 bg-white">
        <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="font-black text-bauhaus-black">{label}</h3>
            {pending && <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black">待上傳</span>}
        </div>
        {preview ? (
            <img src={preview} alt={label} className="w-full h-40 object-contain bg-bauhaus-muted border-2 border-bauhaus-black rounded-xl" />
        ) : externalUrl ? (
            <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="h-40 border-2 border-bauhaus-black rounded-xl bg-bauhaus-yellow flex flex-col items-center justify-center gap-2 font-bold text-bauhaus-black hover:bg-bauhaus-cream">
                <ExternalLink className="w-7 h-7" />查看既有 Google Drive 文件
            </a>
        ) : (
            <div className="h-40 border-2 border-dashed border-bauhaus-black/30 rounded-xl bg-bauhaus-muted flex items-center justify-center text-sm font-bold text-bauhaus-black/50">尚無文件</div>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
            <label className="bh-btn bh-btn-blue px-3 py-2.5 text-sm cursor-pointer">
                <Upload className="w-4 h-4" />選擇新圖片
                <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif" className="hidden" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ''; }} />
            </label>
            {(preview || pending) && <button type="button" onClick={onRemove} className="bh-btn bh-btn-red px-3 py-2.5 text-sm"><Trash2 className="w-4 h-4" />移除</button>}
        </div>
        <label className="block mt-3">
            <span className="bh-label block mb-1">既有 Google Drive 連結</span>
            <input type="url" value={externalUrl || ''} onChange={(event) => onExternalUrl(event.target.value)} className="bh-input text-sm" placeholder="https://drive.google.com/..." />
        </label>
    </div>
);

export default AdminInstructorEdit;
