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
