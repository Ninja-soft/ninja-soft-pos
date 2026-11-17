-- =============================================================================
-- SEC-61 · Token de supervisor sin carrera + PIN de devoluciones acumulado por
-- venta (ADR-190)
-- =============================================================================
-- Definiciones de producción comparadas (pg_get_functiondef, pre-SEC-59):
-- require_supervisor y pin_action_required son iguales a su última migración
-- (20261019100000_precio_servidor y 20261017110000 + SEC-14 grants): sin drift.
-- trg_sale_returns_supervisor en ese snapshot es la de 20261017120000 (SEC-59
-- todavía sin aplicar); la base de esta migración es la de SEC-59
-- (20270124100000), que tiene que aplicarse antes.
--
-- 1) Carrera del token (todas las acciones con PIN: ventas, descuentos, precio,
--    anulaciones, devoluciones, retiros, reintegro MP…).
--    require_supervisor consumía el token con
--      update supervisor_auth_tokens t set consumed_at = now() …
--       where t.id = (select c.id … where c.consumed_at is null …)
--    El subselect es un InitPlan: corre una vez con el snapshot de la
--    sentencia. Dos transacciones con el mismo token eligen la misma fila; la
--    segunda espera el lock de la primera y, al re-chequear la fila (READ
--    COMMITTED / EvalPlanQual), sólo re-evalúa el WHERE externo (t.id = …), que
--    sigue cumpliéndose: las dos "consumían" el mismo token de un solo uso.
--    Arreglo: el WHERE externo repite todas las condiciones de validez
--    (tenant, acción, solicitante, no consumido, no vencido, monto). Si otra
--    transacción lo consumió primero, el re-chequeo descarta la fila, el UPDATE
--    no afecta filas y sale por el mismo camino de siempre:
--    'supervisor_token_invalid' (42501). Contrato, firma, grants y search_path
--    iguales a prod.
--
-- 2) Fragmentación de devoluciones (ADR-190, reversible).
--    Cada devolución se comparaba sola contra el umbral: N devoluciones de
--    $499 con umbral $500 nunca pedían PIN. Ahora trg_sale_returns_supervisor
--    evalúa la política 'sale_return' con el ACUMULADO de la venta: total de
--    las devoluciones previas de esa venta (sale_returns no tiene anulación: se
--    cuentan todas) + new.total. El token se pide y valida con ese acumulado,
--    topeado en el total de la venta (los prorrateos de return_sale_v2 /
--    return_sale redondean por línea y el acumulado puede pasar el total por
--    centavos). El front (withSupervisor en modules/sales/api.ts) ya pide el
--    PIN con el total de la venta, que es >= ese monto: sin cambios de front.
--    Un advisory lock por venta serializa dos devoluciones concurrentes de la
--    misma venta para que la segunda vea a la primera (return_sale_v2 ya toma
--    uno por negocio para el correlativo; el legado y el INSERT directo no).
--
-- 3) total < 0 → 'invalid_total' (antes se ignoraba en silencio).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) require_supervisor: copia de prod + condiciones de validez en el UPDATE.
-- -----------------------------------------------------------------------------
create or replace function public.require_supervisor(p_action text, p_amount numeric, p_ref uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_tokens uuid[];
  v_tok    supervisor_auth_tokens%rowtype;
begin
  if v_tenant is null or auth.uid() is null then return null; end if;
  if not pin_action_required(v_tenant, p_action, p_amount) then return null; end if;
  if is_supervisor(v_tenant, auth.uid()) then return auth.uid(); end if;

  v_tokens := request_supervisor_tokens();
  if coalesce(array_length(v_tokens, 1), 0) = 0 then
    raise exception 'supervisor_required:%', p_action using errcode = '42501';
  end if;
  -- SEC-61: las condiciones de validez van también en el WHERE externo. El
  -- subselect corre una sola vez; si otra transacción consume el mismo token
  -- antes, el re-chequeo de la fila bloqueada las vuelve a evaluar y la
  -- descarta (0 filas → supervisor_token_invalid).
  update supervisor_auth_tokens t
     set consumed_at = now(), consumed_ref = p_ref
   where t.id = (
           select c.id from supervisor_auth_tokens c
            where c.id = any (v_tokens)
              and c.tenant_id = v_tenant
              and c.action = p_action
              and c.requested_by = auth.uid()
              and c.consumed_at is null
              and c.expires_at > now()
              and (p_amount is null or coalesce(c.amount, 0) + 0.001 >= p_amount)
            order by c.created_at
            limit 1)
     and t.tenant_id = v_tenant
     and t.action = p_action
     and t.requested_by = auth.uid()
     and t.consumed_at is null
     and t.expires_at > now()
     and (p_amount is null or coalesce(t.amount, 0) + 0.001 >= p_amount)
  returning t.* into v_tok;
  if not found then
    -- Vinieron tokens pero ninguno de esta acción: hay que pedir esta también.
    if not exists (select 1 from supervisor_auth_tokens c
                    where c.id = any (v_tokens) and c.tenant_id = v_tenant and c.action = p_action) then
      raise exception 'supervisor_required:%', p_action using errcode = '42501';
    end if;
    raise exception 'supervisor_token_invalid' using errcode = '42501';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'users', v_tok.supervisor_id, 'supervisor_override_used', v_tok.reason,
          jsonb_build_object('pin_action', p_action, 'amount', p_amount, 'supervisor_id', v_tok.supervisor_id,
                             'requested_by', auth.uid(), 'ref_id', p_ref, 'token_id', v_tok.id));
  return v_tok.supervisor_id;
end;
$$;
revoke all on function public.require_supervisor(text, numeric, uuid) from public, anon;
grant execute on function public.require_supervisor(text, numeric, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 2) y 3) trg_sale_returns_supervisor: acumulado por venta y total < 0.
-- Mismo disparo que SEC-59 (BEFORE INSERT OR UPDATE OF total): la cabecera
-- provisoria en 0 no evalúa y en un UPDATE sólo cuando el total sube.
-- -----------------------------------------------------------------------------
create or replace function public.trg_sale_returns_supervisor()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prev       numeric;
  v_sale_total numeric;
  v_amount     numeric;
begin
  if new.total < 0 then
    raise exception 'invalid_total';
  end if;
  -- Cabecera provisoria en 0: el total real llega con el UPDATE.
  if coalesce(new.total, 0) = 0 then
    return new;
  end if;
  -- En un UPDATE sólo cuando el total sube (0 → total real): una sola vez.
  if tg_op = 'UPDATE' and new.total <= coalesce(old.total, 0) then
    return new;
  end if;

  -- ADR-190: dos devoluciones concurrentes de la misma venta se serializan
  -- para que la segunda sume a la primera (lock de transacción).
  perform pg_advisory_xact_lock(hashtext('sale_return_pin:' || new.sale_id::text));

  select coalesce(sum(r.total), 0) into v_prev
    from sale_returns r
   where r.sale_id = new.sale_id
     and r.tenant_id = new.tenant_id
     and r.id <> new.id;

  select s.total into v_sale_total
    from sales s
   where s.id = new.sale_id and s.tenant_id = new.tenant_id;

  -- Tope en el total de la venta (redondeo por línea del prorrateo); least()
  -- ignora un total nulo.
  v_amount := least(v_prev + new.total, v_sale_total);
  perform require_supervisor('sale_return', v_amount, new.sale_id);
  return new;
end;
$$;

-- SEC-12: las funciones de trigger no se ejecutan por el Data API.
revoke execute on function public.trg_sale_returns_supervisor() from public, anon, authenticated;
