---
reviewed: 2026-08-24T14:56:52+08:00
base: 1689acce903a16d38ab690506938107cee9d4b20
head: 916ee869a07a37c66ed0f6a60d0d0cd53769cb1d
files_reviewed_list:
  - 培訓web/package.json
  - 培訓web/scripts/verify-claim-admin-ui.mjs
  - 培訓web/scripts/verify-google-only-auth.mjs
  - 培訓web/scripts/verify-instructor-autolink.mjs
  - 培訓web/scripts/verify-instructor-claim-flow.mjs
  - 培訓web/scripts/verify-instructor-claim-flow.sql
  - 培訓web/src/App.jsx
  - 培訓web/src/components/Layout.jsx
  - 培訓web/src/context/AuthContext.jsx
  - 培訓web/src/lib/formGenerator.js
  - 培訓web/src/lib/profileCompletion.js
  - 培訓web/src/lib/profileCompletion.test.js
  - 培訓web/src/pages/PendingApproval.jsx
  - 培訓web/src/pages/PrivacyPolicy.jsx
  - 培訓web/src/pages/ProfilePage.jsx
  - 培訓web/src/pages/TermsOfService.jsx
  - 培訓web/src/pages/admin/ClaimRequests.jsx
  - 培訓web/src/pages/admin/Dashboard.jsx
  - 培訓web/src/pages/admin/DownloadCenter.jsx
  - 培訓web/src/pages/admin/InstructorList.jsx
  - 培訓web/src/pages/admin/TeacherManager.jsx
  - 培訓web/supabase/migrations/20260824061533_align_instructor_claim_flow.sql
findings:
  critical: 4
  warning: 1
  suggestion: 0
  nit: 2
  total: 7
status: issues_found
---

# Code Review

**Status:** issues_found — 7 findings (4 critical, 1 warning, 0 suggestion, 2 nit).

**Files reviewed:** 22
**Diff range:** `1689acce903a16d38ab690506938107cee9d4b20..916ee869a07a37c66ed0f6a60d0d0cd53769cb1d`
**Intent:** Consolidate instructor identity claim and approval into authentication, profile, and account administration; remove the standalone instructor invitation/claim queue; make instructor master records the source for documents and form generation.

## Bugs & Security

### CR-01 — Imported external documents disappear from generated forms

**File:** `培訓web/src/lib/profileCompletion.js:40-43`
**Severity:** Critical
**Confidence:** 97
**Issue:** `*_external_url` now satisfies document completion, but the PDF generation chain still consumes only `*_path`. Imported ID-card and bankbook images can therefore be reported as complete and then be omitted from the generated remittance form.
**Fix:** Resolve each document from its Storage path or external URL before image embedding, and cover external-only instructor masters in the form-generation regression test.

### CR-02 — Existing mentor and admin invitations are stranded

**File:** `培訓web/supabase/migrations/20260824061533_align_instructor_claim_flow.sql:21-31`
**Severity:** Critical
**Confidence:** 92
**Historical context:** `b01507a2a2a8e749661a80f400aeb8cd85e995c0` introduced pending administrator/mentor promotion from invitations; `9292362498880e7fb5d5b7feefdcc840d11c9ae9` retained it alongside instructor auto-linking.
**Issue:** The migration converts and removes only `teacher` invitations, while the new signup path no longer consumes the remaining `mentor` or `admin` rows. Those staff accounts now remain `pending` instead of receiving their intended roles.
**Fix:** Preserve a narrowly scoped staff onboarding path for existing mentor/admin records, or migrate them into an explicit staff-access table before deprecating `teacher_invites`.

### NR-01 — A pending account can manufacture an email-match conflict

