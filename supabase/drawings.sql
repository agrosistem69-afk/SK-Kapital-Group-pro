-- Интерактивные чертежи: таблица листов и закрытое хранилище.
-- Выполнить один раз в Supabase: SQL Editor → New query → вставить → Run.
--
-- Кто что может:
--   * смотреть лист — руководитель (manager) и любой участник проекта (project_members);
--   * добавлять, менять и удалять листы — только сборщик с service_role ключом
--     (политик на запись для обычных пользователей нет, поэтому из приложения изменить нельзя).

create table if not exists public.drawings (
    id          uuid primary key default gen_random_uuid(),
    project_id  uuid not null references public.projects(id) on delete cascade,
    section     text not null default '',
    sheet       text not null,
    file_path   text not null unique,
    source_hash text,
    updated_at  timestamptz not null default now()
);

create index if not exists drawings_project_idx on public.drawings(project_id);

alter table public.drawings enable row level security;

create or replace function public.can_view_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from profiles where id = auth.uid() and role = 'manager')
        or exists (select 1 from project_members where user_id = auth.uid() and project_id = p_project_id);
$$;

drop policy if exists "drawings_select_members" on public.drawings;
create policy "drawings_select_members" on public.drawings
    for select to authenticated
    using (public.can_view_project(project_id));

-- Закрытый bucket. Путь файла: <project_id>/<имя>.html
insert into storage.buckets (id, name, public)
values ('drawings', 'drawings', false)
on conflict (id) do update set public = false;

drop policy if exists "drawings_files_select_members" on storage.objects;
create policy "drawings_files_select_members" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'drawings'
        and public.can_view_project(((storage.foldername(name))[1])::uuid)
    );
