-- Чертежи, версия 2: дата редакции листа и загрузка только для выбранных людей.
-- Выполнить один раз в Supabase после drawings.sql и drawings_manager_upload.sql:
-- SQL Editor → New query → вставить → в последней строке вписать свою почту → Run.

-- 1. Дата редакции проекта (от какого числа лист), показывается у каждого листа.
alter table public.drawings add column if not exists revision_date date;

-- 2. Кто может загружать, править и удалять листы. Остальные только смотрят.
create table if not exists public.drawing_admins (
    user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.drawing_admins enable row level security;
-- Политик нет: из приложения таблицу не прочитать и не изменить, только через функцию ниже.

create or replace function public.can_manage_drawings()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from drawing_admins where user_id = auth.uid());
$$;
grant execute on function public.can_manage_drawings() to authenticated;

drop policy if exists "drawings_insert_managers" on public.drawings;
create policy "drawings_insert_managers" on public.drawings
    for insert to authenticated
    with check (public.can_manage_drawings());

drop policy if exists "drawings_update_managers" on public.drawings;
create policy "drawings_update_managers" on public.drawings
    for update to authenticated
    using (public.can_manage_drawings())
    with check (public.can_manage_drawings());

drop policy if exists "drawings_delete_managers" on public.drawings;
create policy "drawings_delete_managers" on public.drawings
    for delete to authenticated
    using (public.can_manage_drawings());

drop policy if exists "drawings_files_insert_managers" on storage.objects;
create policy "drawings_files_insert_managers" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'drawings' and public.can_manage_drawings());

drop policy if exists "drawings_files_delete_managers" on storage.objects;
create policy "drawings_files_delete_managers" on storage.objects
    for delete to authenticated
    using (bucket_id = 'drawings' and public.can_manage_drawings());

-- 3. Дать право загрузки себе: замените ВАША_ПОЧТА на почту, с которой входите на skkg.ru.
insert into public.drawing_admins (user_id)
select id from auth.users where lower(email) = lower('ВАША_ПОЧТА')
on conflict do nothing;

-- Проверка: должна показаться одна строка с вашей почтой.
select u.email from public.drawing_admins a join auth.users u on u.id = a.user_id;
