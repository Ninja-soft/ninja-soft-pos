# 38 · Mercado Libre (H87 · ADR-104)

Integración del POS con Mercado Libre: cuentas conectadas por negocio, publicaciones vinculadas a los productos, stock y precio sincronizados, ventas que entran como ventas del POS, facturación ARCA subida a la venta, etiquetas de envío y preguntas.

Esta rama es la **fase MVP**. Las fases v2 (Full, Flex, multi-origen, planificador de envíos a Full, ME1, reclamos y mensajería) y v3 (central de promociones, métricas, Product Ads) usan el mismo modelo de datos (ver "Fases").

Fuente: documentación oficial de developers.mercadolibre.com.ar leída el 2026-10-13. Lo marcado **[confirmar]** hay que validarlo con un usuario de test antes de piloto.

---

## 1. Paso a paso para poner en marcha

### 1.1 Cuenta dueña de la app

1. Usar la cuenta de Mercado Libre **de la empresa NinjaSoft** (persona jurídica) con los datos del titular **validados**: en Argentina no se puede crear una app sin eso.
2. Desde el 30/08/2026 las apps de Mercado Libre y de Mercado Pago van **separadas**. La app de Mercado Pago que ya existe (H15) no sirve: hay que crear una nueva sólo para Mercado Libre.

### 1.2 Crear la app en DevCenter

