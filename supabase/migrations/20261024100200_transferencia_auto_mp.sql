-- =============================================================================
-- 20261024100200_transferencia_auto_mp  (ADR-061, transferencias automáticas)
--
-- Detección automática de transferencias recibidas en un CVU de Mercado Pago
-- mientras la hoja de cobro espera la transferencia.
--
--  A) Feature `transferencia_auto_mp` (OPTIONAL, grupo pagos, Pro en adelante;
--     planes a medida heredan transferencia_multicuenta). Gating real: el
--     trigger de transfer_accounts (prender la detección) y la Edge
--     transfer_watch (start / poll / pick).
--  B) transfer_accounts: auto_detect, auto_tolerance (± pesos), auto_mode
--     ('notify' | 'auto_close') y auto_window_min. Sólo cuentas de Mercado
--     Pago (bank_slug 'mercado-pago' o CVU con PSP 0003, prefijo 0000003).
--     Trigger aparte del guard de ADR-055 (no se recrea).
--  C) transfer_watches: cada espera de la hoja de cobro, con el movimiento de
--     Mercado Pago que la cerró. Un movimiento nunca se usa dos veces (índice
--     único por negocio). Escritura sólo service_role (Edge transfer_watch);
--     lectura del negocio (ADR-052).
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- A) Feature ------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('transferencia_auto_mp', 'Transferencias automáticas (Mercado Pago)',
   'Detecta las transferencias recibidas en el CVU de Mercado Pago mientras el POS espera y cierra o avisa la venta',
   'pagos', false, 22)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('transferencia_auto_mp', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'transferencia_auto_mp');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object(
         'transferencia_auto_mp',
         coalesce((p.limits -> 'modules' ->> 'transferencia_multicuenta')::boolean, false)
       ),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'transferencia_auto_mp');

-- B) Configuración por cuenta ---------------------------------------------------
alter table transfer_accounts
  add column if not exists auto_detect boolean not null default false,
  add column if not exists auto_tolerance numeric(12,2) not null default 0,
  add column if not exists auto_mode text not null default 'notify',
  add column if not exists auto_window_min int not null default 30;

alter table transfer_accounts drop constraint if exists transfer_accounts_auto_tolerance_check;
alter table transfer_accounts
  add constraint transfer_accounts_auto_tolerance_check check (auto_tolerance >= 0 and auto_tolerance <= 100000);
alter table transfer_accounts drop constraint if exists transfer_accounts_auto_mode_check;
alter table transfer_accounts
  add constraint transfer_accounts_auto_mode_check check (auto_mode in ('notify', 'auto_close'));
alter table transfer_accounts drop constraint if exists transfer_accounts_auto_window_check;
alter table transfer_accounts
  add constraint transfer_accounts_auto_window_check check (auto_window_min between 5 and 240);

create or replace function transfer_accounts_auto_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.auto_detect then
    if not (coalesce(new.bank_slug, '') = 'mercado-pago' or coalesce(new.cbu, '') like '0000003%') then
      raise exception 'auto_detect_requires_mp_cvu';
    end if;
    if tg_op = 'INSERT'
       or not old.auto_detect
       or new.auto_tolerance is distinct from old.auto_tolerance
       or new.auto_mode is distinct from old.auto_mode
       or new.auto_window_min is distinct from old.auto_window_min then
      if not tenant_has_feature_for(new.tenant_id, 'transferencia_auto_mp') then
        raise exception 'feature_not_in_plan: transferencia_auto_mp' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function transfer_accounts_auto_guard() from public, anon, authenticated;

-- Nombre con "z": corre después del guard de ADR-055 (que normaliza el CBU).
drop trigger if exists transfer_accounts_zauto_guard on transfer_accounts;
create trigger transfer_accounts_zauto_guard
  before insert or update on transfer_accounts
  for each row execute function transfer_accounts_auto_guard();

-- C) Esperas de transferencia ---------------------------------------------------
create table if not exists transfer_watches (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id       uuid references stores(id) on delete set null,
  register_id    uuid references cash_registers(id) on delete set null,
  account_id     uuid not null references transfer_accounts(id) on delete cascade,
  created_by     uuid default auth.uid() references public.users(id) on delete set null,
  amount         numeric(12,2) not null check (amount > 0),
  tolerance      numeric(12,2) not null default 0 check (tolerance >= 0),
  mode           text not null default 'notify' check (mode in ('notify', 'auto_close')),
  status         text not null default 'waiting'
                   check (status in ('waiting', 'matched', 'ambiguous', 'expired', 'cancelled', 'closed')),
  expires_at     timestamptz not null,
  mp_payment_id  text,
  matched_amount numeric(12,2),
  payer_name     text,
  payer_doc      text,
  matched_at     timestamptz,
  rejected_ids   text[] not null default '{}',
  candidates     jsonb not null default '[]'::jsonb,
  sale_id        uuid references sales(id) on delete set null,
  scope_store_id uuid references stores(id) on delete set null,
  mp_user_id     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists transfer_watches_mp_payment_uniq
  on transfer_watches (tenant_id, mp_payment_id) where mp_payment_id is not null;
create index if not exists transfer_watches_status_idx
  on transfer_watches (tenant_id, status, created_at desc);

drop trigger if exists set_updated_at_transfer_watches on transfer_watches;
create trigger set_updated_at_transfer_watches
  before update on transfer_watches
  for each row execute function set_updated_at();

alter table transfer_watches enable row level security;
drop policy if exists transfer_watches_select on transfer_watches;
create policy transfer_watches_select on transfer_watches
  for select using (tenant_id = current_tenant_id() or internal_scope());

comment on table transfer_watches is
  'ADR-061: esperas de transferencia de la hoja de cobro con el movimiento de Mercado Pago que las cerró. Escritura sólo service_role (Edge transfer_watch).';
