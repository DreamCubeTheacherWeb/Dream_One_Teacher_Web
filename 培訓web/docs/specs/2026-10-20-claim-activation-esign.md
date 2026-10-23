# 規格：帳號認領啟用（Email OTP）＋電子契約簽署證據（2026-10-20）

來源：業主 2026-10-20 貼上的「講師資源站帳號認領及電子契約簽署」需求（本週上線）。
本檔是資料庫／前端／測試三方的**介面契約**；改介面要先改本檔。

## 0. 已定案的決策（主對話依建議定，業主可推翻）
- D1 姓名空位：輸入姓名仍可「認領綁定」（方便追蹤），但**只綁不開通**；開通必須用 OTP 驗證「公司已確認的 Email」。
  空位沒有已確認 Email → 顯示「請聯絡行政人員確認 Email」，由管理員在後台填入並註記確認管道。
- D2 既有主檔（migration 執行當下已存在、且不是「新建帳號待審核」的列）一律標記「身分已核驗」＝公司既有核驗結果登錄，
  記錄登錄時間；非第三方／政府實名認證。既有 `email_primary`（非空）一併登錄為「公司既有資料之 Email」。
- D3 OTP 與寄信全在 Postgres：`pg_net` 呼叫 Resend API，API key 與寄件者放 Supabase Vault。不另架 Edge Function。
- D4 所有認領路徑（Email 對應、姓名＋手機＋末四碼、姓名空位）都改成「綁定後待啟用」；已是 teacher 的既有帳號不受影響（補一筆 legacy 啟用紀錄）。
  「新建帳號」維持管理員審核；核准＝公司核驗，同時把 Google 信箱登錄為已確認 Email。
- D5 簽約 OTP 改用本系統 OTP（寄到綁定的已確認 Email），取代 Supabase Auth 的 signInWithOtp（那個只能寄 Google 登入信箱）。
- D6 文件雜湊：瀏覽器用 WebCrypto 算 SHA-256 送上來，伺服器記錄並在可比對時比對（範本雜湊在管理員上傳時登錄）；
  事後由「完整性驗證」重新下載計算比對，加上證據列的雜湊鏈，任何竄改可被發現。

## 1. 資料庫（migration：`supabase/migrations/20261020100000_claim_activation_esign_evidence.sql`）

### 1.1 instructors 新欄位（admin 專屬，由獨立 trigger `trg_guard_instructor_claim_fields` 保護；2026-10-22 起不再改寫共用的 guard_instructor_admin_fields，以免與已上線的 personnel_types 版本互相覆蓋）
| 欄位 | 型別 | 說明 |
|---|---|---|
| identity_verified_at | timestamptz | 身分已核驗的登錄時間 |
| identity_verification_basis | text | 例：`公司既有核驗結果登錄（非第三方實名認證）`、`管理員審核新進講師`、`管理員建立講師資料` |
| confirmed_email | text | 公司已確認屬於該講師的 Email（小寫去空白）；OTP 一律寄這裡 |
| confirmed_email_at | timestamptz | |
| confirmed_email_by | uuid | 確認的管理員；既有資料登錄為 NULL |
| confirmed_email_method | text | `company_existing_record`／`admin_trusted_channel`（附註記）／`google_login_new_instructor` |
| confirmed_email_note | text | 管理員註記，例「10/20 透過 LINE 與老師確認」 |

### 1.2 新表（全部 RLS：本人讀自己的、admin 讀全部；**沒有任何直接寫入政策**，只能透過 SECURITY DEFINER 函式）
- `public.instructor_account_activations`：id, instructor_id, user_id, claim_method（`email_match`｜`identity_check`｜`name_slot`｜`new_instructor_approved`｜`legacy_pre_activation`）,
  claimed_at（伺服器）, activation_email, otp_challenge_id, otp_verified_at, activated_at, status（`pending`｜`active`｜`revoked`）, revoked_at, revoked_reason。
  同一 user 同時只能有一筆 pending/active。
