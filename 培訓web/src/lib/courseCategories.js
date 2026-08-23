export const TRAINING_VISIBILITY_OPTIONS = [
    { value: 'all', label: '全部講師', shortLabel: '全部' },
    { value: 'intern', label: '實習培訓專用', shortLabel: '實習培訓' },
    { value: 'formal', label: '正式培訓專用', shortLabel: '正式培訓' },
];

export const trainingVisibilityLabel = (value, short = false) => {
    const option = TRAINING_VISIBILITY_OPTIONS.find(item => item.value === value)
        || TRAINING_VISIBILITY_OPTIONS[0];
    return short ? option.shortLabel : option.label;
};

export const trainingVisibilityClass = (value) => {
    if (value === 'intern') return 'bg-bauhaus-blue text-white';
    if (value === 'formal') return 'bg-bauhaus-black text-white';
    return 'bg-bauhaus-muted text-bauhaus-black';
};
