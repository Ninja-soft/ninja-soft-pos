# IM5 cap. 00 (POS y caja) vs NinjaSoft POS

Fuente: `ANDESMAR/docs/auditoria-im5/00-pos-y-caja.md` (relevado 20-10-2026). Contraste: repo `pos-deploy` en main (`30ca1316`), roadmap `docs/02-roadmap.md`, migraciones, `app/`, `components/`, `lib/`, `modules/`.
Estados: HECHO, PARCIAL, ROADMAP (pendiente con hito), FALTA (ni código ni roadmap), NO APLICA.

## 1. Modelo base y configuración

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Punto de venta con destino (interno / electrónico / CAEA) | HECHO | ADR-155 (factura o sólo ticket por venta, Shift+F9 en `lib/pos/shortcuts.ts`), H98 PV por caja o sucursal, serie CAEA propia (F3) | Ninguno relevante |
| PV asignado por usuario | HECHO (equivalente) | PV por caja (`cash_registers`, H89/H98) | IM5 lo ata al usuario; NinjaPOS a la caja, mejor para SaaS |
| Letra por categoría IVA cliente vs empresa | HECHO | ADR-068, roadmap H107 "Decisión automática del tipo de comprobante" | - |
| Lista de precios con prioridad cliente > express > usuario > base | HECHO | ADR-058, `20261021100200_resolver_listas_pro.sql` (canal, sucursal, grupo, cliente) | No hay lista por usuario/caja (IM5 la usa para cajeros mayoristas) |
| Circuitos CC1 / CC2 (blanco / interno) | NO APLICA | - | Contabilidad paralela no fiscal: no se replica en un SaaS |
| Tipos de dinero (denominaciones) | FALTA | Sólo montos rápidos de billetes en `lib/pos/checkoutMath.ts` | No hay maestro de denominaciones ni conteo por billete |
| Cuentas de disponibilidades (caja, banco, tarjeta, puente, faltante, sobrante) | HECHO | H150 ADR-158, `lib/accounting/mappings.ts` (`faltante_caja`, `sobrante_caja`, `redondeo`) | - |
| Cuenta de caja y de ajuste por usuario | HECHO (por caja) | Caja del POS como cuenta de Tesorería (H150) | - |

## 2. Pantalla POS

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Bloqueo de venta sin caja abierta | HECHO | `PosModals.tsx` OpenShiftModal, `resolve_sale_shift` (H114) | - |
| Banda "facturando sin conexión" | HECHO | ADR-077, `components/pos/offline` | - |
| Indicador de entorno ARCA (Prueba / Real) | HECHO | ADR-155 | - |
| Multiplicador N* antes del código | HECHO | `components/pos/screen/QuickScanPane.tsx` (botón ×, `pendingQty`) | Sintaxis `4*codigo` tipeada en el buscador no verificada; IM5 acepta decimales |
| QR con varios códigos (carga por lote) | FALTA | - | Leer un QR con N códigos y cargarlos todos |
| "Artículo no encontrado" que bloquea lecturas hasta cerrar | PARCIAL | Beep y anti duplicado en `useScanner` (H23) | Bloqueo de nuevas lecturas tras código inexistente |
| Búsqueda avanzada con filtros, stock por depósito, columnas por usuario | PARCIAL | ProductPane, stock de otras sucursales (ADR-136) | Grilla avanzada con filtros por columna y columnas guardadas por usuario |
| Favoritos por usuario, reordenables, hasta 30 | PARCIAL | `products.is_favorite` y `FavoritesGrid.tsx` (H36), layout por caja | Favoritos son del negocio, no del cajero; sin reordenar por arrastre |
| Escaneo con cámara | HECHO | `BarcodeScanner.tsx`, `BarcodeDetector` | - |
| Captura de peso con acumular / reemplazar | PARCIAL | ADR-063, peso en vivo en el editor de peso | Acumular varias pesadas y "finalizar al leer" |
| Atajos editables por usuario | PARCIAL | `lib/pos/shortcuts.ts` (ADR-100), fijos F2/F4/F8/F9 | Editar atajos; faltan atajos a cantidad del último ítem, vendedor, favoritos |
| Unidad de venta con coeficiente (bulto, caja) | ROADMAP | F18 línea 1298 "falta la unidad de venta por bulto o caja" | - |
| Descuento manual por renglón con límite por usuario y supervisor | PARCIAL | `pos_settings.max_discount` por rol, PIN H116 | Límite por usuario; tope por línea pendiente en H119 ("Descuento por línea sobre el tope") |
| Copiar % de descuento a todas las filas | FALTA | - | Atajo UX menor |
| Precio unitario editable sólo con permiso | HECHO | ADR-056, PIN `cambio_precio` | - |
| Borrar ítem / vaciar con autorización y auditoría | FALTA | H119 sólo cubre "después de un cobro parcial"; `removeLine` en `modules/pos/store.ts` sin audit | Política "borrar ítem pide PIN" y registro en `audit_logs` de líneas borradas antes de cobrar |
| Promos calculadas en servidor, panel "promos disponibles" | HECHO / mejora | ADR-074, `promoByLine` en CartPane | Falta mostrar promos cercanas ("llevando 3, 20% off") |
| Carrito recuperado al recargar | FALTA | Pausar venta (ADR-106) es manual; store sin persist | Persistencia automática del carrito en el dispositivo |
| Percepciones calculadas por cliente en totales | HECHO | ADR-068, `sale_tax_preview`, vista previa en `app/(app)/pos/page.tsx` | - |
| Crédito a favor del cliente | HECHO | Vale / `store_credit_movements` (F11) | - |
| Vendedor en la venta | HECHO | `sales.professional_id` (`20260608550000_commissions_tips.sql`), pedidos con `seller_user_id` | Vendedor obligatorio configurable no verificado |
| Cliente predeterminado CF, alta rápida, buscar en ARCA | HECHO | `QuickCustomerModal.tsx`, `PadronVerify.tsx`, Edge `arca_padron` (ADR-133), escaneo DNI (H31) | - |
| Tope de monto a CF sin identificar | HECHO | ADR-068 / H107 tope de identificación con vigencia | - |
| Grabado idempotente y verificación antes de reintentar | HECHO | ADR-035 idempotencia, `client_sale_id` | - |
| Artículo en moneda extranjera sin cotización bloquea | ROADMAP | F18 líneas 1297 y 1363 | - |
| Tope de ítems por comprobante | NO APLICA | - | Límite técnico de IM4 |

