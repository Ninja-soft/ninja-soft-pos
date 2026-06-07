-- =============================================================================
-- 20260608220000_sale_number  (número de venta único por tenant — invariante)
-- -----------------------------------------------------------------------------
-- NOTA: la numeración de ventas YA EXISTE en el esquema vivo y NO se duplica:
--   * sales.number               bigint NOT NULL  (correlativo interno por tenant)
--   * UNIQUE (tenant_id, number)  -> constraint sales_tenant_id_number_key
--   * create_sale(...)            asigna coalesce(max(number),0)+1 por tenant.
--   * pos_settings.sale_prefix / sale_pad + formatSaleNumber() le dan formato
--     legible para mostrar/buscar (NINJA-000042), sin cambiar el correlativo.
--
-- Esta migración es IDEMPOTENTE y defensiva: re-asegura la invariante de
-- unicidad por (tenant_id, number) por si algún entorno quedó sin ella. NO
-- reescribe create_sale (es el path de cobro: lo toca otro flujo) — y no hace
-- falta, porque la UNIQUE garantiza que dos ventas nunca compartan número:
-- ante una carrera, el segundo INSERT con el mismo número falla y revierte
-- (no se produce un duplicado).
-- =============================================================================

-- 1) Asegura la columna del correlativo (no-op si ya existe).
alter table sales add column if not exists number bigint;

-- 2) Asegura la unicidad por tenant (no-op si ya existe la constraint).
--    El DO tolera el caso de que ya exista (con cualquier nombre) comparando
--    las columnas exactas de la constraint UNIQUE.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sales'::regclass
      and contype = 'u'
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.sales'::regclass and attname = 'tenant_id'),
        (select attnum from pg_attribute where attrelid = 'public.sales'::regclass and attname = 'number')
      ]
  ) then
    alter table sales
      add constraint sales_tenant_id_number_key unique (tenant_id, number);
  end if;
end $$;
