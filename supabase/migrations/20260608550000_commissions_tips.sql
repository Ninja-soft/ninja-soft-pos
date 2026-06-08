-- =============================================================================
-- 20260608550000_commissions_tips  (F12 · H39)
-- Comisiones por profesional, propinas y reporte de productividad del staff.
--
-- Construye sobre H38 (migración `agenda`): tablas `professionals`
-- (commission_pct, user_id) y `appointments` (sale_id, professional_id,
-- service_price, commission_pct), y columnas products.commission_pct /
-- products.service_duration_min.
--
-- Modelo de datos:
--   * sales.tip_amount / sales.tip_method: la PROPINA. Va aparte del total de
--     productos (NO se suma a sales.total). Se cobra junto a la venta (entra
--     como payment + cash_movement de tipo 'tip' para que la caja cuadre) pero
--     el subtotal/total de la venta siguen siendo sólo productos.
--   * sales.professional_id: vendedor/profesional atribuido a la venta directa.
--     Nullable: sin profesional → sin comisión por la venta. Las ventas que
--     vienen de un turno (appointments.sale_id) toman el profesional del turno.
--
-- Regla de comisión (por línea de venta):
--   comisión_línea = coalesce(products.commission_pct,
--                             professional.commission_pct, 0) / 100 * subtotal
--   donde subtotal = sale_items.subtotal (importe de la línea, ya con su
--   descuento). El % efectivo es el del PRODUCTO si lo define; si no, el del
--   PROFESIONAL atribuido; si ninguno, 0. El profesional de una venta es el de
--   su turno (si vino de la agenda) o sales.professional_id (venta directa).
--   Los ítems libres (product_id null: garantías, recargos, ventas rápidas) no
--   tienen commission_pct de producto → caen al % del profesional (o 0).
--
-- Permiso:
--   * pos_settings.staff_sees_own_only (bool, default false): si está activo, un
--     usuario que NO es owner ve sólo su propia agenda/ventas/comisión. El match
--     usuario↔profesional es professionals.user_id = auth.uid(). El owner ve
--     todo. Aplica en staff_productivity (este archivo) y en la lectura de la
--     agenda (RLS de appointments, abajo).
--
-- create_sale: se extiende para leer la propina y el profesional desde p_extras
--   (mismo mecanismo que la garantía H28), sin cambiar la firma de la función.
--   p_extras puede incluir:
--     { "kind": "tip", "amount": 500, "method": "cash" }   -- una sola propina
--     { "kind": "professional", "id": "<uuid>" }            -- atribución
-- =============================================================================

-- 1) Columnas nuevas -----------------------------------------------------------

alter table sales
  add column if not exists tip_amount numeric not null default 0
    check (tip_amount >= 0),
  add column if not exists tip_method text
    check (tip_method is null or tip_method in ('cash','debit','credit','transfer','qr','other')),
  add column if not exists professional_id uuid references professionals(id);

-- Índice para el reporte por profesional y para el join venta→profesional.
create index if not exists sales_professional_idx
  on sales (professional_id) where professional_id is not null;

alter table pos_settings
  add column if not exists staff_sees_own_only boolean not null default false;

-- 2) create_sale: propina + atribución de profesional desde p_extras ----------
--    Reescribe la función conservando TODA su lógica (stock, gating, pagos) y
--    sumando: validación del profesional, persistencia de sales.professional_id,
--    y la propina en sales.tip_amount / sales.tip_method (no toca el total de la
--    venta; ver nota al pie sobre por qué la propina no va a payments/caja).

