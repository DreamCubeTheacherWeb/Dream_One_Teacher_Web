-- Repair the production dependency required by guard_instructor_admin_fields().
-- The 2026-08-19 hardening trigger protects this administrator-managed field,
-- but production had not received the earlier column migration.

ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS speed_qualification text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.instructors'::regclass
      AND conname = 'instructors_speed_qualification_check'
  ) THEN
    ALTER TABLE public.instructors
      ADD CONSTRAINT instructors_speed_qualification_check
      CHECK (
        speed_qualification IS NULL
        OR speed_qualification IN ('speed_teacher', 'speed_master')
      );
  END IF;
END
$$;

COMMENT ON COLUMN public.instructors.speed_qualification IS
  'Administrator-managed speed-cubing qualification used by salary and profile security rules.';
