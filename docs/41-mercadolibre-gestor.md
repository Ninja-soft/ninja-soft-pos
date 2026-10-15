# 41 · Gestor de Mercado Libre (H141 · ADR-132)

El gestor convierte la pantalla **Mercado Libre** del panel del dueño en el lugar donde se maneja toda la cuenta: publicar rápido (también en varios tipos de publicación con su propio precio), ventas y embudos, posventa y reclamos, preguntas, envíos, métricas y reputación, y una configuración de experto. Se apoya en la integración de ADR-104 ([`38-mercadolibre.md`](./38-mercadolibre.md)): mismas cuentas, tokens, cola, webhook y worker.

Pedido del dueño: "desde la misma sección de ML me gustaría poder publicar productos, también poder publicarlos en varios tipos de publicación, que cada tipo de publicación pueda manejar un % de recargo u otra lista de precio específica. La configuración debe ser más robusta como un gestor ML experto. Mostrar una sección de métricas [...], gestionar la posventa, marcar reclamos a ML, responder en reclamos, gestionar embudos, cambiar de secciones". Y después: "tendría que tener alguna forma rápida de publicar productos que pueda cargar rápido" y "acá debe explicar mejor lo que se podrá hacer en esa sección".

Criterio: "no necesito algo tan robusto pero sí que cubra necesidades". Es para pymes que venden en ML como un canal más, no para una operación de 500 reclamos por mes.

---

## 1. Qué se tomó de ANDESMAR

ANDESMAR (`C:\Users\Lucas\Documents\GitHub\ANDESMAR`, sólo lectura) opera ML a gran escala. Se usó como fuente de criterios, endpoints probados y trampas conocidas.

| Tema | En ANDESMAR | Qué se toma | Qué se simplifica |
|---|---|---|---|
| Reputación | `js/jsPosventa/posventaMetricasReputacion.js`, `posventaReglas.js` (`termometroDe`, `nivelMetrica`, `margen`), `js/reputacionMeliModern.js`, migración `0351_posventa_p5_metricas_reputacion.sql` | Sólo `GET /users/{id}` (`seller_reputation`): los endpoints `/reputation*` dan 404. Escala `1_red` a `5_green` con sus colores, MercadoLíder por `power_seller_status` (silver, gold, platinum), umbrales verdes por defecto **reclamos 1 %, cancelaciones 0,5 %, demoras 8 %**, nivel ámbar desde el 80 % del umbral, fórmula del margen (`permitidos = floor(l/100 · ventas)`, `margen = permitidos − valor`; si se pasó, `faltan = ceil(valor / (l/100)) − ventas` ventas sin reclamo), "sin excluir" cuando ML manda `excluded.real_value`, foto diaria (la última del día gana) | Foto una vez por día (y "Actualizar" a mano) en vez de cada hora; aviso al centro de notificaciones en vez de Telegram |
| Casos que afectan la reputación | `GET /post-purchase/v1/claims/{id}/affects-reputation`, job `enriquecer`, chips Reclamos / Mediaciones / Devoluciones / Otros, exclusión a mano con motivos | Mismo endpoint y chips, ventana de 60 días, estados de exclusión (`candidato`, `pedida`, `aceptada`, `rechazada`, `descartada`) registrados a mano (ML no tiene API para pedirla) | Se consulta al leer el reclamo y al reabrirse, sin job aparte |
| Posventa | `supabase/functions/posventa/index.ts` (`armarClaim`), `mapeo.ts` (`venceDe`, tipo del caso), `posventaMlAcciones.js`, `mlEscribir.ts`, `docs/posventa-omni/funcionalidades.md` | Búsqueda con `status` y `sort=date_created:desc` (sin filtro ML da 400; sin sort repite filas), `/detail` para `due_date` y `action_responsible`, `/v2/claims/{id}/returns` **siempre**, mensajes, vencimiento = `detail.due_date` o el `due_date` más temprano de las acciones del vendedor, estado desde `claim.status` (nunca del texto de `/detail`), "te toca / le toca al comprador / le toca a ML", acciones `send-message`, `attachments`, `allow-return`, `partial-refund` (sólo con las ofertas que da ML), `open_dispute` | Sin bandejas de "colgados" ni etiquetas; un semáforo simple (ámbar < 24 h hábiles, rojo < 4 h, vencido) |
| Escrituras con dinero | Candados: permiso, switch, releer el reclamo y exigir la acción en `available_actions`, vista previa, doble confirmación con monto, idempotencia, "incierto" sin reintento | Los mismos candados en la Edge y la UI, sin cupos por hora | Reembolso total (`refund`) queda en ML: ANDESMAR tampoco lo automatiza |
| Mensajería postventa | `meli-omni/index.ts` (4111-4134): `GET /messages/packs/{pack}/sellers/{seller}?tag=post_sale&mark_as_read=false`, envío por `action_guide` y fallback | Lectura con `mark_as_read=false` (obligatorio) y respuesta por `POST /messages/packs/{pack}/sellers/{seller}?tag=post_sale` | Sin guía de acciones (`action_guide`) en esta etapa |
| Embudos | Circuito interno `nuevo → gestion → esperando → llego → derivado → resuelto` (`posventaConfig.js:97-135`), movimientos automáticos que nunca deshacen uno manual | Etapas configurables con un estado automático asociado; una tarjeta movida a mano no la mueve el sistema | Dos tableros (ventas y posventa), asignación a una persona |
| Logística y Flex | `docs/Informe-Gestion-Flex-MercadoLibre.docx`, `docs/logistica-inversa.md` | Stock publicable con margen de seguridad y tope (no publicar todo el stock) | Flex y Full siguen en la fase v2 de ADR-104 |
| Reportes y cierre | `docs/reportes-ml.md`, `docs/cierre-mensual-ml.md` | Nada en esta etapa: la venta de ML ya entra al POS con su comisión | Conciliación con el release report queda fuera |

