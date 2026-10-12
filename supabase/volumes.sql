-- Объёмы материалов по проекту: проектные объёмы, поставлено (по документам, в т.ч. из 1С) и остаток.
-- Выполнить один раз в Supabase после drawings_v2.sql: SQL Editor → New query → вставить → Run.
--
-- Кто что может:
--   * смотреть — руководитель, участники проекта, Бухгалтерия и ПТО (как и в остальных разделах);
--   * менять проектные объёмы — только тот, кто записан в drawing_admins (тот же, кто загружает чертежи);
--   * вносить поставки (вручную или из документов 1С) — руководитель и Бухгалтерия.

-- 1. Проектные объёмы: одна строка на материал в проекте.
create table if not exists public.materials (
    id            uuid primary key default gen_random_uuid(),
    project_id    uuid not null references public.projects(id) on delete cascade,
    name          text not null,
    unit          text not null default 'шт',
    design_qty    numeric not null default 0,
    revision_date date,          -- от какой редакции проекта взят объём
    source        text,          -- лист или раздел проекта, откуда объём
    updated_at    timestamptz not null default now()
);
create index if not exists materials_project_idx on public.materials(project_id);

-- 2. История корректировок проектного объёма (заполняется автоматически).
create table if not exists public.material_design_log (
    id            uuid primary key default gen_random_uuid(),
    material_id   uuid not null references public.materials(id) on delete cascade,
    old_qty       numeric,
    new_qty       numeric not null,
    revision_date date,
    source        text,
    changed_by    uuid default auth.uid(),
    changed_at    timestamptz not null default now()
);
create index if not exists material_design_log_material_idx on public.material_design_log(material_id);

-- 3. Поставки: строки накладных/УПД. material_id пустой, пока строку не сопоставили с материалом.
create table if not exists public.material_deliveries (
    id          uuid primary key default gen_random_uuid(),
    project_id  uuid not null references public.projects(id) on delete cascade,
    material_id uuid references public.materials(id) on delete set null,
    doc_number  text,
    doc_date    date,
    supplier    text,
    item_name   text not null,   -- наименование как в документе
    unit        text,
    qty         numeric not null,
    source      text not null default 'manual',  -- manual | 1c-xml | 1c-excel
    created_by  uuid default auth.uid(),
    created_at  timestamptz not null default now()
);
create index if not exists material_deliveries_project_idx on public.material_deliveries(project_id);
create index if not exists material_deliveries_material_idx on public.material_deliveries(material_id);

-- 4. Запомненные сопоставления «название в документе → материал», чтобы второй раз не выбирать.
create table if not exists public.material_aliases (
    project_id  uuid not null references public.projects(id) on delete cascade,
    alias       text not null,   -- название из документа в нижнем регистре
    material_id uuid not null references public.materials(id) on delete cascade,
    primary key (project_id, alias)
);

-- Автоматическая запись истории при добавлении материала и изменении проектного объёма.
create or replace function public.log_material_design()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'INSERT' or new.design_qty is distinct from old.design_qty
       or new.revision_date is distinct from old.revision_date then
        insert into material_design_log (material_id, old_qty, new_qty, revision_date, source)
        values (new.id, case when tg_op = 'UPDATE' then old.design_qty end, new.design_qty, new.revision_date, new.source);
    end if;
    return null;
end;
$$;
drop trigger if exists materials_design_log on public.materials;
create trigger materials_design_log
    after insert or update on public.materials
    for each row execute function public.log_material_design();

create or replace function public.touch_material()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;
drop trigger if exists materials_touch on public.materials;
create trigger materials_touch
    before update on public.materials
    for each row execute function public.touch_material();

-- Права.
create or replace function public.can_view_volumes(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.can_view_project(p_project_id)
        or exists (select 1 from profiles where id = auth.uid() and role in ('accountant', 'pto'));
$$;
grant execute on function public.can_view_volumes(uuid) to authenticated;

create or replace function public.can_edit_deliveries()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from profiles where id = auth.uid() and role in ('manager', 'accountant'));
$$;
grant execute on function public.can_edit_deliveries() to authenticated;

alter table public.materials           enable row level security;
alter table public.material_design_log enable row level security;
alter table public.material_deliveries enable row level security;
alter table public.material_aliases    enable row level security;

drop policy if exists "materials_select" on public.materials;
create policy "materials_select" on public.materials
    for select to authenticated using (public.can_view_volumes(project_id));
drop policy if exists "materials_write" on public.materials;
create policy "materials_write" on public.materials
    for all to authenticated
    using (public.can_manage_drawings())
    with check (public.can_manage_drawings());

drop policy if exists "material_design_log_select" on public.material_design_log;
create policy "material_design_log_select" on public.material_design_log
    for select to authenticated
    using (exists (select 1 from materials m where m.id = material_id and public.can_view_volumes(m.project_id)));

drop policy if exists "material_deliveries_select" on public.material_deliveries;
create policy "material_deliveries_select" on public.material_deliveries
    for select to authenticated using (public.can_view_volumes(project_id));
drop policy if exists "material_deliveries_write" on public.material_deliveries;
create policy "material_deliveries_write" on public.material_deliveries
    for all to authenticated
    using (public.can_edit_deliveries() and public.can_view_volumes(project_id))
    with check (public.can_edit_deliveries() and public.can_view_volumes(project_id));

drop policy if exists "material_aliases_select" on public.material_aliases;
create policy "material_aliases_select" on public.material_aliases
    for select to authenticated using (public.can_view_volumes(project_id));
drop policy if exists "material_aliases_write" on public.material_aliases;
create policy "material_aliases_write" on public.material_aliases
    for all to authenticated
    using (public.can_edit_deliveries() or public.can_manage_drawings())
    with check (public.can_edit_deliveries() or public.can_manage_drawings());

-- Проверка: должно показать четыре новые таблицы.
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('materials', 'material_design_log', 'material_deliveries', 'material_aliases');
