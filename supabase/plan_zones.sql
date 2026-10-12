-- Зоны и выбранные участки на плане («Объёмы» → «По зонам»), чтобы они были видны на всех устройствах.
-- У каждого пользователя свои зоны: на телефоне и компьютере под одной учётной записью они одинаковые.
-- Выполнить один раз в Supabase: SQL Editor → New query → вставить → Run.

create table if not exists public.plan_zones (
    user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
    project_id  uuid not null references public.projects(id) on delete cascade,
    sheet       text not null,               -- название листа (в нижнем регистре)
    zones       jsonb not null default '[]', -- обведённые зоны
    picked      jsonb not null default '[]', -- выбранные участки
    updated_at  timestamptz not null default now(),
    primary key (user_id, project_id, sheet)
);

alter table public.plan_zones enable row level security;

drop policy if exists "plan_zones_own" on public.plan_zones;
create policy "plan_zones_own" on public.plan_zones
    for all to authenticated
    using (user_id = auth.uid() and public.can_view_volumes(project_id))
    with check (user_id = auth.uid() and public.can_view_volumes(project_id));

-- Проверка: должна показать таблицу plan_zones.
select table_name from information_schema.tables where table_schema = 'public' and table_name = 'plan_zones';
