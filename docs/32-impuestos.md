# Impuestos: IVA, internos, condición fiscal, percepciones, retenciones y padrones

Decisión: [ADR-068](./17-decision-log.md), [ADR-079](./17-decision-log.md) (retenciones como agente), [ADR-095](./17-decision-log.md) (como sujeto e IIBB) y [ADR-101](./17-decision-log.md) (todo personalizable por el negocio) · Hitos: F18 · H103 a H106 ([roadmap](./02-roadmap.md)) · Auditoría: [`auditoria-fiscal-contable-precios.md`](./auditoria-fiscal-contable-precios.md)

> **Aviso normativo.** Alícuotas, topes, mínimos, códigos de ARCA y diseños de padrón son **orientativos**. Se modelan como datos (catálogos, `tax_parameters`, regímenes cargados por el negocio), nunca como constantes del código, y hay que validarlos con el contador del negocio y la norma vigente. Desde ADR-101 cada uno es una plantilla que el negocio puede pisar con vigencia (ver § 1.1).

## 1. Qué hace

| Pieza | Dónde | Feature |
|---|---|---|
| Alícuota de IVA del catálogo por producto y variante, servicio | Ficha del producto, pestaña Precios, "Impuestos" | `impuestos_iva` (BASE) |
| Listas con IVA incluido o netas | Listas de precios, "Precios con IVA incluido" | `impuestos_iva` |
| Datos fiscales del negocio | Configuración > Impuestos | `impuestos_iva` |
| Condición fiscal del cliente, documento validado, jurisdicción, comprobante que le corresponde | Ficha del cliente | `impuestos_iva` |
| Desglose de cada venta (neto, IVA por alícuota, exento, no gravado) y letra | `create_sale` | `impuestos_iva` |
| Reporte de IVA ventas | Reportes > IVA | `impuestos_iva` |
| Impuestos internos por producto | Ficha del producto | `impuestos_internos` (Pro) |
| Regímenes de percepción y retención, padrones, exclusiones | Configuración > Impuestos, ficha del cliente | `percepciones_retenciones` (Business) |
| Percepciones en el cobro y en el ticket | POS | `percepciones_retenciones` |
| Retenciones como agente calculadas en la orden de pago (Ganancias RG 830 con acumulado mensual, IVA, IIBB, SUSS) con certificado PDF | Compras > Orden de pago | `percepciones_retenciones` |
| Valores de retención (conceptos de la RG 830 y actividades de SUSS, ajustables) | Configuración > Impuestos | `percepciones_retenciones` |
| Retenciones practicadas del mes, certificados, archivos SICORE y ARBA | Compras > Retenciones practicadas | `percepciones_retenciones` |
| Retenciones y percepciones sufridas (procesadores, SIRCREB, SIRTAC, clientes, Mis Retenciones) con asiento | Contabilidad > Retenciones sufridas | `percepciones_retenciones` |
| Liquidación mensual de Ingresos Brutos por jurisdicción (actividades, Convenio Multilateral, saldo a favor) | Contabilidad > Ingresos Brutos | `percepciones_retenciones` |

## 1.1 Qué es personalizable y dónde (ADR-101)

Requisito del dueño: **la configuración impositiva es 100 % del negocio**. Todo valor que NinjaSoft siembra es una **plantilla orientativa**: el negocio la usa tal cual, la pisa con una **versión con vigencia** (desde, y opcionalmente hasta), la **desactiva** en un período, suma **valores propios** o **vuelve a la plantilla** (se quitan sus versiones; lo ya calculado no cambia). El cálculo del servidor lee siempre el **valor efectivo** (versión que cubre la fecha > plantilla). Cada pantalla marca "Plantilla NinjaSoft", "Personalizado", "Propio" o "Desactivado" y tiene historial (audit_logs). Edita el dueño o el encargado (docs/06).

