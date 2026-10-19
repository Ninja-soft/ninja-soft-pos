-- =============================================================================
-- ADR-169: Ficha del cliente 360 completa (H31b, sigue a ADR-067).
--
--   A) Cambios de la ficha auditados: trigger audit_customers (write_audit_log,
--      el mismo de products y sales) en alta, edición y baja de customers. Una
--      edición que sólo mueve updated_at no se audita.
--   B) Adjuntos: tabla customer_attachments (baja lógica) y bucket privado
--      customer-files (carpeta = negocio/cliente, 10 MB, PDF, imágenes,
--      Word, Excel y texto). Alta y baja por RPC auditadas; lectura y subida
--      del archivo con customer_files_can() (miembro activo, no repartidor,
--      feature clientes_360).
--   C) customer_360_timeline: definición VIVA (pg_get_functiondef,
--      2026-10-19) + tipos 'change' (audit_logs del cliente, con antes y
--      después en extra) y 'attachment'. Cada fila suma la columna extra.
--
-- Gating real: clientes_360 en _c360_assert (RPC) y en customer_files_can
-- (storage). RLS con (select current_tenant_id()) y (select internal_scope()).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Auditoría de la ficha.
-- -----------------------------------------------------------------------------
drop trigger if exists audit_customers on public.customers;
drop trigger if exists audit_customers_update on public.customers;
create trigger audit_customers
  after insert or delete on public.customers
  for each row execute function public.write_audit_log();
create trigger audit_customers_update
  after update on public.customers
  for each row
  when ((to_jsonb(old) - 'updated_at') is distinct from (to_jsonb(new) - 'updated_at'))
  execute function public.write_audit_log();

-- -----------------------------------------------------------------------------
-- B) Adjuntos.
-- -----------------------------------------------------------------------------
create table if not exists public.customer_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 200),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid
);
create index if not exists customer_attachments_customer_idx
  on public.customer_attachments (tenant_id, customer_id, created_at desc);

alter table public.customer_attachments enable row level security;
drop policy if exists customer_attachments_select on public.customer_attachments;
create policy customer_attachments_select on public.customer_attachments for select to authenticated
  using ((tenant_id = (select current_tenant_id())) or (select internal_scope()));
drop policy if exists customer_attachments_driver_scope on public.customer_attachments;
create policy customer_attachments_driver_scope on public.customer_attachments as restrictive for select to authenticated
  using (not (select is_driver_member()));
revoke all on public.customer_attachments from anon;
revoke insert, update, delete on public.customer_attachments from authenticated;
grant select on public.customer_attachments to authenticated;

-- Quién puede leer y subir archivos de clientes del negocio actual.
create or replace function public.customer_files_can()
returns boolean
language plpgsql
stable security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then return false; end if;
  if _c360_member(v_tenant) is null then return false; end if;
  if is_driver_member() then return false; end if;
  return tenant_has_feature_for(v_tenant, 'clientes_360');
end;
$$;
revoke all on function public.customer_files_can() from public, anon;
grant execute on function public.customer_files_can() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customer-files', 'customer-files', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "customer_files_read" on storage.objects;
drop policy if exists "customer_files_write" on storage.objects;
create policy "customer_files_read" on storage.objects for select to authenticated
  using (bucket_id = 'customer-files'
         and (storage.foldername(name))[1] = (select current_tenant_id())::text
         and (select customer_files_can()));
create policy "customer_files_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'customer-files'
              and (storage.foldername(name))[1] = (select current_tenant_id())::text
              and (select customer_files_can()));

