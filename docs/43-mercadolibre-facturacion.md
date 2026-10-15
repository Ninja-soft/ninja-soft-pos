# 43 · Facturación de Mercado Libre (H142 · ADR-141)

Cómo se facturan las ventas de Mercado Libre en NinjaSoft POS con reglas y configuración amplia, tomado de cómo factura hoy ANDESMAR a gran escala. Se apoya en la integración de ADR-104 ([`38-mercadolibre.md`](./38-mercadolibre.md)), el gestor de ADR-132 ([`41-mercadolibre-gestor.md`](./41-mercadolibre-gestor.md)), la cola de ARCA de ADR-072 ([`33-facturacion-arca.md`](./33-facturacion-arca.md)) y la matriz de comprobantes y el padrón de ADR-133.

Pedido del dueño: "acá [modal Vincular con un producto] debe mostrar las fotos de productos; deberé poder elegir qué factura se sincroniza; revisá cómo facturo hoy en Meli Omni ANDESMAR para tener en cuenta cosas, como contraparte, cupones, envíos a convenir, cómo se factura, eso, cobro de percepciones por link de pago como tengo hoy; que sea robusta la facturación con una amplia configuración."

> **Aviso normativo.** Alícuotas, mínimos, topes y criterios de percepción son **orientativos** (los de ANDESMAR al 14/09/2026). Se guardan como configuración de la cuenta, nunca como constantes, y hay que validarlos con el contador del negocio.

---

## 1. Cómo factura hoy ANDESMAR

ANDESMAR (`C:\Users\Lucas\Documents\GitHub\ANDESMAR`, sólo lectura) factura las ventas de Mercado Libre con un módulo propio, **MeliOmni**, y dos ERP que hablan con ARCA (Presea/Neuralsoft y el POS de Napse). Ningún código de ANDESMAR llama a WSFE directo: el ERP emite y devuelve el número y el PDF.

### 1.1 Piezas

| Pieza | Dónde | Qué hace |
|---|---|---|
| Pantalla de facturación | `facturacionMeliOmni.html`, `js/jsMeliOmni/meliOmni.js`, `meliOmniModal.js` | Bandejas (pendientes, urgentes, a convenir, reversiones), detalle de la orden, botones "Facturar", flujo de notas de crédito |
| Armado del payload (front) | `js/jsMeliOmni/presea/omniBilling.js`, `omniBillingEditor.js`, `omniBillingManual.js` | Copia del armado del servidor y editor de la configuración |
| Percepciones (UI) | `js/jsMeliOmni/percepcionesConfig.js`, `guia-percepciones.html` | Reglas por jurisdicción, estrategia por tipo de envío, mensaje |
| Napse | `js/jsMeliOmni/napse/omniNapse.js`, `omniNapseManual.js`, `js/jsNapse/facturacionNapseOmni.js`, `docs/napse-meliomni/CONTEXTO.md` | Segundo método de facturación (POS Napse, CAEA) |
| Control de margen | `controlFacturacionMeli.html`, `js/jsMeliOmni/controlFacturacion.js`, `controlFactCalc.js` | Comisión, envío del vendedor, internos, utilidad por línea (no es control fiscal) |
| Cruce de IVA y caja | `js/jsMeliOmni/omniCruzarMp.js` (muestras en `Cruce de IVA/`) | Libro IVA y libro de caja del ERP contra las ventas: faltantes, duplicadas, NC vinculadas, retenciones |
| Edge principal | `supabase/functions/meli-omni/index.ts` (rutas en 7673-7714) | Webhook y barrido de órdenes, `billing-presea`, `billing-manual`, `billing-auto`, `percep-*`, `buyer-doc` |
| Armado y ciclo automático | `supabase/functions/meli-omni/billing.ts` | `buildItems`, `buildValores`, `validatePayloadText`, `runAutoBilling` |
| Percepciones (servidor) | `supabase/functions/meli-omni/percepciones.ts`, `percepcion-gate.ts` | Monto, filas del padrón, reglas por jurisdicción, ajuste de letra |
| Padrón de ARCA | `supabase/functions/afip-padron` | A5 `getPersona`, cache de 30 días |
| Subida del PDF | `supabase/functions/meli-invoice-sync/index.ts` | `POST /packs/{id}/fiscal_documents`, reintentos y reemplazo |
| Envío a convenir | `supabase/functions/meli-envio-pago` | Trae el pago del envío y lo factura aparte |
| Cierre y reportes | `docs/cierre-mensual-ml.md`, `docs/reportes-ml.md`, Edges `cierre-ml`, `mp-report` | Release report, retenciones por provincia, facturas de ML |
| Auditoría con IA | `docs/factura-ia.md`, Edge `factura-ia` | Transcribe cada PDF y lo compara con lo que se tenía que facturar |
| Percepciones: casos | `docs/percepciones-iibb.md`, `docs/percepciones-reglas-por-jurisdiccion-2026-09-14.md`, `docs/percepciones-cobradas-sin-facturar-2026-09-14.md` | Reglas vigentes y el incidente de percepciones cobradas que Napse no facturó |

