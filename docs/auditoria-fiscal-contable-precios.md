# Auditoría fiscal, contable, de precios y compras (Argentina)

Fecha: 2026-10-12 · Fase nueva en el roadmap: **F18** (H100 a H112) · Decisión: [ADR-043](./17-decision-log.md) · Complementa: [`auditoria-napse-vs-ninjapos.md`](./auditoria-napse-vs-ninjapos.md) (multi-sucursal, F17)

> **Mirada:** la de un contador público que audita un sistema de gestión comercial argentino antes de recomendarlo a un cliente: ¿el sistema registra lo que la normativa exige, permite liquidar impuestos sin retipear y deja un rastro auditable? Se audita contra el código en `main` (`1acb481`).
>
> **Aviso normativo.** Las normas fiscales argentinas cambian seguido (alícuotas, topes, padrones, regímenes de información). Las referencias a resoluciones generales (RG) de ARCA (ex AFIP) y a normas provinciales son **orientativas para diseñar el producto**: cada hito debe validarse contra la norma vigente al implementarlo, idealmente con un estudio contable asesor. Por eso todo valor normativo (alícuotas, topes, mínimos, códigos de tributo) se modela como **parámetro con vigencia**, nunca como constante en el código.

---

## 1. Resumen ejecutivo

1. **Listas de precios: base sólida pero chica.** Existen `price_lists` (canal `mostrador` / `catalogo` / `mayorista` / `custom`, `adjustment_pct`) y `price_list_items` (precio fijo por producto o variante), gateadas por `listas_precios` (trigger `trg_assert_price_lists_feature`), resueltas por `lib/prices/resolve.ts`. **Faltan** vigencia, programación, historial, aprobación, listas derivadas de costo con markup, redondeos, plazos de pago, moneda extranjera, escalas por cantidad, lista por cliente o grupo, actualización masiva por proveedor o índice y etiquetas al cambiar precio.
2. **Riesgo de control interno:** el precio se resuelve en el navegador y `create_sale` **acepta el `unit_price` que manda el cliente** (`20260609320000_create_sale_coupon.sql`, línea 141). El tope de descuento por rol se controla, pero un precio unitario alterado no. Para un auditor esto es una debilidad: el servidor debe recalcular el precio de lista y registrar la diferencia como descuento autorizado.
3. **Compras e importaciones: no existen.** Hay `products.cost` (un número) y `brands`; no hay proveedores, órdenes de compra, recepciones, facturas de proveedor, cuenta corriente de proveedores, historial de costos ni costeo de importación. Ya estaban enunciados en F14/H64 sin detalle fiscal.
4. **IVA: modelo insuficiente para facturar.** `products.tax_rate numeric default 21` no distingue **exento** de **no gravado** de **0 %**, no admite alícuotas especiales por operación y no hay tipo de comprobante ni discriminación de impuestos. `customers.iva_condition` y `tenant_branding.iva_condition` existen (bien), pero faltan "IVA no alcanzado", "sujeto no categorizado" y "monotributo social" y la validación contra padrón.
5. **Impuestos internos, percepciones, retenciones y padrones: no existen.** Sin esto un comercio que es agente de percepción de IIBB (ARBA, AGIP) o vende bebidas, tabaco o electrónica **no puede facturar legalmente** con el sistema.
6. **Facturación electrónica: `facturacion_afip` es MARKETING-FUTURO.** F3 no está iniciada; `docs/15-afip-integration.md` diseña WSAA/WSFEv1, cola fiscal y contingencia, pero no cubre tributos, condición IVA del receptor, comprobantes M y E, FCE MiPyME ni Transparencia Fiscal.
7. **Libros y regímenes de información: nada.** Ni Libro IVA Digital (ventas y compras), ni SICORE/SIRE, ni DDJJ de IIBB (ARBA, AGIP, CM05 vía SIFERE), ni SIRCAR, ni régimen de información de precios (SEPA).
8. **Contabilidad: sólo Cierre Z.** No hay plan de cuentas, asientos, centros de costo, conciliación bancaria ni cierre mensual. El reporte de **conciliación de tarjetas** está en curso (`feat/conciliacion-tarjetas`: `payments.card_voucher` con n° de comercio y `payments.reconciled_at`).
9. **Features hoy MARKETING-FUTURO** (prometidas en planes sin función): `facturacion_afip`, `multi_sucursal`, `metricas_avanzadas`, `promociones` (parcial), `api_publica`, `backup`. Este documento suma keys nuevas (ver §9) que **no deben mostrarse en la comparación de planes hasta que exista la función**, o mostrarse como "Próximamente".

**Recomendación del auditor:** antes de habilitar F3 (factura con CAE) hay que tener el **motor de impuestos** (H103), la **condición fiscal del receptor contra padrón** (H104) y la **validación server-side del precio** (H100). Facturar con un modelo de IVA de una sola columna genera comprobantes que después no cierran en el Libro IVA Digital.

