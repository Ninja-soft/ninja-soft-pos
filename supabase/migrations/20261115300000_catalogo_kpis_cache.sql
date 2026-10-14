-- Indicadores del catálogo maestro (panel interno) desde una caché.
-- catalog_dedupe_stats() contaba ~700k ofertas en cada consulta y superaba el
-- statement_timeout (8 s) de PostgREST: la pantalla quedaba en skeleton.
-- Ahora el cálculo corre en segundo plano (pg_cron cada 30 min, sin el límite
-- de PostgREST) y la RPC devuelve el último resultado guardado.

create table if not exists public.catalog_stats_cache (
  id smallint primary key default 1 check (id = 1),
  stats jsonb not null,
  computed_at timestamptz not null default now()
);
alter table public.catalog_stats_cache enable row level security;
drop policy if exists catalog_stats_cache_internal_read on public.catalog_stats_cache;
create policy catalog_stats_cache_internal_read on public.catalog_stats_cache
  for select to authenticated using ((select internal_scope()));
revoke all on public.catalog_stats_cache from anon;

create or replace function public.catalog_dedupe_stats_compute()
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '10min'
as $function$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'items', (select count(*) from catalog_items),
    'items_globales', (select count(*) from catalog_items where store_scope = ''),
    'items_por_tienda', (select count(*) from catalog_items where store_scope <> ''),
    'items_con_varias_tiendas', (select count(*) from (
        select item_id from catalog_offers where vendedor_key = ''
         group by item_id having count(*) > 1) m),
    'ofertas', (select count(*) from catalog_offers),
    'ofertas_tienda', (select count(*) from catalog_offers where vendedor_key = ''),
    'ofertas_vendedores', (select count(*) from catalog_offers where vendedor_key <> ''),
    'tiendas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', s.key, 'name', s.name,
               'ofertas_tienda', coalesce(o.tienda, 0),
               'ofertas_vendedores', coalesce(o.vendedores, 0),
               'disponibles', coalesce(o.disponibles, 0),
               'en_catalogo', exists (select 1 from catalog_store_map m where m.store_key = s.key))
             order by s.name)
        from catalog_stores s
        left join (
          select store_key,
                 count(*) filter (where vendedor_key = '') as tienda,
                 count(*) filter (where vendedor_key <> '') as vendedores,
                 count(*) filter (where disponible) as disponibles
            from catalog_offers group by store_key) o on o.store_key = s.key), '[]'::jsonb)
  ) into v;
  insert into public.catalog_stats_cache (id, stats, computed_at)
  values (1, v, now())
  on conflict (id) do update set stats = excluded.stats, computed_at = excluded.computed_at;
  return v;
end;
$function$;

revoke all on function public.catalog_dedupe_stats_compute() from public, anon, authenticated;

create or replace function public.catalog_dedupe_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v jsonb;
begin
  if not (select internal_scope()) then
    raise exception 'forbidden';
  end if;
  select c.stats || jsonb_build_object('computed_at', c.computed_at)
    into v
    from public.catalog_stats_cache c
   where c.id = 1;
  return coalesce(v, jsonb_build_object('pending', true));
end;
$fn$;
revoke all on function public.catalog_dedupe_stats() from public, anon;
grant execute on function public.catalog_dedupe_stats() to authenticated;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'catalog-stats-refresh';
    perform cron.schedule('catalog-stats-refresh', '*/30 * * * *', 'select public.catalog_dedupe_stats_compute()');
  end if;
end;
$cron$;

-- El primer cálculo lo hace el cron (no acá: dentro de la migración también
-- corre con statement_timeout y el recuento completo lo supera).
