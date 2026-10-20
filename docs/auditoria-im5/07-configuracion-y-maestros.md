# IM5 cap. 07 (Configuración y Tablas maestras) vs NinjaSoft POS

Fuente: `ANDESMAR/docs/auditoria-im5/07-configuracion-y-maestros.md`. Comparado contra `pos-deploy` (main, 30ca1316). Verificado con grep en `supabase/migrations`, `supabase/functions`, `lib`, `components`, `app` y `docs/02-roadmap.md`.

Estados: HECHO, PARCIAL, ROADMAP (pendiente en 02-roadmap), FALTA, NO APLICA. Prioridad: P0 a P3. Tamaño: S, M, L, XL.

## 1. Configuraciones Generales

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Todos los parámetros en una pantalla con buscador global | HECHO | `components/settings/SettingsNav.tsx` ("Buscar ajuste"), `sections.ts` | El buscador no busca en el texto de ayuda ni admite deep link `?buscar=` (P3 S) |
| Herencia de configuración por alcance | HECHO (mejor que IM5) | H92, ADR-049: negocio, grupo, sucursal y caja con "Heredado / Personalizado" | IM5 no lo tiene |
| Grabar solo lo tocado, contador de cambios pendientes, aviso al salir | PARCIAL | Guardado por tarjeta (`OperationSettingsCard`, etc.) | Falta indicador global de cambios sin grabar por sección y confirmación al salir (P3 S) |
| Opciones que activan circuitos enteros: diálogo "leer manual / activar igual", irreversibles protegidas | FALTA | Toggles de `pos_settings` sin diálogo; Escuela F15 tiene contenido | Diálogo de impacto + link a la lección de Escuela para toggles que cambian circuitos (multi-sucursal, cuenta corriente, mesas, CAEA) (P3 S) |
| Diagnóstico "por qué no lo veo" (circuito, permiso, preferencia) | FALTA | Gating por plan (`tenant_has_feature`), capacidades (ADR-138), menú por usuario (ADR-134) existen por separado | Herramienta que, para una pantalla y un usuario, diga si la bloquea plan, toggle, permiso o preferencia (P2 M) |
| Recalcular acumulados | NO APLICA | Saldos calculados en línea | Arquitectura sin acumuladores nocturnos |
| Multiproveedor con foto de stock por proveedor | NO APLICA | `supplier_products` (varios proveedores por producto) | Stock por proveedor es nicho de consignación |

## 2. Alertas

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Motor de alertas programadas (catálogo de ~19 tipos, frecuencia, días, horario, nivel) | PARCIAL | Alertas sueltas: margen (`20261109200200_alertas_margen`), monitor de sucursales (`lib/branches/monitorAlerts.ts`), cockpit (`lib/commerce/cockpit.ts`), recordatorios de deuda (cron `account-reminders`), estado de certificado ARCA solo en UI (`lib/arca/certUpload.ts`). No hay tabla de reglas ni cron genérico | Motor unificado `alert_rules` + cron con catálogo: stock bajo mínimo, stock negativo, venta bajo costo, caída de ventas, deuda vencida, cheques por vencer, facturas de compra por vencer, caja sin cerrar, comprobantes sin CAE, mercadería inmovilizada, ajustes grandes, descuentos anómalos, presupuestos por vencer, clientes que dejaron de comprar, aumento de costo, certificado ARCA por vencer, anulaciones (P1 L) |
| Lógica de "casos nuevos" por clave, no repetir antes de N horas, Probar ahora, Historial | FALTA | n/a | Parte del motor (P1, incluido arriba) |
| Destinos: mail, WhatsApp, campanita por usuario/perfil, resumen diario | ROADMAP | Campana hecha (H13b, `notifications`); roadmap L460 "Preferencias por canal" [ ], L296 "WhatsApp Business para notificaciones" [ ] | Agregar resumen diario por mail y destino por rol (P1 M) |
| Disparo al grabar una venta (bajo costo, sin CAE, descuento) | PARCIAL | Alerta de margen al cambiar costo (ADR-092) | Evaluación post-venta asíncrona (P2 S) |
| Crear alerta con IA (consulta guardada parametrizada) / convertir tablero en alerta | FALTA | `asistente_ia` addon, `_shared/aiQuery.ts` | Alerta IA que guarda la consulta y la reusa sin gastar tokens (P3 M) |
| Alertas de auditoría (PIN fallidos, anulaciones fuera de horario) | ROADMAP | H117 "Pendiente: alertas" [ ] | Cubrir con el motor |