| Valor | Plantilla de NinjaSoft | Dónde se cambia (Configuración > Impuestos) | Qué puede hacer el negocio | Lo lee (servidor) | Feature |
|---|---|---|---|---|---|
| Alícuotas de IVA (21, 10,5, 27, 5, 2,5, 0) | `tax_iva_rates` | IVA > Alícuotas de IVA | Alícuota y nombre con vigencia; exento y no gravado sólo el nombre. El código y el id de ARCA los fija ARCA | `_sale_tax_compute`, `_tax_price_to_final`, `price_context_snapshot` (`tax.rates` para el resolver del POS) | `impuestos_iva` |
| Alícuota de cada producto, variante e ítems sin producto | 21 % | Ficha del producto; Datos fiscales | Del negocio desde ADR-068 | `create_sale` | `impuestos_iva` |
| Impuestos internos | Ninguna | Ficha del producto | Del negocio desde ADR-068 (fijo, % sobre precio o costo) | `_sale_tax_compute` | `impuestos_internos` |
| Tope para vender a consumidor final sin identificarlo | `tax_parameters.cf_id_threshold` | IVA > Valores de IVA | Monto con vigencia o desactivado (sin aviso) | `_sale_tax_compute`, `tax_settings_get` | `impuestos_iva` |
| Regímenes de percepción: jurisdicción, padrón, alícuota general, alícuota por condición, base, mínimos de base y de importe, condiciones alcanzadas, n° de agente, código | Plantillas de arranque en la pantalla | Percepciones | Todo editable; vigencia del régimen (`valid_from`, `valid_to`); cambios de alícuota y mínimos con vigencia sin cambiar de régimen (`regime_values`) | `_sale_tax_compute` | `percepciones_retenciones` |
| Regímenes de retención (IVA, IIBB, Ganancias, SUSS) | Plantillas de arranque | Retenciones > Regímenes | Igual que percepción; la numeración de certificados sigue por régimen | `_tax_retention_compute` | `percepciones_retenciones` |
| Padrones: diseño del archivo | Perfiles ARBA, AGIP y genérico (`BUILTIN_PROFILES`) | Padrones > Mis perfiles | Perfiles propios: CSV o ancho fijo, separador, columnas o posiciones, formato de fecha, decimales, escala de la alícuota, columna de régimen; vista previa con errores por fila antes de aplicar | `tax_padron_import_*` | `percepciones_retenciones` |
| Padrones: alícuota y vigencia por CUIT | El archivo del organismo | Padrones | Import por período; **alícuota a mano por CUIT** con vigencia que manda sobre los archivos | `_tax_padron_rate` | `percepciones_retenciones` |
| Exclusiones (certificados) | Ninguna | Ficha del cliente o del proveedor | Porcentaje y vigencia | `_tax_exemption_pct` | `percepciones_retenciones` |
| Conceptos de Ganancias RG 830: mínimo no sujeto, alícuota inscripto y no inscripto, escala sí o no, retención mínima, códigos de SICORE | `tax_ret_concepts` (RG 5423/2023) | Retenciones > Conceptos de retención | Versión con vigencia, desactivar, **conceptos propios** | `tax_ret_concept_eff` → `_tax_retention_compute` | `percepciones_retenciones` |
| Actividades de SUSS: alícuota, pago y retención mínimos, código de SICORE | `tax_ret_concepts` (RG 4052, 1556, 1769, 3983) | Retenciones > Conceptos de retención | Igual que Ganancias | `_tax_retention_compute` | `percepciones_retenciones` |
| Escala del Anexo VIII | `tax_ret_scales` | Retenciones > Escalas | Tramos con vigencia; **escalas propias** para conceptos propios | `_tax_ret_scale_amount_for` | `percepciones_retenciones` |
| Criterio para el proveedor sin constancia de Ganancias | Inscripto con aviso (`gan_unknown_as_unregistered = 0`) | Retenciones > Criterios de retención | Inscripto o no inscripto, con vigencia | `_tax_retention_compute` | `percepciones_retenciones` |
| Código de impuesto de IVA en SICORE | 767 (`sicore_iva_tax_code`) | Exportaciones | Con vigencia (queda en la foto de cada retención) | `_tax_retention_compute` | `percepciones_retenciones` |
| Código de comprobante de SICORE, sucursal y actividad de ARBA | 06, 0001 y 6 | Exportaciones | Con vigencia | `lib/tax/sicore.ts` (`buildExport` con `ExportOptions`) | `percepciones_retenciones` |
| Alícuota e impuesto mínimo de IIBB por actividad y jurisdicción | `iibb_activity_templates` (CABA 3 %, Provincia de Buenos Aires 3,5 %) | IIBB (cambios con vigencia y volver a la plantilla); altas en Contabilidad > Ingresos Brutos | Actividades propias; cambios con vigencia (rige el vigente el primer día del mes) | `_iibb_compute` | `percepciones_retenciones` |
| Coeficientes de Convenio Multilateral | Ninguna (lo calcula el contador) | Contabilidad > Ingresos Brutos > Convenio Multilateral | Por jurisdicción y vigencia (ADR-095) | `_iibb_compute` | `percepciones_retenciones` |
| Clasificación de retenciones sufridas por texto o código | Palabras clave de `_tax_suffered_classify` | Retenciones > Cómo clasificar las retenciones que te hacen | **Reglas propias** con vigencia (ignorar, impuesto, tipo, régimen, jurisdicción); gana el patrón más largo | `_tax_suffered_classify_for` (procesadores), `parseSufferedFile` (archivos) | `percepciones_retenciones` |
| Jurisdicciones (901 a 924) e ids de ARCA (AlicIva, condiciones, documentos, tributos) | `tax_jurisdictions` y catálogos de ARCA | No se editan | Son códigos oficiales: un valor distinto rompería WSFE, el Libro IVA y SICORE | | |

