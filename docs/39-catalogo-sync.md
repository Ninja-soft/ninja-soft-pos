# 39 · Sincronización del catálogo Tiendita con el scraper (Railway)

> ADR-107 (sync con el feed) y ADR-109 (catálogo maestro por EAN + ofertas por tienda y vendedor). Reemplaza la carga por Excel (`scripts/import_catalog.cjs`), que queda como plan B en el panel interno ("Importar Excel manualmente").

## Modelo (ADR-109)

- **`catalog_items`**: un producto por EAN canónico (UPC de 11/12 dígitos y EAN-13 con ceros son el mismo) con la ficha fusionada de todas las tiendas: título, descripción, marca, categoría, atributos, medidas (`alto_cm`, `ancho_cm`, `profundidad_cm`, `peso_kg`, bultos, contenido en ml/g, unidades por pack) y fotos. Los códigos inválidos y los EAN-13 que empiezan con 2 (pesables, marca propia) quedan como producto de esa tienda (`store_scope`) y no se fusionan.
- **`catalog_offers`**: una oferta por (tienda, producto, vendedor) con precio, precio de lista, disponible, URL y fechas. `vendedor_key = ''` es la publicación de la propia tienda; el resto son otros vendedores (marketplaces). Su `id` conserva el de `catalog_products` para lo migrado.
- **`catalog_products`** quedó congelada (un trigger rechaza escrituras). Se borra en una migración futura, después de una corrida completa OK.
- **Quién ve qué**: un negocio ve un producto si tiene publicación de tienda en una tienda de un catálogo que compró o recibió; ve las ofertas (de todos los vendedores) sólo de esas tiendas. El staff interno ve todo desde el panel interno.
- La fusión la hace el scraper (reglas en su README, "Catálogo maestro"); el POS guarda lo que manda.

## Cómo funciona

1. El scraper del dueño (repo `scrapping-productos`, desplegado en Railway) corre los viernes y guarda todo en su SQLite. Mantiene un índice por producto (`catalog_groups`) que se pone al día solo.
2. El sábado a las **06:00 hora Argentina** el job `catalog-sync-weekly` de pg_cron abre una corrida en `catalog_sync_runs` y llama a la Edge `catalog_sync`.
3. La Edge lee `GET /api/feed/stores` (crea solas las tiendas nuevas en `catalog_stores` con su nombre y logo) y después `GET /api/feed/catalog` de a 250 productos: cada uno trae la ficha fusionada y todas sus ofertas. Upsert batcheado en `catalog_items` + `catalog_offers` (`catalog_sync_upsert_catalog`). Se sincronizan **todas** las tiendas del feed, estén o no en un catálogo (sirven para comparar precios). Guarda el cursor en la corrida (`feed`) después de cada página.
4. Cada invocación trabaja ~100 s. Si no terminó, suelta el lease y el job `catalog-sync-continue` (cada minuto, sólo si hay una corrida abierta sin lease) la continúa desde el cursor. Si una invocación se cae, el lease vence a los 170 s y pasa lo mismo. Si el feed responde 503 (el scraper está armando su índice) se reintenta.
5. Terminada la lectura, cierra tienda por tienda: si la lectura fue **completa y sin error**, las ofertas que no vinieron quedan **no disponibles** (`estado = FALTANTE_EN_FEED`, nunca se borran) y se actualizan `product_count` y `last_import_at`. Al final, recuento público de cada catálogo afectado y aviso "+N productos nuevos" a los negocios que lo compraron.
6. La primera corrida (también la primera después de ADR-109) es completa. Las siguientes son **incrementales**: piden sólo los productos con alguna publicación cambiada desde el inicio de la última corrida OK (menos 1 h de margen por reloj).

Desde el panel interno (Catálogos > Sincronización con el catálogo) se ve la última corrida (productos únicos nuevos y actualizados, ofertas por tienda: nuevas, con cambios y faltantes), la próxima automática y el botón **Sincronizar ahora** (queda auditado en `audit_logs`). Soporte no puede dispararla. Debajo, **Catálogo maestro**: productos únicos vs ofertas de tiendas y de otros vendedores, cuánto se ahorra por deduplicar, qué tiendas están en venta y cuáles sólo para comparar, y un comparador de precios por EAN.

## En el negocio

- **Importar desde la tiendita** copia todo lo del producto maestro: nombre, descripción, marca, categorías, EAN, atributos ordenados (medidas primero), medidas como bultos y hasta 3 fotos. **El precio de venta queda vacío** (0): lo pone el negocio; nunca se copia el de una tienda.
- **Referencia de mercado** en la ficha del producto, al importar y en las flechas de precio: desde / mediana / hasta, cuántos vendedores, dónde está más barato, si el precio del negocio está por debajo, en rango o por encima, y la lista por precio con tienda, vendedor, disponible y fecha. Sólo con las tiendas de los catálogos del negocio.
- **Se apaga** en Configuración > Operación > Productos > "Mostrar precios de referencia del mercado en productos" (o "Ocultar" en la ficha). Apagado no se muestra en ningún lado ni se consulta.

## Puesta en marcha (una sola vez)

### 1. Railway (scraper)

1. Generar un token largo y aleatorio en tu PC (no lo pegues en chats ni commits):

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. En Railway, servicio del scraper > **Variables** > `FEED_TOKEN` = ese valor.
3. Deployar la rama `feat/feed-catalogo-maestro` del scraper (el repo no tiene remote: mergeala a `master` local y deployá como siempre). Al primer arranque la base agrega sola lo que falta y arma el índice del catálogo maestro en segundo plano (unos minutos con 1M de publicaciones; mientras tanto `/api/feed/catalog` responde 503 y el POS reintenta).
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
2. Aplicar las migraciones `20261110500000_catalogo_sync_railway.sql` (crea la tabla de corridas, las RPC y los dos jobs de pg_cron; usa el secreto interno `internal_cron` que ya existe en `platform_secrets`) y `20261111200000_catalogo_maestro_ean.sql` (ADR-109: catálogo maestro, ofertas y backfill desde `catalog_products`, ~1 minuto; no corta la tiendita).
3. Deployar las Edges: `supabase functions deploy catalog_sync` y `supabase functions deploy tiendita_copy_image` (con JWT, ya declaradas en `config.toml`).
4. En el panel interno, **Sincronizar ahora** para la primera corrida completa (con 1M de publicaciones son varias horas en tandas; el cron la continúa sola) y seguir el avance.

## Si algo falla

- **"feed_not_configured"**: faltan los secrets de Supabase.
- **"feed respondió 503"**: el scraper está armando su índice (primer arranque o base reemplazada); se reintenta cada minuto.
- **El feed responde mal varias veces**: se reintenta cada minuto hasta 5 veces seguidas; después la lectura cierra con error, las tiendas se cierran sin marcar faltantes (la corrida queda "Con errores en algunas tiendas") y la próxima vuelve a pedir desde la última corrida buena.
- **El scraper está caído varios días**: usar "Importar Excel manualmente" en el panel (script `scripts/import_catalog.cjs`).
- Una corrida abierta más de 12 h se cierra sola como error al abrir la siguiente.
