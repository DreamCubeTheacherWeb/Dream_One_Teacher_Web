// 講師本人可編輯的個人資料中，不包含管理員專屬欄位。
// 資料庫 trigger 仍是最終防線；這裡避免講師端草稿或請求夾帶管理員專屬欄位。
const ADMIN_MANAGED_FIELDS = [
    'id', 'user_id', 'created_at', 'updated_at', 'form_submitted_at',
    'employment_status', 'instructor_role', 'speed_qualification',
    'note_internal', 'teaching_regions_raw', 'bank_info_raw',
    'id_front_external_url', 'id_back_external_url',
    'photo_external_url', 'bankbook_external_url',
    'wca_name', 'wca_synced_at', 'hide_from_leaderboard',
];

const FILE_FIELD_SUFFIXES = ['_path', '_mime', '_size', '_uploaded_at'];
export const INSTRUCTOR_DOCUMENT_KEYS = ['photo', 'id_front', 'id_back', 'bankbook'];

export const pickInstructorDocumentFields = (values = {}) => Object.fromEntries(
    INSTRUCTOR_DOCUMENT_KEYS.flatMap((key) => FILE_FIELD_SUFFIXES.map((suffix) => {
        const field = `${key}${suffix}`;
        return [field, values[field] ?? null];
    })),
);

// 講師本人儲存是 upsert：資料庫會先用 INSERT 檢查整列，非本人資料夾的路徑一律擋下。
// 管理員代傳或表單匯入的檔案（instructors/<講師主檔 id>/、form-import/）沒換就不重送，
// 讓 upsert 只更新這次真的換掉或移除的文件。
export const omitUnchangedDocumentFields = (payload = {}, savedDocumentFields = {}) => {
    const next = { ...payload };
    INSTRUCTOR_DOCUMENT_KEYS.forEach((key) => {
        const pathField = `${key}_path`;
        if ((next[pathField] ?? null) !== (savedDocumentFields[pathField] ?? null)) return;
        FILE_FIELD_SUFFIXES.forEach((suffix) => delete next[`${key}${suffix}`]);
    });
    return next;
};

// 已有主檔時走 UPDATE：user_id 已是 WHERE 條件不重送；主要 Email 與載入時相同也不送。
// 資料庫 trigger 是「UPDATE OF user_id, email_primary」（Email 守門，只放行 pending／teacher）與
// 「UPDATE OF user_id, employment_status」（凍結／停止合作就把 teacher 降回 pending），
// 欄位只要出現在 SET 清單就會觸發，即使值沒變：mentor 會存不了自己的個人頁，
// 已凍結但被管理員手動恢復 teacher 的講師存一次就被降回 pending。
// 第一次建主檔（INSERT）仍要送 user_id 與 email_primary，不走這裡。
export const toInstructorUpdatePayload = (payload = {}, savedEmailPrimary = null) => {
    const next = { ...payload };
    delete next.user_id;
    if ((next.email_primary ?? null) === (savedEmailPrimary ?? null)) delete next.email_primary;
    return next;
};

const INSTRUCTOR_EMAIL_GUARD_MESSAGES = [
    'changed instructor email must match the signed-in Google account',
    'new instructor email must match the signed-in Google account',
];

// 資料庫 Email 守門 trigger 的英文錯誤轉成講師看得懂的中文；其他錯誤維持原訊息。
export const describeInstructorSaveError = (error, { googleEmail } = {}) => {
    const message = error?.message || String(error ?? '');
    // 出生日期已登錄為未滿 18 歲時，只有管理員能更正（避免未成年講師自己改成成年再線上簽約）。
    if (message.includes('BIRTH_DATE_ADMIN_ONLY')) {
        return '出生日期已登錄為未滿 18 歲，需由行政人員更正；如果登錄有誤，請聯繫管理員。';
    }
    if (!INSTRUCTOR_EMAIL_GUARD_MESSAGES.some((guardMessage) => message.includes(guardMessage))) return message;
    const account = googleEmail ? `（${googleEmail}）` : '';
    return `主要 Email 必須是你登入用的 Google 信箱${account}；若要改用其他信箱，請聯繫管理員。`;
};

export const stripAdminManagedInstructorFields = (values = {}) => {
    const editableValues = { ...values };
    ADMIN_MANAGED_FIELDS.forEach((field) => delete editableValues[field]);
    return editableValues;
};

// 草稿放在受 RLS 保護的 server-side table；檔案在按下儲存前只留在記憶體，
// 避免把證件/存摺路徑與 metadata 留在任何瀏覽器持久儲存。
export const pickInstructorProfileDraftFields = (values = {}) => {
    const draft = stripAdminManagedInstructorFields(values);
    Object.keys(draft).forEach((field) => {
        if (FILE_FIELD_SUFFIXES.some((suffix) => field.endsWith(suffix))) delete draft[field];
    });
    return draft;
};