create or replace function public.create_sale(
  p_items jsonb,
  p_payments jsonb,
  p_discount_total numeric default 0,
  p_customer_id uuid default null,
  p_notes text default null,
  p_extras jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_subtotal numeric := 0;
  v_total    numeric;
  v_total_pre numeric;
  v_paid     numeric := 0;
  v_sale_id  uuid;
  v_item     record;
  v_pay      record;
  v_comp     record;
  v_pname    text;
  v_psku     text;
  v_is_kit   boolean;
  v_track    boolean;
  v_has_variants boolean;
  v_variant  record;
  v_serial   text;
  v_role     text;
  v_max_disc numeric := 100;
  v_round    numeric := 0;
  v_allow_neg boolean := true;
  v_disc_pct numeric;
  v_pallow   boolean;
  v_stock    numeric;
  v_sc_total numeric := 0;
  v_sc_bal   numeric;
  v_pay_feat text;
  v_line_disc numeric := 0;
  v_warranty_prima numeric := 0;
  -- H39: propina + profesional atribuido (leídos de p_extras).
  v_tip_amount numeric := 0;
  v_tip_method text;
  v_professional uuid;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'invalid_discount';
  end if;

  select id into v_store
  from stores
  where tenant_id = v_tenant and deleted_at is null
  order by is_default desc, created_at
  limit 1;
  if v_store is null then
    raise exception 'no_store';
  end if;

  select cs.id into v_shift
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
  order by cs.opened_at desc
  limit 1;
  if v_shift is null then
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;

  select coalesce((ps.max_discount ->> coalesce(v_role, 'cashier'))::numeric, 100),
         coalesce(ps.rounding_multiple, 0),
         coalesce(ps.allow_negative_stock, true)
    into v_max_disc, v_round, v_allow_neg
  from pos_settings ps
  where ps.tenant_id = v_tenant;
  if not found then
    v_max_disc := 100; v_round := 0; v_allow_neg := true;
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_price numeric, discount numeric)
  loop
    v_subtotal := v_subtotal
      + (coalesce(v_item.unit_price, 0) * coalesce(v_item.quantity, 0))
      - coalesce(v_item.discount, 0);
    v_line_disc := v_line_disc + coalesce(v_item.discount, 0);
  end loop;

  if v_subtotal <= 0 then
    raise exception 'empty_sale';
  end if;

  if (coalesce(p_discount_total, 0) > 0 or v_line_disc > 0)
     and not tenant_has_feature('descuentos') then
    raise exception 'feature_not_in_plan: descuentos';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'warranty'
                           then coalesce(e.amount, 0) else 0 end), 0)
    into v_warranty_prima
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric);
  if v_warranty_prima > 0 and not tenant_has_feature('garantias') then
    raise exception 'feature_not_in_plan: garantias';
  end if;

  -- H39: propina (kind='tip'). Se suma por si llegara más de una; el medio es el
  -- de la última fila 'tip' con método (normalmente hay una sola).
  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'tip'
                           then coalesce(e.amount, 0) else 0 end), 0),
         max(case when lower(coalesce(e.kind,'')) = 'tip' then e.method end)
    into v_tip_amount, v_tip_method
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric, method text);
  if v_tip_amount < 0 then
    raise exception 'invalid_tip';
  end if;
  if v_tip_amount > 0 and v_tip_method is null then
    v_tip_method := 'cash';
  end if;

  -- H39: profesional atribuido (kind='professional', id). Debe existir, ser del
  -- tenant y estar activo; si no, se ignora silenciosamente (sin comisión).
  select (e.id)::uuid into v_professional
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, id text)
  where lower(coalesce(e.kind,'')) = 'professional'
    and e.id is not null
  limit 1;
  if v_professional is not null then
    if not exists (
      select 1 from professionals
      where id = v_professional and tenant_id = v_tenant
        and deleted_at is null and is_active
    ) then
      v_professional := null;
    end if;
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
         as p(method text, amount numeric)
       where p.method = 'account' and coalesce(p.amount, 0) > 0
     )
     and not tenant_has_feature('cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;

  if coalesce(p_discount_total, 0) > 0 and v_subtotal > 0 then
    v_disc_pct := coalesce(p_discount_total, 0) / v_subtotal * 100;
    if v_disc_pct > v_max_disc + 0.001 then
      raise exception 'discount_exceeds_limit';
    end if;
  end if;

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0);

  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
  end if;

  -- Pagos: el monto recibido debe cubrir el total de PRODUCTOS + la propina (la
  -- propina se cobra junto a la venta). v_total se mantiene como total de la
  -- venta (productos); la propina viaja aparte.
  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
    if v_pay.method = 'store_credit' then
      v_sc_total := v_sc_total + coalesce(v_pay.amount, 0);
    end if;
  end loop;
  if v_paid < v_total + v_tip_amount then
    raise exception 'insufficient_payment';
  end if;
  if v_sc_total > v_total + 0.001 then
    raise exception 'store_credit_exceeds_total';
  end if;

  if v_sc_total > 0 then
    if p_customer_id is null then
      raise exception 'store_credit_needs_customer';
    end if;
    select coalesce(sum(delta), 0) into v_sc_bal
    from store_credit_movements
    where tenant_id = v_tenant and customer_id = p_customer_id;
    if v_sc_bal < v_sc_total - 0.001 then
      raise exception 'insufficient_store_credit';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes,
                     professional_id, tip_amount, tip_method)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end)
  returning id into v_sale_id;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, variant_id uuid, name text, serial text, modifiers jsonb,
           quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock, p.has_variants
        into v_pname, v_psku, v_is_kit, v_track, v_has_variants
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;

      if coalesce(v_has_variants, false) then
        if v_item.variant_id is null then
          raise exception 'variant_required';
        end if;
        select * into v_variant from product_variants
         where id = v_item.variant_id and product_id = v_item.product_id
           and tenant_id = v_tenant and deleted_at is null;
        if not found then
          raise exception 'variant_not_found';
        end if;
        v_pname := v_pname || ' — ' || v_variant.option1
                   || coalesce(' / ' || v_variant.option2, '');
      elsif v_item.variant_id is not null then
        raise exception 'variant_not_allowed';
      end if;
    else
      v_pname  := coalesce(nullif(btrim(v_item.name), ''), 'Venta rápida');
      v_psku   := null;
      v_is_kit := false;
      v_track  := false;
      v_has_variants := false;
    end if;

    v_serial := nullif(btrim(coalesce(v_item.serial, '')), '');

    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers)
    values (v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb));

    if v_item.product_id is not null then
      if v_is_kit then
        for v_comp in
          select pkc.component_product_id, pkc.quantity,
                 pr.stock as comp_stock, pr.allow_negative as comp_allow, pr.track_stock as comp_track
          from product_kit_components pkc
          join products pr on pr.id = pkc.component_product_id and pr.tenant_id = v_tenant
          where pkc.kit_product_id = v_item.product_id and pkc.tenant_id = v_tenant
        loop
          if v_comp.comp_track then
            if not coalesce(v_comp.comp_allow, v_allow_neg)
               and v_comp.comp_stock < (v_item.quantity * v_comp.quantity) then
              raise exception 'insufficient_stock';
            end if;
            update products
               set stock = stock - (v_item.quantity * v_comp.quantity), updated_at = now()
             where id = v_comp.component_product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_comp.component_product_id, v_store,
                    -(v_item.quantity * v_comp.quantity), 'sale', v_sale_id);
          end if;
        end loop;
      else
        if v_track then
          if coalesce(v_has_variants, false) then
            select pr.allow_negative into v_pallow from products pr
             where pr.id = v_item.product_id and pr.tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_variant.stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;

            update product_variants
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_variant.id and tenant_id = v_tenant;

            insert into stock_movements (product_id, variant_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_variant.id, v_store, -v_item.quantity, 'sale', v_sale_id);
          else
            select stock, allow_negative into v_stock, v_pallow
            from products where id = v_item.product_id and tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;

            update products
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_item.product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
          end if;
        end if;

        if v_serial is not null then
          update product_serials
             set status = 'sold', sale_id = v_sale_id
           where product_id = v_item.product_id and tenant_id = v_tenant
             and serial = v_serial and status = 'in_stock';
          if not found then
            insert into product_serials (product_id, serial, status, sale_id)
            values (v_item.product_id, v_serial, 'sold', v_sale_id)
            on conflict (product_id, serial) do update
              set status = 'sold', sale_id = v_sale_id;
          end if;
        end if;
      end if;
    end if;
  end loop;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text, card_voucher jsonb)
  loop
    if v_pay.method = 'qr' then
      v_pay_feat := null;
      if v_pay.reference is not null
         and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
        select case pi.provider_key
                 when 'mercadopago' then 'mercado_pago'
                 when 'mobbex'      then 'mobbex'
                 when 'modo'        then 'modo'
                 else null
               end
          into v_pay_feat
        from mp_payment_intents pi
        where pi.id = v_pay.reference::uuid
          and pi.tenant_id = v_tenant
        limit 1;
      end if;
      if v_pay_feat is not null and not tenant_has_feature(v_pay_feat) then
        raise exception 'method_not_in_plan';
      end if;
    end if;

    insert into payments (sale_id, method, amount, reference, card_voucher)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference,
            coalesce(v_pay.card_voucher, '{}'::jsonb));

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (customer_id, delta, reason)
      values (p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  -- H39: la propina queda trazada SÓLO en sales.tip_amount / sales.tip_method.
  -- Decisión: la propina es dinero de paso para el staff, NO ingreso del
  -- negocio. Por eso NO se inserta en `payments` (que es lo que pagó los
  -- productos → mantiene sales_report.by_method limpio) ni en `cash_movements`
  -- (que alimenta el efectivo esperado del arqueo Z → no se infla el esperado
  -- con propinas; el dueño liquida la propina aparte del efectivo físico). El
  -- importe igual entró en `p_payments` (se validó v_paid >= total + propina),
  -- así que el cajero recibió el dinero; la traza de a quién va es tip_amount +
  -- el profesional de la venta, que el reporte de productividad agrega.
  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount);
