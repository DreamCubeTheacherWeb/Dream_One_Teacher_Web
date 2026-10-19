import { useCallback, useEffect, useRef, useState } from 'react';

// 兩個分頁共用的狀態：忙碌鎖（一次只做一件事）、提示訊息、「已儲存順序」。
// 成功訊息 4 秒後自己消失；錯誤訊息留到下一次操作。
export function usePanelState() {
    const mounted = useRef(true);
    const busyRef = useRef(false);
    const noticeTimer = useRef(null);
    const savedTimer = useRef(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNoticeState] = useState(null); // { type: 'error' | 'success', text }
    const [savedText, setSavedText] = useState('');

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            clearTimeout(noticeTimer.current);
            clearTimeout(savedTimer.current);
        };
    }, []);

    const setNotice = useCallback((next) => {
        clearTimeout(noticeTimer.current);
        if (!mounted.current) return;
        setNoticeState(next);
        if (next?.type === 'success') {
            noticeTimer.current = setTimeout(() => {
                if (mounted.current) setNoticeState(null);
            }, 4000);
        }
    }, []);

    const showError = useCallback((text) => setNotice({ type: 'error', text }), [setNotice]);
    const showSuccess = useCallback((text) => setNotice({ type: 'success', text }), [setNotice]);

    const flashSaved = useCallback((text = '已儲存順序') => {
        clearTimeout(savedTimer.current);
        if (!mounted.current) return;
        setSavedText(text);
        savedTimer.current = setTimeout(() => {
            if (mounted.current) setSavedText('');
        }, 3000);
    }, []);

    // 一次只跑一個動作；回傳 task 的結果（忙碌中被略過回傳 undefined）
    const run = useCallback(async (task, toMessage) => {
        if (busyRef.current) return undefined;
        busyRef.current = true;
        setBusy(true);
        setNotice(null);
        try {
            return await task();
        } catch (error) {
            showError(toMessage ? toMessage(error) : (error?.message || '操作失敗，請稍後再試。'));
            return undefined;
        } finally {
            busyRef.current = false;
            if (mounted.current) setBusy(false);
        }
    }, [setNotice, showError]);

    return { busy, notice, setNotice, showError, showSuccess, savedText, flashSaved, run };
}