---

## 2. Listas de precios

### 2.1 Qué hay hoy

| Ítem | Estado | Evidencia |
|---|---|---|
| Varias listas por negocio | Existe | `price_lists` (`20260607100000_variants_price_lists.sql`), UI `components/prices/PriceListsCard.tsx`, `PriceListEditorModal.tsx`, `modules/prices/api.ts` |
| Lista por canal (mostrador, catálogo, mayorista) | Existe | `price_lists.channel`, una por canal no-custom (`uq_price_lists_channel`) |
| Lista derivada por % sobre precio base | Existe | `price_lists.adjustment_pct` |
| Precio puntual por producto o variante | Existe | `price_list_items(product_id, variant_id, price)` |
| Gating por plan | Existe | `listas_precios` (Business y superior) con trigger server-side |
| Aplicación en el POS, delivery, mesas y catálogo | Existe | `resolvePrice` en `app/(app)/pos/page.tsx`, `DeliveryProductPicker`, `TableProductPicker`, catálogo público |
| Lista por cliente o grupo de clientes | Falta | `customers.group_id` existe, sin lista asociada |
| Lista por sucursal | Falta | Ver F17/H94 |
| Vigencia desde y hasta, vencimiento, programación | Falta | |
| Historial de precios y auditoría de cambios | Parcial | `audit_logs` genérico si hay trigger; sin historial consultable por producto |
| Aprobación (maker-checker) | Falta | F14/H63 lo enuncia en general |
| Lista derivada de costo (markup) y redondeo psicológico | Falta | |
| Plazos y condiciones de pago (30/60/90 con recargo) | Parcial | `payment_plans` (cuotas con recargo por medio de pago, H27) cubre tarjetas, no plazos de cuenta corriente |
| Moneda extranjera | Falta | |
| Escalas por cantidad | Falta | F9 (promos) cubre NxM, no escalas de lista |
| Actualización masiva por proveedor, marca, categoría | Falta | Sólo import XLSX de productos (TX-4) |
| Actualización por índice (IPC, dólar BNA o MEP) | Falta | |
| Etiquetas de góndola al cambiar precio | Parcial | Perfil de impresión `product_label` (`lib/print/profiles.ts`), sin cola de "precios cambiados" |
| Validación del precio en el servidor | Existe (ADR-056) | `create_sale` recalcula el precio de lista y rechaza el distinto; cambio manual con motivo y PIN (§1.2) |

### 2.2 Diseño: modo simple y modo profesional

**Modo simple (BASE para el que tiene una lista, OPTIONAL `listas_precios` para más):** el comerciante ve "Precio de venta" en el producto y, si tiene el plan, "Listas" con tres plantillas: *Mayorista (−10 %)*, *Tarjeta en cuotas (+15 %)*, *Catálogo web (igual)*. Cambiar precios en masa es un asistente de tres pasos: **qué** (todos, categoría, marca, proveedor), **cuánto** (% o monto, redondeo a $10/$50/$100 o terminado en 9), **cuándo** (ahora o fecha). Siempre con vista previa y deshacer.

**Modo profesional (OPTIONAL `listas_precios_pro`, Business o Enterprise), pensado para compras e importaciones:**

| Variable | Diseño |
|---|---|
| **Base de la lista** | Precio de venta base, otra lista (cadena de derivación) o **costo** (reposición, promedio ponderado o último) con **markup** o **margen objetivo** (no son lo mismo: markup 50 % = margen 33 %; la UI muestra ambos). |
| **Reglas** | Por producto, variante, categoría, marca, proveedor, tag: % o monto, precio fijo, piso (precio mínimo de venta), techo, margen mínimo con alerta. |
| **Redondeo** | Múltiplo, terminación psicológica (,99 / 9 / 90), por tramo de precio. |
| **Vigencia** | `valid_from` / `valid_to`, franja horaria y días (como Napse). Al vencer: vuelve a la lista padre, se desactiva o alerta N días antes. |
| **Programación** | Versiones de lista: borrador → aprobada → programada → vigente → histórica. Cambios futuros sin tocar la vigente. |
| **Aprobación** | Opcional por lista: quien carga no aprueba; aprobación con motivo, antes y después y margen resultante. |
| **Plazos y condiciones** | Lista por condición de venta: contado, 30, 60, 90 días con **recargo financiero** (tasa mensual o TNA, interés simple o compuesto, cálculo visible). Para el cliente de cuenta corriente, la condición se toma de su ficha. El recargo financiero se factura como parte del precio o como ítem "intereses" según criterio fiscal (los intereses de financiación siguen el tratamiento de IVA de la operación principal). |
| **Moneda** | Lista en USD (u otra) con conversión al vender: tipo de cambio de referencia (BNA vendedor, MEP, manual), fecha de corte y redondeo. La factura se emite en pesos o en moneda extranjera con su cotización (WSFE `MonId` / `MonCotiz`). |
| **Escalas** | Precio por cantidad (1 a 9, 10 a 49, 50+), por bulto o caja, unidad de venta distinta de la de stock. |
| **Asignación** | A canal, sucursal o grupo (F17/H94), grupo de clientes, cliente puntual, condición de pago. Precedencia explicable: cliente → grupo → condición → sucursal → canal → base. |
| **Índices** | Actualización por IPC (INDEC), dólar BNA o MEP, o índice propio; con tope y redondeo; registra qué índice y valor se usó. |
| **Actualización por proveedor** | Importar la lista del proveedor (XLSX/CSV con mapeo de columnas guardado por proveedor), comparar contra el costo actual, aplicar markup y generar la nueva versión de precio de venta en borrador. |
| **Historial y auditoría** | `price_history` por producto, variante y lista (precio, costo, margen, quién, cuándo, motivo, versión). Reporte "¿cuánto valía esto el 3 de marzo?". |
| **Etiquetas** | Cola "precios cambiados desde la última impresión" por sucursal; flejes de góndola con precio por unidad de medida (exigencia de exhibición de precios) y, cuando corresponda, el precio sin impuestos nacionales (Transparencia Fiscal). |
| **Control en servidor** | `create_sale` recalcula el precio efectivo; si el `unit_price` recibido difiere, lo registra como descuento o recargo con usuario y motivo, sujeto al tope por rol. |

