-- =============================================================================
-- 20260531270000_sale_number_format  (numeración de comprobante personalizable)
-- Prefijo + padding por tenant para MOSTRAR el N° correlativo de venta.
-- El correlativo interno (sales.number) no cambia; solo cambia cómo se ve/busca.
-- =============================================================================
alter table pos_settings add column if not exists sale_prefix text not null default '';
alter table pos_settings add column if not exists sale_pad    int  not null default 0;
