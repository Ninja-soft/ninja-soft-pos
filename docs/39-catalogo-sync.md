# 39 · Sincronización del catálogo Tiendita con el scraper (Railway)

> ADR-107 (sync con el feed), ADR-109 (catálogo maestro por EAN + ofertas por tienda y vendedor), ADR-113 (agenda editable, pausa y cancelación) y ADR-118 (productos sin EAN, cierre por lotes y conteos guardados). Reemplaza la carga por Excel (`scripts/import_catalog.cjs`), que queda como plan B en el panel interno ("Importar Excel manualmente").

## Modelo (ADR-109)

- **`catalog_items`**: un producto por EAN canónico (UPC de 11/12 dígitos y EAN-13 con ceros son el mismo) con la ficha fusionada de todas las tiendas: título, descripción, marca, categoría, atributos, medidas (`alto_cm`, `ancho_cm`, `profundidad_cm`, `peso_kg`, bultos, contenido en ml/g, unidades por pack) y fotos. Los códigos inválidos y los EAN-13 que empiezan con 2 (pesables, marca propia) quedan como producto de esa tienda (`store_scope`) y no se fusionan. Los EAN con espacios, guiones o puntos se limpian antes de validar (ADR-118).
- **Productos sin EAN (ADR-118)**: los que la tienda publica sin código (Megatone, Bancor y parte de las demás) son productos de esa tienda: `ean` NULL, `store_scope` = la tienda y `codigo_tienda` = su código propio (la key del scraper). Nunca se fusionan con otras tiendas. El código de la tienda es una **referencia** (SKU), no un código de barras.
- **`catalog_offers`**: una oferta por (tienda, producto, vendedor) con precio, precio de lista, disponible, URL y fechas. `vendedor_key = ''` es la publicación de la propia tienda; el resto son otros vendedores (marketplaces). Su `id` conserva el de `catalog_products` para lo migrado.
- **`catalog_products`** quedó congelada (un trigger rechaza escrituras). Se borra en una migración futura, después de una corrida completa OK.
- **Quién ve qué**: un negocio ve un producto si tiene publicación de tienda en una tienda de un catálogo que compró o recibió; ve las ofertas (de todos los vendedores) sólo de esas tiendas. El staff interno ve todo desde el panel interno.
- La fusión la hace el scraper (reglas en su README, "Catálogo maestro"); el POS guarda lo que manda.

## Cómo funciona

1. El scraper del dueño (repo `scrapping-productos`, desplegado en Railway) corre los viernes y guarda todo en su SQLite. Mantiene un índice por producto (`catalog_groups`) que se pone al día solo.
2. Según la **agenda** que se configura en el panel interno (por defecto, sábados 06:00 hora Argentina, sólo cambios), el job `catalog-sync-continue` de pg_cron (cada minuto) llama a `catalog_sync_tick()`: si toca, abre una corrida en `catalog_sync_runs` y llama a la Edge `catalog_sync`. Ver "Agenda" más abajo.
3. La Edge lee `GET /api/feed/stores` (crea solas las tiendas nuevas en `catalog_stores` con su nombre y logo) y después `GET /api/feed/catalog` de a 250 productos: cada uno trae la ficha fusionada y todas sus ofertas. Upsert batcheado en `catalog_items` + `catalog_offers` (`catalog_sync_upsert_catalog`). Se sincronizan **todas** las tiendas del feed, estén o no en un catálogo (sirven para comparar precios). Guarda el cursor en la corrida (`feed`) después de cada página.
4. Cada invocación trabaja ~100 s. Si no terminó, suelta el lease y el job `catalog-sync-continue` (cada minuto, sólo si hay una corrida abierta sin lease) la continúa desde el cursor. Si una invocación se cae, el lease vence a los 170 s y pasa lo mismo. Si el feed responde 503 (el scraper está armando su índice) se reintenta.
5. Terminada la lectura, cierra **por lotes** (ADR-118), cada lote en menos de un segundo:
   - Por tienda, de a 20.000 ofertas (`catalog_sync_close_store_batch`): si la lectura fue **completa y sin error**, las ofertas que no vinieron quedan **no disponibles** (`estado = FALTANTE_EN_FEED`, nunca se borran); se cuentan sus publicaciones y al terminar se guardan `product_count` y `last_import_at`.
   - Por catálogo afectado, de a 50.000 productos (`catalog_recount_step`): productos únicos visibles para quien lo compra (con al menos una publicación de una de sus tiendas, con o sin EAN) en `catalogs.product_count`.
   - `catalog_sync_finalize`: aviso "+N productos nuevos" a los negocios que lo compraron, con el conteo guardado, y estado.
   El avance queda en la corrida (`stores.<TIENDA>.cursor`, `closing`): si se acaba la tanda, la siguiente sigue desde ahí. Un lote que falla se reintenta; a los 3 fallos seguidos esa tienda o catálogo queda con error y la corrida termina **"Con errores"** (`partial`), nunca "OK".