### 2.3 Modelo de datos (borrador)

`price_lists` + `base_kind` (`price`, `list`, `cost`), `base_list_id`, `cost_basis`, `markup_pct`, `rounding jsonb`, `currency`, `fx_source`, `payment_terms_days`, `finance_rate`, `valid_from`, `valid_to`, `schedule jsonb`, `requires_approval`, `status`, `version`. `price_list_rules` (alcance + acción + prioridad). `price_list_items` + `min_qty` (escalas), `valid_from`, `valid_to`. `price_history`. `price_list_assignments` (lista → canal / sucursal / grupo / cliente / condición). `fx_rates` (fecha, fuente, moneda, comprador, vendedor). `price_label_queue`.

---

## 3. Compras e importaciones (perfil profesional)

| Ítem | Estado | Prio | Esf. | Hito |
|---|---|---|---|---|
| Proveedores (CUIT, condición IVA, padrones, condición de pago, moneda, contacto) | Falta | P1 | M | H101 |
| Producto por proveedor (código del proveedor, último costo, mínimo, unidad de compra) | Falta | P1 | S | H101 |
| Orden de compra (abierta → confirmada → recepción parcial → cerrada / cancelada) | Falta (F14/H64 enunciado) | P1 | M | H101 |
| Recepción (remito) parcial con diferencias | Falta | P1 | M | H101 |
| Factura de proveedor con IVA, percepciones sufridas e impuestos internos discriminados | Falta | P1 | M | H101 |
| Cuenta corriente de proveedores, pagos, órdenes de pago con retenciones | Falta | P1 | L | H101, H106 |
| Costeo: reposición, promedio ponderado (PPP), último costo, FIFO opcional | Falta (`products.cost` único) | P1 | M | H101 |
| Multi-moneda y tipo de cambio por operación (compra en USD, diferencia de cambio) | Falta | P2 | M | H101, H109 |
| Costeo de importación con prorrateo | Falta | P2 | L | H102 |
| N° de despacho de importación por lote y en factura | Falta | P2 | M | H102 |

**Costos y criterio.** El sistema debe guardar tres costos por producto y dejar elegir cuál alimenta el markup: **reposición** (el que usa el comerciante para fijar precio en un país con inflación), **promedio ponderado** (el que mejor refleja el CMV contable) y **último costo** (el que pide la Ley de Ganancias para valuar bienes de cambio al cierre, art. 52 LIG, a validar con el asesor). La valuación contable de cierre sigue las normas profesionales vigentes (RT de la FACPCE; la RT 54 unificó criterios). Ninguno se pisa: se guarda la historia de cada uno.

**Costeo de importación (H102).** Carpeta de importación con:

- Valores en origen: **FOB**, flete internacional, seguro → **CIF** (valor en aduana).
- Tributos aduaneros sobre CIF: **derechos de importación** por posición NCM, **tasa de estadística**, **IVA** (21 % o 10,5 %), **percepción de IVA adicional** (RG 2937 y modificatorias), **percepción de Ganancias** (RG 2281), **percepción de IIBB** en aduana (SIRPEI) y los que estén vigentes al momento (por ejemplo el impuesto PAIS, hoy derogado, debe poder cargarse como "otro tributo" con vigencia por si vuelve un recargo similar).
- Gastos de nacionalización: honorarios del despachante, terminal, depósito fiscal, flete interno, gastos bancarios.
- **Prorrateo** por valor, peso, volumen o cantidad, configurable por concepto (el flete por peso, el seguro por valor).
- Tipo de cambio por operación (oficializado del despacho y del pago) con diferencia de cambio contable.
- Resultado: costo unitario puesto en depósito por producto y lote. **Crédito fiscal** (IVA y percepciones computables) separado del costo: lo computable no es costo.
- **N° de despacho** (formato `AAaaaTTTTnnnnnnX`: año, aduana, tipo, número, verificador) asociado al lote y disponible para consignarlo en la factura de venta de bienes importados cuando la norma lo exija.

