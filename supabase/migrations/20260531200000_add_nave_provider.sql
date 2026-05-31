-- =============================================================================
-- 20260531200000_add_nave_provider
-- Agrega "Nave" (billetera/cobros de Banco Galicia) al catálogo de proveedores
-- de pago. Aún sin integración: se muestra como "Próximamente" en el POS.
-- =============================================================================
insert into payment_providers (key, name, kind, sort) values
  ('nave', 'Nave (Banco Galicia)', 'gateway', 10)
on conflict (key) do nothing;
