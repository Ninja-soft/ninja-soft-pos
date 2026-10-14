-- =============================================================================
-- 20261121100000_nombre_fantasia (ADR-123)
--
-- Nombre de fantasía como dato de la MARCA del negocio (Configuración > Marca),
-- no sólo como opción del comprobante.
--
--   1. tenant_branding.trade_name (text, 1 a 120 caracteres o null). BASE: no
--      está entre las columnas que gatea personalizacion_marca (logo y color,
--      trg_assert_branding_feature): se edita en cualquier plan, como la razón
--      social. RLS de siempre (lectura miembros, escritura owner/manager).
--   2. Backfill: el nombre de fantasía que hoy vive en
--      invoice_style.trade_name (ADR-112) pasa a la columna y se quita del
--      jsonb (era el único lugar; dejarlo ahí lo volvería un override que tapa
--      lo que se edite en Marca). Sin pérdida: sólo se mueve si la columna
--      está vacía. El trigger de plan de invoice_style se apaga durante el
--      backfill (como en 20261116200000): quitar una clave no cambia el plan.
--   3. invoice_style.trade_name sigue existiendo como override SÓLO del
--      comprobante. Prioridad del encabezado comercial:
--        invoice_style.trade_name > trade_name (pisado por grupo o sucursal)
--        > tenants.name. La razón social sigue en los datos fiscales.
--   4. Herencia por sucursal (ADR-049): trade_name es campo de texto del
--      dominio "ticket" (config_field_type), como legal_name.
--   5. public_catalog y quote_public_get devuelven el nombre de fantasía.
-- =============================================================================

-- 1. Columna
alter table tenant_branding add column if not exists trade_name text;

alter table tenant_branding drop constraint if exists tenant_branding_trade_name_len;
alter table tenant_branding add constraint tenant_branding_trade_name_len
  check (trade_name is null or (char_length(btrim(trade_name)) between 1 and 120));

comment on column tenant_branding.trade_name is
  'ADR-123: nombre de fantasía del negocio (Configuración > Marca). Es el nombre que se muestra en toda la app y al cliente (fallback tenants.name). BASE: cualquier plan. invoice_style.trade_name lo pisa sólo en comprobantes.';

-- 2. Backfill desde invoice_style
alter table tenant_branding disable trigger tenant_branding_assert_invoice_style;

update tenant_branding
   set trade_name = left(regexp_replace(btrim(invoice_style ->> 'trade_name'), '\s+', ' ', 'g'), 120),
       invoice_style = invoice_style - 'trade_name'
 where trade_name is null
   and coalesce(btrim(invoice_style ->> 'trade_name'), '') <> '';

-- Claves vacías: limpieza (no son override de nada).
update tenant_branding
   set invoice_style = invoice_style - 'trade_name'
 where invoice_style ? 'trade_name'
   and coalesce(btrim(invoice_style ->> 'trade_name'), '') = '';

alter table tenant_branding enable trigger tenant_branding_assert_invoice_style;

