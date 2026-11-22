-- =========================================================
-- Granular privacy + safe share links
-- Version: privacy_sharing v1
-- Run AFTER parent_links.sql, teacher_reviews.sql and reflections.sql.
-- Safe to run more than once.
--
-- What this adds:
--   * visibility = 'teacher' (teacher-only projects)
--   * DB enforcement that is_public can only be true for visibility = 'public'
--   * Revocable share tokens for QR codes and fair/defense links
--   * get_shared_project() so guests can open a shared link without an account
--   * RLS policies for teachers and linked parents
--   * Teacher reviews accept teacher-only projects (not just public ones)
-- =========================================================

begin;

-- 1) Share-link columns ---------------------------------------------------
alter table public.projects
    add column if not exists share_token text;

alter table public.projects
    add column if not exists share_enabled boolean not null default false;

create unique index if not exists projects_share_token_idx
    on public.projects (share_token)
    where share_token is not null;

-- 2) Keep visibility and is_public in sync --------------------------------
-- Legacy clients that only send is_public keep working, while a direct API
-- call cannot mark a private/teacher/parent project as community-public.
create or replace function public.sync_project_visibility()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.visibility is null then
        new.visibility := case when coalesce(new.is_public, false) then 'public' else 'private' end;
    end if;

    if new.visibility <> 'public' then
        new.is_public := false;
    end if;

    return new;
end;
$$;

drop trigger if exists sync_project_visibility on public.projects;
create trigger sync_project_visibility
    before insert or update of visibility, is_public on public.projects
    for each row execute function public.sync_project_visibility();

-- Repair legacy rows that were marked community-public while set to a
-- narrower visibility. Their old QR links keep working if sharing was on.
update public.projects
   set is_public = false
 where visibility is not null
   and visibility <> 'public'
   and is_public = true;

-- Reject unknown visibility values on every new write. Old rows are left
-- alone (NOT VALID) so this script never rewrites student data.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'projects_visibility_check'
          and conrelid = 'public.projects'::regclass
    ) then
        execute 'alter table public.projects
                 add constraint projects_visibility_check
                 check (visibility in (''private'', ''teacher'', ''parents'', ''public''))
                 not valid';
    end if;
end $$;

-- 3) RLS: teachers can read teacher-only projects -------------------------
alter table public.projects enable row level security;

drop policy if exists "projects_select_teachers" on public.projects;
create policy "projects_select_teachers"
    on public.projects for select
    to authenticated
    using (
        visibility = 'teacher'
        and exists (
            select 1 from public.profiles p
            where p.id = auth.uid()
              and p.role = 'teacher'
        )
    );

-- 4) RLS: linked parents can read parent-approved projects ----------------
-- Parent.html still filters client-side, so both layers agree.
drop policy if exists "projects_select_linked_parents" on public.projects;
create policy "projects_select_linked_parents"
    on public.projects for select
    to authenticated
    using (
        visibility = 'parents'
        and exists (
            select 1 from public.parent_links pl
            where pl.student_id = user_id
              and pl.parent_id = auth.uid()
              and pl.status = 'approved'
        )
    );

