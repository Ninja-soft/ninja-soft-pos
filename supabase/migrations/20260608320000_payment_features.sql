-- =============================================================================
-- 20260608320000_payment_features
-- Alinea la matriz de features de PLAN con el catálogo real de medios del POS
-- (tabla payment_providers). Hasta ahora el grupo 'pagos' solo tenía
-- efectivo / transferencia / modo / mobbex (+ mercado_pago en 'integraciones'),
-- pero el POS ofrece más proveedores. Esta migración agrega los que faltaban
-- como CHECKS de plan, los marca por plan según criterio comercial, y deja el
-- gating real (tenant_has_feature + trigger en payments) listo para cubrirlos.
--
-- Proveedores faltantes (payment_providers.key → feature key del plan, igual):
--   mercadopago_point  (Mercado Point — gateway presencial de MP)
--   payway             (Payway / Prisma — gateway de tarjetas)
--   getnet             (Getnet — gateway de tarjetas)
--   fiserv             (Fiserv / Posnet / Clover — gateway/posnet)
--   pagos360           (Pagos360 — links de pago / DEBIN)
--   nave               (Nave — Banco Galicia)
--
-- CRITERIO COMERCIAL (qué plan habilita qué):
--   • efectivo / transferencia: básicos (is_basic) → en TODOS los planes.
--   • Gateways comunes y de uso masivo → desde PRO (pro, business, enterprise):
--       mercadopago_point, payway, getnet, nave.
--     (alineado con mercado_pago, que ya viene desde Pro.)
--   • Gateways premium / especializados → desde BUSINESS (business, enterprise):
--       fiserv (posnet/Clover, perfil más empresarial),
--       pagos360 (links de pago / DEBIN, integración especializada).
--     (alineado con modo/mobbex, que ya vienen desde Business.)
--   • Start NO incluye ninguno de los nuevos (queda con efectivo + transferencia).
--
-- El feature key se elige IGUAL al payment_providers.key para que
-- payment_method_plan_key(provider) resuelva 1:1 sin tabla de traducción.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A) Alta de las features faltantes (grupo 'pagos', no básicas).
--    sort: continúa la serie de 'pagos' (efectivo 10, transferencia 20,
--    modo 30, mobbex 40) respetando el orden de payment_providers.sort.
-- ---------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('mercadopago_point', 'Mercado Point',            'Cobros presenciales con Mercado Point', 'pagos', false, 50),
  ('payway',            'Payway / Prisma',          'Cobros con Payway (Prisma)',            'pagos', false, 60),
  ('getnet',            'Getnet',                   'Cobros con Getnet',                     'pagos', false, 70),
  ('fiserv',            'Fiserv / Posnet / Clover', 'Cobros con Fiserv (Posnet / Clover)',   'pagos', false, 80),
  ('pagos360',          'Pagos360',                 'Cobros con Pagos360 (links / DEBIN)',   'pagos', false, 90),
  ('nave',              'Nave',                     'Cobros con Nave (Banco Galicia)',       'pagos', false, 100)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- B) Marcado por plan en plans.limits->modules (solo planes GLOBALES:
--    tenant_id is null). Idempotente: setea el booleano explícito por clave.
--    jsonb_set sobre limits->'modules'; si 'modules' no existiera, se inicializa.
-- ---------------------------------------------------------------------------

-- Asegura que limits->'modules' exista como objeto en todos los planes globales
-- (defensivo; en la práctica ya existe para los 4 planes base).
update plans
set limits = jsonb_set(
  coalesce(limits, '{}'::jsonb),
  '{modules}',
  coalesce(limits -> 'modules', '{}'::jsonb),
  true
)
where tenant_id is null
  and (limits -> 'modules') is null;

-- Helper inline vía CTE: arma el set de features comunes (Pro+) y premium
-- (Business+), y aplica el booleano correspondiente a cada plan global según su
-- `key`. Se hace por plan para mantener el criterio comercial explícito.

-- Gateways COMUNES → true desde Pro (pro, business, enterprise); false en start.
update plans p
set limits = (
  select jsonb_set(
    p.limits,
    '{modules}',
    (p.limits -> 'modules')
      || jsonb_build_object(
           'mercadopago_point', (p.key in ('pro','business','enterprise')),
           'payway',            (p.key in ('pro','business','enterprise')),
           'getnet',            (p.key in ('pro','business','enterprise')),
           'nave',              (p.key in ('pro','business','enterprise'))
         ),
    true
  )
)
where p.tenant_id is null
  and p.key in ('start','pro','business','enterprise');

-- Gateways PREMIUM → true desde Business (business, enterprise); false en start/pro.
update plans p
set limits = (
  select jsonb_set(
    p.limits,
    '{modules}',
    (p.limits -> 'modules')
      || jsonb_build_object(
           'fiserv',   (p.key in ('business','enterprise')),
           'pagos360', (p.key in ('business','enterprise'))
         ),
    true
  )
)
where p.tenant_id is null
  and p.key in ('start','pro','business','enterprise');

-- ---------------------------------------------------------------------------
-- C) Gating real: payment_method_plan_key(method) debe resolver los nuevos
--    proveedores a su feature de plan. Hasta ahora caían en `else null`
--    (= sin gating). Se extiende el CASE para incluirlos. El trigger en
--    `payments` (20260608210000) ya valida el proveedor del intent QR y el
--    method coarse contra esta función, así que con extenderla el bloqueo
--    queda cubierto end-to-end (UI + backend).
--
--    Nota: se mantiene IMMUTABLE/security y los mismos grants que la versión
--    previa. Se castea el feature key IGUAL al provider key (1:1).
-- ---------------------------------------------------------------------------
create or replace function payment_method_plan_key(p_method text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_method, ''))
    -- Medios básicos (is_basic=true): el gate los deja pasar en todo plan, pero
    -- se mapean explícitamente para que un plan que los apague (futuro) corte.
    when 'cash'              then 'efectivo'
    when 'efectivo'          then 'efectivo'
    when 'transfer'          then 'transferencia'
    when 'transferencia'     then 'transferencia'
    -- Pasarelas con feature de plan.
    when 'mercadopago'       then 'mercado_pago'
    when 'mp'                then 'mercado_pago'
    when 'mercado_pago'      then 'mercado_pago'
    -- mercadopago_point ahora tiene SU PROPIA feature (no comparte mercado_pago):
    -- así un plan puede habilitar MP online sin habilitar el Point presencial.
    when 'mercadopago_point' then 'mercadopago_point'
    when 'modo'              then 'modo'
    when 'mobbex'            then 'mobbex'
    -- Nuevos gateways gateados por plan (alineados al catálogo payment_providers).
    when 'payway'            then 'payway'
    when 'getnet'            then 'getnet'
    when 'fiserv'            then 'fiserv'
    when 'pagos360'          then 'pagos360'
    when 'nave'              then 'nave'
    -- Sin gating de plan: medios operativos internos y proveedores no integrados.
    -- (debit/credit/qr-genérico/store_credit/account/other/…)
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;
