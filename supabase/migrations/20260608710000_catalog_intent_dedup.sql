-- BUG 12 (anti doble cobro de catálogo): a lo sumo UN intent pending por
-- (tenant, catalog) a la vez. Red de seguridad ante carreras entre dos requests
-- de catalog_purchase_checkout que pasen el chequeo de reutilización casi
-- simultáneamente. No afecta intents finalizados (approved/rejected/cancelled),
-- así que el historial de compras se conserva y se puede reintentar tras un
-- final negativo.
create unique index if not exists catalog_payment_intents_one_pending_idx
  on public.catalog_payment_intents (tenant_id, catalog_id)
  where status = 'pending';
