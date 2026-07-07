// ═══════════════════════════════════════════════════════════════
// 成就徽章定義
// 集中管理徽章門檻，日後調整只需改這一個檔案。
// 每個徽章：{ code, name, description, icon(lucide 元件), metric, threshold }
// metric 對應 get_teacher_stats() 回傳欄位。
// ═══════════════════════════════════════════════════════════════
import {
    Rocket,
    BookOpen,
    GraduationCap,
    ClipboardCheck,
    Heart,
    MessageCircle,
    Award,
    Crown,
} from 'lucide-react';

export const BADGE_DEFS = [
    {
        code: 'first_assignment',
        name: '初次啟程',
        description: '繳交第一份作業',
        icon: Rocket,
        metric: 'assignments_submitted',
        threshold: 1,
    },
    {
        code: 'diligent',
        name: '勤學不倦',
        description: '完成 5 個章節',
        icon: BookOpen,
        metric: 'completed_lessons',
        threshold: 5,
    },
    {
        code: 'scholar',
        name: '學而不厭',
        description: '完成 15 個章節',
        icon: GraduationCap,
        metric: 'completed_lessons',
        threshold: 15,
    },
    {
        code: 'assignment_master',
        name: '作業達人',
        description: '繳交 10 份作業',
        icon: ClipboardCheck,
        metric: 'assignments_submitted',
        threshold: 10,
    },
    {
        code: 'popular',
        name: '人氣王',
        description: '累積獲得 10 個讚',
        icon: Heart,
        metric: 'likes_received',
        threshold: 10,
    },
    {
        code: 'social',
        name: '熱心交流',
        description: '留言互動 5 次',
        icon: MessageCircle,
        metric: 'comments_count',
        threshold: 5,
    },
    {
        code: 'graduate',
        name: '培訓結業',
        description: '完成 1 門完整課程',
        icon: Award,
        metric: 'completed_courses',
        threshold: 1,
    },
    {
        code: 'veteran',
        name: '資深講師',
        description: '完成 3 門完整課程',
        icon: Crown,
        metric: 'completed_courses',
        threshold: 3,
    },
];

/**
 * 依據講師統計資料計算每個徽章是否已解鎖。
 * @param {Object|null} stats - get_teacher_stats() 回傳的單列資料
 * @returns {Array} 每個徽章 { ...def, earned:boolean, current:number }
 */
export function computeBadges(stats) {
    const s = stats || {};
    return BADGE_DEFS.map((def) => {
        const current = Number(s[def.metric] || 0);
        return {
            ...def,
            current,
            earned: current >= def.threshold,
        };
    });
}
