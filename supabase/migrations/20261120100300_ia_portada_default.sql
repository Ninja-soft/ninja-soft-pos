-- La portada automática con IA viene prendida por defecto para los negocios con
-- el Asistente IA (pedido del dueño). Quien no la quiera la apaga en
-- Configuración > Imágenes con IA. No cambia a quien ya la apagó.
alter table public.ai_image_settings alter column auto_cover set default true;
