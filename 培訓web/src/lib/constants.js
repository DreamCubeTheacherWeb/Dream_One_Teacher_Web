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

// 講師回報頁的分層選單（業主 2026-10-19：照原 Google 課後回報表單，最上面先選 B2B／B2C 並備註哪種課選哪個）。
// 第一層「回報類別」、第二層「課程類型」用表單原本的用語；第三層「報酬項目」才是報酬規則使用的 course_type（資料庫欄位不變），
// 同一種課只有一個報酬項目時第三層自動帶入、不顯示。
export const REPORT_CHANNELS = [
    { key: 'b2c', label: 'B2C 直營課程', hint: '公司自己開的課：到府家教課／揪團課、線上課程、體驗課、速解研究所、寒暑假營隊、常態課、站櫃。' },
    { key: 'b2b', label: 'B2B 合作單位', hint: '學校、社團、機構等合作單位委託的課，要填教學課程期間與上課單位。' },
];

export const COURSE_CATEGORIES = [
    { key: 'regular', channel: 'b2c', label: '常態課', types: ['regular_basic', 'regular_advanced', 'kids_lead', 'kids_assistant'] },
    { key: 'onsite', channel: 'b2c', label: '到府家教課／到府揪團課', types: ['onsite_2hr', 'onsite_1_5hr'] },
    { key: 'online', channel: 'b2c', label: '線上課程', types: ['online', 'overseas_online'] },
    { key: 'trial', channel: 'b2c', label: '體驗課', types: ['trial'] },
    { key: 'speed_onsite', channel: 'b2c', label: '速解研究所｜實體課程', types: ['speed_onsite', 'speed_training_lead', 'speed_training_assistant'] },
    { key: 'speed_online', channel: 'b2c', label: '速解研究所｜線上課程', types: ['speed_online'] },
    { key: 'camp', channel: 'b2c', label: '寒暑假營隊', types: ['camp', 'camp_director_5d', 'camp_director_4d', 'camp_director_2d', 'speed_camp'] },
    { key: 'counter', channel: 'b2c', label: '站櫃／擺攤', types: ['counter', 'event_booth'] },
    { key: 'other', channel: 'b2c', label: '其他', types: ['cert_sub_judge', 'special_lecture_recorded', 'special_lecture_unrecorded', 'other'] },
    { key: 'collab', channel: 'b2b', label: '合作單位課程', types: ['collab_lead', 'collab_assistant', 'collab_project'] },
];

export const courseCategoryFor = (courseType = '') =>
    COURSE_CATEGORIES.find(category => category.types.includes(courseType))?.key || 'other';

export const courseTypesInCategory = (categoryKey) =>
    COURSE_CATEGORIES.find(category => category.key === categoryKey)?.types || [];

export const reportChannelFor = (courseType = '') =>
    COURSE_CATEGORIES.find(category => category.key === courseCategoryFor(courseType))?.channel || 'b2c';

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
