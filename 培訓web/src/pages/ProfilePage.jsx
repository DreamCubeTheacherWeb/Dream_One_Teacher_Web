import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { Save, Upload, X, User, Phone, GraduationCap, FileText, CreditCard, Camera, Landmark, Pencil, PartyPopper, FileSignature, CheckCircle2, Download, Eye, Calendar, Clock, UserSearch, Send, AlertCircle, Trophy, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { nextMilestone, toHours, MILESTONES } from '../lib/leaderboard';
import { downloadCertificate } from '../lib/certificate';

const TW_REGIONS = {
    '北部': ['臺北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '宜蘭縣'],
    '中部': ['臺中市', '苗栗縣', '彰化縣', '南投縣', '雲林縣'],
    '南部': ['臺南市', '高雄市', '嘉義市', '嘉義縣', '屏東縣'],
    '東部': ['花蓮縣', '臺東縣'],
    '離島': ['澎湖縣', '金門縣', '連江縣'],
};

const ROLE_OPTIONS = [
    { value: 'S', label: 'S 級' },
    { value: 'A+', label: 'A+ 級' },
    { value: 'A', label: 'A 級' },
    { value: 'B', label: 'B 級' },
    { value: '實習', label: '實習' },
    { value: '職員', label: '職員' },
    { value: '工讀生', label: '工讀生' },
];

const DOC_TYPES = [
    { key: 'id_front', label: '身分證正面', Icon: CreditCard },
    { key: 'id_back', label: '身分證反面', Icon: CreditCard },
    { key: 'bankbook', label: '存摺封面', Icon: Landmark },
];

const REQUIRED_FIELDS = [
    { key: 'full_name', label: '姓名' },
    { key: 'nickname', label: '講師暱稱' },
    { key: 'gender', label: '性別' },
    { key: 'birth_date', label: '出生年月日' },
    { key: 'id_number', label: '身分證字號' },
    { key: 'phone_mobile', label: '手機號碼' },
    { key: 'line_id', label: 'Line ID' },
    { key: 'address', label: '通訊地址' },
    { key: 'email_primary', label: '主要 Email' },
    { key: 'instructor_role', label: '講師等級' },
    { key: 'teaching_freq_semester', label: '接課頻率（學期間）' },
    { key: 'teaching_freq_vacation', label: '接課頻率（寒暑假）' },
    { key: 'bio_notes', label: '經歷 / 理念' },
    { key: 'bank_account_name', label: '匯款戶名' },
    { key: 'bank_name', label: '銀行別' },
    { key: 'bank_branch', label: '分行別' },
    { key: 'bank_account_number', label: '銀行帳號' },
    { key: 'bank_code', label: '銀行代碼' },
];

const INITIAL_FORM = {
    full_name: '', nickname: '', gender: '', birth_date: '', id_number: '',
    phone_mobile: '', phone_home: '', line_id: '', address: '',
    email_primary: '', email_secondary: '',
    instructor_role: '', teaching_freq_semester: '', teaching_freq_vacation: '',
    teaching_regions: [],
    bio_notes: '',
    bank_account_name: '', bank_name: '', bank_branch: '',
    bank_account_number: '', bank_code: '',
    photo_path: null, photo_mime: null, photo_size: null, photo_uploaded_at: null,
    id_front_path: null, id_front_mime: null, id_front_size: null, id_front_uploaded_at: null,
    id_back_path: null, id_back_mime: null, id_back_size: null, id_back_uploaded_at: null,
    bankbook_path: null, bankbook_mime: null, bankbook_size: null, bankbook_uploaded_at: null,
};

const ProfilePage = () => {
    const { user, profile } = useAuth();
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [isFirstTime, setIsFirstTime] = useState(false);
    const [showSuccess, setShowSuccess] = useState(false);
    const [form, setForm] = useState(INITIAL_FORM);
    const [filePreviews, setFilePreviews] = useState({});
    const [uploading, setUploading] = useState({});
    const fileRefs = useRef({});
    const [contractInfo, setContractInfo] = useState(null);
    const [latestDocVersions, setLatestDocVersions] = useState(null);
    const [showClaimModal, setShowClaimModal] = useState(false);
    const [existingClaim, setExistingClaim] = useState(null);

    useEffect(() => {
        if (user) {
            loadProfile();
            loadContractStatus();
            loadExistingClaim();
        }
    }, [user]);

    const loadExistingClaim = async () => {
        const { data } = await supabase
            .from('instructor_claim_requests')
            .select('id, status, instructor:instructor_id ( full_name )')
            .eq('requester_user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        setExistingClaim(data || null);
    };

    const loadContractStatus = async () => {
        try {
            const { data: contractData } = await supabase
                .from('instructor_contracts')
                .select('*')
                .eq('user_id', user.id)
                .eq('status', 'signed')
                .order('signed_at', { ascending: false })
                .limit(1);
            if (contractData?.length) setContractInfo(contractData[0]);

            const { data: docsData } = await supabase
                .from('contract_documents')
                .select('doc_type, version')
                .eq('is_active', true);
            if (docsData?.length) {
                const versions = {};
                docsData.forEach(d => { versions[d.doc_type] = d.version; });
                setLatestDocVersions(versions);
            }
        } catch { /* ignore */ }
    };

    const loadProfile = async () => {
        let { data } = await supabase
            .from('instructors')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();

        // 雙保險:萬一 AuthContext 的 fallback link 也沒接到(同 email 但 user_id IS NULL)
        // 在這裡再試一次,避免使用者填新資料造成「同人兩列」
        if (!data) {
            const { data: linkedId } = await supabase.rpc('link_my_instructor_by_email');
            if (linkedId) {
                const { data: linkedRow } = await supabase
                    .from('instructors')
                    .select('*')
                    .eq('user_id', user.id)
                    .maybeSingle();
                data = linkedRow;
            }
        }

        if (data) {
            setIsFirstTime(false);
            const formData = {};
            for (const key of Object.keys(INITIAL_FORM)) {
                formData[key] = data[key] ?? INITIAL_FORM[key];
            }
            setForm(formData);

            const previews = {};
            const allDocKeys = ['photo', ...DOC_TYPES.map(d => d.key)];
            for (const key of allDocKeys) {
                if (data[`${key}_path`]) {
                    const { data: urlData } = await supabase.storage
                        .from('instructor_uploads')
                        .createSignedUrl(data[`${key}_path`], 3600);
                    if (urlData?.signedUrl) previews[key] = urlData.signedUrl;
                }
            }
            setFilePreviews(previews);
        } else {
            setIsFirstTime(true);
            setForm(prev => ({
                ...prev,
                full_name: profile?.name || '',
                email_primary: user.email || '',
            }));
        }
        setLoading(false);
    };

    const handleChange = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

    const toggleRegion = (county) => {
        setForm(prev => ({
            ...prev,
            teaching_regions: prev.teaching_regions.includes(county)
                ? prev.teaching_regions.filter(r => r !== county)
                : [...prev.teaching_regions, county],
        }));
    };

    const selectAllInArea = (counties) => {
        setForm(prev => {
            const current = new Set(prev.teaching_regions);
            const allSelected = counties.every(c => current.has(c));
            if (allSelected) counties.forEach(c => current.delete(c));
            else counties.forEach(c => current.add(c));
            return { ...prev, teaching_regions: [...current] };
        });
    };

    const handleFileUpload = async (docType, file) => {
        if (!file.type.startsWith('image/')) {
            alert('僅接受圖片檔案（JPEG、PNG、GIF、WebP）');
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            alert('檔案大小不可超過 20MB');
            return;
        }

        setUploading(prev => ({ ...prev, [docType]: true }));

        if (form[`${docType}_path`]) {
            await supabase.storage.from('instructor_uploads').remove([form[`${docType}_path`]]);
        }

        const ext = file.name.split('.').pop();
        const path = `instructors/${user.id}/${docType}/${crypto.randomUUID()}.${ext}`;

        const { error } = await supabase.storage
            .from('instructor_uploads')
            .upload(path, file);

        if (error) {
            alert('上傳失敗：' + error.message);
            setUploading(prev => ({ ...prev, [docType]: false }));
            return;
        }

        setForm(prev => ({
            ...prev,
            [`${docType}_path`]: path,
            [`${docType}_mime`]: file.type,
            [`${docType}_size`]: file.size,
            [`${docType}_uploaded_at`]: new Date().toISOString(),
        }));
        setFilePreviews(prev => ({ ...prev, [docType]: URL.createObjectURL(file) }));
        setUploading(prev => ({ ...prev, [docType]: false }));
    };

    const handleRemoveFile = async (docType) => {
        if (form[`${docType}_path`]) {
            await supabase.storage.from('instructor_uploads').remove([form[`${docType}_path`]]);
        }
        setForm(prev => ({
            ...prev,
            [`${docType}_path`]: null, [`${docType}_mime`]: null,
            [`${docType}_size`]: null, [`${docType}_uploaded_at`]: null,
        }));
        setFilePreviews(prev => {
            const next = { ...prev };
            delete next[docType];
            return next;
        });
    };

    const handleSave = async () => {
        const missing = REQUIRED_FIELDS.filter(f => !form[f.key]?.toString().trim());
        if (missing.length > 0) {
            alert('以下欄位為必填：\n' + missing.map(f => `• ${f.label}`).join('\n'));
            return;
        }
        if (!form.teaching_regions?.length) {
            alert('請至少選擇一個接課地區');
            return;
        }
        if (!form.photo_path) {
            alert('請上傳大頭照 / 自拍照');
            return;
        }
        const missingDocs = DOC_TYPES.filter(d => !form[`${d.key}_path`]);
        if (missingDocs.length > 0) {
            alert('以下文件尚未上傳：\n' + missingDocs.map(d => `• ${d.label}`).join('\n'));
            return;
        }

        if (form.bank_account_name.trim() !== form.full_name.trim()) {
            const ok = window.confirm(
                `⚠️ 匯款戶名（${form.bank_account_name}）與身分證姓名（${form.full_name}）不同。\n\n依公司規定戶名應與身分證姓名相同，確定要繼續送出嗎？`
            );
            if (!ok) return;
        }

        if (form.bank_code && form.bank_code.length !== 7) {
            alert('銀行代碼必須為 7 碼數字');
            return;
        }

        setSaving(true);
        const payload = {
            user_id: user.id,
            ...form,
            instructor_role: form.instructor_role || null,
        };

        const { error } = await supabase
            .from('instructors')
            .upsert(payload, { onConflict: 'user_id' });

        if (error) {
            alert('儲存失敗：' + error.message);
            setSaving(false);
            return;
        }

        if (profile?.role === 'pending' && isFirstTime) {
            setShowSuccess(true);
        } else if (profile?.role === 'pending') {
            navigate('/pending');
        } else {
            alert('個人資料已儲存！');
        }
        setSaving(false);
    };

    if (loading) return <div className="p-12 text-center text-bauhaus-black/60 font-bold text-lg">載入中...</div>;

    const inputCls = 'bh-input';
    const selectCls = inputCls + ' bg-white';

    return (
        <div className="p-6 max-w-4xl mx-auto">
            {/* ── 首次註冊提示 ── */}
            {isFirstTime && (
                <div className="bh-card bg-bauhaus-yellow/10 p-5 mb-6 flex items-center gap-3">
                    <div className="w-10 h-10 bg-bauhaus-yellow border-2 border-bauhaus-black flex items-center justify-center shrink-0">
                        <Save className="w-5 h-5 text-bauhaus-black" />
                    </div>
                    <p className="text-bauhaus-black font-bold">
                        填寫完下方資料後才算完成註冊，請務必填寫所有必填欄位並按下「送出資料」。
                    </p>
                </div>
            )}

            {/* ── 認領歷史講師資料(僅 isFirstTime 且尚未提出 pending 申請時顯示)── */}
            {isFirstTime && (!existingClaim || existingClaim.status === 'rejected') && (
                <div className="bh-card p-5 mb-6 flex items-start gap-3">
                    <div className="w-10 h-10 bg-bauhaus-blue border-2 border-bauhaus-black flex items-center justify-center shrink-0">
                        <UserSearch className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1">
                        <p className="text-bauhaus-black font-black">您是已建檔的講師嗎?</p>
                        <p className="text-bauhaus-black/70 text-sm mt-0.5 font-medium">
                            如果您之前已經填過資料、想用這個 Google 帳號接收歷史記錄,可以提出認領申請,管理員審核通過後就會自動綁定。
                        </p>
                        <button
                            type="button"
                            onClick={() => setShowClaimModal(true)}
                            className="bh-btn bh-btn-blue mt-3 px-4 py-3 md:py-2 text-sm w-full sm:w-auto"
                        >
                            <UserSearch className="w-4 h-4" /> 認領我的講師資料
                        </button>
                    </div>
                </div>
            )}

            {/* ── 顯示既有 claim 狀態 ── */}
            {existingClaim?.status === 'pending' && (
                <div className="bh-card bg-bauhaus-yellow/10 p-5 mb-6 flex items-start gap-3">
                    <Clock className="w-5 h-5 text-bauhaus-black shrink-0 mt-0.5" />
                    <div>
                        <p className="text-bauhaus-black font-black">認領申請審核中</p>
                        <p className="text-bauhaus-black/70 text-sm mt-0.5 font-medium">
                            您已申請認領 <strong className="font-black">{existingClaim.instructor?.full_name}</strong> 的講師資料,等候管理員審核中。通過後會自動綁定。
                        </p>
                    </div>
                </div>
            )}

            {/* ── Header with Avatar ── */}
            <div className="mb-8 flex items-center gap-6">
                <div className="relative shrink-0">
                    <div className="w-28 h-28 rounded-full bg-bauhaus-muted border-2 lg:border-4 border-bauhaus-black overflow-hidden flex items-center justify-center">
                        {filePreviews.photo ? (
                            <img src={filePreviews.photo} alt="大頭照" className="w-full h-full object-cover" />
                        ) : (
                            <Camera className="w-10 h-10 text-bauhaus-black/30" />
                        )}
                    </div>
                    {uploading.photo ? (
                        <div className="absolute inset-0 rounded-full bg-bauhaus-black/50 flex items-center justify-center">
                            <div className="w-8 h-8 border-3 border-white border-t-transparent rounded-full animate-spin" />
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => fileRefs.current.photo?.click()}
                            className="absolute bottom-0 right-0 w-11 h-11 bg-bauhaus-blue hover:bg-bauhaus-blue/90 text-white rounded-full flex items-center justify-center transition-colors border-2 border-bauhaus-black"
                        >
                            <Pencil className="w-4 h-4" />
                        </button>
                    )}
                    <input
                        ref={el => (fileRefs.current.photo = el)}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => {
                            if (e.target.files[0]) handleFileUpload('photo', e.target.files[0]);
                            e.target.value = '';
                        }}
                    />
                    {filePreviews.photo && (
                        <button
                            onClick={() => handleRemoveFile('photo')}
                            className="absolute top-0 right-0 w-6 h-6 bg-bauhaus-red hover:bg-bauhaus-red/90 text-white rounded-full flex items-center justify-center border-2 border-bauhaus-black"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    )}
                </div>
                <div>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">
                        {isFirstTime ? '歡迎加入！' : '個人資料'}
                    </h1>
                    <p className="text-bauhaus-black/60 mt-1 font-medium">
                        {isFirstTime
                            ? '請先上傳大頭照並填寫以下完整資料，完成後即可送出審核。'
                            : '查看與編輯您的個人資料，所有欄位皆為必填。'}
                    </p>
                    {!filePreviews.photo && (
                        <p className="text-bauhaus-red text-sm mt-1 font-bold">← 請先上傳大頭照 / 自拍照</p>
                    )}
                </div>
            </div>

            {/* ── 我的成就（僅非首次註冊時顯示）── */}
            {!isFirstTime && user && (
                <AchievementsSection userId={user.id} certName={form.full_name || profile?.name || ''} />
            )}

            {/* ── 基本資料 ── */}
            <Section icon={User} title="基本資料">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="姓名" required>
                        <input type="text" value={form.full_name} onChange={e => handleChange('full_name', e.target.value)} className={inputCls} placeholder="請輸入姓名" />
                    </Field>
                    <Field label="講師暱稱" required>
                        <input type="text" value={form.nickname} onChange={e => handleChange('nickname', e.target.value)} className={inputCls} placeholder="留言區顯示用暱稱" />
                    </Field>
                    <Field label="性別" required>
                        <select value={form.gender} onChange={e => handleChange('gender', e.target.value)} className={selectCls}>
                            <option value="">請選擇</option>
                            <option value="男">男</option>
                            <option value="女">女</option>
                            <option value="其他">其他</option>
                        </select>
                    </Field>
                    <Field label="出生年月日" required>
                        <input type="date" value={form.birth_date} onChange={e => handleChange('birth_date', e.target.value)} className={inputCls} />
                    </Field>
                    <Field label="身分證字號" required>
                        <input type="text" value={form.id_number} onChange={e => handleChange('id_number', e.target.value)} className={inputCls} placeholder="A123456789" />
                    </Field>
                </div>
            </Section>

            {/* ── 聯絡方式 ── */}
            <Section icon={Phone} title="聯絡方式">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Field label="手機號碼" required>
                        <input type="tel" value={form.phone_mobile} onChange={e => handleChange('phone_mobile', e.target.value)} className={inputCls} placeholder="0912-345-678" />
                    </Field>
                    <Field label="家用電話">
                        <input type="tel" value={form.phone_home} onChange={e => handleChange('phone_home', e.target.value)} className={inputCls} placeholder="02-1234-5678" />
                    </Field>
                    <Field label="Line ID" required>
                        <input type="text" value={form.line_id} onChange={e => handleChange('line_id', e.target.value)} className={inputCls} />
                    </Field>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                    <Field label="主要 Email" required>
                        <input type="email" value={form.email_primary} onChange={e => handleChange('email_primary', e.target.value)} className={inputCls} />
                    </Field>
                    <Field label="備用 Email">
                        <input type="email" value={form.email_secondary} onChange={e => handleChange('email_secondary', e.target.value)} className={inputCls} />
                    </Field>
                </div>
                <div className="mt-4">
                    <Field label="通訊地址" required>
                        <input type="text" value={form.address} onChange={e => handleChange('address', e.target.value)} className={inputCls} placeholder="請輸入通訊地址" />
                    </Field>
                </div>
            </Section>

            {/* ── 教學資訊 ── */}
            <Section icon={GraduationCap} title="教學資訊">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Field label="講師等級" required>
                        {!isFirstTime && form.instructor_role ? (
                            <div className="flex items-center gap-2">
                                <span className="bh-chip bg-bauhaus-blue text-white text-sm px-4 py-2.5">
                                    {ROLE_OPTIONS.find(r => r.value === form.instructor_role)?.label || form.instructor_role}
                                </span>
                                <span className="text-xs text-bauhaus-black/50">（如需變更請聯繫管理員）</span>
                            </div>
                        ) : (
                            <select value={form.instructor_role} onChange={e => handleChange('instructor_role', e.target.value)} className={selectCls}>
                                <option value="">請選擇</option>
                                {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                        )}
                    </Field>
                    <Field label="接課頻率（學期間）" required>
                        <input type="text" value={form.teaching_freq_semester} onChange={e => handleChange('teaching_freq_semester', e.target.value)} className={inputCls} placeholder="例：每週 2-3 次" />
                    </Field>
                    <Field label="接課頻率（寒暑假）" required>
                        <input type="text" value={form.teaching_freq_vacation} onChange={e => handleChange('teaching_freq_vacation', e.target.value)} className={inputCls} placeholder="例：每週 5 次" />
                    </Field>
                </div>

                <div className="mt-6">
                    <label className="bh-label block mb-3">
                        可接課地區 <span className="text-bauhaus-red">*</span>
                        <span className="ml-2 text-xs text-bauhaus-black/50 normal-case tracking-normal font-medium">（已選 {form.teaching_regions.length} 個縣市）</span>
                    </label>
                    <div className="space-y-4">
                        {Object.entries(TW_REGIONS).map(([area, counties]) => {
                            const allSelected = counties.every(c => form.teaching_regions.includes(c));
                            return (
                                <div key={area} className="bg-bauhaus-muted p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <button
                                            type="button"
                                            onClick={() => selectAllInArea(counties)}
                                            className={`inline-flex items-center gap-1 border-2 border-bauhaus-black px-2 py-0.5 text-xs font-bold uppercase tracking-wide transition-colors ${allSelected ? 'bg-bauhaus-blue text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'}`}
                                        >
                                            {allSelected ? '✓ 全選' : '全選'}
                                        </button>
                                        <span className="text-sm font-black text-bauhaus-black uppercase tracking-wide">{area}</span>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {counties.map(county => (
                                            <label key={county}
                                                className={`bh-chip cursor-pointer transition-colors ${form.teaching_regions.includes(county) ? 'bg-bauhaus-blue text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'}`}
                                            >
                                                <input type="checkbox" className="sr-only"
                                                    checked={form.teaching_regions.includes(county)}
                                                    onChange={() => toggleRegion(county)} />
                                                {county}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </Section>

            {/* ── 匯款銀行資訊 ── */}
            <Section icon={Landmark} title="匯款銀行資訊">
                <p className="text-sm text-bauhaus-black/70 mb-4 font-medium">
                    此區資訊將用於「廠商匯款申請書」的自動填寫，<strong className="font-black text-bauhaus-black">匯款戶名請務必與身分證姓名相同</strong>。
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="匯款戶名" required>
                        <input
                            type="text"
                            value={form.bank_account_name}
                            onChange={e => handleChange('bank_account_name', e.target.value)}
                            className={inputCls}
                            placeholder="須與身分證姓名相同"
                        />
                    </Field>
                    <Field label="銀行別" required>
                        <input
                            type="text"
                            value={form.bank_name}
                            onChange={e => handleChange('bank_name', e.target.value)}
                            className={inputCls}
                            placeholder="例：華南銀行"
                        />
                    </Field>
                    <Field label="分行別" required>
                        <input
                            type="text"
                            value={form.bank_branch}
                            onChange={e => handleChange('bank_branch', e.target.value)}
                            className={inputCls}
                            placeholder="例：仁愛分行"
                        />
                    </Field>
                    <Field label="銀行代碼（7 碼）" required>
                        <input
                            type="text"
                            value={form.bank_code}
                            onChange={e => handleChange('bank_code', e.target.value.replace(/\D/g, '').slice(0, 7))}
                            className={inputCls + ' font-mono tracking-wider'}
                            placeholder="0000000"
                            maxLength={7}
                        />
                        <p className="text-xs text-bauhaus-black/50 mt-1 font-medium">共 7 碼數字（{form.bank_code.length}/7）</p>
                    </Field>
                    <Field label="銀行帳號（含檢查碼）" required>
                        <input
                            type="text"
                            value={form.bank_account_number}
                            onChange={e => handleChange('bank_account_number', e.target.value.replace(/[^0-9-]/g, ''))}
                            className={inputCls + ' font-mono tracking-wider md:col-span-2'}
                            placeholder="請填寫完整帳號"
                        />
                    </Field>
                </div>
                <div className="mt-4 bg-bauhaus-yellow/10 border-2 border-bauhaus-black p-3 text-xs text-bauhaus-black font-bold">
                    💡 銀行帳戶為華南銀行者免扣手續費；非華南銀行將扣匯款手續費 30 元。
                </div>
            </Section>

            {/* ── 經歷與自我介紹 ── */}
            <Section icon={FileText} title="經歷與自我介紹">
                <Field label="教學經歷 / 教學理念 / 想說的話" required>
                    <textarea
                        value={form.bio_notes}
                        onChange={e => handleChange('bio_notes', e.target.value)}
                        rows={6}
                        className={inputCls + ' resize-y'}
                        placeholder="請分享您的教學經歷、理念，或任何想說的話⋯⋯"
                    />
                </Field>
            </Section>

            {/* ── 文件上傳 ── */}
            <Section icon={Upload} title="文件上傳">
                <p className="text-sm text-bauhaus-black/70 mb-4 font-medium">以下文件皆為必填，支援 JPEG、PNG、GIF、WebP 格式，單檔上限 20MB</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {DOC_TYPES.map(({ key, label, Icon: docIcon }) => {
                        const Icon = docIcon;
                        return (
                        <div key={key} className="border-2 border-dashed border-bauhaus-black/30 p-4 text-center hover:border-bauhaus-blue transition-colors">
                            <div className="text-sm font-bold text-bauhaus-black mb-3 flex items-center justify-center gap-1.5">
                                <Icon className="w-4 h-4 text-bauhaus-black/40" /> {label} <span className="text-bauhaus-red">*</span>
                            </div>

                            {filePreviews[key] ? (
                                <div className="relative group">
                                    <img src={filePreviews[key]} alt={label} className="w-full h-32 object-cover border-2 border-bauhaus-black" />
                                    <button
                                        onClick={() => handleRemoveFile(key)}
                                        className="absolute top-1 right-1 bg-bauhaus-red hover:bg-bauhaus-red/90 text-white rounded-full p-3 md:p-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity border-2 border-bauhaus-black flex items-center justify-center min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                    {form[`${key}_size`] && (
                                        <div className="text-[10px] text-bauhaus-black/50 mt-1 font-bold">
                                            {(form[`${key}_size`] / 1024 / 1024).toFixed(1)} MB
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => fileRefs.current[key]?.click()}
                                    disabled={uploading[key]}
                                    className="w-full h-32 flex flex-col items-center justify-center gap-2 text-bauhaus-black/40 hover:text-bauhaus-blue transition-colors"
                                >
                                    {uploading[key] ? (
                                        <div className="flex flex-col items-center gap-1">
                                            <div className="w-6 h-6 border-2 border-bauhaus-blue border-t-transparent rounded-full animate-spin" />
                                            <span className="text-xs">上傳中⋯</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Upload className="w-8 h-8" />
                                            <span className="text-xs">點擊上傳</span>
                                        </>
                                    )}
                                </button>
                            )}

                            <input
                                ref={el => (fileRefs.current[key] = el)}
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={e => {
                                    if (e.target.files[0]) handleFileUpload(key, e.target.files[0]);
                                    e.target.value = '';
                                }}
                            />
                        </div>
                        );
                    })}
                </div>
            </Section>

            {/* ── 儲存按鈕 ── */}
            <div className="flex justify-end mt-8 mb-12">
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className="bh-btn bh-btn-blue px-8 py-3 text-base w-full sm:w-auto"
                >
                    <Save className="w-5 h-5" />
                    {saving ? '儲存中⋯' : isFirstTime ? '送出資料' : '儲存個人資料'}
                </button>
            </div>

            {/* ── 簽約狀態 ── */}
            {!isFirstTime && (
                <Section icon={FileSignature} title="合約簽署">
                    {contractInfo ? (
                        <div>
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-10 h-10 bg-bauhaus-blue border-2 border-bauhaus-black flex items-center justify-center">
                                    <CheckCircle2 className="w-5 h-5 text-white" />
                                </div>
                                <div>
                                    <div className="font-black text-bauhaus-blue text-sm">已簽約</div>
                                    <div className="text-xs text-bauhaus-black/50 font-bold">
                                        {new Date(contractInfo.signed_at).toLocaleDateString('zh-TW')} 簽署
                                    </div>
                                </div>
                            </div>

                            {latestDocVersions && (() => {
                                const signedVersions = contractInfo.doc_versions || {
                                    rules: contractInfo.rules_doc_version,
                                    compensation: contractInfo.compensation_doc_version,
                                    contract: contractInfo.contract_doc_version,
                                };
                                const hasUpdate = Object.entries(latestDocVersions).some(
                                    ([k, v]) => (signedVersions[k] || 0) < v
                                );
                                return hasUpdate;
                            })() && (
                                <div className="bg-bauhaus-yellow/10 border-2 border-bauhaus-black p-3 mb-4 flex items-start gap-2">
                                    <Clock className="w-4 h-4 text-bauhaus-black mt-0.5 shrink-0" />
                                    <p className="text-sm text-bauhaus-black font-medium">
                                        合約文件已更新為新版本，建議您<Link to="/contract" className="font-black text-bauhaus-blue hover:underline">重新簽約</Link>以確認最新內容。
                                    </p>
                                </div>
                            )}

                            <div className="flex flex-col sm:flex-row gap-3">
                                <Link
                                    to={`/contract/view/${contractInfo.id}`}
                                    className="bh-btn bh-btn-outline px-5 py-2.5 text-sm"
                                >
                                    <Eye className="w-4 h-4" /> 查看合約
                                </Link>
                                <Link
                                    to="/contract"
                                    className="bh-btn bh-btn-outline px-5 py-2.5 text-sm"
                                >
                                    <FileSignature className="w-4 h-4" /> 重新簽約
                                </Link>
                            </div>
                        </div>
                    ) : (
                        <div className="text-center py-6">
                            <div className="w-16 h-16 bg-bauhaus-blue/10 border-2 border-bauhaus-black rounded-full flex items-center justify-center mx-auto mb-4">
                                <FileSignature className="w-8 h-8 text-bauhaus-blue" />
                            </div>
                            <h3 className="font-black text-bauhaus-black mb-1">尚未簽約</h3>
                            <p className="text-sm text-bauhaus-black/60 mb-5 font-medium">請完成線上合約簽署程序</p>
                            <Link
                                to="/contract"
                                className="bh-btn bh-btn-blue px-6 py-3 text-sm"
                            >
                                <FileSignature className="w-4 h-4" /> 前往簽約
                            </Link>
                        </div>
                    )}
                </Section>
            )}

            {/* ── 認領歷史講師資料 Modal ── */}
            {showClaimModal && (
                <ClaimInstructorModal
                    initialName={form.full_name || profile?.name || ''}
                    onClose={() => setShowClaimModal(false)}
                    onSubmitted={() => {
                        setShowClaimModal(false);
                        loadExistingClaim();
                    }}
                />
            )}

            {/* ── 註冊完成彈窗 ── */}
            {showSuccess && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-bauhaus-black/60 p-4">
                    <div className="bg-white border-2 lg:border-4 border-bauhaus-black shadow-hard-lg max-w-md w-full p-8 text-center animate-in">
                        <div className="w-20 h-20 bg-bauhaus-blue/10 border-2 border-bauhaus-black rounded-full flex items-center justify-center mx-auto mb-5">
                            <PartyPopper className="w-10 h-10 text-bauhaus-blue" />
                        </div>
                        <h2 className="text-2xl font-black text-bauhaus-black mb-3">恭喜你完成註冊！</h2>
                        <p className="text-bauhaus-black/70 mb-2 font-medium">
                            你的個人資料已成功送出，目前正在等待管理員審核。
                        </p>
                        <div className="bg-bauhaus-yellow/10 border-2 border-bauhaus-black p-4 my-5 text-left">
                            <p className="text-bauhaus-black text-sm font-bold">
                                請在<strong>「夢想一號講師個人群組」</strong>中通知管理員您已完成註冊，以加速審核流程。
                            </p>
                        </div>
                        <p className="text-bauhaus-black/50 text-sm mb-6 font-medium">
                            審核通過後即可瀏覽所有培訓課程內容。
                        </p>
                        <button
                            onClick={() => { setShowSuccess(false); navigate('/pending'); }}
                            className="bh-btn bh-btn-blue w-full py-3"
                        >
                            我知道了
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════
// 我的成就：徽章牆 + 完成培訓證明下載
// 資料來源：get_teacher_stats() RPC（SQL 上線後才有真資料）
// ═══════════════════════════════════════════════════════════════
const AchievementsSection = ({ userId, certName }) => {
    const [hours, setHours] = useState(0);
    const [sessions, setSessions] = useState(0);
    const [completedCourses, setCompletedCourses] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [downloading, setDownloading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(false);
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_teaching_leaderboard');
                if (rpcErr) throw rpcErr;
                if (cancelled) return;
                const mine = (data || []).find((r) => r.user_id === userId);
                setHours(Number(mine?.total_hours || 0));
                setSessions(Number(mine?.session_count || 0));
                // 完訓數（給證書解鎖用）：讀自己的 course_training_status；失敗不影響成就顯示
                try {
                    const { count } = await supabase
                        .from('course_training_status')
                        .select('id', { count: 'exact', head: true })
                        .eq('user_id', userId)
                        .eq('status', 'completed');
                    if (!cancelled) setCompletedCourses(Number(count || 0));
                } catch { /* 證書解鎖條件維持 0 */ }
            } catch (err) {
                console.error('Achievements load failed:', err);
                if (!cancelled) setError(true);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [userId]);

    const earnedCount = MILESTONES.filter((m) => hours >= m.hours).length;
    const next = nextMilestone(hours);
    const canDownloadCert = completedCourses >= 1;

    const handleDownloadCert = async () => {
        setDownloading(true);
        try {
            await downloadCertificate({ name: certName || '講師' });
        } catch (err) {
            console.error('Certificate generation failed:', err);
            alert('證書產生失敗，請稍後再試。');
        } finally {
            setDownloading(false);
        }
    };

    const BADGE_COLORS = ['bg-bauhaus-red', 'bg-bauhaus-blue', 'bg-bauhaus-yellow'];

    return (
        <div className="bh-card p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-black uppercase tracking-tight text-bauhaus-black flex items-center gap-2">
                    <span className="inline-flex items-center justify-center w-8 h-8 bg-bauhaus-yellow text-bauhaus-black shrink-0">
                        <Trophy className="w-4 h-4" />
                    </span>
                    我的教學成就
                </h2>
                {!loading && !error && (
                    <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black">
                        里程碑 {earnedCount} / {MILESTONES.length}
                    </span>
                )}
            </div>

            {loading ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[...Array(8)].map((_, i) => (
                        <div key={i} className="h-28 bg-bauhaus-muted animate-pulse" />
                    ))}
                </div>
            ) : error ? (
                <div className="py-8 text-center">
                    <AlertCircle className="w-8 h-8 text-bauhaus-red/50 mx-auto mb-2" />
                    <p className="text-sm text-bauhaus-black/60 font-medium">成就載入失敗，請稍後再試。</p>
                </div>
            ) : (
                <>
                    {/* 教學數據摘要 */}
                    <div className="grid grid-cols-2 gap-3 mb-5">
                        {[
                            { label: '接課時數', value: toHours(hours), unit: '小時' },
                            { label: '接課場次', value: sessions, unit: '場' },
                        ].map((s) => (
                            <div key={s.label} className="border-2 border-bauhaus-black bg-white p-3 text-center">
                                <div className="text-xl sm:text-2xl font-black text-bauhaus-black tabular-nums">{s.value}</div>
                                <div className="text-[11px] text-bauhaus-black/60 mt-0.5 font-bold">{s.label}（{s.unit}）</div>
                            </div>
                        ))}
                    </div>

                    {/* 接課里程碑 */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {MILESTONES.map((m, idx) => {
                            const earned = hours >= m.hours;
                            return (
                                <div
                                    key={m.hours}
                                    className={`relative border-2 p-3 flex flex-col items-center text-center transition-all ${
                                        earned
                                            ? 'border-bauhaus-black bg-white'
                                            : 'border-bauhaus-black/20 bg-bauhaus-muted grayscale'
                                    }`}
                                >
                                    <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-2 text-2xl border-2 border-bauhaus-black ${
                                        earned ? BADGE_COLORS[idx % 3] : 'bg-bauhaus-muted'
                                    }`}>
                                        {earned ? m.emoji : <Lock className="w-5 h-5 text-bauhaus-black/40" />}
                                    </div>
                                    <div className={`text-sm font-black ${earned ? 'text-bauhaus-black' : 'text-bauhaus-black/30'}`}>
                                        {m.name}
                                    </div>
                                    <div className={`text-[11px] mt-0.5 leading-tight font-bold ${earned ? 'text-bauhaus-black/70' : 'text-bauhaus-black/30'}`}>
                                        {earned ? '已達成' : `接課滿 ${m.hours} 小時`}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {next && (
                        <p className="mt-3 text-xs text-center text-bauhaus-black/60 font-medium">
                            再接課 <b className="text-bauhaus-black font-black tabular-nums">{next.remain}</b> 小時，即可解鎖「{next.emoji} {next.name}」
                        </p>
                    )}

                    {/* 完成培訓證明 */}
                    {canDownloadCert && (
                        <div className="mt-5 pt-5 border-t-2 border-bauhaus-black flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-bauhaus-blue border-2 border-bauhaus-black flex items-center justify-center shrink-0">
                                    <CheckCircle2 className="w-5 h-5 text-white" />
                                </div>
                                <div>
                                    <div className="font-black text-bauhaus-black text-sm">恭喜完成培訓！</div>
                                    <div className="text-xs text-bauhaus-black/50 font-bold">你已完成培訓課程，可下載完成證明</div>
                                </div>
                            </div>
                            <button
                                onClick={handleDownloadCert}
                                disabled={downloading}
                                className="bh-btn bh-btn-blue px-5 py-3 sm:py-2.5 text-sm w-full sm:w-auto"
                            >
                                <Download className="w-4 h-4" />
                                {downloading ? '產生中⋯' : '下載完成培訓證明'}
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

const Section = ({ icon, title, children }) => {
    const Icon = icon;
    return (
    <div className="bh-card p-6 mb-6">
        <h2 className="text-lg lg:text-xl font-black uppercase tracking-tight text-bauhaus-black mb-4 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-8 h-8 bg-bauhaus-black text-white shrink-0">
                <Icon className="w-4 h-4" />
            </span>
            {title}
        </h2>
        {children}
    </div>
    );
};

const Field = ({ label, required, children }) => (
    <div>
        <label className="bh-label block mb-1">
            {label} {required && <span className="text-bauhaus-red">*</span>}
        </label>
        {children}
    </div>
);

// ═══════════════════════════════════════════════════════════════
// 認領歷史講師資料 Modal
// 流程:輸入姓名(+選填手機末四碼)→ 搜尋 → 選一筆 → 送出申請
// 後端 RPC search_unlinked_instructors 只回遮罩過的資訊
// ═══════════════════════════════════════════════════════════════
const ClaimInstructorModal = ({ initialName, onClose, onSubmitted }) => {
    const [nameQuery, setNameQuery] = useState(initialName || '');
    const [phoneLast4, setPhoneLast4] = useState('');
    const [results, setResults] = useState([]);
    const [searched, setSearched] = useState(false);
    const [searching, setSearching] = useState(false);
    const [selected, setSelected] = useState(null);
    const [phoneFull, setPhoneFull] = useState('');
    const [message, setMessage] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [err, setErr] = useState('');

    const inputCls = 'bh-input text-sm';

    const doSearch = async (e) => {
        e?.preventDefault();
        setErr('');
        if (!nameQuery.trim()) {
            setErr('請輸入姓名');
            return;
        }
        if (phoneLast4 && phoneLast4.length !== 4) {
            setErr('手機末四碼請填 4 位數,或留白');
            return;
        }
        setSearching(true);
        const { data, error } = await supabase.rpc('search_unlinked_instructors', {
            name_query: nameQuery.trim(),
            phone_last4: phoneLast4 || null,
        });
        setSearching(false);
        setSearched(true);
        if (error) {
            setErr('搜尋失敗:' + error.message);
            return;
        }
        setResults(data || []);
        setSelected(null);
    };

    const doSubmit = async () => {
        if (!selected) return;
        setErr('');
        setSubmitting(true);
        const { error } = await supabase.rpc('submit_claim_request', {
            target_instructor_id: selected.id,
            phone_input: phoneFull.trim() || null,
            message_input: message.trim() || null,
        });
        setSubmitting(false);
        if (error) {
            setErr('送出失敗:' + error.message);
            return;
        }
        alert('已送出認領申請,請等待管理員審核。');
        onSubmitted();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bauhaus-black/60 p-4">
            <div className="bg-white border-2 lg:border-4 border-bauhaus-black shadow-hard-lg max-w-lg w-full max-h-[85vh] flex flex-col">
                <div className="px-6 py-4 border-b-2 border-bauhaus-black flex items-start justify-between">
                    <div>
                        <h2 className="font-black uppercase tracking-tight text-lg text-bauhaus-black flex items-center gap-2">
                            <UserSearch className="w-5 h-5 text-bauhaus-blue" /> 認領講師資料
                        </h2>
                        <p className="text-xs text-bauhaus-black/60 mt-1 font-medium">
                            請輸入您過去填寫資料時使用的姓名,我們會在歷史記錄中比對。
                        </p>
                    </div>
                    <button onClick={onClose} className="relative text-bauhaus-black/40 hover:text-bauhaus-black shrink-0 before:absolute before:-inset-2 before:content-['']">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                    {!selected && (
                        <>
                            <form onSubmit={doSearch} className="space-y-3">
                                <Field label="姓名" required>
                                    <input
                                        type="text" value={nameQuery}
                                        onChange={e => setNameQuery(e.target.value)}
                                        className={inputCls} placeholder="例:王小明"
                                    />
                                </Field>
                                <Field label="手機末四碼(選填,用以縮小結果)">
                                    <input
                                        type="text" value={phoneLast4}
                                        onChange={e => setPhoneLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                        className={inputCls} placeholder="1234" maxLength={4}
                                    />
                                </Field>
                                <button
                                    type="submit" disabled={searching}
                                    className="bh-btn bh-btn-blue w-full px-4 py-2.5 text-sm"
                                >
                                    {searching ? '搜尋中⋯' : '搜尋'}
                                </button>
                            </form>

                            {searched && results.length === 0 && !searching && (
                                <div className="border-2 border-bauhaus-black bg-bauhaus-muted p-4 text-center text-bauhaus-black/60 text-sm font-medium">
                                    <AlertCircle className="w-5 h-5 mx-auto mb-1 text-bauhaus-black/40" />
                                    沒有找到符合的講師資料,請確認姓名,或直接填寫下方表單註冊新講師。
                                </div>
                            )}

                            {results.length > 0 && (
                                <div className="space-y-2">
                                    <div className="text-xs font-bold text-bauhaus-black/60 px-1">
                                        找到 {results.length} 筆,請點選您本人
                                    </div>
                                    {results.map(r => (
                                        <button
                                            key={r.id}
                                            onClick={() => { setSelected(r); setPhoneFull(''); setMessage(''); }}
                                            className="w-full text-left p-3 border-2 border-bauhaus-black hover:bg-bauhaus-muted transition-colors"
                                        >
                                            <div className="font-black text-bauhaus-black">{r.full_name}</div>
                                            <div className="text-xs text-bauhaus-black/60 mt-0.5 flex flex-wrap gap-x-3">
                                                {r.email_masked && <span>📧 {r.email_masked}</span>}
                                                {r.phone_masked && <span>📱 {r.phone_masked}</span>}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </>
                    )}

                    {selected && (
                        <div className="space-y-4">
                            <div className="bg-bauhaus-blue/10 border-2 border-bauhaus-black p-4">
                                <div className="text-xs text-bauhaus-blue font-black uppercase tracking-wide mb-1">即將認領</div>
                                <div className="font-black text-bauhaus-black">{selected.full_name}</div>
                                <div className="text-xs text-bauhaus-black/60 mt-0.5 flex flex-wrap gap-x-3">
                                    {selected.email_masked && <span>📧 {selected.email_masked}</span>}
                                    {selected.phone_masked && <span>📱 {selected.phone_masked}</span>}
                                </div>
                                <button onClick={() => setSelected(null)}
                                    className="relative text-xs text-bauhaus-blue font-bold hover:underline mt-2 before:absolute before:-inset-2 before:content-['']">
                                    ← 重新選擇
                                </button>
                            </div>

                            <Field label="您的完整手機號碼(供管理員核對)">
                                <input
                                    type="tel" value={phoneFull}
                                    onChange={e => setPhoneFull(e.target.value)}
                                    className={inputCls} placeholder="0912345678"
                                />
                            </Field>

                            <Field label="說明(選填,協助管理員快速辨識)">
                                <textarea
                                    value={message}
                                    onChange={e => setMessage(e.target.value)}
                                    rows={3}
                                    className={inputCls + ' resize-none'}
                                    placeholder="例:之前用 work@gmail.com 註冊,現在改用個人 Gmail"
                                />
                            </Field>
                        </div>
                    )}

                    {err && (
                        <div className="text-sm text-white bg-bauhaus-red border-2 border-bauhaus-black px-3 py-2 font-bold">
                            {err}
                        </div>
                    )}
                </div>

                {selected && (
                    <div className="px-6 py-3 border-t-2 border-bauhaus-black flex justify-end gap-2">
                        <button onClick={onClose}
                            className="bh-btn-ghost px-4 py-3 md:py-2 text-sm">
                            取消
                        </button>
                        <button onClick={doSubmit} disabled={submitting}
                            className="bh-btn bh-btn-blue px-5 py-3 md:py-2 text-sm">
                            <Send className="w-4 h-4" />
                            {submitting ? '送出⋯' : '送出認領申請'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ProfilePage;
