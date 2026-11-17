-- =============================================================================
-- 20270125100000_sec60_mp_webhook_signature  (SEC-60 · ADR-189)
--
-- Modo de verificación de `x-signature` en los webhooks de cobros de Mercado
-- Pago (mp_webhook y mp_orders_webhook; mp_billing_webhook no cambia):
--   * 'off'     → no se mira la firma (comportamiento anterior a SEC-60).
--   * 'report'  → se verifica; si falta el secreto o la firma no coincide se
--                 anota el motivo en webhook_events.error (signature_*) y el
--                 aviso se procesa igual. ES EL VALOR INICIAL.
--   * 'enforce' → firma inválida / sin ts / ausente / vencida → 401 sin
--                 escribir. Un aviso sin secreto (negocio con Access Token
--                 manual, o app sin webhook_secret cargado) sigue como report.
--
-- Lo leen las Edges con service_role (lectura directa por PK, cache de 60 s
-- en el isolate). Sin fila, valor desconocido o lectura fallida → 'report'.
-- No agrega funciones ni toca grants: system_settings ya no se escribe por el
-- Data API (SEC-23) y su SELECT sigue limitado a staff por RLS.
--
-- Pasar a enforce (decisión humana, después de revisar webhook_events):
--   update public.system_settings set value = '"enforce"'::jsonb, updated_at = now()
--    where key = 'mp_webhook_signature_mode';
-- Volver atrás: el mismo update con '"report"' (o '"off"').
-- =============================================================================

insert into public.system_settings (key, value)
values ('mp_webhook_signature_mode', '"report"'::jsonb)
on conflict (key) do nothing;
