export const TEACHING_MATERIALS_LINK = Object.freeze({
    key: 'teaching_materials',
    label: '教材資源',
    description: '講師導航列的教材系統入口',
    url: 'https://dreamone-teaching-materials.vercel.app/',
});

export const isSafeHttpUrl = (value) => {
    if (typeof value !== 'string' || !value.trim()) return false;

    try {
        const parsed = new URL(value.trim());
        return (
            (parsed.protocol === 'https:' || parsed.protocol === 'http:')
            && Boolean(parsed.hostname)
            && !parsed.username
            && !parsed.password
        );
    } catch {
        return false;
    }
};

export const resolveHttpUrl = (value, fallback) => (
    isSafeHttpUrl(value) ? value.trim() : fallback
);
