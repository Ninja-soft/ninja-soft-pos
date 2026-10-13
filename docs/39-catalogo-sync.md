# 39 · Sincronización del catálogo Tiendita con el scraper (Railway)

> ADR-107. Reemplaza la carga por Excel (`scripts/import_catalog.cjs`), que queda como plan B en el panel interno ("Importar Excel manualmente").

## Cómo funciona

1. El scraper del dueño (repo `scrapping-productos`, desplegado en Railway) corre los viernes y guarda todo en su SQLite.
2. El sábado a las **06:00 hora Argentina** el job `catalog-sync-weekly` de pg_cron abre una corrida en `catalog_sync_runs` y llama a la Edge `catalog_sync`.
3. La Edge lee `GET /api/feed/stores` (crea solas las tiendas nuevas en `catalog_stores` con su nombre y logo) y después, tienda por tienda, `GET /api/feed/products` de a 1000, haciendo upsert en `catalog_products` por (tienda, EAN). Guarda el cursor del feed en la corrida después de cada página.
4. Cada invocación trabaja ~100 s. Si no terminó, suelta el lease y el job `catalog-sync-continue` (cada minuto, sólo si hay una corrida abierta sin lease) la continúa desde el cursor. Si una invocación se cae, el lease vence a los 170 s y pasa lo mismo.
5. Al terminar cada tienda: si la lectura fue **completa**, lo que no vino en el feed queda **no disponible** (`estado = FALTANTE_EN_FEED`, nunca se borra) y se actualizan `product_count` y `last_import_at`. Al final, recuento público de cada catálogo afectado y aviso "+N productos nuevos" a los negocios que lo compraron.
6. La primera corrida de cada tienda es completa. Las siguientes son **incrementales**: piden sólo lo que cambió desde el inicio de la última corrida OK de esa tienda (menos 1 h de margen por reloj).

Desde el panel interno (Catálogos > Sincronización con el catálogo) se ve la última corrida por tienda (nuevos, actualizados, faltantes), la próxima automática y el botón **Sincronizar ahora** (queda auditado en `audit_logs`). Soporte no puede dispararla.

## Puesta en marcha (una sola vez)

### 1. Railway (scraper)

1. Generar un token largo y aleatorio en tu PC (no lo pegues en chats ni commits):

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. En Railway, servicio del scraper > **Variables** > `FEED_TOKEN` = ese valor.
3. Deployar la rama `feat/feed-ninjapos` del scraper (el repo no tiene remote: mergeala a `master` local y deployá como siempre). Al primer arranque la base agrega sola la columna `updated_at` (unos segundos con 360k productos).
4. Probar desde tu PC:

   ```powershell
   curl.exe -H "Authorization: Bearer <FEED_TOKEN>" https://<tu-app>.up.railway.app/api/feed/stores
   ```

   Sin token tiene que dar 401. Si da 404, falta `FEED_TOKEN` en Railway.

### 2. Supabase (POS)

1. Secrets de la Edge (Dashboard > Edge Functions > Secrets, o CLI):

   ```powershell
   supabase secrets set CATALOG_FEED_URL=https://<tu-app>.up.railway.app CATALOG_FEED_TOKEN=<FEED_TOKEN>
   ```

   `CATALOG_FEED_URL` es la base, sin `/api/feed`.
2. Aplicar la migración `20261110500000_catalogo_sync_railway.sql` (crea la tabla, las RPC y los dos jobs de pg_cron; usa el secreto interno `internal_cron` que ya existe en `platform_secrets`).
3. Deployar la Edge: `supabase functions deploy catalog_sync` (con JWT, ya declarada en `config.toml`).
4. En el panel interno, **Sincronizar ahora** para la primera corrida completa y seguir el avance.

## Si algo falla

- **"feed_not_configured"**: faltan los secrets de Supabase.
- **Una tienda en "Reintentando"**: el feed respondió mal; se reintenta cada minuto hasta 5 veces seguidas y después queda con error (la corrida cierra como "Con errores en algunas tiendas" y la próxima vuelve a pedir esa tienda desde su última corrida buena).
- **El scraper está caído varios días**: usar "Importar Excel manualmente" en el panel (script `scripts/import_catalog.cjs`).
- Una corrida abierta más de 12 h se cierra sola como error al abrir la siguiente.