---

## 4. Impuestos

### 4.1 IVA

| Ítem | Estado | Notas |
|---|---|---|
| Alícuota por producto | Parcial | `products.tax_rate` numérico; falta catálogo cerrado: **21 %, 10,5 %, 27 %, 5 %, 2,5 %, 0 %, exento, no gravado**. Exento y no gravado son distintos (Libro IVA los separa) aunque los dos tengan 0. |
| Alícuota por operación | Falta | El 27 % aplica a ciertos servicios (energía, telecomunicaciones) a responsables inscriptos; 10,5 % en bienes de capital y algunos alimentos. Debe poder depender del producto y del receptor. |
| Condición frente al IVA del emisor | Existe | `tenant_branding.iva_condition` (falta por razón social y sucursal, F17/H98). |
| Condición frente al IVA del receptor | Parcial | `customers.iva_condition` (CF, RI, monotributo, exento, no responsable). Faltan "no alcanzado", "sujeto no categorizado", "monotributo social", "IVA liberado"; validación contra padrón (H104). WSFE exige informar la condición del receptor (RG 5616 y sus plazos). |
| Tipo de comprobante | Falta | **A** (RI a RI y monotributista con CUIT), **B** (RI a CF, exento, monotributista), **C** (emisor monotributista o exento), **M** (RI con observaciones), **E** (exportación, WSFEX), **FCE MiPyME** (A/B/C 201 a 213) cuando el receptor es empresa grande y se supera el monto mínimo. Decisión automática por emisor + receptor + monto. |
| Discriminación en factura B (Transparencia Fiscal al Consumidor, Ley 27.743) | Falta | La factura a consumidor final informa el IVA contenido y otros impuestos nacionales indirectos. Hay que poder calcularlo por ítem. |
| Tope de identificación de consumidor final | Falta | Sobre cierto monto la factura B a CF debe identificar al comprador (DNI/CUIT). El tope se actualiza por RG: parámetro con vigencia. |
| Moneda extranjera | Falta | Factura en USD con cotización, conversión del IVA a pesos con el tipo de cambio que fije la norma. |

### 4.2 Impuestos internos

Ley de impuestos internos (Ley 24.674 y modificatorias): bebidas alcohólicas, tabacos, cervezas, objetos suntuarios, ciertos electrónicos (con alícuotas reducidas según origen, por ejemplo régimen de Tierra del Fuego), telefonía, seguros, vehículos y embarcaciones. Para el sistema:

- **Catálogo de impuestos internos** por rubro con alícuota y **vigencia** (las alícuotas cambian por decreto).
- **Base:** se calcula sobre el precio neto de venta. Ojo con la **tasa nominal vs. efectiva**: como el impuesto integra su propia base, una tasa nominal del 20 % equivale a un 25 % sobre el precio sin impuesto. El sistema debe guardar la nominal y calcular la efectiva.
- **Inclusión en precio:** el precio de lista al público lo incluye. En factura A se discrimina (array `Tributos` de WSFE, tributo "impuestos internos") y su tratamiento en la base de IVA sigue el art. 10 de la Ley de IVA. Configurable por producto: "incluido en precio" sí/no.
- **Por producto y por sucursal** (Napse lo tiene así por la jurisdicción).
- DDJJ mensual de internos: reporte de base y tributo por rubro.

### 4.3 Percepciones (el comercio como agente)

| Régimen | Qué hace el sistema | Estado |
|---|---|---|
| **Percepción de IVA** (RG 2408 y otras específicas por actividad) | Si el comercio fue designado agente: percibe a RI sobre el neto, con alícuota según condición del cliente y mínimo no sujeto. Excluidos con certificado de exclusión. | Falta |
| **IIBB Provincia de Buenos Aires (ARBA)** | Agente de percepción: alícuota **por CUIT del padrón mensual** de ARBA, base neta, monto mínimo. Sin CUIT en padrón: alícuota máxima o no percibe según norma. DDJJ y pago por la aplicación de ARBA (archivo de importación). | Falta |
| **IIBB CABA (AGIP / ARCIBA)** | Padrón de regímenes generales por CUIT con alícuota de percepción y retención; padrón de alto riesgo fiscal. DDJJ con archivo de e-ARCIBA. | Falta |
| **Otras jurisdicciones** (Córdoba, Santa Fe, Mendoza, Tucumán, etc.) | Cada una con su padrón, alícuotas y aplicativo. Modelar como "jurisdicción" genérica con padrón importable. | Falta |
| **Convenio Multilateral** | El comercio con actividad en varias jurisdicciones: percepciones a contribuyentes de CM, coeficientes unificados (CM05), declaración vía **SIFERE**; percepciones y retenciones de agentes de varias provincias por **SIRCAR**. | Falta |
| **Percepciones municipales** | Algunas tasas municipales. Genérico "otros tributos". | Falta |