end;
$function$;

-- create_sale corre como el usuario (NO security definer); RLS aplica. Mantener
-- el grant existente (authenticated) y revocar de public/anon por defensa.
revoke all on function public.create_sale(jsonb,jsonb,numeric,uuid,text,jsonb) from public, anon;
grant execute on function public.create_sale(jsonb,jsonb,numeric,uuid,text,jsonb) to authenticated;

-- 3) RLS de la agenda: lectura sólo-propia para el staff (H39) ----------------
--    Si pos_settings.staff_sees_own_only está activo y el usuario NO es owner,
--    sólo puede LEER (select) los turnos de SU profesional (professionals.user_id
--    = auth.uid()). Escritura/edición/borrado siguen con la policy de tenant
--    existente (appointments_tenant_isolation, ALL). El owner ve todo siempre.
--    La policy nueva es RESTRICTIVE sobre SELECT: se combina (AND) con la
--    permissive de tenant, así que sólo restringe, nunca amplía el aislamiento.

drop policy if exists appointments_staff_own_select on appointments;
create policy appointments_staff_own_select
  on appointments
  as restrictive
  for select
  to authenticated
  using (
    -- Pasa si el negocio NO restringe, o si el usuario es owner, o si el turno
    -- es de su profesional (o aún sin profesional asignado).
    not coalesce(
      (select ps.staff_sees_own_only from pos_settings ps
        where ps.tenant_id = current_tenant_id()), false)
    or exists (
      select 1 from tenant_users tu
      where tu.tenant_id = current_tenant_id()
        and tu.user_id = auth.uid() and tu.status = 'active'
        and tu.role = 'owner')
    or professional_id is null
    or exists (
      select 1 from professionals pr
      where pr.id = appointments.professional_id
        and pr.tenant_id = current_tenant_id()
        and pr.user_id = auth.uid())
  );