## 3. Editar menú

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Reordenar, ocultar y agrupar menú por usuario, filtrado por permisos | HECHO | ADR-134, `lib/nav/menuLayout.ts`, `components/layout/MenuCustomizer.tsx` | n/a |
| Renombrar opciones y publicar un menú para toda la empresa | FALTA | Layout solo en `users.settings` | Menú de empresa publicado por el dueño + renombres; el usuario personaliza encima (P3 S) |
| Menú del celular con accesos directos | NO APLICA | UI responsive mobile-first | El mismo menú se adapta |

## 4. Usuarios, seguridad y perfiles

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Perfiles con permisos por opción, copiar perfil, perfiles de sistema no borrables | HECHO | ADR-138, `20261204100100_permisos_capacidades` (`permission_roles`, capacidades con riesgo y dependencias), duplicar rol en `modules/permissions/api.ts` | n/a |
| Permisos por usuario (sumar) | HECHO (mejor) | `permission_user_overrides` con `grant` y `revoke` | IM5 no puede quitar a un usuario lo que da el perfil |
| "Ver solo sus comprobantes" (permiso que acota) | PARCIAL | Solo en `offline_sales` y `paused_sales` (policy por `created_by`) | Capacidad `sales.view_own` aplicada por RLS a ventas, presupuestos, pedidos, remitos y compras (P2 S) |
| Permiso Exportar separado por pantalla | PARCIAL | Solo `stock.export` | Capacidad de exportar por módulo (ventas, clientes, reportes), gateada server-side en las RPC de export (P2 S) |
| Tareas con valor asociado (límite de descuento manual por usuario) | PARCIAL | Descuento máximo por rol (`pos_settings`), umbrales de PIN (H116) | Límite por usuario como override del rol (P2 S) |
| Deshabilitar vs borrar, nadie se borra a sí mismo, auditado | HECHO | H113 (`staff_set_status`, baja revoca sesiones), `member_admin` | n/a |
| Usuario con sucursales, depósitos y puntos de venta | HECHO | H91 `staff_branch_assignments` con vigencias | n/a |
| Copiar configuración de otro usuario (sucursales, permisos) | PARCIAL | Copiar rol sí | "Copiar de" usuario para asignaciones y overrides (P3 S) |
| Política de clave (complejidad, vencimiento, gracia, clave débil) | FALTA | Supabase Auth por defecto; `lib/security/pinPolicy.ts` solo para PIN | Política configurable por negocio, MFA opcional para dueño/encargado (P3 M) |
| Acceso restringido por equipo (PCs autorizadas) | FALTA | Cajas recuerdan dispositivo por localStorage (H90); sin padrón de equipos | Depende del puente local (H19g) (P3 M) |
| Vistas (plantillas de columnas por perfil, libre/bloqueado, precedencia) | FALTA | Columnas visibles solo en Depósitos (ADR-136) | Plantillas de grilla por rol (P3 L) |
| Ocultar opciones para todos (super usuario) | NO APLICA | Lo resuelve el gating por plan y capacidades | n/a |

## 5. Auditoría

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Registro automático append-only, filtros por fecha/usuario, export | HECHO (mejor) | H117: `audit_log_search`, `AuditLogViewer.tsx` con XLSX, inmutable, hash encadenado y retención (ADR-083) | n/a |
| Cambios en maestros campo por campo (antes/después) | HECHO | `write_audit_log` en `products`, `customers`, `suppliers`, `stores`, etc.; detalle legible ADR-160 | n/a |
| Pestañas predefinidas: Borrados, Cambios masivos (por tanda), Cambios en maestros; "alta por / último cambio" en la ficha | PARCIAL | Visor único con filtros; importación auditada por lote (`_import_audit`) | Vistas guardadas por tipo y pie "creado por / modificado por" en fichas de producto, cliente y proveedor (P3 S) |
| Origen del cambio (Pantalla / API / Importación) | PARCIAL | API y lotes auditados por separado | Columna de origen uniforme en el visor (P3 S) |

