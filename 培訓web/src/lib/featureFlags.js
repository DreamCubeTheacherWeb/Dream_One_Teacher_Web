// 講師簽約功能：2026-10-18 正式重開；暫停時改 false。
export const INSTRUCTOR_CONTRACTS_ENABLED = true;

// 前台暫停（開關為 false）時仍保留管理員的合約查看與測試能力。
export const canAccessInstructorContracts = (role) =>
    INSTRUCTOR_CONTRACTS_ENABLED || role === 'admin';
