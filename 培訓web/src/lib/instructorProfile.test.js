import test from 'node:test';
import assert from 'node:assert/strict';
import {
  omitUnchangedDocumentFields,
  pickInstructorDocumentFields,
  stripAdminManagedInstructorFields,
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
