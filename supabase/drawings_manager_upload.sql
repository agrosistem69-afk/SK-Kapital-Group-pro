-- Ручная загрузка листов руководителем прямо из приложения (кнопка «Загрузить лист»).
-- Выполнить один раз в Supabase после drawings.sql: SQL Editor → New query → вставить → Run.
-- Добавлять и удалять листы может только руководитель (manager); остальные по-прежнему только смотрят.

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from profiles where id = auth.uid() and role = 'manager');
$$;

drop policy if exists "drawings_insert_managers" on public.drawings;
create policy "drawings_insert_managers" on public.drawings
    for insert to authenticated
    with check (public.is_manager());

drop policy if exists "drawings_update_managers" on public.drawings;
create policy "drawings_update_managers" on public.drawings
    for update to authenticated
    using (public.is_manager())
    with check (public.is_manager());

drop policy if exists "drawings_delete_managers" on public.drawings;
create policy "drawings_delete_managers" on public.drawings
    for delete to authenticated
    using (public.is_manager());

drop policy if exists "drawings_files_insert_managers" on storage.objects;
create policy "drawings_files_insert_managers" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'drawings' and public.is_manager());

drop policy if exists "drawings_files_delete_managers" on storage.objects;
create policy "drawings_files_delete_managers" on storage.objects
    for delete to authenticated
    using (bucket_id = 'drawings' and public.is_manager());
