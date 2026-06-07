-- =============================================================================
-- 20260608230000_pos_page_size  (tamaño de página de los listados, por tenant)
-- -----------------------------------------------------------------------------
-- Tamaño de página configurable desde la Configuración del POS (Operación).
-- Se usa para paginar server-side los listados (ventas, productos, clientes…).
-- Default 20; acotado a 10..100 por CHECK (la UI también lo clampa).
-- =============================================================================

alter table pos_settings
  add column if not exists page_size int not null default 20;

-- Acota el rango permitido. Idempotente: solo agrega la constraint si falta.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pos_settings'::regclass
      and conname = 'pos_settings_page_size_range'
  ) then
    alter table pos_settings
      add constraint pos_settings_page_size_range
      check (page_size between 10 and 100);
  end if;
end $$;