-- Registra un archivo ya subido a customer-files/<negocio>/<cliente>/...
create or replace function public.customer_attachment_add(
  p_customer uuid, p_path text, p_file_name text, p_mime_type text, p_size_bytes bigint, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _c360_assert(p_customer);
  v_path   text := btrim(coalesce(p_path, ''));
  v_name   text := left(btrim(coalesce(p_file_name, '')), 200);
  v_note   text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
  v_meta   jsonb;
  v_row    customer_attachments%rowtype;
begin
  if is_driver_member() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_path not like v_tenant::text || '/' || p_customer::text || '/%' or position('..' in v_path) > 0 then
    raise exception 'attachment_bad_path';
  end if;
  if char_length(v_name) < 1 then raise exception 'attachment_name_required'; end if;
  select o.metadata into v_meta from storage.objects o where o.bucket_id = 'customer-files' and o.name = v_path;
  if not found then raise exception 'attachment_not_uploaded'; end if;
  if (select count(*) from customer_attachments a
       where a.tenant_id = v_tenant and a.customer_id = p_customer and a.deleted_at is null) >= 100 then
    raise exception 'attachment_limit';
  end if;
  insert into customer_attachments (tenant_id, customer_id, storage_path, file_name, mime_type, size_bytes, note, created_by)
  values (v_tenant, p_customer, v_path, v_name,
          coalesce(nullif(v_meta ->> 'mimetype', ''), p_mime_type),
          coalesce(nullif(v_meta ->> 'size', '')::bigint, p_size_bytes),
          v_note, auth.uid())
  returning * into v_row;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'customers', p_customer, 'customer_attachment_added',
          jsonb_build_object('attachment_id', v_row.id, 'file_name', v_row.file_name, 'size_bytes', v_row.size_bytes));
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.customer_attachment_add(uuid, text, text, text, bigint, text) from public, anon;
grant execute on function public.customer_attachment_add(uuid, text, text, text, bigint, text) to authenticated;

-- Baja lógica: quien lo subió o un encargado. El archivo queda en storage.
create or replace function public.customer_attachment_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_row    customer_attachments%rowtype;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  select * into v_row from customer_attachments
   where id = p_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then raise exception 'attachment_not_found'; end if;
  perform _c360_assert(v_row.customer_id);
  if v_row.created_by is distinct from auth.uid() and not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update customer_attachments set deleted_at = now(), deleted_by = auth.uid() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_tenant, auth.uid(), 'customers', v_row.customer_id, 'customer_attachment_deleted',
          jsonb_build_object('attachment_id', p_id, 'file_name', v_row.file_name));
