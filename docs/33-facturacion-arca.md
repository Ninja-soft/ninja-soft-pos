# Facturación electrónica con ARCA (WSFEv1)

Decisión: [ADR-072](./17-decision-log.md) · Hitos: F3 y F18 · H107 (parte) ([roadmap](./02-roadmap.md)) · Base fiscal: [32-impuestos.md](./32-impuestos.md) · Diseño previo: [15-afip-integration.md](./15-afip-integration.md)

> **Aviso normativo.** Códigos, plazos y reglas de ARCA son **orientativos** y se toman de lo que devuelve ARCA cuando es posible (`FEParamGet*`, `FchTopeInf`). Validar con el contador del negocio y la norma vigente.

## 1. Qué hace

- Cada venta completada (y el cobro en espera cuando se acredita) genera su **factura A, B o C** en una cola. La devolución genera una **nota de crédito** proporcional y la anulación de una venta facturada, una nota de crédito por lo que falta acreditar.
- **El cajero nunca espera a ARCA.** La venta se completa siempre; el POS le pide a la Edge que emita sin esperar la respuesta, y el cron de cada minuto procesa lo pendiente con reintentos.
- El **ticket** muestra "Factura B N° 00003-00000012", el CAE con su vencimiento y el **QR fiscal** (RG 4892). Mientras no hay CAE dice "Comprobante pendiente de autorización ARCA".
- **Contingencia CAEA** (opcional): si ARCA no responde, la factura sale al instante con el CAEA de la quincena y se informa después.
- **Monitor**: pendientes, errores con el código de ARCA y qué hacer, última conexión, reproceso, comprobantes en dead-letter, CAEA vigente, comprobantes por informar y vencimientos.

Feature de plan: `facturacion_afip` (OPTIONAL, Pro, Business y Enterprise). Requiere `impuestos_iva` (datos fiscales del negocio).

## 2. Glosario (el mismo que muestra el asistente)

| Término | En simple |
|---|---|
| ARCA | La ex AFIP. |
| Homologación | Modo de prueba de ARCA: las facturas no tienen validez fiscal, sirve para probar sin riesgo. |
| Producción | Facturas reales, con validez fiscal. |
| Certificado | La llave que autoriza a NinjaSoft a facturar en tu nombre. Dura 2 años. |
| Pedido de certificado (CSR) | El texto que NinjaSoft genera y vos subís a ARCA para que te dé el certificado. La clave privada queda guardada cifrada en NinjaSoft y nunca se muestra. |
| Alias | El nombre con el que ARCA identifica al certificado ("computador fiscal"). |
| wsfe | El servicio de ARCA de factura electrónica. Hay que autorizarlo para el certificado. |
| Punto de venta | Número de caja fiscal que das de alta en ARCA, de tipo Web Services. Cada sucursal o caja usa uno. |
| CAE | Código que da ARCA y hace válida la factura. |
| CAEA | Código anticipado por quincena para facturar cuando ARCA no responde. Necesita un punto de venta propio de tipo CAEA. |
| WSASS | Autogestión de certificados de homologación de ARCA. |
| Delegación | Autorizar a la CUIT de NinjaSoft a facturar por vos (camino A, disponible próximamente). |

## 3. Configuración paso a paso (Configuración > Facturación electrónica)

Antes: Configuración > Impuestos con **condición frente al IVA y CUIT** del negocio.

