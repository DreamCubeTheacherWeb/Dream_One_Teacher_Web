import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { Save, Upload, X, User, Phone, GraduationCap, FileText, CreditCard, Camera, Landmark, Pencil, PartyPopper, FileSignature, CheckCircle2, Download, Eye, Calendar, Clock, UserSearch, Send, AlertCircle, Trophy, Lock, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchTeacherBadges, groupByCategory, CATEGORY_ORDER } from '../lib/badges';
import { downloadCertificate } from '../lib/certificate';
import { stripAdminManagedInstructorFields } from '../lib/instructorProfile';
import BadgeVisual from '../components/BadgeVisual';
import { canAccessInstructorContracts } from '../lib/featureFlags';
import { PROFILE_SAVED_EVENT, REQUIRED_PROFILE_FIELDS } from '../lib/profileCompletion';

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

const INITIAL_FORM = {
    full_name: '', nickname: '', gender: '', birth_date: '', id_number: '',
    phone_mobile: '', phone_home: '', line_id: '', address: '', household_address: '',
    email_primary: '', email_secondary: '',
    instructor_role: '', teaching_freq_semester: '', teaching_freq_vacation: '',
    teaching_regions: [],
    bio_notes: '',
    wca_id: '',
    bank_account_name: '', bank_name: '', bank_branch: '',
    bank_account_number: '', bank_code: '',
    photo_path: null, photo_mime: null, photo_size: null, photo_uploaded_at: null,
    id_front_path: null, id_front_mime: null, id_front_size: null, id_front_uploaded_at: null,
    id_back_path: null, id_back_mime: null, id_back_size: null, id_back_uploaded_at: null,
    bankbook_path: null, bankbook_mime: null, bankbook_size: null, bankbook_uploaded_at: null,
};

