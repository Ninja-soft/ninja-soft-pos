-- =============================================================================
-- 20260604200000_billing_records  (H12 — billing manual + extensión de trial)
-- Tabla append-only de pagos registrados por staff. Sin UPDATE/DELETE.
-- RPC internal_extend_trial: extiende trial_ends_at N días (guard is_internal).
-- =============================================================================

-- ── billing_records ──────────────────────────────────────────────────────────
create table if not exists billing_records (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  amount       numeric(12,2) not null,
  currency     text not null default 'ARS',
  medium       text not null check (medium in ('mp','bank_transfer','cash','other')),
  period_start date,
  period_end   date,
  receipt_ref  text,
  notes        text,
  recorded_by  uuid references public.users(id),
  created_at   timestamptz not null default now()
);
create index if not exists br_tenant_idx on billing_records(tenant_id, created_at desc);

alter table billing_records enable row level security;
-- Append-only: solo staff interno puede leer e insertar. Sin UPDATE/DELETE.
create policy br_select on billing_records
  for select using ((select is_internal()));
create policy br_insert on billing_records
  for insert with check ((select is_internal()));

-- ── internal_extend_trial ────────────────────────────────────────────────────
create or replace function internal_extend_trial(
  p_tenant_id uuid,
  p_days      int
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new_end timestamptz;
begin
  if not (select is_internal()) then raise exception 'unauthorized'; end if;
  if p_days < 0 or p_days > 365 then raise exception 'invalid_days'; end if;

  update tenants
     set trial_ends_at = greatest(coalesce(trial_ends_at, now()), now())
                         + (p_days || ' days')::interval
   where id = p_tenant_id
  returning trial_ends_at into v_new_end;

  if v_new_end is null then raise exception 'tenant_not_found'; end if;

  perform write_audit_log(
    'tenants'::text, p_tenant_id,
    'trial_extended'::text,
    jsonb_build_object('days', p_days, 'new_end', v_new_end),
    null
  );
  return v_new_end;
end;
$$;
revoke execute on function internal_extend_trial(uuid, int) from public, anon;
grant  execute on function internal_extend_trial(uuid, int) to authenticated;
