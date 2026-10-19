// 共用標籤常數：course_type / instructor role 的中文對照表
// 原本散落在 MySalary.jsx、MySalaryNew.jsx、admin/SalaryRegister.jsx 三處逐字重複，抽出集中維護。

// course_type 中文 label
export const COURSE_LABELS = {
    regular_basic: '實體常態-初階', regular_advanced: '實體常態-進階',
    online: '線上課程', overseas_online: '國外一對一線上', trial: '體驗課',
    onsite_2hr: '到府 2hr/節', onsite_1_5hr: '到府 1.5hr/節',
    collab_lead: '合作 主講', collab_assistant: '合作 助教', collab_project: '合作 專案',
    camp: '冬夏令營', speed_onsite: '速解到府', speed_online: '速解線上',
    speed_training_lead: '速解培訓 主講', speed_training_assistant: '速解培訓 助教',
    speed_camp: '速解營隊', kids_lead: '幼兒啟蒙 主講', kids_assistant: '幼兒啟蒙 助教',
    camp_director_5d: '營隊負責人 5日', camp_director_4d: '營隊負責人 4日', camp_director_2d: '營隊負責人 2日',
    cert_sub_judge: '認證 助裁', counter: '櫃台人員', event_booth: '擺攤',
    special_lecture_recorded: '特殊講座 有紀錄', special_lecture_unrecorded: '特殊講座 無紀錄',
    other: '其他',
};

// 講師回報頁的分層選單（業主 2026-10-19：選項與欄位要和兩份 Google 課後回報表單一樣，最上面先選 B2B／B2C 並備註哪種課選哪個）。
// 第一層「回報類別」對應表單；第二層「課程種類」用表單原本的選項文字；第三層才是報酬規則使用的 course_type（資料庫欄位不變），
// 只有同一種課對應多個報酬規則時才顯示，顯示文字照表單的問法（合作課＝課程講師身分別、營隊＝是否為營隊負責人）。
// 兩份表單都沒有的課（常態課、站櫃等）放在「其他課程」，欄位維持原本的完整版。
export const REPORT_CHANNELS = [
    { key: 'b2c', label: 'B2C 直營課程部', hint: '到府家教課／揪團課、線上課程、體驗課、速解研究所、寒暑假營隊（同「課後回報表單｜二處 B2C 版本」）。' },
    { key: 'b2b', label: 'B2B 合作單位課程', hint: '補習班、學校社團、講座等合作單位的課（同「B2B 合作單位課程 課後回報單」）。' },
    { key: 'other', label: '其他課程', hint: '不在上面兩份表單裡的課：常態課、幼兒啟蒙、速解培訓、站櫃／擺攤、認證、特殊講座。' },
];

export const COURSE_CATEGORIES = [
    { key: 'onsite', channel: 'b2c', label: '到府家教課 or 到府揪團課', types: ['onsite_2hr', 'onsite_1_5hr'] },
    { key: 'online', channel: 'b2c', label: '線上課程', types: ['online', 'overseas_online'] },
    { key: 'trial', channel: 'b2c', label: '體驗課', types: ['trial'] },
    { key: 'speed_onsite', channel: 'b2c', label: '速解研究所｜實體課程', types: ['speed_onsite'] },
    { key: 'speed_online', channel: 'b2c', label: '速解研究所｜線上課程', types: ['speed_online'] },
    { key: 'camp', channel: 'b2c', label: '寒暑假營隊 二日營、五日營', itemLabel: '是否為營隊負責人', types: ['camp', 'speed_camp', 'camp_director_5d', 'camp_director_4d', 'camp_director_2d'] },
    { key: 'collab', channel: 'b2b', label: '合作單位課程', itemLabel: '課程講師身分別', types: ['collab_lead', 'collab_assistant', 'collab_project'] },
    { key: 'regular', channel: 'other', label: '常態課', types: ['regular_basic', 'regular_advanced'] },
    { key: 'kids', channel: 'other', label: '幼兒啟蒙', types: ['kids_lead', 'kids_assistant'] },
    { key: 'speed_training', channel: 'other', label: '速解培訓', types: ['speed_training_lead', 'speed_training_assistant'] },
    { key: 'counter', channel: 'other', label: '站櫃／擺攤', types: ['counter', 'event_booth'] },
    { key: 'misc', channel: 'other', label: '其他', types: ['cert_sub_judge', 'special_lecture_recorded', 'special_lecture_unrecorded', 'other'] },
];

// 第三層選項照表單問法顯示；沒列的用 COURSE_LABELS
export const REPORT_ITEM_LABELS = {
    collab_lead: '合作課程 主講',
    collab_assistant: '合作課程 助教',
    camp: '否（一般講師）',
    speed_camp: '否（一般講師，速解營）',
    camp_director_5d: '是（5 日營負責人）',
    camp_director_4d: '是（4 日營負責人）',
    camp_director_2d: '是（2 日營負責人）',
};

// 表單上沒有的報酬項目，講師端不列（管理員後台仍可登記）
export const TEACHER_REPORT_HIDDEN_TYPES = new Set(['collab_project']);

export const courseCategoryFor = (courseType = '') =>
    COURSE_CATEGORIES.find(category => category.types.includes(courseType))?.key || 'misc';

export const courseCategoryConfig = (categoryKey) =>
    COURSE_CATEGORIES.find(category => category.key === categoryKey) || null;

export const courseTypesInCategory = (categoryKey) => courseCategoryConfig(categoryKey)?.types || [];

export const teacherCourseItems = (categoryKey) =>
    courseTypesInCategory(categoryKey).filter(type => !TEACHER_REPORT_HIDDEN_TYPES.has(type));

export const reportItemLabel = (courseType) => REPORT_ITEM_LABELS[courseType] || COURSE_LABELS[courseType] || courseType;

export const reportChannelFor = (courseType = '') =>
    courseCategoryConfig(courseCategoryFor(courseType))?.channel || 'other';

export const categoriesInChannel = (channelKey) =>
    COURSE_CATEGORIES.filter(category => category.channel === channelKey);

// instructor role 中文 label
export const ROLE_LABELS = { lead: '主講', assistant: '助教', head_judge: '主裁', sub_judge: '助裁', counter: '櫃台', project_lead: '負責人', other: '其他' };

export const INSTRUCTOR_LEVEL_LABELS = {
    S: 'S 級',
    'A+': 'A+ 級',
    A: 'A 級',
    B: 'B 級',
    '實習': '實習',
};

export const SPEED_QUALIFICATION_LABELS = {
    speed_teacher: '速解老師',
    speed_master: '速解大師',
};

export const isSpeedCourse = (courseType = '') => courseType.startsWith('speed_');

export const speedQualificationLabel = (value) =>
    SPEED_QUALIFICATION_LABELS[value] || '未取得';

// 合作課「教學課程期間」（class_sessions.term_period）
export const TERM_PERIOD_LABELS = {
    winter_break: '寒假',
    semester: '學期間',
    summer_break: '暑假',
};