Trampas que el diseño respeta (de ANDESMAR y de lecturas reales del 15/10/2026):

- `x-format-new: true` en `/shipments/{id}`.
- Un 403 en `GET /claims/{id}` de un reclamo que sí lista la búsqueda: se usa la fila de la búsqueda.
- `/returns` da 429 seguido: se lee igual, y un retorno ya conocido no se borra por una lectura vacía.
- Una mediación puede quedar `opened` después de resuelta: se muestra el último mensaje del mediador.
- Los mensajes del mediador vienen en HTML: se pasan a texto.
- Las visitas por ítem se leen de a uno (`/items/visits?ids=` acepta un solo id): se leen a pedido, de a 50 por vez.

---

## 2. Alcance para el POS

**Entra:**

1. **Publicaciones**: listado con estado, tipo, precio, stock, calidad (`health`) y visitas de 30 días; acciones en lote (pausar, activar, reenviar precio o stock, releer, leer visitas); **publicación rápida** en lote y **publicar el mismo producto en varios tipos** con reglas de precio por tipo.
2. **Métricas y reputación**: como ANDESMAR, con foto diaria y evolución.
3. **Posventa**: reclamos, mediaciones y devoluciones con vencimiento, detalle con mensajes, responder (con adjuntos), pedir la mediación de ML, aceptar la devolución, ofrecer un reintegro parcial y registrar la exclusión; mensajes postventa del carrito.
4. **Embudos**: tablero de ventas y de posventa con etapas configurables y asignación.
5. **Configuración**: cuenta, reglas de precio por tipo, stock publicable (reserva fija, % y tope), sucursal de stock, facturación de ventas (modo de ADR-104), plantillas de respuesta, umbrales de reputación, exclusión y notificaciones.

**Queda fuera** (ver §8).

---

## 3. Secciones del gestor

Navegación con `Segmented scrollOnMobile` (scroll lateral en mobile) y encabezado con `headerActionsRow`. Cada sección tiene una línea que explica qué se hace ahí, un estado vacío útil con 2 o 3 acciones y, si la cuenta es nueva, un **checklist de puesta en marcha** arriba (cuenta conectada, sucursal de stock, reglas de precio por tipo, facturación de ventas, notificaciones de DevCenter).

