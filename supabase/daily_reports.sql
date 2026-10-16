-- Ежедневные отчёты: у каждого пользователя свой отчёт за день по объекту
-- (люди по бригадам из табеля, техника, заметки).
-- Видит свой отчёт автор; все отчёты видят руководитель и руководство (прораб).
-- Менять и удалять отчёт может только его автор.
-- Выполнить один раз в Supabase: SQL Editor → New query → вставить весь файл → Run. Повторный запуск ничего не ломает.

create table if not exists public.daily_reports (
    id           uuid primary key default gen_random_uuid(),
    project_id   uuid not null references public.projects(id) on delete cascade,
    author_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
    author_name  text,
    report_date  date not null,
    crews        jsonb not null default '[]'::jsonb,   -- [{"brigade": "Данияр", "people": 5}] — снимок табеля на момент сохранения
    machines     jsonb not null default '[]'::jsonb,   -- [{"name": "Мини-погрузчик", "count": 1, "hours": 8}]
    notes        text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (project_id, author_id, report_date)
);
create index if not exists daily_reports_project_date on public.daily_reports (project_id, report_date);

alter table public.daily_reports enable row level security;

drop policy if exists "daily_reports_select" on public.daily_reports;
create policy "daily_reports_select" on public.daily_reports
    for select to authenticated
    using (author_id = auth.uid()
           or (public.can_view_project(project_id)
               and exists (select 1 from public.profiles where id = auth.uid() and role in ('manager', 'lead'))));

drop policy if exists "daily_reports_insert" on public.daily_reports;
create policy "daily_reports_insert" on public.daily_reports
    for insert to authenticated
    with check (author_id = auth.uid() and public.can_view_project(project_id));

drop policy if exists "daily_reports_update" on public.daily_reports;
create policy "daily_reports_update" on public.daily_reports
    for update to authenticated
    using (author_id = auth.uid())
    with check (author_id = auth.uid() and public.can_view_project(project_id));

drop policy if exists "daily_reports_delete" on public.daily_reports;
create policy "daily_reports_delete" on public.daily_reports
    for delete to authenticated
    using (author_id = auth.uid());

-- Проверка: должна показать таблицу daily_reports.
select table_name from information_schema.tables where table_schema = 'public' and table_name = 'daily_reports';
