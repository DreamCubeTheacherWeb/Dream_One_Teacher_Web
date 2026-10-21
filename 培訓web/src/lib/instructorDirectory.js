import { supabase } from './supabaseClient';

// 輔導員（mentor）讀不到 instructors 表（只有管理員與講師本人讀得到，表內有身分證、銀行等個資；
// migration 20261022010000）。要看別人的姓名／暱稱／等級，一律走 mentor_instructor_directory，
// 它只回 id、user_id、full_name、nickname、instructor_role、employment_status、teaching_regions、
// speed_qualification。其他角色維持原本的直接查表（管理員全權；講師依 RLS 只拿到自己那列）。
export function fetchInstructorDirectory({ role, columns, userIds } = {}) {
    if (role === 'mentor') {
        return supabase.rpc('mentor_instructor_directory', userIds ? { p_user_ids: userIds } : {});
    }
    let query = supabase.from('instructors').select(columns);
    if (userIds) query = query.in('user_id', userIds);
    return query;
}