1. **Camino.** *Certificado propio* (hoy el único activo). *Delegar en NinjaSoft* aparece como "Disponible próximamente" hasta que NinjaSoft tenga su CUIT y su certificado cargados.
2. **Certificado de homologación.** "Generar pedido" crea la clave y el CSR en el servidor. Copiar el CSR, entrar a ARCA con clave fiscal, servicio **WSASS - Autogestión Certificados Homologación** (adherirlo desde el Administrador de Relaciones si no aparece), "Nuevo certificado" con el alias que muestra NinjaSoft y pegar el CSR. Copiar el certificado que devuelve y pegarlo en NinjaSoft: se valida que corresponda al pedido, que lo haya emitido "Computadores Test", la CUIT y el vencimiento.
3. **Autorizar wsfe (homologación).** En WSASS, "Crear autorización a servicio": alias del certificado, CUIT representada (la del negocio) y servicio **wsfe**. NinjaSoft muestra cada valor con botón copiar.
4. **Punto de venta.** En homologación sirve cualquier número (por ejemplo 1). Se asigna por sucursal y, si hace falta, por caja.
5. **Prueba.** "Probar conexión": certificado, permiso de acceso (WSAA), servicio en línea (FEDummy), puntos de venta y último comprobante autorizado. Cada falla dice qué pasó y qué hacer (tabla de la sección 6). Activar la facturación y hacer al menos 3 ventas de prueba (quedan aprobadas en homologación).
6. **Certificado de producción.** Igual que el paso 2 pero en **Administración de Certificados Digitales** (emisor "Computadores"), y autorizar wsfe en el **Administrador de Relaciones de Clave Fiscal**: Nueva relación, servicio Facturación Electrónica, representante el alias (computador fiscal).
7. **Punto de venta de producción.** ARCA, **Administración de puntos de venta y domicilios**: alta de un punto de venta "Factura Electrónica - Monotributo / Responsable Inscripto - Web Services" por sucursal. "Consultar en ARCA" lista los habilitados para elegirlos.
8. **Contingencia (opcional).** Dar de alta otro punto de venta exclusivo de tipo **CAEA** ("RECE para aplicativo y web services" con CAEA) y activarlo en NinjaSoft con ese número y la espera máxima (10 segundos por defecto).
9. **Activar producción.** Sólo el dueño, con el checklist completo: datos fiscales, certificado de producción vigente de la CUIT, 3 comprobantes aprobados en homologación, prueba completa en producción en los últimos 7 días y puntos de venta presentes en ARCA. Desde ahí las facturas son reales.

## 4. Cómo funciona por dentro

| Pieza | Dónde |
|---|---|
| Configuración, certificados (sólo metadata), checklist | `arca_settings`, `arca_certificates` (sin policies), RPC `arca_config_get`, `arca_settings_save`, `arca_set_environment`, `arca_certificate_delete` |
| Cola | `fiscal_documents`, `fiscal_document_events`; triggers `arca_sales_enqueue` y `arca_returns_enqueue`; RPC `arca_claim`, `arca_snapshot`, `arca_mark_sending`, `arca_apply_result`, `arca_document_retry`, `arca_enqueue_sale_manual` |
| Tickets WSAA | `arca_tickets`, `arca_platform_tickets` (sólo service_role, 12 h) |
| Plataforma (delegación) | `arca_platform` (sin valores por defecto), `arca_platform_get`, `arca_platform_store` |
| CAEA | `arca_caea`, `arca_caea_series`, `arca_caea_tasks`, `arca_caea_issue`, `arca_caea_inform_result`, `arca_caea_sin_movimiento_result` |
| Estado para el POS | `arca_status()` |
| Worker y acciones | Edge `arca_wsfe` |
| Lógica pura | `supabase/functions/_shared/arca/` (`wsaa`, `wsfe`, `comprobante`, `qr`, `pki`, `crypto`, `caea`, `errors`, `client`, `worker`, `caeaTasks`) |
| Cron | `arca-wsfe`, cada minuto si `arca_any_due()` |

Un comprobante en el worker: foto de la venta → importes (`sale_tax_lines`) → ticket WSAA (cacheado) → si tenía número de un intento incierto, recuperación con `FECompUltimoAutorizado` + `FECompConsultar` → `FECompUltimoAutorizado` → número siguiente guardado antes de mandar → `FECAESolicitar` → aprobado con CAE y QR, rechazado con observaciones, reintento con backoff (1, 2, 4 ... 60 minutos, dead-letter a los 10 intentos) o requiere acción.

## 5. Contingencia CAEA

