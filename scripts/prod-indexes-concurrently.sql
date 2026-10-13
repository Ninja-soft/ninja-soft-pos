-- =============================================================================
-- scripts/prod-indexes-concurrently.sql  (ADR-090 · F4)
--
-- Índices de la migración 20261108500000_perf_f4_indices_rls_initplan creados
-- con CONCURRENTLY: no bloquean INSERT / UPDATE / DELETE de la tabla mientras
-- se construyen. Correrlo en producción ANTES de aplicar la migración cuando
-- las tablas tengan volumen; la migración después los encuentra hechos
-- ("if not exists") y sólo hace la parte de RLS.
--
-- Reglas:
--   * CREATE INDEX CONCURRENTLY no puede ir dentro de una transacción: correr
--     sentencia por sentencia (psql sin -1, o el SQL editor de Supabase de a
--     una). Nada de BEGIN / COMMIT alrededor.
--   * Si una falla (timeout, deadlock), queda un índice INVALID con ese
--     nombre: borrarlo con "drop index concurrently if exists <nombre>;" y
--     volver a correr esa línea. Revisar con la consulta del final.
--   * Subir statement_timeout para la sesión si hace falta (ej. 15 min).
-- =============================================================================

set statement_timeout = '15min';

create index concurrently if not exists payments_tenant_created_idx
  on public.payments (tenant_id, created_at desc);
create index concurrently if not exists payments_reconciled_by_idx
  on public.payments (reconciled_by) where reconciled_by is not null;

create index concurrently if not exists sales_promo_idx
  on public.sales (promo_id) where promo_id is not null;
create index concurrently if not exists sales_coupon_idx
  on public.sales (coupon_id) where coupon_id is not null;

create index concurrently if not exists cash_movements_tenant_created_idx
  on public.cash_movements (tenant_id, created_at desc);

create index concurrently if not exists stock_movements_store_created_idx
  on public.stock_movements (store_id, created_at desc);

create index concurrently if not exists table_order_items_product_idx
  on public.table_order_items (product_id) where product_id is not null;

-- fiscal_documents: sólo si ARCA (20261101100100) ya está aplicada. Al
-- 2026-10-13 la tabla no existe en producción: saltear este bloque, la
-- migración crea los índices sobre la tabla vacía.
create index concurrently if not exists fiscal_documents_tenant_status_created_idx
  on public.fiscal_documents (tenant_id, status, created_at desc);
create index concurrently if not exists fiscal_documents_store_created_idx
  on public.fiscal_documents (store_id, created_at desc) where store_id is not null;
create index concurrently if not exists fiscal_documents_return_idx
  on public.fiscal_documents (return_id) where return_id is not null;
create index concurrently if not exists fiscal_documents_assoc_idx
  on public.fiscal_documents (assoc_document_id) where assoc_document_id is not null;
create index concurrently if not exists fiscal_documents_caea_idx
  on public.fiscal_documents (caea_id) where caea_id is not null;

-- Redundantes (después de crear los de arriba).
drop index concurrently if exists public.audit_logs_tenant_idx;
drop index concurrently if exists public.cash_movements_tenant_id_idx;
drop index concurrently if exists public.stock_movements_store_id_idx;

-- Verificación: no debe devolver filas (índices inválidos que quedaron de un
-- CONCURRENTLY cortado).
select c.relname as invalid_index
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not i.indisvalid;