6. La primera corrida (también la primera después de ADR-109) es completa. Las siguientes son **incrementales**: piden sólo los productos con alguna publicación cambiada desde el inicio de la última corrida OK (menos 1 h de margen por reloj).

## Panel interno (Catálogos)

Arriba, KPIs: productos únicos, ofertas, tiendas, última sincronización y próxima automática. Cuatro secciones:

- **Sincronización**: la corrida en curso o la última (estado, tipo, origen, avance, tiempo transcurrido y estimación según la última corrida del mismo tipo, resultados y tabla por tienda con estado Pendiente / En curso / OK / Error y progreso), los botones **Sincronizar ahora** (sólo cambios), **Lectura completa ahora**, **Pausar corrida** / **Reanudar** y **Cancelar corrida**, la **agenda** y el **historial** de corridas con duración y resultados. El Excel queda plegado abajo como plan B. Todo lo que dispara o cambia queda en `audit_logs`; soporte no puede.
- **Catálogos vendibles**: tarjetas con carátula, estado, tiendas, productos únicos, ofertas, cantidad de tiendas, negocios con acceso, precio, Accesos y Editar. Los números son los guardados (no se cuentan en vivo): se actualizan al terminar cada sincronización y al guardar el catálogo (si cambiaron sus tiendas, el panel recuenta por lotes).
- **Tiendas de origen**: por tienda, si está en venta o sólo para comparar, productos, disponibles, ofertas de otros vendedores, última sincronización y foto propia.
- **Catálogo maestro**: productos únicos vs ofertas de tiendas y de otros vendedores, ahorro por deduplicar y comparador de precios por EAN.

Los logos de las tiendas se muestran siempre sobre una baldosa blanca (`components/catalog/StoreLogo.tsx`), en todos los temas y en todo el sistema.

## Agenda (ADR-113)

- Se guarda en `catalog_sync_config` (una fila) con la RPC `internal_catalog_sync_config_save` (admin o super admin del panel interno, auditada). Opciones: activa o apagada; **diaria**, **semanal** (uno o varios días), **cada N días** (1 a 90, contados desde el día en que se guarda) o **cron avanzado** (5 campos: minuto hora día mes día-de-la-semana, en hora Argentina; números, `*`, listas, rangos y pasos, sin nombres); hora en hora Argentina; corrida automática **sólo cambios** o **completa**, y opcionalmente **una completa cada K corridas** (2 a 52).
- **Cómo se aplica**: no se reprograma pg_cron. El job `catalog-sync-continue` corre cada minuto y llama a `catalog_sync_tick()`, que revisa si algún minuto desde el último chequeo (hasta 60 minutos para atrás, por si el cron se salteó alguno) coincide con la agenda en hora Argentina. Si coincide, abre la corrida automática; si ya hay una abierta (en curso o pausada) la saltea y lo anota en la agenda. Al guardar una agenda nueva, lo que ya pasó no se dispara. El panel muestra la próxima ejecución calculada con las mismas reglas (`modules/internal/catalogSyncSchedule.ts`) y, para diaria y semanal, el equivalente en UTC.
- **Pausar**: la corrida sigue abierta pero nadie la continúa (ni el cron ni la Edge) hasta **Reanudar**; no vence por el timeout de 12 h. **Cancelar**: queda como cancelada en el historial, lo ya sincronizado se queda y no se marcan faltantes; la próxima incremental pide desde la última corrida buena. La Edge corta la tanda en la página siguiente; si todavía no se redesplegó, se nota al terminar la tanda en curso (unos 2 minutos).