## 3. Cobro

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Multi medio, paga con y vuelto | HECHO | `CheckoutSheet.tsx`, `checkoutMath.ts` | - |
| Redondeo automático con cuenta de ajuste | HECHO | H30 redondeo, cuenta `redondeo` | - |
| Tarjeta con plan, cuotas, recargo, lote, cupón, autorización | HECHO | `payment_plans`, `payments.card_voucher`, `require_card_voucher` | - |
| Planes por día de la semana | FALTA | `payment_plans` tiene vigencia y `store_id`, no días | "Cuotas sin interés los martes" se resuelve hoy sólo con promos |
| Arancel, TNA, TEM, CFT por plan | PARCIAL | H21i comisiones por medio; F14 línea 927 CFT | CFT visible en el cobro |
| Cheque como medio de cobro (POS y cuenta corriente) | PARCIAL | Cheques de terceros en Tesorería (ADR-059, ADR-158, `ChequesView.tsx`) | No es un medio del POS ni de `account_collect` |
| Efectivo en dólares con cotización | FALTA | Tenders sin USD (`lib/pos/tenders.ts`) | Cobro en USD con cotización del día y vuelto en pesos |
| Pago electrónico aprobado no se pierde al cerrar | HECHO | Cobros en espera (ADR-048), Pausar (ADR-106) | - |
| Reglas de cobro destino x medio (qué medios por tipo de comprobante y usuario) | PARCIAL | Medios por negocio y sucursal, planes por sucursal (`20261020110000_planes_por_sucursal.sql`) | Restringir medios por "factura vs sólo ticket" y por usuario |
| Botonera de cobro ágil (un toque cobra y graba, F-keys, orden por uso) | PARCIAL | Cobro express H36 | Botones configurables medio + comprobante con atajo y orden por frecuencia |
| Imágenes de cobro (logos) | HECHO | `lib/pos/tenderLogo.ts`, `public/img/medios_de_pago` | - |

## 4. Cobros integrados

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Mercado Pago QR, Point, Link, OAuth, defaults por caja | HECHO | H15, `mp_create_qr`, Point en `tenders.ts`, cobros en espera con link | Validar con cobro real (criterio H15+) |
| Payway POS / QR / Link | PARCIAL | H17 link hosted; Payway Point bloqueado (F8 ADR-047) | ROADMAP |
| Clover Flex/Mini | PARCIAL | H19 `clover_point` en código | ROADMAP, falta primer cobro real |
| Panel sandbox (aprobar / rechazar) | HECHO | Simulador de terminal (ADR-053), sandbox por medio | - |

