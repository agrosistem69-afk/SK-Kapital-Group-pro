-- Объёмы, дополнение: раздел проекта (Озеленение, Покрытия, МАФ…) и группа внутри раздела
-- (Деревья, Кустарники…), чтобы материалы на экране «Объёмы» были разложены по разделам.
-- Выполнить один раз в Supabase после volumes.sql: SQL Editor → New query → вставить → Run.

alter table public.materials add column if not exists section  text;
alter table public.materials add column if not exists category text;

-- Проверка: должны показаться две строки, section и category.
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'materials' and column_name in ('section', 'category');
