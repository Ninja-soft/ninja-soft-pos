-- =============================================================================
-- 20260608620000_comanda_printed  (F13 · H45 — comanda impresa por estación)
-- -----------------------------------------------------------------------------
-- Contraparte IMPRESA del KDS (H46): para locales con impresora de comandas en
-- cocina/barra en vez de pantalla. El mozo, desde la cuenta de la mesa (H44),
-- imprime la(s) comanda(s) del pedido — una POR ESTACIÓN (cocina lo suyo, barra
-- lo suyo). La comanda es un ticket de COCINA (sin precios ni totales): mesa +
-- salón, hora, mozo y la lista de ítems con cantidad + modificadores + notas.
--
-- ADITIVO: no toca el mostrador, ni create_sale, ni el cobro, ni el KDS. Sólo
-- agrega un flag por línea (`printed_at`) y dos RPCs de lectura/marcado.
--
-- MODELO (reusa H44/H46):
--   1) `table_order_items.printed_at` (timestamptz, null) — cuándo se envió la
--      línea a cocina por primera vez. null = "nueva" (todavía no impresa). Por
--      defecto "Imprimir comanda" imprime sólo las nuevas; "reimprimir todo"
--      ignora el flag.
--   2) RPC `comanda_items(p_order_id, p_only_new)` — líneas del pedido con su
--      estación + el contexto de cabecera (mesa / salón / mozo) en una sola
--      llamada tenant-scoped (mismo patrón que kds_tickets). El front agrupa por
--      estación en cliente. Devuelve también printed_at para mostrar el estado.
--   3) RPC `mark_comanda_printed(p_order_id, p_item_ids)` — sella printed_at
--      (sólo en las que aún era null; reimprimir NO repisa la marca original).
--
-- FUERA DE ALCANCE (follow-up, NO en este PR): impresión física automática a
-- una impresora de red por estación (acá es print del navegador), cancelación
-- con re-impresión de anulación, agrupar/imprimir por curso (entradas/
-- principales), QZ Tray / cola ESC-POS.
-- types/database.ts NO se regenera (el front castea; la DB + RLS validan).
-- =============================================================================

-- ── 1) Flag de impresión por línea ───────────────────────────────────────────
-- null = línea nueva (no enviada a cocina). Se sella al imprimir la comanda.
alter table table_order_items add column if not exists printed_at timestamptz;

-- Índice parcial: localizar rápido las líneas NUEVAS de un pedido (lo que la
-- comanda por defecto imprime). Acota a lo que realmente se consulta.
create index if not exists table_order_items_unprinted_idx
  on table_order_items (order_id)
  where printed_at is null;

-- ── 2) comanda_items: líneas del pedido + contexto para la comanda ────────────
-- Devuelve las líneas del pedido (con su estación snapshot) más mesa / salón /
-- mozo para la cabecera. p_only_new=true filtra a las no impresas (las "nuevas"
-- a enviar); false trae todas (reimprimir). SECURITY DEFINER + guard de miembro
-- activo (mismo patrón que kds_tickets / add_table_order_item). Orden FIFO.
create or replace function comanda_items(
  p_order_id uuid,
  p_only_new boolean default false
)
returns table (
  item_id      uuid,
  product_id   uuid,
  name         text,
  qty          numeric,
  modifiers    jsonb,
  notes        text,
  station      text,
  printed_at   timestamptz,
  table_label  text,
  area_name    text,
  waiter_name  text,
  opened_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
begin
  return query
    select
      i.id, i.product_id, i.name, i.qty, i.modifiers, i.notes,
      i.station, i.printed_at,
      t.label, a.name,
      nullif(btrim(coalesce(u.full_name, u.email, '')), ''),
      o.opened_at
    from table_order_items i
    join table_orders o   on o.id = i.order_id and o.tenant_id = v_tenant
    join dining_tables t  on t.id = o.table_id  and t.tenant_id = v_tenant
    left join dining_areas a on a.id = t.area_id and a.tenant_id = v_tenant
    left join public.users u on u.id = t.waiter_user_id
    where i.order_id = p_order_id
      and i.tenant_id = v_tenant
      and (p_only_new is not true or i.printed_at is null)
    order by i.created_at asc;
end;
$$;
revoke all on function comanda_items(uuid, boolean) from public, anon;
grant execute on function comanda_items(uuid, boolean) to authenticated;

-- ── 3) mark_comanda_printed: sella printed_at de las líneas impresas ──────────
-- Marca como enviadas las líneas indicadas (las que aún tenían printed_at null).
-- Reimprimir NO repisa la marca original (coalesce). p_item_ids vacío/null = no
-- hace nada. tenant-scoped + guard. Devuelve cuántas pasaron a impresas.
create or replace function mark_comanda_printed(
  p_order_id uuid,
  p_item_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_count  int;
begin
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    return jsonb_build_object('marked', 0);
  end if;

  with upd as (
    update table_order_items
       set printed_at = coalesce(printed_at, now())
     where order_id = p_order_id
       and tenant_id = v_tenant
       and id = any(p_item_ids)
       and printed_at is null
    returning 1
  )
  select count(*) into v_count from upd;

  return jsonb_build_object('marked', coalesce(v_count, 0));
end;
$$;
revoke all on function mark_comanda_printed(uuid, uuid[]) from public, anon;
grant execute on function mark_comanda_printed(uuid, uuid[]) to authenticated;
