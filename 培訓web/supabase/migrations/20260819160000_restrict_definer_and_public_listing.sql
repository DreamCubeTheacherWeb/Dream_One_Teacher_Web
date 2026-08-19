-- Remove legacy PUBLIC execution grants from SECURITY DEFINER functions.
-- Only the two WCA webhook RPCs intentionally remain callable by anon; both
-- validate the rotated capability secret before reading or writing data.

REVOKE ALL ON FUNCTION public.admin_link_instructor(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_unlink_instructor(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_claim_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_claim_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.find_unlinked_instructor_by_my_email() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_cube_leaderboard(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_interaction_leaderboard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_teacher_badge_stats(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_teacher_stats() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_teaching_leaderboard_v2(integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_teaching_leaderboard(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_teaching_years() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_wca_allaround_leaderboard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_wca_events() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_wca_leaderboard(text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_link_instructor(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unlink_instructor(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_claim_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_claim_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_unlinked_instructor_by_my_email() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cube_leaderboard(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_interaction_leaderboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_teacher_badge_stats(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_teacher_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_teaching_leaderboard_v2(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_teaching_leaderboard(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_teaching_years() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_wca_allaround_leaderboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_wca_events() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_wca_leaderboard(text, text) TO authenticated;

-- Trigger functions never need direct client execution.
REVOKE ALL ON FUNCTION public.guard_instructor_role() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_instructor_name_to_users() FROM PUBLIC, anon, authenticated;

-- WCA automation uses the anon API surface with a rotated 256-bit secret.
REVOKE ALL ON FUNCTION public.get_wca_sync_targets(text) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.sync_wca_results(text, jsonb) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wca_sync_targets(text) TO anon;
GRANT EXECUTE ON FUNCTION public.sync_wca_results(text, jsonb) TO anon;

-- Public buckets do not require SELECT policies to serve getPublicUrl() assets.
-- Removing broad SELECT prevents anonymous directory listing.  Badge uploads use
-- upsert, so administrators retain a narrow SELECT policy for that operation.
DROP POLICY IF EXISTS "badge_icons public read" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view content images" ON storage.objects;
DROP POLICY IF EXISTS "badge_icons admin read" ON storage.objects;

CREATE POLICY "badge_icons admin read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'badge_icons'
    AND (SELECT private.current_user_is_admin())
  );

-- Pin the search path of the three remaining mutable-path trigger functions.
ALTER FUNCTION public.update_instructors_updated_at() SET search_path = '';
ALTER FUNCTION public.set_class_sessions_updated_at() SET search_path = '';
ALTER FUNCTION public.detect_session_anomaly() SET search_path = '';