### 1.2 Flujo de una orden

1. **Ingreso** (`processOrder`, `meli-omni/index.ts:413-873`): orden, envío (`x-format-new`), `billing_info` y pagos. Documento desde `billing_info` o, si falta, del pagador. Provincias bloqueadas (Tierra del Fuego) quedan `ibb_bloqueado` y nunca se facturan.
2. **Cuándo**: automático poco después del pago (`runAutoBilling`, `billing.ts:798-1147`: pagada, sin mediación, demora configurable, de a 15 por corrida, con *circuit breaker*), o a mano.
3. **Letra**: el ERP la deduce del tipo de documento y responsable (`omniBilling.js:151-177`): DNI → B, CUIT → A; después la ajusta con el padrón de ARCA (`ajustarLetraPorCondicionArca`, `percepcion-gate.ts:620-642`): exento → B con el mismo CUIT; consumidor final → B (para CUIT de persona, el DNI de adentro); RI, monotributo o sin respuesta → A. Razón social y domicilio fiscal salen del padrón, no del nombre del comprador.
4. **Renglones** (`buildItems`, `billing.ts:234-391`): uno por ítem a `unit_price` (el descuento del vendedor ya viene en el precio), más el envío y el cupón. Recibo (`buildValores`): un valor por pago aprobado por `transaction_amount − coupon_amount` (sin intereses de tarjeta).
5. **Control antes de mandar** (`validatePayloadText`, `billing.ts:565-627`): Σ renglones = facturable y recibo = facturable + percepción pagada, con $ 1 de tolerancia; si no cierra, queda para facturar a mano.
6. **Resultado**: número de factura, nota de venta, recibo y cliente; unicidad por letra; nota privada en la venta de ML; un resultado incierto (timeout) nunca se reintenta solo.

### 1.3 "Contraparte" y cupones

En ANDESMAR **"contraparte" es el cupón**: la parte del precio que paga Mercado Libre (o la campaña) y no el comprador (`payments[].coupon_amount`, migración `0046_concil_coupon_guard_from_payments.sql`). El detalle lo muestra como "Contraparte (cupón) −$X · Facturar este pago por $neto" (`meliOmniModal.js:405-411`) y la conciliación vieja marca "SE FACTURÓ POR ERROR CONTRAPARTE" cuando la factura quedó por el precio lleno.

- Facturable (trigger `compute_total_facturable`, migración 0059): `Σ (transaction_amount + shipping_cost − coupon_amount)` de los pagos aprobados.
- Presea: **renglón negativo** "DESCUENTO CUPON ML" con los productos a precio de lista (por defecto) o el cupón **prorrateado** en los precios (`discountLine.prorratear`). Napse: siempre prorrateado.
- Descuentos del vendedor: ya están en `unit_price`.

### 1.4 Envío

