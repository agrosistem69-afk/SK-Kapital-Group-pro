-- Задания бригадирам: работы из вашего списка, где исполнитель — человек, связанный с пользователем,
-- видны у него в списке. Он меняет название, участок, заметки, процент и статус, но не сроки, не исполнителя,
-- не закрывает (галочка, «Завершено») и не удаляет. Закрывает автор задания; руководитель — любое.
-- Выполнить один раз в Supabase после staff_roles.sql: SQL Editor → New query → вставить весь файл → Run.

-- 1. Связь пользователя с записью в «Сотрудниках».
alter table public.profiles add column if not exists worker_id uuid references public.workers(id) on delete set null;

-- Должность, бригаду и связь с сотрудником меняет только руководитель.
create or replace function public.profiles_guard_staff() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is not null
       and (new.staff_role is distinct from old.staff_role or new.brigade is distinct from old.brigade
            or new.worker_id is distinct from old.worker_id)
       and not exists (select 1 from public.profiles where id = auth.uid() and role = 'manager') then
        raise exception 'Должность, бригаду и связь с сотрудником меняет только руководитель';
    end if;
    return new;
end $$;

-- 2. Чужие задания: сроки, исполнитель, закрытие и удаление — только у автора и руководителя.
create or replace function public.tasks_guard_assignment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then return coalesce(new, old); end if;   -- запросы из SQL Editor
    if old.owner_id is not distinct from auth.uid() then return coalesce(new, old); end if;
    if exists (select 1 from public.profiles where id = auth.uid() and role = 'manager') then return coalesce(new, old); end if;
    if tg_op = 'DELETE' then
        raise exception 'Задание удаляет только его автор';
    end if;
    if new.start_date is distinct from old.start_date or new.due_date is distinct from old.due_date
       or new.worker_id is distinct from old.worker_id or new.owner_id is distinct from old.owner_id
       or new.project_id is distinct from old.project_id
       or coalesce(new.struck, false) <> coalesce(old.struck, false)
       or (coalesce(new.status, '') = 'completed') <> (coalesce(old.status, '') = 'completed') then
        raise exception 'Сроки, исполнителя и закрытие задания меняет только его автор';
    end if;
    return new;
end $$;
drop trigger if exists tasks_guard_assignment on public.tasks;
create trigger tasks_guard_assignment before update or delete on public.tasks
    for each row execute function public.tasks_guard_assignment();
