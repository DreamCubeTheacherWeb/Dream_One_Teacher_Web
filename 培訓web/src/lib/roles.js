// 角色判斷工具：集中定義「誰算什麼角色」的純函式。
// 目前專案內約有 9 處散落的 profile.role 字串比對，之後可分階段改用這裡的函式收斂。
// 本模組僅提供判斷邏輯，不做任何權限強制或導向。
//
// role 可能值：'admin' | 'mentor' | 'teacher' | 'pending'

/**
 * 是否為系統管理員。
 * @param {{ role?: string } | null | undefined} profile 使用者的 profile 物件
 * @returns {boolean}
 */
export function isAdmin(profile) {
    return profile?.role === 'admin';
}

/**
 * 是否為已核准使用平台內容的帳號。
 * 待審核或未登入狀態不得讀取講師公告等內部內容。
 * @param {{ role?: string } | null | undefined} profile 使用者的 profile 物件
 * @returns {boolean}
 */
export function isApprovedUser(profile) {
    return profile?.role === 'teacher'
        || profile?.role === 'mentor'
        || profile?.role === 'admin';
}
