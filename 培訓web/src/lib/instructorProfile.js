// 講師本人可編輯的個人資料中，不包含管理員專屬欄位。
// 資料庫 trigger 仍是最終防線；這裡避免講師端草稿或請求夾帶講師等級。
export const stripAdminManagedInstructorFields = (values = {}) => {
    const editableValues = { ...values };
    delete editableValues.instructor_role;
    return editableValues;
};