-- 3. Herencia por grupo o sucursal (copia de 20261026100100 + trade_name).
create or replace function config_field_type(p_domain text, p_scope text, p_field text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_domain = 'payment_method' then
      case
        when p_field = 'enabled' then 'bool'
        -- Transferencia (ADR-055): la caja puede mostrar u omitir la pantalla.
        when p_field = 'transfer_show_screen' then 'bool'
        when p_scope = 'register' then null
        when p_field = 'surcharge_pct' then 'num'
        when p_field = 'plan_mode' then 'text'
        when p_field = 'merchant_numbers' then 'map_text'
        when p_field = 'sort' then 'num'
        when p_field = 'transfer_require_reference' then 'bool'
        when p_field = 'transfer_accounts' then 'map_any'
        when p_field = 'transfer_default_account' then 'text'
        else null
      end
    when p_domain = 'pos_settings' then
      case
        when p_field in ('blind_close', 'require_close_reason', 'allow_free_sale',
                         'display_show_unit_prices') then 'bool'
        when p_field = 'close_tolerance' then 'num'
        when p_field in ('display_welcome_message', 'display_thanks_message') then 'text'
        -- ADR-054: reglas del cupón, también por caja (el posnet es de la caja).
        when p_field in ('print_profiles', 'pos_layout', 'card_voucher_rules') then 'map_any'
        when p_scope = 'register' then null
        when p_field in ('allow_negative_stock', 'require_customer', 'require_card_voucher',
                         'offer_warranty', 'auto_email_receipt') then 'bool'
        when p_field = 'rounding_multiple' then 'num'
        when p_field in ('max_discount', 'max_free_sale') then 'map_num'
        -- ADR-063: balanza y cajón por negocio, grupo o sucursal.
        when p_field in ('scale_enabled', 'drawer_open_on_cash') then 'bool'
        when p_field = 'drawer_no_sale' then 'text'
        when p_field = 'scale_label' then 'map_any'
        else null
      end
    when p_domain = 'ticket' then
      case
        when p_scope = 'register' then null
        when p_field = 'use_store_contact' then 'bool'
        -- ADR-123: nombre de fantasía por grupo o sucursal.
        when p_field in ('trade_name', 'legal_name', 'cuit', 'phone', 'address', 'ticket_title',
                         'ticket_legend', 'ticket_footer') then 'text'
        else null
      end
    else null
  end;
$$;
grant execute on function config_field_type(text, text, text) to authenticated, service_role;

-- 4. Catálogo público (copia de 20260609100000 + trade_name en branding).
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
        -- ADR-123: nombre de fantasía (el catálogo lo usa como título).
        'trade_name', nullif(btrim(b.trade_name), ''),
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

-- 5. Presupuesto público (copia de 20261120100100 con el nombre de fantasía).
create or replace function quote_public_get(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q  quotes%rowtype;
  v_b  record;
  v_t  record;
begin
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 80 then
    return null;
  end if;
  select * into v_q from quotes where public_token = p_token and deleted_at is null;
  if not found then
    return null;
  end if;
  select b.legal_name, b.logo_url, b.accent, b.cuit, b.address, b.phone, b.iva_condition,
         b.trade_name, b.invoice_style ->> 'trade_name' as style_trade_name
    into v_b from tenant_branding b where b.tenant_id = v_q.tenant_id;
  select t.name into v_t from tenants t where t.id = v_q.tenant_id;
  return jsonb_build_object(
    'pto_vta', v_q.pto_vta,
    'number', v_q.number,
    'version', v_q.version,
    'status', quote_effective_status(v_q.status, v_q.valid_until),
    'issue_date', v_q.issue_date,
    'valid_until', v_q.valid_until,
    'customer_name', v_q.customer_name,
    'customer_doc', v_q.customer_doc,
    'customer_address', v_q.customer_address,
    'customer_iva', v_q.customer_iva,
    'terms', v_q.terms,
    'notes', v_q.notes,
    'service_from', v_q.service_from,
    'service_to', v_q.service_to,
    'subtotal', v_q.subtotal,
    'discount_total', v_q.discount_total,
    'total', v_q.total,
    'show_signature', v_q.show_signature,
    'accepted_at', v_q.accepted_at,
    'accepted_by_name', v_q.accepted_by_name,
    'rejected_at', v_q.rejected_at,
    'issuer', jsonb_build_object(
      'name', coalesce(nullif(btrim(v_b.legal_name), ''), v_t.name),
      -- ADR-123: override del comprobante > fantasía de la marca > nombre de la cuenta.
      'trade_name', coalesce(nullif(btrim(v_b.style_trade_name), ''), nullif(btrim(v_b.trade_name), ''), v_t.name),
      'logo_url', v_b.logo_url,
      'accent', v_b.accent,
      'cuit', v_b.cuit,
      'address', v_b.address,
      'phone', v_b.phone,
      'iva_condition', v_b.iva_condition),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', i.name, 'sku', i.sku, 'quantity', i.quantity, 'unit_price', i.unit_price,
               'discount', i.discount, 'subtotal', i.subtotal, 'is_service', i.is_service,
               'unit_label', i.unit_label, 'service_type_name', i.service_type_name,
               'variant_label', i.variant_label, 'line_detail', i.line_detail, 'line_note', i.line_note,
               'line_clarifications', i.line_clarifications) order by i.sort)
        from quote_items i where i.quote_id = v_q.id and i.deleted_at is null), '[]'::jsonb)
  );
end;
$$;
revoke all on function quote_public_get(text) from public;
grant execute on function quote_public_get(text) to anon, authenticated;
