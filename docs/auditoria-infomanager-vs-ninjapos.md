# Auditoría InfoManager IM5 vs NinjaPOS

Fecha: 2026-10-20 · Fase nueva en el roadmap: **F24** Paridad InfoManager IM5 (H158 a H174) · Decisión: [ADR-170](./17-decision-log.md)

Fuentes:

- Auditoría funcional completa de **InfoManager IM5** v1.0.507 (187 rutas, 119 manuales embebidos, servidor en sólo lectura), relevada el 20-10-2026 sobre la base de un cliente real (Frigorífico La Jamonera): `ANDESMAR/docs/auditoria-im5/` (documento de otro proyecto, sólo lectura, 8 capítulos, unos 640 KB).
- Código de NinjaPOS en `main` (`30ca1316`): migraciones, Edge Functions, `app/`, `components/`, `lib/`, `modules/`, este roadmap y los docs de dominio.

Cada capítulo de IM5 se cruzó capacidad por capacidad contra el roadmap **y** el código (con grep, sin dar por hecho lo que dice el roadmap). Las matrices completas, con la evidencia de cada fila, están en [`auditoria-im5/`](./auditoria-im5/).

---

## 1. Resumen ejecutivo

1. **NinjaPOS ya cubre lo central de IM5.** De 614 capacidades relevadas, 232 están hechas y 142 parciales. El POS, la caja con Z, las listas de precios, la cuenta corriente, compras, tesorería, contabilidad, ARCA, Mercado Libre, reparto y la API pública existen y en varios puntos son mejores (ver §3).
2. **Faltan 135 capacidades y 49 están en el roadmap sin hacer.** Se agrupan en 17 hitos nuevos (F24, H158 a H174) en lugar de desparramarlas por fases viejas; cada hito dice qué hito existente enriquece.
3. **Dos huecos de seguridad e integridad (P0):** el asistente de IA no respeta los permisos de costos ni de sucursal (`ai_assistant` corre las RPC `ai_*` con service_role), y una factura de proveedor con pagos imputados se puede editar o anular. Van primero (H158).
4. **Una corrección del roadmap:** H109 "asientos automáticos por venta" figuraba hecho, pero el asiento usa `products.tax_rate` en vez de `sale_tax_lines`, así que las percepciones y los internos no van a su cuenta. Pasa a parcial y el arreglo entra en H158.
5. **Lo que más pesa para un comercio como La Jamonera** (fiambrería y carnicería mayorista): envío de precios a balanzas Kretz y Systel (H164), despiece y producción (H165), cobro contra entrega en el reparto (H171), arqueo por billetes y rendición con tesorero (H159), compras importadas desde ARCA y leídas con IA (H167) y el costo guardado en cada venta para que los márgenes sean confiables (H161).
6. **Lo que no se replica (56):** la contabilidad paralela CC1 / CC2, la impresora fiscal y los cierres X/Z fiscales, los talonarios manuales, las herencias de IM4 (topes de renglones, numeraciones, caracteres especiales, recálculo de acumulados) y los circuitos propios de La Jamonera (intermediarios, Ultu).

## 2. Conteo por capítulo

| Capítulo IM5 | Hecho | Parcial | En roadmap | Falta | No aplica |
|---|---|---|---|---|---|
| [00 POS y caja](./auditoria-im5/00-pos-y-caja.md) | 43 | 16 | 6 | 14 | 4 |
| [01 Artículos y stock](./auditoria-im5/01-articulos-y-stock.md) | 31 | 11 | 6 | 14 | 5 |
| [02 Ventas, comprobantes](./auditoria-im5/02-ventas-comprobantes.md) | 34 | 12 | 7 | 21 | 8 |
| [03 Logística y ecommerce](./auditoria-im5/03-logistica-y-ecommerce.md) | 33 | 9 | 11 | 9 | 6 |
| [04 Clientes, proveedores y compras](./auditoria-im5/04-clientes-proveedores-compras.md) | 30 | 18 | 3 | 24 | 4 |
| [05 Consultas, gerencia e IA](./auditoria-im5/05-consultas-gerencia-ia.md) | 15 | 33 | 5 | 30 | 8 |
| [06 Contabilidad e impuestos](./auditoria-im5/06-contabilidad-e-impuestos.md) | 27 | 21 | 3 | 8 | 9 |
| [07 Configuración y maestros](./auditoria-im5/07-configuracion-y-maestros.md) | 19 | 22 | 8 | 15 | 12 |
| **Total** | **232** | **142** | **49** | **135** | **56** |

