-- ═══════════════════════════════════════════════════════════════════
-- 遊戲化：講師數據聚合函式（成就徽章 + 排行榜共用）2026-07-07
-- 在 Supabase SQL Editor 貼上整份執行，可重複執行（idempotent）。
-- ───────────────────────────────────────────────────────────────────
-- 設計原則：不新增任何「可寫入」的表，避免資料一致性負擔。徽章與排行榜
-- 都由這一支 SECURITY DEFINER 函式即時算出——前端拿到每位講師的數據後，
-- 排行榜負責排序、徽章負責用門檻判斷解鎖。完訓證明另用現成的
-- course_training_status='completed' 判定（不在本檔）。
-- ───────────────────────────────────────────────────────────────────
-- ⚠️ 若執行時報「欄位不存在」，代表線上 schema 與 supabase/*.sql 有落差，
--    把錯誤訊息回報給我修正對應欄位名即可（本函式只讀不寫，建立失敗無副作用）。
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_teacher_stats()
RETURNS TABLE (
  user_id uuid,
  display_name text,
  photo_path text,
  joined_at timestamptz,
  completed_lessons bigint,   -- 完成的章節數（progress.completed）
  completed_courses bigint,   -- 完訓的課程數（course_training_status='completed'）
  assignments_submitted bigint, -- 提交的作業數
  comments_count bigint,      -- 留言次數
  likes_received bigint        -- 留言累積被按讚數
) AS $$
BEGIN
  -- 守衛：任何登入者都能看排行榜，但未登入不行
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  -- 所有子查詢欄位都以表別名限定（pr./cts./asg./lcm./lc.），避免與本函式回傳欄位
  -- user_id 撞名——否則 Postgres 執行時會報 "column reference user_id is ambiguous"。
  RETURN QUERY
  SELECT
    u.id,
    COALESCE(i.nickname, i.full_name, u.name, split_part(u.email, '@', 1)) AS display_name,
    i.photo_path,
    u.created_at,
    COALESCE(p.cnt, 0)  AS completed_lessons,
    COALESCE(c.cnt, 0)  AS completed_courses,
    COALESCE(a.cnt, 0)  AS assignments_submitted,
    COALESCE(cm.cnt, 0) AS comments_count,
    COALESCE(lk.cnt, 0) AS likes_received
  FROM public.users u
  LEFT JOIN public.instructors i ON i.user_id = u.id
  LEFT JOIN (
    SELECT pr.user_id, count(*) AS cnt FROM public.progress pr WHERE pr.completed GROUP BY pr.user_id
  ) p ON p.user_id = u.id
  LEFT JOIN (
    SELECT cts.user_id, count(*) AS cnt FROM public.course_training_status cts
    WHERE cts.status = 'completed' GROUP BY cts.user_id
  ) c ON c.user_id = u.id
  LEFT JOIN (
    SELECT asg.user_id, count(*) AS cnt FROM public.assignments asg GROUP BY asg.user_id
  ) a ON a.user_id = u.id
  LEFT JOIN (
    SELECT lcm.user_id, count(*) AS cnt FROM public.lesson_comments lcm GROUP BY lcm.user_id
  ) cm ON cm.user_id = u.id
  LEFT JOIN (
    SELECT lc.user_id, count(*) AS cnt
    FROM public.lesson_comment_likes lcl
    JOIN public.lesson_comments lc ON lc.id = lcl.comment_id
    GROUP BY lc.user_id
  ) lk ON lk.user_id = u.id
  WHERE u.role = 'teacher';  -- 只排講師，排除 admin/mentor/pending
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_teacher_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teacher_stats() TO authenticated;

-- 驗證：任一登入 session 執行應回傳每位講師一列數據
--   SELECT * FROM public.get_teacher_stats() ORDER BY completed_lessons DESC;
