// 講師簽約功能暫停中。調整完成後只需將此開關改回 true。
export const INSTRUCTOR_CONTRACTS_ENABLED = false;

// 前台暫停時仍保留管理員的合約查看與測試能力。
export const canAccessInstructorContracts = (role) =>
    INSTRUCTOR_CONTRACTS_ENABLED || role === 'admin';
