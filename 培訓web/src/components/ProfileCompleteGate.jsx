import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';

const REQUIRED_KEYS = [
  'full_name', 'nickname', 'gender', 'birth_date', 'id_number',
  'phone_mobile', 'line_id', 'address', 'email_primary',
  // ⚠️ instructor_role（等級）2026-07-09 起改為「系統/管理員指派、老師不可自填」
  //   （見 guard_instructor_role trigger）。老師既然填不了它，就不能拿它當完成度門檻，
  //   否則名冊等級為空的列被認領後會永遠卡在資料頁（老師改不了、trigger 又保留空值）。
  'teaching_freq_semester', 'teaching_freq_vacation',
  'bio_notes',
  'bank_account_name', 'bank_name', 'bank_branch',
  'bank_account_number', 'bank_code',
];
const REQUIRED_PATHS = ['photo_path', 'id_front_path', 'id_back_path', 'bankbook_path'];

const isComplete = (inst) => {
  if (!inst) return false;
  if (!inst.teaching_regions?.length) return false;
  for (const k of REQUIRED_KEYS) {
    const v = inst[k];
    if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return false;
  }
  for (const p of REQUIRED_PATHS) {
    if (!inst[p]) return false;
  }
  return true;
};

// 允許未填完資料時仍可進入的路徑
const ALLOWED_PATHS = ['/profile', '/dev-login'];
const isAllowedPath = (path) => {
  if (ALLOWED_PATHS.includes(path)) return true;
  if (path.startsWith('/announcements')) return true;
  return false;
};

/**
 * 監聽當前使用者：若資料未填完，強制把任何頁面導向 /profile。
 * 在 ProfilePage 上額外顯示「距離首次登入第 N 天」倒數提示。
 */
const ProfileCompleteGate = () => {
  const { user, profile, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [complete, setComplete] = useState(null); // null = unknown, true/false 確認後
  const [createdAt, setCreatedAt] = useState(null);

  // 載入 instructors 完整度 + 註冊時間
  useEffect(() => {
    if (loading || !user || !profile) { setComplete(null); return; }
    // 管理員 / 輔導員不檢查
    if (profile.role === 'admin' || profile.role === 'mentor') { setComplete(true); return; }

    let cancelled = false;
    (async () => {
      const { data: inst } = await supabase
        .from('instructors')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      setComplete(isComplete(inst));
      // 用 auth.user.created_at 作為三天倒數起點
      setCreatedAt(user.created_at || profile.created_at || null);
    })();
    return () => { cancelled = true; };
  }, [loading, user, profile, location.pathname]);

  // 強制導頁
  useEffect(() => {
    if (loading || complete === null) return;
    if (complete) return;
    if (isAllowedPath(location.pathname)) return;
    navigate('/profile', { replace: true });
  }, [complete, location.pathname, loading, navigate]);

  // 只在 /profile 顯示倒數橫幅
  if (loading || complete === null || complete) return null;
  if (location.pathname !== '/profile') return null;
  if (!createdAt) return null;

  const elapsedMs = Date.now() - new Date(createdAt).getTime();
  const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  const remaining = 3 - elapsedDays;
  const overdue = remaining < 0;

  return (
    <div className="max-w-4xl mx-auto px-4 pt-4">
      <div
        className={`p-4 sm:p-5 border-2 border-bauhaus-black rounded-2xl flex items-start gap-3 ${
          overdue ? 'bg-bauhaus-red/10' : 'bg-bauhaus-yellow/20'
        }`}
      >
        <div
          className={`w-10 h-10 border-2 border-bauhaus-black rounded-lg flex items-center justify-center shrink-0 font-black text-lg ${
            overdue ? 'bg-bauhaus-red text-white' : 'bg-bauhaus-yellow text-bauhaus-black'
          }`}
        >
          {overdue ? '!' : remaining}
        </div>
        <div className="flex-1 min-w-0">
          <div
            className={`font-black text-base ${
              overdue ? 'text-bauhaus-red' : 'text-bauhaus-black'
            }`}
          >
            {overdue
              ? `已逾期 ${Math.abs(remaining)} 天 — 請立即完成資料填寫`
              : remaining === 0
              ? '今天是最後一天 — 請務必完成資料填寫'
              : `您還有 ${remaining} 天需完成講師資料`}
          </div>
          <div
            className={`text-sm mt-1 font-medium ${
              overdue ? 'text-bauhaus-red/80' : 'text-bauhaus-black/70'
            }`}
          >
            首次登入起 3 天內須完成所有資料（含銀行資訊與身分證、存摺等檔案）。
            <strong className="ml-1">未完成前無法瀏覽其他頁面。</strong>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfileCompleteGate;