- Lo que pagó el comprador, en este orden: Σ `payments[].shipping_cost`, `shipment.lead_time.cost`, `shipping_option.cost` (ME1), o `total_amount − Σ(precio × cantidad)`.
- Renglón "ENVIO" sólo si es mayor a cero. Gratis, bonificado, Full, Flex o ME2 gratis: sin renglón.
- **Envío a convenir** (`logistic_category = "A convenir"`): el producto se factura igual; la venta queda en la bandeja "A convenir" y, cuando el comprador paga el envío aparte, se trae el pago (`meli-envio-pago`) y se emite **otra factura** sólo con el envío (`meliOmni.js:7690-7810`).

### 1.5 Comisiones y cargos

Nunca van en la factura al comprador. `sale_fee`, costo de envío del vendedor y retenciones se guardan para el margen (`controlFactCalc.js`) y el cierre mensual (release report: comisiones y Melilog a proveedores, retenciones a clientes por provincia; facturas de ML con percepciones, asesoría y comisiones).

### 1.6 Notas de crédito

- Cancelada antes de facturar: no se factura y se deja nota en ML.
- Cancelada después: `cancelado_pos_facturacion` y **NC a mano** con un circuito de reversión (`meliOmni.js:8471-8637`: solicitado, informado, NC confirmada, completa). No hay NC automática en ningún ERP; las mediaciones no se facturan solas y los reintegros parciales tampoco generan NC.

### 1.7 Percepciones de IIBB y el link de pago

Sólo a compradores con CUIT que figuran en algún padrón (`evalPercepcionOrden`, `meli-omni/index.ts:3698-3778`).

- **Monto** (`calcularMonto`, `percepciones.ts:65-95`): `neto = facturable / IVA ponderado` (envío al 21 %); base neta para RI y monotributo, total para exentos; `monto = round2(base × Σ alícuotas / 100)`.
- **Fila del padrón** (`elegirFilasPadron`, `percepciones.ts:571`): la vigente hoy (hora de Argentina); si no hay, la más nueva, salvo que el período actual de esa jurisdicción ya esté cargado (entonces el CUIT salió del padrón).
- **Reglas por jurisdicción** (`evaluarPercepcion`, `percepcion-gate.ts:84-279`, valores del 14/09/2026):
  - ARBA: base mínima $ 3.500; tramo local con la alícuota del padrón al 100 % de la base; Convenio Multilateral al 50 %.
  - Santa Fe (API): igual, base mínima $ 360.000.
  - Salta (DGR): base mínima $ 1.000; alícuota fija 3,6 % (100 % local, 50 % CM); no percibe si el CUIT figura en otro padrón.
  - Modo **acumulado** (todos los padrones del CUIT) o **destino** (sólo la provincia del envío).
- **Estrategia por tipo de envío** (`percepciones_config.porTipo`): ME1, ME2 y a convenir → **mensajear** (se retiene la factura y se cobra por link); Full y Flex → **factura B** inmediata sin percepción (y un link listo por si el comprador pide A).
- **Link de pago** (`crearLinkPagoMP`, `holdMensajear`, `meli-omni/index.ts:3940` y `4717-4834`): preferencia de Mercado Pago "Ajuste Percepciones Impositivas - Venta Mercado Libre #orden" por el monto, `external_reference = percep-<orden>`, **link completo** (con acortador el pago bajó del 61 % al 3 %), mensaje por la guía de acciones de ML (350 caracteres sin cortar la URL) o por mensajes postventa, vence a los 2 o 3 días (o a fin de mes si cambia la alícuota).
- **Resolución** (`resolverPercepciones`, cada 30 minutos): pagado → factura A con la percepción; vencido → factura B (o "falta DNI" si es empresa sobre el tope); pagado tarde → revisar.
- **Lección** (`docs/percepciones-cobradas-sin-facturar-2026-09-14.md`): 52 facturas A donde el comprador pagó el link y el POS percibió 0, por $ 343.128,32, porque el POS tomaba la alícuota de la ficha del cliente y no la enviada. Conclusión para NinjaSoft: **lo cobrado y lo facturado tienen que salir del mismo cálculo guardado**, y se controla antes de emitir.

