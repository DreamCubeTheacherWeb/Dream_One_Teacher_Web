// 共用標籤常數：course_type / instructor role 的中文對照表
// 原本散落在 MySalary.jsx、MySalaryNew.jsx、admin/SalaryRegister.jsx 三處逐字重複，抽出集中維護。

// course_type 中文 label
export const COURSE_LABELS = {
    regular_basic: '實體常態-初階', regular_advanced: '實體常態-進階',
    online: '線上課程', overseas_online: '國外一對一線上',
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
