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

export const REQUIRED_PROFILE_DOCUMENTS = [
  { key: 'id_front', label: '身分證正面' },
  { key: 'id_back', label: '身分證反面' },
  { key: 'bankbook', label: '存摺封面' },
];

export const PROFILE_SAVED_EVENT = 'instructor-profile-saved';

const hasValue = (value) => value !== null
  && value !== undefined
  && (typeof value !== 'string' || Boolean(value.trim()));

export const toFetchableInstructorDocumentUrl = (value) => {
  if (!hasValue(value)) return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') return null;

    const pathMatch = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)/);
    const fileId = url.searchParams.get('id') || pathMatch?.[1];
    if (!fileId || !/^[A-Za-z0-9_-]+$/.test(fileId)) return null;

    const directUrl = new URL('https://drive.google.com/uc');
    directUrl.searchParams.set('export', 'download');
    directUrl.searchParams.set('id', fileId);
    return directUrl.toString();
  } catch {
    return null;
  }
};

export const getInstructorDocumentReference = (instructor, key) => {
  const path = instructor?.[`${key}_path`];
  if (hasValue(path)) return { kind: 'storage', value: path.trim() };

  const externalUrl = instructor?.[`${key}_external_url`];
  const fetchUrl = toFetchableInstructorDocumentUrl(externalUrl);
  if (fetchUrl) {
    return { kind: 'external', value: externalUrl.trim(), fetchUrl };
  }

  return null;
};

export const hasInstructorDocument = (instructor, key) => (
  getInstructorDocumentReference(instructor, key) !== null
);

export const getInstructorProfileCompletion = (instructor) => {
  const missingItems = [];

  REQUIRED_PROFILE_FIELDS.forEach(({ key, label }) => {
    if (!hasValue(instructor?.[key])) missingItems.push(label);
  });

  if (!instructor?.teaching_regions?.length) missingItems.push('主要接課地區');

  REQUIRED_PROFILE_DOCUMENTS.forEach(({ key, label }) => {
    if (!hasInstructorDocument(instructor, key)) missingItems.push(label);
  });

  const totalItems = REQUIRED_PROFILE_FIELDS.length + REQUIRED_PROFILE_DOCUMENTS.length + 1;
  return {
    complete: missingItems.length === 0,
    missingItems,
    completedItems: totalItems - missingItems.length,
    totalItems,
    percent: Math.round(((totalItems - missingItems.length) / totalItems) * 100),
  };
};

export const isInstructorProfileComplete = (instructor) => {
  return getInstructorProfileCompletion(instructor).complete;
};