- `private.email_otp_challenges`（不對外）：id, user_id, purpose（`account_activation`｜`contract_sign`）, target_email, code_hash, salt, created_at, expires_at（+5 分）,
  attempts, max_attempts(5), verified_at, consumed_at, superseded_at, delivery_id。**不存明碼**。
- `public.email_delivery_log`（寄送紀錄）：id, kind（`otp_activation`｜`otp_contract`｜`contract_signed_copy`）, to_email, subject, related_user_id, related_contract_id,
  requested_at, provider('resend'), net_request_id, status（`queued`｜`sent`｜`failed`｜`not_configured`）, http_status, provider_message_id, error_text, updated_at。
  信件內文不入庫（OTP 信尤其不可）。**只有 admin 讀得到**（2026-10-23 資安審查建議 2：to_email 是全文，本人讀得到會抵銷遮罩；前端只有後台 ContractEvidencePanel 讀）。
- `public.contract_consent_records`（append-only）：id, user_id, instructor_id, decision（`agree_electronic`｜`decline_electronic`）, consent_text_version, consent_text,
  doc_versions jsonb, ip_address, user_agent, created_at（伺服器）。
- `public.contract_signing_evidence`（append-only，雜湊鏈）：id, contract_id, user_id, instructor_id, bound_email, doc_versions, document_sha256 jsonb, signed_pdf_paths jsonb,
  signed_pdf_sha256 jsonb, consent_id, consent_at, otp_challenge_id, otp_verified_at, signed_at, ip_address, user_agent, previous_evidence_sha256, evidence_sha256, created_at。
  evidence_sha256 ＝ sha256(前一筆 evidence_sha256 ∥ 本列規範化 JSON)。
- `contract_documents.content_sha256 text`（範本檔雜湊；管理員上傳新版時寫入；舊版可由管理員補登）。
- `instructor_contracts` 補欄位：instructor_id, bound_email, consent_id, otp_challenge_id, otp_verified_at, document_sha256 jsonb, signed_pdf_sha256 jsonb, evidence_id,
  voided_at, voided_reason, superseded_by。

### 1.3 防竄改
- `instructor_contracts`：trigger 禁止 DELETE（任何人）；UPDATE 只允許 `signed → voided`（同時寫 voided_at／voided_reason／superseded_by），其他欄位不得變。
- `contract_consent_records`、`contract_signing_evidence`、`instructor_account_activations` 的已完成欄位：trigger 禁止 UPDATE/DELETE（啟用表只允許 pending→active／active→revoked）。
- Storage `contract-documents`：`signed/` 底下任何人（含 admin）不可 UPDATE/DELETE；被任何已簽契約引用的範本檔不可 UPDATE/DELETE。
- `contract_documents`：被已簽契約引用的版本不可刪除、不可改 file_path／version／content_sha256。
- `delete_user_completely`：帳號有已簽契約時拒絕刪除（訊息：依簽署證據保存規定不可刪除，請改用停用）。
- 函式 `public.admin_verify_contract_evidence_chain()` → {ok, checked, first_broken_id}。