| Sección | Qué se hace | Parte |
|---|---|---|
| **Publicaciones** | Ver y ordenar lo publicado, publicar rápido, publicar en varios tipos, pausar, activar y sincronizar | A |
| **Ventas** | Las órdenes que entraron como venta del POS (ADR-104) | existente |
| **Preguntas** | Bandeja de preguntas con plantillas | existente + B |
| **Envíos** | Etiquetas y estado | existente |
| **Posventa** | Reclamos, mediaciones, devoluciones y mensajes con vencimiento | B |
| **Embudos** | Tableros de ventas y posventa | B |
| **Métricas** | Reputación, márgenes, evolución y casos | B |
| **Configuración** | Todo lo de la cuenta | A + B |

### 3.1 Publicación rápida (objetivo: un producto típico en menos de un minuto)

1. **Elegir productos**: búsqueda por nombre, SKU o código, filtro por categoría, "sólo sin publicar" y un campo para el **escáner** (un código exacto agrega el producto a la selección). Selección múltiple.
2. **Sugerencia automática** por producto (de a 3 en paralelo, con progreso):
   - con GTIN válido, `GET /products/search?status=active&site_id=MLA&product_identifier={gtin}`: si existe en el catálogo de ML, sus atributos (marca, línea, volumen, etc.) precompletan la publicación;
   - `GET /sites/MLA/domain_discovery/search?q={título}`: categoría y atributos sugeridos;
   - la **última categoría usada** y los **valores recordados para esa categoría** (`ml_category_memory`) completan lo que falte.
3. **Precompletado desde la ficha**: título, marca, modelo, GTIN o motivo sin código, SKU, fotos, descripción y garantía.
4. **Precio por tipo**: los tipos tildados salen de las reglas de la cuenta (`default_on`); cada fila muestra el precio que calcula el servidor para cada tipo y la comisión estimada de ML (`/sites/MLA/listing_prices`).
5. **Grilla tipo planilla** (una fila por producto; tarjetas en mobile) con **sólo los atributos obligatorios que faltan**, editables en línea.
6. **Validar todo** contra `/items/validate` (uno por producto) y **Publicar** en lote, con progreso y resultado por fila: publicado (con link) o qué corregir.

### 3.2 Reglas de precio por tipo

Por cuenta y tipo (`ml_listing_rules`): activo, modo **recargo %** sobre el precio base de la cuenta o **lista de precios** propia (más un recargo opcional), redondeo hacia arriba al múltiplo (0 = el de la cuenta), precio mínimo y "tildado por defecto al publicar". Override por producto y tipo (`ml_product_listing_prices`): heredar, recargo propio, lista propia, precio fijo o **no publicar en este tipo**.

Cálculo (SQL `_ml_listing_price` y su espejo `listingPrice` en `lib/mercadolibre/pricing.ts`, con tests):

1. Override "no publicar" → no se publica en ese tipo. Override "precio fijo" → ese precio (con el mínimo).
2. Base: la lista del override o de la regla si el modo es lista; si no, el precio base de la cuenta (lista de la cuenta o precio del POS con el margen y el redondeo de ADR-104).
3. Recargo: el del override (si es recargo o lista) o el de la regla.
4. Si hubo recargo o lista, redondeo hacia arriba al múltiplo de la regla (o el de la cuenta).
5. Mínimo: el del override si está, si no el de la regla.

El precio que se manda a ML lo calcula **siempre el servidor** (al publicar y en cada push de precio de la cola). El push de precio de cada publicación usa el tipo de esa publicación. Cambiar una regla reenvía el precio de lo vinculado.

**Varios tipos para el mismo producto:** un ítem por tipo, vinculado al mismo producto. Con User Products (el caso por defecto desde 2025) ML agrupa los ítems del mismo producto y el stock es del User Product; en el modelo clásico cada ítem muestra el mismo stock publicable (una venta baja el stock del POS y la cola actualiza los dos).

### 3.3 Métricas y reputación