-- 5) Owner-only share toggle ----------------------------------------------
-- Turning sharing on rotates the token, so an old printed QR code stops
-- working after sharing is turned off and back on.
create or replace function public.set_project_share(
    p_project_id bigint,
    p_enabled    boolean
)
returns table (
    share_token   text,
    share_enabled boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_owner uuid := auth.uid();
    v_token text;
    v_out_token text;
    v_out_enabled boolean;
begin
    if v_owner is null then
        raise exception 'Please log in first.';
    end if;

    if coalesce(p_enabled, false) then
        v_token := replace(gen_random_uuid()::text, '-', '');
    end if;

    update public.projects as p
       set share_enabled = coalesce(p_enabled, false),
           share_token = case when coalesce(p_enabled, false) then v_token else p.share_token end
     where p.id = p_project_id
       and p.user_id = v_owner
     returning p.share_token, p.share_enabled
          into v_out_token, v_out_enabled;

    if not found then
        raise exception 'Project not found.';
    end if;

    share_token := v_out_token;
    share_enabled := v_out_enabled;
    return next;
end;
$$;

-- 6) Guest-safe read for Shared.html --------------------------------------
-- Returns only presentation fields, and only while sharing is enabled.
create or replace function public.get_shared_project(p_token text)
returns table (
    title       text,
    author      text,
    category    text,
    subject     text,
    term        text,
    description text,
    tags        text[],
    skills      text[],
    reflection  jsonb,
    file_url    text,
    file_name   text,
    live_url    text,
    size_mb     numeric,
    created_at  timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
    if p_token is null or lower(p_token) !~ '^[a-f0-9]{32}$' then
        return;
    end if;

    return query
    select p.title,
           p.author,
           p.category,
           p.subject,
           p.term,
           p.description,
           coalesce(p.tags, '{}'::text[]),
           coalesce(p.skills, '{}'::text[]),
           p.reflection,
           p.file_url,
           p.file_name,
           p.live_url,
           p.size_mb,
           p.created_at
    from public.projects p
    where p.share_token = lower(p_token)
      and p.share_enabled = true
    limit 1;
end;
$$;

-- 7) Teacher reviews: public OR teacher-only ------------------------------
create or replace function public.submit_teacher_review(
    p_kind           text,
    p_project_id     bigint default null,
    p_featured_owner uuid default null,
    p_featured_slot  integer default null,
    p_message        text default null,
    p_scores         jsonb default null,
    p_stage          text default null,
    p_status         text default null
)
returns public.teacher_reviews
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_teacher    uuid := auth.uid();
    v_role       text;
    v_name       text;
    v_student    uuid;
    v_public     boolean;
    v_visibility text;
    v_slot       integer;
    v_message    text := nullif(trim(coalesce(p_message, '')), '');
    v_scores     jsonb;
    v_total      integer := 0;
    v_key        text;
    v_val        numeric;
    v_keys       text[] := array['content', 'creativity', 'execution', 'organization', 'impact'];
    v_row        public.teacher_reviews;
    v_id         bigint;