**Cómo se calcula (motor H105):** regla = (jurisdicción del comercio o de la entrega) × (impuesto) × (condición del cliente) → alícuota (de padrón por CUIT si existe, si no la general) + mínimo de base + mínimo de percepción + exclusiones vigentes. Se aplica sobre el neto gravado del comprobante (o sobre el total según régimen), se suma al total, se informa en `Tributos` de WSFE y se registra para la DDJJ. Es exactamente lo que Napse modela como "relaciones impositivas" (jurisdicción × impuesto × categoría del cliente).

### 4.4 Retenciones

| Régimen | Como agente (pagos a proveedores) | Como sujeto (lo que le retienen al comercio) | Estado |
|---|---|---|---|
| **Ganancias** (RG 830) | Retiene al pagar a proveedores según concepto, escala y mínimo no sujeto; certificado de retención. | Retenciones sufridas para imputar a su DDJJ. | Falta |
| **IVA** (agentes designados) | Retiene IVA al pagar si fue designado agente. | Retenciones sufridas, computables. | Falta |
| **IIBB** por jurisdicción | Retiene según padrón. | Retenciones y percepciones sufridas, más **SIRCREB** (recaudación sobre acreditaciones bancarias) y **SIRTAC** (recaudación sobre liquidaciones de tarjetas y billeteras): se ven en la liquidación de tarjetas y en el extracto bancario, y son pago a cuenta de IIBB. | Falta |
| **SUSS** (seguridad social, RG 1784 / 1769 y otras por actividad) | Retención a contratistas de construcción, limpieza, seguridad, etc. | Sufridas. | Falta |
| **Declaración** | **SICORE** y **SIRE** (según impuesto y régimen) con archivo de exportación; certificados en PDF. | Import de retenciones sufridas (por ejemplo "Mis Retenciones" de ARCA). | Falta |

Las retenciones como agente viven en el módulo de **pagos a proveedores** (H101 + H106); las sufridas en tarjetas (SIRTAC, comisiones, IVA sobre comisiones) se capturan en la **conciliación de tarjetas** (H110) y en bancos (SIRCREB, impuesto a los débitos y créditos bancarios) en la conciliación bancaria.

### 4.5 Padrones y condición fiscal

| Ítem | Diseño | Estado |
|---|---|---|
| Constancia de inscripción de ARCA por CUIT | Consulta online (web service de padrón de ARCA, alcance A5/A13 o el vigente) al dar de alta un cliente o proveedor: razón social, domicilio fiscal, condición de IVA, monotributo (categoría), actividades, impuestos. Cache con fecha y re-validación periódica. | Falta |
| Padrones provinciales periódicos | Import mensual (ARBA, AGIP, otros) con alícuota de percepción y retención por CUIT y vigencia; job programado; historial (la alícuota que se usó es la vigente a la fecha del comprobante). | Falta |
| Certificados de exclusión | Carga por cliente o proveedor (IVA, Ganancias, IIBB) con vigencia y porcentaje; también consulta del listado público de ARCA. | Falta |
| Régimen del contribuyente | RI, monotributo (categoría y tope), exento, CF, no alcanzado, no categorizado. El tipo de comprobante y las percepciones salen de acá. | Parcial (`iva_condition`) |
| Alertas | Cliente monotributista que superaría tope, CUIT dado de baja, padrón vencido sin actualizar. | Falta |

### 4.6 Cómo alimenta todo a la facturación electrónica

Un comprobante WSFE (`FECAESolicitar`) se arma con: **punto de venta** (por sucursal o caja, F17/H98) → **tipo de comprobante** (emisor × receptor × monto, §4.1) → **concepto** (productos, servicios o ambos, con fechas de servicio) → **receptor** (tipo y n° de documento + **condición IVA del receptor**) → **importes**: total, neto no gravado, neto gravado, exento, IVA, tributos → **array `AlicIva`** (base e importe por alícuota, ids que se obtienen con `FEParamGetTiposIva`) → **array `Tributos`** (impuestos internos, percepciones de IVA, IIBB y municipales, ids con `FEParamGetTiposTributos`) → **moneda y cotización** → **comprobantes asociados** (para NC/ND) → **opcionales** (FCE: CBU, referencia comercial, "anulación") → **CAE** y vencimiento → QR fiscal (RG 4892) en el impreso. En contingencia, **CAEA** por quincena con rendición posterior. **Exportación** (factura E) usa otro servicio (WSFEX) con incoterms y permiso de embarque. **FCE MiPyME** (Ley 27.440) usa los tipos 201 a 213, tiene aceptación o rechazo del comprador y plazo, y conviene modelarla junto con la cuenta corriente.