### 1.8 Subida a Mercado Libre

`meli-invoice-sync`: `POST /packs/{pack_id|order_id}/fiscal_documents` multipart (`fiscal_document`, PDF), 401 renueva el token una vez, "already/exist/limit" o un documento ya presente cuentan como hecho, hasta 24 intentos; si cambia el número, `DELETE` del documento y se vuelve a subir.

### 1.9 Control

- **Cruce IVA + Caja** (`omniCruzarMp.js:463-2805`): ventas contra libro IVA y caja; faltantes, duplicadas, diferencias, NC vinculadas y retenciones de agentes.
- **Reportes ML** (`docs/reportes-ml.md`): release report diario contra los recibos; facturable = precio − cupón + envío + percepción.
- **Factura IA** (`docs/factura-ia.md`): transcribe cada PDF y lo compara con lo esperado; encontró A a exentos o consumidores finales y percepciones cobradas distintas de las facturadas.

### 1.10 Trampas conocidas

- La fecha del comprobante en hora de Argentina (con UTC salieron 4.300 comprobantes con el día siguiente).
- El nombre de ML es de quien compró, no del titular del CUIT: la razón social sale del padrón.
- B a una empresa: no puede llevar el CUIT; consumidor final sin identificar bajo el tope (RG 5700/2025) o pedir DNI.
- Carritos: una factura por carrito, el PDF se sube por pack.
- Pagos agregados después de facturar y mediaciones: no se facturan solos.

---

## 2. Reglas de negocio en NinjaSoft

| Tema | Regla | Configurable |
|---|---|---|
| Unidad | Una factura por carrito (pack) = una venta del POS (ADR-104) | No |
| Renglones | Precio de la publicación (`unit_price`); el descuento del vendedor ya está adentro | No |
| Cupón (contraparte) | Renglón de descuento (por defecto, como Presea), repartido en los precios (como Napse) o sin descontar | Por cuenta |
| Envío | Renglón con lo que pagó el comprador (pagos, o el costo si el pago lo incluye). Gratis, bonificado, Full o a convenir: sin renglón. A convenir avisa que el envío cobrado aparte se factura aparte | Por cuenta (sí/no y texto) |
| Comisiones y cargos de ML | Nunca en la factura | No |
| Control | Lo cobrado (Σ pago + envío − cupón) contra la factura; si difiere más que la tolerancia, la venta queda **a revisar** y no sale sola | Tolerancia por cuenta |
| Receptor | Variante **datos del comprador**: `billing_info` de ML con la condición, razón social y domicilio del **padrón de ARCA** si el CUIT ya se consultó (ADR-133, cache compartida). Variante **consumidor final**: DNI (o el DNI del CUIL), pasaporte o sin identificar | Por cuenta (siempre consumidor final, usar padrón, DNI del CUIL, empresa sin identificar) y por venta |
| Letra | La sugerida por la condición; forzada sólo dentro de la matriz de ARCA (`cbte_letter_check`); la cola vuelve a validar (`_arca_blocker`) | Por venta |
| Consumidor final por encima del tope | Sin documento: a revisar | Tope de ARCA (`cf_id_threshold`) |
| Punto de venta | El de la cuenta o el de la sucursal | Por cuenta y por venta |
| Concepto | Según los productos, o fijo | Por cuenta y por venta |
| PDF | A4 o ticket de 80 mm | Por cuenta y por venta |
| Cuándo | Al pagarse, al despacharse, al entregarse, a mano por lote o no facturar | Por cuenta |
| Jurisdicciones bloqueadas | El envío a esas provincias no se factura (Tierra del Fuego en ANDESMAR) | Por cuenta |
| Percepciones | Sólo con CUIT, condición alcanzada y el negocio agente (`percepciones_retenciones`); reglas por jurisdicción (padrón, fija o cero; % de base; mínimos de base y de monto; base neta o total; exentos sobre el total), modo acumulado o destino | Por cuenta |
| Estrategia por envío | Cobrar por link antes de la A (ME1, ME2, propio, a convenir), factura B sin percepción (Full, Flex) o A sin percibir | Por cuenta y por venta |
| Link | Mercado Pago del negocio, monto del servidor, vence en N días; al vencer: B, A sin percibir o a revisar; pagado tarde: a revisar; también "cobrada por otro medio" con referencia | Por cuenta |
| Subida a ML | La factura según la cuenta; las NC si la cuenta lo pide; por comprobante se elige subir o no, subir ya o **volver a subir** (reemplaza) | Por cuenta y por comprobante |
| NC | Cancelación total: anula la venta y ARCA emite la NC (ADR-104). Reintegro total en un reclamo: NC automática o "a revisar". Parcial: desde Ventas (devolución) | Por cuenta |