## 6. Puesta en Vivo

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Borrar datos de práctica antes del primer día real, con conteo previo, fecha de corte por circuito, maestros solo si no quedan movimientos | FALTA | Solo `agenda_demo_clear` (ADR-082). H62 "sandbox por tenant" [~] | "Empezar de cero": dueño borra ventas, caja, stock y demás de prueba hasta una fecha, con vista previa de conteos, bloqueado si hubo CAE de producción, auditado (P2 M) |

## 7. Intercambio de códigos

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Reemplazar código de artículo en toda la base | NO APLICA | PK UUID; SKU editable sin romper historia | n/a |
| Unificar fichas duplicadas (no lo hace IM5, pero es el problema real detrás) | FALTA | Sin RPC de merge | Unificar clientes y productos duplicados con vista previa y auditoría (P2 M) |
| Reimputar cuenta contable en movimientos | FALTA | Contabilidad ADR-066 | Nicho contable (P3 M) |

## 8. Importaciones

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Alta y actualización con validación previa, errores por fila, auditoría por tanda | HECHO | ADR-078, `20261104100100_importaciones_xlsx`, `lib/import/engine.ts` | n/a |
| Entidades: artículos, clientes, stock, listas | HECHO | `import_products`, `import_customers`, `import_stock`, `import_price_lists`, `import_warehouse_stock`, etc. | n/a |
| Entidades: proveedores, rubros/categorías, plan de cuentas, asientos | FALTA | No hay `import_suppliers` ni de cuentas | Import de proveedores (P1 S), categorías explícitas (P2 S), plan de cuentas y asientos de apertura (P2 M) |
| Identificar por (código, barras, CUIT, documento) elegible | PARCIAL | Productos por SKU o barras; clientes fijo | Elegir clave de cruce (CUIT, documento, barras, código del proveedor) (P2 S) |
| Pegar desde Excel, mapeo libre de columnas, formatos guardados | FALTA | Plantilla fija con encabezados tolerantes | Mapeo de columnas guardable (sirve para listas de proveedores) (P2 M) |
| Actualización por filtro + "aplicar a todas" | PARCIAL | Editor masivo de precios (`components/prices/QuickPriceEditor.tsx`, ADR-058) | Edición masiva por filtro de otros campos (categoría, IVA, proveedor, stock mínimo) (P2 M) |
| Padrón ARBA/AGIP | PARCIAL | ADR-068 import manual; job periódico [~] (roadmap L1335) | Ya en roadmap |
| Deshacer importación | ROADMAP | H34 L718 "reversión pendiente" [~] | n/a |
| Lote desde/hasta, sanear caracteres | NO APLICA | Dry-run del servidor cubre la prueba | n/a |

## 9. Formatos de impresión

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Diseño de comprobantes con logo, bloques, vista previa con datos | HECHO | `components/invoices/InvoiceStyleCard.tsx` (ADR-112/119), `ticket_templates` | n/a |
| Formato e impresora por tipo de documento y por caja/sucursal | HECHO | H22 `lib/print/profiles.ts`, `lib/print/printers.ts` (impresora asignada + respaldo, herencia por caja) | n/a |
| Diseñador libre por bandas, fórmulas, campos de cliente/artículo/saldo | ROADMAP | F16 L1068 "Diseñador PDF fiscal/no fiscal" [~] | Para pyme alcanza el modelo; agregar campos útiles: saldo de cuenta corriente al pie, bloque forma de pago/cuotas (P2 S) |
| Diseño unificado para remito, presupuesto, recibo, orden de pago, OC | PARCIAL | Diseño solo para facturas y tickets | Extender el mismo estilo a los demás documentos (P2 M) |
| Formato e impresora por usuario; impresión al grabar: preguntar / siempre / nunca por usuario | PARCIAL | Auto/manual por negocio y documento | Override por usuario (P3 S) |

## 10. Complementos (agente local)

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Agente local para térmicas ESC/POS, cajón, balanza, fiscal, con diagnóstico y auto-update | PARCIAL | `tools/bridge`, `lib/print/escpos.ts`, ADR-063, diagnóstico H26 | ROADMAP H19g "Instalador del puente local" [ ] y L560 ESC/POS directo [~]; sumar estado del agente, versión y auto-update en la pantalla de Hardware |
| Identidad de terminal y PCs clonadas | NO APLICA | Caja por dispositivo vía navegador | Sin agente obligatorio |