Todo esto **depende** de H103 (alícuotas y tributos por ítem), H104 (condición del receptor), H105 (percepciones) y F17/H98 (punto de venta por sucursal). Sin ellos F3 sólo podría emitir facturas B y C simples.

### 4.7 Libros y regímenes de información

| Obligación | Contenido | Estado |
|---|---|---|
| **Libro IVA Digital** (RG 4597) ventas | Comprobantes emitidos con alícuotas, exento, no gravado, percepciones, internos; archivos de importación de ARCA. | Falta |
| **Libro IVA Digital** compras | Facturas de proveedor, importaciones (despachos), percepciones sufridas, crédito fiscal computable, prorrateo de crédito fiscal si hay operaciones exentas. | Falta |
| **SICORE / SIRE** | Retenciones y percepciones practicadas (nacionales). | Falta |
| **DDJJ IIBB** | ARBA (agente y contribuyente), e-ARCIBA, SIFERE (CM), SIRCAR (agentes CM). Archivos de exportación por aplicativo. | Falta |
| **Impuestos internos** | Base y tributo por rubro. | Falta |
| **Régimen de información de precios (SEPA)** | Las cadenas alcanzadas informan diariamente precios por sucursal a la Secretaría de Comercio. Archivo por sucursal desde las listas vigentes. | Falta |
| **Otros regímenes de información** | Los que ARCA o las provincias exijan al rubro (por ejemplo operaciones con tarjetas, compras y ventas). Diseñar un exportador genérico por plantilla. | Falta |

---

## 5. "Tag registration": interpretaciones

El pedido dice "TAG REGISTRATION" sin más contexto. Posibles lecturas, de más a menos probable para un POS argentino; **hay que confirmarlo con el dueño**:

| # | Interpretación | Qué implica | Se incluye |
|---|---|---|---|
| 1 | **Tags de producto** para clasificar, filtrar, armar listas y reglas de precio | Ya existe `products.tags text[]`. Falta usarlos como alcance de reglas de lista, promos, impuestos y reportes. | Sí (H100) |
| 2 | **Etiquetas de góndola y flejes** al cambiar precios (con precio por unidad de medida y, si aplica, precio sin impuestos nacionales) | Cola de precios cambiados, plantillas de fleje, impresión masiva por sucursal. | Sí (H100) |
| 3 | **Registro de códigos de barras GS1** (EAN-13/GTIN del producto propio) | Guardar GTIN validado (dígito verificador), prefijo de empresa GS1, códigos de balanza; validar al importar. No hay API pública obligatoria: es dato maestro. | Sí (H112) |
| 4 | **Registros sanitarios y de producto**: RNPA/RNE (alimentos, INAL/ANMAT), PM/PL (ANMAT, productos médicos y cosméticos), SENASA, INV (vinos), certificación de seguridad eléctrica y etiqueta de eficiencia energética | Campos por producto con n° de registro, vencimiento y alerta; impresión en etiqueta propia; bloqueo opcional de venta si venció. | Sí (H112) |
| 5 | **Régimen de información de precios SEPA** y programas oficiales de precios (Precios Justos y similares, hoy variables según gestión) | Exportación diaria de precios por sucursal; marca de productos adheridos a programas con su precio tope. | Sí (H112) |
| 6 | **Registro de importadores y licencias de importación** (SIMI/SIRA en su momento, hoy reemplazados; registro aduanero) | Datos del importador y de la licencia por carpeta de importación. | Sí, dentro de H102 |
| 7 | **RFID / tags antirrobo** | Hardware de prevención de pérdidas; fuera del alcance fiscal. | No (backlog F10) |
| 8 | **"Tax registration"** (inscripción fiscal) mal escrito | Sería la inscripción del comercio y la validación de CUIT contra padrón: cubierto en H104. | Sí, vía H104 |

---

## 6. Contabilidad