Gating real en el servidor: `tax_custom_save`, `tax_custom_delete` y `tax_custom_reset` exigen dueño o encargado y la feature del catálogo (`impuestos_iva` para IVA y el tope del consumidor final; `percepciones_retenciones` para el resto); los perfiles de padrón, `tax_can_write('percepciones_retenciones')` en la policy. Sin la feature, el valor efectivo sigue siendo la plantilla.

## 2. Cálculo

El precio de venta es **final** (lo que paga el cliente). Para cada venta:

1. **Reparto:** el total sin percepciones (con descuentos, promo, cupón, redondeo y envío) se reparte entre las líneas en proporción a su bruto, por resto mayor (los centavos que sobran van a las fracciones más grandes; empate, la primera línea).
2. **Internos** por línea:
   - monto fijo: `cantidad × monto`;
   - % sobre costo: `cantidad × costo × tasa`;
   - % sobre precio: la tasa es **nominal** (integra su propia base). Efectiva `e = t / (1 − t)` (20 % nominal = 25 % sobre el neto); `N = G / (1 + IVA + e)`, `I = N × e`.
   Los internos discriminados no integran la base del IVA.
3. **IVA por alícuota** sobre la base agregada: `base = redondeo(Σ(G − I) / (1 + alícuota))`, `IVA = Σ(G − I) − base`; la base se reparte a las líneas por resto mayor. Diferencia máxima con `base × alícuota`: un centavo.
4. Emisor monotributista, monotributo social, exento o no alcanzado: no discrimina IVA (todo es neto) y emite C.
5. **Percepciones** (si el negocio es agente, hay cliente con CUIT válido y su condición está alcanzada): alícuota del padrón vigente a la fecha; si no figura, la de su condición o la general; menos la exclusión vigente; base neta, neta gravada o total; mínimos de base y de monto. Se suman al total **después** del redondeo de caja.

Lista neta o internos adicionales: el resolver lleva el precio cargado a final antes de validar (`_tax_price_to_final`). Ejemplo con IVA 21 % e internos 20 % nominal: lista con IVA 1.210 + internos adicionales, lista neta 1.250 con internos incluidos o lista neta 1.000 con internos adicionales dan el mismo final, 1.460.

## 3. Comprobante que corresponde

| Emisor \ Receptor | RI, monotributo | CF, exento, no responsable, no categorizado, no alcanzado, IVA liberado | Exterior |
|---|---|---|---|
| Responsable inscripto | A (M si ARCA lo indicó) | B | E |
| Monotributo, exento, no alcanzado | C | C | E |
| Sin configurar | sin letra | sin letra | sin letra |

Avisos guardados en la venta: `cf_identification_required` (consumidor final sin documento por encima del tope `cf_id_threshold`) y `receptor_cuit_missing` (A o M sin CUIT).

## 4. Padrones: diseños de registro

Texto plano, una línea por CUIT, separador `;`, decimales con coma. Se leen en el navegador por partes y se suben en tandas de hasta 5000 filas. Por defecto sólo los CUIT de clientes y proveedores ("Sólo CUIT de mis clientes y proveedores").

**ARBA · Padrón de regímenes generales** (`PadronRGSPerMMAAAA.txt` percepción, `PadronRGSRetMMAAAA.txt` retención; se descarga con la clave CIT del agente):

