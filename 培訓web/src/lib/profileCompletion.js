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

const isLegacyMailingAddressNote = (value) => (
  typeof value === 'string' && value.trim().startsWith('[通訊地址]')
);

const deriveGenderFromTaiwanId = (idNumber) => {
  const normalized = typeof idNumber === 'string' ? idNumber.trim().toUpperCase() : '';
  if (!/^[A-Z][12]\d{8}$/.test(normalized)) return null;
  return normalized[1] === '1' ? '男' : '女';
};

export const getInstructorLegacyRecoverableItems = (instructor) => {
  const recoverable = [];
  if (!hasValue(instructor?.nickname) && hasValue(instructor?.line_name || instructor?.full_name)) {
    recoverable.push('講師暱稱');
  }
  if (!hasValue(instructor?.gender) && deriveGenderFromTaiwanId(instructor?.id_number)) {
    recoverable.push('性別');
  }
  if (
    (!hasValue(instructor?.bio_notes) || isLegacyMailingAddressNote(instructor?.bio_notes))
    && [
      instructor?.bio_personal_experience,
      instructor?.bio_teaching_experience,
      instructor?.teaching_philosophy,
    ].some(hasValue)
  ) {
    recoverable.push('經歷 / 理念');
  }
  if (!instructor?.teaching_regions?.length && hasValue(instructor?.teaching_regions_raw)) {
    recoverable.push('主要接課地區');
  }
  const bankFieldsMissing = [
    'bank_account_name', 'bank_name', 'bank_branch', 'bank_account_number', 'bank_code',
  ].some((key) => !hasValue(instructor?.[key]));
  if (bankFieldsMissing && hasValue(instructor?.bank_info_raw)) {
    recoverable.push('舊匯款帳戶資料');
  }
  return recoverable;
};

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
    if (
      !hasValue(instructor?.[key])
      || (key === 'bio_notes' && isLegacyMailingAddressNote(instructor?.[key]))
    ) missingItems.push(label);
  });

  if (!instructor?.teaching_regions?.length) missingItems.push('主要接課地區');

  REQUIRED_PROFILE_DOCUMENTS.forEach(({ key, label }) => {
    if (!hasInstructorDocument(instructor, key)) missingItems.push(label);
  });

  const totalItems = REQUIRED_PROFILE_FIELDS.length + REQUIRED_PROFILE_DOCUMENTS.length + 1;
  return {
    complete: missingItems.length === 0,
    missingItems,
    recoverableItems: getInstructorLegacyRecoverableItems(instructor),
    completedItems: totalItems - missingItems.length,
    totalItems,
    percent: Math.round(((totalItems - missingItems.length) / totalItems) * 100),
  };
};

export const isInstructorProfileComplete = (instructor) => {
  return getInstructorProfileCompletion(instructor).complete;
};