### 1.4 RPC 介面（前端只呼叫這些；全部 SECURITY DEFINER、search_path=''、auth.uid() 檢查）
| 函式 | 參數 | 回傳（jsonb） |
|---|---|---|
| `get_my_activation_status()` | — | `{status:'none'｜'pending'｜'active', claim_method, has_confirmed_email:bool, masked_email:'ab***@gmail.com'｜null, profile_complete:bool}` |
| `request_email_otp(p_purpose text)` | `account_activation`／`contract_sign` | `{status:'sent', challenge_id, expires_at, masked_email, resend_after_seconds:60}`；`{status:'cooldown', retry_after_seconds}`；`{status:'rate_limited'}`（每人每小時 5 封）；`{status:'daily_limit_reached'}`（每人每 24 小時 10 封，2026-10-23）；`{status:'locked_contact_admin'}`（24 小時內被鎖 3 組 → 暫停寄碼 24 小時，2026-10-23）；`{status:'no_confirmed_email'}`；`{status:'profile_incomplete'}`（僅啟用）；`{status:'not_allowed', reason}`；`{status:'email_not_configured'}` |
| `verify_email_otp(p_challenge_id uuid, p_code text)` | 6 位數字 | `{status:'verified', verified_at, activated:bool}`；`{status:'invalid', attempts_remaining}`；`{status:'expired'}`；`{status:'used'}`；`{status:'locked'}`（剛好是 24 小時內第 3 組被鎖時另帶 `sending_suspended:true`）；`{status:'superseded'}` |
| `record_contract_consent(p_decision text, p_doc_versions jsonb, p_consent_text_version text)` | `agree_electronic`／`decline_electronic` | `{status:'recorded', consent_id, created_at}`（decline 另通知所有 admin，內文只有資料庫文件名稱＋Google 登入信箱，不帶講師自填文字）；錯誤：`ACCOUNT_NOT_ACTIVE`、`INVALID_INPUT`（含空物件）、`CONSENT_RATE_LIMITED`（每人每小時 10 筆，同意＋不同意合計）、`DOC_VERSION_MISMATCH`（鍵不是目前啟用中的契約文件類型、或版本不是正整數）、`CONSENT_TEXT_UNKNOWN`（2026-10-23） |
| `submit_my_contract(...)` v2 | 既有參數 ＋ `p_otp_challenge_id uuid, p_consent_id uuid, p_document_sha256 jsonb, p_signed_pdf_sha256 jsonb` | `{status:'signed', contract_id, signed_at, evidence_id, copy_email_masked}`；錯誤用 RAISE，MESSAGE 為代碼：`OTP_REQUIRED`、`OTP_EXPIRED`、`OTP_ALREADY_USED`、`CONSENT_REQUIRED`、`DOC_VERSION_MISMATCH`、`DOC_HASH_MISMATCH`、`INVALID_HASH`、`ACCOUNT_NOT_ACTIVE` 等 |
| `admin_confirm_instructor_email(p_instructor_id uuid, p_email text, p_note text)` | admin | `{status:'confirmed'}` |
| `admin_set_document_hash(p_document_id uuid, p_sha256 text)` | admin；只能補登 NULL 的 | `{status:'saved'}` |
| `admin_verify_contract_evidence_chain()` | admin | `{ok, checked, first_broken_id}` |
| `admin_reset_email_otp_lock(p_user_id uuid)` | admin（2026-10-23） | `{status:'reset', was_locked}`；解除「連續輸錯暫停寄碼」，之前被鎖的 challenge 不再計入；帳號不存在 `USER_NOT_FOUND` |

規則：
- OTP：6 位數、5 分鐘有效、只能驗證成功一次、錯 5 次鎖該 challenge；同目的重寄冷卻 60 秒，新寄出後舊的作廢（superseded）；每人每小時最多 5 封、
  每 24 小時最多 10 封（兩種用途合計）；24 小時內被鎖的 challenge 累計 3 個就暫停寄碼 24 小時（`private.email_otp_send_locks`），行政用 `admin_reset_email_otp_lock` 解除（2026-10-23）。
- 啟用：OTP 驗證成功當下把 users.role pending→teacher、活化紀錄 active、寫 otp_verified_at／activated_at；需要主檔資料完整（`private.instructor_profile_is_complete`）且有 confirmed_email。
- 簽約 OTP：驗證後 15 分鐘內須送出；`submit_my_contract` 會 consume，同一 challenge 不能用第二次。
- 同意紀錄：agree 且 2 小時內、doc_versions 與送出時一致才算數。
- 同意文案版本白名單（2026-10-23）：agree 只收 `esign-consent-v1`；decline 只收 `esign-decline-paper-v1`／`esign-minor-paper-v1`；其他回 `CONSENT_TEXT_UNKNOWN`。
  `submit_my_contract` 只認 agree＋白名單版本的同意紀錄（否則 `CONSENT_REQUIRED`）。升版要同時改 record_contract_consent 與 submit_my_contract 的白名單、
  以新代碼種入新文案、改前端 esignCopy.js 的版本代碼（四處，見 migration 註解）。
