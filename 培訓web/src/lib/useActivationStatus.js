import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabaseClient';
import { interpretActivationStatus } from './accountActivation';

/**
 * 讀取目前登入者的帳號啟用狀態（get_my_activation_status）。
 * 讀取失敗（RPC 尚未上線、網路）時 state 為 unknown，畫面維持舊行為、不顯示啟用提示。
 *
 * @param {string|undefined} userId 登入者 id；沒有就不查
 * @returns {{ loading: boolean, activation: ReturnType<typeof interpretActivationStatus>, refresh: () => Promise<void> }}
 */
export const useActivationStatus = (userId) => {
  const [loading, setLoading] = useState(Boolean(userId));
  const [activation, setActivation] = useState(() => interpretActivationStatus(null));
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      setActivation(interpretActivationStatus(null));
      return;
    }
    try {
      const { data, error } = await supabase.rpc('get_my_activation_status');
      if (!aliveRef.current) return;
      setActivation(interpretActivationStatus(error ? null : data));
      if (error) console.warn('get_my_activation_status 失敗：', error.message);
    } catch (error) {
      if (!aliveRef.current) return;
      console.warn('get_my_activation_status 失敗：', error?.message);
      setActivation(interpretActivationStatus(null));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    aliveRef.current = true;
    // 只在登入者變動時載入一次；Supabase token 續期會換 user 物件，但 id 不變，不重查。
    const timer = window.setTimeout(load, 0);
    return () => {
      aliveRef.current = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  return { loading, activation, refresh: load };
};