---

## 3. Qué se implementa

### 3.1 Armado de la factura

`supabase/functions/_shared/mercadolibre/invoicePlan.ts` (puro, sin imports, con tests): `buildInvoicePlan(input)` devuelve el **plan** del carrito: renglones, cupón, envío, totales y control, las dos variantes de receptor con su letra, la percepción por jurisdicción con su estrategia, el estado (`ready`, `hold_perception`, `needs_review`, `blocked`) y los avisos.

El worker (`ingestOrder`) lee la orden, el carrito, `billing_info`, el envío y los **pagos** (cupón y envío por pago), pide el contexto al servidor (`ml_billing_context`: reglas, emisor, padrón de ARCA de la cache, padrón de IIBB del CUIT, jurisdicciones con el período completo cargado, alícuota de IVA de cada producto vinculado y la fecha de Argentina), arma el plan y lo manda con el carrito a `ml_ingest_pack`. Sin la feature, el contexto dice `enabled = false` y la venta entra como en ADR-104.

### 3.2 Venta y emisión

- `ml_ingest_pack` (recreada) arma la venta con los renglones del plan, el renglón de envío (sin producto ni stock), el descuento del cupón y el desglose de `_sale_tax_compute`; guarda el plan (`ml_invoice_plans`) y, si el modo es "al pagarse" y el plan está listo, emite.
- `_ml_invoice_emit` (SQL, la única emisión): receptor elegido, letra validada con `cbte_letter_check`, percepción cobrada (tributo IIBB `arca_id 7` en `sale_tax_lines`, total y pago, asiento rearmado), `arca_enqueue_sale` y en el comprobante el punto de venta, el concepto y el receptor (`receptor_override`), con `_arca_blocker` otra vez. Auditada.
- `ml_shipment_upsert` (recreada): al despacharse o al entregarse, emite el plan listo.
- `arca_wsfe`: el concepto del comprobante manda sobre el de la venta.

### 3.3 Datos

| Tabla | Para qué |
|---|---|
| `ml_billing_settings` | Por cuenta: punto de venta, concepto, PDF, NC (subir, reintegro), reglas (`rules`, ver `planSettingsFrom`), link de percepción (días, al vencer, mensaje) |
| `ml_invoice_plans` | Plan del carrito y lo elegido para esa venta (receptor, letra, punto de venta, concepto, PDF, cobrar o no la percepción), estado, error y comprobante |
| `ml_perception_charges` | Link de pago de la percepción: monto, detalle, intent de Mercado Pago, vencimiento, estado (`link_sent`, `paid`, `paid_manual`, `paid_late`, `expired`, `cancelled`), mensaje |
| `ml_fiscal_uploads` | Cada comprobante de la venta (factura o NC), si se sube, estado, id del documento en ML, intentos y error |
| `ml_orders.payments`, `coupon_amount`, `shipping_paid` | Pagos de la orden para el control |

Todas con `tenant_id`, RLS de lectura `tenant_id = (select current_tenant_id())`, escritura sólo por RPC o service_role, `role_write_guard`. Nunca `OR is_internal()`.

### 3.4 Pantalla

**Mercado Libre › Facturación** (sección nueva del gestor):

