// 新手導覽（「關於我」頁第一次進來時跳出的 5 格彈窗）的「看過了」紀錄。
// 業主 2026-10-21 選「記在這台裝置」：存 localStorage、不動資料庫；換手機或換電腦會再跳一次。
// 導覽內容大改時把 TOUR_VERSION 加一，所有人會再看到一次新版。
export const TOUR_VERSION = 1;

// 「關於我」頁的「重看導覽」按鈕送出這個事件，Layout 收到就打開導覽
export const OPEN_TOUR_EVENT = 'dreamone:open-onboarding-tour';

export const tourStorageKey = (userId) => `dreamone_onboarding_v${TOUR_VERSION}_${userId}`;

// 讀不到 localStorage（無痕模式、瀏覽器擋住）時當成看過，避免每次進頁都被彈窗擋住
export const hasSeenTour = (userId, storage = globalThis.localStorage) => {
    if (!userId) return true;
    try {
        return Boolean(storage?.getItem(tourStorageKey(userId)));
    } catch {
        return true;
    }
};

export const markTourSeen = (userId, storage = globalThis.localStorage, now = new Date()) => {
    if (!userId) return;
    try {
        storage?.setItem(tourStorageKey(userId), now.toISOString());
    } catch {
        // 存不了就算了：這次關掉後同一個分頁內不會再自動跳（由呼叫端的狀態控制）
    }
};