| # | Campo | Ejemplo |
|---|---|---|
| 1 | Régimen (P percepción, R retención) | `P` |
| 2 | Fecha de publicación (ddmmaaaa) | `25092026` |
| 3 | Vigencia desde | `01102026` |
| 4 | Vigencia hasta | `31102026` |
| 5 | CUIT | `30712345671` |
| 6 | Tipo de contribuyente (D directo, C convenio) | `D` |
| 7 | Marca alta de sujeto (S, N, B) | `S` |
| 8 | Marca cambio de alícuota (S, N) | `N` |
| 9 | Alícuota | `1,50` |
| 10 | N° de grupo | `03` |

**AGIP · Padrón de regímenes generales** (mensual, percepción y retención en la misma línea):

| # | Campo | Ejemplo |
|---|---|---|
| 1 | Fecha de publicación | `25092026` |
| 2 | Vigencia desde | `01102026` |
| 3 | Vigencia hasta | `31102026` |
| 4 | CUIT | `30712345671` |
| 5 | Tipo de contribuyente | `C` |
| 6 | Marca alta de sujeto | `S` |
| 7 | Marca cambio de alícuota | `N` |
| 8 | Alícuota de percepción | `1,00` |
| 9 | Alícuota de retención | `0,50` |
| 10 | Grupo de percepción | `03` |
| 11 | Grupo de retención | `02` |
| 12 | Razón social | `EMPRESA SA` |

**Genérico** (cualquier jurisdicción): `CUIT;percepción;retención;desde;hasta`, separador `;` o `,`, fechas `dd/mm/aaaa`, `ddmmaaaa` o `aaaa-mm-dd`, encabezado opcional.

**Perfiles del negocio (ADR-101).** Los tres diseños de arriba son perfiles de plantilla (`lib/tax/padronProfile.ts`, `BUILTIN_PROFILES`, misma lectura que `parsePadronLine`). Para otro diseño el negocio arma un perfil (`tax_padron_profiles`): CSV con separador (`;`, `,`, `|`, tabulador o detectar) o texto de ancho fijo; columna (1 = primera) o posición y largo (1 = primer carácter) de CUIT, alícuota de percepción, de retención o una sola alícuota con columna de régimen (valores P y R configurables), vigencia desde y hasta (o el período elegido al importar), grupo y razón social; formato de fecha (ddmmaaaa, dd/mm/aaaa, aaaa-mm-dd, aaaammdd o detectar), separador decimal, escala de la alícuota (150 = 1,50 %), encabezado y líneas a saltear. Antes de aplicar se ve una **vista previa** (primeras filas leídas y hasta 50 filas con error con su número de línea, motivo y texto). El import guarda `profile_id`. La **alícuota a mano por CUIT** (`tax_padron_manual_set`, formato `manual`) manda sobre los archivos mientras esté vigente y no se reemplaza al importar el mes.

Líneas con CUIT inválido, fechas al revés o alícuota ilegible se informan (las primeras 50) y no se cargan. Al cerrar el import se reemplazan los del mismo período y jurisdicción; los de otros meses quedan para ventas con fecha vieja. Fixtures en `tests/fixtures/padron/`.

## 5. Datos

- `tax_iva_rates`, `tax_jurisdictions`, `tax_parameters` (globales, sólo lectura).
- `products.tax_rate_code` (`tax_rate` espejo), `is_service`, `internal_tax_*`; `product_variants.tax_rate_code`; `price_lists.prices_include_tax`; `customers.iibb_jurisdiction` y condición ampliada.
- `tax_settings` (negocio), `tax_regimes`, `tax_exemptions`, `tax_padron_imports`, `tax_padron_entries`.
- Venta: `sales.cbte_letter`, `fiscal_snapshot`, `net_taxed`, `net_exempt`, `net_untaxed`, `iva_total`, `internal_tax_total`, `perception_total` (`tax_total` = IVA + internos + percepciones); `sale_items.tax_rate_code`, `iva_rate`, `taxed_total`, `net_amount`, `iva_amount`, `internal_tax_amount`; `sale_tax_lines` (AlicIva, internos y percepciones con id de ARCA).
- Vista `tax_suffered`: percepciones y tributos sufridos en comprobantes de compra.

RPC: `tax_settings_get`, `tax_settings_save`, `sale_tax_preview`, `tax_padron_import_start | _rows | _finish | _delete`, `tax_padron_lookup`, `tax_retention_suggest` (reemplazada en la orden de pago por `tax_retention_preview`), `report_iva_ventas`, `cbte_letter_infer`, `tax_param`.