-- 4) staff_productivity: reporte de productividad por profesional (H39) --------
--    SECURITY DEFINER, tenant-scoped. Agrega por profesional en el período:
--    servicios (turnos realizados), # productos vendidos, total facturado,
--    comisión calculada (regla: producto > profesional > 0), propinas y ticket
--    promedio. Respeta pos_settings.staff_sees_own_only: si está activo y el
--    usuario no es owner, sólo devuelve su propia fila.
--
--    Atribución del profesional de una venta:
--      - venta vinculada a un turno (appointments.sale_id) → profesional del turno
--      - venta directa con sales.professional_id → ese profesional
--      - si ambas, gana el turno (la venta nació de la agenda).
--    Comisión por línea = coalesce(products.commission_pct,
--      professional.commission_pct, 0)/100 * sale_items.subtotal.
--    Propina: sales.tip_amount, atribuida al profesional de la venta.

create or replace function public.staff_productivity(
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_own_only boolean;
  v_is_owner boolean;
  v_my_prof  uuid;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'forbidden';
  end if;

  select coalesce(staff_sees_own_only, false) into v_own_only
  from pos_settings where tenant_id = v_tenant;

  select exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = auth.uid()
       and status = 'active' and role = 'owner'
  ) into v_is_owner;

  -- Profesional del usuario actual (para el filtro sólo-propio).
  select id into v_my_prof
  from professionals
  where tenant_id = v_tenant and user_id = auth.uid() and deleted_at is null
  limit 1;

  return (
    with
    -- Ventas completadas del período, con el profesional atribuido (turno gana
    -- sobre venta directa).
    sales_scope as (
      select s.id,
             s.total,
             coalesce(s.tip_amount, 0) as tip_amount,
             coalesce(ap.professional_id, s.professional_id) as professional_id
      from sales s
      left join appointments ap
        on ap.sale_id = s.id and ap.tenant_id = v_tenant
      where s.tenant_id = v_tenant
        and s.status = 'completed'
        and s.created_at >= p_from
        and s.created_at < p_to
    ),
    scoped as (
      select * from sales_scope
      where professional_id is not null
        and (
          not v_own_only or v_is_owner
          or professional_id = v_my_prof
        )
    ),
    -- Comisión + conteo de productos por línea de cada venta atribuida.
    lines as (
      select sc.professional_id,
             si.product_id,
             si.quantity,
             si.subtotal,
             coalesce(pr.commission_pct, prof.commission_pct, 0) as pct
      from scoped sc
      join sale_items si on si.sale_id = sc.id and si.tenant_id = v_tenant
      left join products pr on pr.id = si.product_id
      left join professionals prof on prof.id = sc.professional_id
    ),
    per_prof_lines as (
      select professional_id,
             sum(case when product_id is not null then quantity else 0 end) as products_qty,
             sum(round((subtotal * pct / 100)::numeric, 2)) as commission
      from lines
      group by professional_id
    ),
    -- Turnos realizados (servicios) del período, por profesional.
    services as (
      select professional_id, count(*) as services_count
      from appointments
      where tenant_id = v_tenant
        and professional_id is not null
        and status = 'realizado'
        and starts_at >= p_from
        and starts_at < p_to
        and (not v_own_only or v_is_owner or professional_id = v_my_prof)
      group by professional_id
    ),
    -- Totales por venta atribuida (facturado, propina, ticket).
    per_prof_sales as (
      select professional_id,
             count(*) as sales_count,
             sum(total) as billed,
             sum(tip_amount) as tips
      from scoped
      group by professional_id
    )
    select coalesce(jsonb_agg(j), '[]'::jsonb) from (
      select jsonb_build_object(
        'professional_id', p.id,
        'professional', p.name,
        'services', coalesce(sv.services_count, 0),
        'products_qty', coalesce(pl.products_qty, 0),
        'sales_count', coalesce(ps.sales_count, 0),
        'billed', coalesce(ps.billed, 0),
        'commission', coalesce(pl.commission, 0),
        'tips', coalesce(ps.tips, 0),
        'avg_ticket', case when coalesce(ps.sales_count, 0) > 0
                           then round((ps.billed / ps.sales_count)::numeric, 2)
                           else 0 end
      ) as j
      from professionals p
      left join per_prof_sales ps on ps.professional_id = p.id
      left join per_prof_lines pl on pl.professional_id = p.id
      left join services      sv on sv.professional_id = p.id
      where p.tenant_id = v_tenant
        and p.deleted_at is null
        and (not v_own_only or v_is_owner or p.id = v_my_prof)
        -- Sólo profesionales con actividad en el período (o el propio).
        and (ps.professional_id is not null or sv.professional_id is not null
             or p.id = v_my_prof)
      order by coalesce(ps.billed, 0) desc, coalesce(pl.commission, 0) desc
    ) t
  );
end;
$function$;

revoke all on function public.staff_productivity(timestamptz, timestamptz) from public, anon;
grant execute on function public.staff_productivity(timestamptz, timestamptz) to authenticated;