- IP：`request.headers` 的 `cf-connecting-ip` → `x-forwarded-for` 第一段 → `x-real-ip`；UA 用 header `user-agent`（前端參數只當後備）。時間全用伺服器 `now()`，timestamptz（UTC 儲存，顯示 Asia/Taipei）。
- 簽約成功後寄「簽署完成通知」到 bound_email，內含登入後可下載的網址 `https://dream-one-teacher.zeabur.app/contract/view/<contract_id>`，寫 email_delivery_log。
- 寄信設定：Vault secret `resend_api_key`、`resend_from`（例 `夢想一號 <no-reply@網域>`）；缺任一 → 寄信紀錄 `not_configured`，`request_email_otp` 回 `email_not_configured`。
- `private.refresh_email_delivery_status()` 讀 `net._http_response` 更新寄送狀態；pg_cron 每分鐘跑。

### 1.5 認領函式改動
- `claim_instructor_name_slot`、`claim_existing_instructor_by_identity`、`claim_my_precreated_instructor`：綁定後**不再**把 role 改成 teacher，改寫一筆 pending 啟用紀錄；
  回傳 `status:'claimed'` 不變，另加 `activation_required:true`。
- `approve_new_instructor_account`：照舊改 teacher，並寫 `new_instructor_approved` 啟用紀錄（active）、confirmed_email＝該帳號 Google 信箱、identity_verified_at＝now()。
- 管理員解除綁定（`admin_unlink_instructor`）：啟用紀錄改 revoked。

### 1.6 未啟用的綁定者讀不到主檔關聯資料（migration：`20261023100000_linked_reads_require_active_account.sql`，2026-10-23 資安審查必修 1）
- 判斷函式 `private.current_user_is_approved_account()`＝本人 `users.role IN ('teacher','mentor','admin')`。加在：class_sessions「Instructors view own sessions」、
  storage「Users can view files referenced by own instructor profile」、badge_overrides「badge_ovr read」、`get_teacher_badge_stats`、`get_teaching_leaderboard`／`_v2`（未啟用者回空集合）。
- 姓名空位認領排除已有 class_sessions／class_sessions_quarantine／salary_master_rows／salary_payout_export_items 紀錄的主檔（回 `not_found`）。
- pending 仍可讀寫自己的主檔、自己 uid 資料夾的上傳檔、草稿、通知與啟用流程。
- 正式庫四支連續套用：233000 → 100000 → 120000 → 20261023100000。

## 2. 前端
- `/pending` 認領成功 → `/profile`；`/profile` 頂端依 `get_my_activation_status()`：
  - pending＋無已確認 Email →「你的 Email 尚未經公司確認，請聯絡行政人員確認後才能啟用帳號」；
  - pending＋資料未完整 →「請先補齊資料，再按下方『確認資料無誤，驗證信箱啟用帳號』」；
  - pending＋資料完整 → 按鈕「確認資料無誤，驗證信箱啟用帳號」→ OTP 視窗（顯示遮罩信箱、倒數、重寄）→ 成功後重新載入成 teacher。
- 簽約頁：閱讀每份文件（可下載範本）→ 電子簽約同意頁（同意／不同意改紙本，文案見法規顧問版）→ OTP（`contract_sign`）→ 手寫簽名 → 確認簽署（送出前用 WebCrypto 算範本與成品 SHA-256）→
  成功頁顯示伺服器簽署時間與「副本通知已寄到 xx***@…」。
- 契約查閱頁：列出所有版本（含已作廢），可下載。
- 後台：講師資料總覽進度新增「待確認 Email」「待信箱驗證」；每列 admin 可「確認 Email」；合約管理頁每份契約可看證據、寄送紀錄、「驗證檔案完整性」（重新下載算 SHA-256 比對）、「驗證證據鏈」。

## 3. 必測情境（上線前）
錯誤認領、OTP 過期、OTP 重複使用、OTP 錯 5 次、重寄冷卻、冒用帳號（別人的 challenge）、簽署中斷（驗證後關頁再回來）、簽署途中契約改版、重複送出、
簽後文件遭修改（storage 檔案被換／evidence 被改 → 完整性與證據鏈驗證抓得到）、不同意電子簽約、未設定寄信金鑰。