## En el negocio

- **Importar desde la tiendita** copia todo lo del producto maestro: nombre, descripción, marca, categorías, EAN, atributos ordenados (medidas primero), medidas como bultos y hasta 3 fotos. **El precio de venta queda vacío** (0): lo pone el negocio; nunca se copia el de una tienda.
- El diálogo previo muestra si el producto **trae EAN** (y cuál) y **qué medidas** trae (peso, volumen o contenido, dimensiones, unidades por pack). **Sin EAN** avisa "se carga con el código de la tienda; podés agregar el código de barras después", deja el código de la tienda como SKU y un campo para cargar el EAN antes de importar. Las tarjetas marcan "Sin EAN" y "Con medidas".
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
2. Aplicar las migraciones (en orden) `20261110500000_catalogo_sync_railway.sql` (crea la tabla de corridas, las RPC y los jobs de pg_cron; usa el secreto interno `internal_cron` que ya existe en `platform_secrets`), `20261111200000_catalogo_maestro_ean.sql` (ADR-109: catálogo maestro, ofertas y backfill desde `catalog_products`, ~1 minuto; no corta la tiendita) , `20261111400000_catalogo_sync_config.sql` (ADR-113: agenda editable; borra `catalog-sync-weekly` y deja `catalog-sync-continue` llamando a `catalog_sync_tick()`), `20261115100000_tiendita_destacados_rapidos.sql` y `20261115200000_catalogo_sin_ean.sql` (ADR-118: productos sin EAN, cierre por lotes; unos segundos).
3. Deployar las Edges: `supabase functions deploy catalog_sync` y `supabase functions deploy tiendita_copy_image` (con JWT, ya declaradas en `config.toml`).
4. En el panel interno, **Sincronizar ahora** para la primera corrida completa (con 1M de publicaciones son varias horas en tandas; el cron la continúa sola) y seguir el avance.

## Si algo falla

- **"feed_not_configured"**: faltan los secrets de Supabase.
- **"feed respondió 503"**: el scraper está armando su índice (primer arranque o base reemplazada); se reintenta cada minuto.
- **"cierre: canceling statement due to statement timeout"** (antes de ADR-118): el cierre se hacía en una sola llamada. Con ADR-118 va por lotes; si igual un lote falla 3 veces, la corrida queda "Con errores" y la próxima completa lo vuelve a intentar.
- **El conteo de un catálogo no coincide**: se guarda al terminar cada corrida; para forzarlo, guardá el catálogo desde el panel (recuenta por lotes).
- **El feed responde mal varias veces**: se reintenta cada minuto hasta 5 veces seguidas; después la lectura cierra con error, las tiendas se cierran sin marcar faltantes (la corrida queda "Con errores en algunas tiendas") y la próxima vuelve a pedir desde la última corrida buena.
- **El scraper está caído varios días**: usar "Importar Excel manualmente" en el panel (script `scripts/import_catalog.cjs`).
- Una corrida abierta más de 12 h (desde que arrancó o se reanudó) se cierra sola como error al abrir la siguiente. Las pausadas no vencen solas: si una queda pausada, las automáticas se saltean (el panel lo avisa en la agenda) hasta reanudarla o cancelarla.
- **No sale la automática**: revisá en el panel que la agenda esté activa y la próxima ejecución; en la base, `select * from cron.job where jobname = 'catalog-sync-continue'` tiene que llamar a `catalog_sync_tick()`, y `catalog_sync_config.last_check_at` tiene que moverse cada minuto.

## Después de ADR-118 (una sola vez)

1. Deployar el scraper `feat/feed-sin-ean` (mergear a `master` y deployar como siempre). Al arrancar reindexa todo en segundo plano (unos minutos; `/api/feed/catalog` responde 503 y la Edge reintenta).
2. Aplicar `20261115200000_catalogo_sin_ean.sql` (después de `20261115100000_tiendita_destacados_rapidos.sql`).
3. `supabase functions deploy catalog_sync`.
4. En el panel interno, **Lectura completa ahora**: entran los productos sin EAN, se marcan como faltantes las ofertas que se movieron y se recuentan los catálogos.
