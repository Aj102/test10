-- =========================================================
-- Guided Portfolio Reflections
-- Adds one nullable jsonb column used by the upload form's
-- subject-specific reflection prompts.
-- Run this in the Supabase SQL Editor (safe to run more than once).
-- =========================================================

alter table public.projects
    add column if not exists reflection jsonb;

comment on column public.projects.reflection is
    'Guided reflection answers: [{"prompt": "What problem did I solve?", "answer": "..."}]';

-- Make PostgREST pick up the new column immediately.
notify pgrst, 'reload schema';