Retenciones como agente (ADR-079): `tax_ret_concepts` y `tax_ret_scales` (globales, sólo lectura), `tax_ret_concept_settings` y `supplier_tax_profiles` (por negocio), `tax_withholdings` (registro); RPC `tax_retention_preview`, `tax_ret_concepts_list`, `tax_withholdings_list`, `tax_withholdings_export`; `supplier_payment_order_create` recreada.

Personalización (ADR-101): `tax_custom_values` (versiones del negocio con vigencia por catálogo: `iva_rate`, `parameter`, `ret_concept`, `ret_scale`, `regime_values`, `iibb_activity`, `suffered_rule`), `tax_padron_profiles`, `tax_regimes.valid_from` / `valid_to`, `tax_padron_imports.profile_id`. Resolución: `_tax_custom_at`, `tax_param_for`, `_tax_iva_rate_eff`, `_tax_regime_eff`, `_tax_ret_scale_amount_for`, `tax_ret_concept_eff` (recreada), `_tax_suffered_classify_for`. RPC `tax_custom_save`, `tax_custom_delete`, `tax_custom_reset`, `tax_custom_history`, `tax_ret_scale_get`, `tax_padron_manual_set`. Espejo puro en `lib/tax/custom.ts` (`versionAt`, `resolveCustom`).

## 6. Deploy

Migraciones `20261028100000` a `20261028100300` en orden, **antes del front** (el front escribe columnas nuevas). Sin Edges ni crons. Recrean `_resolve_unit_price`, `price_context_snapshot` y `create_sale`.

ADR-101: `20261110100000_impuestos_personalizables` y `20261110100100_impuestos_personalizables_calculo`, en orden y **antes del front** (el front lee `tax_regimes.valid_from` y las tablas nuevas). Recrean `_tax_price_to_final`, `price_context_snapshot`, `_sale_tax_compute`, `tax_settings_get`, `tax_ret_concept_eff`, `tax_ret_concepts_list`, `_tax_retention_compute`, `_iibb_compute`, `_tax_suffered_from_settlement`, `_tax_padron_rate`, `tax_padron_import_start` y `tax_padron_import_finish` desde su última definición: cualquier rama que los toque tiene que partir de acá. **No recrean `create_sale`.** Sin Edges ni crons.

## 7. Pendiente

Notas de crédito con reversa proporcional de impuestos (con F3), alícuota por operación según receptor, internos por sucursal y con vigencia, Convenio Multilateral con coeficientes, constancia de ARCA por CUIT, descarga programada de padrones, SIRE, archivos de DDJJ de IIBB (ARBA como contribuyente, e-ARCIBA, SIFERE, SIRCAR) y cálculo del coeficiente CM05, import del extracto bancario y consulta automática de Mis Retenciones y de COMARB (retenciones sufridas y liquidación mensual de IIBB hechas en ADR-095, § 9).

## 8. Retenciones como agente (ADR-079)

### Cómo se calcula

En la orden de pago, con la imputación (o el importe, si es a cuenta), el servidor arma las bases del pago: **neto sin IVA** (neto gravado + exento + no gravado en proporción a lo imputado), **neto gravado**, **total** y el **IVA facturado**. Después, por cada régimen de retención activo del negocio (`tax_regimes`, rol retención):

- **Ganancias (RG 830)**, por **concepto** (bienes, servicios, honorarios, alquileres, fletes):
  1. Monotributista: no se retiene. Exento o no alcanzado según la ficha: no se retiene. Sin concepto: se pide elegirlo.
  2. **Acumulado del mes** = pagos anteriores del mes al mismo proveedor por el mismo concepto (registrados en `tax_withholdings`, aunque no hayan retenido) + la base de este pago.
  3. **Sujeto** = acumulado − **mínimo no sujeto mensual** (a los **no inscriptos** no se les descuenta, salvo que el concepto diga lo contrario).
  4. **Retención del mes** = sujeto × alícuota (inscripto o no inscripto) o, para honorarios de inscriptos, la **escala** del Anexo VIII (fijo + excedente × %).
  5. **Ahora** = retención del mes − lo ya retenido en el mes. Si da cero o menos, no se retiene. **Exclusión** con certificado: 100 % no retiene; parcial, reduce.
  6. Si lo de ahora es menor que la **retención mínima**, no se retiene y el pago queda registrado para acumular con el próximo del mes.
