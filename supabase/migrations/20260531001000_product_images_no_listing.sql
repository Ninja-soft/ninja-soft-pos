-- =============================================================================
-- Recuperada del remoto (schema_migrations, version 20260531010917): aplicada
-- vía MCP el 2026-05-31 pero nunca commiteada. Restaurada el 2026-06-04 para
-- que el historial replaye en DBs frescas (detectado por el job rls de CI).
-- =============================================================================
-- El bucket public sirve objetos por URL sin necesidad de policy SELECT.
-- Quitamos la policy de lectura para que no se pueda LISTAR el bucket.
drop policy if exists "product_images_read" on storage.objects;
