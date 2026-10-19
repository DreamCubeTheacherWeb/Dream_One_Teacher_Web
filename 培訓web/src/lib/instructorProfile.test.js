import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeInstructorSaveError,
  omitUnchangedDocumentFields,
  pickInstructorDocumentFields,
  stripAdminManagedInstructorFields,
  toInstructorUpdatePayload,
} from './instructorProfile.js';

const savedRow = {
  full_name: '王小明',
  photo_path: 'form-import/inst-1--photo.jpg',
  photo_mime: 'image/jpeg',
  photo_size: 1000,
  photo_uploaded_at: '2026-08-18T13:45:00Z',
  id_front_path: 'instructors/inst-1/id_front/a.jpg',
  id_front_mime: 'image/jpeg',
  id_front_size: 2000,
  id_front_uploaded_at: '2026-10-19T12:00:00Z',
  id_back_path: null,
  bankbook_path: 'form-import/inst-1--bankbook.jpg',
  bankbook_mime: 'image/jpeg',
  bankbook_size: 3000,
  bankbook_uploaded_at: '2026-08-18T13:45:00Z',
};

test('pickInstructorDocumentFields keeps the 16 document fields with null for missing values', () => {
  const fields = pickInstructorDocumentFields(savedRow);
  assert.equal(Object.keys(fields).length, 16);
  assert.equal(fields.photo_path, 'form-import/inst-1--photo.jpg');
  assert.equal(fields.id_back_path, null);
  assert.equal(fields.id_back_mime, null);
  assert.equal('full_name' in fields, false);
});

test('unchanged admin-uploaded or imported documents are not re-sent on save', () => {
  const saved = pickInstructorDocumentFields(savedRow);
  const payload = omitUnchangedDocumentFields({ user_id: 'user-1', ...savedRow, full_name: '王小明二' }, saved);
  for (const key of ['photo', 'id_front', 'id_back', 'bankbook']) {
    for (const suffix of ['_path', '_mime', '_size', '_uploaded_at']) {
      assert.equal(`${key}${suffix}` in payload, false, `${key}${suffix} should be omitted`);
    }
  }
  assert.equal(payload.full_name, '王小明二');
  assert.equal(payload.user_id, 'user-1');
});

test('a newly uploaded document is sent with all of its file fields', () => {
  const saved = pickInstructorDocumentFields(savedRow);
  const next = {
    ...savedRow,
    id_back_path: 'instructors/user-1/id_back/new.jpg',
    id_back_mime: 'image/png',
    id_back_size: 4000,
    id_back_uploaded_at: '2026-10-20T01:00:00Z',
  };
  const payload = omitUnchangedDocumentFields(next, saved);
  assert.equal(payload.id_back_path, 'instructors/user-1/id_back/new.jpg');
  assert.equal(payload.id_back_mime, 'image/png');
  assert.equal(payload.id_back_size, 4000);
  assert.equal(payload.id_back_uploaded_at, '2026-10-20T01:00:00Z');
  assert.equal('photo_path' in payload, false);
  assert.equal('bankbook_path' in payload, false);
});

test('a replaced imported document sends the new path, and a removed one sends null', () => {
  const saved = pickInstructorDocumentFields(savedRow);
  const next = {
    ...savedRow,
    photo_path: 'instructors/user-1/photo/new.jpg',
    photo_mime: 'image/jpeg',
    id_front_path: null,
    id_front_mime: null,
    id_front_size: null,
    id_front_uploaded_at: null,
  };
  const payload = omitUnchangedDocumentFields(next, saved);
  assert.equal(payload.photo_path, 'instructors/user-1/photo/new.jpg');
  assert.equal('id_front_path' in payload, true);
  assert.equal(payload.id_front_path, null);
  assert.equal(payload.id_front_size, null);
});

test('first-time profiles without documents send no document fields', () => {
  const payload = omitUnchangedDocumentFields({ user_id: 'user-2', full_name: '新講師', photo_path: null }, {});
  assert.equal('photo_path' in payload, false);
  assert.equal(payload.full_name, '新講師');
});

test('admin-managed fields are still stripped before document comparison', () => {
  const stripped = stripAdminManagedInstructorFields({ ...savedRow, id: 'inst-1', note_internal: 'x' });
  assert.equal('id' in stripped, false);
  assert.equal('note_internal' in stripped, false);
  assert.equal(stripped.photo_path, 'form-import/inst-1--photo.jpg');
});

test('update payload never re-sends user_id and drops an unchanged primary email', () => {
  const payload = toInstructorUpdatePayload(
    { user_id: 'user-1', email_primary: 'old@mail.example', nickname: '新暱稱' },
    'old@mail.example',
  );
  assert.equal('user_id' in payload, false);
  assert.equal('email_primary' in payload, false);
  assert.equal(payload.nickname, '新暱稱');
});

test('update payload keeps a changed primary email so the database guard still checks it', () => {
  const payload = toInstructorUpdatePayload(
    { user_id: 'user-1', email_primary: 'new@other.example', nickname: '暱稱' },
    'old@mail.example',
  );
  assert.equal('user_id' in payload, false);
  assert.equal(payload.email_primary, 'new@other.example');
});

test('update payload treats a blank email that was blank on load as unchanged', () => {
  assert.equal('email_primary' in toInstructorUpdatePayload({ email_primary: '' }, ''), false);
  assert.equal('email_primary' in toInstructorUpdatePayload({ email_primary: null }, null), false);
});

test('update payload does not mutate the insert payload', () => {
  const insertPayload = { user_id: 'user-1', email_primary: 'g@gmail.com', full_name: '王小明' };
  toInstructorUpdatePayload(insertPayload, 'g@gmail.com');
  assert.equal(insertPayload.user_id, 'user-1');
  assert.equal(insertPayload.email_primary, 'g@gmail.com');
});

test('email guard errors are explained in Chinese; other errors keep their message', () => {
  for (const message of [
    'changed instructor email must match the signed-in Google account',
    'new instructor email must match the signed-in Google account',
  ]) {
    const text = describeInstructorSaveError({ code: '42501', message }, { googleEmail: 'g@gmail.com' });
    assert.match(text, /主要 Email 必須是你登入用的 Google 信箱（g@gmail\.com）/);
    assert.match(text, /請聯繫管理員/);
    assert.doesNotMatch(text, /must match/);
  }
  assert.equal(describeInstructorSaveError({ message: 'network down' }), 'network down');
  assert.equal(
    describeInstructorSaveError({ message: 'instructor identity is not owned by the signed-in account' }),
    'instructor identity is not owned by the signed-in account',
  );
  assert.doesNotMatch(describeInstructorSaveError({ message: 'new instructor email must match the signed-in Google account' }), /（/);
});
