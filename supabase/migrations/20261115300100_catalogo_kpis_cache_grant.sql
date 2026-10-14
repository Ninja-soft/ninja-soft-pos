-- El cálculo de la caché de indicadores lo corre el cron (postgres) y, en los
-- tests de integración, service_role. Nunca un usuario autenticado.
grant execute on function public.catalog_dedupe_stats_compute() to service_role;