- **SUSS**: sólo si el proveedor tiene cargada una actividad alcanzada (construcción, limpieza, seguridad, eventuales); alícuota de la actividad (o la general del régimen) sobre la base del régimen, con pago y retención mínimos.
- **IVA e IIBB**: alícuota del padrón, de la condición del proveedor o la general; base del régimen (`vat` = el IVA facturado, para la retención de IVA de agentes designados); mínimos de base y de importe; exclusión.

Todo en centavos con redondeo mitad hacia arriba. Espejo exacto en `lib/tax/retentions.ts` (paridad con `tests/fixtures/retentionMatrix.ts`). La condición en Ganancias vacía se toma como **inscripto** y la orden de pago lo avisa.

### Registro, certificados y asiento

Al registrar la orden de pago con `agent_retentions = true` el servidor **vuelve a calcular** (si el total no coincide con el que vio el usuario, `retentions_changed`), numera un **certificado correlativo por régimen** (`GAN-00000001`, `IVA-…`, `IIBB902-…`, `SUSS-…`), guarda cada cálculo en `tax_withholdings` con la foto del agente y del sujeto y deja cada retención en `supplier_payments.withholdings`: el asiento contable (ADR-066) las acredita en "Retenciones a depositar" sin cambios en el motor. Anular la orden de pago anula sus retenciones (el número no se reutiliza). El certificado se descarga o imprime en PDF desde el detalle de la orden de pago o desde Retenciones practicadas.

### Valores normativos: fuente y cómo actualizarlos

| Dato | Dónde vive | Fuente sembrada | Cómo se actualiza |
|---|---|---|---|
| Conceptos de Ganancias (mínimo no sujeto mensual, alícuotas, retención mínima, códigos de SICORE 217 / 078, 094, 116, 031, 095) | `tax_ret_concepts` (`verify = true`) | RG 830 Anexo VIII con montos de la RG 5423/2023, vigencia 01/07/2023 | Migración nueva que **agrega una fila** con la nueva `valid_from` (nunca se pisa la anterior: los pagos se calculan con lo vigente a su fecha). El negocio no espera: carga su versión con vigencia en Configuración > Impuestos > Retenciones (`tax_custom_values`, ADR-101; el ajuste viejo sin vigencia `tax_ret_concept_settings` sigue valiendo debajo). |
| Escala del Anexo VIII | `tax_ret_scales` | RG 830 Anexo VIII (tramos de 0 a 96.000) | Migración con filas nuevas para la nueva `valid_from`, o el negocio carga sus tramos con vigencia (Retenciones > Escalas, ADR-101). |
| Actividades de SUSS (alícuota, retención mínima) | `tax_ret_concepts` con `tax = 'suss'` | RG 4052 (construcción 1,2 %), RG 1556 (limpieza 6 %), RG 1769 (seguridad 6 %), RG 3983 (eventuales 8 %); retención mínima $ 400; código de régimen de SICORE **vacío** | Igual que Ganancias; el código de régimen de SICORE lo carga el negocio con su contador. |
| Regímenes del negocio (alícuota general, padrón, n° de agente, código de régimen de IVA) | `tax_regimes` | Plantillas orientativas en la pantalla | El negocio. |

**Todos los valores sembrados son orientativos y están marcados para verificar con el contador.**

### Archivos

- **SICORE** (`lib/tax/sicore.ts`): Ganancias (217), IVA (767) y SUSS (353); registro de 144 posiciones: código de comprobante 06 (orden de pago), fecha, número y total de la OP, impuesto, régimen, operación 1, base, fecha de retención, condición (01 inscripto, 02 no inscripto), sujeto suspendido 0, importe, % de exclusión, fecha de boletín vacía, tipo 80 y CUIT del retenido, certificado original en ceros. Importes con coma decimal, fechas dd/mm/aaaa, CRLF. En Ganancias con acumulado la base informada es la parte del sujeto del mes que corresponde a ese pago. Golden files en `tests/fixtures/sicore/`.
- **ARBA** (IIBB Buenos Aires, actividad 6): 47 posiciones (CUIT con guiones, fecha, sucursal 0001, n° de certificado, importe con punto decimal, operación A). Nombre `AR-CUIT-AAAAMM0-6-LOTE1.txt`.
- **AGIP (e-ARCIBA)** y otras provincias: **deuda** (se cargan con los datos de la lista).

