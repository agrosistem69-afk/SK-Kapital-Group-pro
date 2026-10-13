-- План-график работ по объекту: виды работ с объёмами, выработкой, людьми и техникой, сроками,
-- а также ежедневный факт выполнения. Из этого приложение считает отставание и прогноз.
-- Выполнить один раз в Supabase: SQL Editor → New query → вставить → Run.
--
-- Кто что может:
--   * смотреть — все, кто видит проект (как и остальные разделы объекта);
--   * составлять и менять план — Руководитель и Руководство;
--   * вносить ежедневное выполнение — Руководитель, Руководство, Сотрудник (прораб) и ПТО.

-- 1. Общие настройки графика объекта.
create table if not exists public.schedule_settings (
    project_id        uuid primary key references public.projects(id) on delete cascade,
    start_date        date,                 -- начало работ
    deadline          date,                 -- срок сдачи объекта
    people_available  integer,              -- сколько людей есть на объекте
    workdays          integer not null default 6 check (workdays in (5, 6, 7)),  -- рабочих дней в неделе
    updated_at        timestamptz not null default now()
);

-- 2. Строки план-графика: вид работ.
create table if not exists public.schedule_items (
    id             uuid primary key default gen_random_uuid(),
    project_id     uuid not null references public.projects(id) on delete cascade,
    sort_order     integer not null default 0,
    section        text,                    -- раздел/участок (Озеленение, Покрытия...)
    name           text not null,           -- вид работ
    material_id    uuid references public.materials(id) on delete set null,  -- откуда объём
    unit           text,
    qty            numeric not null default 0,   -- объём по проекту
    norm           numeric,                 -- выработка на 1 человека в смену
    crew           integer,                 -- людей по плану
    machine        text,                    -- техника (название)
    machine_count  integer,                 -- техники по плану, ед.
    start_date     date,
    end_date       date,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);
create index if not exists schedule_items_project_idx on public.schedule_items(project_id);

-- 3. Ежедневный факт: сколько сделали, сколько людей и техники вышло.
create table if not exists public.schedule_progress (
    id          uuid primary key default gen_random_uuid(),
    item_id     uuid not null references public.schedule_items(id) on delete cascade,
    project_id  uuid not null references public.projects(id) on delete cascade,
    work_date   date not null,
    qty         numeric not null default 0,
    people      integer,
    machines    integer,
    note        text,
    created_by  uuid default auth.uid(),
    created_at  timestamptz not null default now()
);
create index if not exists schedule_progress_item_idx on public.schedule_progress(item_id);
create index if not exists schedule_progress_project_idx on public.schedule_progress(project_id);

-- Права.
create or replace function public.can_plan_schedule(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.can_view_project(p_project_id)
       and exists (select 1 from profiles where id = auth.uid() and role in ('manager', 'lead'));
$$;
grant execute on function public.can_plan_schedule(uuid) to authenticated;

create or replace function public.can_report_schedule(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.can_view_project(p_project_id)
       and exists (select 1 from profiles where id = auth.uid() and role in ('manager', 'lead', 'worker', 'pto'));
$$;
grant execute on function public.can_report_schedule(uuid) to authenticated;

alter table public.schedule_settings enable row level security;
alter table public.schedule_items    enable row level security;
alter table public.schedule_progress enable row level security;

drop policy if exists "schedule_settings_select" on public.schedule_settings;
create policy "schedule_settings_select" on public.schedule_settings
    for select to authenticated using (public.can_view_project(project_id));
drop policy if exists "schedule_settings_write" on public.schedule_settings;
create policy "schedule_settings_write" on public.schedule_settings
    for all to authenticated
    using (public.can_plan_schedule(project_id))
    with check (public.can_plan_schedule(project_id));

drop policy if exists "schedule_items_select" on public.schedule_items;
create policy "schedule_items_select" on public.schedule_items
    for select to authenticated using (public.can_view_project(project_id));
drop policy if exists "schedule_items_write" on public.schedule_items;
create policy "schedule_items_write" on public.schedule_items
    for all to authenticated
    using (public.can_plan_schedule(project_id))
    with check (public.can_plan_schedule(project_id));

drop policy if exists "schedule_progress_select" on public.schedule_progress;
create policy "schedule_progress_select" on public.schedule_progress
    for select to authenticated using (public.can_view_project(project_id));
drop policy if exists "schedule_progress_insert" on public.schedule_progress;
create policy "schedule_progress_insert" on public.schedule_progress
    for insert to authenticated
    with check (public.can_report_schedule(project_id));
-- Исправить или удалить запись выполнения: автор записи или тот, кто составляет план.
drop policy if exists "schedule_progress_change" on public.schedule_progress;
create policy "schedule_progress_change" on public.schedule_progress
    for update to authenticated
    using (created_by = auth.uid() or public.can_plan_schedule(project_id))
    with check (public.can_report_schedule(project_id));
drop policy if exists "schedule_progress_delete" on public.schedule_progress;
create policy "schedule_progress_delete" on public.schedule_progress
    for delete to authenticated
    using (created_by = auth.uid() or public.can_plan_schedule(project_id));

-- Проверка: должно показать три таблицы.
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('schedule_settings', 'schedule_items', 'schedule_progress');
