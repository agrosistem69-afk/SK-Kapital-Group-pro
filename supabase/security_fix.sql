-- Закрываем дыры в доступе (проверка безопасности 23.10.2026).
-- Выполнить один раз в Supabase: SQL Editor → New query → вставить весь файл → Run. Повторный запуск ничего не ломает.
--
-- Что меняется:
--   1. Роль (Руководитель, Бухгалтерия, ПТО…) меняет только Руководитель. Сам себе роль поднять нельзя.
--   2. Новый пользователь после регистрации всегда «Заказчик», что бы ни прислал браузер.
--   3. В проект человека добавляет только Руководитель («Пользователи и роли»). Сам себя добавить нельзя.
--   4. Список проектов больше не виден до входа на сайт.
-- Запросы из SQL Editor (без входа на сайт) эти проверки не затрагивают.

-- 1. Роль, должность, бригаду и связь с сотрудником меняет только руководитель.
create or replace function public.profiles_guard_staff() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is not null
       and (new.role is distinct from old.role
            or new.staff_role is distinct from old.staff_role or new.brigade is distinct from old.brigade
            or new.worker_id is distinct from old.worker_id or new.id is distinct from old.id)
       and not exists (select 1 from public.profiles where id = auth.uid() and role = 'manager') then
        raise exception 'Роль, должность и бригаду меняет только руководитель';
    end if;
    return new;
end $$;
drop trigger if exists profiles_guard_staff on public.profiles;
create trigger profiles_guard_staff before update on public.profiles
    for each row execute function public.profiles_guard_staff();

-- 2. Новый профиль: роль «Заказчик», без должности и бригады — если его создаёт не руководитель.
--    Пока в базе нет ни одного руководителя, правило не действует (чтобы можно было завести первого).
create or replace function public.profiles_guard_new() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if exists (select 1 from public.profiles where role = 'manager')
       and not exists (select 1 from public.profiles where id = auth.uid() and role = 'manager') then
        new.role := 'customer';
        new.staff_role := null;
        new.brigade := null;
        new.worker_id := null;
    end if;
    return new;
end $$;
drop trigger if exists profiles_guard_new on public.profiles;
create trigger profiles_guard_new before insert on public.profiles
    for each row execute function public.profiles_guard_new();

-- 3. Участников проекта добавляет и убирает только руководитель.
create or replace function public.project_members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then return coalesce(new, old); end if;   -- запросы из SQL Editor
    if exists (select 1 from public.profiles where id = auth.uid() and role = 'manager') then return coalesce(new, old); end if;
    raise exception 'Доступ к проекту открывает только руководитель';
end $$;
drop trigger if exists project_members_guard on public.project_members;
create trigger project_members_guard before insert or update or delete on public.project_members
    for each row execute function public.project_members_guard();

-- 4. Список проектов для формы регистрации больше не нужен: закрываем его для всех.
do $$
begin
    if exists (select 1 from pg_views where schemaname = 'public' and viewname = 'signup_projects') then
        execute 'revoke all on public.signup_projects from anon, authenticated';
    end if;
end $$;

-- Проверка: должны показаться три строки — profiles_guard_staff, profiles_guard_new, project_members_guard.
select tgname from pg_trigger
where tgname in ('profiles_guard_staff', 'profiles_guard_new', 'project_members_guard') and not tgisinternal;