| Ítem | Estado | Prio | Esf. | Hito |
|---|---|---|---|---|
| Plan de cuentas (plantilla argentina comercial precargada, editable, niveles) | Falta | P1 | M | H109 |
| Asientos automáticos por **venta** (ventas, IVA DF, internos, percepciones a pagar, CMV/stock), **cobro** (caja, bancos, tarjetas a cobrar, deudores), **compra** (mercadería, IVA CF, percepciones sufridas, proveedores), **pago** (proveedores, retenciones a depositar, bancos) | Falta | P1 | L | H109 |
| Asientos resumidos (por día, sucursal y medio) o detallados (por comprobante), configurable | Falta | P1 | S | H109 |
| Centros de costo = sucursal (y opcional por unidad de negocio) | Falta | P1 | S | H109 (requiere F17/H89) |
| Conciliación de tarjetas y billeteras | **En curso** (`feat/conciliacion-tarjetas`: reporte, `card_voucher.comercio`, `payments.reconciled_at`) | P1 | L | H110 |
| Conciliación bancaria (extracto importado contra cobros, pagos, depósitos y liquidaciones; SIRCREB e impuesto al cheque) | Falta | P2 | L | H110 |
| Cierre mensual (bloqueo de período, re-apertura auditada) | Falta | P1 | M | H109 |
| Libros: Diario, Mayor, Balance de sumas y saldos; Libro IVA (§4.7) | Falta | P2 | M | H109 |
| Exportación a estudios contables: **Tango**, **Bejerman**, **Holistor**, **Xubio**, **Colppy**, Excel con layout configurable | Falta | P1 | M (por formato) | H109 |
| Ajuste por inflación (contable RT 6; impositivo Título VI de Ganancias) | Falta | P3 | L | H109 (se recomienda resolverlo en el sistema contable del estudio; el POS exporta datos con fecha y moneda homogénea) |
| Diferencias de cambio | Falta | P2 | S | H109 |
| Tesorería (caja fuerte, retiros a banco, rendiciones) | Falta | P2 | L | H111 |

**Criterio del auditor:** el POS no tiene que ser el sistema contable del estudio; tiene que **generar asientos correctos, inmutables y trazables** desde los documentos (ventas, cobros, compras, pagos, Z, liquidaciones) y **exportarlos** en el formato del estudio. Corregir siempre por contra-asiento, nunca editando. El cierre de período bloquea cualquier documento con fecha anterior (incluidas anulaciones: se anulan con fecha del día y NC).

---

## 7. Matriz consolidada (existe / parcial / falta)

| Área | Ítem | Estado | Prio | Esf. | Hito | Clasificación |
|---|---|---|---|---|---|---|
| Precios | Listas por canal con % y precio fijo | Existe | ok | n/a | H10 | OPTIONAL `listas_precios` |
| Precios | Validación de precio en servidor | Falta | **P0** | S | H100 | BASE |
| Precios | Asistente de actualización masiva simple con vista previa | Falta | P1 | M | H100 | BASE |
| Precios | Vigencia, programación, vencimiento y alertas | Falta | P1 | M | H100 | OPTIONAL `listas_precios` |
| Precios | Lista por cliente, grupo, condición de pago | Falta | P1 | M | H100 | OPTIONAL `listas_precios` |
| Precios | Derivadas de costo, markup, margen, redondeo psicológico | Falta | P1 | M | H100 | OPTIONAL `listas_precios_pro` |
| Precios | Plazos 30/60/90 con recargo financiero | Falta | P2 | M | H100 | OPTIONAL `listas_precios_pro` |
| Precios | Moneda extranjera y tipos de cambio | Falta | P2 | M | H100 | OPTIONAL `listas_precios_pro` |
| Precios | Escalas por cantidad | Falta | P2 | S | H100 | OPTIONAL `listas_precios_pro` |
| Precios | Actualización por índice o por lista de proveedor | Falta | P2 | M | H100 | OPTIONAL `listas_precios_pro` |
| Precios | Historial de precios y auditoría | Falta | P1 | S | H100 | BASE |
| Precios | Aprobación de listas | Falta | P2 | S | H100 | OPTIONAL `listas_precios_pro` |
| Precios | Etiquetas al cambiar precio | Parcial | P1 | S | H100 | BASE |
| Compras | Proveedores, OC, recepción, factura, cuenta corriente | Falta | P1 | L | H101 | OPTIONAL `compras` |
| Compras | Costos reposición / PPP / último | Falta | P1 | M | H101 | BASE (costo) + OPTIONAL `compras` |
| Compras | Costeo de importación y despacho | Falta | P2 | L | H102 | OPTIONAL `importaciones` |
| Impuestos | Catálogo de alícuotas IVA (exento ≠ no gravado) | Parcial | **P0** | S | H103 | BASE |
| Impuestos | Impuestos internos | Falta | P1 | M | H103 | OPTIONAL `impuestos_internos` |
| Impuestos | Condición fiscal contra padrón ARCA | Falta | P1 | M | H104 | BASE (alta manual) + OPTIONAL `padrones` (consulta automática) |
| Impuestos | Padrones provinciales y certificados de exclusión | Falta | P1 | M | H104 | OPTIONAL `padrones` |
| Impuestos | Percepciones IVA e IIBB (ARBA, AGIP, CM, otras) | Falta | P1 | L | H105 | OPTIONAL `percepciones` |
| Impuestos | Retenciones como agente y sufridas | Falta | P2 | L | H106 | OPTIONAL `retenciones` |
| Fiscal | Factura electrónica A/B/C con CAE | Falta (MARKETING-FUTURO) | P1 | L | F3 | OPTIONAL `facturacion_afip` |
| Fiscal | Tributos, condición del receptor, M, FCE MiPyME, E, Transparencia Fiscal, tope de identificación | Falta | P1 | L | H107 | OPTIONAL `facturacion_afip` (+ `factura_exportacion` OPTIONAL Enterprise) |
| Fiscal | PV por sucursal, CAEA | Falta | P1 | M | F17/H98 | OPTIONAL `facturacion_afip` |
| Libros | Libro IVA Digital ventas y compras, SICORE/SIRE, DDJJ IIBB | Falta | P1 | L | H108 | OPTIONAL `export_contable` |
| Registros | GTIN, registros sanitarios, SEPA, programas de precios | Falta | P2 | M | H112 | BASE (campos) + OPTIONAL `sepa` |
| Contable | Plan de cuentas, asientos, centros de costo, cierre | Falta | P1 | L | H109 | OPTIONAL `contabilidad` |
| Contable | Export a estudios (Tango, Bejerman, Holistor, Xubio, Colppy, Excel) | Falta | P1 | M | H109 | OPTIONAL `export_contable` / ADDON `integracion_erp` |
| Contable | Conciliación de tarjetas | En curso | P1 | L | H110 | OPTIONAL `conciliacion_tarjetas` |
| Contable | Conciliación bancaria | Falta | P2 | L | H110 | OPTIONAL `conciliacion_bancaria` |
| Contable | Tesorería | Falta | P2 | L | H111 | OPTIONAL `tesoreria` |
| Contable | Ajuste por inflación | Falta | P3 | L | H109 | OPTIONAL `contabilidad` |