end;
$$;
revoke all on function public.customer_attachment_delete(uuid) from public, anon;
grant execute on function public.customer_attachment_delete(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Línea de tiempo con cambios y adjuntos.
-- -----------------------------------------------------------------------------
create or replace function public.customer_360_timeline(p_customer uuid, p_kinds text[] DEFAULT NULL::text[], p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_store uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant  uuid := _c360_assert(p_customer);
  v_ids     uuid[] := report_store_filter(p_store);
  v_manager boolean := is_tenant_manager();
  v_lim     int := greatest(1, least(coalesce(p_limit, 50), 200));
  v_items   jsonb;
  v_n       int;
  v_last    jsonb;
begin
  with ev as (
    -- Ventas (completas y anuladas).
    (select 'sale'::text as kind, s.status as sub, s.id, s.created_at as at, s.total as amount,
            s.number::text as ref, s.status as status, s.store_id, s.id as sale_id,
            (select string_agg(distinct p.method, ', ') from payments p where p.sale_id = s.id) as detail,
            null::jsonb as extra
       from sales s
      where s.tenant_id = v_tenant and s.customer_id = p_customer
        and (p_kinds is null or 'sale' = any (p_kinds))
        and (v_ids is null or s.store_id = any (v_ids))
        and (p_from is null or s.created_at >= p_from) and (p_to is null or s.created_at < p_to)
        and (p_before_at is null or (s.created_at, s.id) < (p_before_at, p_before_id))
      order by s.created_at desc, s.id desc
      limit v_lim + 1)
    union all
    -- Devoluciones (del cliente o de sus ventas).
    (select 'return', r.refund_method, r.id, r.created_at, -r.total,
            r.number::text, r.refund_method, s.store_id, r.sale_id,
            coalesce(r.reason, '') || case when r.mp_refund_amount > 0
                                           then ' · Mercado Pago ' || _ars(r.mp_refund_amount) else '' end, null::jsonb
       from sale_returns r
       join sales s on s.id = r.sale_id and s.tenant_id = v_tenant
      where r.tenant_id = v_tenant and (r.customer_id = p_customer or s.customer_id = p_customer)
        and (p_kinds is null or 'return' = any (p_kinds))
        and (v_ids is null or s.store_id = any (v_ids))
        and (p_from is null or r.created_at >= p_from) and (p_to is null or r.created_at < p_to)
        and (p_before_at is null or (r.created_at, r.id) < (p_before_at, p_before_id))
      order by r.created_at desc, r.id desc
      limit v_lim + 1)
    union all
    -- Cuenta corriente: cargos, cobros, intereses, ajustes y reversas.
    (select 'account', m.kind, m.id, m.created_at, m.delta,
            coalesce(m.receipt_no::text, ''), case when m.voided_at is not null then 'voided' else 'ok' end,
            null::uuid, m.sale_id,
            coalesce(m.note, m.reason, '') || case when m.method is not null then ' · ' || m.method else '' end, null::jsonb
       from customer_account_movements m
      where m.tenant_id = v_tenant and m.customer_id = p_customer
        and (p_kinds is null or 'account' = any (p_kinds))
        and p_store is null
        and (p_from is null or m.created_at >= p_from) and (p_to is null or m.created_at < p_to)
        and (p_before_at is null or (m.created_at, m.id) < (p_before_at, p_before_id))
      order by m.created_at desc, m.id desc
      limit v_lim + 1)
    union all
    -- Gestión de cobranza (notas, promesas, tareas, recordatorios): encargados.
    (select 'collection', a.type, a.id, a.created_at, coalesce(a.promise_amount, 0),
            coalesce(to_char(a.promise_date, 'DD/MM/YYYY'), ''), a.status, null::uuid, null::uuid,
            coalesce(a.body, ''), null::jsonb
       from account_collection_items a
      where v_manager and a.tenant_id = v_tenant and a.customer_id = p_customer and a.deleted_at is null
        and (p_kinds is null or 'collection' = any (p_kinds))
        and p_store is null
        and (p_from is null or a.created_at >= p_from) and (p_to is null or a.created_at < p_to)
        and (p_before_at is null or (a.created_at, a.id) < (p_before_at, p_before_id))
      order by a.created_at desc, a.id desc
      limit v_lim + 1)
    union all
    -- Vales y saldo a favor.
    (select 'store_credit', case when m.delta >= 0 then 'credit' else 'debit' end, m.id, m.created_at, m.delta,
            '', 'ok', null::uuid, null::uuid, coalesce(m.reason, ''), null::jsonb
       from store_credit_movements m
      where m.tenant_id = v_tenant and m.customer_id = p_customer
        and (p_kinds is null or 'store_credit' = any (p_kinds))
        and p_store is null
        and (p_from is null or m.created_at >= p_from) and (p_to is null or m.created_at < p_to)
        and (p_before_at is null or (m.created_at, m.id) < (p_before_at, p_before_id))
      order by m.created_at desc, m.id desc
      limit v_lim + 1)
    union all
    -- Cobros en espera.
    (select 'pending_charge', pc.channel, pc.id, pc.created_at, pc.amount,
            '', pc.status, pc.store_id, pc.sale_id, pc.provider_key, null::jsonb
       from pending_charges pc
      where pc.tenant_id = v_tenant and pc.customer_id = p_customer
        and (p_kinds is null or 'pending_charge' = any (p_kinds))
        and (v_ids is null or pc.store_id = any (v_ids))
        and (p_from is null or pc.created_at >= p_from) and (p_to is null or pc.created_at < p_to)
        and (p_before_at is null or (pc.created_at, pc.id) < (p_before_at, p_before_id))
      order by pc.created_at desc, pc.id desc
      limit v_lim + 1)
    union all
    -- Reintegros por Mercado Pago (H21h).
    (select 'mp_refund', mr.status, mr.id, mr.created_at, -mr.amount,
            coalesce(mr.mp_refund_id, ''), mr.status, mr.store_id, mr.sale_id,
            coalesce(mr.error_code, mr.fallback_method, ''), null::jsonb
       from mp_refunds mr
       join sales s on s.id = mr.sale_id and s.tenant_id = v_tenant
      where mr.tenant_id = v_tenant and s.customer_id = p_customer
        and (p_kinds is null or 'mp_refund' = any (p_kinds))
        and (v_ids is null or s.store_id = any (v_ids))
        and (p_from is null or mr.created_at >= p_from) and (p_to is null or mr.created_at < p_to)
        and (p_before_at is null or (mr.created_at, mr.id) < (p_before_at, p_before_id))
      order by mr.created_at desc, mr.id desc
      limit v_lim + 1)
    union all
    -- Contracargos, reclamos y devoluciones de Mercado Pago (ADR-064): encargados.
    (select 'dispute', d.kind, d.id, d.first_seen_at, -d.amount,
            coalesce(d.provider_case_id, d.provider_payment_id), d.status, s.store_id, d.sale_id,
            d.origin, null::jsonb
       from payment_disputes d
       join sales s on s.id = d.sale_id and s.tenant_id = v_tenant
      where v_manager and d.tenant_id = v_tenant and s.customer_id = p_customer and d.deleted_at is null
        and (p_kinds is null or 'dispute' = any (p_kinds))
        and (v_ids is null or s.store_id = any (v_ids))
        and (p_from is null or d.first_seen_at >= p_from) and (p_to is null or d.first_seen_at < p_to)
        and (p_before_at is null or (d.first_seen_at, d.id) < (p_before_at, p_before_id))
      order by d.first_seen_at desc, d.id desc
      limit v_lim + 1)
    union all
    -- Notas internas.
    (select 'note', case when n.pinned then 'pinned' else 'note' end, n.id, n.created_at, 0::numeric,
            coalesce(u.full_name, ''), 'ok', null::uuid, null::uuid, n.body, null::jsonb
       from customer_notes n
       left join public.users u on u.id = n.created_by
      where n.tenant_id = v_tenant and n.customer_id = p_customer and n.deleted_at is null
        and (p_kinds is null or 'note' = any (p_kinds))
        and (p_from is null or n.created_at >= p_from) and (p_to is null or n.created_at < p_to)
        and (p_before_at is null or (n.created_at, n.id) < (p_before_at, p_before_id))
      order by n.created_at desc, n.id desc
      limit v_lim + 1)
    union all
    -- Cambios de la ficha (ADR-169): altas, ediciones y verificaciones
    -- auditadas, con el antes y el después para el presentador de ADR-160.
    -- Las ediciones que sólo tocan updated_at no se auditan (trigger).
    (select 'change', a.action, a.id, a.created_at, 0::numeric,
            coalesce(u.full_name, ''), 'ok', null::uuid, null::uuid, '',
            jsonb_build_object('action', a.action, 'before', a.before_data, 'after', a.after_data)
       from audit_logs a
       left join public.users u on u.id = a.actor_user_id
      where a.tenant_id = v_tenant and a.entity_type = 'customers' and a.entity_id = p_customer
        and a.action in ('INSERT', 'UPDATE', 'customer_fiscal_verified')
        and (p_kinds is null or 'change' = any (p_kinds))
        and p_store is null
        and (p_from is null or a.created_at >= p_from) and (p_to is null or a.created_at < p_to)
        and (p_before_at is null or (a.created_at, a.id) < (p_before_at, p_before_id))
      order by a.created_at desc, a.id desc
      limit v_lim + 1)
    union all
    -- Adjuntos de la ficha (ADR-169).
    (select 'attachment', case when f.deleted_at is null then 'active' else 'deleted' end, f.id, f.created_at, 0::numeric,
            coalesce(u.full_name, ''), case when f.deleted_at is null then 'ok' else 'voided' end, null::uuid, null::uuid,
            f.file_name || case when f.note is not null then ' · ' || f.note else '' end,
            jsonb_build_object('mime_type', f.mime_type, 'size_bytes', f.size_bytes)
       from customer_attachments f
       left join public.users u on u.id = f.created_by
      where f.tenant_id = v_tenant and f.customer_id = p_customer
        and (p_kinds is null or 'attachment' = any (p_kinds))
        and (p_from is null or f.created_at >= p_from) and (p_to is null or f.created_at < p_to)
        and (p_before_at is null or (f.created_at, f.id) < (p_before_at, p_before_id))
      order by f.created_at desc, f.id desc
      limit v_lim + 1)
  ),
  page as (
    select ev.*, st.name as store_name
      from ev
      left join stores st on st.id = ev.store_id
     order by ev.at desc, ev.id desc
     limit v_lim + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', p.kind, 'sub', p.sub, 'id', p.id, 'at', p.at, 'amount', round(coalesce(p.amount, 0), 2),
           'ref', p.ref, 'status', p.status, 'store_id', p.store_id, 'store_name', p.store_name,
           'sale_id', p.sale_id, 'detail', nullif(p.detail, ''), 'extra', p.extra)
           order by p.at desc, p.id desc), '[]'::jsonb),
         count(*)
    into v_items, v_n
    from page p;

  -- Hay más: se corta en el límite y el cursor es la última fila mostrada.
  if v_n > v_lim then
    v_items := (select jsonb_agg(e order by o) from jsonb_array_elements(v_items) with ordinality as x(e, o) where o <= v_lim);
    v_last := v_items -> (v_lim - 1);
    return jsonb_build_object('items', v_items,
                              'next_cursor', jsonb_build_object('at', v_last -> 'at', 'id', v_last -> 'id'));
  end if;
  return jsonb_build_object('items', v_items, 'next_cursor', null);
end;
$function$
;
