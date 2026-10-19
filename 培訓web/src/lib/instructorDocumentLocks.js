// 講師身分證／存摺／匯款資料的鎖定與「開放修改一次」共用規則。
// 權限邊界在 DB（20261020120000_instructor_document_edit_unlocks.sql）；這裡只決定畫面怎麼顯示，
// 判準必須與 DB trigger 一致：路徑或匯入的雲端連結任一非空白就算「已有資料」。

export const UNLOCK_SCOPES = ['id_card', 'bankbook', 'bank_account'];

export const UNLOCK_SCOPE_LABELS = {
    id_card: '身分證正反面',
    bankbook: '存摺封面',
    bank_account: '匯款銀行資訊',
};

export const LOCKABLE_DOCUMENT_KEYS = ['id_front', 'id_back', 'bankbook'];

export const DOCUMENT_CHANGE_ITEM_LABELS = {
    id_front: '身分證正面',
    id_back: '身分證反面',
    bankbook: '存摺封面',
    bank_account: '匯款銀行資訊',
};

export const BANK_ACCOUNT_FIELD_LABELS = {
    bank_account_name: '戶名',
    bank_name: '銀行',
    bank_branch: '分行',
    bank_code: '銀行代碼',
    bank_account_number: '帳號',
};

export const LOCK_NOTICE = '如需修改，請於講師群組提出。';
export const UNLOCKED_NOTICE = '管理員已開放修改一次，存檔後會自動鎖回。';

const hasText = (value) => typeof value === 'string' && value.trim() !== '';

export const unlockScopeForDocument = (key) => {
    if (key === 'id_front' || key === 'id_back') return 'id_card';
    if (key === 'bankbook') return 'bankbook';
    return null;
};

export const hasSubmittedDocument = (instructor, key) => (
    hasText(instructor?.[`${key}_path`]) || hasText(instructor?.[`${key}_external_url`])
);

export const hasSubmittedBankAccount = (instructor) => hasText(instructor?.bank_account_number);

const LOCK_SOURCE_FIELDS = [
    'id_front_path', 'id_front_external_url',
    'id_back_path', 'id_back_external_url',
    'bankbook_path', 'bankbook_external_url',
    'bank_account_number',
];

// 只留判斷鎖定需要的 DB 欄位，作為「已存版本」的快照。
export const pickLockSource = (row) => (
    row ? Object.fromEntries(LOCK_SOURCE_FIELDS.map((field) => [field, row[field] ?? null])) : null
);

// savedInstructor 必須是「DB 正本」，不可用尚未存檔的表單值，否則講師剛選的新檔會被誤判成已鎖定。
export const getDocumentLockState = ({ savedInstructor, key, isAdmin, openScopes }) => {
    const scope = unlockScopeForDocument(key);
    if (!scope || isAdmin || !hasSubmittedDocument(savedInstructor, key)) {
        return { locked: false, unlocked: false, scope };
    }
    const unlocked = Boolean(openScopes?.has?.(scope));
    return { locked: !unlocked, unlocked, scope };
};

export const getBankAccountLockState = ({ savedInstructor, isAdmin, openScopes }) => {
    if (isAdmin || !hasSubmittedBankAccount(savedInstructor)) {
        return { locked: false, unlocked: false, scope: 'bank_account' };
    }
    const unlocked = Boolean(openScopes?.has?.('bank_account'));
    return { locked: !unlocked, unlocked, scope: 'bank_account' };
};

// 新功能的資料表若尚未套到該環境（42P01／PGRST205），視為沒有任何開放權限，畫面照舊鎖定，不報錯。
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

export const fetchOpenEditUnlocks = async (client, instructorId) => {
    if (!client || !instructorId) return [];
    // 開放 72 小時後過期（DB 也會擋），過期的不算開放。
    const { data, error } = await client
        .from('instructor_edit_unlocks')
        .select('id, scope, granted_at, granted_by, expires_at')
        .eq('instructor_id', instructorId)
        .is('consumed_at', null)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString());
    if (error) {
        if (!MISSING_TABLE_CODES.has(error.code)) console.warn('Failed to load edit unlocks:', error.message);
        return [];
    }
    return data || [];
};

export const toOpenScopeSet = (unlocks = []) => new Set(
    unlocks.map((unlock) => unlock.scope).filter((scope) => UNLOCK_SCOPES.includes(scope)),
);

// 只遮帳號中段，管理員核對時仍看得到頭尾。
export const maskAccountNumber = (value) => {
    if (!hasText(value)) return '';
    const digits = value.trim();
    if (digits.length <= 6) return digits;
    return `${digits.slice(0, 3)}${'•'.repeat(digits.length - 6)}${digits.slice(-3)}`;
};

// 修改紀錄的匯款差異：只列有變的欄位。
export const describeBankAccountChange = (oldValue = {}, newValue = {}) => (
    Object.keys(BANK_ACCOUNT_FIELD_LABELS)
        .filter((field) => (oldValue?.[field] ?? null) !== (newValue?.[field] ?? null))
        .map((field) => {
            const format = field === 'bank_account_number' ? maskAccountNumber : (value) => value || '';
            return {
                field,
                label: BANK_ACCOUNT_FIELD_LABELS[field],
                from: format(oldValue?.[field] ?? '') || '（空白）',
                to: format(newValue?.[field] ?? '') || '（空白）',
            };
        })
);

export const isLockedDocumentError = (error) => (
    error?.code === '42501' && typeof error?.message === 'string' && error.message.includes('已鎖定')
);