---

## 8. Plan por fases (F18)

| Etapa | Hitos | Entrega | Motivo |
|---|---|---|---|
| **0. Control interno** | H100 (parte) | `create_sale` recalcula precio de lista; diferencias como descuento autorizado; historial de precios. | Cierra la debilidad de §1.2 y no cambia nada visible. |
| **1. Base fiscal** | H103, H104 | Catálogo de alícuotas, condición fiscal del cliente (manual + padrón ARCA), impuestos internos. | Prerrequisito de F3. |
| **2. Facturar bien** | F3 + H107 + F17/H98 | CAE con tributos, condición del receptor, PV por sucursal, Transparencia Fiscal. | Lo que promete `facturacion_afip`. |
| **3. Precios PRO** | H100 | Vigencias, programación, derivadas de costo, plazos, moneda, escalas, índices, etiquetas. | Pedido explícito; independiente de F3. |
| **4. Compras** | H101, H102 | Proveedores, OC, recepción, facturas, costos, importación. | Alimenta costo, crédito fiscal y markup. |
| **5. Agente de percepción y retención** | H105, H106 | Percepciones IVA/IIBB, retenciones en pagos. | Obligatorio para comercios designados agentes. |
| **6. Libros y contabilidad** | H108, H109, H110, H111 | Libro IVA Digital, DDJJ, asientos, export a estudios, conciliaciones, tesorería. | Cierra el circuito con el contador. |
| **7. Registros** | H112 | GTIN, registros sanitarios, SEPA. | Según rubro del cliente. |

---

## 9. Keys de features propuestas

| Key | Categoría | Plan sugerido | Dependencias |
|---|---|---|---|
| (sin key) validación de precio, historial, alícuotas IVA, condición fiscal manual, costo, campos de registro | BASE | Todos | Ninguna |
| `listas_precios` (existe) | OPTIONAL | Business | Ninguna |
| `listas_precios_pro` | OPTIONAL | Business | `listas_precios` |
| `compras` | OPTIONAL | Pro | Ninguna |
| `importaciones` | OPTIONAL | Enterprise | `compras` |
| `impuestos_internos` | OPTIONAL | Pro | H103 |
| `padrones` | OPTIONAL | Pro | H104 |
| `percepciones` | OPTIONAL | Business | `padrones` |
| `retenciones` | OPTIONAL | Business | `compras`, `padrones` |
| `facturacion_afip` (existe, MARKETING-FUTURO) | OPTIONAL | Pro | F3, H103, H104 |
| `factura_exportacion` | OPTIONAL | Enterprise | `facturacion_afip` |
| `export_contable` | OPTIONAL | Pro | F3 para Libro IVA |
| `contabilidad` | OPTIONAL | Business | `export_contable` |
| `conciliacion_tarjetas` | OPTIONAL | Business | n° de comercio (en curso) |
| `conciliacion_bancaria` | OPTIONAL | Business | `contabilidad` |
| `tesoreria` | OPTIONAL | Business | F17/H89 |
| `integracion_erp` | ADDON | Por negocio | `contabilidad` |
| `sepa` | OPTIONAL | Enterprise | F17/H94 (precio por sucursal) |

Cada key sigue el checklist de `CLAUDE.md` (features, `plans.limits.modules`, gating server-side con `tenant_has_feature_for`, copy en `featureInfo.ts`, comparación en `planComparison.ts`). Hasta que exista la función, la comparación de planes la muestra como "Próximamente" y el decision-log registra la deuda.
