-- =============================================================================
-- 20260608460000_customer_display  (F10 / H25 — pantalla del cliente)
-- Settings por tenant para la segunda pantalla / display del cliente:
--   * display_show_unit_prices: mostrar el precio unitario de cada ítem en la
--     pantalla del cliente. Default TRUE (se muestran). Si se apaga, la pantalla
--     muestra solo nombre + cantidad + subtotal de línea (algunos comercios no
--     quieren exponer el precio unitario por unidad).
--   * display_welcome_message: mensaje de bienvenida de la pantalla idle (sin
--     venta en curso). NULL/'' → se usa un texto por defecto en el front.
--   * display_thanks_message: mensaje que se muestra tras cobrar ("Pago recibido")
--     junto al agradecimiento/promo. NULL/'' → texto por defecto en el front.
-- Conservador: solo agrega columnas con defaults seguros; no toca create_sale ni
-- otros settings. La pantalla del cliente las lee dentro de la sesión del tenant
-- (RLS de pos_settings ya vigente: miembros leen, owner/manager escriben).
-- =============================================================================
alter table pos_settings
  add column if not exists display_show_unit_prices boolean not null default true,
  add column if not exists display_welcome_message   text,
  add column if not exists display_thanks_message     text;
