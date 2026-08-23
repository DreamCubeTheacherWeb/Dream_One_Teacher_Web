/* Teacher Training Platform - Database Setup (Supabase / PostgreSQL) */

-- 1. users (使用者) - Extend Supabase Auth users
create table users (
  id uuid references auth.users not null primary key,
  name text,
  email text,
  role text check (role in ('pending', 'teacher', 'admin')) default 'pending',
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table users enable row level security;

-- 2. courses (課程)
create table courses (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  description text,
  is_published boolean default false,
  "order" int default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table courses enable row level security;

-- 3. lessons (章節)
create table lessons (
  id uuid default gen_random_uuid() primary key,
  course_id uuid references courses(id) on delete cascade not null,
  title text not null,
  "order" int default 0,
  is_published boolean default false,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table lessons enable row level security;

-- 4. contents (內容)
create table contents (
  id uuid default gen_random_uuid() primary key,
  lesson_id uuid references lessons(id) on delete cascade not null,
  type text check (type in ('article', 'video')) not null,
  title text not null,
  body text, -- for article
  video_url text, -- for video
  "order" int default 0,
  status text check (status in ('draft', 'published', 'archived')) default 'draft',
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table contents enable row level security;

-- 5. progress (學習進度)
create table progress (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  lesson_id uuid references lessons(id) on delete cascade not null,
  completed boolean default false,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, lesson_id)
);

alter table progress enable row level security;

-- 6. assignments (作業)
create table assignments (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  lesson_id uuid references lessons(id) on delete cascade not null,
  type text check (type in ('video', 'text')) not null,
  content text, -- for text type (心得)
  file_url text, -- for video file (storage link)
  feedback text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table assignments enable row level security;

-- 7. Sync Supabase Auth Users with public.users table automatically
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, name, email, role)
  values (new.id, new.raw_user_meta_data->>'full_name', new.email, 'pending')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- RLS Policies Setup (Example basics)

-- RLS Policies Setup

-- Users Table: 允許使用者讀取自己的資料，允許管理員讀取所有資料
create policy "Users can view own profile" on public.users for select using (
  auth.uid() = id
);
create policy "Admins can view all profiles" on public.users for select using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);
create policy "Admins can update all profiles" on public.users for update using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);

-- Courses Table: 管理員可做任何事，已核准教師可讀取已發佈課程（pending 使用者無法看到）
create policy "Admins can do everything on courses" on courses for all using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);
create policy "Approved users can view published courses" on courses for select using (
  is_published = true
  and exists (select 1 from public.users where id = auth.uid() and role in ('teacher', 'admin'))
);

-- Lessons Table: 管理員可做任何事，已核准教師可讀取已發佈章節
create policy "Admins can do everything on lessons" on lessons for all using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);
create policy "Approved users can view published lessons" on lessons for select using (
  is_published = true
  and exists (select 1 from public.users where id = auth.uid() and role in ('teacher', 'admin'))
);

-- Contents Table: 管理員可做任何事，已核准教師可讀取章節內容
create policy "Admins can do everything on contents" on contents for all using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);
create policy "Approved users can view contents" on contents for select using (
  exists (select 1 from public.users where id = auth.uid() and role in ('teacher', 'admin'))
);

-- Progress Table: 教師可管理自己的進度，管理員可檢視所有進度
create policy "Users can view own progress" on progress for select using (
  auth.uid() = user_id
);
create policy "Users can insert own progress" on progress for insert with check (
  auth.uid() = user_id
);
create policy "Users can update own progress" on progress for update using (
  auth.uid() = user_id
);
create policy "Admins can do everything on progress" on progress for all using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);

-- Assignments Table: 教師可繳交與查看自己的作業，管理員可管理所有作業
create policy "Users can view own assignments" on assignments for select using (
  auth.uid() = user_id
);
create policy "Users can insert own assignments" on assignments for insert with check (
  auth.uid() = user_id
);
create policy "Admins can do everything on assignments" on assignments for all using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);

-- ═══════════════════════════════════════════════════════════════════
-- 新增功能：講師管理 / 培訓進度 / 佈告欄
-- ═══════════════════════════════════════════════════════════════════

-- 8. users 表新增欄位
alter table users add column if not exists mentor_name text;

-- 9. teacher_invites（預先建檔，管理員邀請尚未註冊的講師）
create table teacher_invites (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  email text not null unique,
  role text check (role in ('pending', 'teacher', 'admin')) default 'teacher',
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table teacher_invites enable row level security;

create policy "Admins can do everything on teacher_invites" on teacher_invites for all using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);

-- 10. course_training_status（每位講師在每門課程的培訓狀態）
create table course_training_status (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  course_id uuid references courses(id) on delete cascade not null,
  status text check (status in ('training', 'completed', 'exempt')) default 'training',
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, course_id)
);

alter table course_training_status enable row level security;

create policy "Users can view own training status" on course_training_status for select using (
  auth.uid() = user_id
);
create policy "Admins can do everything on course_training_status" on course_training_status for all using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);

-- 11. announcements（佈告欄）
create table announcements (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  content text not null,
  tag text default '一般公告',
  pinned boolean default false,
  published boolean default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table announcements enable row level security;

revoke all on public.announcements from anon, authenticated;
grant select, insert, update, delete on public.announcements to authenticated;

create policy "Approved users can view published announcements" on announcements for select to authenticated using (
  published = true
  and exists (
    select 1
    from public.users
    where id = (select auth.uid())
      and role in ('teacher', 'mentor', 'admin')
  )
);
create policy "Admins can do everything on announcements" on announcements for all using (
  exists (select 1 from public.users where id = auth.uid() and role = 'admin')
);

-- 12. 更新 handle_new_user trigger：支援預先核准名單（跳過待審核）
-- 若 email 在 teacher_invites 中 → 直接取得預設角色（teacher/admin），無需審核
-- 若 email 不在名單中 → 預設為 pending（待審核），需管理員手動核准
create or replace function public.handle_new_user()
returns trigger as $$
declare
  invite_record record;
begin
  select * into invite_record from public.teacher_invites where email = new.email;

  if invite_record is not null then
    insert into public.users (id, name, email, role)
    values (
      new.id,
      coalesce(invite_record.name, new.raw_user_meta_data->>'full_name'),
      new.email,
      invite_record.role
    )
    on conflict (id) do nothing;

    delete from public.teacher_invites where email = new.email;
  else
    insert into public.users (id, name, email, role)
    values (new.id, new.raw_user_meta_data->>'full_name', new.email, 'pending')
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$ language plpgsql security definer;