// ── 草稿暫存（防「填一填換頁整個不見」）──
// 圖片本體已即時上傳 Storage，但路徑等 metadata 要等整份表單送出才會寫入 DB；
// 因此檔案欄位也必須進草稿，否則切頁或重新掛載後會看起來像是證件消失。
const draftKeyFor = (uid) => `profile_draft_${uid}`;
const DRAFT_VERSION = 2;
const pickDraftFields = (form) => stripAdminManagedInstructorFields(form);
const clearDraft = (uid) => {
    try { localStorage.removeItem(draftKeyFor(uid)); } catch { /* 略過 */ }
};
const readDraft = (uid, baseSnapshot, allowLegacyDraft) => {
    try {
        const draft = JSON.parse(localStorage.getItem(draftKeyFor(uid)) || 'null');
        if (!draft) return null;

        if (draft.version === DRAFT_VERSION && draft.data) {
            if (draft.baseSnapshot !== baseSnapshot) {
                clearDraft(uid);
                return null;
            }
            return stripAdminManagedInstructorFields(draft.data);
        }

        // 舊版草稿沒有基準快照：首次建檔仍可保留；已有 DB 資料時不可冒險覆蓋較新的值。
        if (allowLegacyDraft) return stripAdminManagedInstructorFields(draft);
        clearDraft(uid);
        return null;
    }
    catch { return null; }
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
    const pendingStorageDeletes = useRef(new Set());
    const originalWcaId = useRef('');
    // 草稿暫存：hydrated 為 true 後才寫 localStorage（避免載入中的空表覆蓋既有草稿）；
    // savedSnapshot 記「已存進 DB 的文字欄位版本」，用來判斷是否有未儲存變更。
    const hydrated = useRef(false);
    const savedSnapshot = useRef('');
    const [contractInfo, setContractInfo] = useState(null);
    const [latestDocVersions, setLatestDocVersions] = useState(null);
    const [showClaimModal, setShowClaimModal] = useState(false);
    const [existingClaim, setExistingClaim] = useState(null);
    const [instructorId, setInstructorId] = useState(null);
    const [wcaLocked, setWcaLocked] = useState(false);
    const canUseContracts = canAccessInstructorContracts(profile?.role);

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

        let nextForm;

        if (data) {
            setIsFirstTime(false);
            setInstructorId(data.id || null);
            const formData = {};
            for (const key of Object.keys(INITIAL_FORM)) {
                formData[key] = data[key] ?? INITIAL_FORM[key];
            }
            // 記下「已存進 DB 的文字欄位版本」，並套用未儲存的本機草稿（若有）
            savedSnapshot.current = JSON.stringify(pickDraftFields(formData));
            const draft = readDraft(user.id, savedSnapshot.current, false);
            nextForm = draft ? { ...formData, ...draft } : formData;
            originalWcaId.current = formData.wca_id || '';
            setWcaLocked(!!data.hide_from_leaderboard);
        } else {
            setIsFirstTime(true);
            setInstructorId(null);
            const base = {
                ...INITIAL_FORM,
                full_name: profile?.name || '',
                email_primary: user.email || '',
            };
            savedSnapshot.current = JSON.stringify(pickDraftFields(base));
            const draft = readDraft(user.id, savedSnapshot.current, true);
            nextForm = draft ? { ...base, ...draft } : base;
        }

        setForm(nextForm);

        // 預覽要依「DB + 本機草稿」的合併結果建立；首次填寫、尚未送出時
        // 檔案只存在 Storage 與草稿，若只看 DB 就會誤判為未上傳。
        const previews = {};
        const allDocKeys = ['photo', ...DOC_TYPES.map(d => d.key)];
        for (const key of allDocKeys) {
            const storedPath = nextForm[`${key}_path`];
            if (storedPath) {
                const { data: urlData } = await supabase.storage
                    .from('instructor_uploads')
                    .createSignedUrl(storedPath, 3600);
                if (urlData?.signedUrl) previews[key] = urlData.signedUrl;
            }
        }
        setFilePreviews(previews);

        hydrated.current = true; // 載入完成後才允許草稿自動寫入
        setLoading(false);
    };

    useEffect(() => {
        if (user?.id) {
            loadProfile();
            if (canUseContracts) loadContractStatus();
            loadExistingClaim();
        }
        // Supabase 會在 TOKEN_REFRESHED 時提供新的 user 物件；只依 user id 載入，
        // 避免 token 更新把使用者尚未送出的表單重新以 DB 舊值覆蓋。
        // 這三個 loader 刻意不放進 dependency，否則每次 render 都會重新查詢。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id, canUseContracts]);

    // 草稿自動暫存：hydrated 後，表單一有變動就寫入 localStorage（包含已上傳檔案的 metadata）
    useEffect(() => {
        if (!hydrated.current || !user) return;
        try {
            localStorage.setItem(draftKeyFor(user.id), JSON.stringify({
                version: DRAFT_VERSION,
                baseSnapshot: savedSnapshot.current,
                data: pickDraftFields(form),
            }));
        } catch { /* localStorage 滿了或被停用就略過，不影響填寫 */ }
    }, [form, user]);

    // 關閉分頁 / 強制重整時，若有未儲存變更，跳原生確認（站內換頁靠上面的草稿還原，不會掉資料）
    useEffect(() => {
        const handler = (e) => {
            if (JSON.stringify(pickDraftFields(form)) !== savedSnapshot.current) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [form]);

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

        const previousPath = form[`${docType}_path`];
        if (previousPath && previousPath !== path) {
            pendingStorageDeletes.current.add(previousPath);
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

    const handleRemoveFile = (docType) => {
        const previousPath = form[`${docType}_path`];
        if (previousPath) pendingStorageDeletes.current.add(previousPath);
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
        const missing = REQUIRED_PROFILE_FIELDS.filter(f => !form[f.key]?.toString().trim());
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

        // WCA 編號：新填或變更時，送出前確認照實填寫
        const wcaVal = form.wca_id?.trim() || '';
        if (wcaVal && wcaVal !== originalWcaId.current) {
            const ok = window.confirm(
                `你填寫的 WCA 選手編號：${wcaVal}\n\n送出前請再次確認這是「你本人」的真實編號。填寫不實者，管理員有權刪除；累計三次故意不實，將取消你參與排名的資格。\n\n確定照實填寫並送出嗎？`
            );
            if (!ok) return;
        }

        setSaving(true);
        const payload = {
            user_id: user.id,
            ...stripAdminManagedInstructorFields(form),
            wca_id: form.wca_id?.trim() || null,
        };

        const { error } = await supabase
            .from('instructors')
            .upsert(payload, { onConflict: 'user_id' });

        if (error) {
            alert('儲存失敗：' + error.message);
            setSaving(false);
            return;
        }


        // DB 已指向新路徑後才清理舊檔。清理失敗只留下孤兒檔，不會破壞已儲存的資料。
        const obsoletePaths = [...pendingStorageDeletes.current];
        if (obsoletePaths.length) {
            const { error: cleanupError } = await supabase.storage
                .from('instructor_uploads')
                .remove(obsoletePaths);
            if (cleanupError) {
                console.error('Failed to clean up replaced profile files:', cleanupError);
            } else {
                pendingStorageDeletes.current.clear();
            }
        }

        // 儲存成功：清掉本機草稿、更新「已存版本」快照（避免離開時誤跳未儲存警告）
        clearDraft(user.id);
        savedSnapshot.current = JSON.stringify(pickDraftFields(form));
        window.dispatchEvent(new CustomEvent(PROFILE_SAVED_EVENT, { detail: payload }));

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
                    <div className="w-10 h-10 bg-bauhaus-yellow border-2 border-bauhaus-black rounded-lg flex items-center justify-center shrink-0">
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
                    <div className="w-10 h-10 bg-bauhaus-blue border-2 border-bauhaus-black rounded-lg flex items-center justify-center shrink-0">
                        <UserSearch className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1">
                        <p className="text-bauhaus-black font-black">您是已建檔的講師嗎?</p>
                        <p className="text-bauhaus-black/70 text-sm mt-0.5 font-medium">
                            如果您之前已經填過資料、想用這個 Google 帳號接收歷史記錄,請點下方認領,輸入姓名並核對手機與身分證末四碼,相符即可立即啟用(不需等待審核)。
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
                <AchievementsSection userId={user.id} instructorId={instructorId} certName={form.full_name || profile?.name || ''} />
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
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="通訊地址" required>
                        <input type="text" value={form.address} onChange={e => handleChange('address', e.target.value)} className={inputCls} placeholder="請輸入通訊地址" />
                    </Field>
                    <Field label="戶籍地址" required>
                        <div className="flex gap-2">
                            <input type="text" value={form.household_address} onChange={e => handleChange('household_address', e.target.value)} className={inputCls} placeholder="請輸入戶籍地址" />
                            <button
                                type="button"
                                onClick={() => handleChange('household_address', form.address)}
                                className="shrink-0 border-2 border-bauhaus-black rounded-lg px-3 min-h-[44px] text-xs font-bold bg-white text-bauhaus-black hover:bg-bauhaus-muted whitespace-nowrap transition-colors"
                            >
                                同通訊地址
                            </button>
                        </div>
                    </Field>
                </div>
            </Section>

            {/* ── 教學資訊 ── */}
            <Section icon={GraduationCap} title="教學資訊">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Field label="講師等級">
                        {/* 等級一律由系統/管理員決定,老師不可自選:認領者沿用名冊原等級,
                            全新老師預設「實習」(伺服器端 guard_instructor_role 也會強制) */}
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="bh-chip bg-bauhaus-blue text-white text-sm px-4 py-2.5">
                                {ROLE_OPTIONS.find(r => r.value === form.instructor_role)?.label
                                    || (form.instructor_role || '實習')}
                            </span>
                            <span className="text-xs text-bauhaus-black/50">
                                {form.instructor_role ? '（如需變更請聯繫管理員）' : '（首次註冊預設,管理員可調整）'}
                            </span>
                        </div>
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
                                            className={`inline-flex items-center gap-1 border-2 border-bauhaus-black rounded-lg px-2 py-0.5 text-xs font-bold uppercase tracking-wide transition-colors ${allSelected ? 'bg-bauhaus-blue text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'}`}
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
                <div className="mt-4 bg-bauhaus-yellow/10 border-2 border-bauhaus-black rounded-xl p-3 text-xs text-bauhaus-black font-bold">
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
                        <div key={key} className="border-2 border-dashed border-bauhaus-black/30 rounded-xl p-4 text-center hover:border-bauhaus-blue transition-colors">
                            <div className="text-sm font-bold text-bauhaus-black mb-3 flex items-center justify-center gap-1.5">
                                <Icon className="w-4 h-4 text-bauhaus-black/40" /> {label} <span className="text-bauhaus-red">*</span>
                            </div>

                            {filePreviews[key] ? (
                                <div className="relative group">
                                    <img src={filePreviews[key]} alt={label} className="w-full h-32 object-cover border-2 border-bauhaus-black rounded-xl" />
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

            {/* ── WCA 世界賽成績（選填，老師自填）── */}
            <Section icon={Trophy} title="WCA 世界賽成績（選填）">
                <p className="text-sm text-bauhaus-black/60 font-medium mb-3 leading-relaxed">
                    WCA（世界方塊協會，World Cube Association）是全球魔術方塊比賽的官方組織。
                    若你參加過 WCA 正式比賽，填入你的 WCA 選手編號即可；系統會定期依你填的編號，
                    自動抓取 WCA 官方最新成績並顯示在排行榜的「WCA 賽事」榜，你不需自行填寫成績。
                    沒有 WCA 比賽紀錄可以留空。
                </p>
                <div className="bg-bauhaus-yellow border-2 border-bauhaus-black px-3 py-2 mb-4 text-sm font-bold text-bauhaus-black flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>請務必照實填寫自己的 WCA 選手編號。管理員有權刪除不實資料；累計三次故意填寫不實，將取消你參與排名的資格。</span>
                </div>
                {wcaLocked && (
                    <div data-testid="wca-locked-warning" className="bg-bauhaus-red border-2 border-bauhaus-black px-3 py-2 mb-4 text-sm font-bold text-white flex items-start gap-2">
                        <Lock className="w-4 h-4 mt-0.5 shrink-0" />
                        <span>你的 WCA 送出資格已被管理員停用，如有疑問請聯繫管理員。</span>
                    </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="WCA 選手編號（WCA ID）">
                        <input type="text" disabled={wcaLocked} value={form.wca_id || ''} onChange={e => handleChange('wca_id', e.target.value)} className={`${inputCls} disabled:opacity-50 disabled:cursor-not-allowed`} placeholder="例如 2012WUZH01" />
                    </Field>
                    <div className="flex items-end">
                        <a href="https://www.worldcubeassociation.org/" target="_blank" rel="noopener noreferrer" className="bh-btn bh-btn-outline inline-flex items-center justify-center gap-2 text-sm w-full md:w-auto">
                            <Trophy className="w-4 h-4" /> WCA 網站
                        </a>
                    </div>
                </div>

                <div className="mt-6 pt-5 border-t-2 border-bauhaus-black">
                    <div className="bh-label mb-1">各項目成績</div>
                    <p className="text-xs text-bauhaus-black/50 font-medium leading-relaxed">
                        系統會定期依你填的 WCA 選手編號，自動抓取 WCA 官方最新成績並顯示在排行榜的「WCA 賽事」榜，
                        你不需自行填寫；請確認編號正確即可。
                    </p>
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
            {canUseContracts && !isFirstTime && (
                <Section icon={FileSignature} title="合約簽署">
                    {contractInfo ? (
                        <div>
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-10 h-10 bg-bauhaus-blue border-2 border-bauhaus-black rounded-lg flex items-center justify-center">
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
                                <div className="bg-bauhaus-yellow/10 border-2 border-bauhaus-black rounded-xl p-3 mb-4 flex items-start gap-2">
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
                    <div className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard-lg max-w-md w-full p-8 text-center animate-in">
                        <div className="w-20 h-20 bg-bauhaus-blue/10 border-2 border-bauhaus-black rounded-full flex items-center justify-center mx-auto mb-5">
                            <PartyPopper className="w-10 h-10 text-bauhaus-blue" />
                        </div>
                        <h2 className="text-2xl font-black text-bauhaus-black mb-3">恭喜你完成註冊！</h2>
                        <p className="text-bauhaus-black/70 mb-2 font-medium">
                            你的個人資料已成功送出，目前正在等待管理員審核。
                        </p>
                        <div className="bg-bauhaus-yellow/10 border-2 border-bauhaus-black rounded-xl p-4 my-5 text-left">
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
// 我的成就：38 徽章成就牆 + 完成培訓證明下載
// 資料來源：src/lib/badges.js 的 fetchTeacherBadges()（背後呼叫 get_teacher_badge_stats RPC）
// ═══════════════════════════════════════════════════════════════
// 分類 → Bauhaus 三原色循環（不採 badges.js 的 color 十六進位色碼──那是後台用的任意色，
// 前台一律照 DESIGN.md §2/§4 只用三原色 + 黑/白，不散寫色碼、不出現綠色）
const CATEGORY_ACCENTS = ['bg-bauhaus-red', 'bg-bauhaus-blue', 'bg-bauhaus-yellow'];
const categoryAccent = (key) => CATEGORY_ACCENTS[Math.max(0, CATEGORY_ORDER.indexOf(key)) % 3];

const fmtHours = (v) => Math.round((Number(v) || 0) * 10) / 10;

const BadgeCircle = ({ badge, accentClass }) => (
    <div className="flex flex-col items-center text-center w-[72px] sm:w-20">
        <div
            className={`relative w-14 h-14 sm:w-16 sm:h-16 rounded-full border-2 border-bauhaus-black flex items-center justify-center p-1.5 sm:p-2 mb-1.5 shrink-0 ${
                badge.earned ? `${accentClass} shadow-hard-sm` : 'bg-bauhaus-muted'
            }`}
        >
            <BadgeVisual
                badge={badge}
                size={64}
                className={`w-full h-full ${badge.earned ? '' : 'grayscale opacity-40'}`}
            />
            {!badge.earned && (
                <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-bauhaus-black border-2 border-white flex items-center justify-center">
                    <Lock className="w-2.5 h-2.5 text-white" />
                </span>
            )}
        </div>
        <div className={`text-[10px] sm:text-[11px] font-black leading-tight ${badge.earned ? 'text-bauhaus-black' : 'text-bauhaus-black/30'}`}>
            {badge.name}
        </div>
        {!badge.earned && (
            <div className="text-[9px] text-bauhaus-black/40 font-bold leading-tight mt-0.5" title={badge.description}>
                {badge.description}
            </div>
        )}
    </div>
);

const AchievementsSection = ({ userId, instructorId, certName }) => {
    const [badges, setBadges] = useState([]);
    const [stats, setStats] = useState(null);
    const [completedCourses, setCompletedCourses] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [collapsed, setCollapsed] = useState(true);

    useEffect(() => {
        if (!instructorId) { setLoading(false); return undefined; }
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(false);
            try {
                const { badges: b, stats: s, error: fetchErr } = await fetchTeacherBadges(supabase, instructorId);
                if (fetchErr) throw fetchErr;
                if (cancelled) return;
                setBadges(b);
                setStats(s);
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
    }, [instructorId, userId]);

    const grouped = groupByCategory(badges);
    const earnedCount = badges.filter((b) => b.earned).length;
    const totalCount = badges.length;
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

    return (
        <div className="bh-card p-6 mb-6">
            <div
                role="button"
                tabIndex={0}
                onClick={() => setCollapsed(c => !c)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(c => !c); } }}
                className={`flex items-center justify-between gap-2 cursor-pointer select-none ${collapsed ? '' : 'mb-4'}`}
            >
                <h2 className="text-lg font-black uppercase tracking-tight text-bauhaus-black flex items-center gap-2">
                    <span className="inline-flex items-center justify-center w-8 h-8 bg-bauhaus-yellow text-bauhaus-black shrink-0">
                        <Trophy className="w-4 h-4" />
                    </span>
                    我的教學成就
                </h2>
                <div className="flex items-center gap-2 shrink-0">
                    {!loading && !error && (
                        <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black">
                            成就 {earnedCount} / {totalCount}
                        </span>
                    )}
                    {collapsed
                        ? <ChevronDown className="w-5 h-5 text-bauhaus-black" />
                        : <ChevronUp className="w-5 h-5 text-bauhaus-black" />}
                </div>
            </div>

            {!collapsed && (loading ? (
                <div>
                    <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-5">
                        {[...Array(3)].map((_, i) => (
                            <div key={i} className="h-14 bg-bauhaus-muted animate-pulse" />
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-3">
                        {[...Array(10)].map((_, i) => (
                            <div key={i} className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-bauhaus-muted animate-pulse" />
                        ))}
                    </div>
                </div>
            ) : error ? (
                <div className="py-8 text-center">
                    <AlertCircle className="w-8 h-8 text-bauhaus-red/50 mx-auto mb-2" />
                    <p className="text-sm text-bauhaus-black/60 font-medium">成就載入失敗，請稍後再試。</p>
                </div>
            ) : totalCount === 0 ? (
                <div className="py-8 text-center">
                    <div className="flex items-center justify-center gap-2 mb-3">
                        <span className="w-6 h-6 rounded-full bg-bauhaus-red border-2 border-bauhaus-black" />
                        <span className="w-6 h-6 bg-bauhaus-blue border-2 border-bauhaus-black" />
                        <span className="w-6 h-6 bg-bauhaus-yellow border-2 border-bauhaus-black" style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }} />
                    </div>
                    <p className="text-sm text-bauhaus-black/60 font-medium">成就系統準備中，尚未有可解鎖的徽章。</p>
                </div>
            ) : (
                <>
                    {/* 教學數據摘要 */}
                    <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-5">
                        {[
                            { label: '接課時數', value: fmtHours(stats?.total_hours), unit: '小時' },
                            { label: '接課場次', value: stats?.session_count ?? 0, unit: '場' },
                            { label: '觸及人次', value: stats?.student_reach ?? 0, unit: '人次' },
                        ].map((s) => (
                            <div key={s.label} className="border-2 border-bauhaus-black rounded-xl bg-white p-2.5 sm:p-3 text-center">
                                <div className="text-lg sm:text-2xl font-black text-bauhaus-black tabular-nums">
                                    {s.value}<span className="text-[10px] sm:text-xs font-bold ml-0.5">{s.unit}</span>
                                </div>
                                <div className="text-[10px] sm:text-[11px] text-bauhaus-black/60 mt-0.5 font-bold">{s.label}</div>
                            </div>
                        ))}
                    </div>

                    {/* 38 徽章成就牆：依分類分區 */}
                    <div className="space-y-5">
                        {grouped.map((group) => {
                            const accentClass = categoryAccent(group.key);
                            const groupEarned = group.badges.filter((b) => b.earned).length;
                            return (
                                <div key={group.key}>
                                    <h3 className="bh-label mb-2 flex items-center gap-2">
                                        <span className={`w-3 h-3 border border-bauhaus-black shrink-0 ${accentClass}`} />
                                        {group.label}
                                        <span className="text-bauhaus-black/40 font-bold normal-case tracking-normal">
                                            {groupEarned}/{group.badges.length}
                                        </span>
                                    </h3>
                                    <div className="flex flex-wrap gap-x-3 gap-y-4 sm:gap-4">
                                        {group.badges.map((b) => (
                                            <BadgeCircle key={b.key} badge={b} accentClass={accentClass} />
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* 完成培訓證明 */}
                    {canDownloadCert && (
                        <div className="mt-5 pt-5 border-t-2 border-bauhaus-black flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-bauhaus-blue border-2 border-bauhaus-black rounded-lg flex items-center justify-center shrink-0">
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
            ))}
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
    const [results, setResults] = useState([]);
    const [searched, setSearched] = useState(false);
    const [searching, setSearching] = useState(false);
    const [selected, setSelected] = useState(null);
    const [phoneFull, setPhoneFull] = useState('');
    const [idLast4, setIdLast4] = useState('');
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
        setSearching(true);
        const { data, error } = await supabase.rpc('search_unlinked_instructors', {
            name_query: nameQuery.trim(),
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
        const { data, error } = await supabase.rpc('submit_claim_request', {
            target_instructor_id: selected.id,
            phone_input: phoneFull.trim() || null,
            message_input: message.trim() || null,
            id_last4_input: idLast4.trim() || null,
        });
        setSubmitting(false);
        if (error) {
            setErr('送出失敗:' + error.message);
            return;
        }
        // 手機＋身分證末四碼與名冊相符 → 後端已當場自動綁定,不必等審核
        if (data && data.status === 'approved') {
            alert('認領成功!資料與名冊相符,已自動綁定你的講師資料,歡迎回來。');
            window.location.reload();
            return;
        }
        alert('已送出認領申請,請等待管理員審核。');
        onSubmitted();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bauhaus-black/60 p-4">
            <div className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl overflow-hidden shadow-hard-lg max-w-lg w-full max-h-[85vh] flex flex-col">
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
                                <button
                                    type="submit" disabled={searching}
                                    className="bh-btn bh-btn-blue w-full px-4 py-2.5 text-sm"
                                >
                                    {searching ? '搜尋中⋯' : '搜尋'}
                                </button>
                            </form>

                            {searched && results.length === 0 && !searching && (
                                <div className="border-2 border-bauhaus-black rounded-xl bg-bauhaus-muted p-4 text-center text-bauhaus-black/60 text-sm font-medium">
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
                                            onClick={() => { setSelected(r); setPhoneFull(''); setIdLast4(''); setMessage(''); }}
                                            className="w-full text-left p-3 border-2 border-bauhaus-black rounded-xl hover:bg-bauhaus-muted transition-colors"
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
                            <div className="bg-bauhaus-blue/10 border-2 border-bauhaus-black rounded-xl p-4">
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

                            <Field label="您的完整手機號碼(與名冊核對)">
                                <input
                                    type="tel" value={phoneFull}
                                    onChange={e => setPhoneFull(e.target.value)}
                                    className={inputCls} placeholder="0912345678"
                                />
                            </Field>

                            <Field label="身分證字號末四碼(與名冊核對)">
                                <input
                                    type="text" inputMode="numeric" value={idLast4}
                                    onChange={e => setIdLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                    className={inputCls} placeholder="1234" maxLength={4}
                                />
                                <p className="text-xs text-bauhaus-black/50 mt-1 font-medium">
                                    手機與身分證末四碼都與名冊相符,即可立即啟用,不需等待審核。
                                </p>
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
                        <div className="text-sm text-white bg-bauhaus-red border-2 border-bauhaus-black rounded-xl px-3 py-2 font-bold">
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