En [Mis aplicaciones](https://developers.mercadolibre.com.ar/es_ar/crea-una-aplicacion-en-mercado-libre-es) > **Crear aplicación**:

| Campo | Valor |
|---|---|
| Nombre | NinjaSoft POS (único en ML) |
| Nombre corto | ninjasoft-pos |
| Descripción (se le muestra al vendedor al autorizar, máx. 150) | "Conectá tu cuenta de Mercado Libre con NinjaSoft POS: stock, precios, ventas, facturación y envíos desde tu punto de venta." |
| Logo | El isotipo de NinjaSoft (brandBook) |
| **URI de redirect** | `https://<dominio de la app>/api/ml/oauth/callback` (exacta, HTTPS, sin parámetros). Producción hoy: `https://<APP_URL>/api/ml/oauth/callback` |
| **PKCE** | Activado (después es obligatorio, y el POS siempre lo manda) |
| Scopes | `offline_access`, `read`, `write` |
| **URL de notificaciones** | `https://hooks.soft.ninja/ml` (dominio propio, ADR-069; se copia desde el panel interno). Alternativa directa: `https://hrkditzrsavehnhngakb.supabase.co/functions/v1/ml_webhook` |

**Permisos funcionales** (lectura y escritura salvo aclaración):

- Usuarios (viene por defecto).
- Publicación y sincronización (items, pictures, prices).
- Ventas y envíos (orders, shipments, packs; Flex y Full para v2).
- Comunicación pre y postventa (questions; messages, claims y returns para v2).
- Facturación (invoices, billing): para subir la factura al pack.
- Métricas del negocio (lectura).
- Promociones, cupones y descuentos (v3; se puede tildar ya).
- Publicidad: sólo lectura (v3).

Si falta un permiso, ML responde `403 PA_UNAUTHORIZED_RESULT_FROM_POLICIES` y el POS muestra "A la app de Mercado Libre le falta un permiso funcional".

**Tópicos** a tildar:

| Tópico | MVP | Uso |
|---|---|---|
| `orders_v2` | sí | Altas, pagos, cancelaciones y fraude de las órdenes |
| `items` | sí | Cambios de publicaciones hechos desde ML |
| `items_prices` | sí | Precio cambiado en ML (promos, automatización) |
| `questions` | sí | Bandeja de preguntas |
| `shipments` | sí | Estado del envío (facturar al despachar, etiquetas) |
| `user_products`, `stock-location`, `fbm_stock_operations`, `flex-handshakes` | v2 | Se guardan como `ignored` hasta v2 |
| `messages`, `post_purchase`, `payments`, `invoices` | v2 | Ídem |
| `public_offers`, `public_candidates`, `catalog_item_competition_status`, `price_suggestion` | v3 | Ídem |

Tildar ya los de v2 y v3 no tiene costo: llegan, se guardan en el inbox como `ignored` y se borran a los 15 días.

**Rotación del secret:** usar "Programar renovación" (deja hasta 7 días de convivencia) y cargar la clave nueva en el panel interno > Mercado Libre dentro de esa ventana (o el secret de Supabase, si la app sigue configurada por Edge).

### 1.3 Configurar la app (panel interno, ADR-126)

Desde **panel interno > Mercado Libre** (`/internal/mercadolibre`, cualquier staff interno, igual que Pagos de plataforma):

1. **App ID** y **Clave secreta** de DevCenter. La clave es write-only: se guarda por la Edge `set_platform_secret` en `platform_secrets` key `ml_app` (RLS deny a todos, sólo service_role) y nunca vuelve al navegador; se ve "Guardada, termina en xxxx".
2. **Redirect URI**: la sugerida (`<dominio de la app>/api/ml/oauth/callback`) con botón copiar y "Usar esta Redirect URI". Tiene que ser idéntica a la de DevCenter.
3. **URL de notificaciones** (`https://hooks.soft.ninja/ml`) y **tópicos** a tildar, con botón copiar.
4. **Probar conexión**: valida App ID + Clave secreta contra `POST /oauth/token` sin tocar cuentas de clientes (`client_credentials`; si ML no lo acepta, un `refresh_token` inventado: `invalid_grant` = par correcto, `invalid_client` = par incorrecto). Si ML devuelve los datos de la app, avisa si la Redirect URI o la URL de notificaciones registradas en DevCenter son otras.
5. Resumen: negocios con cuenta conectada, cuentas que piden reconectar y últimas notificaciones (24 h y errores).

Cada guardado, prueba y borrado queda en `audit_logs` (`platform_secret_set`, `platform_secret_tested`, `platform_secret_cleared`) sin valores.

**Prioridad de orígenes** (`resolveMlConfig`, `_shared/mercadolibre/config.ts`): si `platform_secrets.ml_app` tiene App ID y Clave secreta válidos, rige esa (la Redirect URI, si falta ahí, sale del env); si no, rigen los **secrets de Edge** como antes. Nunca se mezclan id y clave de orígenes distintos. "Borrar lo cargado acá" vuelve a los secrets de Edge. Las Edges ML leen la config con service_role una vez por invocación (`mlConfig(admin)`); `ml_webhook` la memoriza 60 s por isolate para no sumar una lectura a cada aviso (presupuesto de 500 ms).

**Compatibilidad (secrets de Edge):** siguen funcionando sin cambios.

```bash
supabase secrets set ML_CLIENT_ID=<APP_ID numérico> ML_CLIENT_SECRET=<secret>
# Opcional: si la URI de redirect no es <APP_URL>/api/ml/oauth/callback
supabase secrets set ML_REDIRECT_URI=https://<dominio>/api/ml/oauth/callback
# Si APP_URL no está cargado como secret de Edge:
supabase secrets set APP_URL=https://<dominio>
```

Mientras no haya ninguna config completa, el POS muestra **"Falta configurar la app de Mercado Libre"** al conectar y las Edge responden `ml_app_not_configured` (503). Nada falla en silencio.

### 1.4 Desplegar

1. Migraciones en orden: `20261110400000_features_mercadolibre`, `20261110400100_mercadolibre_base`, `20261110400200_mercadolibre_rpc`, `20261110400300_mercadolibre_cron`. La última necesita `pg_cron`, `pg_net` y el secret interno `platform_secrets('internal_cron')` (el mismo que usa ARCA).
2. Edge Functions: `ml_oauth_start`, `ml_oauth_callback` (pública), `ml_webhook` (pública), `ml_worker`, `ml_api`. Para configurar la app desde el panel interno, también `set_platform_secret` (ADR-126). Las públicas están en `supabase/config.toml` y en `PUBLIC_FUNCTIONS` de `scripts/deploy-check.mjs` (`node scripts/deploy-check.mjs` lo verifica).
3. Front (Vercel): la ruta `/api/ml/oauth/callback`.

### 1.5 Usuarios de test

ML **no tiene sandbox**: se prueba en producción con usuarios de test.

```bash
# Con un access token de la cuenta dueña de la app:
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"site_id":"MLA"}' https://api.mercadolibre.com/users/test_user
```

- Crear al menos un **vendedor** y un **comprador**, y **guardar las credenciales** (no se recuperan). Hasta 10 por cuenta; se borran a los 60 días sin uso. Sólo operan entre ellos.
- El código de validación por email son los últimos dígitos del user_id.
- Publicaciones de prueba: título "Item de Prueba - Por favor, NO OFERTAR", categoría "Otros", **nunca gold / gold_pro** (usar `free` o la que indique ML para test).
- Pagos con las tarjetas de prueba de Mercado Pago (titular "APRO").
- User Products y multi-origen requieren pedir la **ambientación** del usuario de test por formulario (UP cada 7 días; multi-origen los viernes cada 15 días).
- Full, Flex y el Facturador de ML probablemente no se pueden ambientar en test **[confirmar]**: para v2 hace falta una cuenta real piloto en modo solo lectura.

### 1.6 Checklist de aceptación del MVP

1. Conectar la cuenta del vendedor de test en Configuración > Integraciones > Mercado Libre (sólo el usuario **administrador** de la cuenta de ML; un colaborador recibe `operator_user`).
2. Vincular una publicación existente (Importar publicaciones -> sugerencia por SKU) y publicar un producto con 2 variantes (Validar da OK, la publicación queda activa con foto y precio del canal).
3. Comprar con el comprador de test: aparece **una** venta en Ventas aunque la notificación llegue varias veces; baja el stock de la sucursal configurada; se ve la comisión en Mercado Libre > Ventas.
4. Vender en mostrador: en menos de 2 minutos la publicación tiene el stock nuevo.
5. Con facturación ARCA activa y "Al pagarse": CUIT -> Factura A (emisor RI), DNI -> B; la factura aprobada queda subida a la venta en ML.
6. Etiqueta ME2 en PDF y ZPL para un envío `ready_to_print`; una orden con fraude no deja imprimir.
7. Cancelar la compra en ML: la venta se anula y el stock vuelve.

---

## 2. Cómo funciona

### 2.1 Piezas

| Pieza | Qué hace |
|---|---|
| `ml_oauth_start` (JWT) | Dueño o encargado con la feature: crea state + code_verifier (PKCE S256) y devuelve la URL de autorización |
| `/api/ml/oauth/callback` (Next) | Recibe `code` y `state` del redirect y los manda a `ml_oauth_callback` |
| `ml_oauth_callback` (pública) | Consume el state (un solo uso, 15 min), canjea el code, lee `/users/me` y da de alta o reconecta la cuenta |
| `ml_webhook` (pública) | Valida y guarda la notificación cruda en `ml_notifications` con una RPC; responde 200 sin llamar a ML |
| `ml_worker` (cron) | `cron` cada minuto: inbox y después la cola de escrituras; `reconcile` cada 10 min: missed_feeds y órdenes recientes; `tokens` cada hora |
| `ml_api` (JWT) | Predictor de categoría, atributos, validar, publicar, importar y sugerir vínculos, etiquetas, sincronizar ya |
| `_shared/mercadolibre/*` | Cliente HTTP tipado (errores, 401 con token nuevo, 429, gate de límite), OAuth y lock, notificaciones, órdenes, publicaciones, stock, etiquetas, PDF de la factura y el worker. Puros y testeados |

### 2.2 Datos

| Tabla | Contenido | Acceso de clientes |
|---|---|---|
| `ml_accounts` | Cuentas por negocio y su configuración | lectura del negocio |
| `ml_tokens`, `ml_oauth_states`, `ml_rate_buckets` | Secretos y límites | ninguno (sólo service_role) |
| `ml_location_map` | Origen del stock por ubicación de ML | lectura del negocio |
| `ml_notifications`, `ml_sync_jobs` | Inbox y outbox | lectura de dueño o encargado |
| `ml_items`, `ml_item_links` | Publicaciones y vínculos con productos | lectura del negocio |
| `ml_orders`, `ml_shipments`, `ml_questions` | Órdenes (con su venta), envíos y preguntas | lectura del negocio |

Las escrituras van sólo por RPC SECURITY DEFINER (UI: `ml_assert` con rol y feature) o por service_role (Edge). `sales.channel = 'mercadolibre'` y `sales.channel_ref` (pack) marcan las ventas del canal.

### 2.3 Reglas de ML que el diseño respeta

- **Refresh token de un solo uso**: renovación con lock por cuenta en la base; `invalid_grant` -> "reconectar".
- **Callback en menos de 500 ms**: el webhook sólo inserta; el GET del recurso lo hace el worker.
- **Sin firma**: application_id, user_id conocido, patrón del recurso y GET autenticado.
- **Duplicados**: inbox único por `_id`; venta única por pack (lock + `sale_id`); stock aplicado una vez (`stock_applied_at`) y revertido una vez (`stock_reverted_at`).
- **Pack = unidad de facturación**: una venta del POS por carrito; la factura se sube a `/packs/{pack_id|order_id}/fiscal_documents` (PDF, máx. 1 MB).
- **x-version** en el stock del User Product y reintento ante 409.
- **Automatización de precios**: si ML la tiene activa, el POS no pisa el precio.
- **Límites**: token bucket por cuenta y familia (stock de UP a 90 RPM, el documentado es 100) y backoff exponencial con jitter ante 429.
- **No mensajes automáticos**, no se modifica la etiqueta, no se clonan publicaciones.
- **Atributos condicionales** (`items.ts`): los tags `new_hidden`, `used_hidden` y `refurbished_hidden` de `/categories/{id}/attributes` dicen para qué condición no aplica un atributo (GRADING sólo va en reacondicionados; en MLA1644 el GTIN no va en usados). No se muestran ni se mandan, y la Edge descarta además los ocultos y de solo lectura. Si ML responde `delete.item.attribute.*`, se saca el atributo y se valida otra vez (un solo reintento, avisado).
- **Modo de envío** (`shipping.ts`): antes de publicar se leen `/users/{id}/shipping_preferences`, `/categories/{id}/shipping_preferences` y `/users/{id}/shipping_modes?category_id=` (la más precisa). Orden: `me2` si vendedor y categoría lo admiten; si no, `not_specified` (a convenir) o `custom` (costos fijos). Nunca `me1`. Envío gratis sólo con `me2`. Si ML igual responde `shipping.lost_me2_*`, se pasa a a convenir y se reintenta una vez. Verificado el 2026-10-15 con la cuenta conectada: MLA1644 (aires) no admite me2; MLA1055 y MLA1652 sí.
- **Predictor**: se filtran las categorías de prueba de ML (nombre o dominio con "Test").
- **Errores de validación**: `mlCauseInfo` (`lib/mercadolibre/labels.ts`) traduce los códigos frecuentes (`shipping.*`, `item.attribute(s).*`, `item.price.*`, `item.title.*`, `item.pictures.*`) con la acción a tomar; el código crudo queda en un detalle desplegable.

### 2.4 Stock y precio

- Stock publicado = stock de la sucursal elegida (o del depósito, ADR-085) menos reservas de clientes (ADR-091) menos la reserva de seguridad de la cuenta. Valor absoluto, entero, nunca negativo. Productos que no llevan stock no se empujan.
- Una venta de mostrador, una compra, un ajuste o un movimiento de depósito encola el push (trigger); el valor se calcula al enviar.
- Precio del canal = lista de precios de la cuenta, o precio del POS más el margen, redondeado hacia arriba. Cambios de precio del producto, la variante o la lista encolan el push. Por publicación se puede dejar el precio "manual" (no se pisa).

### 2.5 Ventas, cancelaciones y facturación

- La orden pagada entra como venta del POS: canal Mercado Libre, sin turno de caja, medio **Mercado Libre** (no mueve caja), cliente desde los datos de facturación, comisión y envío en la pantalla de Mercado Libre.
- Publicación sin vincular: la venta se registra igual, sin descontar stock, y la orden queda "a revisar".
- Fraude (`fraud_risk_detected`): no se crea la venta y no se imprime etiqueta.
- Cancelación: revierte el stock y anula la venta (si estaba facturada, ARCA emite la NC). Carrito con órdenes canceladas y otras no: queda "a revisar".
- Facturación por cuenta: al pagarse, al despacharse, a mano (botón Facturar) o no facturar. Tipo de comprobante: CUIT -> A, DNI -> B para un emisor RI; monotributo emite C.
- Con la feature `mercadolibre_facturacion` (ADR-141): cupones, envío, padrón de ARCA, elección por venta, al entregarse, bandeja en lote, percepciones por link de pago y qué se sube a ML. Ver [`43-mercadolibre-facturacion.md`](./43-mercadolibre-facturacion.md).

### 2.6 Errores que ve el usuario

| Código | Mensaje |
|---|---|
| `ml_app_not_configured` | Falta configurar la app de Mercado Libre |
| `feature_not_in_plan` | Tu plan no incluye Mercado Libre |
| `operator_user` | Conectá con el usuario administrador de la cuenta, no con un colaborador |
| `ml_account_taken` | Esa cuenta de Mercado Libre ya está conectada a otro negocio |
| `reauth_required` / `invalid_grant` | La conexión venció: reconectá la cuenta |
| `missing_permission` | A la app le falta un permiso funcional en DevCenter |
| `rate_limited` | Mercado Libre pidió bajar el ritmo: se reintenta solo |

---

## 3. A confirmar con usuarios de test

- Forma del billing-info en MLA: se soportan el formato nuevo (`/orders/billing-info/MLA/{id}`) y el anterior (`/orders/{id}/billing_info`).
- `sale_fee` de `order_items` por unidad (la comisión total se calcula por cantidad).
- `response_type=zpl2` devuelve un ZIP con el `.txt` (se soportan ZIP y texto plano).
- Tag de la automatización de precios en el ítem (además se detecta por el 400 de ML).
- `missed_feeds` leído con el token de una cuenta vendedora.
- El PDF del comprobante armado en el servidor es aceptado por `fiscal_documents`.
- Si la NC se puede subir al pack después de la factura (un documento por tipo).

---

## 4. Fases

| Fase | Alcance | Modelo |
|---|---|---|
| **MVP** (esta) | Conexión multi-cuenta, webhook + worker + reconciliación, vincular y publicar (UP y clásico), pausar y activar, stock y precio, órdenes -> ventas, cancelaciones, facturación ARCA + PDF al pack, etiquetas ME2, preguntas | Todo lo de arriba |
| **v2** | Full y Flex con `selling_address` y depósito virtual Full, multi-origen (`seller_warehouse`), planificador de envíos a Full, ME1 con tracking V2, Flex (zonas, cadetes), reclamos y devoluciones con NC, mensajería postventa, catálogo y competencia, edición masiva grande | `ml_location_map` con más tipos, `ml_shipments.me1_tracking`, más `kind` en `ml_sync_jobs`, tópicos ya guardados |
| **v3** | Central de promociones con simulador de margen, métricas (visitas, conversión, reputación, calidad), Product Ads en lectura, sugerencias de precio, Facturador de ML (`invoice_mode = 'ml_billing'`), asistente IA para títulos | Tablas nuevas de promociones; `invoice_mode` ya contempla `ml_billing` |
