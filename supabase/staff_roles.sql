-- Должности «Бригадир» и «Прораб», бригада пользователя в табеле и свой список работ у каждого.
-- Выполнить один раз в Supabase: SQL Editor → New query → вставить весь файл → Run.
-- Повторный запуск ничего не ломает.

-- 1. Должность и бригада в профиле. Права по-прежнему берутся из role:
--    бригадир = role 'worker', прораб = role 'lead', поэтому прежние правила доступа не меняются.
alter table public.profiles add column if not exists staff_role text;
alter table public.profiles drop constraint if exists profiles_staff_role_check;
alter table public.profiles add constraint profiles_staff_role_check check (staff_role is null or staff_role in ('brigadier', 'foreman'));
alter table public.profiles add column if not exists brigade text;   -- название бригады (группы) в табеле

-- Должность и бригаду меняет только руководитель (из «Пользователи и роли»).
create or replace function public.profiles_guard_staff() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is not null
       and (new.staff_role is distinct from old.staff_role or new.brigade is distinct from old.brigade)
       and not exists (select 1 from public.profiles where id = auth.uid() and role = 'manager') then
        raise exception 'Должность и бригаду меняет только руководитель';
    end if;
    return new;
end $$;
drop trigger if exists profiles_guard_staff on public.profiles;
create trigger profiles_guard_staff before update on public.profiles
    for each row execute function public.profiles_guard_staff();

-- 2. Табель: сотрудник и бригадир отмечают только свою бригаду; руководитель, руководство и прораб — любую.
create or replace function public.timesheet_guard_brigade() returns trigger
language plpgsql security definer set search_path = public as $$
declare
    my_role text; my_brigade text; worker_group text;
    wid public.timesheet_entries.worker_id%type;
begin
    if auth.uid() is null then return coalesce(new, old); end if;   -- запросы из SQL Editor
    select role, brigade into my_role, my_brigade from public.profiles where id = auth.uid();
    if my_role in ('manager', 'lead') then return coalesce(new, old); end if;
    wid := case when tg_op = 'DELETE' then old.worker_id else new.worker_id end;
    select group_name into worker_group from public.workers where id = wid;
    if my_role = 'worker' and coalesce(trim(my_brigade), '') <> ''
       and lower(trim(coalesce(worker_group, ''))) = lower(trim(my_brigade)) then
        return coalesce(new, old);
    end if;
    raise exception 'В табеле можно отмечать только свою бригаду';
end $$;
drop trigger if exists timesheet_guard_brigade on public.timesheet_entries;
create trigger timesheet_guard_brigade before insert or update or delete on public.timesheet_entries
    for each row execute function public.timesheet_guard_brigade();

-- 3. Свой список работ: чей список (пусто — общий список руководителя, как было раньше).
alter table public.tasks add column if not exists owner_id uuid references auth.users(id) on delete set null;
create index if not exists tasks_owner_id on public.tasks (owner_id);