- Encabezado: nivel con la barra de 5 colores (rojo, naranja, amarillo, verde claro, verde) y la marca del nivel actual, MercadoLíder (Platinum, Gold o el básico) y la fecha de la última lectura.
- Tarjetas: ventas del período (`metrics.sales.completed`, 60 días según ML), calificaciones (positivas, neutras, negativas), concretadas y canceladas (`transactions`).
- Reclamos, cancelaciones y despachos con demora: valor, %, umbral para seguir en verde, barra con la marca del 80 %, **margen restante** ("Te quedan N reclamos antes de pasar el 1 %") o lo que falta para volver ("Te faltan N ventas sin reclamo"), y "sin excluir" si ML lo informa.
- Evolución diaria (ECharts, ADR-035) de los tres porcentajes con la línea del umbral, 30, 60 o 90 días.
- Casos que afectan la reputación en 60 días, con chips **Todos · Reclamos · Mediaciones · Devoluciones · Otros**, motivo, estado y exclusión.

### 3.4 Posventa

- Lista con chips por tipo (reclamo, mediación, devolución, cancelación), "te toca", vencimiento ("Resolvé hasta el 16/10 18:00") con semáforo, venta del POS asociada, asignado y si afecta la reputación.
- Detalle: datos del reclamo, motivo, devolución (estado), acciones disponibles según ML, historial de mensajes (comprador, vendedor, mediador) y mensajes postventa del carrito.
- Acciones (sólo si ML las ofrece en `available_actions` en ese momento; la Edge vuelve a leer el reclamo antes de escribir):
  - **Responder** al comprador o al mediador (`send_message_to_complainant` / `send_message_to_mediator`), con plantillas y hasta 3 adjuntos (jpg, png o pdf, 5 MB cada uno).
  - **Pedir la mediación de ML** (`open_dispute`), con confirmación.
  - **Aceptar la devolución** (`allow-return`), con confirmación fuerte.
  - **Ofrecer un reintegro parcial** (`partial-refund`) sólo con los porcentajes que ofrece ML, con doble confirmación que muestra el monto; si el monto cambió, se cancela.
  - **Exclusión**: marcar "pedí la exclusión en ML" y su resultado (no hay API).
  - Reembolso total y revisión de la devolución quedan en ML (link directo).

### 3.5 Embudos

Dos tableros: **Ventas** (Nueva, A preparar, Despachada, Entregada, Con reclamo, Resuelta) y **Posventa** (Nuevo, En gestión, Esperando, Resuelto). Etapas configurables (nombre, orden, estado automático asociado). Cada tarjeta entra sola en la etapa que corresponde a su estado (orden pagada, envío listo, entregado, reclamo abierto, reclamo cerrado) hasta que alguien la mueve a mano; desde ahí el sistema no la mueve. Asignación a una persona del negocio y nota corta. Kanban con scroll lateral en mobile y "Mover a" accesible por teclado.

---

## 4. Modelo de datos

Todas con `tenant_id` NOT NULL sin default, RLS de lectura `tenant_id = (select current_tenant_id())`, escritura sólo por RPC SECURITY DEFINER o service_role, `role_write_guard`, índice por FK. Nunca `OR is_internal()`.

**Parte A** (`20261127100000_ml_gestor_publicaciones`):

| Tabla / columna | Para qué |
|---|---|
| `ml_listing_rules` | Regla de precio por cuenta y tipo de publicación |
| `ml_product_listing_prices` | Override por producto y tipo |
| `ml_location_map.reserve_pct`, `.max_qty` | Stock publicable: % de reserva y tope |
| `ml_category_memory` | Última categoría y valores de atributos por categoría |
| `ml_items.visits_30d`, `.visits_synced_at` | Visitas de 30 días |

**Parte B** (`20261127100100_features_mercadolibre_gestor`, `20261127100200_ml_gestor_posventa`, `20261127100300_ml_gestor_cron`):

| Tabla / columna | Para qué |
|---|---|
| `features.mercadolibre_gestor` | Feature de plan (ADR-132) |
| `ml_reputation_snapshots` | Foto diaria por cuenta (fecha de Argentina) |
| `ml_claims` | Espejo de reclamos, mediaciones y devoluciones con vencimiento, acciones, retorno, afecta la reputación, exclusión y asignación |
| `ml_gestor_settings` | Por cuenta: umbrales de reputación, motivos de exclusión, notificaciones |
| `ml_reply_templates` | Plantillas de respuesta (preguntas, reclamos, mensajes) |
| `ml_board_stages`, `ml_board_cards` | Etapas y tarjetas de los embudos |
| `ml_sync_jobs.kind` | Suma `claim_refresh` |