**File:** `培訓web/supabase/migrations/20260824061533_align_instructor_claim_flow.sql:299-302`
**Severity:** Nit
**Confidence:** 25
**Issue:** The hook rejects duplicate normalized email matches, but the reviewed source still appears to let an authenticated pending user create a master row with an arbitrary `email_primary`. That allows a low-privilege account to create a duplicate matching a real lecturer and block the real account with a 409. Live database privileges were unavailable, so confidence is capped at 25.
**Fix:** Bind instructor creation and email changes to an admin-only path; for self-service pending profiles, derive the email from `auth.users` server-side and reject changes to another address.

## CLAUDE.md Adherence

### CR-03 — Migration filename violates the repository convention

**File:** `培訓web/supabase/migrations/20260824061533_align_instructor_claim_flow.sql:1`
**Severity:** Critical
**Confidence:** 100
**CLAUDE.md rule:** "新增遷移檔請用 `YYYY-MM-DD_描述.sql` 格式（如 `2026-07-07_security_hardening.sql`），別再用會誤導的數字前綴。" (`CLAUDE.md`)
**Issue:** The compact timestamp prefix does not follow the required date-dash migration naming convention.
**Fix:** Rename the migration to `2026-08-24_align_instructor_claim_flow.sql`.

## Quality & Architecture

### CR-04 — Required-document definitions have already drifted

**File:** `培訓web/src/pages/admin/InstructorList.jsx:26`
**Severity:** Critical
**Confidence:** 98
**Anchor:** `培訓web/src/lib/profileCompletion.js:28-32` defines the shared required-document set; `培訓web/src/pages/admin/InstructorList.jsx:596-598` still tests `docCount === 4` while displaying a `/3` denominator.
**Issue:** InstructorList creates a second required-document registry instead of consuming the shared definition. The two sources already disagree: all three required files produce `3/3` while the completion badge remains yellow because its predicate still expects four.
**Fix:** Export and consume one shared required-document registry and derive both count and completed state from its length.

### WR-01 — Claim conflicts can create additional instructor masters

**File:** `培訓web/src/pages/PendingApproval.jsx:52-54`
**Severity:** Warning
**Confidence:** 85
**Anchor:** `培訓web/src/pages/PendingApproval.jsx:20-21` redirects every account without a linked instructor to `/profile`; `培訓web/src/pages/ProfilePage.jsx:402-405` can upsert a new instructor row by `user_id`.
**Issue:** A `conflict` claim result is only rendered as alternate copy. The redirect runs first, so a conflicted account reaches the new-profile path and can create another master record, enlarging the duplicate set that caused the conflict.
**Fix:** Route conflict accounts to a non-editable support state and allow profile creation only when the claim RPC returns the explicit `new` status.

## Performance

### NR-02 — Normalized email matching scans the instructor table repeatedly

**File:** `培訓web/supabase/migrations/20260824061533_align_instructor_claim_flow.sql:96-116`
**Severity:** Nit
**Confidence:** 25
**Hot path:** request-path
**Frequency:** Every first-time or unlinked login × 2 scans; every new Auth user creation × up to 3 scans
**Per-call cost:** O(number of instructors) scan with `lower` and `BTRIM` evaluated for every row
**Verdict:** moderate
**Issue:** The new login and signup predicates normalize `email_primary` repeatedly without a matching expression index.
**Fix:** Add a partial expression index on `lower(BTRIM(email_primary))` for nonblank email values.

## Resolution

All seven findings were addressed after this review in the same task branch:

- External document URLs are now resolved and embedded during PDF generation; required-image failures stop generation with an explicit message.
- Legacy admin/mentor bootstrap rows are consumed on first staff login while teacher rows migrate into instructor masters.
- Non-admin instructor identity email changes are bound to the signed-in Google account by a database trigger.
- The migration was renamed to `2026-08-24_align_instructor_claim_flow.sql`.
- InstructorList consumes the shared required-document registry and derives both the denominator and completion predicate from it.
- Claim conflicts remain on a non-editable support path and cannot create another instructor master.
- A normalized primary-email expression index covers the login/signup predicates.

The post-fix unit, database, browser, targeted ESLint, production-build, and whitespace checks are recorded in `STATUS.md`.
