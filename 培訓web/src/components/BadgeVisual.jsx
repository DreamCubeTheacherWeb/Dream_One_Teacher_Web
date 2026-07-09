import { supabase } from '../lib/supabaseClient';
import BadgeIcon from './BadgeIcon';

// 徽章顯示的共用入口：有上傳圖示（image_path）優先顯示上傳圖，
// 否則退回內建幾何 Bauhaus 圖示（BadgeIcon，內含 emoji/未知 key 的 fallback）。
// 用法：<BadgeVisual badge={badgeObj} size={64} className="..." />
// badgeObj 需含 { key, image_path }（badge_definitions 的一列，或 computeBadges() 的輸出）。
export default function BadgeVisual({ badge, size = 72, className = '' }) {
    if (badge?.image_path) {
        const url = supabase.storage.from('badge_icons').getPublicUrl(badge.image_path).data?.publicUrl;
        if (url) {
            return (
                <img
                    src={url}
                    alt={badge.name || badge.key || 'badge'}
                    width={size}
                    height={size}
                    className={`object-contain aspect-square ${className}`}
                />
            );
        }
    }
    return <BadgeIcon badgeKey={badge?.key} size={size} className={className} />;
}