- **Bandeja** con filtros y conteos (por facturar, esperando percepción, a revisar, con error, facturadas, no se facturan), selección y acciones en lote (**Facturar**, **No facturar**, **Volver a facturar**), y el resultado por venta.
- **Detalle** de cada venta: qué se factura (renglones, cupón, envío, total y lo cobrado), a quién (datos del comprador o consumidor final, con su fuente), tipo de factura con las opciones de ARCA (las que no acepta, deshabilitadas con el motivo), punto de venta, concepto y PDF; percepción por jurisdicción con **Ver el mensaje**, **Crear link de pago** (y mandar el mensaje por ML), copiar y reenviar, **Marcar cobrada** con referencia, **Facturar B sin percepción** o **Facturar A sin percibir**; comprobantes con **Subir a la venta** (sí o no), **Subir ahora**, **Volver a subir** y **Nota de crédito por el total**; **Rearmar** con las reglas de hoy.
- **Configuración**: cuándo facturar, subir la factura, punto de venta, concepto, PDF, cupones, envío, control, receptor, padrón, consumidor final, jurisdicciones bloqueadas, reintegro, NC y percepciones (modo, estrategia por envío, link, mensaje y reglas por jurisdicción con plantillas de ANDESMAR).

Sin `mercadolibre_facturacion` la sección muestra sólo cuándo facturar y subir la factura (ADR-104) y la invitación al plan. En Ventas, las órdenes "esperando la percepción" o "a revisar" llevan a Facturación.

### 3.5 Edge `ml_facturacion` (JWT, dueño o encargado, feature)

| Acción | Qué hace |
|---|---|
| `replan {account_id, pack_key}` | Relee el carrito en ML (sólo GET) y rearma el plan (no toca una venta ya emitida) |
| `perception_link {plan_id, dry_run?, send_message?}` | Vista previa, o preferencia de Checkout Pro de Mercado Pago del negocio por el monto del plan, intent con `external_reference` (lo confirma `mp_webhook`) y mensaje al comprador |
| `perception_message {plan_id}` | Reenvía el mensaje del link abierto |

El pago del link lo marca el trigger `ml_perception_on_intent` sobre `mp_payment_intents` (como los cobros en espera) y, si el modo lo permite, sale la factura A sola. Los vencidos los procesa `ml_perception_expire_due` (cron `ml-perception-expire`, cada 30 minutos, SQL puro).

### 3.6 Vincular con un producto

El modal muestra la publicación (foto, precio, marca, SKU y EAN leídos con `ml_api · link_context`, sólo GET) y los productos con su miniatura, marca y códigos. Sin buscar, sugiere por **mismo código de barras** (también de una variante), **mismo SKU** o **nombre parecido** (palabras del título); la búsqueda encuentra por nombre, SKU, código, PLU, marca y SKU o código de las variantes (`ml_link_candidates`). La variación clásica se elige de una lista y la variante se preelige.

---

## 4. Feature de plan

**`mercadolibre_facturacion`** (OPTIONAL, `requires: mercadolibre, facturacion_afip`, marcada en Pro, Business y Enterprise como `mercadolibre`): todo lo de §2 que es regla o configuración, la bandeja en lote y las percepciones. La facturación de ADR-104 (cuándo facturar, letra automática, subir el PDF) sigue en `mercadolibre`. Se separó de `mercadolibre_gestor` porque son públicos distintos (quien factura y su contador frente a quien atiende reclamos) y para que el editor de planes pueda moverla sin tocar el gestor. Gating real: `ml_billing_assert` (RPC), `ml_edge_guard_billing` (Edge), `ml_billing_context` (worker), `_ml_invoice_emit` y `ml_ingest_pack` (el plan se ignora sin la feature). Las percepciones además exigen `percepciones_retenciones`, y el link, `mercado_pago` y la credencial conectada.

---

## 5. Endpoints