---

## 5. Endpoints de Mercado Libre

Todos con el token del negocio por las Edges (`ml_api`, `ml_gestor`, `ml_worker`). Probados en lectura (GET) con la cuenta conectada del dueño el 15/10/2026 los marcados con ✓.

| Endpoint | Uso | Permiso funcional (DevCenter) |
|---|---|---|
| `GET /users/{id}` ✓ | Reputación (`seller_reputation`) | Usuarios |
| `GET /users/{id}/items/search?search_type=scan` ✓ | Importar publicaciones | Publicación y sincronización |
| `GET /items?ids=` / `GET /items/{id}` ✓ | Espejo, `health` | Publicación y sincronización |
| `GET /items/visits?ids={uno}&date_from&date_to` ✓ | Visitas (un id por llamada) | Métricas del negocio |
| `GET /sites/MLA/domain_discovery/search` ✓ | Categoría sugerida | Publicación |
| `GET /products/search?product_identifier={gtin}` ✓ | Producto de catálogo por GTIN (`query_type: GTIN`) | Publicación |
| `GET /sites/MLA/listing_types` ✓, `GET /sites/MLA/listing_prices?price&category_id` ✓ | Tipos y comisión por tipo | Publicación |
| `GET /categories/{id}/attributes`, `POST /items/validate`, `POST /items`, `POST /items/{id}/description` | Publicar (ADR-104) | Publicación |
| `PUT /items/{id}` | Pausar, activar, precio, stock (cola, ADR-104) | Publicación |
| `GET /post-purchase/v1/claims/search?status=opened&sort=date_created:desc` ✓ | Reclamos (sin filtro: 400 `atLeastOneFilterProvided`) | Comunicación pre y postventa |
| `GET /post-purchase/v1/claims/{id}`, `/detail`, `/messages`, `/affects-reputation`, `/partial-refund/available-offers` | Detalle | Comunicación pre y postventa |
| `GET /post-purchase/v2/claims/{id}/returns` | Devolución | Comunicación pre y postventa |
| `POST /post-purchase/v1/claims/{id}/actions/send-message` | Responder | Comunicación (escritura) |
| `POST /post-purchase/v1/claims/{id}/attachments` | Adjuntos | Comunicación (escritura) |
| `POST /post-purchase/v1/claims/{id}/actions/open-dispute` **[confirmar ruta]** | Pedir la mediación | Comunicación (escritura) |
| `POST /post-purchase/v1/claims/{id}/expected-resolutions/allow-return` | Aceptar la devolución | Comunicación (escritura) |
| `POST /post-purchase/v1/claims/{id}/expected-resolutions/partial-refund` | Reintegro parcial | Comunicación (escritura) |
| `GET /messages/packs/{pack}/sellers/{seller}?tag=post_sale&mark_as_read=false` | Mensajes postventa | Comunicación |
| `POST /messages/packs/{pack}/sellers/{seller}?tag=post_sale` | Responder mensaje | Comunicación (escritura) |

Scopes de la cuenta conectada hoy (15/10/2026): `offline_access read write` más `urn:ml:all:comunication:/read-write`, `urn:ml:mktp:metrics:/read-only`, `urn:ml:mktp:publish-sync:/read-write`, `urn:ml:mktp:orders-shipments:/read-write` e `invoices` en lectura. Alcanzan para todo el gestor; no hay que pedir permisos nuevos en DevCenter.

### Tópicos a tildar en DevCenter

| Tópico | Uso | Estado |
|---|---|---|
| `claims` | Reclamo nuevo o cambiado → `claim_refresh` | **nuevo**, tildar |
| `claims_actions` | Acción sobre un reclamo | **nuevo**, tildar |
| `messages` | Mensajes postventa | opcional: hoy se guarda como `ignored`; los mensajes se leen en vivo al abrir el caso (`mark_as_read=false`) |
| `post_purchase` | Alias que algunas apps reciben para los reclamos | se procesa igual si llega |

`claims`, `claims_actions` y `post_purchase` van al mismo patrón `^/post-purchase/v\d/claims/\d+` y disparan la relectura del reclamo. Hasta que se tilden, la reconciliación cada 10 minutos (`ml-reconcile`) busca los reclamos abiertos y los cerrados recientes, así que nada se pierde.

