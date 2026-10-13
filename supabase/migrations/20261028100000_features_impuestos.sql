-- =============================================================================
-- 20261028100000_features_impuestos  (F18 · H103-H106, ADR-068)
--
-- Features de plan (convención CLAUDE.md §6) de la base fiscal:
--
--   • `impuestos_iva` · BASE (is_basic=true, grupo ventas). Catálogo cerrado
--     de alícuotas de IVA (21, 10,5, 27, 5, 2,5, 0, exento y no gravado) por
--     producto y variante, listas con o sin IVA, condición fiscal del negocio
--     y del cliente con documento validado, desglose de IVA en cada venta,
--     tipo de comprobante inferido y reporte de IVA ventas. Cualquier negocio
--     que vende lo necesita para facturar bien: es parte de pagar cualquier
--     plan.
--   • `impuestos_internos` · OPTIONAL desde Pro (grupo ventas). Impuestos
--     internos por producto (monto fijo, % sobre precio con tasa nominal o %
--     sobre costo; incluido en el precio o adicional) discriminados en la
--     venta. Lo usan rubros puntuales (bebidas, tabaco, electrónica).
--   • `percepciones_retenciones` · OPTIONAL desde Business (grupo ventas). El
--     negocio como agente: regímenes de percepción de IVA e IIBB por
--     jurisdicción (ARBA, AGIP y genéricos), padrones importados con
--     alícuota por CUIT y vigencia, exclusiones, mínimos, percepciones en la
--     venta como líneas aparte y retenciones sugeridas en las órdenes de pago.
--     Es para negocios designados agentes (grandes contribuyentes y medianos).
--
-- Gating real (migraciones siguientes): tax_settings_save exige
-- `impuestos_iva`; el trigger de products rechaza internos sin
-- `impuestos_internos`; tax_regimes, tax_exemptions y los padrones exigen
-- `percepciones_retenciones` en la policy y en las RPC, y _sale_tax_compute
-- sólo percibe y calcula internos con la feature activa.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('impuestos_iva', 'IVA por alícuota y condición fiscal',
   'Alícuotas de IVA por producto (21, 10,5, 27, 5, 2,5, 0, exento y no gravado), listas con o sin IVA, condición fiscal del negocio y del cliente, desglose de IVA en cada venta y reporte de IVA ventas',
   'ventas', true, 46),
  ('impuestos_internos', 'Impuestos internos',
   'Impuestos internos por producto (monto fijo, % sobre precio o sobre costo, incluido o adicional) discriminados en la venta',
   'ventas', false, 47),
  ('percepciones_retenciones', 'Percepciones y retenciones',
   'Agente de percepción de IVA e IIBB (ARBA, AGIP y otras jurisdicciones) con padrones por CUIT, mínimos y exclusiones; retenciones sugeridas en las órdenes de pago',
   'ventas', false, 48)
on conflict (key) do nothing;

-- Planes globales. BASE: en todos. Internos: Pro y superiores. Percepciones y
-- retenciones: Business y Enterprise.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('impuestos_iva', true), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'impuestos_iva');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('impuestos_internos', (p.key in ('pro', 'business', 'enterprise'))), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'impuestos_internos');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('percepciones_retenciones', (p.key in ('business', 'enterprise'))), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'percepciones_retenciones');

-- Planes a medida: no se tocan. La BASE entra por defecto (is_basic); las
-- opcionales se activan desde el editor de planes o como add-on.
