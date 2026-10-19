// 講師簽約功能：2026-10-18 正式重開；暫停時改 false。
export const INSTRUCTOR_CONTRACTS_ENABLED = true;

// 可進簽約流程、個人頁顯示簽約區塊的角色：已核准角色（teacher／mentor）。
// pending（Google 登入後尚未核准）在後端 submit_my_contract 會被拒，2026-10-19 起也讀不到
// contract_documents 與合約範本檔，前端一併不顯示入口，避免點進去又被導回待審頁。
const CONTRACT_ROLES = ['teacher', 'mentor'];

// 前台暫停（開關為 false）時仍保留管理員的合約查看與測試能力。
export const canAccessInstructorContracts = (role) =>
    role === 'admin' || (INSTRUCTOR_CONTRACTS_ENABLED && CONTRACT_ROLES.includes(role));