| Endpoint | Uso |
|---|---|
| `GET /orders/{id}`, `/packs/{id}`, `/orders/billing-info/MLA/{id}`, `/orders/{id}/billing_info`, `/shipments/{id}` (`x-format-new`) | Carrito, pagos (cupón y envío), datos fiscales y envío |
| `GET /items/{id}?include_attributes=all` | Fotos, marca, GTIN, SKU y variaciones para vincular |
| `POST /packs/{pack}/fiscal_documents` (multipart `fiscal_document`) | Subir la factura o la NC |
| `DELETE /packs/{pack}/fiscal_documents/{id}` | Volver a subir (reemplazo) **[confirmar ruta]** |
| `POST /messages/action_guide/packs/{pack}/option` (`option_id: OTHER`, 350 caracteres) y `POST /messages/packs/{pack}/sellers/{seller}?tag=post_sale` | Mensaje del link de la percepción |
| Mercado Pago `POST /checkout/preferences` | Link de pago de la percepción (`expires`, `expiration_date_to`, `external_reference` = intent) |

---

## 6. Qué se tomó de ANDESMAR y qué no

| Tomado | Simplificado o fuera |
|---|---|
| Facturable = pago + envío − cupón y el control con $ 1 de tolerancia antes de emitir | Sin ERP: emite NinjaSoft por su cola de ARCA |
| Cupón como renglón de descuento o prorrateado | Mapeos de pagos a renglones (`paymentItemMappings`) |
| Renglón de envío sólo si lo pagó el comprador; a convenir sin renglón | La factura aparte del envío a convenir cobrado por fuera queda como deuda (hoy se avisa) |
| Letra por condición con el padrón de ARCA; razón social y domicilio del padrón; DNI del CUIL; empresa como consumidor final sin identificar bajo el tope | `tipo_resp` de Presea y `taxRegistrations` de Napse |
| Percepciones: fila del padrón, reglas por jurisdicción, % de base, mínimos, acumulado o destino, estrategia por envío, link completo de Mercado Pago, mensaje sin cortar la URL, vencimiento, pago tarde a revisar | Tramo D/C de ARBA por fila del padrón (hoy un % de base por jurisdicción), corte a fin de mes por cambio de alícuota, avisos por Telegram |
| Lo cobrado y lo facturado del mismo cálculo guardado (lección de las 52 facturas) | Auditoría del PDF con IA |
| Subida al pack con reemplazo y "ya existe" como hecho | Búsqueda del PDF en Drive o Gmail (acá el PDF lo arma el servidor) |
| Resultado incierto sin reintento (la cola de ARCA ya lo hace) | Circuit breaker y cupos por corrida del ERP |
| Provincias bloqueadas | Notas privadas en la venta de ML |

---

## 7. Despliegue

1. Migraciones, en orden: `20261208100000_ml_vincular_candidatos` (parte A), `20261208100100_features_ml_facturacion`, `20261208100200_ml_facturacion`, `20261208100300_ml_facturacion_cron`. Requieren las de ADR-104, ADR-132 y ADR-133.
2. Edges: `ml_api` (parte A: `link_context`; parte B: comparte el worker), `ml_worker` (plan en la ingesta, reemplazo de la subida), `ml_facturacion` (nueva, JWT) y `arca_wsfe` (concepto del comprobante).
3. DevCenter: sin tópicos nuevos. Permisos: Facturación (ya pedido en ADR-104) y Comunicación (para el mensaje del link).
4. Para percepciones: plan con `percepciones_retenciones`, el padrón de IIBB importado **completo** (no "sólo mis clientes": los compradores de ML no son clientes hasta que compran) y Mercado Pago conectado.

---

## 8. A confirmar y deuda

- Ruta exacta del `DELETE` de un documento fiscal del pack y si ML acepta la NC en el mismo pack después de la factura.
- Mensaje por la guía de acciones (`OTHER`) en MLA con la cuenta real.
- Devolución parcial con NC parcial automática (hoy desde Ventas), factura aparte del envío a convenir, tramo D/C del padrón, corte del vencimiento a fin de mes, Facturador de ML (`ml_billing`).
- `ml_ingest_pack` también la recrea la rama de Mercado Libre Full (ADR-142, `20261209100100`): la que se aplique después tiene que conservar los bloques ADR-141 y ADR-142.
