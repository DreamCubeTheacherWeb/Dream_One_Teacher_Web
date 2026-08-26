import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import {
  getInstructorProfileCompletion,
  PROFILE_SAVED_EVENT,
} from '../lib/profileCompletion';

// 允許未填完資料時仍可進入的路徑
// pending 需先完成「新進／非新進」分流；不能在選擇前被完整度檢查導去空白主檔。
const ALLOWED_PATHS = ['/profile', '/pending'];
const isAllowedPath = (path) => {
  if (ALLOWED_PATHS.includes(path)) return true;
  if (path.startsWith('/announcements')) return true;
  return false;
};

/**
 * 監聽當前使用者：若資料未填完，強制把任何頁面導向 /profile。
 * 在 ProfilePage 上額外顯示「距離首次登入第 N 天」倒數提示。
 */
const ProfileCompleteGate = ({ onCompletionChange }) => {
  const { user, profile, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [completion, setCompletion] = useState({
    userId: null,
    path: null,
    complete: null,
    completedItems: 0,
    totalItems: 0,
    missingItems: [],
  });
  const [createdAt, setCreatedAt] = useState(null);
  const [mountedAt] = useState(Date.now);

  const isExemptRole = profile?.role === 'admin' || profile?.role === 'mentor';
  const completionIsCurrent = completion.userId === user?.id
    && completion.path === location.pathname;
  const complete = isExemptRole ? true : completionIsCurrent ? completion.complete : null;

  // 讓導覽列共用同一份完成度狀態，避免再次查詢 instructors。
  useEffect(() => {
    onCompletionChange?.(complete);
  }, [complete, onCompletionChange]);

  // 載入 instructors 完整度 + 註冊時間
  useEffect(() => {
    if (loading || !user || !profile) return;
    // 管理員 / 輔導員不檢查
    if (isExemptRole) return;

    let cancelled = false;
    const checkedPath = location.pathname;
    (async () => {
      const { data: inst } = await supabase
        .from('instructors')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      const nextCompletion = getInstructorProfileCompletion(inst);
      setCompletion({
        userId: user.id,
        path: checkedPath,
        ...nextCompletion,
      });
      // 用 auth.user.created_at 作為三天倒數起點
      setCreatedAt(user.created_at || profile.created_at || null);
    })();
    return () => { cancelled = true; };
  }, [isExemptRole, loading, user, profile, location.pathname]);

  // ProfilePage 儲存成功時立即更新目前頁面的完成度，避免成功訊息後仍顯示舊警告。
  useEffect(() => {
    const handleProfileSaved = (event) => {
      if (!user?.id) return;
      const nextCompletion = getInstructorProfileCompletion(event.detail);
      setCompletion({
        userId: user.id,
        path: location.pathname,
        ...nextCompletion,
      });
    };
    window.addEventListener(PROFILE_SAVED_EVENT, handleProfileSaved);
    return () => window.removeEventListener(PROFILE_SAVED_EVENT, handleProfileSaved);
  }, [location.pathname, user?.id]);

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
  const createdAtMs = createdAt ? new Date(createdAt).getTime() : NaN;
  const hasValidCreatedAt = Number.isFinite(createdAtMs);
  const elapsedMs = hasValidCreatedAt ? mountedAt - createdAtMs : 0;
  const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  const remaining = hasValidCreatedAt ? 3 - elapsedDays : null;
  const overdue = remaining < 0;
  const missingCount = completion.missingItems.length;

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
          {overdue ? '!' : missingCount}
        </div>
        <div className="flex-1 min-w-0">
          <div
            className={`font-black text-base ${
              overdue ? 'text-bauhaus-red' : 'text-bauhaus-black'
            }`}
          >
            還缺 {missingCount} 項講師資料
          </div>
          <div
            className={`text-sm mt-1 font-medium ${
              overdue ? 'text-bauhaus-red/80' : 'text-bauhaus-black/70'
            }`}
          >
            {hasValidCreatedAt && (
              <span className="mr-1">
                {overdue
                  ? `已逾期 ${Math.abs(remaining)} 天。`
                  : remaining === 0
                  ? '今天是完成期限。'
                  : `首次登入後還有 ${remaining} 天可完成。`}
              </span>
            )}
            已帶入的資料不必重填，只需補齊下列項目。
            <strong className="ml-1">完成前僅能查看個人資料與公告。</strong>
          </div>
          <div
            data-testid="profile-missing-items"
            aria-label={`尚缺 ${missingCount} 項講師資料`}
            className="mt-3 flex flex-wrap gap-2"
          >
            {completion.missingItems.map((item) => (
              <span
                key={item}
                className="inline-flex min-h-8 items-center rounded-lg border-2 border-bauhaus-black bg-white px-2.5 py-1 text-xs font-black text-bauhaus-black"
              >
                {item}
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs font-bold text-bauhaus-black/60">
            已完成 {completion.completedItems}／{completion.totalItems} 項
          </p>
        </div>
      </div>
    </div>
  );
};

export default ProfileCompleteGate;
