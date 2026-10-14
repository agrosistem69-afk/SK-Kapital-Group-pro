-- Замечания на чертежах: фигуры, стрелки, линии от руки и подписи поверх плана листа.
-- Рисовать и видеть могут все участники проекта. Удалять и менять замечание может его автор,
-- а чужие — только ответственный за чертежи (can_manage_drawings).
-- Выполнить один раз в Supabase после drawings.sql и drawings_v2.sql: SQL Editor → New query → вставить → Run.

create table if not exists public.drawing_notes (
    id           uuid primary key default gen_random_uuid(),
    project_id   uuid not null references public.projects(id) on delete cascade,
    sheet        text not null,                 -- название листа (в нижнем регистре): замечания переживают новую редакцию
    drawing_id   uuid references public.drawings(id) on delete set null,  -- на какой редакции нарисовано
    author_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
    author_name  text,
    kind         text not null check (kind in ('rect', 'ellipse', 'arrow', 'pen', 'text')),
    color        text not null default '#dc2626',
    data         jsonb not null,                -- координаты в единицах чертежа (метрах)
    text         text,                          -- подпись или комментарий
    resolved     boolean not null default false,
    created_at   timestamptz not null default now()
);
create index if not exists drawing_notes_sheet on public.drawing_notes (project_id, sheet);

alter table public.drawing_notes enable row level security;

drop policy if exists "drawing_notes_select" on public.drawing_notes;
create policy "drawing_notes_select" on public.drawing_notes
    for select to authenticated
    using (public.can_view_project(project_id));

drop policy if exists "drawing_notes_insert" on public.drawing_notes;
create policy "drawing_notes_insert" on public.drawing_notes
    for insert to authenticated
    with check (author_id = auth.uid() and public.can_view_project(project_id));

drop policy if exists "drawing_notes_update" on public.drawing_notes;
create policy "drawing_notes_update" on public.drawing_notes
    for update to authenticated
    using (author_id = auth.uid() or public.can_manage_drawings())
    with check (public.can_view_project(project_id));

drop policy if exists "drawing_notes_delete" on public.drawing_notes;
create policy "drawing_notes_delete" on public.drawing_notes
    for delete to authenticated
    using (author_id = auth.uid() or public.can_manage_drawings());

-- Проверка: должна показать таблицу drawing_notes.
select table_name from information_schema.tables where table_schema = 'public' and table_name = 'drawing_notes';
