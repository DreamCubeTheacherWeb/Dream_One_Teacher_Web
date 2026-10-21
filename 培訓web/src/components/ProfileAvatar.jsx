import { useState } from 'react';

// 頂部選單與「關於我」共用的大頭貼：沒上傳或圖片載入失敗時顯示企鵝
const PenguinAvatar = () => (
    <svg viewBox="0 0 64 64" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="32" fill="#e2e8f0" />
        <ellipse cx="32" cy="38" rx="16" ry="18" fill="#334155" />
        <ellipse cx="32" cy="40" rx="10" ry="14" fill="#f1f5f9" />
        <circle cx="26" cy="30" r="3" fill="white" />
        <circle cx="38" cy="30" r="3" fill="white" />
        <circle cx="27" cy="30" r="1.5" fill="#1e293b" />
        <circle cx="39" cy="30" r="1.5" fill="#1e293b" />
        <ellipse cx="32" cy="35" rx="3" ry="2" fill="#f59e0b" />
    </svg>
);

const ProfileAvatar = ({ src, alt }) => {
    const [failedSrc, setFailedSrc] = useState(null);
    if (!src || failedSrc === src) return <PenguinAvatar />;
    return (
        <img
            src={src}
            alt={alt}
            referrerPolicy="no-referrer"
            onError={() => setFailedSrc(src)}
            className="w-full h-full object-cover"
        />
    );
};

export default ProfileAvatar;
