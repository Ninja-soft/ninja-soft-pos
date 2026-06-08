-- =============================================================================
-- 20260608470000_print_profiles  (F10 / H22 — config de impresión por documento)
-- Perfiles de impresión por TIPO DE DOCUMENTO, guardados POR TENANT en
-- pos_settings.print_profiles (jsonb). Cada tipo configura:
--   * paper   : destino/formato ('58' | '80' | 'a4') — el front limita los
--               válidos por tipo (ej. etiqueta no ofrece A4).
--   * copies  : cantidad de copias a imprimir (1..N).
--   * auto    : impresión automática (true = imprime al confirmar) vs manual
--               (false = el usuario toca "Imprimir").
--   * font    : tamaño de fuente base ('sm' | 'md' | 'lg') — ajuste básico.
--   * margin  : margen del papel ('none' | 'narrow' | 'normal') — ajuste básico.
--
-- Tipos cubiertos (claves del objeto):
--   sale          → ticket de venta
--   z_close       → cierre Z de caja
--   cash_movement → movimiento de caja (ingreso/egreso)
--   product_label → etiqueta de producto
--   return        → devolución / nota de crédito
--
-- ALCANCE (H22 buildable, por tenant): el POS lee este perfil para decidir
-- formato + copias + auto/manual al imprimir. La IMPRESIÓN sigue siendo web
-- (window.print()). ESC/POS por conector local, cola de impresión con reintentos
-- y perfiles POR SUCURSAL / CAJA quedan para F4 (ver lib/print/profiles.ts y la
-- nota en la UI). Conservador: solo agrega una columna con default seguro; NO
-- toca create_sale, return_sale ni la plantilla activa (print_active de H9b).
-- La RLS de pos_settings ya vigente aplica: miembros leen, owner/manager escriben.
-- =============================================================================

alter table pos_settings
  add column if not exists print_profiles jsonb not null default jsonb_build_object(
    'sale',          jsonb_build_object('paper', '80', 'copies', 1, 'auto', false, 'font', 'md', 'margin', 'normal'),
    'z_close',       jsonb_build_object('paper', '80', 'copies', 1, 'auto', false, 'font', 'md', 'margin', 'normal'),
    'cash_movement', jsonb_build_object('paper', '80', 'copies', 1, 'auto', false, 'font', 'md', 'margin', 'normal'),
    'product_label', jsonb_build_object('paper', '58', 'copies', 1, 'auto', false, 'font', 'sm', 'margin', 'narrow'),
    'return',        jsonb_build_object('paper', '80', 'copies', 1, 'auto', false, 'font', 'md', 'margin', 'normal')
  );

comment on column pos_settings.print_profiles is
  'H22: perfiles de impresión por tipo de documento (sale/z_close/cash_movement/product_label/return). Cada uno: paper(58|80|a4), copies(int), auto(bool), font(sm|md|lg), margin(none|narrow|normal). Web print por tenant; ESC/POS, cola y per-caja → F4.';
