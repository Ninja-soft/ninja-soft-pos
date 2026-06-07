-- =============================================================================
-- 20260607190000_scanner_settings  (H23 — F10)
-- Perfil de scanner por tenant (por caja → F4 multi-caja): prefijo/sufijo a
-- limpiar, beep de feedback y ventana anti-duplicado.
-- =============================================================================
alter table pos_settings add column if not exists scanner_prefix text not null default '';
alter table pos_settings add column if not exists scanner_suffix text not null default '';
alter table pos_settings add column if not exists scanner_beep boolean not null default true;
alter table pos_settings add column if not exists scanner_dup_ms int not null default 1500;
