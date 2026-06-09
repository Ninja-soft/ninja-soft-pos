-- =============================================================================
-- 20260609100000_feature_gating_fixes
-- -----------------------------------------------------------------------------
-- Auditoría de gating (continuación de 20260608410000_writefeature_gating):
-- varias features "decorativas" se mostraban/escondían SOLO en la UI; el backend
-- no validaba `tenant_has_feature_for`, así que sorteando la UI (devtools, RLS
-- directo a la tabla, o llamando la RPC) se usaban sin el plan. Esta migración
-- cierra el agujero en el BACKEND, imposible de saltear, espejando el patrón ya
-- vivo `price_lists_assert_feature` (trigger BEFORE INS/UPD que hace
-- `if not tenant_has_feature_for(new.tenant_id, '<key>') then raise`).
--
-- Cubre cuatro fixes:
--   1) panel_dueno y devoluciones → BASE (is_basic=true). El panel del dueño es
--      donde se gestiona el plan que YA se paga: debe estar siempre activo.
--      Devolver una venta es operación núcleo. Quedan ON para todos los planes.
--   2) Enforcement server-side de features de ESCRITURA decorativas, vía trigger:
--        ticket_templates   → tickets_pro
--        customer_groups    → grupos_clientes
--        tenant_branding    → personalizacion_marca
--        product_variants   → variantes
--      Todas tienen columna tenant_id; el gate se resuelve por NEW.tenant_id
--      (no por el JWT) para cubrir también escrituras service_role.
--   3) public_catalog(slug) gateado por catalogo_publico: si el tenant del slug
--      no tiene la feature, el RPC devuelve null (storefront no disponible).
--   4) tenant_payment_methods: trigger que, al HABILITAR un proveedor, exige su
--      feature (payment_method_plan_key(provider_key)). Efectivo/transferencia
--      (básicos) y mercado_pago (incluido en todos los planes) pasan; los
--      gateways de tarjeta sin feature, no. NO bloquea deshabilitar ni edits de
--      filas ya habilitadas (gate solo en la TRANSICIÓN a enabled).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) panel_dueno y devoluciones → BASE (siempre activos para todos los planes).
--    is_basic=true es el último escalón de tenant_has_feature_for: sin flag,
--    addon ni declaración por plan, devuelve is_basic. Quedan ON para todos.
-- -----------------------------------------------------------------------------
update features set is_basic = true where key in ('panel_dueno', 'devoluciones');

-- Defensa por si el seed no las tuviera (idempotente; respeta el esquema real
-- de features: key/label/description/grupo/is_basic/sort).
insert into features (key, label, is_basic)
select v.key, v.label, true
from (values
  ('panel_dueno',  'Panel del dueño'),
  ('devoluciones', 'Devoluciones')
) as v(key, label)
on conflict (key) do update set is_basic = true;

-- -----------------------------------------------------------------------------
-- 2) Enforcement server-side de features decorativas de ESCRITURA.
--    Un trigger genérico parametrizado por TG_ARGV[0] = feature key. Cada tabla
--    tiene NEW.tenant_id; se gatea por tenant (cubre service_role). SECURITY
--    DEFINER + search_path fijo (sin search_path mutable).
-- -----------------------------------------------------------------------------
create or replace function trg_assert_tenant_feature()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not tenant_has_feature_for(new.tenant_id, tg_argv[0]) then
    raise exception 'feature_not_in_plan: %', tg_argv[0]
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_assert_tenant_feature() from public, anon;

-- ticket_templates → tickets_pro (personalización de tickets)
drop trigger if exists ticket_templates_assert_feature on ticket_templates;
create trigger ticket_templates_assert_feature
  before insert or update on ticket_templates
  for each row execute function trg_assert_tenant_feature('tickets_pro');

-- customer_groups → grupos_clientes
drop trigger if exists customer_groups_assert_feature on customer_groups;
create trigger customer_groups_assert_feature
  before insert or update on customer_groups
  for each row execute function trg_assert_tenant_feature('grupos_clientes');

-- tenant_branding → personalizacion_marca (PK = tenant_id)
drop trigger if exists tenant_branding_assert_feature on tenant_branding;
create trigger tenant_branding_assert_feature
  before insert or update on tenant_branding
  for each row execute function trg_assert_tenant_feature('personalizacion_marca');

-- product_variants → variantes
drop trigger if exists product_variants_assert_feature on product_variants;
create trigger product_variants_assert_feature
  before insert or update on product_variants
  for each row execute function trg_assert_tenant_feature('variantes');

