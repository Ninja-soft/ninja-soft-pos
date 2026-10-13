# 34 · Venta offline

> Estado: entregable conservador en `feat/venta-offline` (F3 · Venta offline / AFIP offline). Migración `20261103200000_venta_offline` sin aplicar. Decisión: [ADR-077](./17-decision-log.md#adr-077-venta-offline-conservadora-cola-local-idempotente-sync_offline_sale-y-revisión-del-dueño). Abrir y recargar el POS sin conexión (PWA, service worker): [ADR-087](./17-decision-log.md#adr-087-pos-instalable-que-abre-y-recarga-sin-conexión-service-worker-propio-shell-anónimo-y-sesión-local-h65-paso-pwa), §8. Lo que falta de offline-first (comandas, stock, caja) sigue en F14 · H65.

## 1. Qué resuelve

Si se corta internet (o NinjaSoft no responde) con el POS abierto, el cajero sigue cobrando. La venta queda guardada en el dispositivo con un ticket provisorio y, cuando vuelve la conexión, se envía sola y se registra con la misma lógica de siempre (`create_sale`). Nada se pierde: lo que el servidor no puede registrar queda en **Ventas offline** para que el dueño decida.

## 2. Qué se permite sin conexión

| Se permite | No se permite (necesita al servidor) |
|---|---|
| Efectivo (con vuelto) | QR y link de pago (Mercado Pago, MODO, etc.) |
| Transferencia manual (con o sin n° de operación) | Point y terminal de la marca (Payway, Nave, Fiserv) |
| Tarjeta en posnet con cupón (lote, cupón, autorización) | Terminal integrada de la caja (ADR-053) |
| Descuentos dentro del tope del rol, promo automática | Vale (saldo a favor) y cuenta corriente |
| Venta libre dentro del tope | Directo, packs y sesiones, cupones |
| | Mesas, delivery, turnos de agenda, cobros en espera |
| | Cambio manual de precio (pide PIN de supervisor) |
| | Abrir o cerrar la caja |

El POS sólo muestra los medios permitidos (`isTenderAllowedOffline`) y valida antes de guardar (`checkOfflineSale`). El servidor repite las mismas reglas al sincronizar (`_offline_sale_checks`): lo que no cumple va a revisión.

## 3. Límites del dueño (`pos_settings.offline_policy`)

Configuración > Operación > **Venta sin conexión** (dueño o encargado, RPC `offline_policy_save`, auditada).

| Clave | Default | Qué controla |
|---|---|---|
| `enabled` | `true` | Si el POS vende sin conexión. |
| `max_amount` | `50000` | Monto máximo por venta offline (ARS). |
| `max_sales` | `20` | Ventas offline por cajero y turno. |
| `max_hours` | `48` | Plazo para sincronizar sin revisión. |

Defaults conservadores: alcanzan para un corte de una o dos horas en un kiosco o comercio chico y limitan la exposición si el dispositivo se usa mal.

## 4. Cómo funciona

```
POS con conexión ── foto local (IndexedDB): catálogo con precios, política, turno
        │
   se corta ──> indicador "Sin conexión: vendiendo offline, N ventas por sincronizar"
        │        cobro → checkOfflineSale → cola local (client_sale_id uuid, hash SHA-256)
        │        ticket provisorio OFF-XXXXXXXX
        │
  vuelve ──> syncQueue → sync_offline_sale (una por una, en orden de venta)
                 ├─ synced (con o sin diferencias) → sale de la cola
                 ├─ needs_review → sale de la cola (la tiene el servidor)
                 ├─ sin red → queda, se reintenta (cada 30 s y al volver la red)
                 └─ rechazo duro → queda retenida en el dispositivo
```

- **Conectividad:** `navigator.onLine` + eventos `online`/`offline`. Si la red está pero NinjaSoft no responde (una venta falla por red), el POS pasa a offline y hace ping cada 15 s.
- **Corte durante un cobro:** si `create_sale` falla por red, la venta NO se guarda sola (pudo haber entrado): el POS pasa a offline y pide revisar Ventas antes de confirmar de nuevo.
- **Foto local:** `products` (mismo select del POS, hasta 5000) sin `cost`, `created_by`, `updated_by`, `tenant_id`; la política; el turno. Se renueva cada 10 minutos con conexión. Sin conexión, la búsqueda y el scanner (código, SKU, PLU) leen la foto. Los precios del carrito salen de los datos ya cargados (listas y contexto de precios en memoria).
- **Cola:** IndexedDB `ninja-pos-offline` (stores `queue` y `kv`). Cada entrada guarda negocio, usuario, turno, momento de la venta, el payload de `create_sale` y el hash SHA-256 canónico de todo eso. La cola se lee filtrada por negocio y usuario.
- **Cierre de caja:** bloqueado sin conexión y mientras haya ventas offline por enviar.

## 5. Servidor

- `sync_offline_sale(p_client_sale_id, p_sale, p_meta)` SECURITY DEFINER:
  1. Negocio y usuario activos; `p_meta.user_id` tiene que ser el que llama.
  2. **Idempotencia:** `offline_sales` único por `(tenant_id, client_sale_id)`; un reenvío devuelve el mismo resultado (`duplicate: true`). `sales.offline_client_id` es único por negocio como segunda barrera.
  3. Turno del negocio (si no, error duro `shift_not_found`).
  4. Reglas (`_offline_sale_checks`): política, medios, packs, cambio de precio, mesa, delivery y cupón, integridad, antigüedad.
  5. `_offline_run_sale`: llama a `create_sale` con los mismos parámetros y el GUC transaccional `ninja.offline_sync` dentro de un savepoint. El turno tiene que estar abierto y ser del cajero (regla de caja propia, ADR-051): si no, `create_sale` lo rechaza y la venta va a revisión.
  6. Marca la venta (`sales.offline_sold_at`, `sales.offline_client_id`) y audita (`offline_sale_conflicts`, `offline_sale_needs_review`).
- `create_sale` (copia de `20261102100300_promociones_venta`: impuestos + promociones) en modo offline:
  - **Precio cambiado:** se respeta el cobrado; el conflicto `price_changed` (lista y cobrado) vuelve en `offline_conflicts` y `sale_items.list_price` guarda el de lista.
  - **Stock insuficiente:** se vende igual (queda negativo) con `negative_stock` / `negative_stock_branch`.
  - **Promociones (ADR-074):** el motor se evalúa a la hora real de la venta (`ninja.offline_sold_at`). Si al sincronizar el descuento no coincide con lo que descontó el POS (promo vencida, editada o tope agotado), se respeta lo cobrado (una fila en `sale_promotions` con la promo que mandó el POS) y queda `promo_changed` (`charged`, `expected`, `expected_applied`). Un regalo que ya no corresponde se respeta y queda `promo_changed` con `gift: true`. Nunca `promo_mismatch` offline; si el plan no tiene `promociones`, la venta va a revisión.
  - Sin el GUC es idéntica a la anterior (precio y stock se siguen rechazando online).
- `offline_sale_resolve(p_id, p_action, p_note, p_cash_shift_id)` (dueño o encargado):
  - `retry`: registra en la caja de quien revisa (o en el turno original), sin las reglas de la política (las aprueba quien revisa).
  - `discard` / `resolve`: con motivo obligatorio. La fila queda (baja lógica).
  - `acknowledge`: da por vistas las diferencias de una venta registrada.
- **RLS** `offline_sales`: `tenant_id = current_tenant_id() or internal_scope()` (ADR-052, nunca `is_internal()` suelto), restrictiva por rol (el cajero ve las suyas) y por sucursal. Sin escritura por PostgREST.

## 6. Seguridad

- La foto local no guarda secretos: ni tokens, ni credenciales de medios de pago, ni costos. La sesión de Supabase sigue en su almacenamiento habitual; el POS sin conexión (§8) sólo la lee para saber el id del usuario y no guarda otra copia.
- La cola queda asociada a negocio, usuario y turno y firmada con SHA-256. La firma detecta un payload tocado en el dispositivo (va a revisión con `integrity_failed`); no es una firma criptográfica fuerte (la clave estaría en el mismo navegador). La garantía real es que **el servidor revalida todo**: usuario de la sesión, turno propio y abierto, precios contra la lista, topes de descuento, venta libre, plan, medios y política.
- Nunca se pierde una venta: el servidor guarda la fila antes de intentar registrarla y lo que falla queda en `needs_review`; el dispositivo sólo borra una entrada cuando el servidor confirmó que la tiene.

## 7. ARCA

La venta offline no se factura en el momento: el ticket es **provisorio** ("no válido como factura"). Al sincronizar, `create_sale` inserta la venta y la cola fiscal la toma como cualquier otra (en la rama de ARCA, el trigger `arca_sales_enqueue`), con CAE o, si ARCA no responde, CAEA. Pendiente para esa rama: usar `sales.offline_sold_at` como fecha del comprobante dentro de la ventana que acepta WSFE y reimprimir el ticket con CAE.

## 8. Abrir y recargar el POS sin conexión (H65, ADR-087)

El POS se puede **instalar** (celular o tablet: "Agregar a la pantalla de inicio", abre en `/pos`) y se puede **abrir o recargar sin conexión**.

```
POS con conexión ── registra el service worker (/sw.js, scope /pos)
        │            el SW guarda el shell anónimo /pos-offline y sus archivos
        │            el POS guarda la foto local y el puntero pos.last (negocio + usuario)
        │
 recarga sin red ──> SW: /pos no responde ──> sirve el shell guardado (misma URL)
                        shell: lee la sesión que Supabase ya guardó (sólo id y email)
                               + pos.last + la foto ──> ¿vende o sólo lectura?
```

**Qué guarda el service worker y qué no**

| Se guarda | Nunca se guarda |
|---|---|
| El shell `/pos-offline` (página estática, sin datos; se baja sin cookies) | El HTML de `/pos` (es personalizado) |
| `/_next/static/*` (scripts, CSS y fuentes con hash) | Nada de Supabase ni de otro dominio (REST, Auth, Storage, Realtime) |
| Íconos de `/brand/` y el manifest | `/api`, `/internal`, `/pagar`, `/auth`, webhooks, login, `/c/`, `/_next/image` |
| | Pedidos con `Authorization`, RSC o prefetch, métodos distintos de GET |
| | Respuestas con error, redirigidas, opacas, `no-store`, `private` o `Vary: *` |

El SW sólo controla las pantallas `/pos` y `/pos-offline` (scope `/pos`): el resto del panel no pasa por él.

**Cuándo se vende y cuándo es sólo lectura**

Se vende sólo con un usuario identificado: hay una sesión de Supabase guardada con refresh token, es del mismo usuario que dejó la foto, no pasaron 8 horas sin uso, la foto es de ese negocio y usuario, la venta offline está prendida, la foto no es más vieja que `max_hours` y tenía la caja abierta. Un access token vencido no frena: se renueva al volver la red. Si algo no cierra, el shell queda en **sólo lectura** y dice por qué ("La sesión es de otro usuario", "No hay una caja abierta", etc.); si el usuario es el mismo, se puede consultar el catálogo.

**Qué se vende en el shell:** productos simples de la foto al precio de la foto (sin variantes, series, modificadores, descuentos, clientes ni promociones), en efectivo con vuelto, transferencia o tarjeta en posnet con lote y cupón. Mismo payload, misma cola y mismas reglas que el POS abierto (§2 a §5): el servidor revalida todo al sincronizar. Cuando vuelve la conexión el shell envía la cola y ofrece **Abrir el POS completo**.

**Versión nueva:** cada deploy publica un `sw.js` nuevo. El POS muestra "Hay una versión nueva" con **Recargar**; con carrito o con el cobro abierto, el botón espera. Nunca recarga solo. Emergencia: `NEXT_PUBLIC_DISABLE_SW=1` desinstala el service worker en los dispositivos.

**Probarlo a mano:** `pnpm build && pnpm start -p 3005`, entrar a `/pos` con la caja abierta, esperar unos segundos (foto y service worker), en DevTools > Network marcar Offline (o cortar el wifi) y recargar.

## 9. Fuera de alcance (H65)

- El POS **completo** sin conexión (el shell es reducido), cajón de dinero, impresión con la impresora configurada (hoy `window.print()`), listas de precios y promociones en el shell.
- Mesas, delivery, cuenta corriente y vale offline, comandas, varios dispositivos con conflictos de stock, reconciliación de caja y numeración interna offline.

## 10. Archivos

| Capa | Archivo |
|---|---|
| Migración | `supabase/migrations/20261103200000_venta_offline.sql` |
| Lógica pura | `lib/pos/offline/{policy,queue,sync,snapshot,idb}.ts` |
| POS | `modules/pos/offline/{api,useOfflinePos}.ts`, `modules/pos/screen/usePosSale.ts`, `app/(app)/pos/page.tsx`, `components/pos/offline/*`, `components/pos/checkout/CheckoutSheetConnected.tsx` |
| Dueño | `app/(app)/ventas-offline/page.tsx`, `components/sales/OfflineSalesPanel.tsx`, `components/config/OfflinePolicyCard.tsx` |
| PWA (ADR-087) | `lib/pwa/{sw.worker.js,version.ts,update.ts}`, `app/sw.js/route.ts`, `app/manifest.ts`, `app/pos-offline/page.tsx`, `components/pos/offline/PosOfflineScreen.tsx`, `components/pwa/SwUpdateBanner.tsx`, `modules/pwa/useServiceWorker.ts`, `modules/pos/offline/offlineSession.ts`, `lib/pos/offline/{session,shellCart}.ts`, `public/brand/pwa-*.png` |
| Tests | `tests/unit/offline{Queue,Policy,Sync,Session}.test.ts`, `tests/unit/pwa{ServiceWorker,Shell}.test.ts`, `tests/integration/rls-venta-offline.test.ts`, `tests/e2e/venta-offline.spec.ts` (sólo local con `E2E_OFFLINE=1`), `tests/e2e/pwa-offline.spec.ts` (`@pwa`, sólo local con build de producción y `E2E_PWA=1`) |