Los diseños son **orientativos**: validar con una importación real en SICORE y en ARBA antes de presentar. Cada descarga queda en `audit_logs` (`tax_withholdings_exported`).

## 9. Como sujeto: retenciones sufridas e Ingresos Brutos (ADR-095)

### Retenciones y percepciones sufridas

Contabilidad > **Retenciones sufridas** (`/impuestos/sufridas`, feature `percepciones_retenciones`, dueño o encargado). Una fila por retención, percepción o pago a cuenta que le hacen al negocio, en `tax_suffered_entries`:

| Origen | Cómo entra | Documento vinculado (asiento) |
|---|---|---|
| Procesadores (Mercado Pago `charges_details`, liquidaciones por archivo) | Solo, al importar o sincronizar la liquidación (trigger) o con "Traer de las liquidaciones" | La línea de liquidación: se reclasifica desde "impuestos de procesadores" |
| Bancos (SIRCREB, débitos y créditos) | "Registrar" con origen Banco: crea el débito en la cuenta de tesorería o vincula uno cargado | El débito de tesorería |
| Clientes agentes de retención | "Registrar" con origen Cliente y el recibo de cuenta corriente (cobrado con el medio Otro) | El recibo |
| Mis Retenciones (ARCA), consulta de SIRCREB o SIRTAC (COMARB), planilla | "Importar archivo" (CSV o TXT con encabezado) | Ninguno (sin asiento hasta vincularla) |
| Proveedores | Percepciones de la factura de compra (vista `tax_suffered`, ADR-068) | La factura (su asiento ya las lleva) |

Clasificación de los impuestos de procesadores (`classifyTaxText` = `_tax_suffered_classify`): débitos y créditos (Ley 25.413) como pago a cuenta; IIBB (también por SIRTAC, SIRCREB, ARBA, AGIP); Ganancias; IVA; SUSS. El **IVA sobre la comisión** no es retención y se saltea. Jurisdicción por nombre o código (901 a 924); si no figura, la del negocio y queda **para revisar**. Las de IIBB sin jurisdicción no entran en la liquidación hasta asignarla.

Cada fila tiene un **mes de imputación** (por defecto el de la fecha) que decide en qué DDJJ se toma como saldo a favor. Importe, fecha y origen no se cambian: se anula con motivo y se carga de nuevo. Un mes de IIBB liquidado bloquea altas, cambios y anulaciones de esa jurisdicción.

**Asiento** (con Contabilidad): debe la cuenta de retenciones sufridas del impuesto (`retencion_sufrida`, detalle `iibb:902` o el impuesto; por defecto Percepciones de IIBB, IVA o Ganancias sufridas y "Retenciones e impuestos sufridos en cobros" para el resto) / haber la cuenta del documento vinculado. Sin documento no hay asiento.

### Liquidación mensual de Ingresos Brutos

Contabilidad > **Ingresos Brutos** (`/impuestos/iibb`):

1. **Actividades** por jurisdicción: código NAES, alícuota, impuesto mínimo mensual y categorías de productos; una principal toma lo que no tenga categoría asignada. Hay plantillas orientativas (`iibb_activity_templates`, `verify = true`).
2. **Base** de cada actividad = neto sin IVA, internos ni percepciones de los ítems de las ventas completadas del mes de las sucursales de la jurisdicción (provincia de la sucursal; sin provincia, la del negocio) − ventas de meses anteriores anuladas en el mes − devoluciones del mes (en proporción a lo vendido de cada actividad en esa venta). Ventas sin desglose: subtotal / (1 + alícuota del ítem), con aviso.
3. **Convenio Multilateral** (si está marcado en Configuración > Impuestos): base de todo el país × coeficiente unificado vigente de la jurisdicción (pestaña Convenio Multilateral; lo calcula el contador con el CM05; la suma de coeficientes no pasa de 1).
4. **Impuesto** = base × alícuota (centavos, mitad hacia arriba); base cero o negativa, cero; con mínimo, el mínimo si da menos.
5. **Deducciones**: retenciones, percepciones (más las de facturas de proveedor del mes), SIRCREB y SIRTAC imputadas al mes y a la jurisdicción, más el saldo a favor de la última liquidación confirmada (o el inicial, en la primera).
6. **Saldo a pagar** = impuesto − lo usado; **saldo a favor** para el mes siguiente = lo disponible − lo usado.