-- -----------------------------------------------------------------------------
-- 3) public_catalog(slug) gateado por catalogo_publico.
--    Recreado desde su def VIVA + el gate. Se preserva TODO lo demás (branding,
--    precios por lista 'catalogo', etc). El gate se aplica en la subquery que
--    resuelve el tenant del slug: si no tiene la feature, tt no devuelve fila →
--    tt.id is null → el RPC devuelve null (storefront no disponible). Un plan
--    sin catalogo_publico NO publica catálogo aunque el slug exista.
-- -----------------------------------------------------------------------------
create or replace function public.public_catalog(p_slug text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select case when tt.id is null then null else jsonb_build_object(
    'tenant', jsonb_build_object('name', tt.name, 'slug', tt.slug),
    'branding', (
      select jsonb_build_object(
        'logo_url', b.logo_url, 'accent', b.accent, 'legal_name', b.legal_name,
        'phone', b.phone, 'address', b.address
      ) from tenant_branding b where b.tenant_id = tt.id
    ),
    'products', coalesce((
      select jsonb_agg(s.x order by s.name) from (
        select p.name,
          jsonb_build_object(
            'id', p.id, 'name', p.name,
            -- Precio resuelto por la lista 'catalogo' activa (item por producto →
            -- ajuste % → base). Sin lista activa → precio base.
            'price', coalesce(
              pli.price,
              case when pl.adjustment_pct is not null
                then round(p.price * (1 + pl.adjustment_pct / 100), 2)
                else p.price end
            ),
            'image_url', p.image_url, 'category', c.name
          ) as x
        from products p
        left join categories c on c.id = p.category_id
        left join lateral (
          select id, adjustment_pct from price_lists
          where tenant_id = tt.id and channel = 'catalogo'
            and is_active and deleted_at is null
          limit 1
        ) pl on true
        left join price_list_items pli
          on pli.price_list_id = pl.id
         and pli.product_id = p.id
         and pli.variant_id is null
        where p.tenant_id = tt.id and p.is_active and p.deleted_at is null
      ) s
    ), '[]'::jsonb)
  ) end
  from (
    select id, name, slug from tenants
    where slug = p_slug and deleted_at is null and status in ('trial','active')
      -- Gate de plan: sin catalogo_publico no se publica el storefront.
      and tenant_has_feature_for(id, 'catalogo_publico')
    limit 1
  ) tt;
$function$;

-- -----------------------------------------------------------------------------
-- 4) tenant_payment_methods — gating de origen de los gateways de tarjeta.
--    Hoy un tenant puede HABILITAR (enabled=true) un proveedor sin su feature, y
--    al cobrar entra como débito/crédito (no gateado). El cierre real va aquí:
--    al habilitar un proveedor se exige su feature, mapeada con la MISMA función
--    canónica que usa el cobro (payment_method_plan_key(provider_key)).
--      • cash → 'efectivo', transfer → 'transferencia' (is_basic=true): siempre ok.
--      • mercadopago → 'mercado_pago' (declarado en todos los planes): siempre ok.
--      • mercadopago_point/modo/mobbex/payway/getnet/fiserv/pagos360/nave → su
--        propia feature (is_basic=false): exige el plan.
--    Se gatea SOLO en la transición a enabled (INSERT con enabled=true, o UPDATE
--    de false→true). NO bloquea deshabilitar ni edits de filas ya habilitadas
--    (surcharge, sandbox, sort, config) para no romper datos legados.
--    Si provider_key no mapea a ninguna feature (payment_method_plan_key=null),
--    no se gatea (no hay feature que exigir).
-- -----------------------------------------------------------------------------
create or replace function trg_assert_payment_method_feature()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_feature text;
begin
  -- Solo en la transición a habilitado.
  if new.enabled is not true then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.enabled is true then
    return new;
  end if;

  v_feature := payment_method_plan_key(new.provider_key);
  if v_feature is not null
     and not tenant_has_feature_for(new.tenant_id, v_feature) then
    raise exception 'feature_not_in_plan: %', new.provider_key
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_assert_payment_method_feature() from public, anon;

drop trigger if exists tenant_payment_methods_assert_feature on tenant_payment_methods;
create trigger tenant_payment_methods_assert_feature
  before insert or update on tenant_payment_methods
  for each row execute function trg_assert_payment_method_feature();