## 11. API pública e IA

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Credenciales, token, idempotencia, documentación, sandbox | HECHO (mejor) | ADR-094 `api_clients`, `api_idempotency_keys`, `api_rate_windows`; portal y sandbox ADR-159 | El dueño genera y rota solo (IM5 depende del proveedor) |
| Log de pedidos por credencial, webhooks | ROADMAP | H68 L982 [~] y L983 [ ] | n/a |
| Consumo de IA con tope mensual | PARCIAL | `ai_usage`, `ai_config.monthly_quota` (lo fija NinjaSoft) | Pantalla de consumo para el dueño, tope propio y aviso al 80 % (P3 S) |
| Clave propia de Anthropic (BYOK), elegir modelo | NO APLICA | Addon `asistente_ia` gestionado por NinjaSoft | Modelo SaaS cobra el addon |
| Conector MCP con los datos del negocio | FALTA | n/a | P3 M, cruza con API pública |

## 12. Mail

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| SMTP por negocio con envío de prueba | HECHO | `TenantEmailCard.tsx`, `20260607110000_ticket_destinations_tenant_smtp` | n/a |
| Casilla por usuario, OAuth de Google, copia oculta al remitente | FALTA | n/a | P3 S |
| Presupuesto por mail con la casilla del negocio | ROADMAP | L763 [ ] | n/a |

## 13. Tablas maestras

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Países, provincias, localidades con código ARCA y CP | HECHO (mejor) | Georef normalizado, `customer_addresses` (ADR-157, Edge `geo`) | Falta código de jurisdicción IIBB derivado de provincia (cubre H98/H105) |
| Bancos | HECHO | Catálogo de bancos en cuentas de transferencia (ADR-055), `cheques` | n/a |
| Turnos | NO APLICA | Agenda propia (H38) | n/a |
| Roles de contacto de clientes y proveedores | ROADMAP | H31 L681 "contactos" [~] | Contactos múltiples con rol (P3 S) |
| Zonas y rubros de clientes | PARCIAL | `customer_groups` (ADR-058), zonas de envío por localidad | Zona y rubro de cliente para reportes y vendedor (P2 S) |
| Vendedores: comisión % con vigencia, zona, vendedor asignado al cliente | PARCIAL | `commission_pct` en producto y profesional (`20260608550000_commissions_tips`), vendedor solo en `sale_orders`; `sales` no tiene vendedor | Vendedor en la venta de mostrador, vendedor del cliente, comisión con historial por fecha (P2 M) |
| Transportes (maestro con CUIT, patentes, chofer) | PARCIAL | Texto libre en remito (`carrier_name`, `carrier_cuit`, `vehicle_plate`), `vehicles` de logística | Maestro de transportistas reutilizable en remitos y COT (P2 S) |
| Unidades de medida con equivalencias y unidad de venta vs compra | PARCIAL | `products.unit`, `units_per_purchase` | ROADMAP L1298 "unidad de venta por bulto o caja" [~] |
| Actividad económica ARCA | HECHO | `iibb_activities` | n/a |
| Tipos de operación ARCA para aplicativos | NO APLICA | Libros generados por el motor fiscal F18 | n/a |
| Caracteres especiales, Identificadores | NO APLICA | n/a | Utilidades de IM4 |
| Unidades de negocio con fecha de vigencia | PARCIAL | Centros de costo (ADR-066) | Vigencia "hasta" que deja de ofrecerla (P3 S) |
| Empresas: varias razones sociales | ROADMAP | H98 L1206 [ ] | n/a |
| Empresa como agente de retención (Ganancias con mínimo, IIBB) | HECHO | F18 H106 L1348 | n/a |
| Logo y firma de la empresa | PARCIAL | Logo en `tenant_branding` | Firma digitalizada para remitos y presupuestos (P3 S) |
| Cliente predeterminado por empresa | NO APLICA | Venta sin cliente = consumidor final | n/a |

## Conteo

HECHO 19 · PARCIAL 22 · ROADMAP 8 · FALTA 15 · NO APLICA 12 (total 76)