**Validar y publicar (ADR-136).** `POST /items/validate` responde 400 aunque sólo haya causas `type: warning`: los avisos no frenan (salvo `moderations.*`). El envío se decide con `GET /users/me` (`status.mercadoenvios`), `GET /users/{id}/shipping_preferences` (modos y logísticas de me2 con su `status`) y `GET /categories/{id}/shipping_preferences` (logísticas de me2 que admite la categoría); `GET /users/{id}/available_listing_types?category_id=` dice qué tipos puede usar la cuenta. Todo vive en `_shared/mercadolibre/publish.ts`, la única función que usan el modal y la publicación rápida.

---

## 6. Feature de plan, permisos y auditoría

- **`mercadolibre`** (ADR-104, Pro): conexión, publicaciones (incluida la publicación rápida y los tipos con reglas de precio), ventas, preguntas y envíos.
- **`mercadolibre_gestor`** (nueva, OPTIONAL, Pro, Business y Enterprise; requiere `mercadolibre`): métricas y reputación, posventa, embudos, plantillas y umbrales. Gating real en `ml_gestor_assert` (RPC), `ml_edge_guard_gestor` (Edge), la ingesta de reclamos y la foto diaria. Ver ADR-132.
- Roles: dueño o encargado configuran y ejecutan acciones con dinero (devolución, reintegro, mediación); cualquier rol operativo puede responder mensajes, mover tarjetas y responder preguntas; sólo lectura no escribe nunca.
- `audit_logs` **antes** de responder al usuario: publicar (`ml_item_published`), pausar y activar (`ml_items_pause` / `ml_items_activate`), reglas y overrides de precio, responder reclamo (`ml_claim_message_sent`), mediación (`ml_claim_dispute_opened`), devolución (`ml_claim_return_allowed`), reintegro (`ml_claim_partial_refund`) y exclusión; también los intentos que ML rechaza o cuyo resultado es incierto.

---

## 7. Límites

- Publicación rápida: hasta 50 productos por tanda; sugerencias de a 3 en paralelo; respeta el límite por cuenta de `ml_rate_take`.
- Visitas: a pedido, hasta 50 publicaciones por vez (un GET por ítem).
- Reclamos: la reconciliación trae hasta 200 abiertos y los cerrados de los últimos 3 días por corrida.
- Adjuntos: 3 por mensaje, jpg, png o pdf, 5 MB cada uno.
- Mensajes: 2.000 caracteres en reclamos, 3.500 en mensajes postventa.
- Reputación: la foto es diaria; ML calcula la reputación con su propio período (60 días para cuentas con muchas ventas, 365 para las chicas, como la cuenta de prueba).

---

## 8. Lo que queda fuera

- Reembolso total, revisión de la devolución (SRF2 a SRF7) y evidencia de envío: se hacen en ML (link directo). Son escrituras con dinero o con reglas que cambian seguido.
- Pedido de exclusión por API (no existe): se registra a mano.
- Bandejas de "colgados", etiquetas y tiempos de primera respuesta de ANDESMAR.
- Conciliación con el release report de Mercado Pago, cierre mensual y facturas de ML.
- Guía de acciones de mensajería (`action_guide`), Flex, Full y multi-origen (fase v2 de ADR-104).
- Publicar como **producto de catálogo** (buy box): el catálogo sólo se usa para precompletar.
- Avisos por email o WhatsApp: los avisos van al centro de notificaciones del POS.

---

## 9. Despliegue

1. Migraciones en orden: `20261127100000_ml_gestor_publicaciones` (parte A), `20261127100100_features_mercadolibre_gestor`, `20261127100200_ml_gestor_posventa` y `20261127100300_ml_gestor_cron` (parte B). Requieren las de ADR-104.
2. Edges: `ml_api` (parte A), `ml_worker` y `ml_webhook` (modificadas en la parte B: tópicos de reclamos, reconciliación y foto diaria) y `ml_gestor` (nueva, JWT, parte B).
3. DevCenter: tildar `claims` y `claims_actions` (`messages` es opcional).
