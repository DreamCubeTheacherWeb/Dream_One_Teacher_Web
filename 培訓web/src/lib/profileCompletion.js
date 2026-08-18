export const REQUIRED_PROFILE_FIELDS = [
  { key: 'full_name', label: '姓名' },
  { key: 'nickname', label: '講師暱稱' },
  { key: 'gender', label: '性別' },
  { key: 'birth_date', label: '出生年月日' },
  { key: 'id_number', label: '身分證字號' },
  { key: 'phone_mobile', label: '手機號碼' },
  { key: 'line_id', label: 'Line ID' },
  { key: 'address', label: '通訊地址' },
  { key: 'household_address', label: '戶籍地址' },
  { key: 'email_primary', label: '主要 Email' },
  { key: 'teaching_freq_semester', label: '接課頻率（學期間）' },
  { key: 'teaching_freq_vacation', label: '接課頻率（寒暑假）' },
  { key: 'bio_notes', label: '經歷 / 理念' },
  { key: 'bank_account_name', label: '匯款戶名' },
  { key: 'bank_name', label: '銀行別' },
  { key: 'bank_branch', label: '分行別' },
  { key: 'bank_account_number', label: '銀行帳號' },
  { key: 'bank_code', label: '銀行代碼' },
];

export const REQUIRED_PROFILE_PATHS = [
  'id_front_path',
  'id_back_path',
  'bankbook_path',
];

export const PROFILE_SAVED_EVENT = 'instructor-profile-saved';

export const isInstructorProfileComplete = (instructor) => {
  if (!instructor?.teaching_regions?.length) return false;

  const hasAllFields = REQUIRED_PROFILE_FIELDS.every(({ key }) => {
    const value = instructor[key];
    return value !== null
      && value !== undefined
      && (typeof value !== 'string' || value.trim());
  });

  return hasAllFields && REQUIRED_PROFILE_PATHS.every((path) => instructor[path]);
};