- Quincenas: orden 1 (días 1 a 15) y orden 2 (16 a fin de mes). Se pide el CAEA de la vigente si falta y el de la próxima dentro de los 5 días previos (`FECAEASolicitar`; si ya estaba, `FECAEAConsultar`).
- Se usa sólo si el fallo de ARCA es **cierto** antes del CAE: sin permiso de acceso, `FECompUltimoAutorizado` sin respuesta en la espera configurada, o error explícito 500 a 502. Un timeout del pedido de CAE es incierto y espera la recuperación.
- Numeración propia del punto de venta CAEA (`arca_caea_series`, sincronizada con ARCA cuando responde). QR con `tipoCodAut` "A".
- Informe con `FECAEARegInformativo` hasta la fecha tope que devuelve ARCA (hoy, 8 días corridos después del cierre de la quincena); un informe rechazado deja el comprobante en "Requiere acción". Quincena sin uso: `FECAEASinMovimientoInformar`.
- Norma (orientativo): RG 5782/2025 (CAE en línea como regla, CAEA quincenal), RG 5785/2025 (CAEA como primera opción de contingencia para Web Services) y RG 5852/2026 (vigencia desde el 1 de agosto de 2026). Confirmar con el contador si el negocio puede usarlo y desde cuándo.

## 6. Errores frecuentes

| Código | Qué pasó | Qué hacer |
|---|---|---|
| `coe.alreadyAuthenticated` / `ta_ya_emitido` | ARCA ya entregó un permiso de 12 h que NinjaSoft no tiene guardado | Esperar a que venza y reprocesar. No se reintenta solo. |
| `cms.cert.expired` | Certificado vencido | Generar un pedido nuevo y cargar el certificado. |
| `coe.notAuthorized` | El certificado no tiene autorizado wsfe | Autorizar el servicio para el alias. |
| `600`, `601` | La CUIT no está autorizada o no es la del certificado | Revisar la autorización o la delegación y la CUIT del negocio. |
| `602` en puntos de venta | ARCA no tiene puntos de venta para la CUIT | Dar de alta uno de tipo Web Services. |
| `10016` | Numeración desfasada | Se reconcilia y reintenta solo. |
| `500`, `501`, `502`, `sin_respuesta` | ARCA con problemas | Se reintenta solo; con CAEA, sale en contingencia. |
| `receptor_sin_cuit` | Factura A sin CUIT del cliente | Cargar el CUIT y reprocesar. |
| `importes_no_cierran` | El desglose de la venta no cierra | Revisar alícuotas y reprocesar. |

## 7. Operación

- **Secrets de la Edge:** `ARCA_KEY_ENC` (obligatorio, `openssl rand -base64 32`; guardarlo aparte: sin él las claves guardadas no se pueden leer). Opcionales: `ARCA_WSAA_URL_HOMO`, `ARCA_WSFE_URL_HOMO`, `ARCA_WSAA_URL_PROD`, `ARCA_WSFE_URL_PROD` (sólo dominios de ARCA o localhost).
- **Deploy:** migraciones `20261101100000`, `20261101100100`, `20261101100200` (después de ADR-068) y la Edge `arca_wsfe` con su `deno.json`.
- **Smoke test de homologación** (nunca producción):

  ```powershell
  $env:ARCA_CERT_PATH="C:\Users\<vos>\.ninja-arca\homo\ninjapos-homo.crt"
  $env:ARCA_KEY_PATH="C:\Users\<vos>\.ninja-arca\homo\ninjapos-homo.key"
  $env:ARCA_CUIT="20378923450"
  node scripts/arca-homo-smoke.mjs
  ```

  Hace WSAA (o usa el ticket guardado junto a la clave), FEDummy, `FECompUltimoAutorizado` y una Factura B de $121 en el punto de venta 1, y la consulta. `ARCA_SMOKE_ONLY=dummy` prueba sólo FEDummy. Necesita Node 22.18 o superior (ejecuta TypeScript sin compilar).
- **Delegación:** cuando NinjaSoft tenga CUIT, el staff la carga en `/internal/configuracion` (CUIT, generar pedido, pegar certificado por ambiente). Recién ahí el camino A se habilita para los clientes.

## 8. Pendiente

Con certificado real: 100 comprobantes consecutivos en homologación, recuperación ante un error transitorio real, CAEA en homologación y paso a producción de un piloto. Funcional: factura E (WSFEX), FCE MiPyME, moneda extranjera, notas de débito, venta offline del POS con CAEA local, reimpresión y reenvío automático del ticket con CAE.
