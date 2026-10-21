-- Монтаж МАФ: какие скамьи, урны, велопарковки уже установлены. Отметку ставят на плане листа
-- (кнопка «МАФ» над чертежом); приложение считает факт и остаток по каждой марке.
-- Видят все участники проекта, ставить и снимать отметки может ответственный за чертежи (can_manage_drawings).
-- Выполнить один раз в Supabase после drawings.sql и drawings_v2.sql: SQL Editor → New query → вставить → Run.

create table if not exists public.maf_installs (
    id                 uuid primary key default gen_random_uuid(),
    project_id         uuid not null references public.projects(id) on delete cascade,
    sheet              text not null,          -- название листа (в нижнем регистре): отметки переживают новую редакцию
    item_id            text not null,          -- номер МАФ на плане (А1, В5…)
    mark               text not null,          -- марка (СК-1, У-1…)
    installed_at       timestamptz not null default now(),
    installed_by       uuid default auth.uid() references auth.users(id) on delete set null,
    installed_by_name  text,
    unique (project_id, sheet, item_id)
);
create index if not exists maf_installs_sheet on public.maf_installs (project_id, sheet);

alter table public.maf_installs enable row level security;

drop policy if exists "maf_installs_select" on public.maf_installs;
create policy "maf_installs_select" on public.maf_installs
    for select to authenticated
    using (public.can_view_project(project_id));

drop policy if exists "maf_installs_insert" on public.maf_installs;
create policy "maf_installs_insert" on public.maf_installs
    for insert to authenticated
    with check (public.can_manage_drawings() and public.can_view_project(project_id));

drop policy if exists "maf_installs_delete" on public.maf_installs;
create policy "maf_installs_delete" on public.maf_installs
    for delete to authenticated
    using (public.can_manage_drawings());

-- Проверка: должна показать таблицу maf_installs.
select table_name from information_schema.tables where table_schema = 'public' and table_name = 'maf_installs';
