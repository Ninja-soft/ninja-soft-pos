-- =============================================================================
-- 20261104100000_features_importaciones_xlsx  (TX-4 · H34, ADR-078)
--
-- La feature `importacion_excel` (OPTIONAL, grupo catalogo, desde Pro) ya
-- existía pero sólo la gateaba la UI (GatedButton en /productos y /clientes;
-- el insert iba directo a las tablas). Con TX-4 pasa a tener gating real y
-- cubre todas las importaciones:
--
--   Qué habilita: importar desde Excel (XLSX) productos, clientes, stock por
--   sucursal, listas de precios, sucursales, planes de garantía y motivos de
--   devolución con plantilla, revisión previa en el servidor (dry-run),
--   confirmación, archivo de errores por fila y auditoría.
--   Gating real (migración siguiente): cada RPC import_* exige
--   tenant_has_feature_for(tenant, 'importacion_excel') además de la feature
--   propia de la entidad (listas_precios, garantias, devoluciones, stock,
--   multi_sucursal, stock_sucursales según corresponda).
--   Matriz por plan: sin cambios (Start no, Pro / Business / Enterprise sí).
--   Exportar la base completa sigue con `export_xlsx` (lectura de datos que el
--   rol ya puede leer por RLS).
-- =============================================================================

update features
   set label = 'Importación Excel',
       description = 'Importar desde Excel productos, clientes, stock por sucursal, listas de precios, sucursales, garantías y motivos de devolución, con plantilla, revisión previa, confirmación y errores por fila'
 where key = 'importacion_excel';
