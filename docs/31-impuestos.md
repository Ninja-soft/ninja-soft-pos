# Impuestos: IVA, internos, condición fiscal, percepciones, retenciones y padrones

Decisión: [ADR-068](./17-decision-log.md) · Hitos: F18 · H103 a H106 ([roadmap](./02-roadmap.md)) · Auditoría: [`auditoria-fiscal-contable-precios.md`](./auditoria-fiscal-contable-precios.md)

> **Aviso normativo.** Alícuotas, topes, mínimos, códigos de ARCA y diseños de padrón son **orientativos**. Se modelan como datos (catálogos, `tax_parameters`, regímenes cargados por el negocio), nunca como constantes del código, y hay que validarlos con el contador del negocio y la norma vigente.

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
| Retenciones sugeridas en la orden de pago | Compras > Orden de pago | `percepciones_retenciones` |

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

Líneas con CUIT inválido, fechas al revés o alícuota ilegible se informan (las primeras 50) y no se cargan. Al cerrar el import se reemplazan los del mismo período y jurisdicción; los de otros meses quedan para ventas con fecha vieja. Fixtures en `tests/fixtures/padron/`.

## 5. Datos

- `tax_iva_rates`, `tax_jurisdictions`, `tax_parameters` (globales, sólo lectura).
- `products.tax_rate_code` (`tax_rate` espejo), `is_service`, `internal_tax_*`; `product_variants.tax_rate_code`; `price_lists.prices_include_tax`; `customers.iibb_jurisdiction` y condición ampliada.
- `tax_settings` (negocio), `tax_regimes`, `tax_exemptions`, `tax_padron_imports`, `tax_padron_entries`.
- Venta: `sales.cbte_letter`, `fiscal_snapshot`, `net_taxed`, `net_exempt`, `net_untaxed`, `iva_total`, `internal_tax_total`, `perception_total` (`tax_total` = IVA + internos + percepciones); `sale_items.tax_rate_code`, `iva_rate`, `taxed_total`, `net_amount`, `iva_amount`, `internal_tax_amount`; `sale_tax_lines` (AlicIva, internos y percepciones con id de ARCA).
- Vista `tax_suffered`: percepciones y tributos sufridos en comprobantes de compra.

RPC: `tax_settings_get`, `tax_settings_save`, `sale_tax_preview`, `tax_padron_import_start | _rows | _finish | _delete`, `tax_padron_lookup`, `tax_retention_suggest`, `report_iva_ventas`, `cbte_letter_infer`, `tax_param`.

## 6. Deploy

Migraciones `20261028100000` a `20261028100300` en orden, **antes del front** (el front escribe columnas nuevas). Sin Edges ni crons. Recrean `_resolve_unit_price`, `price_context_snapshot` y `create_sale`.

## 7. Pendiente

Notas de crédito con reversa proporcional de impuestos (con F3), alícuota por operación según receptor, internos por sucursal y con vigencia, Convenio Multilateral con coeficientes, constancia de ARCA por CUIT, descarga programada de padrones, Ganancias (RG 830) y SUSS, certificados de retención, SICORE, SIRE, Libro IVA Digital y DDJJ de IIBB (H108).