begin
    if v_teacher is null then
        raise exception 'Please log in first.';
    end if;

    select role, nullif(trim(coalesce(fname, '') || ' ' || coalesce(lname, '')), '')
      into v_role, v_name
    from public.profiles
    where id = v_teacher;

    if v_role is distinct from 'teacher' then
        raise exception 'Only teacher accounts can submit reviews.';
    end if;

    if p_kind not in ('feedback', 'rubric', 'milestone') then
        raise exception 'Unknown review type.';
    end if;

    -- Resolve the student owner from the chosen target.
    if p_project_id is not null then
        select user_id, is_public, visibility into v_student, v_public, v_visibility
        from public.projects
        where id = p_project_id;

        if v_student is null then
            raise exception 'Project not found.';
        end if;
        if not (coalesce(v_public, false) or v_visibility = 'teacher') then
            raise exception 'Only projects posted to the Community Showcase or shared as teacher-only can receive teacher reviews.';
        end if;
        v_slot := null;

    elsif p_featured_owner is not null and p_featured_slot is not null then
        select user_id into v_student
        from public.featured
        where user_id = p_featured_owner and slot = p_featured_slot;

        if v_student is null then
            raise exception 'That featured work was not found.';
        end if;
        v_slot := p_featured_slot;

    else
        raise exception 'Choose a posted project or a featured work to review.';
    end if;

    if p_kind = 'feedback' then
        if v_message is null then
            raise exception 'Write your feedback before posting.';
        end if;
        if length(v_message) > 2000 then
            raise exception 'Feedback must be 2000 characters or fewer.';
        end if;

        insert into public.teacher_reviews
            (teacher_id, student_id, project_id, featured_slot, kind, message, teacher_name)
        values
            (v_teacher, v_student, p_project_id, v_slot, 'feedback', v_message, coalesce(v_name, 'Teacher'))
        returning * into v_row;

        return v_row;
    end if;

    if p_kind = 'rubric' then
        if p_scores is null or jsonb_typeof(p_scores) <> 'object' then
            raise exception 'Score every rubric criterion before saving.';
        end if;

        for v_key in select jsonb_object_keys(p_scores) loop
            if not (v_key = any (v_keys)) then
                raise exception 'Unknown rubric criterion: %', v_key;
            end if;
        end loop;

        foreach v_key in array v_keys loop
            v_val := nullif(p_scores ->> v_key, '')::numeric;
            if v_val is null or v_val < 1 or v_val > 5 then
                raise exception 'Rubric scores must be between 1 and 5.';
            end if;
            v_total := v_total + v_val;
        end loop;

        v_scores := p_scores;

        select id into v_id
        from public.teacher_reviews
        where kind = 'rubric'
          and teacher_id = v_teacher
          and project_id is not distinct from p_project_id
          and featured_slot is not distinct from v_slot;

        if v_id is null then
            insert into public.teacher_reviews
                (teacher_id, student_id, project_id, featured_slot, kind,
                 message, scores, total_score, teacher_name)
            values
                (v_teacher, v_student, p_project_id, v_slot, 'rubric',
                 v_message, v_scores, v_total, coalesce(v_name, 'Teacher'))
            returning * into v_row;
        else
            update public.teacher_reviews
               set message = v_message,
                   scores = v_scores,
                   total_score = v_total,
                   teacher_name = coalesce(v_name, 'Teacher'),
                   updated_at = now()
             where id = v_id
             returning * into v_row;
        end if;

        return v_row;
    end if;

    -- Milestone review
    if p_stage not in ('proposal', 'draft', 'final') then
        raise exception 'Choose the milestone stage.';
    end if;
    if p_status not in ('approved', 'needs_revision') then
        raise exception 'Choose a milestone status.';
    end if;

    select id into v_id
    from public.teacher_reviews
    where kind = 'milestone'
      and teacher_id = v_teacher
      and stage = p_stage
      and project_id is not distinct from p_project_id
      and featured_slot is not distinct from v_slot;

    if v_id is null then
        insert into public.teacher_reviews
            (teacher_id, student_id, project_id, featured_slot, kind,
             message, stage, status, teacher_name)
        values
            (v_teacher, v_student, p_project_id, v_slot, 'milestone',
             v_message, p_stage, p_status, coalesce(v_name, 'Teacher'))
        returning * into v_row;
    else
        update public.teacher_reviews
           set message = v_message,
               status = p_status,
               teacher_name = coalesce(v_name, 'Teacher'),
               updated_at = now()
         where id = v_id
         returning * into v_row;
    end if;

    return v_row;
end;
$$;

-- 8) Permissions ----------------------------------------------------------
revoke all on function public.set_project_share(bigint, boolean) from public, anon;
grant execute on function public.set_project_share(bigint, boolean) to authenticated;

revoke all on function public.get_shared_project(text) from public;
grant execute on function public.get_shared_project(text) to anon, authenticated;

revoke execute on function public.submit_teacher_review(text, bigint, uuid, integer, text, jsonb, text, text)
    from public, anon;
grant execute on function public.submit_teacher_review(text, bigint, uuid, integer, text, jsonb, text, text)
    to authenticated;

notify pgrst, 'reload schema';

commit;

-- 9) Quick check ----------------------------------------------------------
select
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'projects'
        and column_name in ('share_token', 'share_enabled')) as share_columns,
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'projects'
        and policyname in ('projects_select_teachers', 'projects_select_linked_parents')) as privacy_policies,
    (select count(*) from pg_trigger
      where tgrelid = 'public.projects'::regclass
        and tgname = 'sync_project_visibility') as visibility_trigger;
