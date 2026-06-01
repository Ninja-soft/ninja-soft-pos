-- =============================================================================
-- 20260601140000_payment_plans_brand  (H27 — planes por base/marca/cuotas)
-- Extiende payment_plans: base (débito/crédito/…), marca de tarjeta, cuotas y
-- code (para el seeder de planes típicos AR). Aditivo; los planes existentes
-- quedan base 'otro', 1 cuota.
-- =============================================================================
alter table payment_plans add column if not exists base text not null default 'otro'
  check (base in ('efectivo','transferencia','debito','credito','qr','otro'));
alter table payment_plans add column if not exists brand text;          -- visa/master/maestro/cabal/amex/naranja/diners/null
alter table payment_plans add column if not exists installments int not null default 1;
alter table payment_plans add column if not exists code text;
create unique index if not exists payment_plans_tenant_code_uk
  on payment_plans(tenant_id, code) where code is not null;