## 5. Resultado de la venta, ARCA e impresión

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Estados: exitosa, CAEA, provisorio, pendiente ARCA, error con categoría | HECHO | F3 cola fiscal, estados `pendiente/enviando/aprobado/rechazado/requiere acción` | - |
| Reintentar en ARCA / registración masiva | HECHO | Cola con backoff y reproceso manual (ADR-072) | - |
| Diagnóstico de conexión (ARCA vs servidor, latencia) | FALTA | Healthcheck profundo (ADR-098) no expuesto al cajero | Mensaje "tu conexión respondió en X ms, el caído es ARCA" |
| PDF con QR AFIP, offline | HECHO | `supabase/functions/_shared/arca/qr.ts`, ticket provisorio offline | - |
| Certificados por entorno con aviso de vencimiento | HECHO | `components/arca/ArcaSettings.tsx` (`certExpiry`) | - |
| CAEA por quincena, informar, sin movimiento | HECHO | F3 Contingencia CAEA | - |
| Edición de comprobantes con seguridad (cargar CAE a mano) | NO APLICA | - | La cola automática evita la carga manual; riesgoso |
| Impresora fiscal, cierres X/Z fiscales, agente local | NO APLICA | `docs/15-afip-integration.md` "no soportamos hardware fiscal" | Decisión vigente |

## 6. Caja

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Apertura con saldo del cierre anterior | FALTA | `OpenShiftModal` pide monto libre (`PosModals.tsx`) | Sugerir lo que quedó en el cajón, confirmar si abre en $0 con saldo previo, diferencia de apertura auditada |
| Retiros / controles parciales en el turno | HECHO | `cash_movements` retiro con destino en Tesorería, PIN por monto (H116) | Retiro por límite pendiente (H111 línea 1402) |
| Desglose de billetes en el conteo | FALTA | `close_cash_shift(p_closing_amount)` recibe un total | Conteo por denominación que suma el total |
| Un cajero no tiene dos cajas abiertas | HECHO | H114 `open_cash_shift` | - |
| Simulación de cierre | HECHO | Resumen en vivo en `app/(app)/caja/page.tsx`, monitor H115 | - |
| Cuadro a rendir / rendido / diferencia por concepto (efectivo, cada tarjeta, otros) | PARCIAL | Z con desglose por medio (H30b) pero sólo se cuenta efectivo | Arqueo por medio (cupones de tarjeta, transferencias, cheques, vales) |
| Cierre confirmado por tesorero (dos pasos) | ROADMAP | H111 línea 1403 "Rendiciones por medio de pago con estados (pendiente de aprobación > entregado)" | - |
| Asiento de faltante / sobrante | HECHO | ADR-066 | - |
| Histórico de cierres con asiento y export | HECHO | H30b `ZClosuresHistory.tsx` | - |
| Rendición offline | PARCIAL | Venta offline exige caja abierta (ADR-077) | Abrir y rendir sin conexión (H65) |
| Transferencias de valores entre sucursales con tránsito | PARCIAL | Transferencias entre cuentas (ADR-059) | Estado en tránsito y recepción, cheques que viajan |
| Cambio de mercadería con diferencia | HECHO | `exchange_sale` (F11) | - |
| Ticket de cambio (sin precios, con días para cambiar) | FALTA | Sin rastro en `lib/print` ni roadmap | Imprimir ticket de cambio desde la venta |

## 7. Seguridad

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Permisos por pantalla y acción, perfiles | HECHO | ADR-138 roles propios y editor de permisos | - |
| Autorización de supervisor sin cambiar sesión | HECHO (mejor) | H116 / H116b PIN rotativo, TOTP | - |
| PCs autorizadas por usuario | FALTA | Caja recordada por dispositivo, sin restricción | Limitar login de un usuario a dispositivos aprobados |
| Cierre de sesión por inactividad | HECHO | `components/system/InactivityGuard.tsx`, `lib/auth/idle.ts` | - |
| Auditoría de borrados | HECHO | H117 visor, hash encadenado | - |

## 8. Balanzas, offline, ayuda

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Lectura de peso y etiquetas con peso/precio | HECHO | ADR-063 `lib/barcode/scaleLabel.ts`, `lib/hardware/scale` | Presets sin validar |
| Envío de precios / PLU a la balanza | FALTA | `lib/hardware/scale/protocols.ts` sólo lectura | Sync de PLU y precios por lista a Kretz/Systel |
| Control de tickets de balanza vs facturado | FALTA | - | Nicho |
| Respaldo offline (ver, descartar, exportar, importar la cola) | PARCIAL | Panel "Ventas offline" del dueño (`OfflineSalesPanel.tsx`) | Export/import local de la cola |
| Ayuda contextual, recorridos, IA | HECHO | H69/H70, `components/help`, `components/ai` | - |

## 9. Otros circuitos citados

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Facturación periódica a clientes | ROADMAP | H41 línea 782 membresía recurrente | Generar facturas periódicas por cliente |
| FCE MiPyME, factura E | ROADMAP | H107 | - |
| NC/ND automáticas por diferencia de cotización | ROADMAP | F18 línea 1312 diferencia de cambio | - |

## Conteo

HECHO 43 (incluye 3 con mejora menor) · PARCIAL 16 · ROADMAP 6 · FALTA 14 · NO APLICA 4
