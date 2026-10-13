-- =============================================================================
-- 20261030100000_features_reintegro_mp_cliente_360  (ADR-067)
--
-- Dos features de plan nuevas (convención CLAUDE.md §6):
--
--  1) `reintegro_mp` · OPTIONAL, grupo pagos, desde Pro (va con Mercado Pago).
--     Qué habilita: en una devolución, reintegrar el dinero por Mercado Pago
--     (total o parcial, hasta lo cobrado por ese pago menos lo ya reintegrado)
--     con la API de reembolsos, además de efectivo o vale.
--     Gating real: return_sale_v2 (pata Mercado Pago) y la Edge `mp_refund`
--     exigen tenant_has_feature_for(tenant, 'reintegro_mp') (migración
--     siguiente). Además el dueño lo prende en Medios de pago, Mercado Pago
--     (apagado por defecto).
--     Análisis comercial: es parte del cobro con Mercado Pago (Pro en
--     adelante): quien cobra con MP espera poder devolver por MP. Los planes a
--     medida heredan el valor de `mercado_pago`.
--
--  2) `clientes_360` · OPTIONAL, grupo clientes, desde Pro.
--     Qué habilita: la ficha 360 del cliente en página propia (indicadores,
--     línea de tiempo unificada con filtros y paginación, productos y medios
--     preferidos, gráficos, segmentos, notas internas y exportación XLSX).
--     El historial básico (CustomerHistoryModal: vale, compras y
--     devoluciones) sigue siendo BASE con `clientes`.
--     Gating real: customer_360_summary, customer_360_timeline y
--     customer_note_add exigen tenant_has_feature_for(tenant, 'clientes_360')
--     (migración 20261030100200).
--     Análisis comercial: es análisis de cartera (CRM liviano); va con el
--     resto de la gestión de clientes avanzada de Pro (grupos de clientes,
--     listas de precios). Los planes a medida heredan `grupos_clientes`.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('reintegro_mp', 'Reintegro por Mercado Pago',
   'En una devolución, reintegrar el dinero por Mercado Pago (total o parcial) a la tarjeta o cuenta con la que pagó el cliente',
   'pagos', false, 24),
  ('clientes_360', 'Ficha del cliente 360',
   'Ficha completa del cliente: indicadores, línea de tiempo unificada, productos y medios preferidos, gráficos, segmentos, notas y exportación',
   'clientes', false, 125)
on conflict (key) do nothing;

-- Planes globales: Pro, Business y Enterprise.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('reintegro_mp', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'reintegro_mp');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('clientes_360', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'clientes_360');

-- Planes a medida (por tenant): heredan el nivel comercial equivalente.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('reintegro_mp', coalesce((p.limits -> 'modules' ->> 'mercado_pago')::boolean, false)),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'reintegro_mp');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('clientes_360', coalesce((p.limits -> 'modules' ->> 'grupos_clientes')::boolean, false)),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'clientes_360');