## 3. Donde NinjaPOS ya es mejor (mantener)

- **Cuenta corriente:** los intereses por mora se calculan y cobran solos (`account_interest_calc`); IM5 sólo los informa.
- **Contabilidad:** no puede haber asientos desbalanceados (trigger y `acc_issues`); IM5 tiene un umbral para "despreciar" diferencias.
- **Conciliación de tarjetas y procesadores:** empareja sola (ADR-061, ADR-162); en IM5 es manual.
- **Impuestos personalizables con vigencia** (ADR-105) en lugar de un lenguaje de fórmulas libre difícil de auditar.
- **Punto de venta por caja** (H98), no por usuario: mejor para un SaaS con cajeros rotativos.
- **API pública:** el dueño genera y rota sus credenciales, con sandbox y portal (ADR-094, ADR-163, ADR-168); en IM5 depende del proveedor.
- **Expedición y reparto** con escaneo, entrega parcial, roturas y seguimiento en vivo (ADR-164, ADR-165), más completo que la hoja de ruta de IM5.

## 4. De la auditoría a los hitos de F24

| Hito | Qué cubre | Prioridad máxima | Enriquece |
|---|---|---|---|
| H158 | Integridad y seguridad: IA con permisos, factura pagada bloqueada, asiento de venta con impuestos, letra de compra en el servidor, producto no bonificable, cheque repetido | P0 | H88, H101, H109 |
| H159 | Caja PRO: arqueo por billetes y medio, apertura con fondo anterior, borrar renglón auditado, topes de descuento, ticket de cambio, cierre en dos pasos, valores en tránsito | P1 | H111, H119, H22 |
| H160 | Cobros ampliados: recibo con varios medios, cheques y e-cheqs, retenciones en el recibo, efectivo en USD, reglas de medios | P1 | H14, H31, H106 |
| H161 | Costo en la venta y reportes de gestión: cobranzas, kardex, mercadería parada, rentabilidad, pendientes a fecha, búsqueda sin acentos | P1 | TX-5, H67, H97 |
| H162 | Motor de alertas programadas con destinos | P1 | H63, H67, H117 |
| H163 | Catálogo PRO: varios códigos de barras, duplicar, unidad de venta con coeficiente, artículo de compra o venta | P1 | H100, H112 |
| H164 | Balanzas etiquetadoras: envío de precios, prefijos PRO, etiqueta de peso | P1 | H23, H24 |
| H165 | Producción y despiece | P2 | H50, backlog |
| H166 | Inventario y reposición: conteo multiusuario, pedido interno, costo en el movimiento, verificador de precios | P2 | H64, H95 |
| H167 | Compras PRO: Mis Comprobantes Recibidos, lectura con IA, factura que recibe stock, imputación de NC y anticipos, autorización de OC | P1 | H101, H104, H106, H108 |
| H168 | Comprobantes B2B: NC financiera, remito primero, factura resumen, abonos, venta bajo pedido | P1 | H32, H41, H107 |
| H169 | Vendedores y cartera, comisión sobre lo cobrado, "ver sólo lo propio" | P2 | H39, ADR-138 |
| H170 | Ecommerce multicanal: sólo lectura al conectar, conectores genéricos, Tienda Nube, WooCommerce | P1 | H84, H87, F5 |
| H171 | Reparto: cobro contra entrega y rendición | P1 | H145, H146, H149 |
| H172 | Contabilidad e impuestos: Ver asiento en todo, posición de IVA, diferencia de cambio, exportadores | P1 | H108, H109, H110, H155 |
| H173 | Consultas dinámicas e IA con tableros guardados | P2 | TX-5, H88 |
| H174 | Configuración, importaciones y maestros: proveedores por XLSX, columnas a elección, empezar de cero, unificar duplicados | P1 | H34, H62, H117 |

## 5. Correcciones al roadmap existente

- **H109** "Asientos automáticos por venta…" pasa de `[x]` a `[~]`: falta leer `sale_tax_lines` (H158).
- **H31b**: los ítems "Cuenta corriente contable" y "Comprobantes" quedaron hechos con ADR-169 y se marcan `[x]`.

## 6. Lo que quedó sin poder determinar en IM5

La auditoría de IM5 no pudo ver la lógica de servidor (asientos exactos por comprobante, sintaxis de fórmulas, formato de los TXT de los aplicativos, recursos de su API). Donde eso importa (exportadores de H172), NinjaPOS sigue las especificaciones de ARCA y de cada provincia, no la implementación de IM5.
