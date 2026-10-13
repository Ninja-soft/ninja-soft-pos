-- =============================================================================
-- 20261105100100_cierres_z_por_sucursal_y_caja  (F17 · H97 · completa F11/H30b · ADR-080)
--
-- Cierres Z con correlativo propio por sucursal y por caja, además del número
-- del negocio. Un negocio con varias sucursales necesita que "Z 12 de Norte"
-- no salte cuando cierra Centro, y que cada caja tenga su serie (como un
-- controlador fiscal por caja).
--
--   * cash_z_closures suma cash_register_id (desnormalizado del turno),
--     store_z_number y register_z_number.
--   * Trigger BEFORE INSERT (SECURITY DEFINER) asigna los tres números bajo un
--     lock por negocio. No se recrea close_cash_shift (lo recrean otras ramas;
--     última definición: 20261015120000): el trigger pisa lo que calculó.
--
-- Fix incluido: close_cash_shift es SECURITY INVOKER y calcula
-- max(z_number) + 1 con la RLS del usuario. Desde ADR-045 un cajero limitado
-- a Norte sólo ve los Z de Norte (czc_branch_scope), así que el número del
-- negocio se podía repetir entre sucursales. El trigger lo calcula sobre todo
-- el negocio, sin RLS, con el lock.
--
-- Backfill: numera los Z existentes por sucursal y por caja en orden de
-- cierre. El número del negocio existente no se toca (inmutable).
-- =============================================================================

alter table cash_z_closures
  add column if not exists cash_register_id uuid references cash_registers(id) on delete set null,
  add column if not exists store_z_number bigint,
  add column if not exists register_z_number bigint;

comment on column cash_z_closures.store_z_number is
  'Correlativo del cierre Z dentro de la sucursal (F17 · H97). Lo asigna el trigger czc_numbering.';
comment on column cash_z_closures.register_z_number is
  'Correlativo del cierre Z dentro de la caja (F17 · H97). Lo asigna el trigger czc_numbering.';

-- -----------------------------------------------------------------------------
-- A) Backfill (idempotente: sólo filas sin número)
-- -----------------------------------------------------------------------------
update cash_z_closures z
   set cash_register_id = cs.cash_register_id,
       store_id = coalesce(z.store_id, cs.store_id)
  from cash_shifts cs
 where cs.id = z.cash_shift_id
   and z.cash_register_id is null;

with n as (
  select id,
         row_number() over (partition by tenant_id, store_id order by closed_at, created_at, id) as rn
    from cash_z_closures
   where store_id is not null
)
update cash_z_closures z
   set store_z_number = n.rn
  from n
 where n.id = z.id and z.store_z_number is null;

with n as (
  select id,
         row_number() over (partition by cash_register_id order by closed_at, created_at, id) as rn
    from cash_z_closures
   where cash_register_id is not null
)
update cash_z_closures z
   set register_z_number = n.rn
  from n
 where n.id = z.id and z.register_z_number is null;

create unique index if not exists czc_store_number_key
  on cash_z_closures (tenant_id, store_id, store_z_number)
  where store_z_number is not null;
create unique index if not exists czc_register_number_key
  on cash_z_closures (cash_register_id, register_z_number)
  where register_z_number is not null;
create index if not exists czc_register_idx on cash_z_closures (cash_register_id, closed_at desc);

-- -----------------------------------------------------------------------------
-- B) Numeración al insertar
-- -----------------------------------------------------------------------------
create or replace function trg_czc_numbering()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reg   uuid;
  v_store uuid;
begin
  select cs.cash_register_id, cs.store_id into v_reg, v_store
    from cash_shifts cs
   where cs.id = new.cash_shift_id and cs.tenant_id = new.tenant_id;
  new.cash_register_id := coalesce(new.cash_register_id, v_reg);
  new.store_id := coalesce(new.store_id, v_store);

  -- Un cierre a la vez por negocio: los tres correlativos quedan sin huecos
  -- ni repetidos aunque dos cajas cierren en el mismo instante.
  perform pg_advisory_xact_lock(hashtextextended('czc:' || new.tenant_id::text, 0));

  select coalesce(max(z.z_number), 0) + 1 into new.z_number
    from cash_z_closures z
   where z.tenant_id = new.tenant_id;

  if new.store_id is not null then
    select coalesce(max(z.store_z_number), 0) + 1 into new.store_z_number
      from cash_z_closures z
     where z.tenant_id = new.tenant_id and z.store_id = new.store_id;
  end if;

  if new.cash_register_id is not null then
    select coalesce(max(z.register_z_number), 0) + 1 into new.register_z_number
      from cash_z_closures z
     where z.cash_register_id = new.cash_register_id;
  end if;

  return new;
end;
$$;
revoke all on function trg_czc_numbering() from public, anon, authenticated;

drop trigger if exists czc_numbering on cash_z_closures;
create trigger czc_numbering
  before insert on cash_z_closures
  for each row execute function trg_czc_numbering();