Confirmar (sólo meses terminados) recalcula en el servidor, guarda la foto y bloquea el mes. Asiento: debe Impuesto sobre los ingresos brutos / haber retenciones sufridas de IIBB (lo usado), percepciones de compras usadas e Ingresos brutos a pagar. Se anula sólo la última confirmada de la jurisdicción (contra-asiento). El XLSX tiene la liquidación y la base por actividad. **No se generan los archivos de ARBA, e-ARCIBA ni SIFERE**: los importes se cargan en el sistema del organismo.

### Valores sembrados (orientativos, verificar con el contador)

| Dato | Dónde | Valor sembrado |
|---|---|---|
| Comercio minorista y servicios, CABA | `iibb_activity_templates` | 3 % (Ley Tarifaria, alícuota general) |
| Comercio minorista y servicios, Provincia de Buenos Aires | `iibb_activity_templates` | 3,5 % (Ley Impositiva) |
| Clasificación de textos de procesadores | `_tax_suffered_classify` | Reglas por palabra clave (sección anterior) |

## Preguntas para el contador

Preguntas abiertas que dejan los hitos de F18. Hasta tener respuesta, el sistema usa lo indicado entre paréntesis.

**Retenciones como agente (ADR-079)**

1. ¿Los montos de la RG 830 (mínimos no sujetos, alícuotas, retención mínima $ 240) y la escala del Anexo VIII siguen vigentes o hubo una resolución posterior a la RG 5423/2023? (se usan los de la RG 5423/2023)
2. Para Ganancias con comprobantes B o C del proveedor, ¿la base es el total facturado? (se toma el neto cargado)
3. Proveedor sin condición en Ganancias cargada: ¿inscripto o no inscripto? (inscripto, con aviso)
4. Códigos de régimen de SICORE para SUSS por actividad (vacíos: los carga el negocio).

**Retenciones y percepciones sufridas (ADR-095)**

5. Las retenciones de IIBB que hace Mercado Pago sin indicar la provincia, ¿se imputan a la jurisdicción del domicilio fiscal del negocio? (sí, y quedan para revisar)
6. ¿Qué porcentaje del impuesto a los débitos y créditos computa el negocio como pago a cuenta de Ganancias (33 % o 20 % según el caso) y cómo se contabiliza el resto? (se registra entero como pago a cuenta en "Retenciones e impuestos sufridos en cobros")
7. Retención de IVA o Ganancias sufrida en un mes y tomada en otro: ¿hay límite de períodos? (el mes de imputación lo elige el usuario)
8. ¿El IVA sobre la comisión de los procesadores se toma como crédito fiscal en el Libro IVA de compras? (hoy no se registra como retención ni entra en compras: va con la acreditación a "impuestos de procesadores")
9. ¿Las columnas del CSV de Mis Retenciones y de las consultas de SIRCREB y SIRTAC que reciben coinciden con las que lee el importador (fecha, importe, impuesto, régimen, jurisdicción, CUIT del agente, certificado)? Pedimos un archivo real.

**Ingresos Brutos (ADR-095)**

10. Base imponible: ¿se excluyen IVA, impuestos internos y percepciones y se incluyen las ventas exentas y no gravadas de IVA? (sí)
11. Ventas anuladas después de cerrado el mes y devoluciones: ¿se descuentan en el mes en que ocurren? (sí, prorrateando las devoluciones por actividad)
12. ¿El impuesto mínimo se aplica por actividad o por jurisdicción, y corresponde con ventas cero? (por actividad, también con ventas cero)
13. Alícuotas de comercio minorista y servicios de CABA (3 %) y Provincia de Buenos Aires (3,5 %) sembradas como plantilla: ¿cuál corresponde al negocio según sus ingresos del año anterior y su código NAES?
14. Convenio Multilateral: ¿la base de cada jurisdicción es la base total del país × coeficiente unificado, sin regímenes especiales (art. 6 a 13)? (sí; los especiales quedan afuera)
15. ¿La jurisdicción de cada venta se define por la provincia de la sucursal? (sí; sin provincia, la del negocio)
16. Saldo a favor inicial al empezar a usar el sistema: ¿cuál es por jurisdicción? (se carga en la primera liquidación)
