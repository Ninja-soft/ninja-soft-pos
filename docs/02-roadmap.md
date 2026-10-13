# Roadmap — NinjaSoft POS

Plan de ejecución por fases. Cada fase tiene salida verificable, criterios de éxito y demo concreta. Este documento se actualiza al cierre de cada hito.

> **Convención.** Los hitos del MVP (`H0`–`H6`) están detallados en [`01-mvp.md`](./01-mvp.md). Este documento extiende el plan más allá del MVP.

> **Seguimiento.** Todo entregable accionable del roadmap ampliado se escribe como checkbox Markdown: `- [ ]` pendiente, `- [x]` hecho. Al marcar algo como hecho, agregar evidencia breve: PR, commit, ruta, test, deploy o demo que lo valida. No se marca un hito completo si no pasó su corte de control.

## Visión por fases

| Fase | Nombre | Duración estimada | Estado |
|---|---|---|---|
| **F0** | Fundación técnica | 2 semanas | 🟢 Funcional |
| **F1** | MVP vendible (POS + Admin) | 10–12 semanas | 🟢 Funcional (base H0–H6) |
| **F1.5** | Hardening pre-piloto | 2–3 semanas | 🟡 Prioridad inmediata |
| **F2** | Plataforma SaaS (panel interno + suscripciones) | 4–6 semanas | 🟢 Funcional (billing self-serve + dunning + gating) |
| **F3** | Integración AFIP y producción | 4–6 semanas | 🟡 En curso (ARCA WSFEv1, cola fiscal y CAEA en ADR-072, sin certificado real; venta offline ADR-077) |
| **F4** | Escalado: multi-sucursal, hardware, integraciones | 8–10 semanas | 🟡 En curso (multi-sucursal en F17, hardware en F10/ADR-063, pasarelas en F8; falta observabilidad externa) |
| **F5** | Perfiles por rubro y marketplace | 10–14 semanas | 🟡 En progreso (perfiles por rubro hechos, ADR-075; motor de promociones hecho, ADR-074; API pública v1 hecha, ADR-094; marketplace, webhooks y tema por tenant pendientes) |
| **F6** | Personalización del producto (fotos, branding, tickets, catálogo) | 6–8 semanas | 🟢 Funcional (H7–H10b + Tiendita) |
| **F7** | Panel interno PRO + comunicaciones (emails) | 5–7 semanas | 🟢 Funcional (staff, planes custom, emails Resend, notificaciones) |
| **F8** | Pagos y cobros (arquitectura + pasarelas por etapas) | 6–10 semanas | 🟡 En progreso (MP + Mobbex + MODO; gating por plan) |
| **F9** | Motor de promociones PRO | 4–6 semanas | 🟢 Núcleo completo (ADR-074, `feat/promociones-v2`, migraciones `20261102100000` a `20261102100300` sin aplicar): motor con cálculo autoritativo en `create_sale`, combinables, topes, tarjeta/banco, sucursal, lista y combos; falta H55 (segmentos y fidelización) y la aprobación de H56. Devolución parcial con promo prorrateada por línea hecha (ADR-088) |
| **F10** | Hardware y mostrador PRO (impresoras, scanners, doble pantalla) | 5–8 semanas | 🟡 En progreso (impresión por documento H22, scanners H23, doble pantalla H25, diagnóstico H26) |
| **F11** | Configuración retail avanzada (devoluciones, garantías, cuenta corriente, despacho) | 6–8 semanas | 🟡 En curso (falta H32 y parte de H31b) |
| **F12** | Comercios simples y servicios (catálogo chico, agenda, cobro rápido) | 5–7 semanas | 🟡 En progreso (H35 presets, H36 POS rápido, H37 modificadores, H38 agenda/turnos — core) |
| **F13** | Gastronomía PRO (mesas, comandas, cocina, delivery/takeaway) | 7–10 semanas | 🟡 En progreso (H43 modo gastronómico, H44 mesas/pedidos, H45 ruteo + comanda impresa por estación, H46 KDS, H47 cursos/despacho por tiempos, H49 delivery/takeaway, H51 reservas, lista de espera y rotación; mover/unir mesas, anulaciones con motivo y SLA del KDS por estación, ADR-081; ronda 2 ADR-097: ticket separado por comensal y partes iguales, KDS por curso con "marchar", prioridad urgente, anulación de delivery con motivo y aviso automático a la lista de espera) |
| **F14** | Motor comercial enterprise (planes, cuotas, recargos, reglas, inventario PRO) | 8–12 semanas | 🟡 En curso (primer corte ADR-092 en `feat/f14-comercial`: aprobaciones comerciales, alertas de margen, conteo cíclico y garantías por serie; parciales por otras fases: herencia de configuración ADR-049, compras ADR-050 y ADR-059, venta offline ADR-077) |
| **F15** | Escuela NinjaSoft + onboarding guiado configurable | 5–7 semanas | 🟡 En curso: ayuda contextual, Escuela mínima y checklist por rubro (H72, H69, H71 parcial, ADR-086) |
| **F16** | Comercio unificado tipo Napse/TOTVS (Omni, VTOL, Fiscal Flow, Promo) | 10–14 semanas | 🟡 En curso (primer corte ADR-091: cockpit, reservas con retiro en tienda, riesgo operativo y runbooks; parciales previos por otras fases: monitor de sucursales ADR-057 y ADR-080, ARCA ADR-072, simulador de promociones ADR-074) |
| **F17** | Multi-sucursal real (sucursal como contexto, configuración heredable, terminales, stock, clientes y reportes por sucursal) | 10–14 semanas | 🟡 En curso: H89, H90 y H91 (ADR-043, ADR-045); stock por sucursal y traslados (H94 parcial, H95, ADR-046); configuración heredable, terminales e impresoras (H92, H93, ADR-049); credenciales y planes por sucursal, plantilla de sucursal, clientes por sucursal, comparativo y monitor de sucursales (ADR-057); cobros y traslados por sucursal, Z por sucursal y caja, heartbeat de cajas, tránsito y contexto cruzado (ADR-080) |
| **F18** | Fiscal, contable, precios y compras (listas PRO, compras e importaciones, IVA, internos, percepciones, retenciones, padrones, libros, asientos, conciliaciones) | 16–24 semanas | 🟡 En curso (auditoría fiscal 2026-10-12, ADR-043; compras v1 ADR-050; compras v2 y tesorería ADR-059; contabilidad v1 ADR-066; base fiscal ADR-068; Libro IVA ADR-076; retenciones ADR-079) |
| **TX** | Mejoras transversales (UX y datos) — quick wins | continuo | 🟡 En curso (importaciones XLSX ADR-078) |

> **Orden de ejecución acordado (2026-05-30):** **TX (quick wins) → F6 → F7 → F8 → F10 → F11 → F12 → F13 → F9 → F14 → F15 → F16 → F3 (AFIP)**. Las **mejoras transversales (TX)** — calendario unificado con react-day-picker y export XLSX — se hacen primero por ser pedidos explícitos y de bajo costo, y luego se aplican de forma continua. Ver [§ Plan ampliado](#plan-ampliado-2026-05-30), [§ Mejoras transversales](#tx--mejoras-transversales-ux-y-datos) y los cortes de control obligatorios al cierre de cada hito.

> **F17 y F18 (2026-10-12, ADR-043):** dos P0 se hacen ya, independientes del orden: el fix de sucursal en `create_sale` (F17/H90) y la validación del precio en el servidor (F18/H100). Antes de F3 tienen que estar F18/H103 (alícuotas e internos) y H104 (condición fiscal y padrones); F17/H98 y F18/H107 se ejecutan junto con F3. El resto de F17 entra antes de F16.

---

## F0 — Fundación técnica

**Duración:** 2 semanas. **Objetivo:** dejar el proyecto listo para que cualquier agente o persona pueda contribuir sin pedir contexto.

### Entregables
- [x] Repositorio en GitHub con estructura definitiva. — *`Ninja-soft/ninja-soft-pos`, 150+ PRs mergeados.*
- [x] CI/CD: GitHub Actions corriendo lint, typecheck, tests, build (`.github/workflows/ci.yml`).
- [x] Vercel conectado: production en `main` (deploy automático al mergear), previews por rama.
- [~] Supabase: production con migraciones versionadas (`supabase/migrations/`, aplicadas vía MCP) + local con Docker (`pnpm db:start`). *Falta entorno staging.*
- [x] Documentación viva (`docs/`, `CLAUDE.md`, agentes en `.claude/agents/`).
- [x] Sistema de diseño base: tokens (tema `ninja-dark` en Tailwind) y primitives en `components/ui/` (Button, Input, Card, Modal, Toast, Avatar…).
- [x] Auth funcional con Supabase + selección de tenant.

### Criterios de cierre
- [~] Un dev nuevo puede clonar, instalar y levantar el proyecto en < 30 min siguiendo `00-getting-started.md`. *La guía existe; falta validarla con un dev real.*
- [x] El PM puede invocar a cualquier agente y este encuentra su archivo en `.claude/agents/`.
- [~] `pnpm test` pasa con al menos un test por capa (component, hook, edge function). *Componentes (`tests/components/`), dominio y Edge Functions (`tests/unit/arcaWsfe.test.ts` y otros importan `supabase/functions/_shared`); falta un test de hooks de React.*

---

## F1 — MVP vendible

**Duración:** 10–12 semanas. **Objetivo:** un cliente piloto puede vender, controlar stock y cerrar caja durante 30 días sin tocar base de datos manualmente.

Esta fase coincide con los hitos `H1`–`H6` del MVP. Ver [`01-mvp.md`](./01-mvp.md) para el detalle.

### Módulos incluidos
1. Autenticación y selección de tenant.
2. Productos, precios, stock y categorías.
3. POS rápido con búsqueda, carrito, descuentos, pagos.
4. Caja: apertura, movimientos, arqueo, cierre por turno.
5. Clientes (alta básica, búsqueda).
6. Usuarios y roles (owner, manager, cashier, viewer).
7. Reportes diarios y dashboard del cliente.
8. Suscripciones (visualización del plan, no facturación real).

### Demo de cierre
Una sesión de venta completa: apertura de caja → 20 ventas con productos reales → un descuento manual → una anulación → cierre de caja con arqueo → reporte del día descargado en PDF.

---

## F1.5 — Hardening pre-piloto

**Duración:** 2–3 semanas. **Objetivo:** convertir el MVP funcional en un piloto confiable, medible y recuperable.

### Entregables
- [x] `pnpm build` estable y reproducible en local/CI. — *CI corre lint/typecheck/test/build en cada PR.*
- [x] Scripts documentados y alineados con `package.json`. — *`db:start`, `db:reset`, `test:rls` agregados; coinciden con los comandos de bolsillo de CLAUDE.md.*
- [x] Suite de aislamiento multi-tenant con dos tenants y datos cruzados conocidos. — *`tests/integration/rls.test.ts`: crea tenant A/B + owner/cashier, productos y clientes cruzados; corre contra Supabase local (job `rls` de CI con `supabase start` + migraciones reales). Sin las env de test, la suite se salta.*
- [x] Tests de RLS para tablas críticas: productos, ventas, caja, clientes, audit logs. — *Lectura y escritura cross-tenant bloqueadas; además `payment_secrets` (deny-all) y `tenant_notes` (solo staff).*
- [x] Tests de permisos por rol: owner, manager, cashier, viewer. *Hecho: `tests/integration/roles.test.ts` cubre owner, manager, cashier y viewer (ADR-071).*
- [~] Smoke E2E mínimo: login → abrir caja → vender → ticket → anular → cerrar caja → reporte. *`tests/e2e/pos.spec.ts` cubre login, abrir caja y vender; faltan ticket, anulación, cierre de caja y reporte en un mismo flujo.*
- [~] Idempotencia documentada para venta/anulación antes de integrar pagos externos. *Venta offline documentada (`client_sale_id` único, `docs/34-venta-offline.md`, ADR-077) y cobro en espera idempotente (`_pc_complete`, ADR-048); falta documentar la venta online del POS y la anulación.*
- [~] Health endpoint básico (`/api/health`) y checklist de monitoreo manual. *Endpoint listo (`GET /api/health` → status/version/env/time, sin DB ni secretos). Falta el checklist de monitoreo.*
- [x] **Gating server-side real + hardening de seguridad SaaS** *(2026-06-08)*: enforcement backend de **medios de pago por plan** (trigger en `payments`, PRs #215/#240) y de **features de escritura** (descuentos/garantías/cuenta corriente/listas en `create_sale`/escrituras, con advisory lock en el correlativo, PR #250); hardening (policy de planes cerrada a `anon`, guards en RPCs, revokes defensivos, índices/policies de performance, PR #248); **auditoría SaaS exhaustiva** (seguridad/RLS/pagos/funcional/IA/emails) — base sólida, sin fugas, fixes aplicados. *La UI nunca es la única barrera (ver convención de features de plan en `CLAUDE.md`).*
- [ ] Backup/restore de Supabase probado en staging o entorno descartable.
- [ ] Seed/demo reproducible para ventas, productos, clientes y caja.

### Criterios de cierre
- [x] El gate automático pasa completo: lint, typecheck, test y build. — *Job `quality` de CI.*
- [x] Dos tenants operan en paralelo sin fuga de datos validada por test. — *Job `rls` de CI.*
- [ ] Una demo de piloto corre de punta a punta sin tocar SQL manualmente.

---

## F2 — Plataforma SaaS

**Duración:** 4–6 semanas. **Objetivo:** NinjaSoft puede operar el SaaS sin tocar SQL: alta de clientes, cambios de plan, activación de features.

### Entregables
- [x] **Panel interno** (rutas protegidas para staff NinjaSoft): — *Base hecha: `/internal/tenants` + detalle, `/internal/staff`, `/internal/pagos`, `/internal/emails`. Guard `is_internal`.* *Completo: alta y baja manual de negocios (ADR-073), miembros y ficha 360 (ADR-084).*
  - [x] Listado de tenants con filtros (estado, plan, última actividad). — *Búsqueda (nombre/slug/dueño), filtros por estado de suscripción y plan, y columna "Últ. actividad" (último login o última venta, vía `internal_tenant_health()`).*
  - [x] Alta y baja de tenants. *Hecho: "Nuevo negocio" con Edge `internal_create_tenant` y baja lógica con motivo por `internal_tenant_lifecycle` (ADR-073).*
  - [x] Cambio de plan en caliente. — *Detalle del tenant: select de plan → RPC `internal_set_plan`.*
  - [x] Activación / desactivación de feature flags por tenant. — *Toggles en el detalle del tenant → RPC `internal_set_flag`.*
  - [x] Vista de auditoría administrativa. — *`/internal/audit`: últimos 200 registros de `audit_logs` con filtros (negocio, entidad, acción, rango de fechas) y detalle expandible (motivo + before/after JSON). Solo lectura, guard `is_internal` por RLS.*
- [x] **Modelo de suscripciones** completo:
  - [x] Estados: `trial`, `active`, `past_due`, `suspended`, `cancelled` (migración `saas_catalog`).
  - [x] Trial automático de 14 días al alta (Edge Function `create_tenant` setea `trial_ends_at`).
  - [x] Suspensión por falta de pago (manual + **automática**). — *Staff cambia el estado a `suspended` desde el detalle (RPC `internal_set_subscription_status`); además **motor de dunning de 3 días** que pasa a `suspended` y **reactiva reanclando el período** al vencimiento anterior (migración `dunning_3day_grace_reanchor`, PR #237). El cliente suspendido ve un bloqueo de cuenta (`SuspendedGate`, PR #236).*
- [x] **Sistema de soporte interno:** *Hecho: notas internas y salud con errores (ADR-084).*
  - [x] Notas internas por tenant. — *Tabla `tenant_notes` (RLS solo `is_internal`, baja lógica) + card "Notas internas" en el detalle del tenant: agregar, listar con autor y fecha relativa, eliminar. Invisibles para los usuarios del tenant.*
  - [x] Vista rápida de salud operativa (último login, ventas últimos 7 días, errores). *KPIs en el detalle del tenant: último login, última venta, ventas 7 días (cantidad + total) y usuarios activos — RPC `internal_tenant_health()` (SECURITY DEFINER, guard `is_internal`, devuelve solo agregados).* *Errores: la ficha 360 (`internal_tenant_360`) muestra los últimos de webhooks, comprobantes fiscales y emails, con puntaje de salud en `lib/internal/tenantHealth.ts` (ADR-084).*

### Criterios de cierre
- [x] NinjaSoft puede dar de alta un cliente nuevo en < 5 minutos sin tocar SQL. *Hecho: botón "Nuevo negocio" en `/internal/tenants` (Edge `internal_create_tenant`, ADR-073).*
- [x] Cambiar un cliente de Start a Pro toma una sola acción y aplica de inmediato.
- [x] Toda acción administrativa queda en `audit_logs`. *Hecho: todas las RPC `internal_*` de escritura y las Edges de staff (`staff_admin`, `set_platform_secret`, `internal_tenant_members`, `internal_impersonate`) escriben `audit_logs` (ADR-073, ADR-084).*

---

## F3 — Integración AFIP y producción

**Duración:** 4–6 semanas. **Objetivo:** el cliente piloto puede facturar electrónicamente con CAE válido.

> **2026-10-13 (ADR-072):** implementado en `feat/arca-wsfe` sin certificado real: migraciones `20261101100000` a `20261101100200` y Edge `arca_wsfe` sin aplicar ni desplegar; probado con fixtures SOAP, FEDummy real de homologación y el certificado de homologación firmando localmente. Doc: [`33-facturacion-arca.md`](./33-facturacion-arca.md). Quedan abiertos los criterios que piden emitir de verdad.

### Entregables
- [x] Edge Function (`arca_wsfe`, el nombre de diseño era `submit_invoice_afip`) con manejo completo de: *(ADR-072, `feat/arca-wsfe`)*
  - [x] Solicitud de CAE para Factura A, B, C, Nota de Crédito. *(tipo por letra del motor de impuestos; NC por devolución y por anulación; M mapeada; E queda para WSFEX)*
  - [x] Reintentos con backoff exponencial. *(1 a 60 minutos, dead-letter a los 10 intentos)*
  - [x] Almacenamiento de XML de request/response. *(sin Token ni Sign, por comprobante y por intento)*
  - [x] Cola fiscal robusta: pendientes, reintentos, bloqueados, rechazados, dead-letter y reproceso manual.
  - [x] Idempotencia fiscal por venta/tipo de comprobante/punto de venta. *(más recuperación con FECompConsultar ante un resultado incierto)*
  - [x] Conciliación contra AFIP (`FECompUltimoAutorizado`) para detectar drift de numeración.
- [~] **Prerrequisitos fiscales (2026-10-12, ADR-043):** alícuotas IVA con exento y no gravado e impuestos internos (F18/H103), condición fiscal del receptor y padrones (F18/H104), punto de venta por sucursal (F17/H98). Comprobantes completos (tributos, M, FCE MiPyME, E, Transparencia Fiscal) en F18/H107. *Base fiscal hecha (ADR-068: alícuotas con exento y no gravado, internos, condición fiscal y padrones) y punto de venta por sucursal `stores.afip_pos_number` (ADR-072); faltan razón social y CUIT por sucursal (H98) y comprobantes completos (H107).*
- [x] Gestión de certificados AFIP por tenant (almacenados encriptados). *(clave y CSR generados en la Edge, AES-256-GCM con `ARCA_KEY_ENC`; el front sólo ve metadata; delegación en NinjaSoft modelada y apagada hasta tener CUIT)*
- [x] Panel de monitoreo de facturación electrónica:
  - [x] Comprobantes pendientes.
  - [x] Errores recientes con código AFIP.
  - [x] Última conexión al webservice AFIP.
- [x] Modo **homologación** vs **producción** por tenant, con certificados separados, checklist de habilitación y bloqueo de cambio si faltan pruebas. *(asistente paso a paso; producción sólo el dueño con checklist completo)*
- [~] **Venta offline / AFIP offline:** *(base conservadora en `feat/venta-offline`, ADR-077, [`34-venta-offline.md`](./34-venta-offline.md); migración `20261103200000_venta_offline` sin aplicar. Lo completo sigue en F14 · H65.)*
  - [x] La venta no se bloquea si no hay internet: con el POS abierto y la caja abierta sigue cobrando en efectivo, transferencia manual y tarjeta en posnet con cupón (nunca QR, link ni terminal integrada), con límites del dueño (monto, ventas por turno, plazo). *Si ARCA no responde, lo cubre la cola fiscal con CAEA (rama ARCA).*
  - [x] ARCA caído no bloquea la venta. *(ARCA caído: cola y contingencia CAEA; sin internet en el POS depende de la venta offline del POS)*
  - [x] Se emite ticket provisorio (`OFF-XXXXXXXX`, no válido como factura) y la venta queda en una cola local (IndexedDB) con `client_sale_id` idempotente, asociada a usuario y turno.
  - [x] Se emite comprobante interno/provisorio y la factura queda en cola fiscal. *(ticket "Comprobante pendiente de autorización ARCA")*
  - [~] Al reconectar, el POS sincroniza solo (`sync_offline_sale`, wrapper de `create_sale`, idempotente): precio cambiado se respeta y se audita, stock negativo se permite y se marca, lo inválido queda en **Ventas offline** para el dueño. *La venta sincronizada entra a la cola fiscal por el trigger `arca_sales_enqueue` (ADR-072). Falta usar `sales.offline_sold_at` como fecha del comprobante y reimprimir el ticket con CAE.*
  - [~] Al reconectar, el sistema sincroniza ventas pendientes, pide CAE y actualiza el comprobante. *Sincronización (`sync_offline_sale`, ADR-077) y CAE por la cola fiscal (`arca_sales_enqueue`, ADR-072) integrados; falta la fecha real del comprobante (`offline_sold_at`) y actualizar el ticket ya impreso.*
  - [x] El POS muestra estado fiscal claro: `pendiente`, `enviando`, `aprobado`, `rechazado`, `requiere acción`. *(detalle de la venta, ticket e indicador de contingencia)*
- [x] Numeración de comprobantes por punto de venta. *(caja o sucursal; serie CAEA propia)*
- [x] **Contingencia CAEA** (pedido del dueño): CAEA por quincena, emisión al instante si ARCA falla de forma cierta, informe posterior y sin movimiento. *(ADR-072, `feat/arca-wsfe`)*

### Criterios de cierre
- [ ] 100 comprobantes consecutivos en homologación sin error de integración.
- [~] Recuperación automática si AFIP devuelve error transitorio. *Código: reintentos con backoff, clasificación de errores y dead-letter (ADR-072, `tests/unit/arcaWorker.test.ts`); falta validarlo contra ARCA con certificado real.*
- [~] El cashier nunca ve un error de AFIP que lo bloquee — la venta se completa, la factura se reintenta en segundo plano. *Código: la factura se encola por trigger después de la venta (`arca_sales_enqueue`, ADR-072) y nunca la bloquea; falta validarlo en producción.*
- [~] Una venta offline queda registrada localmente, se sincroniza al volver la conexión y termina con CAE o error fiscal accionable. *(Registro local y sincronización hechos, ADR-077; la venta sincronizada se encola en ARCA, ADR-072. Falta la fecha real del comprobante.)*
- [x] El cambio de homologación a producción solo se habilita después de certificados válidos, numeración verificada y prueba exitosa. *Hecho: `_arca_checklist` (datos fiscales, certificado, homologación aprobada, prueba de conexión en producción, puntos de venta) y `arca_set_environment` rechaza con `checklist_incomplete` (ADR-072).*

---

## F4 — Escalado

**Duración:** 8–10 semanas. **Objetivo:** soportar clientes con múltiples sucursales y cajas, integraciones con hardware y pasarelas de pago.

> **Actualización 2026-10-12 (ADR-043):** el bloque multi-sucursal y multi-caja de F4 se detalla y se ejecuta en **[F17](#f17--multi-sucursal-real)** (H89 a H99), a partir de la auditoría [`auditoria-napse-vs-ninjapos.md`](./auditoria-napse-vs-ninjapos.md). Los ítems de abajo quedan como resumen y apuntan al hito que los cubre.

### Entregables
- [~] **Multi-sucursal:** *(ver F17)* *Ver detalle en F17.*
  - [x] Stock por sucursal con transferencias. *(F17/H94 y H95)* *Hecho: ADR-046 y ADR-080.*
  - [x] Reportes consolidados. *(F17/H97)* *Hecho: vista consolidada y comparativo con XLSX por sucursal (ADR-057).*
  - [x] Permisos por sucursal. *(F17/H91)* *Hecho: personal por sucursal y RLS de lectura (ADR-045, `tests/integration/rls-sucursales.test.ts`).*
- [~] **Multi-caja por sucursal:** *(ver F17)* *Ver detalle en F17.*
  - [~] Asignación de cajero a caja específica. *(F17/H90 y H91)* *El cajero opera sólo en sus sucursales y la caja es de quien abre el turno (ADR-045, ADR-051); falta asignar un cajero a una caja fija.*
  - [~] Reportes por caja. *(F17/H97)* *Cierres Z por caja con filtro por caja (ADR-080); falta el filtro por caja en el resto de los reportes.*
- [~] **Integraciones de hardware:** *Ver F10 (H22 a H26) y ADR-063.*
  - [~] Impresoras térmicas (ESC/POS via plugin de impresión web). *Impresión a térmicas 58/80 mm por web print (`lib/print/webPrint.ts`, H22); falta ESC/POS directo por conector local.*
  - [x] Cajón de dinero. *Hecho: pulso ESC/POS por Web Serial, WebUSB o puente local, apertura auditada con `cash_drawer_open` (ADR-063, `lib/hardware/drawer.ts`).*
  - [x] Lectores de código de barras (USB HID, sin driver). *Hecho: `useScanner` (H23).*
  - [x] Balanzas (opcional, vía puerto serie). *Hecho: lectura por Web Serial o puente local y etiquetas de balanza (ADR-063, `lib/hardware/scale/`); presets de marca sin validar con equipos.*
- [x] **Pasarelas de pago:** *Ver F8.*
  - [x] Mercado Pago Point (QR + tarjeta). *Hecho: QR dinámico y Point sobre la Orders API (ADR-027, ADR-032); falta el primer cobro en vivo.*
  - [x] Modo (transferencia). *Hecho: Edges `modo_create_qr` y `modo_webhook`.*
  - [x] Conciliación automática. *Hecho: conciliación de procesadores, Mercado Pago automático (ADR-061) y tarjetas (ADR-044).*
- [~] **Rendimiento de base (escalado):** *Primer corte hecho (2026-10-13, ADR-090, rama `perf/f4-escalado`, migración `20261108500000_perf_f4_indices_rls_initplan` sin aplicar): auditoría reutilizable `scripts/db-audit-perf.mjs` (estática sobre las migraciones y `--catalog` sobre una base en sólo lectura), índices de listas y FKs en `payments`, `sales`, `cash_movements`, `stock_movements`, `table_order_items` y `fiscal_documents`, tres índices redundantes fuera, todas las policies con initplan (`perf_initplan_wrap`) y guardarraíles en CI (`rls_policies_without_initplan`, `perf_fk_without_index`). Script `scripts/prod-indexes-concurrently.sql` para producción con volumen.* *Segundo corte (2026-10-13, ADR-093, rama `perf/f4-create-sale`, migración `20261108600000_perf_f4_create_sale_tenant` sin aplicar): `create_sale` y `return_sale_v2` pasan `tenant_id` explícito en cada insert (sin lookup en `tenant_users` por fila; comportamiento idéntico, verificado), `catalog_search` usa los índices trigram y EAN con permisos iguales a la policy, y la auditoría suma P8 (RPC caliente que inserta sin `tenant_id`). Pendiente: búsqueda sin texto y de 1 o 2 caracteres en catálogos grandes, `exists` de `payments_branch_scope` con volumen.*
  - [x] Índices de listas y FKs de las tablas operativas grandes.
  - [x] Policies sin llamadas por fila (initplan) y guardarraíl en CI.
  - [ ] `create_sale` con `tenant_id` explícito (hoy el DEFAULT `current_tenant_id()` hace un lookup por fila insertada).
  - [ ] Medir con volumen real el `exists` sobre `sales` de la policy de `payments` (ADR-080) y la búsqueda de `catalog_products` bajo RLS.
  - [ ] FKs e índices redundantes del resto del esquema (`db-audit-perf.mjs --all-tables`) cuando crezca el volumen.
- [~] **Observabilidad avanzada:** *Webhooks de cobro con log propio (ADR-070); sin Sentry por decisión de ADR-070.*
  - [ ] Sentry para errores frontend.
  - [~] Logs estructurados centralizados. *`webhook_events` y log JSON en las Edge de cobro (ADR-070); faltan los crons y el resto de la app.*
  - [ ] Alertas en Slack/email para errores críticos.

### Criterios de cierre
- [ ] Un cliente con 3 sucursales puede operar simultáneamente sin latencia perceptible.
- [ ] Una impresora térmica imprime un ticket en < 2s después de cobrar.
- [~] Mercado Pago se acredita en la venta sin intervención del cashier. *Código: el webhook `mp_orders_webhook` acredita y el cobro en espera crea la venta del lado del servidor (ADR-032, ADR-048); falta validarlo en vivo.*

---

## F5 — Perfiles por rubro y marketplace

**Duración:** 10–14 semanas. **Objetivo:** el producto se siente "hecho a medida" para cada rubro sin código específico.

### Entregables
- [x] **Perfiles de rubro** activables por tenant. *Hecho (2026-10-13, ADR-075, rama `feat/perfiles-rubro`, migración `20261102200000_perfiles_rubro` sin aplicar): 11 perfiles versionados (kiosco, almacén, textil, ferretería, farmacia/perfumería, gastronomía, cafetería, verdulería/carnicería, librería, servicios, otro) que prenden flags operativos de `pos_settings`, ajustan el diseño del POS, crean categorías sugeridas y sugieren unidades, medios de cobro y features de plan ("disponible en plan X", nunca se activan). RPC `apply_business_profile` (sólo dueño, auditada), "Cambiar rubro" con vista previa en Configuración, paso en Puesta en marcha y lectura en el panel interno.*
  - [x] **Kiosco:** venta ultrarrápida, atajos de teclado optimizados, gestión de cigarrillos / bebidas.
  - [x] **Textil:** variantes (talle/color), control de prendas por SKU compuesto. *Perfil textil con diseño Boutique; variantes se sugiere (feature de plan, desde Pro).*
  - [x] **Retail:** promociones complejas (2x1, descuentos por volumen). *Hecho: NxM, segunda unidad y escalas por cantidad en el motor de promociones (ADR-074).*
  - [x] **Restaurante / resto-bar:** mesas, salones, comandas, cocina/KDS, cursos, división de cuenta y propina.
  - [x] **Cafetería / take away:** mostrador rápido, nombre del cliente, comandas de barra/cocina, combos y modificadores.
  - [~] **Heladería:** productos por botón, tamaños, sabores/modificadores, balanza opcional y comanda de preparación. *Usa el perfil cafetería; perfil propio pendiente.*
  - [~] **Peluquería / estética:** servicios, agenda, profesional, comisión y venta de productos complementarios. *Usa el perfil servicios (agenda y packs sugeridos); perfil propio pendiente.*
  - [~] **Pyme genérica:** módulo de cuenta corriente de clientes. *Perfil otro; la cuenta corriente se sugiere en almacén y ferretería.*
- [x] **Motor de promociones** configurable: *Hecho: ADR-074 (`lib/promotions/engine.ts` y `_promo_eval_core`).*
  - [x] Reglas declarativas (no código). *Hecho: tipos, alcance y condiciones como columnas validadas (ADR-074).*
  - [x] Vigencia por fecha/horario. *Hecho: vigencia, días y franja horaria (ADR-074).*
  - [x] Combinables o exclusivas. *Hecho: excluyentes o acumulables (`stackable`, ADR-074).*
- [ ] **Marketplace de integraciones:**
  - [ ] **H87 — Mercado Libre: gestor de publicaciones y ventas desde el POS.** *(agregado 2026-06-06)*
    - [ ] **Conexión por tenant**: OAuth "Conectar con Mercado Libre" (un click, mismo patrón que MP en H15); tokens y refresh en tabla de secretos con RLS deny-all (solo Edge Functions), renovación automática.
    - [ ] **Publicar desde el POS**: crear/editar publicaciones ML desde la ficha del producto — título, precio, fotos (reusa WebP de H7), categoría ML sugerida y atributos obligatorios. Vincular productos existentes con publicaciones ya creadas (matcheo por SKU/EAN de H10b).
    - [ ] **Gestor de publicaciones**: pantalla dedicada con listado y estado (activa, pausada, sin stock, con problemas), pausar/reactivar, edición rápida de precio/stock y métricas básicas (visitas, preguntas pendientes).
    - [ ] **Sincronización de stock y precio**: venta en mostrador descuenta stock de la publicación; cambio de precio/stock en el POS impacta en ML. Lista de precios por canal (gancha con H10: mostrador vs. ML con margen propio).
    - [ ] **Ventas de ML dentro del POS**: las órdenes de ML entran por webhook/notificaciones como ventas del canal "Mercado Libre" — descuentan stock, aparecen en /ventas y reportes con comisión ML y costo de envío visibles por venta.
    - [ ] **Conciliación**: cobros de ML (vía Mercado Pago) cruzados con sus órdenes; divergencias de stock detectadas con resolución manual (gancha con cockpit H84).
    - [ ] **Preguntas y mensajería** de compradores: bandeja básica para responder desde el POS *(etapa 2)*.
    - [ ] *Criterio:* el dueño conecta su cuenta ML, publica un producto del catálogo con foto y precio propio del canal, una venta en ML descuenta stock y aparece en /ventas con su comisión, y una venta en mostrador baja el stock de la publicación sin tocar ML a mano.
  - [ ] Tienda Nube.
  - [~] **H88 — Asistente IA como addon del plan.** *(agregado 2026-06-07; base hecha 2026-06-08)* Como en Ninja Food: una IA embebida en el POS, **gateada como addon de pago** (feature flag `ai_assistant` + addon en el plan). — *Addon completo: config por proveedor, contexto amplio, cuota, burbuja con compra y explicador sin addon. Falta el tool-use que aplica cambios al ticket (hoy guía/consulta).*
    - [x] **Burbuja de chat** en el shell (visible solo con el addon activo) con **Gemini o Claude** vía Edge Function `ai_assistant` (la key vive en `platform_secrets` por proveedor, nunca en el cliente); burbuja con spinner/gif/ícono de proveedor y **botón de compra** cuando no está el addon. — *PRs #208, #231, #238.*
    - [x] **Configuración interna por proveedor**: Gemini/Claude con **API key por proveedor**, **modelo correcto por proveedor**, modo test, imágenes de proveedor subibles (SVG default) y "Probar" real; sección **Complementos** en el POS. — *PRs #217, #231, #249; migración `ai_public_config_provider_image`.*
    - [~] **Configuración guiada del ticket**: la IA lee la plantilla activa del tenant y propone/aplica cambios (tool-use sobre `ticket_templates`, siempre con confirmación del usuario). — *Pendiente: hoy la IA guía y consulta; el tool-use que aplica cambios al ticket queda para la siguiente etapa.*
    - [x] **Guía del sistema**: responde "¿cómo hago X?" con contexto de las pantallas del POS — **explicador disponible sin addon**. — *PR #208.*
    - [x] **Consultas sobre sus datos** (solo lectura, scoped por RLS al tenant): **contexto amplio de la cuenta** — ventas del mes, caja, cuenta corriente, devoluciones y suscripción. — *PR #249.*
    - [x] Límite de uso por plan (mensajes/mes) + medición para facturar el addon. — *Cuota mensual configurable (`ai_usage`), PRs #205/#249.*
    - [~] *Criterio:* un tenant con el addon activo abre el chat, pide "armame un ticket con mi logo y mis colores", la IA genera la plantilla y el dueño la confirma; sin el addon, la burbuja no existe. — *El chat con contexto y el gateo de la burbuja están; la generación/aplicación de la plantilla por la IA queda pendiente.*
  - [ ] WhatsApp Business para notificaciones.
- [~] **API pública** con OAuth para clientes Enterprise. *v1 hecha (ADR-094): credenciales OAuth2 client_credentials por negocio con alcances, secreto mostrado una vez, rotación, revocación y último uso (Configuración > Integraciones > API, sólo el dueño); `/api/v1` con productos (cursor y upsert por SKU hasta 500 con Idempotency-Key), precios, sucursales y stock por sucursal con motivo, ventas por rango (lectura) y clientes; límite por credencial; OpenAPI 3.1 en `/api/openapi.json` y `docs/api-publica.md`. Feature `api_publica` OPTIONAL sólo Enterprise con gating en el token y en cada RPC. Falta: webhooks salientes, variantes, listas de precios y aplicar las migraciones `20261109400000` a `20261109400300`.*
- [~] **Tema visual personalizado** por tenant (logo, color de acento dentro de los límites de marca). *Logo y color de acento por negocio en `tenant_branding` (H8, gateado por `personalizacion_marca`) aplicados a tickets, emails y catálogo; falta aplicarlos al tema del panel.*

### Criterios de cierre
- [ ] Un cliente textil puede gestionar 500 SKUs con variantes sin pasar por NinjaSoft.
- [x] Una promoción "Miércoles 30% en bebidas" se configura desde el panel del cliente y aplica automáticamente. *Hecho: porcentaje por categoría con días de la semana, aplicado en `create_sale` (ADR-074).*
- [~] La API permite a un cliente Enterprise sincronizar 1000 productos en < 60s. *Medido en CI contra Supabase local (`tests/integration/rls-api-publica.test.ts`: alta y cambio de precio de 1000 productos en dos lotes de 500); falta validarlo contra producción.*

---

## Plan ampliado (2026-05-30)

Extensión del roadmap acordada con el equipo humano. Define hitos nuevos (`H7+`) sobre la base del MVP ya funcional. **Orden de ejecución: F6 → F7 → F8 → F10 → F11 → F12 → F13 → F9 → F14 → F15 → F16 → F3.** Cada hito cierra con el [corte de control](#cortes-de-control-y-testing-estricto) obligatorio.

### F6 — Personalización del producto

Objetivo: que el producto se sienta "a medida" de cada negocio. Todo configurable por tenant, con persistencia y multi-dispositivo.

- [x] **H7 — Fotos de productos → WebP.** — *Hecho (PR #27, 2026-05-31).*
  - [x] Subida de imágenes por producto (múltiples) desde el form de producto.
  - [x] Conversión a **WebP** **client-side** (`canvas.toBlob('image/webp')`, redimensión a 900px, calidad 0.82) antes de subir; guarda en Supabase Storage (bucket `product-images`) con RLS por tenant (path `tenant_id/product_id/uuid.webp`). *(`sharp` no corre en Supabase Edge/Deno; se hace en el navegador.)*
  - [x] Galería por producto: marcar principal (actualiza `products.image_url`), eliminar (borra de Storage + fila).
  - [x] Optimización de peso (un JPG grande baja a decenas de KB en WebP a 900px).
  - [x] *Criterio:* subir una imagen grande resulta en un WebP liviano servido por URL pública; sin policy de listado en el bucket.
  - *Pendiente menor:* multi-tamaño (thumb/card/full) — hoy se sirve una sola imagen optimizada; los thumbnails se muestran por CSS. Drag&drop para reordenar queda para una iteración.

- [x] **H8 — Branding por tenant.** — *Parcial/base hecha (PR #29, 2026-05-31).*
  - [x] Logo del negocio (subida → WebP, bucket `tenant-assets` con RLS), color de acento (presets dentro de límites de marca), datos comerciales.
  - [x] Datos legales del comercio: razón social, CUIT, teléfono, dirección, pie de ticket. Tabla `tenant_branding` (escritura owner/manager por RLS). UI en `/dashboard-team` (BrandingCard).
  - [x] Modo del negocio/rubro operativo (presets por rubro). *Perfiles por rubro de F5 (ADR-075).*
  - [x] Logo en PNG/JPG/WebP → se normaliza a WebP en el navegador.
  - [x] Aplicado en **tickets** (logo + razón social + CUIT/dirección/teléfono + pie). *Emails y catálogo: cuando existan (H13/H10).*
  - [ ] (Opcional Enterprise) dominio propio para el catálogo.
  - [x] *Criterio:* el logo y los datos del tenant se ven en el ticket sin tocar código.
  - *Pendiente:* condición IVA/provincia/ciudad y selector de rubro; aplicar acento al catálogo (H10).

- [~] **H9 — Tickets y comprobantes personalizables.** — *Título, leyenda extra y QR del comprobante hechos (branding). Solo falta preview por sucursal (multi-store, F4).*
  - [x] Plantillas de ticket con logo, datos comerciales y pie configurable (vía branding H8).
  - [x] Formatos **58mm / 80mm** (térmica, selector por tenant aplicado al ticket/impresión) y **A4 (PDF)** descargable (`jspdf`, PR #31).
  - [x] Título del comprobante configurable (ej. "Comprobante no fiscal") — `tenant_branding.ticket_title`.
  - [x] Texto al pie del ticket configurable.
  - [x] Logo en el ticket (si hay branding).
  - [x] CUIT y datos fiscales en el ticket (si están cargados).
  - [x] Ancho 58/80mm configurable (por tenant; por caja queda para multi-caja F4).
  - [x] QR (datos de la venta) y leyenda extra en ticket y PDF (`ticket_show_qr`, `ticket_legend`). Preview por sucursal queda para multi-store (F4).
  - [x] **Numeración del comprobante personalizable por tenant**: prefijo + padding (`pos_settings.sale_prefix`/`sale_pad`) sobre el correlativo único por tienda. Se aplica en /ventas, ticket y PDF; configurable en Operación del POS. El correlativo interno se mantiene.
  - [x] *Criterio:* un tenant configura su ticket (logo/datos/título/pie/leyenda/QR/ancho), lo imprime y descarga A4.

- [x] **H9b — Editor visual de ticket multi-modo + envío por email.** — *Completo (2026-06-06): PR1 infra + bloques + email; PR2 modos canvas y HTML. Spec: [`superpowers/specs/2026-06-06-h9b-ticket-designer-design.md`](superpowers/specs/2026-06-06-h9b-ticket-designer-design.md).*
  - [x] **Editor visual por bloques**: el dueño diseña su ticket/comprobante con bloques reordenables (logo, datos del negocio, título, datos de venta, cliente, ítems, totales, medios de pago, QR, código de barras, texto libre, imagen, separador, pie) con opciones por bloque y preview en vivo. WYSIWYG. — *Configuración → Tickets, `TicketTemplateEditor`.*
  - [x] Plantillas guardables por tenant y por tipo (`sale`/`promo`/`gift`; papel 58/80/A4), default por tipo, duplicar/eliminar. Preview en vivo con venta de muestra. — *Tabla `ticket_templates` + `TicketTemplatesCard`.*
  - [x] Render a imagen/PDF desde el diseño para imprimir, descargar y adjuntar. — *`TicketRenderer` único (térmica vía `ticket-print`, A4 vía html2canvas + jsPDF, PNG para email).*
  - [x] **Logo NinjaSoft al pie opcional** por plantilla (`show_ninjasoft_logo`), aplica en los 3 modos.
  - [x] **Envío del comprobante por email al cliente** con el diseño elegido; registro de envío (`receipt_email_to/At` + `audit_logs`) y reenvío desde /ventas. — *Edge Function `send_receipt_email` (SMTP del sistema H13).*
  - [x] Botón "Enviar por email" en el ticket de una venta (usa el email del cliente o lo pide al momento, con opción de guardarlo en la ficha); **envío automático** opcional si el cliente tiene email (`pos_settings.auto_email_receipt`).
  - [x] **Modo canvas libre (XY tipo Canva)**: elementos con posición/tamaño libres, drag con puntero + coordenadas numéricas; la tabla de ítems es elemento de flujo (alto elástico). Ideal promos/gift. — *PR2, `CanvasTicketRenderer` + editor canvas.*
  - [x] **Modo HTML avanzado** con variables `{{…}}` (18 vars, click-para-copiar) y **5 plantillas precargadas** (Clásico 80mm, Compacto 58mm, A4 factura, Volante promo, Gift card); sanitizado DOMPurify. — *PR2, `HtmlTicketRenderer`.*
  - [x] *Criterio:* el dueño diseña su ticket en cualquiera de los 3 modos, lo guarda como default, y al cobrar puede imprimirlo, bajarlo en A4 y enviarlo por email al cliente con ese diseño. ✓
  - [x] **PR3 — Email del negocio + activación por destino** *(2026-06-06)*: comprobantes salen del **SMTP del propio tenant** (card guiada en Configuración → Email: Gmail/Outlook/Otro, contraseña de aplicación, probar conexión; `tenant_email_smtp` deny-all + `set_tenant_smtp`); cuerpo HTML con branding del tenant (logo + acento, fallback ninja) y **texto personalizable**, comprobante adjunto; **un modelo activo para impresión y uno para email** (`print_active`/`email_active`, únicos por tenant; sin activo → ticket clásico); fix: la plantilla activa ahora sí aplica al cobrar en el POS.
  - [x] **PR4 — Canvas PRO + 5 modelos por modo** *(2026-06-06)*: subir imágenes al canvas (pipeline WebP de H7 → tenant-assets), **resize con handle** y **recorte** con modal propio; **5 modelos precargados en los 3 modos** (bloques, canvas y HTML) con picker al crear — promo/gift ya no arrancan vacíos.

- [~] **H10 — Catálogo público + variantes.** — *Variantes + listas de precios por canal completas (2026-06-07). Solo queda carrito/pedido (→ F12/F13). Spec: [`superpowers/specs/2026-06-06-h10-variants-price-lists-design.md`](superpowers/specs/2026-06-06-h10-variants-price-lists-design.md).*
  - [x] Catálogo web público por tenant en `/c/<slug>` (RPC `public_catalog` SECURITY DEFINER, anónimo; solo tenants activos y productos activos). Muestra logo/branding, fotos, precios y categorías.
  - [x] Variantes por rubro (talle/color para textil; SKU compuesto). — *Ejes genéricos (máx 2) + matriz de combinaciones en el form (`VariantsEditor`), SKU auto-sufijado, barcode/precio/stock por variante; picker en el POS + escaneo directo; `create_sale`/`return_sale` mueven stock por variante; +tests RLS y de matriz.*
  - [x] Listas de precios por canal (mostrador / catálogo / mayorista). — *`price_lists` + `price_list_items` (por producto/variante), resolución item-variante → item-producto → ajuste % → base (`lib/prices/resolve.ts`); UI en Configuración; POS usa lista mostrador; `/c/<slug>` usa lista catálogo (RPC reescrita).*
  - [ ] Carrito/pedido desde el catálogo (cruza con F12/F13 y delivery).
  - [x] *Criterio (base):* un tenant con productos activos publica su catálogo en `/c/<slug>` sin tocar código.
  - [x] *Criterio (variantes):* un textil gestiona talle/color con stock por combinación, el POS pide la variante al vender y el precio del catálogo sale de su propia lista. ✓
  - *Nota:* el motor de promociones se trata aparte y a fondo en **[F9 — Motor de promociones PRO](#f9--motor-de-promociones-pro)**.

- [x] **H10b — Catálogo PRO: ficha de producto completa, marcas y categorías.** — *Completado (2026-06-05). Solo quedan fuera stock por depósito (→ F11/H33) y variantes (→ H10).*
  - [x] **Form de alta/edición de producto rico** (mejor que la competencia: una sola pantalla, todo opcional, defaults inteligentes): nombre, **EAN/código de barras**, **SKU interno** (auto-generado al guardar si no se carga, con prefijo configurable — gancha con H30), precio de venta, costo, **categoría**, **marca**, **IVA %**, **unidad de medida**. — *`ProductFormModal` (alta/edición); SKU auto vía trigger `products_auto_sku`; alta inline de categoría y marca desde el propio form.*
  - [x] **Subida de fotos opcional con conversión a WebP** en el propio alta (no solo en edición): arrastrar/elegir imagen → WebP liviano client-side → galería; también admite **URL de imagen**. (Reusa H7.) — *Al crear, el modal queda en modo edición y se suben fotos sin reabrir (`ProductImages`); campo "URL de imagen" en el alta.*
  - [x] **Datos adicionales plegables:** descripción larga (para ticket/catálogo), **tags** (lista separada por coma, para filtros y promos), **temporada** (ej. "Verano 2026"), **garantía de fábrica en meses** (gancha con H28: imprime en ticket y habilita garantía extendida). — *Sección `<details>` colapsada por defecto en el form (2026-06-05).*
  - [x] **Categorías con 2 niveles** (rubro → sub-rubro, ej. Indumentaria → Calzado): alta/edición/orden, máximo 2 niveles, asignables al producto. — *`CategoriesModal`: árbol por `parent_id` hasta 4 niveles (supera lo pedido), selector jerárquico en el form.*
  - [x] **Catálogo de marcas** por tenant: alta/edición, asignación a productos y uso como **condición de promociones por marca** (gancha con F9/H54). — *`BrandsModal` (crear/renombrar/eliminar, 2026-06-04) + selector en el form; condición de promos queda para F9.*
  - [x] **Controla stock (toggle por producto):** si está apagado, el producto **no descuenta stock** al venderse (ej. servicios). — *`products.track_stock` + `create_sale` lo respeta (migración `product_attributes`). Default por rubro queda con los presets de F12/F13.*
  - [x] **Permite venta en cero/negativo (override por producto)** del setting global (gancha con H30). — *`products.allow_negative` (hereda/sí/no en el form); `create_sale` lo aplica.*
  - [x] **Producto serializado (IMEI/N° de serie):** cada unidad tiene serie única; al vender, el cajero elige el serial que sale. — *`product_serials` + `SerialsEditor` en el form + picker de serial en el POS; `create_sale` marca el serial vendido. Base avanzada queda en F14/H64.*
  - [x] **Kit / combo (BOM de retail):** un kit no tiene stock propio; al venderse descuenta el stock de sus **componentes** según cantidades configuradas. — *`product_kits` + `KitComponentsEditor`; `create_sale` descuenta componentes (respetando `track_stock`/`allow_negative` de cada uno).*
  - [~] **Stock inicial por depósito** desde el alta (gancha con F11/H33) y **variantes talle/color** (gancha con F6/H10) cuando el producto las tenga. *Variantes en el alta (`VariantsEditor`, H10) y depósitos con stock inicial por importación (`import_warehouse_stock`, ADR-085); falta elegir el depósito en el alta.*
  - [x] *Criterio:* el dueño crea un producto con marca, IVA, foto WebP, tags y garantía en una sola pantalla; arma una categoría de 2 niveles; marca un servicio como "no controla stock"; define un kit que descuenta sus componentes; y un electro como serializado que pide el N° de serie al vender. ✓

- [~] **H10c — Tiendita / Catálogos precargados (storefront de catálogos).** *(feature nueva, agregada 2026-06-08 — no estaba en el roadmap original)* Un catálogo precargado por NinjaSoft (ej. kiosco/almacén con miles de productos) que el dueño **compra una vez** y carga a su negocio sin cargar productos a mano. Doble plano: **gestión interna** de los catálogos y **storefront** para el dueño. — *Base completa (PRs #245/#246/#247); falta gobierno fino del addon (versionado/actualización del catálogo comprado) y métricas de adopción.*
  - [x] **Addon interno de catálogos** (`/internal/catalogos`): schema de catálogos precargados, **import batcheado** desde Excel, sample real y gestión (crear, ver, **bonificar** a un tenant). — *PR #245; migraciones `tiendita_catalogs`, `tiendita_catalog_admin_rpcs`.*
  - [x] **Storefront del dueño** (`/tiendita`): **comprar un catálogo con pago único de Mercado Pago**, buscar y agregar productos del catálogo (con **categoría anidada**) al propio negocio, con animación de logos. — *PR #247; Edge Functions `catalog_purchase_checkout` + `catalog_purchase_webhook`; migración `tiendita_catalog_payment`.*
  - [x] **Flechas de precio vs. catálogo de referencia** en productos/listas (compara el precio propio contra el del catálogo; toggle en config, visible solo si el tenant compró el catálogo). — *PR #246; migración `catalog_price_reference`.*
  - [ ] Actualización/versionado del catálogo comprado (re-sincronizar altas/bajas/precios sugeridos cuando NinjaSoft actualiza el catálogo de origen).
  - [x] *Criterio:* el dueño entra a `/tiendita`, compra un catálogo con un pago único de MP, agrega productos al negocio con su categoría y ve flechas de comparación de precio contra la referencia. ✓

### F7 — Panel interno PRO + comunicaciones

Objetivo: que NinjaSoft opere el SaaS completo sin SQL, con control fino de usuarios, planes y comunicaciones.

- [x] **H11 — Roles de staff NinjaSoft + gestión total de usuarios.** — *Hecho (PR #33 backend + PR #40 UI). Página `/internal/staff`: listar, agregar por email, cambiar nivel y quitar. Bootstrap del primer super_admin desde la propia página.*
  - [x] Tres niveles de staff: **super-admin**, **admin**, **soporte**.
    - *super-admin:* todo (sumar/quitar staff, borrar tenants, facturación, acciones peligrosas).
    - *admin:* gestión de tenants/usuarios/soporte; sin tocar staff ni acciones destructivas.
    - *soporte:* solo-lectura + acciones limitadas (notas, ver salud, reset de contraseña).
  - [x] Gestión total de usuarios (staff): ver todos, **pausar/suspender/reactivar**, cambiar roles, **sumar poderes**, y **sumar usuarios como staff NinjaSoft** (con su nivel). — *Página `/internal/usuarios`: todas las cuentas con membresías por negocio (tenant + rol), búsqueda, filtro "solo suspendidos", suspender/reactivar (ban en auth + espejo `users.suspended_at`). Guards en `staff_admin`: `admin`+ suspende; a un staff solo lo toca un `super_admin`; nadie se suspende a sí mismo. Sumar staff/cambiar nivel sigue en `/internal/staff`.*
  - [x] Toda acción crítica en `audit_logs`; matriz de permisos versionada en [`06-permissions-roles.md`](./06-permissions-roles.md). — *`staff_level_set`, `user_suspended`/`user_reactivated` auditados; matriz actualizada con la fila de suspensión y el estado de implementación.*
  - [x] *Criterio:* un super-admin suma a otra persona como admin de NinjaSoft en una acción; un admin no puede tocar staff. — *Enforced en `staff_admin` (set_level solo super; set_active sobre staff solo super).*

- [~] **H11c — Consola internal completa + login independiente.** *KPIs SaaS + buscador de tenants (2026-06-04); login interno diferenciado + buscador global multi-campo (2026-06-05); alta manual, ciclo de vida con motivo y timeline de auditoría por negocio (2026-10-13, ADR-073); acceso como el negocio con duración, banner y cierre, miembros desde internal, ficha 360 y salud por negocio (2026-10-13, ADR-084). Falta: tickets de soporte en los KPIs cuando exista ese módulo.*
  - [x] Entrar directo a `/internal` redirige a `/internal/tenants`; si no hay sesión, login conserva destino interno (`/login?next=/internal/tenants`).
  - [x] Dashboard con 8 KPIs SaaS (total, trial, activos, con problemas, nuevos 7/30d, conversión, MRR), breakdown por plan, alerta de negocios con problemas, quick links y tabla con buscador. Componente `TenantSearchTable`.
  - [x] Pantalla de acceso interno con copy y layout diferenciado de POS/tenant. — *`/login-internal` (2026-06-05): card propia "Staff NinjaSoft / Panel interno" con aviso de auditoría, sin registro, link cruzado al login de clientes; al entrar va a `/internal/tenants`.*
  - [~] Dashboard internal con KPIs SaaS: MRR, ARR, trials, activos, past_due, suspendidos, churn, conversión trial→paid, tickets de soporte y alertas. — *10 KPIs en `/internal` (2026-06-07: +ARR estimado y Churn 30d; MRR incluye past_due). Tickets de soporte cuando exista ese módulo.*
  - [x] Buscador global por tenant, CUIT, email owner, teléfono, slug, plan, estado, feature flag y fecha de alta. — *`/internal/tenants` (2026-06-05): el texto matchea nombre/slug/dueño/email, y CUIT/teléfono por dígitos; filtros de estado, plan, feature flag (efectivo: override o default) y rango de fecha de alta (DateRangePicker).*
  - [x] Ficha 360 del tenant: datos legales/comerciales, owners, usuarios, sucursales, cajas, ventas, módulos activos, flags, salud, últimos errores y actividad. *ADR-084: RPC `internal_tenant_360` (agregados, módulos efectivos con `tenant_has_feature_for`, errores de webhooks, fiscales y emails, actividad) + `Tenant360Card` con puntaje de salud (`lib/internal/tenantHealth.ts`); datos legales en `TenantProfileCard`. El inicio de `/internal` lista los negocios en riesgo.*
  - [x] Desde internal se puede invitar usuarios al tenant, reenviar invitación, cambiar rol, suspender/reactivar miembro y resetear acceso con motivo. *ADR-084: `TenantMembersCard`, RPC `internal_member_admin` (rol, suspender, reactivar, cortar sesiones; último dueño protegido; rol de dueño sólo super_admin; soporte sólo resetea) y Edge `internal_tenant_members` (invitar, reenviar, email de recupero). Todo con motivo y en `audit_logs`.*
  - [x] Desde internal se puede convertir un usuario existente en staff NinjaSoft y asignarle rol/nivel interno según permiso. *Auditoría 2026-10-13: ya estaba. `/internal/staff` busca la cuenta existente por email y le asigna nivel con la Edge `staff_admin` (`set_level`, sólo `super_admin`), auditado como `staff_level_set` (H11, PR #33 y #40).*
  - [x] Impersonation/abrir contexto de tenant solo con motivo, duración limitada, banner visible y auditoría. *Motivo obligatorio y auditado antes de devolver el link de un uso (ADR-073). ADR-084: duración elegida (15 min a 4 h), `impersonation_sessions`, link `/auth/impersonate` que ata la sesión de Auth, banner con cuenta regresiva sólo en esa sesión, cierre desde el banner, desde el panel o por cron (`impersonation-expire`) que borra la sesión de Auth; inicio y cierre auditados.*
  - [x] Acciones peligrosas requieren confirmación fuerte, motivo y quedan en `audit_logs`. *ADR-073: suspender, reactivar y dar de baja con motivo obligatorio; la baja pide escribir el identificador y es sólo super admin (`internal_tenant_lifecycle`).*
  - [x] **Alta manual de negocio desde internal** (nombre, rubro, dueño por email con invitación, plan y trial). *ADR-073: Edge `internal_create_tenant` + RPC `internal_create_tenant` (service_role), auditado.*
  - [x] **Suspender / reactivar / baja lógica** con motivo y efecto real en el servidor. *ADR-073: `assert_account_active` bloquea venta, caja y devoluciones del negocio suspendido, cancelado o con `deleted_at`; nunca `DELETE`.*
  - [x] **Timeline de auditoría por negocio** legible y filtrable (categoría, texto, fechas, motivo, antes/después). *ADR-073, `TenantAuditTimeline`.*
  - [x] *Criterio:* un super-admin entra por `/internal` sin pasar por POS, encuentra un tenant, invita un owner/cajero, cambia plan, activa módulos y promueve un usuario a admin interno, todo auditado. *Cubierto en código (2026-10-13): login interno, buscador, invitar desde Miembros (ADR-084), `PlanCard`, feature flags del negocio y `/internal/staff`. Validar en producción al aplicar las migraciones.*

- [x] **H11b — Miembros del negocio (lo gestiona el DUEÑO en `/dashboard-team`).** — *Hecho (PR #25, 2026-05-30).*
  - [x] **Dos clases de miembro** (el dueño elige al crear):
    - **Con login:** email + contraseña, recibe invitación (Edge Function `invite_user`). Nombre real **o** genérico (ej. "Cajero A").
    - **Perfil sin login:** etiqueta para identificar quién vende (ej. "Cajero A"), **sin email**, con **PIN opcional** para fichar en el POS. Útil en kioscos con caja compartida.
  - [x] **Nombre por membresía:** `display_name` en `tenant_users` (+ tabla `cashier_profiles` para los sin-login, con `pin_hash`).
  - [x] **Avatares:** set de **presets** (iniciales con color + emoji) elegibles ya (componente `Avatar`); subida de imagen propia se habilita en **F6 (WebP)**. Columna `avatar` en membresía/perfil.
  - [x] **Edición por el dueño:** `owner`/`manager` editan miembros (nombre, rol, avatar) y suspenden/reactivan; resetean PIN de perfiles. Edge Function `member_admin` (guard owner/manager), auditado. No se puede editar al propio usuario ni al owner desde la UI.
  - [x] *Backend (deployado con Supabase MCP):* migración `20260530230000_members_profiles`, Edge Functions `invite_user` (extendida) y `member_admin`, `tenant_members()` extendida.
  - [x] *Criterio:* el dueño crea "Cajero A" sin email con avatar preset y PIN; luego lo renombra y lo suspende; un cajero no puede editar a otros.
  - *Pendiente menor:* el PIN se hashea con SHA-256 (uso de baja seguridad); migrar a bcrypt cuando se implemente el fichaje en el POS (F12).

- [~] **H12 — Suscripciones, billing manual y lifecycle comercial.** — *Base (2026-06-04) + lifecycle del trial y cobranza (2026-06-05) + plan custom/overrides/descuentos (2026-06-07) + **billing self-serve, panel del dueño y dunning automático** (2026-06-08). Cobro real por MP cableado (checkout owner-callable + webhook); el cobro en vivo queda por validar en producción. Quedan historial completo de cambios y automatizaciones avanzadas.*
  - [~] Upgrade/downgrade de plan, cambio de estado (`trial`/`active`/`past_due`/`suspended`/`cancelled`), fechas de período. — *Upgrade desde el panel del dueño (PR #226); estados conciliados por el dunning de 3 días con reanclaje de período (PR #237). Downgrade self-serve fino pendiente.*
  - [~] Aumentar/limitar módulos y feature flags por tenant desde una sola consola. *Auditoría 2026-10-13: en el detalle del negocio (`app/internal/tenants/[id]/page.tsx`) están los feature flags del negocio (`useTenantFlags`) y los overrides de límites (`PlanCard`); los módulos se tocan con el plan custom en el editor de planes. Falta un único panel de módulos por negocio.*
  - [x] **Plan específico por cliente:** clonar un plan base, cambiar nombre comercial, límites, módulos, soporte, precio y condiciones sin afectar a otros tenants. — *RPCs `internal_clone_plan` / `internal_update_custom_plan` + `PlanCard` en el detalle del tenant (2026-06-07).*
  - [~] **Overrides de cuota/límites por cliente:** usuarios, sucursales, cajas, productos, ventas mensuales, almacenamiento, módulos, soporte y límites fiscales. — *Base hecha (2026-06-07): `subscriptions.limit_overrides` + RPC auditado + editor por límite (efectivo = override ?? plan). Cajas/almacenamiento/fiscales cuando existan esos límites.*
  - [ ] **Aumento de cuota/precio a un cliente:** cambio inmediato o programado con fecha efectiva, motivo, aviso previo, aceptación opcional y registro de antes/después.
  - [x] Trial configurable: extender trial, acortarlo, convertir a paid, marcar como perdido, registrar motivo. — *Completo (2026-06-05): extender (+7/14/30/60/90), "Fijar fin…" a fecha exacta (acortar/terminar — RPC `internal_set_trial_end`), "Convertir a pago" y "Marcar perdido" con motivo (RPC `internal_trial_outcome` → active/cancelled). Auditado con before/after + reason; migración `trial_lifecycle` aplicada en remoto.*
  - [x] Billing manual: registrar pago, medio, período cubierto, comprobante/recibo interno, deuda y próxima fecha de vencimiento. — *Completo (2026-06-05): a la base (`billing_records` append-only) se suma el bloque de cobranza en la card Facturación: próximo vencimiento = último `period_end`; si quedó en el pasado, "Vencido hace N días" + deuda estimada (meses vencidos × precio mensual del plan).*
  - [~] Descuentos comerciales, precio acordado, cupones/manual override y notas internas con vigencia. — *Descuentos percent/fixed con vigencia y precio mensual efectivo en Facturación (2026-06-07); cupones pendientes.*
  - [x] Historial de cambios de plan/estado/precio con antes/después, autor, fecha, motivo y fuente. *Auditoría 2026-10-13: lo cubre el timeline de auditoría por negocio (ADR-073, `TenantAuditTimeline`): categorías "Plan y facturación" y "Ciclo de vida" con antes y después por campo, autor (o "Sistema" para dunning y webhooks), fecha y motivo.*
  - [~] Automatizaciones futuras: avisos de vencimiento, suspensión, reactivación y webhooks de pago. — *Hechas (2026-06-08): **dunning de 3 días** que avisa, suspende y reactiva reanclando el período (PR #237); **webhook de pago** que registra y notifica el cobro (PR #226); **cola de emails auto-enviada** por cron + `pg_net` vía Resend (PR #251). Falta orquestación fina de aumentos masivos.*
  - [~] **Panel del dueño (self-serve) + cobro por Mercado Pago** *(agregado 2026-06-08)*: el dueño ve plan actual + imagen, días restantes, upgrade, **registro de pagos** (`my_payment_history`), baja sutil/cancelar y gestión del medio de pago; **checkout self-serve por MP** (owner-callable) + **addon IA cobrado en MP** + update del monto (PRs #226, #228, #232, #234, #235, #239). El cobro real queda por validar en producción.
  - [~] *Criterio:* pasar un tenant de Start trial a un plan custom "Pro Heladería Lucas" activo con vencimiento, pago registrado, cuota aumentada, módulos activados y notificación pendiente queda auditado de punta a punta. — *Casi: plan custom, overrides, pago registrado, vencimiento y notificación al owner están; falta el historial unificado de cambios.*

- [x] **H13 — Emails del sistema (NinjaSoft, en `/internal/emails`).** — *Editor + remitente + envío Resend (PR #51) + **Resend con failover de proveedores, plantillas transaccionales completas, factura PDF por email y auto-envío de la cola** (2026-06-08, PRs #210/#214/#251). Envíos masivos del cliente quedan para una fase aparte.*
  - [x] **Emails del sistema son GLOBALES y se editan en `/internal/emails`** (no en el POS del cliente). Tablas `system_email_templates` + `system_email_config` (RLS solo `is_internal`). Override de defaults de `lib/email/templates.ts`.
  - [x] **Editor HTML + variables + preview en vivo**; catálogo: bienvenida, invitación, reset, trial por vencer, pago vencido, suspensión.
  - [x] **Remitente configurable** (nombre + email de dominio verificado) en `/internal/emails`.
  - [x] **Envío real por SMTP propio** (denomailer, sin secrets de backend): el remitente y el servidor SMTP se configuran desde `/internal/emails` (host/puerto/usuario/clave/secure/from). Edge Functions `set_email_smtp` (guarda) y `send_email` (envía, guard `is_internal`); clave en `system_email_smtp` (RLS solo service_role), lectura sin clave vía `get_email_smtp()`. Botón "Enviar prueba".
  - [x] **Log de envío** en `audit_logs` (acción `email_sent`).
  - [x] **Resend con failover de proveedores** + **plantillas transaccionales** + **prueba con destinatario** + **auto-envío de la cola** (cron + `pg_net`, unificado en Resend) con **reintentos**, **emails de alta de cuenta** y plantillas conectadas a los emisores. — *PRs #210 (Edge Function `set_email_providers`), #251 (migración `email_autosend`).*
  - [x] **Factura/comprobante PDF por email** (asunto con hora, footer con logo) usando **Resend del cliente**. — *PR #214.*
  - [ ] **Brevo** + **envíos masivos** (siguiente etapa; el failover ya cubre el envío transaccional con reintentos).
  - [ ] **POS del cliente:** los tenants suman **sus propios proveedores** para **campañas masivas** a sus clientes (en `/configuracion` del tenant) — *fase aparte (no son los emails del sistema).*
  - [x] *Criterio:* en `/internal/emails` se edita una plantilla, se previsualiza con variables y se envía una prueba; los emails del ciclo de vida salen solos por la cola.

- [~] **H13b — Centro de notificaciones por cuenta.** — *Base completa (2026-06-07) + **ventana de captación, borrar y archivar abajo** (2026-06-08, PR #213): tablas `notifications`/`notification_reads` con RLS por audiencia, campana + panel en el POS (leer/archivar/borrar/ack, banner para `blocking`), composer en `/internal/notificaciones` (broadcast/negocio/rol, historial) y notificación automática al cambiar precio de plan custom. Quedan: preferencias por canal (email/WhatsApp/push) y acciones embebidas transaccionales (pagar/aceptar).*
  - [x] Panel de notificaciones dentro de cada tenant: novedades, cambios de plan, vencimientos, pagos, alertas de uso, seguridad, AFIP, mantenimiento y soporte. — *Campana + panel en el shell del POS (tipos news/plan/billing/usage/security/afip/maintenance/support).*
  - [x] Notificaciones dirigidas por audiencia: owner, manager, cashier, viewer, todos, sucursal específica o usuario específico. — *Audiencia broadcast / negocio / rol / usuario, vía RLS.*
  - [x] Estados: no leída, leída, archivada, requiere acción, vencida. — *Leída/archivada/borrada/ack en `notification_reads`; **vencimiento por `display_until`** (ventana de captación, PR #213).*
  - [x] Severidad: info, éxito, advertencia, crítica, bloqueo. — *info→blocking con acento por severidad y banner fijo para `blocking`.*
  - [ ] Acciones embebidas: pagar, actualizar datos, aceptar cambio de plan, descargar comprobante, ver deuda, renovar, contactar soporte. — *Acción embebida genérica (`action_label`/`action_url`) e info en "requiere confirmación" (PR #229); las transaccionales (pagar/aceptar) quedan pendientes.*
  - [ ] Preferencias por canal: in-app obligatorio para eventos críticos; email/WhatsApp/push futuro configurables por tipo.
  - [x] Composer internal para enviar novedades globales o por segmento de clientes. — *`/internal/notificaciones`: broadcast / negocio+rol, con historial.*
  - [x] **Anuncios por segmento** (plan, estado, rubro y fecha de alta) con vista previa de a cuántos negocios llega, un aviso por negocio en un lote auditado y borrable entero. *ADR-084, RPC `internal_notify_segment`, `lib/internal/segments.ts`.*
  - [~] *Criterio:* al aumentar cuota/precio de un tenant, el owner ve una notificación in-app con fecha efectiva, motivo, nuevo monto, historial y acción de aceptación/consulta. — *La notificación automática con `requires_ack` está; la acción de aceptación transaccional queda pendiente.*

### F8 — Pagos y cobros

Objetivo: cobrar por cualquier medio, con arquitectura extensible. **Arquitectura primero, integraciones por etapas** (un sub-hito por proveedor).

- [x] **H14 — Arquitectura de pagos (base).** — *UI de cobro abstracta completada (2026-06-04).*
  - [x] Registro de **proveedores de pago** (`payment_providers`, catálogo global seedeado con los 10 medios) y config por tenant.
  - [x] Habilitación y **configuración por tenant** (`tenant_payment_methods`: enabled, recargo %, sandbox; RLS owner/manager). **Secretos** en `payment_secrets` (RLS deny: solo service_role/Edge Functions). UI `PaymentMethodsCard` en `/dashboard-team`.
  - [x] **UI de cobro abstracta** en el POS: `PaymentModal` lee `tenant_payment_methods.enabled` y muestra solo los medios del tenant (fallback a todos si no hay config). Selector de planes activos para débito/crédito con recargo. Recargo global del medio si `surcharge_pct > 0`. Hook `useEnabledPaymentMethods()`.
  - [x] Medios manuales reales: **Efectivo**, **Transferencia** (en catálogo; el POS ya cobra efectivo/transferencia/mixto).
  - [~] **Detección automática de transferencias en un CVU de Mercado Pago** (feature `transferencia_auto_mp`, Pro): mientras la pantalla de transferencia espera, el servidor busca la transferencia recibida en Mercado Pago y la empareja por monto (± tolerancia) y ventana de tiempo, sin reusar un movimiento y preguntando al cajero si hay más de una opción; avisa o cierra la venta sola. *Hecho en `feat/detalle-venta-conciliacion` (ADR-061, adenda). Pendiente: validar con una cuenta real que `payments/search` informa las transferencias entrantes a CVU ("Probar detección"), vincular la venta al watch al confirmar, override por sucursal y caja, y barrido de watches vencidos.*
  - [x] *Criterio:* el POS muestra solo los medios habilitados por el tenant y aplica el recargo configurado. ✓

- [~] **H15+ — Integraciones por proveedor** (un sub-hito cada uno, cableado incremental sobre la arquitectura de H14):
  - [~] **H15** — Mercado Pago. **Conexión por Access Token + QR de cobro (Checkout Pro) + OAuth "Conectar con MP" hechos**: Edge Functions `set_payment_secret`, `mp_create_qr`, `mp_webhook`, `mp_oauth_start`, `mp_oauth_callback` (`state` anti-CSRF, refresh de token); botón "Conectar con Mercado Pago" (un click) y "Cobrar con QR" en el POS; tabla `mp_payment_intents`. **Billing de suscripciones**: credenciales de plataforma en `platform_secrets` editables desde `/internal/pagos` (`set_platform_secret`), `mp_subscription_checkout` (preapproval) + `mp_billing_webhook`; "Generar link de cobro" en el detalle del tenant. **Conciliación básica hecha** (modal "Cobros QR" en /ventas: intents cruzados con sus ventas, alerta de "aprobado sin venta", filtros + export XLSX). **Mercado Point (tarjeta presencial) hecho** (2026-07-10, ADR-027): Edge `mp_point` (devices/pdv/create/status/cancel) reutilizando la conexión MP del tenant, `PointCheckoutModal` en el POS (elegir lector → cobro en el Point → venta como débito/crédito real), verificación independiente contra `/v1/payments` antes de acreditar, conciliación compartida en "Cobros QR". *Pendiente: validar con lector físico (primer cobro en vivo).* **Migración a la Orders API unificada** (2026-10-11, ADR-032): QR dinámico en la caja del local (Edge `mp_qr`: alta única de sucursal + caja desde Medios de pago, `POST /v1/orders` type `qr` con `X-Idempotency-Key`, QR dibujado local sin servicios externos, status/cancel), "Enviar link" de Checkout Pro desde el mismo modal (fallback automático si no hay caja), Point sobre `POST /v1/orders` type `point` (terminales `/terminals/v1/list`, PDV, cuotas preseleccionables, cancel con `at_terminal`) con compatibilidad para intents legacy, webhook topic `order` (`mp_orders_webhook`, re-lee la order con el token del tenant) y switch Sandbox de MP (token de prueba). *Pendiente: aplicar migración `20261011170000_mp_orders_api`, desplegar Edges, configurar el webhook `order` en la app de MP y validar QR + Point en sandbox y en vivo.*
  - [~] **H16** — **MODO** vía QR interoperable. — *Transaccionable en el POS (2026-06-08, PRs #227/#229): Edge Functions `modo_create_qr` + `modo_webhook`, **gating real** por plan, sin botón de cuotas y **conexión de credenciales** desde Medios de pago. **Dialecto REAL implementado y verificado estructuralmente** (2026-07-10): token `POST {base}/middleman/token {username,password}` → `accessToken`, intención `POST {base}/ecommerce/payment-intention`, estado por GET — confirmado contra el SDK del plugin oficial de WooCommerce ("paga-con-modo"); preprod/producción por el switch Sandbox (`merchants[.preprod].playdigital.com.ar/merchants`). Polling server-side (action `status`) en lugar del webhook por intención (MODO usa webhook account-level, mejora futura). Form de conexión con las credenciales reales (Username/Password + Store ID y Processor code opcionales). **Bloqueado en la última milla:** las credenciales QA de NOVOGAR (email de MODO) devuelven 401 en `/middleman/token` de preprod — requiere activación/whitelisting del lado de MODO (comercios@modo.com.ar); con credenciales válidas el cobro corre sin tocar código.*
  - [~] **H17** — **Payway / Prisma**. — *Transaccionable por Formulario de pago hosted (2026-07-10, ADR-029): Edge `payway` (create → `checkout-payment-button/link`, status → `GET /api/v2/payments/{id}` con verificación de monto en centavos) + `payway_webhook` (re-verifica contra la API, nunca acredita a ciegas; GET sirve la pantalla de retorno del cliente). Botón "Cobrar con link · Payway" en el POS, conexión por API Key pública/privada + Nº de comercio, **sandbox público de Payway/Decidir** vía el switch Sandbox. Dialecto del SDK oficial `payway-ar/sdk-node-ventaonline`. **Validado E2E contra PRODUCCIÓN con credenciales reales del comercio (2026-07-10):** el create devuelve `payment_link` (`live.decidir.com/web/checkout/{hash}`); quirks del validador documentados en la Edge (URLs ≤ ~100 chars y de UN solo query param → correlación por prefijo corto `?i=`); la confirmación llega por webhook re-verificado + poll. **H17b — Checkout PROPIO de la tienda (2026-07-10):** el QR de Payway abre `/pagar/{intent}` de la app — página pública con la marca del negocio (logo/acento de `tenant_branding`), selección de tarjeta y cuotas de los Planes del negocio (recargo en vivo) y form de tarjeta; el PAN viaja del navegador directo a Payway (tokens con API Key pública) y el cobro corre server-side con monto RECALCULADO (Edge `payway_checkout`, centavos, `payment_method_id` por marca). La venta se registra por el total final (recargo como extra). Rechazos del emisor dejan reintentar con otra tarjeta. Primer cobro pagado E2E pendiente de una tarjeta real.*
  - [~] **H18** — **Getnet**. — *Canal QR + link implementado (2026-10-11, ADR-031): Edge `getnet` (create → orden `POST /api/v2/orders` del Checkout de Geopagos con token OAuth2 `client_credentials`, status → `GET /api/v2/orders/{uuid}`) + `getnet_webhook` (verify_jwt false; re-consulta la orden con el token del tenant, acredita sólo APPROVED/PROCESSED/SUCCESS con monto exacto, idempotente). Checkout hosted como QR + link en `QrCheckoutModal` (provider `getnet`), conexión por Client ID + Client Secret. Dialecto del plugin oficial de WooCommerce de Getnet AR. **Sin sandbox AR:** falta el primer cobro real chico para confirmar los campos inferidos (uuid y monto en el GET, estados de rechazo). Tender cableado en el POS (`lib/pos/tenders.ts`: QR, link y checkout propio). **Getnet Point** sigue "Próximamente" (integración de terminales probablemente sólo para partners). **2026-10-12 (ADR-069):** dos juegos de credenciales (Web Checkout para QR y link, Checkout API para el checkout propio) con prueba por slot y aviso de credencial en el lugar equivocado; checkout propio `/pagar?p=getnet` con la Checkout API y Edge `getnet_checkout`, tender "Link (checkout propio)" y feature `getnet_checkout_propio`. **Bloqueado por PCI:** Getnet no tokeniza desde el navegador; el cobro queda apagado hasta la validación PCI DSS o hasta pasar a iframe de Web Checkout.*
  - [~] **H19** — **Fiserv / Posnet / Clover**. *Clover Point integrado en código (ADR-047, Edges `clover_point` y `clover_webhook`) y base de terminal integrada con adaptador Fiserv (ADR-053, `lib/payments/terminal/adapters/fiserv.ts`). Falta Posnet integrado (H19e) y el primer cobro real.*
  - [~] **H20** — **Mobbex** como **orquestador** (abstrae varios proveedores; opcional según convenga). — *Cobro por QR funcionando con cuenta real (validado 2026-06-04): conexión por API Key + Access Token, checkout hosted → QR, planes del grid (cuotas + interés) aplicados en el checkout de Mobbex (`installments`), webhook actualiza el intent y la venta se registra. Edge Functions `mobbex_create_qr` + `mobbex_webhook`. Conciliación básica en el modal "Cobros QR" de /ventas.*
  - [~] **H21** — **Pagos360** (links de pago / cobranzas). — *Transaccionable (2026-07-10, ADR-028): Edge `pagos360` (create/status), botón "Cobrar con link · Pagos360" en el POS, checkout hosted como QR + link, conexión por API Key, soporte de **sandbox de Pagos360** vía el switch Sandbox del medio, conciliación compartida en "Cobros QR". Sin webhook: el POS sondea y la Edge sincroniza contra la API (sólo acredita con `state=paid` + monto exacto). Falta validar con cuenta real/sandbox propia (patrón H16).*
  - [~] **H21c** — **Nave (Banco Galicia)** (QR interoperable + link y Nave Point). — *Integrado en código (2026-10-11, ADR-030): Edge `nave` (payment_request ecommerce → `qr_data` + `checkout_url`, status de respaldo, cancel), Edge `nave_point` (smart_pos a la terminal del `pos_id`, devices/status/cancel) y `nave_webhook` (valida host Nave anti-SSRF, re-consulta el pago con el token del tenant, acredita sólo APPROVED + monto exacto, idempotente). Auth client_credentials (apinaranja) con 401 → re-auth. Conexión única en Medios de pago (Client ID/Secret, punto de venta, terminales Point, Producción/Prueba, URL de notificaciones para Nave); Nave Point la reutiliza. `QrCheckoutModal`/`PointCheckoutModal` soportan `nave`/`nave_point`; tenders QR, link y Point cableados en el POS (`lib/pos/tenders.ts`). Gating server-side `nave`/`nave_point`. Falta: deploy de las Edge y validar con credenciales sandbox del comercio (pos_id de prueba + URL de notificaciones registrada por Nave).*
  - [~] **H21d** — **GO Cuotas** (cuotas sin interés con débito, QR + link). — *Integrado en código (2026-10-11, ADR-033): Edge `gocuotas` (create → `POST /api_redirect/v1/checkouts` con `order_reference_id` = intent y `webhook_url` por intent, `url_init` como QR + link; status re-consulta la orden; cancel = baja local) y `gocuotas_webhook` (verify_jwt false; nunca confía en el cuerpo: re-consulta con la API Key del tenant, acredita sólo approved + referencia propia + monto exacto en centavos, idempotente; GET = pantalla neutra de retorno). Auth con la API Key de la sucursal como Bearer; sandbox/producción por el switch del medio (`mp_env` en el intent). Mínimo $1.500 con copy claro. `QrCheckoutModal` soporta `gocuotas`; form standalone `GoCuotasConnectForm`. Feature `gocuotas` desde Pro, gating server-side. Tender QR y link cableado en el POS (`lib/pos/tenders.ts`) y conexión en Medios de pago (`ConnectProviderModal`). Falta: aplicar la migración `20261011180000_gocuotas_directo`, deploy de las Edge y validar con API Key de prueba de una sucursal real.*
  - [~] **H21e** — **Directo** (Crédito Directo S.A.) como **tender manual**. — *Implementado (2026-10-11, ADR-034): sin API pública; el cajero cobra en el portal de comercios de Directo (QR o link) y en el POS elige "Directo (crédito)" y carga el número de operación (obligatorio). `payments.method = 'directo'` con `reference` = Nº de operación (constraint), gating coarse por `payment_method_plan_key('directo')`. Feature `directo` desde Pro. Bloque informativo `DirectoInfo` para Medios de pago. `DirectoInfo` cableado en Medios de pago (`PaymentMethodsCard`). Directo sí tiene API: canal QR y link con respaldo manual (ADR-041, Edges `directo` y `directo_webhook`). Falta: aplicar las migraciones y validar en QA.*
  - [ ] *Criterio por proveedor:* cobro real en sandbox + conciliación + manejo de error sin bloquear la venta.

- [~] **H21b — Orquestador de pagos estilo VTOL.** *Sólo la conciliación tiene base (ver abajo); router, estado central y monitoreo pendientes.*
  - [ ] Router de pagos por proveedor/adquirente/terminal/canal con prioridad, fallback y reglas de ruteo.
  - [ ] Estado central de transacciones: iniciada, autorizada, capturada, rechazada, reversada, anulada, conciliada, en disputa.
  - [~] Conciliación automática por lote, cupón, autorización, terminal, adquirente y liquidación. *Base: conciliación de tarjetas por día, n° de comercio y lote (ADR-044, `/reportes/conciliacion`) y de procesadores, automática con Mercado Pago y por archivo para adquirentes (ADR-061, Edge `settlements`). Falta liquidación automática para el resto de los adquirentes.*
  - [ ] Monitoreo de terminales, alarmas de caída, reintentos seguros y recuperación automática.
  - [ ] Trazabilidad por transacción y auditoría completa sin guardar datos sensibles de tarjeta.
  - [ ] *Criterio:* si un proveedor falla, el POS ofrece fallback autorizado y la operación queda conciliable sin duplicar cobro.

#### F8 · Points (terminales integradas): estado 2026-10 (ADR-047)

> Subsección propia de la rama `feat/fiserv-clover-point` (para mergear sin pisar otras ediciones del roadmap). Relevamiento completo: [`docs/payments/research-points-2026-10.md`](payments/research-points-2026-10.md).

- [~] **H19 · Clover Point (Fiserv).** *Integrado en código (2026-10-12):* canal `fiserv_point` (marca Fiserv, OPTIONAL desde Business, `requires: fiserv`), Edge `clover_point` (devices/ping/create/status/cancel por Cloud Pay Display, centavos, Idempotency-Key, consulta por externalPaymentId) y `clover_webhook` (`--no-verify-jwt`, re-consulta, nunca confía en el cuerpo). Conexión Fiserv (Merchant ID + token, refresh opcional, series de terminales, Prueba/Producción). `fiserv` pasa a canal manual (Posnet o Clover sin integrar). **Bloqueos:** (1) cuenta de desarrollador global + comercio de prueba AR + Dev Kit o emulador (lo hace Lucas); (2) confirmar con Fiserv/Clover que Cloud Pay Display está habilitado en producción AR (los docs se contradicen); (3) app aprobada para tokens de producción (`CLOVER_APP_ID`). **Pasos:** aplicar `20261013300000_fiserv_clover_point`, deploy de las 2 Edges + `set_payment_secret` (sin cambios), primer cobro en sandbox, webhook opcional.
- [ ] **Payway Point.** Próximamente. **Bloqueo:** Payway no publica una API para mandar cobros a la terminal (sólo reversas y cierres PayStore). **Paso:** pedir al ejecutivo de Payway el kit de integradores (API de terminales, homologación PayStore, SDK Terminal Smart).
- [ ] **Getnet Point.** Próximamente. **Bloqueo:** Cloud2Cloud de "Integrated POS" es para partners y no está confirmado en Argentina. **Paso:** contactar Partnerships de Getnet AR y pedir disponibilidad y credenciales.
- [x] **Descartados como Point** (sin terminal propia o sin API): Mobbex, MODO, Ualá Bis, Viumi, Naranja X (cubierto por Nave), Posnet/LaPos legacy (protocolo local), Cuenta DNI, Personal Pay.

#### F8 · Terminal integrada: posnet y pinpad por cable o red (ADR-053)

> Relevamiento: [`docs/payments/terminal-integrada-payway.md`](payments/terminal-integrada-payway.md) y [`terminal-integrada-getnet.md`](payments/terminal-integrada-getnet.md).

- [~] **H19b · Base de terminal integrada.** *En código (2026-10-12, `feat/terminal-integrada-payway`):* Web Serial, WebUSB y puente local (`tools/bridge`), simulador, máquina de estados, kinds `posnet_integrado` / `pinpad` por caja, Conectar y venta de prueba, "Tarjeta en terminal" en el cobro, bitácora `terminal_transactions` y validación del cupón en `payments`. Feature `terminal_integrada` (Pro+). **Paso:** aplicar `20261018100000_terminal_integrada`.
- [~] **H19c · Payway posnet integrado y pinpad.** Adaptador VPI implementado según fuentes públicas no oficiales (`unverified`). **Bloqueo:** especificación oficial, modelos y VID/PID, tabla de códigos de tarjeta, protocolo del Lane/3000 y homologación. **Paso:** pedirlo a Payway con la lista del relevamiento §7 y probar con una Classic en modo integrado. *Código: `lib/payments/terminal/adapters/payway.ts` sobre la base de ADR-053, sin validar con equipo real.*
- [ ] **H19d · Getnet integrado.** Placeholder. **Bloqueo:** protocolo de la librería (USB / HTTP) o API de Cloud2Cloud. **Paso:** lista "Qué pedirle a Getnet".
- [ ] **H19e · Fiserv Posnet integrado.** Placeholder. **Bloqueo:** especificación de la aplicación TRANSACT.
- [ ] **H19f · Operaciones desde Ventas y Caja:** anulación y devolución con la terminal, cierre de lote con totales y conciliación automática (ADR-044) con la bitácora. Requiere H19c.
- [ ] **H19g · Instalador del puente local** (servicio de Windows, emparejamiento con código corto).

#### F8 · Cobros en espera y QR más rápido (ADR-048)

- [~] **H21f · Cobros en espera.** *Integrado en código (2026-10-12, rama `feat/cobros-en-espera`):* compartir el QR o link (sistema, WhatsApp, email del servidor con el diseño del negocio, copiar, SMS) y "Dejar en espera": la venta queda en `pending_charges` y se registra sola del lado del servidor al acreditarse (trigger sobre `mp_payment_intents`, idempotente), con aviso en el POS (imprimir ticket o factura) y en la campana. Pestaña propia en el POS y en Operación (filtros, sucursal, detalle con línea de tiempo, cancelar, editar en el POS, reenviar, extender, regenerar, reintentar). Cierre de caja con decisión obligatoria (cancelar o pasar a la próxima apertura). Feature `cobros_en_espera` (Pro+). **Pasos:** aplicar `20261014100000_cobros_en_espera`, deploy de `pending_charge_share` y `pending_charges_sync` (y de las Edges de cobro tocadas), probar en sandbox con Mercado Pago (link) y Pagos360 (sin webhook). **Pendiente:** Realtime en vez de sondeo, factura electrónica desde el aviso (F3), "visto por el cliente" (los proveedores no lo informan).
- [~] **H21g · QR más rápido.** Prechecks en una ronda y intent en paralelo con el proveedor en `mp_qr`, `mp_create_qr`, `pagos360` y `modo_create_qr` (token de MODO cacheado), planes y modo del medio pasados por la hoja (sin dos consultas antes de pedir el QR), precalentado de Edges al abrir la hoja y link directo cuando MP no tiene caja QR. Tiempos por etapa en el log y `Server-Timing`. **Pendiente:** medir antes y después en producción con esos logs; mismo patrón en `mobbex_create_qr`, `payway`, `getnet`, `nave`, `gocuotas` y `directo`.

#### F8 · Devolución de dinero por el medio original

- [~] **H21h · Reintegro por Mercado Pago al hacer una devolución.** *(pedido de Lucas, 2026-10-12)* *Integrado en código (2026-10-12, rama `feat/reintegro-mp-cliente360`, ADR-067): `return_sale_v2` con pata MP, Edge `mp_refund`, respaldo en efectivo o vale, PIN `reintegro_mp`, ajuste del dueño, "Devuelto (POS)" en la conciliación. **Pasos:** aplicar `20261030100000` y `20261030100100`, deploy de `mp_refund` (verify_jwt = true), probar en sandbox de MP una devolución parcial de QR, de link y de Point. **Pendiente:** id de la devolución de MP impreso en el comprobante; Payway y otros medios.* Si la venta se cobró con Mercado Pago (QR, link o Point), al devolver se puede reintegrar el dinero **al mismo medio que usó el cliente** (tarjeta o dinero en cuenta) por la API de reembolsos de Mercado Pago, además de efectivo o vale como hoy.
  - [x] **Activable por el dueño** en Configuración → Medios de pago → Mercado Pago ("Permitir devolver el dinero por Mercado Pago"), apagado por defecto. Feature de plan con gating server-side (checklist de features de CLAUDE.md). *(`reintegro_mp` OPTIONAL desde Pro; `mp_refund_settings_save` sólo del dueño)*
  - [x] En el wizard de devolución (`ReturnModal`) aparece "Devolver a la tarjeta / cuenta de Mercado Pago" sólo si el pago original fue por MP, está aprobado y dentro del plazo que permite MP. Reintegro **total o parcial** (por el importe de los ítems devueltos), nunca mayor a lo cobrado por ese pago menos lo ya reintegrado.
  - [x] Ejecución en una Edge Function (token del negocio, nunca en el front): llamada idempotente al reembolso, guarda el id y estado del refund, y queda en `audit_logs`. La devolución en el sistema (`return_sale_v2`) se registra con medio "Mercado Pago" y referencia al refund.
  - [~] Permiso por rol (el cajero puede necesitar autorización del encargado o PIN de supervisor), motivo obligatorio y comprobante de devolución con el dato del reintegro. *(PIN `reintegro_mp` y motivo hechos; el comprobante dice "Mercado Pago" pero todavía no imprime el id de la devolución de MP)*
  - [x] Errores honestos: saldo insuficiente en la cuenta MP, plazo vencido, pago en disputa o ya reintegrado. En esos casos se ofrece efectivo o vale.
  - [x] Conciliación: el reintegro aparece en el detalle del pago, en el historial del cliente (H31b) y en la conciliación de Mercado Pago.
  - [ ] Después: mismo patrón para Payway y otros medios con API de devolución.
  - [ ] *Criterio:* una venta cobrada con QR de MP se devuelve parcialmente desde el wizard, el cliente ve el reintegro en su tarjeta o cuenta, y la devolución queda con el id del refund, auditada y conciliada.

### F10 — Hardware y mostrador PRO

Objetivo: que el POS opere como sistema de mostrador profesional: impresoras configurables, scanners confiables, periféricos por caja/sucursal y segunda pantalla para el cliente. Todo debe ser configurable por tenant, sucursal, caja y perfil de dispositivo.

- [~] **H22 — Configuración avanzada de impresión.** — *Buildable por tenant hecho (2026-06-08, PR #262): config por TIPO DE DOCUMENTO (formato, copias, auto/manual) en Configuración → Impresión, respetada por el POS al cobrar, en Caja (Z) y en Devoluciones. Perfiles por sucursal y caja con impresora asignada hechos (ADR-049, `lib/print/printers.ts`). Faltan ESC/POS directo y cola.*
  - [x] Perfiles de impresión por **tenant / sucursal / caja**: ticket 58mm, ticket 80mm, A4, etiqueta, cocina/comanda, comprobante interno. — *Por **tenant** hecho (formato 58/80/A4 por tipo, según aplique). Sucursal y caja: `print_profiles` heredable por `config_overrides` con impresora y respaldo por documento, incluidos comanda y remito (ADR-049, `lib/print/profiles.ts`).*
  - [x] Selector de destino por tipo de documento: ticket de venta, cierre Z, movimiento de caja, etiqueta de producto, comanda, devolución, nota de crédito futura. — *5 tipos configurables (ticket de venta, cierre Z, movimiento de caja, etiqueta de producto, devolución/NC) en `pos_settings.print_profiles` (migración `20260608470000_print_profiles`). Comanda → F13.*
  - [~] Plantillas con variables: logo, datos fiscales, QR, leyendas legales, redes, promociones, cajero, caja, sucursal, medios de pago. — *Ya resuelto por el editor de plantillas de H9b (`ticket_templates`, modos bloques/canvas/HTML con variables). H22 elige formato/copias/auto sobre esa plantilla activa, sin duplicarla.*
  - [~] Márgenes, tamaño de fuente, densidad, cantidad de copias, corte de papel, apertura de cajón, impresión automática o manual. — *Copias (1..20), impresión automática vs manual, y ajustes básicos de **fuente y margen** por tipo. Densidad y corte de papel requieren ESC/POS → F4. Apertura de cajón por pulso ESC/POS directo a la térmica: ADR-063.*
  - [x] Web print nativo: `window.print()` para navegador, A4 y fallback universal. — *La impresión es web; las copias se imprimen llamando a `window.print()` N veces (`lib/print/webPrint.ts`).*
  - [~] ESC/POS por conector local: app/servicio local para térmicas USB/LAN/Bluetooth cuando el browser no alcanza. — *F4 (documentado en la UI de Impresión y en `lib/print/profiles.ts`).* *Conector local `tools/bridge` (ADR-053) ya manda ESC/POS para el pulso del cajón por serie o red 9100 (ADR-063, `lib/hardware/devices.ts`). Falta imprimir tickets por ESC/POS.*
  - [~] QZ Tray / WebUSB / WebSerial evaluados por compatibilidad. — *F4.* *WebUSB y WebSerial evaluados y en uso para terminal integrada, balanza y cajón (ADR-053, ADR-063, `lib/hardware/capabilities.ts`). QZ Tray sin evaluar.*
  - [ ] Cola de impresión con reintentos: pendiente, impreso, fallido, reimprimir, cancelar. — *F4 (documentado como límite del web print).*
  - [~] *Criterio:* un tenant configura ticket 80mm para caja principal, etiqueta 58mm para productos y cierre Z A4; cada documento sale por su destino correcto. — *Cumplido a nivel **tenant** (formato + copias + auto/manual por tipo, aplicado en venta/Z/devolución). "Por caja" queda para F4.* *Por caja: impresora y perfil por documento heredables (ADR-049); la salida sigue siendo web print, falta que salga sola a la impresora.*

- [~] **H23 — Scanners y captura de códigos PRO.** — *Base (PR #80) + perfil/beep/anti-dup/diagnóstico (2026-06-07) + etiquetas de balanza (ADR-063, `feat/balanza-cajon`). Quedan: QR de pago/fidelización.*
  - [x] Soporte para lector USB HID tipo teclado y Bluetooth (`useScanner`: captura global de teclado por velocidad de tipeo + Enter, sin foco previo), cámara (`BarcodeDetector`) y entrada manual (búsqueda).
  - [~] Perfiles de scanner por caja: prefijo/sufijo, Enter automático, delay entre caracteres, normalización de EAN/UPC/Code128/QR. — *Perfil por tenant hecho (prefijo/sufijo/anti-dup en Configuración → Escáner); por caja → F4. Formato inferido EAN/UPC/QR en diagnóstico.*
  - [x] Modo continuo en POS: lectura sin tocar mouse (escaneo en cualquier parte agrega al carrito), **beep de confirmación** y **anti-duplicado** configurable. — *useScanner v2 (2026-06-07).*
  - [x] Producto por SKU/barcode (`productsApi.findByCode`).
  - [ ] QR de pago.
  - [ ] QR de cliente/fidelización.
  - [x] Etiquetas internas de balanza/precio-peso. · *ADR-063: `lib/barcode/scaleLabel.ts` decodifica EAN-13 con prefijo 20-29, código de 4 a 6 dígitos, precio o peso embebido, decimales, DV del EAN y DV del valor (GS1); formato por negocio o sucursal (`pos_settings.scale_label`, heredable). El escáner del POS lo intercepta antes de la búsqueda común y agrega la línea pesada (PLU o SKU). Tests `tests/unit/scaleLabel.test.ts`.*
  - [x] Diagnóstico de scanner: pantalla de prueba que muestra caracteres recibidos, tiempos y formato detectado. — *Configuración → Escáner: últimas 10 capturas con código/crudo/largo/duración/gap/formato/duplicado (2026-06-07).*
  - [ ] *Criterio:* un lector USB escanea 100 productos seguidos sin perder foco ni duplicar lecturas; un móvil usa cámara como fallback.

- [~] **H24 — Etiquetas, códigos y balanzas.** — *Generador + impresión por lote hechos (PR #79). Balanza: etiquetas y lectura en vivo por Web Serial o puente local (ADR-063, `feat/balanza-cajon`); presets de marca sin validar con el equipo.*
  - [x] Generador de etiquetas de producto con nombre, precio y código de barras (Code 39 sin dependencias, SVG). Variantes pendientes (cruza con F6/H10).
  - [x] Impresión por lote: selección de productos + cantidad de copias por producto, vista previa y `window.print()` (página `/etiquetas`, hoja `ticket-print`). Hasta 200 copias por producto.
  - [x] Soporte para etiquetas de balanza: parsing configurable de código con precio o peso embebido. · *ADR-063 (ver H23).*
  - [~] Lectura de balanza en vivo (Web Serial o puente local) con peso estable, tara y simulador. · *ADR-063: `lib/hardware/scale/*` + `lib/hardware/devices.ts` (`ScaleReader`, `ScaleSimulatorTransport`), balanza por caja en `register_hardware`, peso en vivo en el editor de peso del POS (completa los gramos con el peso estable). Presets Systel, Kretz y Moretti marcados "sin validar": falta probarlos con equipos reales.*
  - [x] WebSerial para balanzas compatibles cuando aplique; fallback por código de barra de balanza. *ADR-063: Web Serial o puente local (`lib/hardware/scale/protocols.ts`, `lib/hardware/devices.ts`) y fallback por etiqueta de balanza (`lib/barcode/scaleLabel.ts`).*
  - [x] *Criterio (impresión):* el negocio selecciona productos e imprime un lote de etiquetas con nombre/precio/código sin tocar código. *(Balanza queda pendiente.)*

- [~] **H25 — Doble pantalla / display cliente.** — *Pantalla web del cliente sincronizada en tiempo real hecha (PR #260). Falta solo el modo hardware (display serial/USB de 2 líneas) y el branding por sucursal (multi-store → F4).*
  - [x] Ventana secundaria del navegador: el cajero abre una pantalla cliente en otro monitor (`/customer-display`), sincronizada por BroadcastChannel/local storage o Realtime. — *PR #260: ruta `app/(display)/customer-display`, hook `lib/pos/customerDisplay.ts` (`BroadcastChannel('ninja-customer-display')` + respaldo localStorage `storage`), botón “Pantalla cliente” en el POS (`window.open`).*
  - [x] Display cliente dedicado: tablet/celular en la misma caja mostrando carrito, total, promociones y QR de pago. — *Misma ruta `/customer-display`: se abre en la tablet de la caja (misma sesión/origen) y se sincroniza por el broadcast.*
  - [ ] Modo hardware futuro: integración con display serial/USB de dos líneas para importes básicos.
  - [x] Nombre del negocio y caja en pantalla cliente. — *PR #260: logo + nombre (de `tenant_branding`) y nombre de caja (`cash_registers.name`) en el encabezado.*
  - [x] Ítems del carrito en vivo. — *PR #260: el POS publica el carrito (Zustand) en cada cambio; la pantalla lo renderiza sin recargar.*
  - [x] Subtotal, descuentos, total y vuelto. — *PR #260: totales grandes a distancia; el vuelto (efectivo) se muestra en la pantalla “Pago recibido”.*
  - [x] QR de Mercado Pago/MODO cuando aplique. — *PR #260: `QrCheckoutModal` reporta `init_point` + monto vía `onQrState`; la pantalla muestra el QR + importe (MP/MODO/Mobbex).*
  - [x] Mensaje final: “Pago recibido”, “Gracias”, promoción o invitación a fidelización. — *PR #260: pantalla “Pago recibido ✓” + mensaje de agradecimiento configurable, luego vuelve a idle.*
  - [x] Configuración por tenant: ~~tema~~, logo, mostrar/ocultar precios unitarios, ~~banners~~, idle screen, ~~idioma~~. — *PR #260: `pos_settings.display_show_unit_prices` + `display_welcome_message` (idle) + `display_thanks_message`; logo/acento de `tenant_branding`. Sección “Pantalla del cliente” en Configuración. (Tema/banners/idioma → fuera de alcance de este PR.)*
  - [x] Seguridad: nunca mostrar datos sensibles del cajero, panel interno, tokens ni información privada de otros clientes. — *PR #260: la ruta exige sesión del tenant (layout `(display)` redirige a /login); el payload solo lleva la venta en curso; el canal es same-origin/same-device; RLS de `tenant_branding`/`pos_settings` ya vigente.*
  - [x] Limitación técnica documentada: el navegador no puede controlar monitores como una app nativa; el flujo robusto es abrir una URL de display cliente y mantenerla sincronizada. — *PR #260: documentado en `lib/pos/customerDisplay.ts` y en la sección de Configuración (abrir la ventana, arrastrarla al 2do monitor, F11 para fullscreen).*
  - [x] *Criterio:* el cajero cobra en el POS y el segundo monitor/tablet muestra carrito, QR y total en tiempo real sin recargar. — *PR #260.*

- [x] **H26 — Centro de diagnóstico de hardware.** — *Completo (2026-06-08, PR #261): sección "Diagnóstico de hardware" en Configuración (+ ruta directa `/configuracion/hardware`) con tarjeta por periférico, estado claro (ok / no disponible / requiere conector / advertencia) con íconos, pruebas guiadas, log local y export. 100% client-side (detección + pruebas; persistencia en localStorage, sin migración). Honestidad total sobre los límites del navegador.*
  - [x] Pantalla `/configuracion/hardware` con estado de impresoras, scanners, pantalla cliente, cajón y balanza. — *`HardwareCard` (`components/dashboard-team/HardwareCard.tsx`); ruta `app/(app)/configuracion/hardware/page.tsx` redirige a la sección. Una tarjeta por periférico con badge de estado.*
  - [x] Pruebas guiadas: imprimir ticket de prueba, abrir cajón, probar scanner, probar display cliente, probar balanza. — *Impresora: render oculto del ticket de muestra + `window.print()` (web print, reusa `TicketRenderer`/`ticket-print`). Escáner: captura en vivo con `useScanner` (mismo motor del POS, últimas lecturas con código/largo/ms/formato/duplicado). Pantalla cliente: "Abrir pantalla de prueba" (`window.open('/customer-display')`) + "Probar sincronización" (round-trip real de `BroadcastChannel`). Cajón y balanza: pruebas por caja con su configuración efectiva (ADR-063): "Abrir cajón de prueba" pasa por el servidor y manda el pulso ESC/POS; "Probar balanza" muestra peso, estabilidad, tara y la trama cruda.*
  - [x] Logs locales de hardware y errores legibles para soporte. — *`lib/hardware/diagnosticsLog.ts`: cada prueba registra qué/cuándo/resultado/detalle en `localStorage` (máx 100), listado legible con color por resultado. Sin datos sensibles.*
  - [x] Export de diagnóstico para NinjaSoft. — *`lib/hardware/export.ts`: "Exportar diagnóstico" baja XLSX (reusa `exportXlsx`: hojas Resumen/Capacidades/Entorno/Pruebas) o JSON, con tenant/caja, capacidades reales del navegador (BroadcastChannel, WebUSB, WebSerial, Web Bluetooth, BarcodeDetector, web print), entorno (userAgent, pantalla/resolución, origen seguro, etc.) y el log. **Sin tokens ni datos de clientes** (test lo verifica).*
  - [x] *Criterio:* soporte puede pedir “Exportar diagnóstico” y ver qué periférico falla sin conectarse a la máquina del cliente. ✓ — *Tests en `tests/unit/hardwareDiagnostics.test.ts`.*

### F3 — AFIP (robustecida, se ejecuta al final de esta tanda)

Alcance robustecido: ver [F3](#f3--integración-afip-y-producción) y [`15-afip-integration.md`](./15-afip-integration.md). Se prioriza **después** de F6–F8/F10/F11/F12/F13 (requiere certificados por tenant, homologación, tickets/comprobantes configurables, medios de pago y flujos de devolución/cambio/servicios/gastronomía definidos).

---

### F11 — Configuración retail avanzada

Objetivo: cubrir configuraciones de retail profesional inspiradas en POS líderes: formas de pago con recargos, garantías extendidas, devoluciones/cambios, cuenta corriente, pedidos de salón, despacho, depósitos, roles propios e importación masiva por Excel.

- [x] **H27 — Medios de pago configurables + recargos.** — *Planes con recargo % por base/marca/cuotas, **scopeados a cada medio conectado** (`payment_plans.provider_key`). En Configuración → Medios de pago, cada medio de tarjeta/QR conectado (ej. Mercado Pago) tiene su botón **Planes** que abre un grid visual: secciones Débito/Crédito, una fila por marca con su logo, celdas de recargo % por cuota (vacía = no se ofrece). Marcas y cuotas configurables por medio (`tenant_payment_methods.config`). Seeder "Cargar planes AR" + import/export XLSX (import pregunta reemplazar/agregar). Al cobrar, el plan elegido reemplaza el recargo global del medio. **Vigencia por plan y voucher de tarjeta completados (PR #266).***
  - [x] Medios de pago visibles al cobrar (efectivo, transferencia, débito, crédito, QR, vale).
  - [x] Variantes con recargo automático: "Visa 3 cuotas +8%" (`payment_plans.surcharge_pct`).
  - [x] Planes de financiación AR por tarjeta/marca/cuotas **con vigencia**. — *`payment_plans.valid_from`/`valid_until` (date, null = sin límite). Editable en el grid del medio (campaña de financiación: ventana aplicada a todos los planes). Al cobrar, sólo se ofrecen los planes vigentes hoy (`valid_from <= hoy` y `valid_until null o >= hoy`); el helper `isPlanActive` espeja `isDiscountActive`. PR #266.*
  - [x] Recargo agregado al total del ticket (entra como ítem "Recargo …").
  - [x] Configuración de voucher obligatorio para tarjeta: lote, cupón, autorización. — *Flag `pos_settings.require_card_voucher` (Configuración → Operación). Activo + medio débito/crédito → el POS exige los 3 campos al confirmar; se guardan en `payments.card_voucher` (jsonb) vía `create_sale` y se muestran en el detalle de la venta (/ventas → Ticket). PR #266.*
  - [x] *Criterio:* el cajero elige "Visa 3 cuotas +8%" y el ticket suma el recargo automáticamente. — *Cumplido: el plan vigente elegido suma el recargo como ítem "Recargo …"; los planes fuera de vigencia no se ofrecen.*

- [x] **H28 — Garantías extendidas.** — *Garantía de fábrica por producto + planes de garantía extendida + oferta al cobrar (prima como línea) + **oferta contextual automática** + reporte de garantías/comisiones. (Completado 2026-06-08, PR #264.)*
  - [x] Campo "garantía de fábrica" por producto (`warranty_months`).
  - [x] Planes de garantía extendida por tenant: meses, prima fija **o % del precio**, comisión y descripción (`warranty_plans`). Configurable completo en **Configuración → Garantías** (y acceso rápido en Productos → Garantías).
  - [x] Oferta al cobrar: en el POS se elige un plan de garantía y la prima entra como línea de la venta.
  - [x] **Oferta contextual automática (al cobrar un producto con garantía declarada).** — *`WarrantyOfferCard` en el carrito del POS: detecta productos con `warranty_months > 0` (la garantía viaja a la línea del carrito) y ofrece los planes activos del tenant con su prima; al elegir uno, **pre-selecciona** la garantía y la prima entra como línea vía el mecanismo existente (PaymentModal + extras `kind:'warranty'`, sin duplicar). Descartable, no frena al cajero; si hay varios elegibles ofrece sobre el de mayor importe. Flag `pos_settings.offer_warranty` (Configuración → Operación) para des/activar. PR #264.*
  - [x] Planes de garantía extendida por tenant: meses adicionales, prima (% del precio) y comisión del vendedor. — *Por tenant (no hay scoping por categoría/producto; aplicabilidad honesta: `warranty_months > 0` habilita los planes del tenant).*
  - [x] Oferta contextual al cobrar productos con garantía declarada. — *Ver `WarrantyOfferCard` arriba (PR #264).*
  - [x] Prima agregada al ticket como línea/servicio asociado. — *Entra como ítem "Garantía &lt;plan&gt;" en la venta (reusa el flujo de extras del cobro).*
  - [x] Reporte de garantías vendidas y comisiones (Reportes → "Garantías y comisiones": agrupa las líneas "Garantía …" por plan, cruza con `warranty_plans.commission_pct` y muestra cantidad/total/comisión; incluido en el export XLSX).
  - [x] *Criterio:* al cobrar un producto con garantía de fábrica, el POS ofrece planes aplicables y registra prima/comisión. — *Cumplido (PR #264): la oferta contextual aparece sola, la prima entra como línea y el reporte Garantías y comisiones la agrupa por plan con su comisión.*

- [x] **H29 — Devoluciones, cambios y vales.** — *Devolución parcial hecha (RPC `return_sale` + `ReturnModal` en /ventas) + **rediseño premium por pasos** (2026-06-08, PRs #221/#243): política, motivos con destino de stock, **vales con código y validez**. Redención del vale en el POS y **cambio con diferencia a cobrar** (PR #265) completos.*
  - [x] Política de devolución: el cajero elige caso a caso reintegro en efectivo o vale. — *Rediseñada en flujo por pasos (PR #221; migración `returns_overhaul`).*
  - [x] Vigencia configurable del vale/saldo a favor. — *Vales con **código** y **validez** (PRs #221/#243).*
  - [x] Motivos configurables (tabla `return_reasons`, gestión owner/manager desde /devoluciones → Motivos; dropdown en la devolución + "Otro").
  - [x] Destinos de stock por línea: vuelve a stock / a revisión / descarte (revisión y descarte no reponen).
  - [x] Wizard de devolución con trazabilidad y reintegro por efectivo o vale. **Cambio con diferencia a cobrar** hecho: modo "Cambio" en `ReturnModal` (devolver ítems → motivo/destino de stock → llevar productos nuevos → cobrar la diferencia >0 o reintegrar el sobrante <0 en efectivo/vale según política). RPC atómico `exchange_sale` (migración `20260608490000_exchange_sale`) orquesta `return_sale_v2` + `create_sale` en una transacción auditada, reusando la lógica de stock/saldo/gating (PR #265).
  - [x] **Búsqueda de venta en el histórico** (/ventas): por N° de comprobante / ticket (formato personalizado o correlativo).
  - [x] **Sección dedicada de Devoluciones** (`/devoluciones`): buscar la venta por **ticket / N° de comprobante** y arrancar la devolución desde ahí (reusa ReturnModal).
  - [x] **Redención del vale en el POS**: medio de pago "Vale (saldo a favor)" cuando el cliente tiene saldo que cubre el total; `create_sale` valida saldo y descuenta de `store_credit_movements`.
  - [x] *Criterio:* devolución parcial con destino de stock por línea, auditada; sección de devoluciones con búsqueda; redención del vale en el POS; y **cambio con diferencia** (devolver A, llevar B más caro → diferencia cobrada; B más barato → sobrante a efectivo o vale) — todo atómico y trazable vía `exchange_sale` (PR #265).

- [~] **H30 — Settings operativos del POS.** — *Hecho salvo señas (→ H32): tabla `pos_settings` + Configuración → Operación del POS (solo dueño). `create_sale` aplica descuento máximo por rol, redondeo y bloqueo de stock negativo (con override por producto); `close_cash_shift` exige motivo por tolerancia; SKU automático; selector de cliente en el POS + requerir cliente. Defaults permisivos.*
  - [x] Permitir vender en negativo global (`pos_settings.allow_negative_stock`); override por producto (`products.allow_negative`) preparado, UI en PR2.
  - [x] Requerir cliente para registrar venta (selector de cliente en el POS + flag `require_customer`).
  - [ ] Señas: reservar stock sin descontar hasta cobrar saldo, o descontar al cobrar seña. *(se aborda en H32)*
  - [x] Descuento máximo global por rol/cajero (validado en `create_sale` + tope en el POS).
  - [x] Redondeo del total por múltiplo configurable (autoritativo en `create_sale`).
  - [x] Arqueo ciego al cerrar caja. *(el modal de cierre no muestra el esperado; el cajero cuenta a ciegas)*
  - [x] Tolerancia sin justificación en cierre de caja (`require_close_reason` + `close_tolerance`; `close_cash_shift` exige motivo si supera).
  - [x] SKU automático para productos sin código de barras con prefijo configurable (trigger `products_auto_sku`).
  - [x] *Criterio:* un cashier no puede superar el descuento máximo; el cierre exige motivo si supera la tolerancia.

- [x] **H30b — Cierres Z inmutables e historial contable de caja.** — *Auditoría contra el código (2026-06-07): el grueso ya estaba implementado desde el 2026-05-31 (`cash_z_closures`); roadmap sincronizado con evidencia. Auditoría F11 (2026-11-07): el correlativo por sucursal y por caja ya está (ADR-080, trigger `czc_numbering`, `20261105100100`). Ítems resumidos hechos en `feat/f11-retail` (ADR-085, `20261107200200`, sin aplicar).*
  - [x] Al cerrar una caja se genera un **Cierre Z**: cierre **contable diario del turno**, registro **inmutable** (no editable ni borrable) con su **snapshot consolidado** del turno. — *`close_cash_shift` v2 inserta en `cash_z_closures` (append-only: RLS sin UPDATE/DELETE, unique por turno).*
  - [x] Snapshot del Z: número correlativo de Z por sucursal/caja, apertura/cierre, cajero, ventas (cantidad y total), **desglose por medio de pago**, ingresos/egresos de caja, descuentos, anulaciones, monto esperado vs. contado, **diferencia**, e items vendidos resumidos. — *Correlativo por sucursal y por caja (`store_z_number` / `register_z_number`, ADR-080). Ítems vendidos: `cash_z_closures.items_summary` lo arma el trigger `czc_items_summary` al cerrar (sin recrear `close_cash_shift`), se ve en el detalle del Z y sale en el XLSX (ADR-085). Los Z anteriores quedan sin resumen.*
  - [x] **Historial de Cierres Z** (pantalla dedicada en Caja): lista filtrable por fecha; cada Z se puede ver, **reimprimir** (ticket vía `ticket-print`) y exportar XLSX. Nunca se edita. — *`ZClosuresHistory` en /caja; filtro por rango de fechas agregado 2026-06-07. Filtro por sucursal (selector de sucursal de arriba) y por caja hecho (ADR-080, `showRegisterFilter`).*
  - [x] Integridad: el Z queda enlazado a sus ventas/movimientos (vía `cash_shift_id`); cualquier ajuste posterior va por contramovimiento auditado, no por edición del Z (la tabla no admite UPDATE/DELETE).
  - [x] *Criterio:* al cerrar caja aparece su Z en el historial con el consolidado del turno; se puede reimprimir y exportar, pero no modificar. ✓

- [~] **H31 — Cuenta corriente y grupos de clientes.** — *Criterio principal cumplido (2026-06-07). Auditoría F11 (2026-11-07): la deuda ya se ve en el historial y en la ficha 360 (ADR-067); los grupos ya fijan lista de precios (ADR-058) y condiciones de crédito (ADR-037). Acceso desde el selector del POS hecho (ADR-085). Resta: promociones por grupo (H55).*
  - [x] **Cuenta corriente v2 (2026-10-11, ADR-037, spec `docs/specs/cuenta-corriente-v2.md`).** Plazos configurables (días o corte mensual) a nivel negocio / grupo / cliente y **cuotas**; cargo con lock (fin de la carrera del límite); **bloqueo por mora** con autorización de encargado auditada; **cobros por RPC** (`account_collect`: medio, caja abierta y Z, recibo correlativo, imputación FIFO o elegida, idempotencia); **punitorios** (simple/compuesto, mensual/diario, gracia, tope, mínimo; pg_cron diario; condonación auditada); ajustes; **estado de cuenta** y **aging por vencimiento** server-side; **reversa** de la deuda al anular o devolver; tablero `/clientes/cuentas` (KPIs, aging ECharts, lista por mora con cobrar / recordar / WhatsApp / promesa) y ficha de cuenta; **cobranza** (promesas, notas, tareas, cobrador, recordatorios automáticos por email con la Edge `account_reminders`). Features nuevas `cc_punitorios` y `cc_cobranza` (Business+). Addendum: **PIN de supervisor** para autorizar desde la caja (hash, intentos limitados, token de un solo uso), condiciones por grupo, punitorio diario en un movimiento por mes y vista previa de emails.
  - [x] **Historial del cliente**: modal en /clientes con saldo a favor (vale), compras, devoluciones y deuda de cuenta corriente (`CustomerHistoryModal`, bloque "Saldo a favor + deuda"), más la ficha completa `/clientes/[id]` (ADR-067). *Desde el selector de cliente del POS: "Ver ficha e historial" abre la ficha en otra pestaña sin perder el carrito (ADR-085).*
  - [x] Medio de pago "Cuenta corriente" que deja deuda del cliente (trigger en `payments` → `customer_account_movements`).
  - [x] Límite de deuda por cliente (`customers.credit_limit`; 0 = sin límite; se valida al cobrar fiado). Deuda visible en el historial del cliente.
  - [x] *(Reemplazado por Cuenta corriente v2: cobro por RPC y aging por vencimiento server-side.)* Cuentas por cobrar: registrar pagos de deuda desde el historial del cliente (reduce la deuda) + **vista global de CxC** en /clientes (`AccountsReceivableModal`) con buckets de antigüedad 0-30/31-60/61-90/+90 días (FIFO: los pagos cancelan los cargos más viejos) y export XLSX. Plazo/vencimiento por venta fiada hecho (2026-06-07): `due_date` por cargo (plazo configurable en Operación del POS), columna Vencido en CxC y próximo vencimiento en el historial.
  - [~] Grupos de clientes (tabla `customer_groups` + `customers.group_id`; alta inline y selector en la ficha del cliente). *Precios por grupo hechos (asignación de lista con alcance `customer_group`, ADR-058, `20261021100100`); riesgo por grupo hecho (plazos, cuotas, límite y mora en `customer_groups.account_config`, ADR-037). Falta usarlos en promociones (segmento de cliente, H55).*
  - [x] Reglas de datos obligatorios del cliente: documento, IVA, teléfono, email, domicilio, nacimiento. Configurable por el dueño en Operación del POS (`pos_settings.customer_required`); se exige en la ficha del cliente (alta/edición) con marca " *" y bloqueo de guardado. Se agregó `customers.birth_date` (fecha de nacimiento). Default: nada obligatorio salvo el nombre.
  - [x] **Escaneo de DNI argentino para alta rápida de cliente** *(agregado 2026-06-06; hecho 2026-06-08, PR #263)*: lee el código **PDF417** del frente del DNI (scanner 2D USB tipo teclado vía `useScanner`, cámara con `BarcodeDetector` cuando soporta `pdf417`, o pegado manual) y parsea **offline** los campos separados por `@` (apellido, nombre, sexo, N° de DNI, fecha de nacimiento) con `parseDni` (`lib/customers/dniParse.ts`, +16 tests) para autocompletar la ficha del cliente en alta/edición (`CustomerFormModal`) y el alta rápida del selector del POS (`createQuick`). Sin servicios ni registros gubernamentales — el dato vive en el propio código del documento. Componente `DniScanModal` con **validación visual** de los datos parseados antes de guardar (no autocompleta sin confirmación); degrada honestamente si el navegador no lee `pdf417` por cámara.
  - [x] *Criterio:* una venta fiada genera deuda con vencimiento y aparece en cuentas por cobrar. ✓

- [~] **H31b · Historial del cliente 360 PRO.** *(pedido de Lucas, 2026-10-12)* *Primer corte integrado en código (2026-10-12, rama `feat/reintegro-mp-cliente360`, ADR-067): página `/clientes/[id]` con perfil, segmentos, indicadores, sucursales, gráficos, notas, línea de tiempo unificada con filtros y cursor y XLSX; RPC `customer_360_summary` y `customer_360_timeline` con alcance de sucursal; feature `clientes_360` desde Pro. **Pasos:** aplicar `20261030100200`. **Pendiente:** comprobantes con reimprimir y reenviar, cuenta Debe / Haber con saldo acumulado y PDF, adjuntos, cambios de la ficha auditados en la línea de tiempo y acceso desde el selector del POS y desde cada venta.* Una ficha de cliente robusta y profesional para ver **todo** lo que pasó con ese cliente en un solo lugar. Hoy el historial (`CustomerHistoryModal`) muestra vale, compras y devoluciones; esto lo lleva a una vista completa, en página propia (no modal), accesible desde /clientes, desde el selector del POS y desde cada venta.
  - [~] **Línea de tiempo unificada** de todos los movimientos, con filtros por tipo, fecha, sucursal y medio: ventas, devoluciones y cambios, notas de crédito, cobros de cuenta corriente, cargos y punitorios, ajustes, vales y saldo a favor, garantías, cobros en espera, turnos y reservas, señas, gift cards y puntos (cuando existan), y cambios de datos de la ficha (auditados). *Auditoría F11: `customer_360_timeline` (ADR-067) une ventas, devoluciones, cuenta corriente, cobranza, vales, cobros en espera, reintegros por MP, disputas y notas con filtros de tipo, fecha y sucursal. Faltan turnos, cambios de la ficha auditados y filtro por medio.*
  - [ ] **Cuenta corriente contable (Debe / Haber / Saldo)**: libro mayor del cliente con saldo acumulado por fila, saldo inicial del período, totales del período, aging y próximos vencimientos. Imputación visible de cada cobro contra sus cargos.
  - [ ] **Comprobantes**: listado de todos los comprobantes del cliente (tickets, facturas A/B/C cuando haya AFIP, notas de crédito y débito, recibos de cobro, remitos) con ver, reimprimir, descargar PDF y reenviar por email o WhatsApp.
  - [x] **Detalle de cada pago**: medio, procesadora, tarjeta, cuotas, autorización y cupón, y datos de la pasarela cuando el medio está conectado. *Auditoría F11: tocar una venta de la línea de tiempo abre el detalle de la venta con los datos del procesador (ADR-061).*
  - [~] **Datos y perfil**: ficha completa (documento, condición IVA, contactos, domicilios, grupo, lista de precios, límite y condiciones de crédito), notas internas, etiquetas y adjuntos. *Auditoría F11: perfil, datos fiscales y notas internas fijables hechos (`customer_notes`, ADR-067). Faltan etiquetas y adjuntos.*
  - [x] **Indicadores**: total comprado, ticket promedio, frecuencia, última compra, productos y categorías favoritos, medios de pago preferidos, deuda actual y vencida, devoluciones y comportamiento de pago. *Auditoría F11: `customer_360_summary` con 8 indicadores, productos más comprados, medios de pago y segmentos (`lib/customers/c360.ts`, ADR-067).*
  - [~] **Exportar** el estado de cuenta y la línea de tiempo en XLSX (TX-2) y PDF con la marca del negocio; enviar el estado de cuenta al cliente. *Auditoría F11: XLSX de la ficha (resumen, línea de tiempo, productos, medios y sucursales) hecho (ADR-067). Faltan PDF y envío.*
  - [x] **Gating y seguridad**: todo server-side con RLS por tenant y permisos por rol (el cajero ve lo justo; deuda y datos sensibles según permiso). Clasificar la feature (BASE para el historial básico; OPTIONAL por plan para la vista contable completa, indicadores y exportes) y cumplir el checklist de features de CLAUDE.md. *Auditoría F11: `clientes_360` OPTIONAL desde Pro con gating en las RPC (`_c360_assert`), alcance de sucursal con `report_store_filter` y cobranza sólo para dueño o encargado (ADR-067).*
  - [ ] *Criterio:* desde la ficha de un cliente se ve en una sola pantalla su línea de tiempo completa, su cuenta Debe / Haber con saldo correcto contra cuentas por cobrar, y se puede reimprimir o reenviar cualquier comprobante; exportar el estado de cuenta da un XLSX/PDF que cuadra con el saldo.

- [ ] **H32 — Pedidos de salón, reservas y despacho.**
  - [ ] Pedidos pendientes de facturar: vendedor arma pedido y cajera lo cobra.
  - [ ] Reserva de stock con expiración en minutos.
  - [ ] Anulación automática o liberación al vencer reserva.
  - [ ] Despacho/expedición separado: ventas pagadas pasan a queue de armado/entrega.
  - [~] Tipos de entrega: retiro inmediato, retiro pendiente en sucursal, envío a domicilio. *Auditoría F11: delivery y take away existen para gastronomía (`delivery_orders`, F13 · H49). Falta el retiro pendiente en sucursal para retail.*
  - [ ] Cross-branch configurable por tipo de entrega.
  - [ ] *Criterio:* vendedor crea pedido reservado, cajera lo levanta, cobra y expedición lo marca entregado.

- [~] **H33 — Depósitos, stock multi-depósito y transferencias.** — *Hecho en `feat/f11-retail` (ADR-085, migraciones `20261107200000` a `20261107200300` sin aplicar): feature `depositos` (OPTIONAL, Pro+), página **Depósitos**, salón calculado, movimientos internos con tránsito, recepción parcial con diferencias, conteo por depósito y reposición del salón por mínimos. Queda: depósito por defecto por tipo de entrega o devolución. La venta ya valida contra el salón y puede vender de la reserva con aviso (`pos_settings.sell_from_reserve`, ADR-088, `20261108200000` sin aplicar).*
  > Nota 2026-10-12: *(Stock y transferencias entre sucursales: F17/H94 y H95; acá quedan los depósitos dentro de cada sucursal.)*
  - [x] Depósitos por sucursal: principal, reserva, devolución, merma, tránsito. *`warehouses` (tipos principal, reserva, devolucion, merma, otro). El tránsito no es un depósito: es el estado del movimiento (`in_transit`, `partially_received`).*
  - [x] Stock por depósito. *`warehouse_stock` para los depósitos y el salón calculado (sucursal − depósitos − tránsito) con `warehouse_stock_overview`; conteo por depósito con `warehouse_stock_set`.*
  - [x] Transferencias entre depósitos con origen/destino, motivo, estado y auditoría. *Entre sucursales: traslados (H95). Dentro de la sucursal: `warehouse_move_create` / `_receive` / `_cancel` con motivo, estado, número correlativo y `audit_logs` (ADR-085).*
  - [x] Recepción parcial y diferencias. *Parcial o total; al cerrar, el faltante sale de la sucursal como merma y el sobrante entra como ajuste, cada uno con motivo; cerrar con diferencias es de dueño o encargado (ADR-085).*
  - [ ] Depósito default por tipo de entrega/devolución. *Deuda (ADR-085): los motivos de devolución que no reingresan stock y los tipos de entrega (H32) necesitan definición con el dueño.*
  - [x] *Criterio:* se transfiere stock de depósito central a sucursal, queda en tránsito y luego recibido. *Entre sucursales con traslados (H95) y dentro de la sucursal con movimientos internos en tránsito (ADR-085).*

- [~] **H34 — Importación masiva por Excel.** — *TX-4 completo (2026-10-13, ADR-078): productos, clientes, sucursales, stock por sucursal, listas, garantías y motivos con dry-run en el servidor, confirmación, errores por fila descargables y auditoría por lote. Depósitos y stock por depósito hechos (ADR-085). Faltan transferencias por archivo y reversión.*
  - [x] Importar productos por XLSX (parser `parseProductsXlsx` + `ImportProductsModal`).
  - [x] Importar clientes por XLSX (parser `parseCustomersXlsx` + `ImportCustomersModal`).
  - [x] Importar depósitos/sucursales por XLSX. *(Sucursales con `import_stores`; depósitos con `import_warehouses`, ADR-085.)*
  - [~] Importar stock inicial y transferencias por XLSX. *(Stock por sucursal con `import_stock` y por depósito con `import_warehouse_stock`, conteos auditados; transferencias pendientes.)*
  - [x] Importar listas de precios, medios de pago/planes, garantías extendidas y motivos de devolución por XLSX. *(Listas, garantías y motivos con `import_*`; planes de cuotas por medio desde H27.)*
  - [x] Plantillas descargables por entidad con columnas obligatorias y ejemplos.
  - [x] Preview antes de confirmar: filas válidas, errores.
  - [x] Modo dry-run formal y archivo de errores descargable. *(ADR-078)*
  - [~] Importaciones auditadas y reversibles cuando sea posible. *(Auditadas por lote; reversión pendiente.)*
  - [x] *Criterio:* un tenant carga productos, clientes, depósitos y stock inicial desde Excel sin tocar SQL. *(ADR-078 + ADR-085.)*

### F12 — Comercios simples y servicios

Objetivo: que negocios con pocos productos o servicios puedan vender en minutos con pantallas de cobro ultrarrápidas, sin sentirse obligados a cargar inventario pesado. Apunta a heladerías, cafeterías simples, panaderías chicas, peluquerías, barberías, estética/uñas/spa, lavaderos, talleres livianos, profesionales con turnos y comercios de mostrador con catálogo chico. Ver [`22-simple-commerce-services.md`](./22-simple-commerce-services.md).

- [~] **H35 — Onboarding por rubro de catálogo chico.** — *Core entregado (PR #269, 2026-06-08): wizard de "configuración rápida por rubro" (3 pasos) + RPC `apply_industry_preset(p_preset, p_sells)` SECURITY DEFINER tenant-scoped, idempotente y auditada (migración `20260608530000_industry_presets.sql`) que siembra categorías + productos/servicios de muestra (favoritos · H36), servicios sin stock y defaults sensatos de `pos_settings`. Reachable desde el onboarding (`OnboardingChecklist`) y Configuración → Rubro (`RubroCard`). Verificado por SQL (alta limpia siembra; re-aplicar NO duplica). La automatización de impuestos/ticket/medios de pago/roles se apoya en sus propios pasos del onboarding y queda fuera de este PR.*
  - [x] Wizard inicial con pregunta operativa: "vendo productos", "vendo servicios", "vendo ambos". — *Paso 1 del `IndustryPresetWizard`; filtra qué presets/ítems se siembran y los defaults del POS.*
  - [x] Presets de rubro: heladería, cafetería/take away, panadería simple, peluquería/barbería, estética/uñas/spa, lavadero, taller liviano, servicios profesionales. — *8 presets en `modules/onboarding/presets.ts` + la RPC; cada uno con categorías y un puñado de ítems de muestra marcados favorito.*
  - [~] Creación automática de categorías, botones rápidos, impuestos/ticket, medios de pago y roles mínimos. — *Categorías + botones rápidos (favoritos H36) + defaults de `pos_settings` (servicios: sin exigir cliente/documento, venta libre on) sembrados por el preset. Impuestos/ticket/medios de pago/roles los cubren sus secciones del onboarding (cruza con F3/H8/H30) — no se rehacen acá. *Auditoría 2026-10-13:* el checklist de onboarding (`components/dashboard/OnboardingChecklist.tsx`, pasos `fiscal`, `mp`, `producto`, `ticket`, `venta`) cubre datos fiscales, medios de pago y ticket; **los roles mínimos por rubro siguen abiertos** (no hay paso ni preset de roles), por eso queda en [~].*
  - [x] Modo "sin stock" para servicios y comercios donde el inventario no importa al inicio. — *Los ítems de servicio se crean con `track_stock=false` (no descuentan inventario en `create_sale`); en modo "servicios" los defaults arrancan sin inventario ni cliente obligatorio.*
  - [x] *Criterio:* una heladería o peluquería queda lista para cobrar una primera venta en menos de 10 minutos, sin importar Excel ni tocar SQL. — *Un preset deja categorías + botones rápidos + defaults en un par de clics; el cajero abre el POS y cobra.*

- [~] **H36 — POS rápido por botones / catálogo chico.** — *Core de cobro rápido por botones entregado (PR#267): favoritos como botones grandes + cantidades rápidas + venta libre por permiso. La cantidad "sesión individual/pack" quedó cubierta por H41 (consumo de sesión por línea). *Auditoría 2026-10-13:* sólo queda abierto el criterio de 15 segundos, que necesita medición en pantalla táctil real (no hay instrumentación de tiempo por venta).*
  - [x] Pantalla de cobro con grilla táctil de favoritos, categorías grandes y botones de alto contraste. — *`components/pos/FavoritesGrid.tsx` (botones grandes alto contraste, mobile/tablet-first) arriba de la grilla del POS; categorías grandes ya existían (`CategoryNav`).*
  - [x] Productos/servicios sin búsqueda obligatoria: el cajero toca 2-3 botones y cobra. — *Favoritos (`products.is_favorite`) se muestran sin buscar; tap = agrega al carrito.*
  - [x] Cantidades rápidas: `+1`, `+2`, `x6`, `x12`, medio kilo/kilo, sesión individual/pack. — *`+1` (tap del botón) + chips `×2/×6/×12` en botones y en la línea del carrito; `½ kg`/`1 kg` para productos por peso. Sesión/pack entregado en H41 (consumo de sesión por línea en el carrito).*
  - [x] Botón "Venta libre" con monto manual y motivo, controlado por permiso. — *Botón "Venta libre (monto manual)" gateado por `pos_settings.allow_free_sale` + rol owner/manager; reusa el mecanismo de línea product-less (`addFreeAmount` → `create_sale` con `product_id` null, no descuenta stock). Probado por SQL.*
  - [x] Cobro express: efectivo exacto, efectivo con vuelto, QR, tarjeta, transferencia. — *Reusa `PaymentModal`/QR existentes (no se duplicó).*
  - [ ] *Criterio:* una venta típica de 3 ítems se carga y cobra en menos de 15 segundos en pantalla táctil.

- [x] **H37 — Modificadores simples para heladería/cafetería.** — *Core hecho (PR #268, 2026-06-08): grupos de modificadores por producto (Tamaño/Sabores/Toppings) con min/max, obligatorio y orden; opciones con +precio; selector en el POS al agregar; precio = base + deltas; persistencia del snapshot en `sale_items.modifiers`. **Combos** (café + medialuna) → F9; **comanda de cocina/producción** → F13.* *Auditoría 2026-10-13: hito completo; combos con el motor de promociones (ADR-074) y comanda impresa del pedido de mostrador (H48, `components/dining/ComandaModal.tsx`).*
  - [x] Tamaños: vasito, cucurucho, 1/4 kg, 1/2 kg, 1 kg, café chico/mediano/grande. — *Modelados como un grupo "Tamaño" (radio, min1/max1) con opciones libres por tenant; no hay lista fija, el dueño carga las suyas.*
  - [x] Sabores/toppings como modificadores, con límite configurable por tamaño. — *Grupos multi con `max_select` configurable (ej. Sabores hasta 3) y opciones con `price_delta` (ej. Crema +200). El POS valida el tope al elegir.*
  - [x] Modificadores obligatorios/opcionales y ordenados para que no frenen al cajero. — *`required` + `min_select`/`max_select` + `sort`; en el selector del POS los obligatorios van primero y se valida min/max antes de confirmar.*
  - [x] Combos simples: café + medialuna, kilo + cucuruchos, docena, promo familiar. *Hecho con el motor de promociones: combo a precio fijo por juego completo (`bundle_items`), NxM y escalas por cantidad (ADR-074, `20261102100200_promociones_motor`).*
  - [x] Impresión opcional de comanda/producción para preparación. *Hecho: pedido de mostrador (H48) con KDS y "Imprimir comanda" por estación (`DeliveryAccountModal` + `ComandaModal`, H45/H49).*
  - [x] *Criterio:* el cajero vende "1/2 kg, 3 sabores" sin crear 200 productos distintos. — *Verificado: schema `product_modifier_groups`/`product_modifier_options` (migración `product_modifiers`, RLS por tenant), editor plegable en `ProductFormModal`, `ModifierPickerModal` en el POS (radio/multi con límite + precio en vivo), `create_sale` persiste `sale_items.modifiers` con el precio ajustado (probado por SQL).* 

- [x] **H38 — Agenda y servicios para peluquería/estética.** — *Core entregado (local, pendiente de push — migración `20260608540000_agenda.sql` aplicada en remoto vía MCP y validada por SQL): servicios + profesionales + agenda día/semana + cobro desde el turno. **Follow-up (NO en este hito):** liquidación de comisiones (H39), seña/pago de reserva, propinas y lista de espera avanzada.* *Auditoría 2026-10-13: hito completo; la seña de reserva quedó hecha en ADR-088 y la lista de espera en ADR-082.*
  - [x] Servicios con duración, precio, profesional asignable y comisión. — *Un servicio es un `products` con `track_stock=false` + dos campos nuevos `products.service_duration_min` y `products.commission_pct` (sección “Servicio para agenda” en el form de producto). Reusa categorías/precio/favoritos/listas. El profesional se asigna por turno (no es un atributo fijo del servicio).*
  - [x] Agenda diaria/semanal por profesional, silla/cabina o recurso. *Recursos hechos (2026-10-13, ADR-082, `20261106100100_agenda_recursos`, sin aplicar): `agenda_resources` (silla, cabina, box, equipo) + `appointments.resource_id`, vista del día por recurso (`AgendaBoard` con `groupBy`), selector en el turno, y el servidor bloquea la doble reserva del mismo recurso (`resource_busy`); el choque de profesional es aviso. Feature `agenda_recursos` desde Pro.* — *Vista **día** (columnas por profesional + “Sin asignar”) y **semana** (columnas por día, filtrable por profesional), grid horario 8–21h con bloques coloreados por profesional, click en hueco = agendar (`AgendaBoard`). Silla/cabina/recurso genérico queda como extensión (hoy el recurso es el profesional).*
  - [x] Turnos, walk-ins y lista de espera. *Lista de espera hecha (2026-10-13, ADR-082, `20261106100200_agenda_lista_espera`, sin aplicar): `agenda_waitlist` con servicio, profesional preferido, fecha y franja, aviso por WhatsApp manual y "Agendar" con la RPC atómica `agenda_waitlist_schedule` (`WaitlistPanel`). Feature `lista_espera` BASE.* — *Turnos (`appointments`: snapshot servicio + estado + `sale_id`), **walk-in** (turno ahora, `is_walk_in`, en_curso) hechos. **Lista de espera** queda como follow-up.*
  - [x] Cobro desde turno: servicio realizado → agregar productos extra → cobrar. — *Botón “Cobrar este turno” → `/pos?appointment=<id>`: el POS carga el servicio en el carrito (permite agregar productos extra) y cobra con el flujo existente (`create_sale` intacto); al confirmar, `link_appointment_sale()` enlaza la venta y marca el turno `realizado`.*
  - [x] Señas, cancelaciones, no-show y reprogramación. — *Cancelación con motivo, **no-show**, reprogramación (editar fecha/hora) y todos los estados (reservado/confirmado/en_curso/realizado/cancelado/no_show) hechos. **Seña/pago de reserva** queda como follow-up (H39/pagos). *Auditoría 2026-10-13: sigue abierta; descontar la seña al cobrar el turno requiere tocar `create_sale` o un medio de pago "seña" (deuda en ADR-082). **Hecho en `feat/create-sale-deudas` (ADR-088, `20261108200000` sin aplicar):** `appointment_deposits`, seña cobrada en la caja propia al reservar (feature `agenda_senas`, Pro+), descontada en `create_sale` como pago `sena` exacto con el turno enlazado en la misma transacción, liberada si la venta se anula y devolución del sobrante con motivo.*
  - [x] *Criterio:* una peluquería agenda corte + color con profesional, cobra el turno y calcula comisión. — *Cumplido a nivel core (validado por SQL: profesional + servicio + turno → cambio de estado → venta enlazada; la comisión se calcula y muestra en el detalle del turno). La **liquidación** de comisiones es H39.*

- [x] **H39 — Comisiones, propinas y productividad del staff.** *(Auditoría 2026-10-13: todos los ítems y el criterio están hechos; el reparto de propina entre varios profesionales es mejora futura, no ítem del hito.)* — *Core hecho (migración `20260608550000_commissions_tips`, aplicada en remoto; **local, pendiente de push**). Propinas al cobrar (monto + medio efectivo/tarjeta/QR) en `sales.tip_amount`/`tip_method`, aparte del total de productos. Atribución de vendedor/profesional a la venta (`sales.professional_id`, selector en el PaymentModal) y comisión por línea `coalesce(products.commission_pct, professional.commission_pct, 0)% × subtotal`. Reporte de productividad por profesional en Reportes (servicios, productos, facturado, comisión, propinas, ticket prom. + export XLSX) vía RPC `staff_productivity` SECURITY DEFINER tenant-scoped. Flag `pos_settings.staff_sees_own_only` (toggle en Configuración → Operación) con RLS de lectura sólo-propia en la agenda y filtro en el reporte. Probado por SQL (rollback). **Reparto de propina entre varios profesionales** → futuro (hoy la propina va al profesional de la venta).*
  - [x] Comisión por servicio, por producto, por garantía/extra y por profesional. — *Por línea: % del producto si lo define, si no el del profesional, si no 0. Las garantías/extras (ítem libre sin commission_pct de producto) caen al % del profesional. Las garantías además ya tienen su comisión propia en el reporte de Garantías (H28).*
  - [x] Propinas por efectivo/tarjeta/QR con reparto manual o por profesional. — *Captura al cobrar (monto + medio); se atribuye al profesional de la venta. Reparto manual entre varios queda como mejora futura.*
  - [x] Reporte diario por profesional: servicios, productos vendidos, comisión, propina, ticket promedio. — *Sección "Productividad del staff" en Reportes con tabla + gráfico (comisión) + export XLSX; respeta el rango de fechas (día/semana).* 
  - [x] Permisos para que el staff vea solo su agenda/ventas si el owner lo decide. — *`pos_settings.staff_sees_own_only`: RLS RESTRICTIVE de SELECT en `appointments` (lectura sólo-propia) + filtro en `staff_productivity`. El owner ve todo. Match usuario↔profesional por `professionals.user_id`.*
  - [x] *Criterio:* el owner liquida comisiones de la semana sin planilla externa. — *Verificado por SQL: venta con propina + vendedor → comisión 200 (10% prod + 20% prof) y propina 300 trazada; `staff_productivity` agrega por profesional; el owner exporta XLSX para liquidar. Pendiente de push (modo local).*

- [~] **H40 — Clientes livianos y recurrencia.** — *Núcleo entregado (local, pendiente de push — migración `20260608570000_customer_extras.sql` aplicada en remoto vía MCP y validada por SQL). **Follow-up (NO en este hito):** envío AUTOMÁTICO de recordatorios (WhatsApp/email) — cruza con el cron de emails transaccionales (H-emails).*
  - [x] Ficha mínima opcional: nombre, teléfono/WhatsApp, cumpleaños, preferencias y notas. — *`customers.preferences` (texto libre, distinto de `notes` internas) + campo en `CustomerFormModal` y bloque "Preferencias" en `CustomerHistoryModal`. El resto (nombre/teléfono/cumpleaños/notas) ya existía.*
  - [x] Historial de servicios/productos por cliente. — *`CustomerHistoryModal` ya muestra compras, devoluciones, saldo a favor, deuda y packs (H41); H40 agrega los próximos turnos (de `appointments` futuros, reusa H38).*
  - [~] Recordatorios por WhatsApp/email: próximo turno, mantenimiento, cumpleaños, promo de regreso. *Base: "Cumpleaños del mes" en /clientes (`BirthdaysModal`) + próximos turnos en el historial con links MANUALES de WhatsApp (`wa.me`) y email (`mailto`) con el recordatorio prearmado. **El envío AUTOMÁTICO queda como follow-up** (cron de emails).*
  - [x] Recompra rápida: "repetir último servicio" o "repetir pedido frecuente". — *Botón "Repetir última venta" en `CustomerHistoryModal` → `/pos?repeat=<customerId>`: el POS carga los ítems de la última venta `completed` al carrito (precio ACTUAL del producto vía lista mostrador; omite los dados de baja con aviso; ítems libres a su precio histórico) y deja al cliente seleccionado. Mismo patrón que el cobro desde turno (`?appointment=`).*
  - [x] *Criterio:* un cliente frecuente se cobra desde su historial en menos de 3 taps. — *Verificado por flujo: en /clientes, abrir Historial (1) → "Repetir última venta" (2) → "Cobrar" (3). Migración validada por SQL (columna `preferences` write/read; query de próximos turnos sin errores). Pendiente de push (modo local).*

- [~] **H41 — Paquetes, membresías y sesiones.** — *Núcleo (packs de sesiones) entregado (local, pendiente de push — migración `20260608560000_service_packs.sql` aplicada en remoto vía MCP y validada por SQL). **Follow-up (NO en este hito):** membresía recurrente (cruza con suscripciones) y gift cards (cruza con vales H29).*
  - [x] Packs de sesiones: 4 cortes, 8 clases, 10 sesiones de estética, mantenimiento mensual. — *`service_packs` (nombre, servicio cubierto opcional, nº de sesiones, precio, validez en días, baja lógica). Gestión en Configuración → Paquetes (`ServicePacksManager`), RLS por tenant + auditoría.*
  - [x] Saldo de sesiones consumibles con vencimiento opcional. — *`customer_pack_credits` (sessions_total/used, expires_at del `validity_days`, snapshot del pack). Vender el pack acredita el saldo y consumir descuenta una sesión, vía `create_sale` (`p_extras` kind `pack`/`pack_session`, sin tocar su firma — patrón H28/H39). Validación de saldo, vencimiento y cliente obligatorio; consumo auditado (`pack_session_used`).*
  - [ ] Membresía simple recurrente o prepaga, conectable a suscripciones/pagos después. — *Follow-up: cruza con suscripciones; no en este hito.*
  - [ ] Gift cards para servicios y consumos. — *Follow-up: cruza con vales (H29); no en este hito.*
  - [x] *Criterio:* se vende un pack de 5 sesiones, se consume una al cobrar y queda saldo visible. — *Cumplido: en el POS se vende el pack (entra como ítem + acredita el saldo al cliente) y, al cobrar el servicio cubierto, "Usar sesión del pack (N restantes)" deja la línea en 0 y descuenta una sesión; el saldo (restantes + vencimiento) se ve en la ficha del cliente (`CustomerHistoryModal`). Validado por SQL: vender→acredita, consumir→sessions_used++, respeta saldo/vencimiento/cliente.*

- [~] **H42 — Oportunidad comercial y plantillas vendibles.** *(2026-10-13, ADR-082: datos de ejemplo de la agenda y métricas de activación hechos; landing por rubro queda fuera de esta app.)*
  - [ ] Landing/demo por rubro: "POS para heladerías", "POS para peluquerías", "POS para estética", "POS para cafeterías chicas".
  - [x] Datos demo precargados por rubro para mostrar valor en 3 minutos. *Catálogo de muestra por rubro con los presets (H35, `20260710130000_preset_sample_products`) y, para servicios, "Cargar datos de ejemplo" en la Agenda (`agenda_demo_seed` / `agenda_demo_clear`, `20261106100300`, sin aplicar): profesionales, clientes, turnos de hoy, recurso y lista de espera marcados "(ejemplo)", que se quitan con un toque.*
  - [x] Plan Start orientado a catálogo chico: bajo setup, pantalla simple, agenda básica o botones rápidos. *Auditoría 2026-10-13: el plan Start (`20260608150000_plans_overhaul`) incluye POS, caja, productos y stock; `agenda` y `packs` son BASE (`is_basic`, `20260608540000_agenda` y `20260608560000_service_packs`), el diseño del POS con hasta 12 teclas rápidas es gratis (`20261011190000_pos_layout`, más de 12 es `pos_quick_keys_pro`) y los presets por rubro (H35) dejan el catálogo armado.*
  - [x] Métrica de activación: primer cobro real, primer turno agendado, primer cliente recurrente. *RPC `internal_tenant_activation` (sólo panel interno con `internal_scope`) + tarjeta Activación en el detalle del negocio (`components/internal/ActivationCard.tsx`, `lib/saas/activation.ts`): también primer pack y uso de favoritos. Taps y segundos por venta no se miden (deuda).*
  - [ ] *Criterio:* ventas puede demoear cada rubro con flujo real sin configurar datos manualmente.

### F13 — Gastronomía PRO

Objetivo: cubrir restaurantes, resto-bares, cafeterías, heladerías, panaderías, rotiserías, food trucks y fast food con mesas, comandas, cocina/barra, delivery/takeaway y variantes de atención. No reemplaza F12: F12 cubre cobro simple; F13 cubre operación gastronómica completa. Ver [`23-restaurant-cafe-operations.md`](./23-restaurant-cafe-operations.md).

- [~] **H43 — Configuración de negocio gastronómico y modos de atención.** — *Núcleo del modo gastronómico hecho (local, pendiente de push): toggle `pos_settings.dining_enabled` (Configuración → Operación → "Modo gastronómico / mesas"). ADITIVO: con off, el POS mostrador queda idéntico; con on, aparece la sección Salón en el menú y "Salones y mesas" en Configuración. **Presets por tipo de rubro gastronómico** que activan la suite F13 (mesas/cocina/delivery) → hechos (H47 — restaurante / resto_bar / rotiseria / dark_kitchen, ver abajo; local pendiente de push). **Follow-up:** modos de venta como tales (take away / delivery / pickup / QR como modo seleccionable), selector por caja/dispositivo y reglas por modo (cobrar antes/después, comanda al enviar/cobrar) → siguen pendientes (se cruzan con H45/H49).*
  - [x] Modo gastronómico on/off por tenant (`dining_enabled`), aditivo (mostrador intacto con off).
  - [~] Presets por tipo: restaurante salón, resto-bar, cafetería, heladería, panadería, rotisería, fast food, food truck, dark kitchen, delivery/takeaway. — *Presets gastronómicos que ENGANCHAN la suite F13 hechos (H47, local pendiente de push). Migración `20260608760000_gastro_presets` extiende `apply_industry_preset` con 4 presets nuevos en `modules/onboarding/presets.ts` + SQL (nombres de categorías/ítems sincronizados): **`restaurante`** (mesas+cocina: `dining_enabled=true`, siembra salón "Salón" con 6 mesas, comidas → `products.station='cocina'`, bebidas → `'barra'`), **`resto_bar`** (mesas+cocina+barra+delivery: `dining_enabled`+`delivery_enabled`, salón "Salón"+mesas + zona "Zona local", tragos/cervezas → `'barra'`), **`rotiseria`** (mostrador+delivery: `delivery_enabled=true` + zona "Zona local", comidas → `'cocina'`, sin mesas), **`dark_kitchen`** (SOLO delivery, sin mostrador: `delivery_enabled=true` + zona, comidas → `'cocina'`). Idempotente/seguro: enciende sólo el flag del módulo elegido (no apaga ni pisa otros settings); no duplica salón/mesas/zona/ítems al re-aplicar (probado por SQL). Heladería/cafetería/etc. **intactos** (no tocan dining/delivery/salón — probado). La tarjeta del wizard (`IndustryPresetWizard`) muestra "Incluye mesas y cocina (KDS)" / "Incluye delivery" por preset (`PresetDef.enables`). **Follow-up (NO en este tick):** cafetería/heladería/panadería como presets de mostrador gastronómico (hoy son los presets clásicos F12), fast food / food truck, menú por horario/canal (H48), pickup / drive-through / QR-mesa como modos separados.*
  - [~] Modos de venta: mesa, mostrador, take away, delivery propio, pickup, drive-through, pedido por QR, evento/food truck.. *Auditoría 2026-10-13: ya existen **mesa** (H44, `/salon`), **mostrador** con nombre (H48, `delivery_orders.order_type='mostrador'`), **take away** y **delivery propio** (H49, `/delivery`). Pickup, drive-through, pedido por QR y evento/food truck como modos propios siguen pendientes. **Ronda 2 (ADR-097):** pickup se cubre con take away + horario prometido (`delivery_orders.promised_at`), sin modo nuevo. El pedido por QR de mesa no se hizo: exige una superficie pública sin sesión (RPC para `anon`, límite de pedidos por mesa y anti abuso) y queda como decisión aparte; drive-through y evento/food truck no aportan sobre mostrador + take away.*
  - [ ] Selector por caja/dispositivo: salón, barra, cocina, mostrador, despacho.
  - [ ] Reglas por modo: cobrar antes/después, imprimir comanda al enviar/cobrar, pedir nombre de cliente, pedir mesa, pedir teléfono/dirección.
  - [ ] *Criterio:* un tenant cambia de cafetería de mostrador a cafetería con mesas sin tocar código ni migraciones manuales.

- [~] **H44 — Mesas, salones y comandas de salón.** — *Núcleo hecho (local, pendiente de push): migración `20260608580000_dining_tables` (`dining_areas`, `dining_tables`, `table_orders`, `table_order_items`, RLS por tenant + RPCs tenant-scoped con guard de miembro activo y auditoría). CRUD de salones/mesas en Configuración → "Salones y mesas". Vista de **Salón** (`/salon`): grid de mesas por salón, color por estado (libre/ocupada/cuenta_pedida/bloqueada), capacidad y total vivo; tap libre → abrir + cargar, tap ocupada → ver/editar cuenta, agregar ítems (picker de productos + ítem libre), cancelar o cobrar. **Cobrar mesa** reusa el POS: `/pos?table=<order_id>` carga los ítems al carrito y, al confirmar, `close_dining_table` enlaza la venta, marca el pedido 'cobrada' y libera la mesa (espeja el cobro de turno · H38). Probado por SQL (abrir → cargar → editar/quitar → cobrar con create_sale → cerrar). **Follow-up (NO en este PR):** mover/unir/transferir mesas, reservas (H51), propina por mesa, ticket separado por comensal (varias ventas). **Ya hechos después:** ruteo por estación (H45 mínimo), KDS / pantalla de cocina (H46), comanda impresa (H45 print) y **división de cuenta** (N pagos por partes/monto/porcentaje/ítem en un solo `create_sale`, local pendiente de push).*
  - [x] Configuración visual de salones/sectores (salón principal, terraza, barra, etc.) — CRUD en Configuración.
  - [x] Mesas con número/nombre, capacidad, estado y mozo asignado. (posición/forma → follow-up).
  - [x] Estados de mesa núcleo: libre, ocupada, cuenta pedida, bloqueada. (esperando pedido/en cocina/servida/limpieza/reservada → con KDS/reservas).
  - [x] Apertura de mesa, cargar pedido y cerrar mesa (cobro). Mover, unir y transferir: *hecho (ADR-081, migración `20261105200000_mesas_mover_unir`): `move_table_order` (a mesa libre muda el pedido; a ocupada une las cuentas, el origen queda `cancelada` con `merged_into`), `transfer_table_order_items` (pasa algunos ítems; abre la mesa destino si está libre) y `set_table_waiter` (relevo de mozo). Las tres auditan (`table_moved`, `tables_merged`, `items_transferred`, `waiter_changed`). UI: botón **Mover / unir** y selector de mozo en la cuenta de la mesa (`TableMoveModal`).*
  - [x] División de cuenta por ítem, por comensal, por porcentaje o por monto. — *Hecho (N pagos, local pendiente de push): opción "Dividir cuenta" en el modal de cobro (`PaymentModal`) — aplica al cobro de mesa (`/pos?table=`) y al mostrador. Arma N líneas de pago que suman EXACTO el total (`payTotal`) y se mandan como `p_payments` en UN solo `create_sale` (una venta; la mesa se cierra/libera igual con `close_dining_table`). 4 modos: partes iguales (N comensales), por monto, por porcentaje (suma 100%) y por ítem (asignar ítems del pedido a cada comensal; lo no asignado → última línea). Cada línea elige su medio (efectivo/tarjeta/QR/…) respetando el gating de medios de pago (misma lista que el cobro simple; vale/cuenta corriente excluidos del split); voucher de tarjeta por línea si el negocio lo exige. Reconciliación en centavos: el remanente de redondeo va a la última línea para cuadrar al centavo. Muestra total/asignado/restante/vuelto. **Follow-up (NO en este PR):** ticket/comprobante SEPARADO por comensal (varias ventas), propina por comensal distinta, y dejar la mesa parcialmente abierta (pagar parte y seguir).*
  - [x] Propina sugerida y propina libre.. *Auditoría 2026-10-13: ya hecho. El cobro (`components/pos/checkout/CheckoutSheet.tsx`) ofrece propina por % sugerido (presets configurables en Configuración del POS, `lib/pos/layout.ts` `tipPresets`, editor `PosLayoutEditor`) o monto libre, y viaja como `p_extras` `{kind:'tip'}` a `sales.tip_amount` (H39). Aplica igual al cobro de mesa (`/pos?table=`), que usa el mismo checkout.*
  - [x] *Criterio:* un mozo abre mesa 12, carga pedido, envía comanda, divide la cuenta en dos pagos y libera la mesa. — *Abrir/cargar/enviar comanda (H45 impresa)/cobrar/liberar OK; división de cuenta → hecho (N pagos: p. ej. una línea efectivo + una tarjeta en un solo `create_sale`, mesa liberada). **Ticket separado por comensal hecho (ADR-097, migración `20261109600000_gastro_r2_cuenta_por_comensal`):** el mozo asigna cada plato a un comensal (`table_order_items.diner`) y cobra cada uno en su ticket, o en partes iguales (cada parte lleva la fracción de cada plato y la última cuadra al centavo). Cada cuenta separada es un pedido hijo (`split_table_order`) que se cobra con `create_sale` sin tocarlo; la mesa queda abierta hasta la última y un trigger la libera. `SplitBillModal` en la cuenta de la mesa.*

- [~] **H45 — Comandas impresas y ruteo por estación.** — *Ruteo por estación + **comanda IMPRESA por estación** hechos (local, pendiente de push). Ruteo: `products.station` (cocina/barra/cafeteria/parrilla/postres/despacho + "sin estación"), snapshot en `table_order_items.station` al cargar el ítem (alimenta el KDS H46). Comanda impresa: acción **"Imprimir comanda"** en la cuenta de la mesa (`TableAccountModal`) y un botón por mesa en el KDS. Agrupa los ítems por estación y emite **una comanda por estación** (cocina lo suyo, barra lo suyo; ítems sin estación → comanda "Sin estación"), filtrable por estación. Es ticket de COCINA **sin precios ni totales**: nombre del local (opcional), mesa + salón, hora, mozo, e ítems con cantidad + modificadores + notas; estación como encabezado grande. Reusa el flujo de impresión web de los tickets (`window.print` + CSS print `.comanda-print`/`.comanda-page` con salto de página por estación; rollo 58/80mm). Evita re-imprimir: `table_order_items.printed_at` (migración `20260608620000_comanda_printed`) + RPCs `comanda_items`/`mark_comanda_printed`; por defecto imprime sólo lo NUEVO (no enviado) y lo marca, con opción "reimprimir todo". **Follow-up (NO en este PR):** impresión física automática a impresora de RED por estación (acá es print del navegador) + fallback a cola, cancelación parcial con re-impresión de anulación, agrupar por curso (entradas/principales), prioridad/modo de entrega/alergias en la comanda, QZ Tray. Default de estación por categoría → follow-up.*
  - [x] Comanda antes del pago para restaurante/cafetería cuando corresponda. — *"Imprimir comanda" desde la cuenta de la mesa (mesa abierta, antes de cobrar) y desde el KDS.*
  - [x] Ruteo por estación: cocina, barra, cafetería, parrilla, postres, despacho. — *`products.station` + snapshot en la línea; el KDS agrupa por estación.* (cocina fría/heladería como estaciones extra → follow-up; la lista es ampliable sin migración.)
  - [ ] Impresora por estación y fallback a cola si falla. — *Follow-up: hoy es print del navegador (una hoja por estación con salto de página); impresora de red por estación + cola ESC/POS → F4.*
  - [x] Comanda con mesa/pedido, mozo/cajero, hora, ítems, modificadores, notas, alergias, prioridad y modo de entrega. — *Comanda impresa con mesa/salón, hora, mozo, ítems + modificadores + notas (sin precios). Alergias/prioridad/modo de entrega → follow-up. **Auditoría 2026-10-13:** alergias ya salen destacadas (H47, `allergens`) y el modo de entrega ya sale en la comanda de delivery/takeaway (encabezado `DELIVERY/TAKEAWAY #1234`, H49); sólo falta prioridad. **Prioridad hecha (ADR-097):** `priority` normal/urgente en mesa y delivery (`set_order_priority`, audita), banda URGENTE en la comanda impresa y columna urgente primero en el KDS.*
  - [x] Reimpresión, cancelación parcial, agregado posterior y marca de "ya enviado". *Marca "ya enviado" (`printed_at`), sólo lo nuevo y "reimprimir todo" (H45). **Cancelación parcial hecha (ADR-081, migración `20261105200100_comanda_anulaciones`):** un ítem enviado (comanda impresa o tocado por cocina) sólo baja con `void_table_order_item` (cantidad + motivo obligatorio, `table_order_voids` + audit `comanda_item_voided`); `set_table_order_item_qty`, el update directo (trigger) y el delete directo (sin policy) quedan bloqueados. Aviso a cocina: banda **Anulado** en el KDS con "Visto" (`kds_recent_voids` / `ack_comanda_void`) y ticket de ANULACIÓN imprimible (`VoidItemModal`). **Delivery con el mismo patrón hecho (ADR-097, migración `20261109600200_gastro_r2_anulacion_delivery`):** `void_delivery_order_item` + `delivery_order_voids`, regla de ítem enviado en `set_delivery_order_item_qty` y en un trigger, sin DELETE directo; la banda Anulado del KDS une mesa y delivery.*
  - [x] Separación de comandas por estación sin duplicar ítems. — *`kds_tickets(p_station)` (pantalla) y `comanda_items` + agrupado por estación en cliente (impresa): cada línea va a una sola estación, una comanda por estación.*
  - [x] *Criterio:* café va a barra, tostado a cocina y helado a estación heladería en tickets separados, con el mismo pedido. — *La comanda emite una hoja IMPRESA por estación (salto de página) del mismo pedido; en pantalla el KDS separa por estación.*

- [~] **H46 — KDS / pantalla de cocina y barra.** — *Núcleo hecho (local, pendiente de push): migración `20260608590000_kds` (`table_order_items.kds_status`/`kds_ready_at` + `products.station`; RPCs tenant-scoped `kds_tickets`/`set_item_kds_status` con guard de miembro activo). Pantalla **`/kds`** en route group propio (fullscreen, alto contraste, sin AppShell — para un monitor en cocina/barra; se abre con `window.open('/kds')` desde el Salón). Muestra los ítems de pedidos de mesa ABIERTOS pendientes/preparando/listo **agrupados por estación** (tabs `?station=` + "Todas") y dentro por mesa/pedido; cada tarjeta: mesa/salón, cantidad + ítem, modificadores, notas y **timer** desde la carga, con **alertas por demora** (>5 min ámbar, >10 min rojo). Botones para avanzar estado (pendiente → preparando → listo → entregado; "entregado" lo saca de la vista) y retroceder. **Tiempo real por polling** (`useQuery` con `refetchInterval` ~4s sobre `kds_tickets`, tenant-scoped por RLS). Probado por SQL (ítem con estación → aparece en `kds_tickets` de esa estación; avanzar a listo sella `ready_at`; entregado lo saca). **Follow-up (NO en este PR):** comanda IMPRESA por estación (H45 print), SLA configurable avanzado, cancelación parcial con re-impresión, KDS de barra físicamente separado, modo offline con cola de sincronización.*
  - [x] Vista KDS por estación con tarjetas de pedido en tiempo real. — *`/kds`, polling ~4s, tabs por estación.*
  - [~] Estados: nuevo, aceptado, preparando, listo, entregado, demorado, cancelado. — *Núcleo: pendiente → preparando → listo → entregado; "demorado" se refleja visualmente por el timer (ámbar/rojo). Aceptado/cancelado finos → follow-up.*
  - [x] Timers por estación, SLA configurable y alertas visuales por demora. *Timer por ítem + alertas (H46). **SLA por estación hecho (ADR-081, migración `20261105200200_kds_sla_estacion`):** `pos_settings.kds_sla` (default + por estación, minutos de atención y demora) validado por CHECK en la DB, editable por el dueño en Configuración → Salones y mesas (`KdsSlaCard`); el KDS lo aplica por tarjeta (`lib/gastro/kdsSla.ts`). Sin configurar sigue 5/10.*
  - [x] Agrupación por mesa/pedido, por estación, por curso/plato o por orden de llegada. *Ronda 2 (ADR-097, migración `20261109600100_gastro_r2_kds_cursos_prioridad`): dentro de cada pedido el KDS separa los ítems por curso, tiene vista **Por curso** (`?vista=curso`), muestra el próximo tiempo en espera (`kds_held_courses`) con botón **Marchar** y una columna de próximos tiempos para pedidos que todavía no tienen nada en cocina.* — *Por estación (tabs) y por mesa/pedido (columnas), orden de llegada FIFO. Por curso/plato: cada tarjeta del KDS muestra el **Tiempo N** del ítem (cursos / despacho por tiempos, local, pendiente de push — ver H47); agrupar columnas por curso → follow-up.*
  - [ ] Modo offline local con cola de sincronización cuando la red cae. — *Follow-up.*
  - [x] *Criterio:* cocina marca un plato como listo y el mozo/caja ve el cambio sin recargar. — *`set_item_kds_status` + polling: el estado se refresca solo (~4s) en el KDS y la cuenta de la mesa se invalida.*

- [~] **H47 — Menú gastronómico, modificadores y cursos.**. *Auditoría 2026-10-13: cursos, alergias y presets de modificadores hechos; menú por horario y notas en curso; combos y criterio pendientes.*
  - [~] Modificadores obligatorios/opcionales: punto de cocción, guarnición, salsa, leche, tamaño, sabor, topping, sin TACC, sin sal, extra. — *El motor de grupos de modificadores (obligatorio/opcional, min/max, +precio) ya existe desde F12·H37. Esta entrega suma un **catálogo de presets gastronómicos** (`lib/gastro/modifierPresets.ts`) que el dueño inserta con un toque en el editor de modificadores del producto (`ModifiersEditor` → selector "+ Preset gastronómico…"): clona el grupo + opciones (precio sugerido editable) y se guarda con el flujo normal de H37 (sin tabla ni API nueva, 100% cliente). Presets: punto de cocción, guarnición, salsa, tipo de leche, temperatura, tamaño café, tamaño helado, sabores, toppings, restricciones (sin TACC/sal/azúcar), extras y para-llevar. Test de integridad del catálogo (`tests/unit/modifier-presets.test.ts`). **Follow-up:** biblioteca de presets editable por tenant (guardar uno propio) y marca de alérgenos a nivel opción.*
  - [~] Menú por horario/canal: desayuno, almuerzo, merienda, cena, happy hour, delivery. — *Base hecha (local): **menús por franja** con horario y productos. Migración `20260609150000_gastro_menus` (aplicada en remoto): `menus` + `menu_windows` (día 0-6 + rango en minutos, hora local AR) + `product_menus` (asignación) con RLS tenant (escritura sólo owner/manager) + resolver **`active_menu_ids()`** (SECURITY INVOKER, vía RLS) que marca los menús vigentes según día+hora; menú sin ventanas = siempre disponible. UI: sección **Configuración → "Menús por horario"** (`MenusManager`, gateada por `dining_enabled`): CRUD de menús, franjas (día + desde/hasta), asignación de productos (buscador + checklist) y badge **"Activo ahora"** en vivo. Helper de tiempo puro y testeado (`lib/gastro/menuTime.ts` + `tests/unit/menu-time.test.ts`). **El POS YA filtra la carta por menú** (`MenuFilterBar` en `app/(app)/pos/page.tsx`, gateado por `dining_enabled` + menús cargados): barra "Menú" con "Todos" + cada menú, el vigente marcado "● ahora"; elegir un menú deja sólo sus productos asignados (combina con el filtro de categoría; esconde favoritos/frecuentes como el de categoría). Consume `active_menu_ids` + `product_menus`. **Follow-up:** auto-seleccionar el menú vigente al abrir el POS (hoy default "Todos", opt-in); menú por CANAL (mostrador/delivery) y ventanas que cruzan medianoche (happy hour 22→02).*
  - [x] Cursos/platos: entrada, principal, postre, bebida; enviar todo o "fire course" por etapa. — *Cursos / despacho por tiempos hecho (local, pendiente de push). Cada ítem del pedido lleva un **tiempo (`table_order_items.course`** smallint, 1=entrada/2=principal/3=postre…) y un **`fired_at`** (cuándo se disparó a cocina; null = "en espera"). Al cargar un ítem (`add_table_order_item` + params opcionales `p_course`/`p_hold`) se elige el tiempo y si va a cocina al toque (default, = flujo actual) o **en espera**. Disparar por etapa: **`fire_table_order_course(p_order_id, p_course)`** sella `fired_at` de los ítems en espera de ese tiempo (o de todos si `p_course` null = "disparar todo"); audita en `audit_logs` (`fire_course`). **Sólo lo disparado llega a cocina**: `kds_tickets` y `comanda_items` filtran `fired_at is not null` (lo en espera NO aparece en KDS/comanda). En la cuenta de la mesa (`TableAccountModal`) los ítems van **agrupados por tiempo** con selector para cambiar el tiempo de un ítem (`set_table_order_item_course`), badge "En espera · Tiempo N" y botón **"Disparar Tiempo N"** (+ "Disparar todo"); el picker permite elegir tiempo y hold. El **KDS y la comanda muestran el Tiempo N** en cada tarjeta/línea para la secuencia. Migración `20260608680000_dining_courses`; **backfill** `fired_at = created_at` de lo existente (lo ya cargado cuenta como ya disparado, nada se rompe). **Follow-up (NO en este PR):** tiempos automáticos por timer, sugerencia de curso por categoría de producto, "llamar postre" como notificación push, coordinación multi-estación del mismo curso.*
  - [~] Notas por ítem y notas generales de pedido. — *Nota por ítem hecha (local): el picker de mesa (`TableProductPicker`) y de delivery (`DeliveryProductPicker`) cargan una **nota libre** por ítem (se aplica al ítem que se agrega y se limpia después); ya viajaba en `add_*_order_item(p_notes)` y se ve en KDS, comanda y la cuenta. **Nota general del pedido** ya existe en DB (`table_orders.notes` / `delivery_orders.notes`, esta última editable en el alta del delivery); editor dedicado de la nota general de mesa → follow-up.*
  - [x] Alergias/intolerancias destacadas en comanda y KDS. — *Hecho (local). Campo estructurado `allergens` (texto libre corto) por ítem de mesa y de delivery (migración `20260609140000_dining_item_allergens`, aplicada en remoto): columnas nuevas + `add_table_order_item`/`add_delivery_order_item` ganaron `p_allergens` (OPCIONAL, al final; se elimina el overload viejo) + `kds_tickets`/`comanda_items`/`delivery_comanda_items` devuelven `allergens`. Se carga en los dos pickers (campo aparte de la nota). **DESTACADA**: en el KDS, recuadro **rojo** con ⚠ y MAYÚSCULAS arriba de la nota; en la **comanda impresa** (térmica B/N), recuadro de borde grueso + ⚠ + negrita; en la cuenta de mesa/delivery, chip rojo. Es seguridad alimentaria, no una nota más. **Follow-up:** editar la alergia de un ítem ya cargado (hoy se setea al agregar), catálogo de alérgenos predefinidos y marca de alérgenos a nivel producto.*
  - [~] Combos y menús cerrados sin obligar al cajero a tocar 20 botones. *Combo a precio fijo por juego completo con el motor de promociones (ADR-074). Falta el flujo guiado de menú cerrado (elegir entrada, principal y bebida en un paso).*
  - [ ] *Criterio:* "menú ejecutivo entrada + principal + bebida" se carga en un flujo guiado y cocina recibe cada curso correcto.

- [~] **H48 — Cafetería, heladería y mostrador híbrido.** — *Base hecha (local): tipo de pedido **mostrador** reutilizando la infra de delivery (sin dirección/cadete/envío). Falta el "cobrar antes" (que mantiene el pedido en el KDS tras cobrar → requiere tocar `create_sale`) y el pager.*
  - [~] Flujo de mostrador con nombre del cliente, número de orden o pager. — *Hecho: nuevo `order_type='mostrador'` en `delivery_orders` (migración `20260609190000_mostrador_orders`, aplicada en remoto) — `create_delivery_order` y `set_delivery_status` aceptan mostrador (tratado como takeaway: sin dirección/envío, estados recibido→preparando→listo→entregado). Alta desde el board `/delivery` (botón **Mostrador** en `DeliveryOrderModal`, con nombre del cliente; número de orden = etiqueta **"MOSTRADOR #XXXX"** del backend). Filtro y columnas de mostrador en el board. **Pager** → follow-up (campo dedicado).*
  - [~] Pedido abierto: cobrar antes, enviar comanda y marcar listo para retirar. — *Enviar comanda (KDS/impresa) ✓ y marcar listo ✓ (estados del board). **Cobrar ANTES manteniendo el pedido en el KDS** → follow-up: hoy el cobro va por el flujo de delivery (`/pos?delivery=`) que marca entregado; el "pay-first" requiere que `create_sale` deje el pedido en preparación tras cobrar.*
  - [x] Modificadores de cafetería: tamaño, tipo de leche, temperatura, extra shot, syrup, para llevar/en taza. — *Cubierto por los **presets de modificadores gastronómicos** (H47, ya en prod): tipo de leche, temperatura, tamaño café, para llevar/en local, extras. (Syrup = sumar opción al preset Extras.)*
  - [x] Modificadores de heladería: tamaño, cantidad de sabores, topping, cucuruchos, balanza opcional. — *Cubierto por los presets (H47): tamaño helado, sabores (con máx.), toppings. Cucuruchos = opción de Extras; balanza (peso) ya existe por producto (`unit`).*
  - [x] Cola de preparación visible para barra/heladería. — *El KDS (`/kds`) muestra los ítems de mostrador (etiqueta "MOSTRADOR #XXXX" + nombre) agrupados por estación, igual que mesa/delivery.*
  - [~] *Criterio:* se cobra "latte mediano leche vegetal + medialuna" y barra ve el pedido con nombre del cliente. — *Barra ve el pedido de mostrador con nombre + ítems + modificadores en el KDS ✓. El "se cobra ANTES y sigue visible" queda con el follow-up de `create_sale`.*

- [~] **H49 — Delivery, take away y despacho gastronómico.** — *Núcleo hecho (local, pendiente de push): HERMANO de H44 (mesas) pero SIN mesa. Migración `20260608720000_delivery_orders` (tablas `delivery_orders` + `delivery_order_items` espejando `table_orders`/`table_order_items` — mismas columnas KDS/comanda/cursos; RLS tenant-scoped; gating `pos_settings.delivery_enabled` default false + `useDeliveryEnabled`). RPCs SECURITY DEFINER tenant-scoped (guard `_dining_assert_member`): `create_delivery_order` / `add_delivery_order_item` (FOR UPDATE + snapshot de station, igual que H44) / `set_delivery_order_item_qty` / `set_delivery_status` (transiciones válidas por tipo + audit) / `assign_courier` / `cancel_delivery_order` / `fire_delivery_order_course`. **KDS unificado:** `kds_tickets` y la comanda ahora UNEN mesa + delivery con etiqueta de origen (`source` 'mesa'/'delivery' + `source_label` "Mesa 5" / "DELIVERY #1234" / "TAKEAWAY #1234"); preserva `fired_at not null`, excluir 'entregado', orden FIFO; `set_item_kds_status` resuelve mesa o delivery. **Cobro atómico:** `create_sale` ganó `p_delivery_order_id` que ESPEJA EXACTO la rama de mesa (FOR UPDATE del pedido al inicio → aborta si ya cobrado/cancelado; al final enlaza `sale_id` + marca 'entregado' + audit, misma TX → sin doble cobro). El costo de envío entra como LÍNEA del carrito ("Costo de envío"); `create_sale` no calcula el fee (totales/redondeo/stock intactos). Mostrador (todos null), QR y la rama de mesa quedaron INTACTOS (probado por SQL). **Board `/delivery`** (kanban por estado, gateado por `delivery_enabled`, independiente de las mesas): tarjetas con cliente/tel/dirección/canal/horario prometido/cadete/total; avanzar estado, abrir cuenta, alta de pedido. **Alta** (`DeliveryOrderModal`): canal + tipo (delivery/takeaway), cliente existente o suelto (nombre+tel), dirección+referencia (sólo delivery), horario prometido, costo de envío. **Cuenta** (`DeliveryAccountModal`): ver/editar ítems (picker estilo `TableProductPicker`), asignar cadete, cobrar (link `/pos?delivery=<id>` que carga ítems + envío y cobra atómico, espejando `?table=`). Nav: entrada **Delivery** gateada por `delivery_enabled`. Probado por SQL (crear → ítem en KDS con etiqueta delivery → cobro atómico fee incluido, 2º intento `delivery_order_not_open` → estados; takeaway rechaza `en_camino`; mostrador/mesa intactos). **Follow-up (NO en este PR):** integración marketplace (PedidosYa/Rappi/MercadoLibre/TiendaNube), tracking GPS del cadete, mapa/geocoding de direcciones, zonas de envío con tarifa automática, tiempos automáticos por estado, notificación al cliente por WhatsApp del estado, comanda IMPRESA / etiqueta de despacho de delivery (la comanda impresa sigue siendo de mesa; `delivery_comanda_items` ya existe en DB para cuando se sume).*
  - [x] Pedidos con canal: mostrador, teléfono, WhatsApp, QR, delivery propio, marketplace futuro. — *Canal en `delivery_orders.channel` (mostrador/telefono/whatsapp/qr/delivery_propio); marketplace → follow-up.*
  - [x] Datos por pedido: cliente, teléfono, dirección, referencia, horario prometido, cadete/repartidor, costo de envío. — *Todos en `delivery_orders` + alta + cuenta.*
  - [x] **H49 follow-up — Zonas de envío con tarifa automática.** — *Local, pendiente de push. Migración `20260608730000_delivery_zones`: tabla `delivery_zones` (nombre, `fee`, `eta_minutes` opcional, `is_active`, `sort_order`, baja lógica) con RLS tenant-scoped — lectura por miembros, **escritura sólo owner/manager** (espeja `tenant_branding`, enforced server-side; probado por SQL que cashier no puede insertar/actualizar). `delivery_orders.zone_id` (FK on delete set null). `create_delivery_order` ganó `p_zone_id`: al tomar un pedido de delivery, elegir la zona **autocompleta el costo de envío** con su tarifa y lo **snapshotea** en `delivery_orders.delivery_fee` (cambiar la tarifa de la zona después NO altera pedidos viejos — probado por SQL); el fee queda **editable** (override manual gana sobre la zona). Takeaway ignora zona (envío 0). Gestión de zonas en **Configuración → Zonas de envío** (`ZonasManager`, gateada por `delivery_enabled`); selector de zona en el alta (`DeliveryOrderModal`, sólo si hay zonas cargadas — si no, el fee manual sigue como antes); zona/eta visibles en la tarjeta del board y en la cuenta. **Sigue follow-up (NO en este PR):** geocoding/mapa, detección automática de zona por dirección/GPS, polígonos, tarifa por distancia/peso, mínimos por zona.*
  - [~] Estados: recibido, aceptado, en preparación, listo, en camino, entregado, cancelado. — *Delivery: recibido → preparando → en_camino → entregado (+ cancelado). Takeaway: recibido → preparando → listo → entregado (+ cancelado). "Aceptado" fino → follow-up.*
  - [~] Comanda a cocina y ticket/etiqueta para despacho. — *A cocina vía KDS unificado (el pedido aparece con su identificador delivery). **Comanda IMPRESA de delivery/takeaway hecha (local, pendiente de push):** botón "Imprimir comanda" en la cuenta del pedido (`DeliveryAccountModal`) → reusa `ComandaModal` generalizado (`source="delivery"`) con `delivery_comanda_items` + `mark_delivery_comanda_printed`; encabezado "DELIVERY/TAKEAWAY #1234" + cliente/teléfono/dirección/horario/cadete, agrupado por estación, sin precios, "sólo lo nuevo"/"reimprimir todo" + anti-reimpresión idempotente. Etiqueta de despacho específica → follow-up.*
  - [ ] Integración futura con PedidosYa, Rappi, Mercado Libre/Tienda Nube cuando aplique. — *Follow-up.*
  - [x] *Criterio:* una rotisería toma pedido telefónico, cocina lo prepara, despacho lo marca en camino y caja lo concilia. — *Alta telefónica → KDS prepara → board marca "en camino" → cobro atómico desde el pedido (caja). Probado por SQL.*

- [~] **H50 — Inventario gastronómico, recetas y merma básica.** — *Hechos: receta/escandallo + costo y margen por plato, y **merma tipada** (ver sub-ítems). Falta descuento de insumos al vender, producción/batch y alertas.*
  - [x] Recetas/escandallo por producto: ingredientes, cantidad, unidad y costo estimado. — *Hecho (local). Migración `20260609160000_product_recipes` (aplicada en remoto): tabla `product_recipes` (ingrediente texto + qty + unit + unit_cost, RLS por tenant, una policy como el resto del dominio de producto). UI: sección plegable **"Receta / escandallo (costo y margen)"** en la ficha del producto (`RecipeEditor`, espeja `ModifiersEditor`): filas ingrediente/cantidad/unidad/costo-unitario, costo por línea, y resumen **costo del plato + precio + margen** ($ y %, rojo si se vende bajo costo) calculado en vivo. Helpers puros y testeados (`recipeCost`/`marginAmount`/`marginPct` en `modules/products/recipes.ts` + `tests/unit/recipe-cost.test.ts`). Modelo v1: ingrediente como texto libre; vincularlo a un producto de stock → follow-up (habilita el descuento al vender).*
  - [ ] Descuento de insumos al vender cuando el tenant lo active.
  - [~] Producción/preparación previa: batch de helado, masa, prep de cocina, stock de barra. — *Hecho (local): acción **"Registrar producción"** por producto en /productos (`ProductionModal`: cantidad producida + notas) que **suma** ese stock al producto preparado vía RPC `register_production` (SECURITY INVOKER + RLS, espeja la merma pero como ingreso; movimiento con `reason='production'`). Migración `20260609200000_stock_production` (aplicada en remoto). `ProductionSchema` + `productsApi.registerProduction` + `useProductMutations().registerProduction`. **Follow-up:** descontar los insumos de la receta al producir (cuando el insumo se vincule a un producto de stock — hoy las recetas usan ingrediente como texto libre).*
  - [x] Merma: vencido, roto, devolución, preparación fallida. — *Hecho (local). El ajuste de stock ya tenía el motivo genérico `loss` ("Merma"); esta entrega suma **merma tipada**: columna `stock_movements.loss_reason` (vencido/roto/preparacion_fallida/devolucion/otro) + RPC `register_stock_waste(p_product_id, p_qty, p_loss_reason, p_notes)` (SECURITY INVOKER + RLS, espeja `adjust_product_stock`: descuenta `qty` del stock e inserta el movimiento con `reason='loss'` + sub-motivo). Migración `20260609170000_stock_waste` (aplicada en remoto). UI: acción **"Registrar merma"** por producto en /productos (`MermaModal`: cantidad perdida + motivo tipado + notas; muestra el nuevo stock). Schema `WASTE_REASONS`/`MermaSchema` + `productsApi.registerWaste` + `useProductMutations().registerWaste`. **Follow-up:** mostrar el sub-motivo de merma en el historial de stock y un reporte de mermas por período/motivo.*
  - [~] Alertas de insumos críticos y reporte de margen por plato.. *Auditoría 2026-10-13: el **margen por plato** ya está (H52, `gastro_top_items_report` con costo de receta, migración `20260609180000_gastro_top_margin`, y el resumen de margen en `RecipeEditor`). Las alertas de insumos críticos siguen pendientes (los ingredientes de receta son texto libre, sin stock propio).*
  - [ ] *Criterio:* vender 10 combos descuenta insumos configurados y muestra margen estimado.

- [~] **H51 — Reservas gastronómicas, waitlist y ocupación.** — *Núcleo local: agenda de reservas con sentar y seña. `dining_reservations` + RPCs `create_reservation` / `set_reservation_status` / `cancel_reservation` / `seat_reservation` (SECURITY DEFINER tenant-scoped, search_path fijo) en `supabase/migrations/20260609120000_dining_reservations.sql`. UI `/reservas` (agenda hoy / próx. 7 días, alta con picker de cliente optimizado, confirmar / cancelar / no-show / sentar), gateada por `dining_enabled` (toggle del dueño, no plan), nav en AppShell.*
  - [x] Reservas por mesa/sector/capacidad, fecha, hora, duración estimada y seña opcional. — *`dining_reservations`: area_id/table_id/party_size/reserved_at/duration_minutes/deposit_amount; alta en `ReservationModal`.*
  - [x] Lista de espera con prioridad y aviso por WhatsApp/email futuro. *Hecho (ADR-081, migración `20261105200300_lista_espera`): `dining_waitlist` (nombre, teléfono, comensales, prioridad, espera prometida; estados esperando/avisado/sentado/cancelado/se_fue), alta por RLS de miembro y cambios por RPC (`set_waitlist_status`, `seat_waitlist_entry` que abre la mesa y deja la nota en el pedido). UI: pestaña **Lista de espera** en `/reservas` (`WaitlistPanel`): posición, minutos contra lo prometido, **Avisar** por link de WhatsApp manual (`wa.me`) y sentar en la mesa libre sugerida por capacidad. Aviso automático por WhatsApp/email y alta pública por QR: follow-up. **Aviso automático hecho (ADR-097, migración `20261109600300_gastro_r2_aviso_lista_espera`):** al liberarse una mesa, un trigger deja un aviso pendiente (`dining_waitlist_notices`) para el primer grupo que entra, con el mensaje armado; el salón y la lista de espera lo muestran y el mozo lo manda por WhatsApp (link `wa.me`, sin proveedor) o lo descarta. Envío, descarte y aviso manual quedan registrados y auditados. Email y alta pública por QR siguen pendientes.*
  - [x] Turnover de mesas: tiempo sentado, tiempo sin ordenar, tiempo desde cuenta pedida. *Hecho (ADR-081, migración `20261105200400_rotacion_mesas_mozos`): `table_orders.bill_requested_at` y `closed_at` por triggers (sin recrear `create_sale`), `gastro_turnover_report` (global y por mesa) en `/reportes` → "Rotación de mesas, mozos y propinas" + hoja XLSX "Gastro · Rotación".*
  - [x] Bloqueo de mesas por evento, mantenimiento o configuración del salón. — *Estado `reservada` en `dining_tables`: una reserva con mesa asignada la bloquea; al sentar pasa a ocupada, al cancelar/no_show vuelve a libre. (Bloqueo manual por mantenimiento ya existía vía `bloqueada`.)*
  - [x] *Criterio:* una reserva bloquea mesa/sector, luego se convierte en mesa ocupada y conserva cliente/seña. — *`seat_reservation` reusa `open_dining_table` (abre la mesa → ocupada), enlaza `table_order_id`, marca la reserva `sentada` y conserva cliente/comensales/seña (snapshot en la reserva + notas del pedido). Probado por SQL (crear → confirmar → sentar → cancelar/no_show, con ROLLBACK).*

- [~] **H52 — Reportes gastronómicos y operación.** — *Núcleo (local). RPCs tenant-scoped `gastro_tables_report` / `gastro_kitchen_report` / `gastro_delivery_report` / `gastro_top_items_report` (SECURITY DEFINER, search_path fijo, agregan EN SQL) + sección "Gastronomía" en `/reportes` (gateada por `dining_enabled || delivery_enabled`) con tabla/chart por sub-bloque, estados vacíos y export XLSX (gateado por `export_xlsx`). Migración `20260609130000_gastro_reports.sql`. Probado por SQL (datos sintéticos + cleanup).*
  - [x] Ventas por mozo, mesa, sector, estación, canal, producto. — *`gastro_tables_report` (salón/mesa/mozo + ticket prom. + rotación = pedidos cerrados), `gastro_delivery_report` (canal/zona/tipo), `gastro_top_items_report` (estación/curso). Modificador y horario fino → follow-up.*
  - [x] Tiempos: pedido a cocina (pendiente→listo) por estación y global, rotación de mesa. — *`gastro_kitchen_report` (avg/min/máx de `created_at`→`kds_ready_at`, mesa + delivery). "Listo→entregado", cancelaciones/reimpresiones/comandas demoradas → follow-up.*
  - [x] Top productos por estación y curso/tiempo. — *`gastro_top_items_report` (qty + importe, mesa + delivery).*
  - [x] Margen por plato si hay recetas. — *Hecho (local). `gastro_top_items_report` suma `cost` + `margin` por ítem del top: joinea el costo de receta (`product_recipes`, H50) por `product_id` y agrega `cost = qty × costo unitario`, `margin = importe − costo` (migración `20260609180000_gastro_top_margin`, aplicada en remoto, aditiva sobre el jsonb). El reporte (/reportes → "Top ítems") muestra columna **Margen** (sólo cuando el producto tiene receta; si no, "—") y el export XLSX agrega Costo (receta) + Margen. Productos sin receta → costo 0.*
  - [x] Export XLSX. — *Hojas gastro por salón/mesa/mozo/cocina/delivery(canal,zona)/top, gateadas por export_xlsx + el modo del tenant.*
  - [x] Propinas por mozo con reparto. *Hecho (ADR-081): `table_orders.waiter_user_id` guarda el mozo del pedido (sobrevive al cobro); `gastro_turnover_report.by_waiter` suma vendido y propinas (`sales.tip_amount`); el reporte reparte "cada mozo lo suyo" o "pozo común" en partes iguales al centavo (`lib/gastro/tips.ts`) y exporta la hoja "Gastro · Propinas".*
  - [x] *Criterio:* el owner identifica cuellos de botella de cocina/barra y productos con más margen. — *Cuellos de cocina/barra ✓ (tiempos por estación, `gastro_kitchen_report`). Productos con más margen ✓ (columna Margen en el top de ítems, derivada de las recetas H50).*

### F9 — Motor de promociones PRO

Objetivo: igualar o superar a los POS líderes (Square, Lightspeed, Toast, Fudo, Shopify POS) en promociones. Motor **declarativo** (reglas sin código), evaluado en el carrito en tiempo real, auditable y combinable. Configurable 100% por el dueño desde el panel.

- [x] **H53 — Núcleo del motor de reglas.** — *COMPLETO (ADR-074): motor declarativo con dos implementaciones con paridad probada (`lib/promotions/engine.ts` y `_promo_eval_core` en SQL, matriz `tests/fixtures/promoMatrix.ts`), cálculo **autoritativo en `create_sale`** (antes del cupón, impuestos, percepciones y recargos de cuotas; rechaza un monto distinto con `promo_mismatch`), combinables o excluyentes con mejor precio para el cliente, topes por ticket y por cliente. Segmentos de cliente quedan en H55.*
  - [x] Modelo declarativo: **condiciones** (productos, categorías, marcas, cantidad, monto, cliente/segmento, día/horario, canal, sucursal, medio de pago) → **acciones** (% descuento, monto fijo, precio fijo, producto bonificado, envío/recargo). — *ADR-074: alcance por categorías, productos o **marcas** con varios ids (`scope_ids`); condiciones de vigencia, días, franja, **sucursal** (`store_ids`, vacío = todo el negocio, herencia negocio → sucursal), **lista de precios**, medio de pago, **marca de tarjeta** y **banco**, compra mínima y topes de usos totales y por cliente; acciones %, monto, precio fijo del total, NxM, 2ª unidad, escalas, **combo a precio fijo** y regalo. Segmento de cliente y canal: H55 y F16. Recargos: F11/F14 (las promos van antes de los recargos de cuotas).*
  - [x] Evaluación en el carrito en vivo, con prioridad, **combinables o exclusivas**, y tope de descuento. — *ADR-074: acumulables por prioridad (cada una sobre lo que dejó la anterior) contra la mejor excluyente; gana lo que más descuenta. Tope por ticket (`max_discount`). El POS muestra cada promo en su línea del carrito y en los totales; `create_sale` recalcula y guarda cada una en `sale_promotions`; el ticket imprime una línea por promo.*
  - [x] Vigencia por fecha/horario (usa el calendario unificado de TX). — *Vigencia por fecha (`valid_from`/`valid_to`), día de semana y franja horaria (minutos), resuelta por el motor contra el contexto local AR. Inputs de fecha/hora en el admin.*
  - [x] *Criterio:* "Miércoles 30% en bebidas de 18 a 21hs" se configura sin código y aplica solo en ese rango. — *Se configura sin código y el motor + POS lo aplican en la venta dentro del rango, incluido el alcance por **categoría** ("bebidas"): la categoría de cada producto viaja con la línea del carrito.*

- [x] **H54 — Catálogo de tipos de promoción.** — *COMPLETO: NxM, precio fijo (combo), 2º ítem, **% por volumen escalonado**, **condición por medio de pago**, **regalo por compra** y **cupones/códigos** — todos en motor/backend + admin + POS.*
  - [x] **2x1 / 3x2 / NxM**, **% por volumen** (escalonado), **combos/bundles** a precio especial, **descuento por segundo ítem**, **precio por pack**, **regalo por compra** (gift with purchase), **descuento por medio de pago**, **happy hour**, **liquidación por temporada**. — *Hecho (local): **NxM** (`action_type='nxm'` con `buy_qty`/`pay_qty`; libera las unidades más baratas de cada grupo de N) y **precio fijo / combo** (`action_type='fixed_price'`; el alcance pasa a costar X). Migración `20260609220000_promotion_nxm_fixed` (aplicada en remoto): columnas `buy_qty`/`pay_qty` + CHECK de `action_type` extendido + coherencia NxM. Motor (`lib/promotions/engine.ts`) y admin (`PromotionsManager`) soportan los tipos; tests en `promo-engine.test.ts`. **Descuento por 2º ítem** hecho (`action_type='second_item'`: en cada par del alcance, el más barato con X% off; migración `20260609240000_promotion_second_item`, aplicada en remoto). **% por volumen escalonado** hecho (`action_type='volume_tier'`: el % sube por tramos de cantidad del alcance; el motor aplica el tramo más alto que el carrito alcanza; tramos en `promotions.volume_tiers jsonb`; migración `20260609260000_promotion_volume_tier`, aplicada en remoto; admin con editor de tramos; corre en POS y simulador). **Descuento por medio de pago** hecho como **condición** (`promotions.payment_method`: la promo sólo aplica al cobrar con ese medio; cualquier action_type puede condicionarse; migración `20260609270000_promotion_payment_method`, aplicada en remoto). El motor lo evalúa con `PromoContext.paymentMethod`; el POS reevalúa al elegir el medio en el cobro y baja el total, sin tocar `create_sale` (reusa el canal de promo). **Regalo por compra** hecho (`action_type='gift'` con `gift_product_id`/`gift_qty`): al calificar, el POS agrega solo una línea a $0 del producto regalado (la pone/quita el motor `evaluateGifts`; convive con una promo de descuento; si no hay stock no se ofrece); descuenta stock vía create_sale como ítem normal, sin tocar create_sale; migración `20260609290000_promotion_gift`, aplicada en remoto. **Happy hour** = franja horaria (ya en H53); **liquidación por temporada** = rango de fechas (H53). **Catálogo de tipos completo** (sólo queda cupones, sub-ítem aparte).* **ADR-074:** combos con varios productos y unidades por juego (`bundle`), promos por tarjeta y banco con días y horarios, todo validado en el servidor.
  - [x] **Cupones / códigos** (únicos o multiuso, con límite de usos, por cliente o global). — *Hecho. Tablas `coupons` + `coupon_redemptions` (% o monto fijo, monto mínimo, vigencia, tope total + tope por cliente). Admin en **Configuración → "Cupones"** (`CouponsManager`). POS: el cajero ingresa el código → `validate_coupon` (preview read-only) → descuento en vivo; **excluyente** con la promo de descuento (los regalos conviven). **Límite de uso ATÓMICO** en `create_sale` (lock `FOR UPDATE` + cómputo autoritativo + registro de canje en la misma transacción → no se puede reusar de más; verificado end-to-end). Migraciones `20260609310000_coupons` + `20260609320000_create_sale_coupon`, aplicadas en remoto.*
  - [x] *Criterio:* cada tipo tiene su preset configurable y un ejemplo de demo. — *ADR-074: asistente de Configuración → Promociones con 9 tipos, cada uno con su ejemplo en lenguaje simple y valores por defecto, y vista previa "así se ve en el ticket" calculada con el mismo motor.*

- [~] **H55 — Segmentación y fidelización.** *Parcial: saldo a favor y lista de precios por cliente; faltan reglas por segmento, fidelización y gift cards.*
  - [~] Reglas por **segmento de cliente** (nuevos, frecuentes, cumpleaños, lista mayorista). *Parcial: grupos de clientes (`20260601100000_customer_groups`) y lista de precios por cliente (`components/customers/CustomerPricingFields.tsx`); faltan reglas de promo por segmento (nuevos, frecuentes, cumpleaños).*
  - [ ] Base para **fidelización**: puntos, niveles, recompensas canjeables (gancha con cuenta corriente de clientes).
  - [~] **Gift cards** y saldo a favor. *Parcial: saldo a favor (vale) como medio de pago validado en `create_sale` (`20260531280000_store_credit_payment`); faltan gift cards.*
  - [~] *Criterio:* un cliente "VIP" recibe automáticamente un precio/beneficio distinto en el POS. *Parcial: un cliente con lista de precios propia recibe ese precio en el POS; falta el beneficio automático por segmento.*

- [~] **H56 — Gobierno, simulación y reporte de promociones.** — *Hechos el simulador, el **reporte de performance** y su **export XLSX** (ver sub-ítems). Falta sólo **tope/aprobación**.*
  - [x] **Simulador**: previsualizar el efecto de una promo sobre ventas históricas antes de activarla. — *Hecho (local). Botón **"Simular impacto"** por promo en Configuración → "Promociones" (`PromotionSimModal`): elegís un rango y corre la promo (con el motor PURO, aun en borrador/inactiva) contra las ventas del período → muestra **tickets analizados / tickets con la promo / descuento total estimado / % sobre lo vendido**. Read-only, no modifica nada. Backend: RPC `promotion_sim_data(p_from, p_to, p_limit)` (SECURITY DEFINER, filtro explícito por tenant; arma por venta el contexto AR + líneas con categoría; cap 5000; migración `20260609230000_promotion_sim_data`, aplicada en remoto). Función pura `simulatePromotion` en `lib/promotions/engine.ts` + test. **Follow-up:** desglose por día/producto y guardar simulaciones.*
  - [~] **Tope de impacto** y aprobación (rol manager/owner), todo auditado. — *ADR-074: tope de descuento por ticket y topes de usos (totales y por cliente) validados en `create_sale` con lock por promo; alta, edición, pausa y baja auditadas (`promotion_created` / `_updated` / `_activated` / `_deactivated` / `_deleted`) y escritura sólo de dueño o encargado con la feature. Falta la aprobación previa (maker-checker, F14/H63).*
  - [x] **Reporte de performance** por promoción (uso, descuento otorgado, margen, incremental). — *Hecho. Botón **"Rendimiento"** en Configuración → "Promociones" (`PromotionPerfModal`): por período, por promo de descuento → ventas que la usaron + descuento otorgado + facturación + % sobre lo vendido + totales. RPC `promotion_performance(p_from, p_to)` (SECURITY DEFINER, tenant-scoped; migración `20260609300000_promotion_performance`, aplicada en remoto). **Follow-up:** margen (necesita costo por ítem de la venta) e incremental; las promos de **regalo** todavía no se trackean acá (no setean `promo_id`).*
  - [x] Export en **XLSX** (ver TX) y al catálogo/canales. — *Export XLSX del reporte de rendimiento (reusa `lib/utils/xlsx`). Export al catálogo/canales → fuera de alcance (no hay integración de canales aún).*
  - [~] *Criterio:* el dueño ve cuánto descuento otorgó cada promo y su impacto en margen. — *Ve cuánto descuento otorgó cada promo (uso + descuento + facturación + % sobre vendido) y lo exporta. El **margen** por promo es follow-up (requiere costo por ítem).*

### F14 — Motor comercial enterprise

Objetivo: convertir la configuración comercial en un sistema central y auditado: planes, cuotas, recargos, impuestos, costos, reglas, inventario avanzado, compras, offline completo, omnicanal, API y analítica. F11 cubre retail avanzado; F14 lo vuelve **enterprise, versionado, simulable y gobernado**. Ver [`27-commercial-configuration-engine.md`](./27-commercial-configuration-engine.md).

- [~] **H57 — Jerarquía de configuración y precedencia.** *Parcial (ADR-049): herencia negocio, grupo, sucursal y caja con origen por campo; faltan plan, rubro, canal, rol, usuario y campaña como niveles.*
  - [~] Niveles: global NinjaSoft → plan → tenant → rubro → sucursal → caja → canal → rol → usuario → horario/campaña. *Parcial: negocio, grupo de sucursales, sucursal y caja (`config_overrides`, ADR-049); el resto de los niveles no existe.*
  - [x] Resolución de valor efectivo con explicación: "este recargo viene de tenant, sobrescrito por sucursal". *Hecho: `effective_config` devuelve valor y origen por campo (ADR-049); `components/config/ScopedConfig.tsx` muestra "Heredado de ...".*
  - [ ] Conflictos detectados antes de guardar.
  - [x] *Criterio:* un owner ve por qué una caja usa una regla distinta y puede volver al default sin SQL. *Hecho: origen por campo y "Volver a heredar" en `components/config/ScopedConfig.tsx` (`config_override_reset_field`, ADR-049).*

- [~] **H58 — Planes, cuotas, add-ons y entitlements enterprise.** *Parcial: plan custom por tenant, addons, módulos y límites duros; faltan límites blandos, medición general y política de exceso.*
  - [~] Plan base, plan custom por tenant, add-ons, paquetes de módulos, límites blandos/duros y medición de uso. *Parcial: plan custom (`20260607150000_custom_plans_overrides_discounts`), addons (`20260608110000_features_plans_addons`), módulos en `plans.limits.modules`, límites duros y uso medido sólo del asistente IA (`ai_usage`); faltan límites blandos y medición general.*
  - [~] Cuotas configurables: usuarios, sucursales, cajas, productos, ventas, comprobantes AFIP, almacenamiento, mensajes, integraciones, API calls. *Parcial: usuarios, sucursales, cajas por sucursal y productos con tope por plan validado en triggers (`20261013100000_sucursales_cajas`) y mensajes de IA (`ai_usage`); faltan ventas, comprobantes, almacenamiento, integraciones y API calls.*
  - [ ] Exceso de uso: aviso, grace period, upgrade sugerido, cargo adicional o bloqueo gradual según política.
  - [ ] *Criterio:* internal crea un plan específico para un cliente con 8 sucursales, add-on gastronómico y límite de 100.000 ventas/mes.

- [~] **H59 — Recargos, financiación, tasas y redondeos por contexto.** *Parcial: cuotas y recargos por medio, marca, proveedor y sucursal; faltan horario, ticket mínimo, rol y CFT.*
  - [~] Recargos/descuentos por medio, marca, adquirente, plan de cuotas, canal, sucursal, horario, ticket mínimo y rol. *Parcial: por medio, marca, proveedor, plan de cuotas y sucursal (`payment_plans`, `payment_plans.store_id` ADR-057, recargo por caja o sucursal en `config_overrides` ADR-049); faltan canal, horario, ticket mínimo y rol.*
  - [~] Configuración de financiación: interés compuesto/simple, cuotas sin interés absorbidas por comercio, costo financiero total visible, vigencia y topes. *Parcial: planes de cuotas con recargo y vigencia (`20260608500000_card_plans_validity_voucher`); faltan tipo de interés, cuotas absorbidas explícitas, CFT y topes.*
  - [~] Service charge, propina sugerida, fee delivery, cargo por packaging, impuesto/tasa local y redondeo por moneda. *Parcial: propina (`20260608550000_commissions_tips`), fee de delivery (`20260608750000_delivery_fee_enforce`) y redondeo de la configuración efectiva; faltan service charge, packaging y tasa local.*
  - [~] Transparencia: todo recargo aparece antes de cobrar y en ticket/comprobante cuando corresponda. *Parcial: el recargo se muestra en la hoja de cobro antes de cobrar (`lib/pos/checkoutMath.ts`, `components/pos/checkout/CheckoutSheet.tsx`); falta verificar su línea en el comprobante.*
  - [ ] *Criterio:* "Visa 6 cuotas +18%" aplica solo en sucursal A, de lunes a viernes, con simulación del total antes de cobrar.

- [~] **H60 — Motor de reglas comerciales unificado.** *Auditoría 2026-10-13: no hay un motor único; las piezas existen por separado (promociones ADR-074, listas PRO ADR-058, planes de cuotas ADR-057).*
  - [~] Condiciones/acciones para precio, descuento, recargo, comisión, límite, alerta, bloqueo o sugerencia. *Parcial: descuento y precio con condiciones en promociones (ADR-074, `lib/promotions/engine.ts`), precio por cliente y por escala en listas PRO (`price_list_assignments`, `price_list_breaks`, ADR-058) y recargo por plan de cuotas (`payment_plans`); faltan comisión, límite, alerta, bloqueo y sugerencia como acciones de una misma regla.*
  - [~] Prioridad, exclusividad, combinabilidad, vigencia, audiencia, test A/B y simulador con ventas históricas. *Parcial: prioridad, excluyente o acumulable, vigencia y simulador contra ventas reales en promociones (`promotions.priority`, `stackable`, `components/promotions/PromotionSimModal.tsx`, ADR-074); faltan audiencia por segmento y test A/B.*
  - [ ] Unifica promociones F9, recargos F11, planes F7/F14, comisiones F12 y reglas gastronómicas F13.
  - [ ] *Criterio:* una regla "mayorista paga transferencia sin recargo y 5% menos desde 20 unidades" se configura sin código.

- [~] **H61 — Facturación SaaS, dunning y ledger de cobros NinjaSoft.** *Parcial: pagos registrados y dunning automático con reactivación; faltan ledger completo y aumentos segmentados.*
  - [~] Ledger interno por tenant: cargos, créditos, descuentos, impuestos, pagos, deuda, vencimientos y recibos. *Parcial: `billing_records` append-only con pagos registrados por staff (`20260604200000_billing_records`); faltan cargos, créditos, deuda y recibos.*
  - [~] Dunning configurable: aviso preventivo, vencido, grace period, suspensión parcial, suspensión total y reactivación. *Parcial: aviso preventivo, vencido, gracia de 3 días configurable, suspensión y reactivación reanclando el período (`20260608130000_saas_dunning`, `20260608350000_dunning_3day_grace_reanchor`); falta suspensión parcial.*
  - [~] Aumentos masivos segmentados con preview, exclusiones, aceptación requerida y notificaciones automáticas. *Parcial: aviso automático a los suscriptos al subir el precio de un plan (`internal_save_plan` en `20260608130000_saas_dunning`); faltan segmentación, exclusiones, preview de MRR y aceptación.*
  - [ ] *Criterio:* billing programa aumento del 20% para planes Pro, excluye clientes con contrato vigente y ve impacto MRR antes de aplicar.

- [~] **H62 — Centro de configuración PRO.** *Parcial: perfiles por rubro, importaciones y copia entre sucursales; faltan versionado, rollback y sandbox.*
  - [~] Plantillas por rubro: kiosco, retail, electro, textil, cafetería, heladería, restaurante, peluquería, servicios. *Parcial: 11 perfiles por rubro (ADR-075); electro, heladería y peluquería usan perfiles genéricos.*
  - [~] Import/export de configuración XLSX/JSON: medios, recargos, roles, tickets, tipos de entrega, depósitos, reglas, salones, mesas, comisiones. *Parcial: import y export XLSX de sucursales, depósitos, garantías y motivos (ADR-078, ADR-085); faltan medios, recargos, roles, tickets, reglas, salones, mesas, comisiones y JSON.*
  - [~] Versionado, diff, preview, rollback y ambiente sandbox por tenant. *Parcial: copiar de otra sucursal con vista previa campo por campo y "Diferencias por sucursal" (ADR-049); faltan versionado, rollback y sandbox.*
  - [~] *Criterio:* se clona la configuración de una sucursal a otra, se revisa diff y se revierte en un click. *Parcial: copia entre sucursales con diff y "Volver a heredar" por campo (ADR-049); falta revertir la copia entera en un click.*

- [~] **H63 — Gobierno de cambios y aprobaciones.** *Parcial: maker-checker de promociones de alto impacto y recargos (ADR-092), aprobación de precios masivos (ADR-058), PIN de supervisor por acción y auditoría con motivo; faltan plan, regla fiscal, permiso, suspensión, integración y export masivo.*
  - [~] Maker-checker para cambios sensibles: precio, plan, recargo, regla fiscal, permiso, suspensión, integración, export masivo. *Parcial (auditoría 2026-10-13): aprobación del dueño para cambios masivos de precios (`price_bulk_batches` en `pending_approval`, `price_bulk_decide`, ADR-058), traslados con aprobación opcional (ADR-046) y, desde ADR-092, promociones de alto impacto y recargos o planes de cuotas que propone un encargado (`commercial_change_requests`, trigger `commercial_maker_checker`, `/comercial`); faltan plan, regla fiscal, permiso, suspensión, integración y export masivo.*
  - [~] Motivo obligatorio, adjuntos, antes/después, aprobación por rol y expiración de solicitud. *Parcial: motivo y antes/después en `audit_logs` (ADR-073, ADR-083), PIN de supervisor por acción (ADR-051, ADR-060) y, desde ADR-092, solicitud con antes y propuesto, aprobación diferida del dueño, motivo obligatorio al rechazar y vencimiento configurable; faltan adjuntos.*
  - [~] Alertas a owner/manager/internal cuando una configuración crítica cambia. *Parcial (ADR-092): aviso al dueño cuando entra una solicitud, a quien la pidió cuando se decide y a dueño y encargado cuando un costo nuevo deja un producto bajo el margen; faltan internal y el aviso de cambios directos del dueño.*
  - [x] *Criterio:* un manager crea un recargo nuevo, owner lo aprueba y el audit log conserva todo el circuito. *Hecho (ADR-092): el plan del encargado queda inactivo y pendiente, el dueño lo aprueba en `/comercial` y `audit_logs` guarda `commercial_change_requested` y `_approved` (`tests/integration/rls-f14-comercial.test.ts`).*

- [~] **H64 — Inventario PRO, compras y proveedores.** *Parcial: compras, proveedores, lotes, sugerencia de compra y traslado recomendado (ADR-046, ADR-050, ADR-059), conteo cíclico ABC y garantías por serie (ADR-092), con la garantía extendida enlazada al producto que cubre (ADR-096); faltan inventario físico guiado y demanda proyectada.*
  > Nota 2026-10-12: *(Compras, proveedores, costos e importaciones se detallan con su tratamiento fiscal en F18/H101 y H102.)*
  - [~] Lotes, vencimientos, números de serie, garantías por serie, conteos cíclicos, inventario físico, ajustes masivos y auditoría. *Parcial: lotes con vencimiento y consumo FEFO (ADR-050, ADR-059), series (`product_serials`), conteo e importación de stock auditados por sucursal (ADR-078), conteo cíclico por clase ABC con exactitud (`cycle_count_due`, `cycle_count_submit`, `/inventario`, ADR-092) y garantía por serie con reclamos de posventa (`serial_lookup`, `serial_warranty_claims`, ADR-092); faltan inventario físico guiado y ajustes masivos.*
  - [x] Proveedores, órdenes de compra, recepción parcial, costos, listas de proveedor, reposición sugerida y cuenta corriente de proveedores. *Hecho: ADR-050 y ADR-059 (proveedores, OC, recepción parcial, costos, listas del proveedor, `purchase_suggestions`, cuenta corriente de proveedores).*
  - [~] Alertas de stock mínimo/máximo, demanda proyectada y transferencia recomendada entre depósitos/sucursales. *Parcial: mínimo y máximo por sucursal con sugerencia de compra (ADR-050, `lib/purchases/suggest.ts`), traslado recomendado entre sucursales desde la que tiene sobrante (`lib/stock/suggest.ts`, `components/stock/transfers/TransferSuggestModal.tsx`, ADR-046) y reposición del salón desde los depósitos (ADR-085); falta demanda proyectada.*
  - [x] *Criterio:* se crea una orden de compra por reposición sugerida, se recibe parcial y actualiza costo/stock/lote. *Hecho: la OC se arma desde la sugerencia (`components/purchases/OrderWizardModal.tsx`) y la recepción parcial actualiza costo, stock y lote (ADR-050, ADR-059).*

- [~] **H65 — Offline-first completo.** *Parcial: venta offline conservadora (ADR-077) y POS instalable que abre y recarga sin conexión (ADR-087); faltan comandas, pagos integrados y stock multi-dispositivo.*
  - [~] POS/PWA con cache local, cola de ventas/pagos/comandas/stock, reintentos y resolución de conflictos. *Parcial: cola local de ventas en IndexedDB con `client_sale_id` idempotente, reintentos y revisión del dueño (ADR-077); faltan service worker/PWA y colas de pagos, comandas y stock.*
  - [~] Reconciliación al reconectar: stock, caja, numeración interna, cola fiscal, pagos y auditoría. *Parcial: `sync_offline_sale` reconcilia precio, stock, promos, turno y auditoría, y la factura va a la cola fiscal (ADR-077, ADR-072); falta numeración interna offline.*
  - [~] Políticas por tenant: qué se permite offline, montos máximos, usuarios autorizados, duración máxima y bloqueo preventivo. *Parcial: `pos_settings.offline_policy` con switch, monto máximo, ventas por turno y horas máximas (ADR-077); faltan usuarios autorizados y bloqueo preventivo.*
  - [ ] *Criterio:* un local vende 3 horas sin internet y al volver sincroniza sin duplicar ventas ni romper caja/stock/AFIP.

- [~] **H66 — Omnicanal, marketplace hub y catálogo sincronizado.** *Parcial: mostrador, catálogo público y delivery propio con listas por canal; faltan marketplaces y QR de mesa.*
  - [~] Canales: mostrador, catálogo público, QR mesa, WhatsApp, Tienda Nube, Mercado Libre, delivery propio, PedidosYa/Rappi futuro. *Parcial: mostrador, catálogo público `/c/<slug>` y delivery propio (`20260608720000_delivery_orders`); faltan QR mesa, WhatsApp, Tienda Nube, Mercado Libre y PedidosYa/Rappi.*
  - [~] Stock reservado por canal, precios/listas por canal, estados de pedido, cancelación, reembolso y conciliación. *Parcial: listas de precios por canal (`price_lists`, `lib/prices/resolve.ts`); faltan stock reservado por canal y conciliación por canal.*
  - [ ] Mapeo de productos/modificadores/categorías por canal sin duplicar catálogo base.
  - [ ] *Criterio:* un producto cambia de precio y se sincroniza a catálogo/QR/marketplace según reglas del canal.

- [~] **H67 — BI/AI operativo y recomendaciones.** *Parcial: horarios pico y alertas de margen bajo (ADR-092).*
  - [~] Forecast de demanda, alertas de anomalías, productos muertos, margen bajo, quiebres probables, staff necesario y horarios pico. *Parcial: horarios pico en reportes (`peakHour` en `modules/reports/derive.ts`) y margen bajo con precio sugerido y aviso al cruzar el mínimo (`margin_alerts`, `/comercial`, ADR-092); faltan forecast, anomalías, productos muertos, quiebres probables y staff necesario.*
  - [ ] Recomendaciones accionables: subir stock, cambiar precio, crear combo, revisar cajero, reponer insumo, contactar cliente inactivo.
  - [ ] Explicabilidad: cada recomendación muestra datos usados y confianza.
  - [ ] *Criterio:* el owner recibe "te vas a quedar sin café el viernes" con evidencia y orden de compra sugerida.

- [ ] **H68 — API pública, webhooks y app marketplace.**
  - [~] API versionada con OAuth/API keys por tenant, scopes, rate limits, logs y rotación de credenciales. *Hecho en v1 (ADR-094) salvo el log de pedidos por credencial visible para el dueño (hoy: último uso y auditoría por lote).*
  - [ ] Webhooks para venta, pago, stock, cliente, turno, factura, comanda, notificación y cambio de plan.
  - [ ] Marketplace de apps: integración aprobada, permisos visibles, instalación/desinstalación y health por app.
  - [ ] *Criterio:* un partner recibe webhook de venta, consulta detalle por API y queda auditado por tenant.

### F15 — Escuela NinjaSoft + onboarding guiado configurable

Objetivo: que cada cliente aprenda el sistema sin depender de soporte: escuela interna, recorridos guiados, checklist por rubro, ayuda contextual y configuración desde internal para cambiar qué se enseña, cuándo y a quién. Ver [`28-school-onboarding.md`](./28-school-onboarding.md).

- [~] **H69 — Escuela NinjaSoft por módulos.** — *Primer corte (ADR-086, `feat/f15-escuela`, migraciones sin aplicar): `/escuela` con cuatro cursos (POS básico, Caja y arqueo, Primeros pasos, Facturación ARCA), lecciones = artículos de ayuda, checklist, prueba corta puntuada en el servidor y certificado "POS básico". Feature `escuela` BASE.*
  - [~] Biblioteca de cursos: primeros pasos, POS, caja, productos, clientes, reportes, hardware, AFIP, retail, servicios, gastronomía, internal para staff. *Hechos: primeros pasos, POS, caja, AFIP. Faltan hardware, retail, servicios, gastronomía e internal.*
  - [~] Cada lección tiene objetivo, pasos, capturas/video, demo interactiva, errores comunes, checklist y prueba corta. *Pasos, nota por rol, errores comunes, checklist y prueba; faltan capturas, video y demo.*
  - [~] Progreso por usuario, rol, tenant y rubro. *Por usuario y negocio (`school_progress`, RLS); dueño y encargado ven a su equipo. Falta por rubro.*
  - [x] *Criterio:* un cajero completa "Cobrar una venta" y queda certificado para operar POS básico. *Curso POS básico con certificado imprimible y auditado.*

- [~] **H70 — Tours y recorridos guiados configurables.** — *Corte ADR-089 (`feat/f15-tours`, migraciones `20261108300000` a `20261108300400` sin aplicar): `/internal/onboarding` > Recorridos, motor propio en `components/onboarding/TourHost.tsx`, recorridos "Primer cobro" y "Heladería: favoritos y sabores" sembrados. Feature `tours` BASE.*
  - [~] Internal define tours por plan, rubro, rol, feature flag, país, estado del tenant y evento disparador. *Plan, rubro, rol, features del plan, estado, antigüedad y evento (registro, primer ingreso, sin productos, sin caja abierta, sin primera venta, prueba por vencer, venta fallida, manual). Falta país y flag operativo.*
  - [x] Pasos con ancla en UI, tooltip, modal, spotlight, tarea, bloqueo opcional o "hacer ahora". *Anclas `data-tour` en POS (caja, buscar, favoritos, cobrar), abrir caja, productos y medios de pago.*
  - [~] Versionado de tours, draft/publicado, A/B test y métricas de finalización. *Versiones inmutables, borrador, pausa y archivo; inicio, finalización y abandono por paso, conversión a primera venta. Falta A/B test.*
  - [x] *Criterio:* al registrar una heladería, el sistema guía por productos favoritos, sabores, medios de pago y primer cobro. *Recorrido sembrado con audiencia rubro heladería y evento registro; test del criterio.*

- [~] **H71 — Checklist de activación y health de adopción.** — *Parcial (ADR-086): Puesta en marcha dinámica por rubro y plan.*
  - [~] Checklist dinámico por rubro: cargar productos, abrir caja, configurar ticket, invitar cajero, medio de pago, prueba de impresión, AFIP cuando aplique. *Todo menos la prueba de impresión (no hay registro de impresión de prueba); suma salón para gastronomía, agenda para servicios y certificar al cajero.*
  - [~] Score de activación: setup, primera venta, uso de caja, usuarios activos, configuración crítica completa, soporte pendiente. *ADR-089: puntaje 0 a 100 sobre `onboarding_tenant_signals` (única definición) e `internal_tenant_health`. Falta soporte pendiente (no hay tickets).*
  - [x] Internal ve cuentas trabadas y puede disparar ayuda específica. *`/internal/onboarding` > Activación: motivos, correctivo sugerido, recorrido o sugerencia con motivo, rol y vigencia, auditado.*
  - [x] *Criterio:* sales/support identifica tenants que no llegaron a primera venta y lanza recorrido correctivo. *"Sin primera venta a X días" (X configurable) y "Disparar correctivo", también para soporte.*

- [~] **H72 — Ayuda contextual y base de conocimiento.** — *Primer corte (ADR-086): 29 artículos versionados en `content/help/`, panel Ayuda en el shell, buscador con sinónimos y feedback.*
  - [x] Panel de ayuda dentro de cada pantalla con artículos filtrados por módulo, rol y acción actual.
  - [~] Buscador, etiquetas, contenido relacionado, feedback útil/no útil y sugerencia de artículo desde soporte. *Falta la sugerencia desde soporte.*
  - [ ] Modo "mostrarme con mis datos" usando demo segura o datos anonimizados.
  - [x] *Criterio:* desde `/pos`, un cajero busca "anular venta" y ve guía exacta para su rol. *Test unitario del criterio.*

- [ ] **H73 — Laboratorio/demo segura.**
  - [ ] Sandbox por tenant con datos de ejemplo para practicar sin afectar caja/stock/facturación real.
  - [ ] Reset de demo, escenarios por rubro y ejercicios guiados.
  - [ ] Separación visual fuerte entre demo y producción.
  - [ ] *Criterio:* un owner practica una devolución y una comanda sin generar movimientos reales.

- [~] **H74 — Configuración internal de sugerencias, nudges y comunicaciones de onboarding.** — *Corte ADR-089: `/internal/onboarding` > Sugerencias, `nudge_next` y tarjeta en el shell. Feature `sugerencias` BASE.*
  - [~] Internal crea sugerencias por evento: registro, primer login, sin productos, sin caja abierta, venta fallida, hardware no probado, trial por vencer. *Todos menos hardware no probado (no hay registro de prueba de impresión); suma sin primera venta.*
  - [~] Audiencia, prioridad, frecuencia, cooldown, expiración, canal, CTA y fallback a soporte. *Canal sólo en la app (la campana sigue para anuncios); CTA a ruta interna o a un recorrido; "Pedir ayuda" abre la Ayuda.*
  - [~] No molestar: límite de mensajes por sesión/día y preferencias por tenant. *Topes por sesión y día configurables y "No mostrar más" por usuario. Faltan preferencias por negocio.*
  - [x] *Criterio:* operaciones cambia el recorrido inicial de restaurantes sin deploy y mide conversión a primera venta. *Recorridos con audiencia por rubro editables y versionados sin deploy; métricas con conversión a primera venta por recorrido y sugerencia.*

- [~] **H75 — Certificaciones, soporte asistido y analítica de aprendizaje.** *Parcial: sólo el certificado de POS básico (ADR-086).*
  - [~] Certificados por rol: cajero, manager, gastronómico, retail avanzado, AFIP, soporte interno. *Parcial: certificado de cajero (POS básico, `content/help/courses.json`, `school_submit_quiz`, ADR-086). Faltan manager, gastronómico, retail avanzado, AFIP y soporte interno.*
  - [~] Métricas: lecciones vistas, tours completados, pasos abandonados, tickets reducidos, tiempo a primera venta. *Tours completados y pasos abandonados por recorrido (ADR-089); tiempo a primera venta en ADR-082.*
  - [ ] Sugerencias automáticas de capacitación según errores reales del tenant.
  - [ ] *Criterio:* internal ve que un tenant falla en cierres de caja y le recomienda curso + tour de arqueo.

### F16 — Comercio unificado tipo Napse/TOTVS

Objetivo: tomar como benchmark las capacidades de Napse/TOTVS (Bridge, Omni, VTOL, Fiscal Flow y Promo) y llevar NinjaSoft a una capa de **comercio unificado** para cadenas, franquicias y retailers que necesitan operar tienda física, e-commerce, marketplaces, pagos, fiscal, promociones, fidelización y devoluciones desde un solo cockpit. Ver [`29-napse-unified-commerce-benchmark.md`](./29-napse-unified-commerce-benchmark.md).

- [~] **H76 — Unified Commerce Cockpit.** *Parcial: cockpit con canales, pedidos, pagos, fiscal, stock comprometido y alertas con SLA (ADR-091); faltan promociones y fidelización por canal.*
  - [~] Cockpit central de ventas, inventario, pedidos, pagos, fiscal, devoluciones, promociones y fidelización por canal/sucursal/marca. *Parcial (ADR-091, 2026-10-13): página Cockpit con `commerce_cockpit`: ventas por canal y por sucursal, pedidos por surtir, pagos, facturas, devoluciones y stock comprometido, sobre el monitor de sucursales (ADR-080). Faltan promociones, fidelización y marca.*
  - [~] Vista 360 de operación en tiempo real: tiendas físicas, catálogo público, e-commerce, marketplace, QR, WhatsApp y delivery. *Parcial (ADR-091, 2026-10-13): canales mostrador, salón, WhatsApp, teléfono, QR, delivery, take away, link de pago, retiro en tienda y sin conexión, refrescados cada minuto. Faltan catálogo público, e-commerce y marketplace (sin pedidos online todavía).*
  - [x] Alertas operativas con SLA: pedido demorado, stock roto, pago sin conciliar, factura bloqueada, devolución pendiente, terminal caída. *(ADR-091, 2026-10-13): `cockpitAlerts` (`lib/commerce/cockpit.ts`) con pedido demorado, reserva sin preparar o por vencer, traslado demorado, stock negativo y quiebre con ventas, pago sin conciliar, cobros rechazados, contracargo, factura bloqueada o sin CAE, devolución a revisar, caja sin señal y operaciones de riesgo; más las del monitor (ADR-080). Aviso activo por mail o push pendiente (H85).*
  - [x] *Criterio:* un gerente ve en una sola pantalla qué canal vende, qué pedidos faltan surtir, qué pagos fallaron y qué stock está comprometido. *(ADR-091, 2026-10-13): página Cockpit; `tests/unit/comercioUnificado.test.ts` y `tests/integration/rls-comercio-unificado.test.ts`.*

- [~] **H77 — Jornadas omnicanal avanzadas.** *Parcial: stock de otras sucursales en el POS y reservas con retiro en tienda (ADR-091); la venta de mostrador respeta lo reservado y el POS cobra y entrega la reserva en la misma venta (ADR-096). Falta el pedido online para reservar.*
  - [~] Stock Lookup / Endless Aisle: vender desde una tienda usando stock de otra sucursal o depósito. *Parcial: el POS muestra el stock de las otras sucursales (`lib/stock/posBranchStock.ts`) y desde la propia se reserva stock de otra sucursal para retirar allá (ADR-091, 2026-10-13). Falta vender y enviar desde la otra sucursal.*
  - [~] Click & Collect: compra online, retiro en tienda, reserva de stock, preparación y entrega con identidad validada. *Parcial (ADR-091, 2026-10-13): reserva de stock por sucursal que compromete el disponible, preparación, vencimiento y entrega con código de un solo uso o documento contra la venta cobrada (`stock_reservations`, página Reservas y retiros). Falta la compra online.*
  - [ ] Ship from Store: venta online o de tienda con envío desde sucursal óptima.
  - [~] Reserve Online, Try/Pay in Store: reserva online, prueba en tienda y conversión a venta. *Parcial (ADR-091, 2026-10-13): reserva por teléfono, WhatsApp o mostrador y conversión a venta al retirar. Falta la reserva online del cliente.*
  - [ ] Devoluciones y cambios cross-channel: comprar online y devolver/cambiar en tienda con stock y fiscal consistentes.
  - [ ] *Criterio:* un cliente compra online, retira en sucursal, cambia un producto en otra sucursal y todo queda conciliado.

- [~] **H78 — OMS y surtido multi-origen.** *Parcial: reservas con preparación, entrega y cancelación (ADR-091).*
  - [~] Order Management System liviano: pedidos, reservas, picking, packing, despacho, entrega, cancelación y reembolso. *Parcial (ADR-091, 2026-10-13): reservas con estados reservada, lista para retirar, entregada, cancelada y vencida, auditadas; pedidos de delivery (F13/H49). Faltan picking, packing, despacho y reembolso.*
  - [ ] Asignación de origen por reglas: cercanía, stock, margen, SLA, capacidad, horario y costo de envío.
  - [ ] Picking por app/PWA, sustituciones autorizadas, faltantes, preparación parcial y split fulfillment.
  - [ ] *Criterio:* un pedido con 3 ítems se divide entre depósito central y sucursal sin perder trazabilidad.

- [~] **H79 — Fiscal Hub multi-canal y multi-país.** *Parcial: ARCA Argentina (ADR-072) cubre emisión, cola y contingencia.*
  - [ ] Abstracción fiscal por país/provincia/canal: AFIP/ARCA Argentina primero, arquitectura preparada para otros países.
  - [~] Ciclo completo de comprobante: emitir, almacenar XML/PDF, enviar al cliente, reimprimir, anular, nota de crédito/débito y auditar. *Parcial: emisión con CAE, XML de request y response guardados, NC por devolución y por anulación, envío del comprobante por email y reimpresión (ADR-072, `supabase/functions/arca_wsfe`). Falta nota de débito.*
  - [~] Contingencia autónoma por tienda/caja con cola fiscal, alertas 24/7, reintento, bloqueo preventivo y tablero fiscal. *Parcial: cola fiscal con reintentos, dead-letter, contingencia CAEA por punto de venta y panel de monitoreo fiscal (ADR-072). Faltan alertas 24/7 y bloqueo preventivo.*
  - [~] Diseñador PDF fiscal/no fiscal con mensajes, promociones y anexos permitidos. *Parcial (auditoría F16 2026-10-13): diseñador de tickets con logo, leyendas, layout y QR (`components/tickets/TicketTemplateEditor.tsx`, feature `tickets_pro`). Faltan el PDF fiscal propio, los mensajes de promociones y los anexos.*
  - [ ] *Criterio:* una cadena opera ventas físicas y online con comprobantes centralizados, contingencia y trazabilidad por país/canal.

- [~] **H80 — Promo & Loyalty omnicanal enterprise.** *Parcial: el simulador de promociones existe (ADR-074).*
  - [ ] Campañas omnicanal: POS, catálogo, e-commerce, WhatsApp, QR, marketplace y app futura.
  - [~] Simulador de campañas, coexistencia, exclusividad, conflictos, presupuesto, forecast de impacto y ticket promedio esperado. *Parcial: simulador sobre ventas pasadas, combinables o exclusivas y topes (ADR-074, `components/promotions/PromotionSimModal.tsx`, `simulatePromotion`). Faltan presupuesto, forecast de impacto y conflictos entre canales.*
  - [~] Fidelización avanzada: puntos, niveles, cupones, vales, gift cards, monedero, cashback, cliente frecuente y beneficios por comportamiento. *Parcial (auditoría F16 2026-10-13): cupones con topes por cliente (`20260609310000_coupons.sql`) y saldo a favor del cliente por devolución (`refund_method = 'store_credit'`). Faltan puntos, niveles, gift cards, cashback y beneficios por comportamiento.*
  - [ ] Automatizaciones por evento: primera compra, cumpleaños, abandono, recompra, cliente inactivo, devolución, ticket alto.
  - [ ] *Criterio:* una campaña se simula, se publica en todos los canales y mide uso, margen, ticket promedio y recurrencia.

- [~] **H81 — Clienteling y venta asistida móvil.** *Parcial: POS mobile-first instalable con ficha del cliente.*
  - [~] POS móvil para vendedor: buscar cliente, ver historial, preferencias, talles, garantías, deuda, puntos y recomendaciones. *Parcial (auditoría F16 2026-10-13): POS mobile-first e instalable (ADR-087) con la ficha del cliente desde el POS: historial, deuda y garantías (ADR-085, `lib/customers/c360.ts`). Faltan preferencias, talles, puntos y recomendaciones.*
  - [~] Venta asistida desde celular/tablet con QR de pago, stock de otra tienda, cross-selling/up-selling y envío a domicilio. *Parcial (auditoría F16 2026-10-13): cobro con QR y link (ADR-048), stock de otras sucursales en el POS (`lib/stock/posBranchStock.ts`) y pedidos de delivery (F13/H49). Faltan cross-selling y up-selling.*
  - [ ] Lista de deseos, carrito persistente omnicanal y recuperación de venta iniciada en otro canal.
  - [ ] *Criterio:* un vendedor atiende en salón desde celular, cobra con QR y evita que el cliente pase por caja.

- [~] **H82 — Prevención de fraude y riesgo operativo.** *Parcial: señales por persona, puntaje y marcas automáticas (ADR-091), aprobación por supervisor y contracargos.*
  - [x] Detección de operaciones sospechosas: anulaciones repetidas, descuentos excesivos, devoluciones anómalas, pagos fallidos, caja fuera de patrón. *(ADR-091, 2026-10-13): `operational_risk_signals` y `lib/risk/operationalRisk.ts`, página Riesgo operativo (feature `prevencion_fraude`).*
  - [~] Reglas de bloqueo, revisión manual, aprobación por supervisor y scoring de riesgo. *Parcial: aprobación por supervisor con PIN por acción (`20261017110000_pin_supervisor_politicas.sql`); scoring de devoluciones y anulaciones con umbrales del negocio y revisión manual con nota (`risk_settings`, `risk_flags`, (ADR-091, 2026-10-13)). Falta el bloqueo automático (exige recrear `return_sale_v2` y `void_sale`).*
  - [~] Señales de fraude omnicanal: abuso de cupones, cambios cross-channel, múltiples cuentas, chargebacks, vale/gift card sospechosa. *Parcial: contracargos y reclamos por venta (ADR-064, `lib/reports/paymentDisputes.ts`). Faltan abuso de cupones, cambios cross-channel, múltiples cuentas y vales sospechosos.*
  - [~] *Criterio:* una devolución de alto riesgo pide aprobación y queda marcada para auditoría. *Parcial (ADR-091, 2026-10-13): queda marcada y auditada (`risk_flag_raised`); la aprobación es la del PIN por monto (ADR-051), no por puntaje.*

- [~] **H83 — Operación de cadenas, marcas y franquicias.** *Parcial: herencia negocio → sucursal y grupos de sucursales.*
  - [ ] Multi-marca/multi-negocio dentro de un grupo empresarial.
  - [~] Franquicias: configuración central con overrides locales, catálogo central, precios sugeridos/obligatorios y reportes por franquiciado. *Parcial (auditoría F16 2026-10-13): configuración del negocio con overrides por sucursal y caja (F17, `venta_config_efectiva`), plantilla de sucursal (ADR-057) y listas de precios por sucursal. Faltan precios obligatorios y el reporte por franquiciado.*
  - [~] Consolidación regional: país, moneda, impuestos, canales, depósitos, roles y permisos por unidad de negocio. *Parcial (auditoría F16 2026-10-13): grupos o zonas de sucursales (ADR-049), depósitos por sucursal (ADR-085) y roles por sucursal (`staff_branch_assignments`, ADR-045). Faltan país, moneda y canales por unidad.*
  - [ ] *Criterio:* una franquicia recibe catálogo/precios desde central, opera localmente y reporta ventas consolidadas.

- [ ] **H84 — Marketplace y e-commerce integration hub.**
  - [ ] Conectores configurables para Tienda Nube, Mercado Libre, Shopify/WooCommerce futuro, PedidosYa/Rappi futuro y ERP externo.
  - [ ] Mapeo de catálogo, categorías, variantes, modifiers, impuestos, estados y medios por canal.
  - [ ] Sincronización con colas, dead-letter, replay, comparación de divergencias y health por integración.
  - [ ] *Criterio:* si Mercado Libre queda desincronizado, el cockpit muestra divergencia y permite replay controlado.

- [~] **H85 — Observabilidad enterprise de comercio unificado.** *Parcial: salud de webhooks (ADR-070), monitoreo fiscal (ADR-072) y heartbeat de cajas (ADR-080).*
  - [~] Tableros de salud: pagos, fiscal, integraciones, stock, OMS, promociones, webhooks, hardware y offline. *Parcial: Salud de webhooks por proveedor (`/internal/webhooks`, ADR-070), panel de monitoreo de facturación (ADR-072), heartbeat y monitor de cajas (ADR-080), revisión de ventas offline (ADR-077), stock y reservas en el cockpit del negocio (ADR-091). Faltan promociones y hardware en un tablero de plataforma.*
  - [~] Alarmas por SLA, error rate, latencia, backlog de colas, terminal caída, fiscal bloqueado o integración degradada. *Parcial: alertas de caja sin señal y cobro rechazado (ADR-080) y estado "Con errores" por proveedor de webhooks (ADR-070). Faltan alarmas activas (mail o push), latencia y backlog de colas.*
  - [x] Runbooks operativos para soporte: qué revisar, cómo reintentar, cómo escalar y cómo cerrar incidente. *(ADR-091, 2026-10-13): `lib/internal/runbooks.ts` y `/internal/runbooks` (caída de cobros, cobro sin venta, facturas bloqueadas, webhooks, caja sin señal, ventas offline y stock negativo).*
  - [~] *Criterio:* soporte detecta una caída de pagos, identifica proveedor/canal afectado y ejecuta runbook sin consultar SQL. *Parcial (ADR-091, 2026-10-13): Salud de webhooks identifica el proveedor y el runbook guía sin SQL. Falta el aviso activo de la caída.*

- [~] **H86 — Benchmark Napse parity y demos enterprise.** *Parcial: matriz de paridad en docs.*
  - [~] Matriz de paridad contra Napse Bridge/Omni/VTOL/Fiscal Flow/Promo, mantenida por producto. *Parcial (auditoría F16 2026-10-13): matriz en [`29-napse-unified-commerce-benchmark.md`](./29-napse-unified-commerce-benchmark.md) §2 y auditoría de pantallas en [`auditoria-napse-vs-ninjapos.md`](./auditoria-napse-vs-ninjapos.md). Falta el estado por capacidad.*
  - [ ] Demos enterprise por vertical: supermercado, moda, farmacia, tienda departamental, franquicia, mayorista.
  - [ ] Dataset demo con miles de productos, múltiples sucursales, e-commerce, promociones, fidelización, devoluciones y pagos conciliados.
  - [ ] *Criterio:* ventas puede mostrar un flujo omnicanal completo tipo cadena retail sin preparar datos manualmente.

---

### F17 · Multi-sucursal real

Objetivo: que un negocio con 2 o más locales opere con **la sucursal y la caja como contexto de primera clase** (siempre se ve dónde estoy), configure medios de pago, terminales, precios, tickets e impresión **una vez en el negocio y pise sólo lo que cambia por sucursal o caja**, y tenga stock, clientes y reportes por sucursal. Sale de la auditoría [`auditoria-napse-vs-ninjapos.md`](./auditoria-napse-vs-ninjapos.md) (Napse Bridge Manager 7.9, 253 pantallas) y de [ADR-043](./17-decision-log.md). Reemplaza en detalle el bloque multi-sucursal de F4. Lo contable y fiscal va en [F18](#f18--fiscal-contable-precios-y-compras-argentina).

> **Estado de partida (auditoría 2026-10-12):** `stores` y `cash_registers` existen pero sin ABM; `create_sale`, `exchange_sale`, `return_sale` y los RPC de stock toman **la sucursal default** en vez de la de la caja del turno; stock único en `products.stock`; toda la configuración (`tenant_payment_methods`, `payment_secrets`, `payment_plans`, `pos_settings`, `ticket_templates`, impresión) es por negocio; roles por negocio (`tenant_users.role`); la feature `multi_sucursal` está en planes pero no tiene función (hoy es MARKETING-FUTURO).
>
> **Clasificación (convención de features de plan):** cada hito indica BASE / OPTIONAL / ADDON / FLAG-OPERATIVO y su key. Las keys nuevas siguen el checklist completo de `CLAUDE.md` (features, `plans.limits.modules`, gating server-side, `featureInfo.ts`, `planComparison.ts`).

- [~] **H89: Sucursales y cajas como entidades administrables.** *(2026-10-12, ADR-045: ABM, gating y auditoría hechos; grupos (ADR-049), plantilla (ADR-057) e import de sucursales por XLSX (ADR-078) hechos; faltan import de cajas y razón social y CUIT por sucursal)* · *BASE (la primera sucursal y caja) + OPTIONAL `multi_sucursal` (Business, existe) desde la segunda sucursal + OPTIONAL `multi_caja` (nueva, Pro) desde la segunda caja de una sucursal.*
  - [x] ABM de sucursales en Configuración: nombre, nombre corto, código, dirección estructurada, teléfono, email, horario, color, estado (activa, pausada, archivada), principal y baja lógica. Grupos o zonas (`store_groups`) y logo por sucursal (ADR-049).
  - [~] Datos fiscales por sucursal: punto de venta ARCA (`stores.afip_pos_number`) y domicilio hechos; razón social y CUIT opcionales pendientes (H98).
  - [x] ABM de cajas por sucursal: nombre, código, tipo (fija, móvil, autoservicio), notas de dispositivo e impresora, baja lógica (`cash_registers.deleted_at`), PV propio opcional, mover de sucursal sin turno abierto.
  - [x] Enforcement server-side de `max_stores` y de cajas por plan (`max_registers_per_store`, `multi_caja`) con triggers en `stores` y `cash_registers` (`tenant_limit_for` + `tenant_has_feature_for`), no sólo en la UI.
  - [x] Plantilla de sucursal nueva: hereda todo por defecto, "Copiar de otra sucursal" o "Usar una plantilla" guardada, eligiendo partes (operación y ticket, medios, impresoras y perfiles, planes propios y personal). Terminales y credenciales no se copian. *(2026-10-12, ADR-057)*
  - [~] Importar sucursales y cajas por XLSX (cierra el pendiente de F11/H34). *Sucursales hechas: `import_stores` en el motor de ADR-078 (`20261104100100_importaciones_xlsx`). Falta importar cajas.*
  - [x] *Criterio:* el dueño crea "Sucursal Norte" con 2 cajas; un plan Pro no puede crear la segunda sucursal (lo rechaza el servidor, no sólo el botón). *(Auditoría 2026-11-05: cubierto por `tests/integration/rls-sucursales.test.ts`, "sin multi_sucursal el servidor rechaza la segunda sucursal".)*

- [x] **H90: Contexto de sucursal y caja activa ("dónde estoy").** *(2026-10-12, ADR-045: fix P0, chip, cabecera del POS, selector de caja y filtros de ventas y Z hechos; 2026-11-05, ADR-080: aviso de contexto cruzado y título de pestaña)* · *BASE (indicador y fix) + FLAG-OPERATIVO (mostrar el chip con una sola sucursal). El selector requiere H89.*
  - [x] **Fix P0 independiente:** `create_sale`, `exchange_sale`, `return_sale_*` y cobros de cuenta corriente derivan `store_id` del turno (`resolve_sale_shift`), no de `stores.is_default`. Test RLS con 2 sucursales y turnos abiertos en ambas. *(Los RPC de stock, ajuste, merma y producción, van con H94 en `feat/stock-sucursales`.)*
  - [x] Chip de sucursal en el panel (nombre corto + color) con "Todas las sucursales"; filtra ventas, cierres Z, reportes, conciliación y stock; recordado por usuario y dispositivo (localStorage). Título de pestaña con la sucursal ("Norte · Ventas", `useBranchTabTitle`, ADR-080).
  - [x] Cabecera del POS: "Centro · Caja 1 · abierta" (mobile: "Centro · C1"). Sin cambio de sucursal con carrito o turno propio abierto.
  - [x] "¿Dónde vendés hoy?" con sucursales y cajas (libre, abierta, abierta por vos) cuando el usuario puede elegir; el dispositivo recuerda su caja. Reemplaza `posApi.defaultRegister()`.
  - [x] Apertura y cierre de caja y pantalla Caja muestran sucursal y caja; Cierres Z con columna Sucursal; ticket (variables `sucursal`, `caja`) y display de cliente con "Sucursal · Caja".
  - [x] Aviso de contexto cruzado: si el panel mira "Norte" y el turno abierto es en "Centro", el acceso "Vender" lo dice (`lib/branches/crossContext.ts`, ADR-080).
  - [x] *Criterio:* un cajero con turno en la Caja 2 de Norte vende y la venta, el stock y el Z quedan en Norte; en ninguna pantalla hay duda de en qué sucursal está. *(`rls-sucursales.test.ts` y `rls-f17-pendientes.test.ts`: venta y Z en la sucursal y caja del turno; aviso cruzado y pestaña, ADR-080.)*

- [~] **H91: Usuarios, roles y datos por sucursal.** *(2026-10-12, ADR-045: personal con vigencias, traslados programados y RLS de lectura hechos)* · *OPTIONAL dentro de `multi_sucursal`. Requiere H89.*
  - [x] `staff_branch_assignments` (en lugar de `tenant_user_stores`): base, cobertura temporal exclusiva y acceso adicional con vigencias, rol por sucursal, usuarios y perfiles sin cuenta, traslados programados con cancelación que restaura e historial. Sin asignaciones: encargado = todas, cajero = principal.
  - [ ] Alcance central vs sucursal: los maestros (productos, clientes, medios, listas) sólo los edita quien tiene alcance central.
  - [~] RLS restrictiva de lectura con `user_allowed_store_ids()` en `sales`, `cash_shifts` (con `store_id` desnormalizado), `cash_movements` y `cash_z_closures`, más `payment_terminals` y `printers` por sucursal; reportes SECURITY DEFINER acotados a las sucursales del usuario (`report_store_filter`); tests RLS por rol y sucursal. *(2026-11-05, ADR-080: `payments` y `stock_transfers` (con ítems y eventos) hechos; `product_stock` queda legible por decisión (Ver en otras sucursales). Pendiente: `EXPLAIN` sobre datos reales.)*
  - [x] `store_id` en `audit_logs` (trigger `audit_logs_fill_store`) para filtrar la auditoría por sucursal.
  - [x] Invitar usuario con sucursales asignadas (cumple el criterio de `01-mvp.md` "asignación de rol y sucursales permitidas"). Perfiles y vendedores del POS filtrados por la sucursal del POS.
  - [x] *Criterio:* un cajero de Norte no ve ventas ni cajas de Centro aunque consulte la API directo; el dueño ve todo. *(Auditoría 2026-11-05: `tests/integration/rls-sucursales.test.ts`, "el cajero asignado a Norte sólo ve ventas y turnos de Norte".)*

- [~] **H92: Configuración heredable negocio → grupo → sucursal → caja ("compartir configuración").** *(2026-10-12, ADR-049: tabla, resolución en el servidor, selector de alcance, copia y diferencias hechos)* · *OPTIONAL dentro de `multi_sucursal` (nivel caja: `multi_caja`). Primer corte concreto de F14/H57; la clonación con diff es parte de F14/H62.*
  - [x] Tabla `config_overrides(scope, scope_id, domain, domain_key, patch)` con override **por campo**, whitelist de campos por dominio, auditoría y escritura por RPC owner/manager con acceso a la sucursal.
  - [x] Función `effective_config(domain, key, store_id, register_id)` en SQL con el origen de cada campo; `create_sale`, `close_cash_shift`, el trigger de `payments` y las Edges de cobro resuelven con la caja del turno.
  - [~] Dominios del primer corte: `pos_settings` (redondeo, negativo, cierre ciego, tolerancia, descuento máximo por rol), tickets (encabezado y datos de la sucursal, logo), impresión con impresoras por sucursal y caja (cierra el pendiente de F10/H22), display de cliente (cierra el pendiente de F10/H25). *(`pos_layout` se hereda pero se pisa copiando; plantilla de ticket por sucursal y devoluciones: pendientes.)*
  - [x] Selector de alcance en cada pantalla de Configuración ("Configurando: Todo el negocio ▾"), campo marcado "Heredado / Personalizado" con "Volver a heredar" y valor heredado visible.
  - [x] Vista "Diferencias por sucursal" y acciones "Aplicar a todas" (RPC) y "Copiar desde otra sucursal" (con diff). Plantillas para nuevas sucursales (`store_templates`, ADR-057).
  - [x] El override nunca habilita algo fuera del plan: el gating se evalúa antes de la herencia.
  - [x] *Criterio:* el dueño cambia el redondeo del negocio y llega a todas las sucursales menos a la que lo tenía pisado; ve en una tabla qué sucursal es distinta y la vuelve al default en un click. *(`tests/integration/rls-config-sucursal.test.ts`, "el dueño pisa campos por sucursal; el resto hereda y se ve el origen"; vista Diferencias por sucursal y Volver a heredar, ADR-049.)*

- [x] **H93: Medios de pago y terminales por sucursal y caja.** *(2026-10-12, ADR-049: overrides de medios, registro de terminales, Edges con terminal_id y caja QR por caja hechos)* · *Medios: OPTIONAL dentro de `multi_sucursal` (cada medio sigue gateado por su key). Registro de terminales: BASE. Requiere H89 y H92.*
  - [x] `tenant_payment_methods` sigue siendo el catálogo central; override por sucursal y caja vía `config_overrides` (`domain='payment_method'`, `domain_key=provider_key`): `enabled`, `surcharge_pct`, `plan_mode`, `sort`, `merchant_numbers`.
  - [x] Credenciales por sucursal: `payment_secrets.store_id` opcional (null = del negocio) para proveedores que trabajan por local (GO Cuotas "API Key de la sucursal", Mobbex, Nave `pos_id`, Payway o Fiserv por comercio, Mercado Pago por OAuth). Resolución sucursal → negocio en todas las Edges, el cobro guarda con qué credencial se creó y el asistente de conexión tiene alcance "Todo el negocio / Sucursal X". Sigue sólo service_role. *(2026-10-12, ADR-057)*
  - [x] Registro de terminales `payment_terminals` (sucursal, caja, proveedor, tipo `point` / `qr_caja` / `clover` / `posnet_manual`, id externo, ambiente, etiqueta, adquirente, **n° de comercio**, default por caja, activa, `last_seen_at`). Migra el lector de `localStorage` (respaldo), la caja QR de MP, `point_pos_ids` de Nave y las series de Clover.
  - [x] Las Edges (`mp_point`, `nave_point`, `clover_point`, `mp_qr`) validan que la terminal sea del negocio y de la sucursal; el POS registra el lector elegido con un tilde. *(Detectar desde la sección Terminales hecho: `components/config/TerminalWizard.tsx`.)*
  - [x] Caja QR de Mercado Pago **por caja** (`mp_qr setup` con `cash_register_id`), con la única de siempre como respaldo.
  - [x] N° de comercio por marca con override por sucursal (`merchant_numbers` efectivo) y n° por terminal. Autocompletar desde la terminal integrada en el cupón: `lib/payments/terminal/normalize.ts` completa `card_voucher.comercio` con el de la terminal o el del registro (ADR-053). *(Auditoría 2026-11-05.)*
  - [x] **Cuentas de transferencia** (ADR-055): banco o billetera del catálogo con logo (o propia con logo subido), titular, CUIT, CBU / CVU validados con detección de la entidad, alias, tipo, moneda y nota; pantalla de transferencia en el POS y en la pantalla del cliente (o cierre directo), n° de operación opcional u obligatorio, cuentas y cuenta por defecto por grupo o sucursal y pantalla por caja. Snapshot de la cuenta en `payments.metadata.transfer`. BASE una cuenta; OPTIONAL `transferencia_multicuenta` (Pro).
  - [x] Planes de cuotas y recargos por sucursal: la sucursal pisa u oculta planes del negocio y hereda el resto; el POS cobra con los de su sucursal. *(2026-10-12, ADR-057; recargo único y n° de comercio por sucursal ya estaban en ADR-049)*
  - [x] *Criterio:* Visa con recargo 10% en todo el negocio y 0% en Norte; Norte usa su propio n° de comercio de Prisma y su Point; el cupón de cada venta sale con el n° correcto sin tipearlo. *(Recargo y n° de comercio por sucursal con `config_overrides` (ADR-049, ADR-057), terminal por caja y n° en el cupón con `lib/payments/terminal/normalize.ts` (ADR-053).)*

- [~] **H94: Catálogo central con stock, precio y habilitación por sucursal.** · *OPTIONAL dentro de `multi_sucursal`. Requiere H89 y H90. Depósitos dentro de la sucursal siguen en F11/H33; listas PRO en F18/H100.* · *Stock: OPTIONAL `stock_sucursales` (Business, requiere `multi_sucursal`), ADR-046.*
  - [x] `product_stock(store_id, product_id, variant_id, qty, min_qty, max_qty, location)` mantenido por trigger sobre `stock_movements`; `products.stock` sigue como total y al commit se garantiza que es la suma (sin romper pantallas). Migración de datos: el stock actual queda en la sucursal principal. En tránsito se calcula desde los traslados (`stock_by_store`). *(ADR-046; reservado queda pendiente)*
  - [x] Stock mínimo, máximo y ubicación por sucursal; desglose en Productos y en la ficha; ajuste y conteo por sucursal. *(ADR-046)*
  - [x] Venta en negativo por sucursal: aviso o bloqueo en el POS y control en `create_sale` (`insufficient_stock_branch`), con la venta sin stock efectiva de la sucursal (ADR-049).
  - [ ] `product_store_settings` (como el `itemStore` de Napse): habilitado, a la venta, precio, costo, stock mínimo, todo nullable = hereda.
  - [x] Listas de precios asignables a sucursal o grupo (`price_list_assignments` con alcance `store` y `store_group`, migración `20261021100100_listas_precios_pro`, ADR-058). *(Auditoría 2026-11-05.)*
  - [x] "Ver en otras sucursales" en el buscador del POS y en la ficha (stock por sucursal).
  - [x] Ajustes, mermas, producción, conteos e import de stock inicial por sucursal (cierra el pendiente de F11/H34). *(Auditoría 2026-11-05: ajuste y conteo por sucursal con `adjust_store_stock` (ADR-046) y merma con `register_stock_waste(p_store_id)` (`20261015200000`) hechos; producción por sucursal con `register_production(p_store_id)` (`20261105100300`, ADR-080); import de stock inicial por sucursal con `import_stock` (`20261104100100`, ADR-078).)*
  - [x] *Criterio:* el mismo producto cuesta $1.000 en Centro y $1.100 en el shopping, tiene stock separado y el cajero ve que en Norte quedan 3. *(Precio por sucursal con `price_list_assignments` alcance `store` resuelto en `_resolve_unit_price` (`20261021100200`, ADR-058); stock por sucursal y Ver en otras sucursales, ADR-046.)*

- [x] **H95: Transferencias entre sucursales.** · *OPTIONAL `traslados` (nueva, Business, requiere `stock_sucursales`; reemplaza a la key `transferencias_stock` prevista). Requiere H94. ADR-046.*
  - [x] Documento con estados `borrador → pendiente de aprobación → programado → en tránsito → recibido parcial → recibido / cancelado`, aprobación configurable por unidades o valor (cuatro ojos) y fecha programada con "Para despachar hoy" (sin cron).
  - [x] Movimientos `transfer_out` / `transfer_in` / `transfer_return`, stock en tránsito visible, diferencias en la recepción con motivo.
  - [x] Remito interno imprimible y XLSX con número correlativo; transferencia sugerida por stock mínimo. *(Falta: tratamiento fiscal del remito y solicitud de transferencia desde la sucursal que necesita.)*
  - [x] Auditoría y timeline por traslado. Reporte de artículos en tránsito por traslado o producto, por sucursal y dirección, con valor y XLSX (ADR-080).
  - [x] *Criterio:* Centro manda 10 unidades a Norte, quedan en tránsito, Norte recibe 9 con motivo "dañado" y el stock y el reporte cuadran. *(`rls.test.ts` "traslado completo con faltante" y `tests/unit/inTransit.test.ts`.)*

- [~] **H96: Clientes compartidos entre sucursales.** · *BASE (cliente único, ya existe) + OPTIONAL `cuenta_corriente` (existe) para crédito. Requiere H90 para el `store_id` de cada movimiento.* *(Cliente único, vales por sucursal, sucursal de alta y cobro en la sucursal de la caja hechos; faltan tope de crédito por sucursal, deuda por sucursal en reportes y fidelización compartida.)*
  - [x] Cliente único a nivel negocio (`customers` por tenant) y cuenta corriente v2 cobrable en cualquier sucursal. *(ADR-037)*
  - [x] Vales con sucursales permitidas (`store_credit_vouchers.allowed_branch_ids`). *(F11/H29)*
  - [x] Sucursal de alta (`customers.store_id_alta`, por trigger) e historial de compras filtrable por sucursal con estadísticas por sucursal. *(2026-10-12, ADR-057; deuda por sucursal: pendiente)*
  - [x] Cobros de cuenta corriente registrados en la sucursal de la caja: `account_open_shift` usa `resolve_sale_shift` (turno propio de la caja, `20261013120000`). *(Auditoría 2026-11-05.)*
  - [ ] Límite de crédito global con opción de tope por sucursal.
  - [ ] Fidelización (puntos, cupones, gift cards) compartida: se cubre en F9/H55 y F16/H80.
  - [~] *Criterio:* un cliente compra fiado en Centro y paga en Norte; la deuda baja y cada sucursal ve lo suyo en su reporte. *(Cobrar en otra sucursal hecho (`account_open_shift` con `resolve_sale_shift`); falta la deuda por sucursal en el reporte.)*

- [~] **H97: Reportes consolidados y por sucursal.** · *BASE (reportes de la sucursal propia) + OPTIONAL `multi_sucursal` (consolidado y comparativo) + `metricas_avanzadas` (existe, MARKETING-FUTURO) para tableros comparativos. Requiere H90.*
  - [x] Filtro global de sucursal (el del chip de H90) en reportes, conciliación, ventas, Z, stock y export XLSX; RPC con `p_store_id` y acceso validado. *(Reportes, ventas, conciliación, stock y XLSX filtran por el chip (`app/(app)/reportes/page.tsx`, `lib/reports/branchScope.ts`); RPC con `report_store_filter` (`20261015200000_reportes_por_sucursal`); filtro por caja en Cierres Z (ADR-080).)*
  - [x] Vista consolidada con desglose por sucursal y comparativo entre sucursales (ventas, ticket promedio, medios de pago, margen, devoluciones, diferencias de caja, clientes) con XLSX de una hoja por sucursal más el consolidado. *(2026-10-12, ADR-057)*
  - [x] Cierres Z por sucursal y caja con correlativo propio (completa F11/H30b): trigger `czc_numbering` con lock, que además corrige el número del negocio repetido bajo la RLS por sucursal (`20261105100100`, ADR-080).
  - [ ] Reportes pesados en cola ("Reporte offline" de Napse) con aviso cuando el archivo está listo.
  - [x] *Criterio:* el dueño compara las 3 sucursales del mes en una pantalla y descarga un XLSX con una hoja por sucursal más el consolidado. *(`components/reports/BranchCompare.tsx` con `compareSheets` y `exportXlsx`, ADR-057.)*

- [~] **H98: Fiscal por sucursal y punto de venta.** · *OPTIONAL `facturacion_afip` (existe, MARKETING-FUTURO hasta F3) + OPTIONAL `multi_razon_social` (nueva, Enterprise). Requiere F3 y H89. Motor de impuestos en F18.* *(PV por sucursal y caja y cola fiscal por serie hechos con ARCA, ADR-072; faltan CAEA por PV, varias razones sociales e IIBB por sucursal.)*
  - [x] Punto de venta ARCA por sucursal (y por caja si el negocio lo elige), con domicilio comercial del PV; reemplaza el `tenants.afip_pos_number` único previsto en `15-afip-integration.md`. *(ADR-072: el comprobante toma `cash_registers.afip_pos_number` o `stores.afip_pos_number`; domicilio de la sucursal, ADR-045.)*
  - [~] Numeración, cola fiscal y CAEA de contingencia por PV (se coordina con F16/H79). *(Numeración y cola por serie (ambiente, PV, tipo) hechas, ADR-072; el CAEA es una sola serie con PV exclusivo del negocio, no por PV.)*
  - [ ] Varias razones sociales que facturan dentro del negocio (franquicias, consignación): cada sucursal o condición de facturación decide quién emite (como las "condiciones de facturación" de Napse).
  - [ ] Jurisdicción de IIBB por sucursal (para percepciones y Convenio Multilateral, F18/H105).
  - [~] *Criterio:* Centro emite con PV 3 y Norte con PV 4; si ARCA cae, cada PV entra en contingencia por separado. *(PV distinto por sucursal hecho, ADR-072; la contingencia CAEA es del negocio, no por PV.)*

- [~] **H99: Monitor de sucursales, cajas y terminales.** *(2026-10-12, ADR-057: vista de sucursales en el monitor de cajas con alertas, BASE `monitor_cajas`; 2026-11-05, ADR-080: heartbeat por caja y último cobro por terminal; key Enterprise `monitoreo_sucursales` para el historial y avisos push, pendiente)* · *OPTIONAL `monitoreo_sucursales` (nueva, Enterprise). Requiere H93. Se integra a F16/H85.*
  - [x] Heartbeat de cada caja (última venta, último ping, versión de la app, display conectado; impresora y balanza quedan para el conector local): `register_heartbeats` + `register_heartbeat`, alerta de caja abierta sin señal (`20261105100200`, ADR-080).
  - [x] Estado de terminales: `last_seen_at` y último cobro aprobado o rechazado (bitácora integrada y Point / QR) en la tarjeta de la sucursal, con alerta de rechazo (ADR-080).
  - [x] Alertas por sucursal: caja abierta hace más de N horas, diferencia de caja sobre tolerancia, terminal sin señal, sucursal sin caja o sin ventas en horario, cobros pagados sin venta y faltantes (`lib/branches/monitorAlerts.ts`, umbrales por equipo). *(ADR-057)*
  - [x] *Criterio:* el dueño ve en una pantalla que el Point de Centro no responde desde las 10:12 y que Norte no abrió caja. *(Alertas `terminal_stale` y `closed_in_hours` en `lib/branches/monitorAlerts.ts`; ADR-057 y ADR-080.)*

#### F17 · Personal, cajas y seguridad operativa (auditoría 2026-10-12, ADR-051)

Sale de [`auditoria-sucursales-personal-cajas.md`](./auditoria-sucursales-personal-cajas.md). Cada hito indica su clasificación según la convención de features de plan.

- [x] **H113: Ciclo de vida del personal.** *(2026-10-12, ADR-051)* · *BASE `personal_estados` (nueva). Requiere H91 para sucursal base y traslados.*
  - [x] Estados `activo`, `suspendido` (motivo, desde y hasta: vuelve solo), `licencia` (tipo, desde y hasta), `baja` (despido, renuncia, fin de contrato u otro; fecha y motivo) y `reingreso`, para usuarios y perfiles sin cuenta. Historial `staff_status_events` con baja lógica, evaluación perezosa por fecha (sin cron).
  - [x] RPC `staff_set_status`, `staff_cancel_status`, `staff_rehire`, `staff_board` (owner/manager; un encargado no toca al dueño ni a otro encargado), auditadas.
  - [x] La suspensión y la licencia cortan la operación al instante en el servidor (turnos, ventas, alcance por sucursal vacío); la baja además revoca sesiones y el negocio activo del JWT, pasa la membresía a `inactive` y libera el cupo de usuarios.
  - [x] Tablero visual por sucursal con avatares y chips de estado, filtros por estado, ficha con timeline (estados y traslados).
  - [x] Invitar desde el Panel del dueño (fix del acceso rápido) con sucursal base, adicionales y rol por sucursal; reinvitar a alguien de baja es un reingreso explícito.
  - [x] Fixes: el encargado no degrada ni suspende al dueño (`member_admin`), invitar no pisa el rol de un miembro existente, el invitado recibe el negocio activo (`app_metadata.current_tenant_id`) y se autocura al entrar.
  - [x] *Criterio:* el dueño da de baja a un cajero; ese cajero no puede abrir caja, vender ni leer datos del negocio después de su próximo refresh de sesión; la historia y sus ventas quedan. *(Auditoría 2026-11-05: `tests/integration/rls-personal-cajas.test.ts`, "baja revoca el negocio activo y la membresía".)*

- [x] **H114: Propiedad de la caja.** *(2026-10-12, ADR-051)* · *BASE (control interno, sin key nueva) + FLAG-OPERATIVO `shared_shift` (caja compartida, apagado).*
  - [x] `assert_shift_owner(shift)`: sólo quien abrió el turno vende, retira, ingresa o cierra. `resolve_sale_shift` lo exige (ventas, devoluciones y cambios) sin recrear `create_sale`.
  - [x] Un turno abierto por usuario en todo el negocio (`open_cash_shift`).
  - [x] Guarda en `cash_shifts` (cierre sólo del dueño del turno o por `cash_force_close`; sin inserts ni borrados directos) y en `cash_movements` (desde el cliente sólo ingreso, retiro o contramovimiento de una anulación real; sin UPDATE ni DELETE).
  - [x] `cash_force_close(shift, monto contado, motivo)` para supervisores (sesión o PIN), con Z y auditoría.
  - [x] POS: aviso "Esta caja la tiene abierta X desde HH:MM" con acceso a elegir otra caja.
  - [x] *Criterio:* un cajero no puede vender, retirar ni cerrar en el turno de otro aunque llame a la API directo; el dueño vende en Norte abriendo su propia caja. *(Auditoría 2026-11-05: `tests/integration/rls-personal-cajas.test.ts`, casos H114.)*

- [x] **H115: Monitor de cajas abiertas.** *(2026-10-12, ADR-051: pantalla y widget hechos; alertas (ADR-057) y heartbeat (ADR-080) en H99)* · *BASE `monitor_cajas` (nueva). Primer corte de H99.*
  - [x] RPC `cash_monitor(store)` (respeta el alcance por sucursal del que mira): turno, caja, sucursal, usuario, desde cuándo, ventas, total, efectivo esperado, retiros e ingresos, última actividad.
  - [x] Pantalla Caja · Cajas abiertas con contador en vivo y acciones Ver detalle y Cierre forzado (PIN); widget en el Panel del dueño.
  - [x] Heartbeat por caja (ADR-080). Alertas por caja abierta hace más de N horas, caja sin señal y terminales sin señal en la vista de sucursales (ADR-057, ADR-080).

- [x] **H116: PIN de supervisor y políticas por acción.** *(2026-10-12, ADR-051)* · *BASE `pin_supervisor` (nueva). Reemplaza el gating por `cuenta_corriente` del PIN (las RPC `account_*` siguen).*
  - [x] `security_settings` por negocio: acciones que piden PIN con umbral (descuento sobre X %, anulación desde $Y, devolución desde $Y, retiro desde $Y, ingreso, cierre forzado), roles y usuarios supervisores, intentos y minutos de bloqueo, rotación del PIN en días, caja compartida.
  - [x] RPC generales `supervisor_pin_status`, `supervisor_set_pin`, `supervisor_clear_pin`, `supervisor_list`, `supervisor_authorize` (token de un solo uso atado a acción, cajero y monto, 5 minutos).
  - [x] Enforcement server-side por trigger con el token en el header `x-ninja-supervisor-token`: descuento (`sales`), anulación (`sales`), devolución (`sale_returns`), retiro e ingreso (`cash_movements`), cierre forzado.
  - [x] Diálogo de PIN reutilizable en el POS, Caja y Ventas que reintenta la acción.

- [x] **H116b: PIN autenticador (rotativo, de un uso y app).** *(2026-10-12, ADR-060, `feat/pin-autenticador`, migración `20261023100000` sin aplicar)* · *OPTIONAL `pin_autenticador` (nueva, Pro). Requiere H116.*
  - [x] Modos por supervisor: fijo, rotativo (HMAC-SHA256 con pasos de N horas alineados a la hora argentina, anterior válido 5 minutos), de un uso (aleatorio, 1 a 30 minutos, hasheado, opcionalmente por acción y monto) y app TOTP estándar (QR `otpauth://`, ±1 paso, sin repetir).
  - [x] Mis PINes: código con cuenta regresiva, Copiar y WhatsApp, generar y revocar PIN de un uso, vincular la app, historial de usos.
  - [x] `supervisor_authorize` acepta todos los modos según la política de la acción; bloqueo por supervisor y por quien pide, tope por minuto, auditoría con el modo.
  - [x] Política del dueño: modos del negocio, modo por defecto, período del rotativo, duración máxima y modos por acción.
  - [ ] Pendiente: notificar al supervisor cuando se usa su PIN (push o WhatsApp) y cifrado en reposo de los secretos con Vault.

- [~] **H117: Visor de auditoría del negocio.** *(2026-10-12, ADR-051: visor, diff, XLSX y lectura restringida hechos; 2026-10-13, ADR-083: inmutabilidad, retención y hash encadenado hechos; alertas pendientes)* · *Registrar: BASE (principio 3). Visor: OPTIONAL `auditoria` (existe, Business; deja de ser MARKETING-FUTURO).*
  - [x] RPC `audit_log_search` con filtros por usuario, sucursal, acción, entidad y fechas, paginada; detalle con diff antes / después; export XLSX.
  - [x] Policy restrictiva: la auditoría la leen dueño y encargado (o lo propio); antes la leía cualquier miembro.
  - [x] Inmutable: sin UPDATE, DELETE ni TRUNCATE para cliente ni service_role (grants y trigger); sólo el sellado y la retención internos tocan filas. El insert del cliente queda en su negocio y no elige `created_at` (ADR-083).
  - [x] Retención configurable: 24 meses por defecto, override por plan (`plans.limits.audit_retention_months`, mínimo 12), cron diario con lápidas; las acciones fiscales y comerciales no se borran (ADR-083).
  - [x] Hash encadenado por negocio (`row_hash` al insertar, sellado cada 5 minutos) y `audit_chain_verify` para el panel interno (ADR-083).
  - [ ] Pendiente: alertas (muchos PIN fallidos, anulaciones fuera de horario), botón de verificación en el panel interno y anclar la cabeza de la cadena fuera de la base.

- [~] **H118: Panel del dueño operativo y por sucursal.** *(2026-10-12, ADR-051: tarjetas, gráficos y selector hechos; 2026-10-13, ADR-083: `current_tenant_id()` con membresía hecho; `tenantScoped()` y lint pendientes)* · *BASE `panel_dueno` (existe) + OPTIONAL `metricas_avanzadas` (existe) para comparativos largos.*
  - [x] Tarjetas Negocio, Plan y Uso rehechas (uso con barras y límites, incluye cajas por sucursal y usuarios en baja).
  - [x] Gráficos con ECharts: ventas de hoy vs ayer por sucursal y por hora, cajas abiertas, personal activo por estado; selector Todas / sucursal.
  - [x] `current_tenant_id()` valida la membresía activa (o staff en `internal_scope()`) y todas las policies la llaman como initplan `(select current_tenant_id())`; `ensure_current_tenant()` corrige un negocio activo inválido (ADR-083, raíz de S-07).
  - [ ] Pendiente: medir con `EXPLAIN` en producción, helper `tenantScoped()`, validar la membresía también en las Edge Functions que leen el claim y regla de lint para lecturas del panel del negocio sin filtro por negocio (lista en la auditoría §9).

- [~] **H119: Más acciones bajo PIN (parcial: cambio de precio y cajón hechos, ADR-056 y ADR-063).** · *BASE `pin_supervisor`. Requiere H116.*
  - [x] Cambio de precio en la línea con precio resuelto en el servidor: `create_sale` valida el precio y el cambio manual pide PIN de `cambio_precio` (`20261019100000_precio_servidor`, ADR-056). *(Auditoría 2026-11-05.)*
  - [ ] Borrar ítem después de un cobro parcial y cancelar cobros en espera (coordinar con `feat/cobros-en-espera`).
  - [ ] Reapertura de turno cerrado (hoy no existe) con PIN y motivo.
  - [x] Abrir el cajón sin venta con PIN opcional. · *ADR-063: política por negocio o sucursal (`drawer_no_sale`: permitido, con PIN o prohibido), acción de PIN `abrir_cajon`, RPC `cash_drawer_open` que decide, registra en `cash_drawer_events` y audita; botón Abrir cajón en el POS y apertura al cobrar en efectivo.*
  - [ ] Reimpresión de tickets con PIN opcional.
  - [ ] Descuento por línea sobre el tope (hoy el trigger mira el descuento general de la venta).

> **Orden sugerido dentro de F17:** fix de sucursal en `create_sale` (H90, ya) → H89 + H90 → H91 → H92 + H93 → H94 + H95 → H96 + H97 → H98 (con F3) → H99. Corte de control: cada hito con tests RLS por rol y sucursal y un escenario de 2 sucursales con turnos simultáneos.

### F18 · Fiscal, contable, precios y compras (Argentina)

Objetivo: que el sistema **registre lo que exige la normativa argentina y le entregue al contador lo que necesita sin retipear**: listas de precios simples o profesionales, compras e importaciones con costeo, motor de impuestos (IVA por alícuota, internos, percepciones, retenciones, padrones), facturación electrónica completa, libros y regímenes de información, contabilidad con asientos automáticos y conciliaciones. Sale de [`auditoria-fiscal-contable-precios.md`](./auditoria-fiscal-contable-precios.md) (auditoría con mirada de contador) y de [ADR-043](./17-decision-log.md). Toda alícuota, tope, mínimo y código de tributo es **parámetro con vigencia**, nunca constante en el código, y cada hito se valida contra la norma vigente al implementarlo.

> **Estado de partida (2026-10-12):** `price_lists` por canal con `adjustment_pct` y `price_list_items` (gateado por `listas_precios`); el precio se resuelve en el navegador y `create_sale` acepta el `unit_price` recibido; `products.tax_rate` numérico (sin distinguir exento, no gravado y 0 %); `products.cost` único; `customers.iva_condition` y `tenant_branding.iva_condition`; sin proveedores, compras, impuestos internos, percepciones, retenciones, padrones, libros ni asientos. `facturacion_afip` es MARKETING-FUTURO (F3 no iniciada). Conciliación de tarjetas en curso (`feat/conciliacion-tarjetas`).

- [~] **H100: Listas de precios simples y profesionales.** · *BASE (validación en servidor, historial, asistente simple, etiquetas) + OPTIONAL `listas_precios` (existe, Business: vigencias, listas por cliente, grupo y condición) + OPTIONAL `listas_precios_pro` (nueva, Business: costo y markup, plazos, moneda, escalas, índices, aprobación). Asignación por sucursal requiere F17/H94.* *Parcial: validación en servidor e historial (ADR-056), listas PRO, programados, plazos, escalas y masivo (ADR-058); faltan franjas, versiones de lista, flejes y precios por tramo.*
  - [x] Listas por canal (mostrador, catálogo, mayorista, personalizada) con % sobre base y precio fijo por producto o variante, gating server-side. *(H10, `price_lists`, `lib/prices/resolve.ts`)*
  - [x] **P0 control interno:** `create_sale` recalcula el precio efectivo de lista (`resolve_unit_price` + modificadores) y rechaza el `unit_price` distinto con `price_mismatch` y el precio esperado; el cambio intencional va marcado con motivo y PIN de `cambio_precio` (o supervisor) y queda en la venta y en auditoría; venta libre por flag y tope por rol; mesas y delivery validados al cargar. *(ADR-056, `feat/precio-servidor`, migración `20261019100000` sin aplicar. Se rechaza en vez de registrar la diferencia como descuento: ver ADR-056.)*
  - [~] Historial de precios y costos por producto, variante y lista (`price_history`: quién, cuándo, motivo, versión) y consulta "¿cuánto valía el 3 de marzo?". *(Precios: `product_price_history` con quién, cuándo y origen, pestaña en la ficha con gráfico, ADR-056, migración `20261019110000`; costos en `product_cost_history`, ADR-050. Falta motivo, versión y la consulta por fecha en pantalla.)*
  - [x] Modo simple: asistente de actualización masiva en 3 pasos (qué: todos, categoría, marca, proveedor, tag; cuánto: % o monto con redondeo; cuándo: ahora o fecha) con vista previa y deshacer. *(ADR-058, `price_bulk_*`)*
  - [~] Vigencia desde y hasta, franja horaria y días; al vencer vuelve a la lista padre, se desactiva o alerta N días antes. *(Desde y hasta hecho, al vencer se usa la lista que sigue, ADR-058; faltan franja, días y alerta.)*
  - [~] Versiones de lista (borrador → aprobada → programada → vigente → histórica) y cambios futuros programados sin tocar la vigente; aprobación opcional con motivo, antes y después y margen resultante. *(Precios programados por fila y lotes masivos con aprobación del dueño, antes y después y deshacer, ADR-058; faltan versiones completas.)*
  - [x] Asignación y precedencia explicable: cliente → grupo de clientes → condición de pago → sucursal → canal → base (`price_list_assignments`; `customers.group_id` ya existe). *(ADR-058: elegida en el POS → cliente → grupo → sucursal → grupo de sucursales → mostrador; la condición es un recargo sobre la lista.)*
  - [~] Listas derivadas: de otra lista o de **costo** (reposición, promedio ponderado o último) con **markup** o **margen objetivo** (mostrando ambos), piso, techo y margen mínimo con alerta; reglas por categoría, marca, proveedor y tag (`products.tags` ya existe). *(Derivadas, sobre costo, piso y margen mínimo hechos, ADR-058; faltan techo y reglas por alcance dentro de la lista: hoy el alcance está en la actualización masiva.)*
  - [~] Redondeo por múltiplo, terminación psicológica (,99 / 9 / 90) y por tramo de precio. *(Múltiplo y terminación hechos, ADR-058; falta por tramo.)*
  - [x] Plazos y condiciones: contado, 30, 60, 90 días con **recargo financiero** (tasa mensual o TNA, simple o compuesto, cálculo visible), tomado de la ficha del cliente de cuenta corriente. *(ADR-058, tasa mensual; TNA se carga como % fijo.)*
  - [~] Moneda extranjera: lista en USD con conversión por tipo de cambio de referencia (BNA vendedor, MEP o manual) con fecha de corte (`fx_rates`); factura en pesos o en moneda extranjera con cotización. *(Lista en moneda con cotización hecha, ADR-058; factura en moneda con F3.)*
  - [~] Escalas por cantidad y por bulto o caja; unidad de venta distinta de la de stock. *(Escalas por cantidad hechas, ADR-058; falta la unidad de venta por bulto o caja.)*
  - [~] Actualización por índice (IPC, dólar, índice propio) con tope y registro del valor usado; actualización desde la lista del proveedor (import con mapeo de columnas guardado por proveedor, comparación con el costo actual, nueva versión en borrador). *(Índice y dólar con tope hechos, ADR-058; import XLSX de la lista del proveedor con mapeo guardado por proveedor y vista previa de la variación, ADR-059 `supplier_price_list_apply`; falta generar la versión de la lista de venta en borrador.)*
  - [~] Etiquetas: cola "precios cambiados desde la última impresión" por sucursal; flejes de góndola con precio por unidad de medida y, si corresponde, precio sin impuestos nacionales (sobre el perfil `product_label` existente). *(Cola por sucursal hecha, ADR-058; faltan los flejes.)*
  - [~] *Criterio:* un comprador importa la lista de un proveedor en USD, el sistema propone precios con markup 60% redondeados a 9, el dueño aprueba con vigencia desde el lunes, el lunes cambian solos y se imprimen los flejes de lo que cambió. *(Lista del proveedor en moneda con TC, lista sobre costo con markup, redondeo, lote masivo con aprobación y programado que aplica solo: ADR-058 y ADR-059; faltan los flejes de góndola.)*

- [~] **H101: Compras, proveedores y costos.** · *OPTIONAL `compras` (nueva, Pro); los tres costos por producto son BASE. Detalla y reemplaza la parte de compras de F14/H64.* · *v1 en `feat/compras-proveedores` (ADR-050, migraciones `20261016100000` a `20261016100300` sin aplicar).*
  - [~] Proveedores: CUIT validado contra padrón (H104), condición IVA, alícuotas de padrones, condición de pago, moneda, contactos, baja lógica. *(v1: CUIT con dígito verificador, condición IVA, plazo, moneda, contacto, CBU/alias, baja lógica, ADR-050; alícuotas de padrones por CUIT desde el import de ARBA y AGIP, ADR-068; falta validar el CUIT contra el padrón de ARCA)*
  - [x] Producto por proveedor: código del proveedor, último costo, mínimo de pedido, unidad de compra y conversión. *(conversión en la OC: pendiente)*
  - [x] Orden de compra (abierta → confirmada → recepción parcial → cerrada / cancelada), manual o sugerida por stock mínimo. *(borrador → enviada → recibida en parte → recibida / cancelada; sugerencia por sucursal; impresión y envío por WhatsApp o mail)*
  - [x] Recepción por remito con diferencias y actualización de stock por sucursal (F17/H94).
  - [~] Factura de proveedor: neto por alícuota, IVA crédito fiscal, percepciones sufridas (IVA, IIBB por jurisdicción), impuestos internos, no gravado, exento; asociada a OC y remito (control de tres vías). *(v1: todo como líneas libres y vínculo con recepciones; falta control de tres vías automático)*
  - [x] Cuenta corriente de proveedores, notas de crédito y débito, órdenes de pago (con retenciones como agente, H106), anticipos. *(v1 ADR-050: saldo, aging, NC/ND. v2 ADR-059: órdenes de pago con imputación, pago parcial y a cuenta (anticipo), efectivo de la caja propia, banco y cheques. v3 ADR-079: retenciones como agente calculadas por el servidor con certificado PDF)*
  - [x] Devoluciones al proveedor con salida de stock por sucursal, lote, recálculo del promedio y NC vinculada; anulación de recepciones con reversa de stock, costos y OC. *(ADR-059, `feat/compras-v2`)*
  - [x] Costos por producto: **reposición**, **promedio ponderado** y **último**, con historia; el usuario elige cuál alimenta el markup (H100). Crédito fiscal computable nunca se suma al costo.
  - [~] Multi-moneda por operación (compra en USD, tipo de cambio de la factura y del pago, diferencia de cambio para H109). *(v1: moneda y TC por operación en modo profesional; falta diferencia de cambio)*
  - [x] *Criterio:* se recibe parcial una OC, se carga la factura con percepción de IIBB ARBA, el costo promedio se actualiza y la deuda con el proveedor queda en su cuenta corriente. *(`tests/integration/rls-compras.test.ts`: recepción parcial, factura con percepción de IIBB Buenos Aires, promedio y saldo en la cuenta corriente; migraciones sin aplicar en producción)*

- [~] **H102: Importaciones y costeo de importación.** · *OPTIONAL `importaciones` (nueva, Enterprise). Requiere H101.* · *v1 como `compras_importacion` (Business, ADR-050): hoja de costeo sobre la recepción con prorrateo por concepto y n° de despacho en el lote; faltan carpeta de importación, TC del pago y despacho en la venta.*
  - [~] Carpeta de importación: proveedor del exterior, factura comercial, incoterm, FOB, flete internacional, seguro, **CIF**. *(Hoja de costeo sobre la recepción con FOB, flete, seguro y CIF en moneda de origen, ADR-050, `lib/purchases/landed.ts`; falta la carpeta como entidad propia con proveedor del exterior, factura comercial e incoterm.)*
  - [~] Tributos aduaneros sobre CIF con vigencia: derechos de importación por posición NCM, tasa de estadística, IVA, percepción de IVA adicional, percepción de Ganancias, percepción de IIBB aduanera y "otros tributos" parametrizables. *(ADR-050: derechos por línea según NCM, tasa de estadística con tope, otros tributos de costo, IVA y percepciones de IVA adicional y Ganancias aparte como crédito; las alícuotas son parámetros de cada hoja, falta el catálogo con vigencia.)*
  - [x] Gastos de nacionalización: despachante, terminal, depósito fiscal, flete interno, gastos bancarios. *(ADR-050, `lib/purchases/landed.ts`)*
  - [x] Prorrateo configurable por concepto (valor, peso, volumen o cantidad) y costo unitario puesto en depósito por producto y lote; crédito fiscal separado del costo. *(ADR-050: prorrateo por valor, peso, volumen o cantidad en centavos exactos, costo puesto en depósito por línea y lote, crédito fiscal fuera del costo; `tests/unit/purchasesLanded.test.ts`)*
  - [~] Tipo de cambio por operación (oficializado del despacho y del pago) y diferencia de cambio. *(TC del despacho en la hoja y TC por OC y recepción, ADR-050; faltan el TC del pago y la diferencia de cambio.)*
  - [~] **N° de despacho** (`AAaaaTTTTnnnnnnX`) por lote, disponible para consignarlo en la factura de venta cuando la norma lo exija; datos del importador y de licencias. *(ADR-059: consumo por lote FEFO/FIFO en la venta y trazabilidad lote y despacho → ventas; falta imprimirlo en la factura, F3/H107)*
  - [~] *Criterio:* una carpeta con 3 productos, flete prorrateado por peso y seguro por valor da el costo unitario y el n° de despacho aparece en la venta del lote. *(Costeo con prorrateo por peso y valor, ADR-050, y n° de despacho del lote en sus ventas (`lot_sales`), ADR-059; falta imprimirlo en el comprobante de venta, F3/H107.)*

- [~] **H103: Motor de impuestos: IVA por alícuota e impuestos internos.** · *BASE `impuestos_iva` (catálogo de alícuotas IVA) + OPTIONAL `impuestos_internos` (nueva, Pro). Prerrequisito de F3.* · *ADR-068, `feat/impuestos`, migraciones `20261028100000` a `20261028100300` sin aplicar.*
  - [x] Catálogo cerrado de condición IVA por producto: **21 %, 10,5 %, 27 %, 5 %, 2,5 %, 0 %, exento, no gravado** (exento y no gravado separados para el Libro IVA); migración de `products.tax_rate`. *(ADR-068: `tax_rate_code` con `tax_rate` espejo, por variante, servicio)*
  - [ ] Alícuota por operación cuando depende del receptor o del destino (por ejemplo 27 % a responsables inscriptos en ciertos servicios).
  - [x] Cálculo por ítem de neto, IVA y precio final, con precios cargados con o sin IVA. *(ADR-068: lista con o sin IVA, reparto por resto mayor, IVA por alícuota sobre base agregada, paridad TS/SQL)*
  - [~] Impuestos internos por rubro con alícuota y vigencia, **tasa nominal vs. efectiva**, "incluido en precio" sí/no, discriminación en factura A y tratamiento en la base de IVA; por producto y por sucursal. *(ADR-068: por producto, fijo, % sobre precio nominal o % sobre costo, incluido o adicional, fuera de la base de IVA; faltan vigencia por decreto y por sucursal)*
  - [~] Transparencia Fiscal al Consumidor (Ley 27.743): IVA contenido y otros impuestos nacionales indirectos por ítem para la factura B y, si corresponde, para la exhibición. *(ADR-068: en el ticket B; falta en la exhibición y en la factura con F3)*
  - [~] *Criterio:* una venta mixta (21 %, 10,5 %, exento y una bebida con internos) calcula por ítem y totaliza igual que el Libro IVA. *(Cálculo por ítem con paridad TS y SQL (`sale_tax_preview`) y reporte de IVA ventas probados en `tests/integration/rls-impuestos.test.ts`; falta el caso de cruce contra el Libro IVA con internos.)*

- [~] **H104: Padrones y condición fiscal de clientes y proveedores.** · *BASE `impuestos_iva` (carga manual) + OPTIONAL `percepciones_retenciones` (Business: padrones; ADR-068 unifica `padrones`, `percepciones` y `retenciones`).*
  - [x] Condición fiscal ampliada: RI, monotributo (categoría), monotributo social, exento, CF, no alcanzado, sujeto no categorizado. *(ADR-068, más no responsable, IVA liberado y exterior, con ids de ARCA, documento validado en el servidor y letra inferida; falta la categoría de monotributo)*
  - [ ] Consulta de constancia de inscripción de ARCA por CUIT (web service de padrón vigente) al alta: razón social, domicilio fiscal, condición IVA, actividades; cache con fecha y re-validación periódica.
  - [~] Padrones provinciales periódicos (ARBA, AGIP y otras jurisdicciones) importados por job con alícuotas de percepción y retención por CUIT y vigencia; historial (se usa la alícuota vigente a la fecha del comprobante). *(ADR-068: import manual por partes de ARBA, AGIP y genérico con historial por período; falta la descarga programada)*
  - [~] Certificados de exclusión (IVA, Ganancias, IIBB) con vigencia y porcentaje, cargados o consultados. *(ADR-068: cargados; falta la consulta)*
  - [ ] Alertas: CUIT dado de baja, padrón vencido sin actualizar, monotributista cerca de tope.
  - [~] *Criterio:* al cargar un CUIT se completan razón social y condición IVA, y la percepción de ARBA usa la alícuota del padrón del mes. *(La percepción de ARBA usa la alícuota del padrón importado, `tests/integration/rls-impuestos.test.ts`; falta completar razón social y condición desde ARCA por CUIT.)*

- [~] **H105: Percepciones (el comercio como agente).** · *OPTIONAL `percepciones_retenciones` (nueva, Business, ADR-068). Requiere H103 y H104; jurisdicción por sucursal en F17/H98.*
  - [x] Motor de reglas: jurisdicción × impuesto × condición del cliente → alícuota (padrón o general) + mínimo de base + mínimo de percepción + exclusiones vigentes. *(ADR-068, `tax_regimes`)*
  - [x] Percepción de IVA para agentes designados (RG 2408 y regímenes específicos). *(ADR-068: régimen configurable con alícuota por condición)*
  - [~] Percepción de IIBB: ARBA, AGIP/ARCIBA (incluido alto riesgo fiscal), Convenio Multilateral y jurisdicción genérica con padrón importable; percepciones municipales como "otros tributos". *(ADR-068: ARBA, AGIP y genérica con padrón; faltan coeficientes de CM y municipales)*
  - [~] Percepciones en el comprobante, en el array `Tributos` de WSFE, en el ticket y en NC (reversa proporcional). *(ADR-068: en la venta con id de tributo, en el POS y en el ticket; array `Tributos` de WSFE en ADR-072; falta la reversa proporcional en NC)*
  - [~] *Criterio:* una factura A a un RI de Provincia de Buenos Aires suma la percepción de IIBB del padrón y de IVA si corresponde, y ambas salen en la DDJJ del mes. *(La factura A a un RI del padrón suma IIBB e IVA, `tests/integration/rls-impuestos.test.ts`; falta la DDJJ de percepciones del mes, H108.)*

- [~] **H106: Retenciones (como agente y como sujeto).** · *OPTIONAL `percepciones_retenciones` (Business, ADR-068). Requiere H101 y H104.* · *ADR-068: retenciones de IIBB e IVA sugeridas desde el padrón y vista `tax_suffered`. ADR-079 (`feat/retenciones-agente`, migraciones `20261104200000` y `20261104200100` sin aplicar): **como agente completo**; falta como sujeto (SIRTAC / SIRCREB / "Mis Retenciones").*
  - [x] Como agente al pagar a proveedores: Ganancias (RG 830: concepto, escala, mínimo no sujeto, acumulado mensual), IVA (agentes designados), IIBB por jurisdicción, SUSS (contratistas de construcción, limpieza, seguridad); certificado de retención en PDF. *(ADR-079: cálculo en el servidor con desglose explicado en la orden de pago, certificado correlativo por régimen en PDF, registro de retenciones practicadas, archivos SICORE y ARBA, asiento contable; valores de la RG 830 y SUSS sembrados y ajustables, a verificar con contador. AGIP e-ARCIBA y otras provincias: deuda)*
  - [~] Como sujeto: registro de retenciones y percepciones sufridas (proveedores, tarjetas vía **SIRTAC**, bancos vía **SIRCREB**, impuesto a los débitos y créditos) para imputarlas en DDJJ; import desde la liquidación (H110) y desde "Mis Retenciones" de ARCA. *(Percepciones sufridas en compras registradas en la vista `tax_suffered`, ADR-068; faltan tarjetas (SIRTAC), bancos (SIRCREB), débitos y créditos y el import desde "Mis Retenciones".)*
  - [x] *Criterio:* una orden de pago calcula la retención de Ganancias con el acumulado del mes, emite el certificado y queda para SICORE/SIRE. *(ADR-079; SIRE queda para H108)*

- [~] **H107: Facturación electrónica completa.** · *OPTIONAL `facturacion_afip` (función real desde ADR-072) + OPTIONAL `factura_exportacion` (nueva, Enterprise). Extiende F3; requiere H103, H104 y F17/H98.*
  - [x] Decisión automática del tipo de comprobante: A, B, C, M según emisor y receptor; tope de identificación del consumidor final como parámetro con vigencia. *(ADR-068 y ADR-072)*
  - [x] Condición frente al IVA del receptor informada en WSFE; arrays `AlicIva` y `Tributos` (internos, percepciones) desde H103 y H105; ids desde `FEParamGetTiposIva` y `FEParamGetTiposTributos`. *(ADR-072; las tablas se consultan desde el asistente)*
  - [~] Moneda extranjera (`MonId`, `MonCotiz`); conceptos de servicios con fechas; comprobantes asociados en NC y ND. *(Conceptos de servicios con fechas y comprobantes asociados en NC hechos, ADR-072 `_shared/arca/wsfe.ts`; faltan moneda extranjera (hoy `MonId` PES) y notas de débito.)*
  - [ ] **Factura de Crédito Electrónica MiPyME** (Ley 27.440, tipos 201 a 213): monto mínimo, CBU, aceptación o rechazo, vínculo con cuenta corriente.
  - [ ] **Factura E** de exportación (WSFEX) con incoterm y permiso de embarque.
  - [x] QR fiscal en el impreso, CAEA de contingencia por PV, almacenamiento del request y response. *(ADR-072)*
  - [ ] *Criterio:* el sistema emite A, B, C, NC, FCE y E en homologación con percepciones e internos y todas cierran contra el Libro IVA.

- [~] **H108: Libros y regímenes de información.** · *Libro IVA Digital dentro de OPTIONAL `facturacion_afip` (ADR-076); SICORE, SIRE y DDJJ de IIBB en OPTIONAL `export_contable` (nueva, Pro). Requiere F3 (ventas) y H101 (compras).* · *ADR-076, `feat/libro-iva-digital`, migración `20261103100000` sin aplicar.*
  - [~] Libro IVA Digital ventas y compras (RG 4597) con archivos de importación; prorrateo de crédito fiscal si hay operaciones exentas. *(ADR-076: VENTAS_CBTE, VENTAS_ALICUOTAS, COMPRAS_CBTE y COMPRAS_ALICUOTAS en zip con revisión previa en lenguaje simple, en Contabilidad > Libro IVA Digital; falta el prorrateo, el período de imputación de compras, COMPRAS_IMPORTACIONES y validar el formato con un contador y una importación real)*
  - [~] SICORE y SIRE (retenciones y percepciones practicadas). *(SICORE de retenciones practicadas de Ganancias, IVA y SUSS, ADR-079 `lib/tax/sicore.ts`; faltan percepciones practicadas y SIRE.)*
  - [~] DDJJ de IIBB: ARBA, e-ARCIBA, SIFERE (Convenio Multilateral, coeficientes CM05), SIRCAR; base y tributo de impuestos internos. *(ARBA agente de retención (actividad 6), ADR-079; faltan percepciones de ARBA, e-ARCIBA, SIFERE, SIRCAR e internos.)*
  - [ ] Exportador genérico por plantilla para otros regímenes de información provinciales o nacionales.
  - [ ] *Criterio:* a fin de mes el contador baja Libro IVA ventas y compras, SICORE y la DDJJ de ARBA y los importa sin retipear.

- [~] **H109: Contabilidad: plan de cuentas, asientos, cierres y export a estudios.** *(2026-10-12, ADR-066, `feat/contabilidad`, migraciones `20261029100000` a `20261029100300` sin aplicar; ver [`31-contabilidad.md`](./31-contabilidad.md))* · *OPTIONAL `contabilidad` (nueva, Business, hecha) + OPTIONAL `export_contable` (Pro, con H108) + ADDON `integracion_erp` (nueva, por conector). Centros de costo requieren F17/H89.*
  - [x] Plan de cuentas con plantilla argentina comercial precargada, niveles y edición (árbol, imputables, código externo del estudio). *(ADR-066)*
  - [x] Mapeos: medio de pago y adquirente → cuenta con **código ERP** (código externo de la cuenta), caja de cada sucursal → cuenta, IVA y tributos → cuentas, CMV y stock → cuentas, proveedores, tesorería y procesadores. *(ADR-066; cuotas como calificador: pendiente)*
  - [x] Asientos automáticos por **venta**, **cobro**, devolución, **compra**, **pago**, cierre de caja, ingresos y retiros de caja, liquidación de procesadores, contracargos y movimiento de tesorería; detallados y resumidos al exportar (día o mes y sucursal); inmutables, corrección por contra-asiento; regeneración de un período abierto. *(ADR-066)*
  - [x] Centros de costo por sucursal (y opcional por unidad de negocio). *(ADR-066)*
  - [~] Cierre mensual (bloqueo de período, numeración del Diario, re-apertura del dueño auditada). *(ADR-066; diferencias de cambio: pendiente)*
  - [x] Libros Diario, Mayor y Balance de sumas y saldos; estado de resultados; resumen de IVA Ventas y Compras. *(ADR-066)*
  - [~] Export a estudios contables: Tango, Holistor, Xubio, Colppy y CSV con layout configurable, y XLSX de cada libro. *(ADR-066; layouts a validar con un estudio; Bejerman y conectores con API: ADDON; API y webhooks en F14/H68)*
  - [ ] Ajuste por inflación: el POS exporta datos con fecha y moneda homogénea; el ajuste (RT 6 contable, Título VI de Ganancias impositivo) se resuelve en el sistema contable del estudio. Evaluar cálculo propio en una etapa posterior.
  - [ ] *Criterio:* a fin de mes el estudio recibe los asientos por sucursal en el formato de su sistema y cuadran con el Libro IVA y los Z.

- [~] **H110: Conciliación de tarjetas, billeteras y bancos.** · *OPTIONAL `conciliacion_tarjetas` (nueva, Business) + OPTIONAL `conciliacion_bancaria` (nueva, Business). Requiere el n° de comercio y F17/H93; enlaza con F8/H21b.*
  - [x] Reporte de conciliación de tarjetas con `payments.card_voucher` (incluido n° de comercio) y `payments.reconciled_at`. *(ADR-044, migración `20261012120000_conciliacion_tarjetas`, `modules/reports/cardReconciliation.ts`)*
  - [~] Import de liquidaciones: **Mercado Pago por API, automático todos los días** (`payments/search`, cada credencial del negocio y de las sucursales); **Payway, Getnet, Fiserv/Posnet, Nave u otro por XLSX o CSV** con mapeo de columnas. *Hecho en `feat/detalle-venta-conciliacion` (ADR-061, feature `conciliacion_procesadores`, Business). Pendiente: MODO, Mobbex, Pagos360 y Directo con preset; presets de columnas guardados; Payway por API si la publican.*
  - [~] Matching automático por id del procesador o intent, **n° de comercio + lote + cupón**, autorización + últimos 4, y monto + día con pareja única; estados Conciliado, Cobro sin venta, Venta sin cobro, Diferencia de monto, Revisado, y Acreditado / Pendiente de acreditación. *Hecho (ADR-061). Contracargos, reclamos y devoluciones como estado propio (Devuelto, Devuelto parcial, Contracargo, Reclamo abierto) con neto efectivo, KPI, filtros y plazo de documentación: hecho en `feat/contracargos-devoluciones` (ADR-064).*
  - [~] **Alertas de contracargos y devoluciones de Mercado Pago** (feature BASE `alertas_contracargos`): detección en la sincronización diaria y por aviso de MP (`topic_chargebacks_wh`, `topic_claims_integration_wh`), `payment_disputes`, notificación al dueño y encargados, marcas y filtro "Con alertas" en Ventas, detalle en Cobros y tarjeta en el Panel del dueño. *Hecho en `feat/contracargos-devoluciones` (ADR-064, migración `20261027100000` sin aplicar). Pendiente: suscribir los dos tópicos en la aplicación de MP, validar con un contracargo real la búsqueda de casos por pago, resumen diario por email y subir la documentación del contracargo desde NinjaPos (`POST /v1/chargebacks/{id}/documentation`).*
  - [~] Comisiones, IVA sobre comisiones, retenciones y percepciones sufridas separadas del bruto por cobro (Mercado Pago por `charges_details`; archivos por columna). *Hecho el detalle por cobro (ADR-061). Pendiente: asiento (H109) y registro para H106.*
  - [x] Detalle de la venta con los cobros y los datos del procesador (comisiones, neto, acreditación, tarjeta, pagador) traídos por API con la credencial del cobro. *(ADR-061)*

  - [x] **Integración con NubCeo** (conciliador externo): envío de cada venta con sus cobros, ritmo y ventana, solo simular, mapeo de campos y medios, monitor de envíos, anulaciones y devoluciones, e importación de los asientos contables de NubCeo (API o CSV). *(2026-10-12, ADR-062, `feat/nubceo`, migraciones `20261025100000` y `20261025100100` sin aplicar, Edge `nubceo_sync` sin desplegar)* · *OPTIONAL `integracion_nubceo` (nueva, Business, también add-on).* Ver [`30-nubceo.md`](./30-nubceo.md).
  - [ ] Conciliación del turno: marcar un Z como conciliado con motivo.
  - [~] Conciliación bancaria: extracto importado contra cobros, depósitos, pagos y liquidaciones; SIRCREB e impuesto a los débitos y créditos. *(Conciliación manual de movimientos de tesorería con referencia del extracto, ADR-059; faltan el import del extracto, SIRCREB y débitos y créditos.)*
  - [ ] BIN de tarjeta → banco y medio (opcional).
  - [x] *Criterio:* el dueño sube la liquidación de Prisma de Norte y ve qué cupones se acreditaron, cuáles faltan y cuánto se llevó de comisión y retenciones. *(ADR-061: import de Payway por archivo con n° de comercio y lote, estados Acreditado y Pendiente, arancel y retenciones por columna)*

- [~] **H111: Tesorería multi-sucursal.** · *OPTIONAL `tesoreria` (nueva, Business). Requiere F17/H89.* · *Básica en `feat/compras-v2` (ADR-059, requiere `compras`): cuentas de caja general y bancos, movimientos, transferencias, conciliación manual, cheques propios y de terceros y flujo de fondos proyectado.*
  - [~] Caja fuerte por sucursal, retiros del cajón (por límite con motivo), depósitos al banco y transferencias entre sucursales, con comprobante adjunto. *(Cuentas de caja general por sucursal, banco y transferencias entre cuentas, ADR-059 `tesoreria`; faltan el retiro del cajón por límite y el comprobante adjunto.)*
  - [ ] Rendiciones por medio de pago con estados (pendiente de aprobación → entregado) y fondo fijo de cambio.
  - [~] Saldo teórico vs. contado por cuenta (cajero, caja fuerte, banco) y asiento (H109). *(Saldo y saldo conciliado por cuenta en `treasury_balances`, ADR-059, y asiento de los movimientos de tesorería, ADR-066; falta el contado contra el teórico.)*
  - [ ] *Criterio:* el encargado de Norte retira efectivo al llegar al límite, lo deposita y el dueño ve el dinero en tránsito hasta el banco.

- [~] **H112: Registros de producto, códigos y régimen de precios ("tag registration").** · *BASE (campos y validaciones) + OPTIONAL `sepa` (nueva, Enterprise). SEPA por sucursal requiere F17/H94. **Interpretación a confirmar con el dueño** (ver §5 de la auditoría).*
  - [~] Tags de producto como alcance de reglas de precio, promociones, impuestos y reportes (`products.tags` existe). *(Tags como alcance de la actualización masiva de precios, ADR-058; faltan promociones, impuestos y reportes.)*
  - [~] GTIN/EAN con validación de dígito verificador, prefijo de empresa GS1 y códigos de balanza. *(Códigos de balanza EAN-13 con dígito verificador, ADR-063 `lib/barcode/scaleLabel.ts`; falta validar el GTIN del producto y el prefijo GS1.)*
  - [ ] Registros sanitarios y técnicos por producto con n° y vencimiento: RNPA/RNE (alimentos), ANMAT (productos médicos y cosméticos), SENASA, INV, certificación de seguridad eléctrica y etiqueta de eficiencia energética; alerta y bloqueo opcional de venta si venció.
  - [ ] Régimen de información de precios SEPA (cadenas alcanzadas): archivo diario por sucursal desde las listas vigentes; marca de productos adheridos a programas oficiales de precios con su tope.
  - [ ] *Criterio:* un producto con RNPA vencido avisa al venderlo y la cadena genera el archivo SEPA del día por sucursal.

> **Orden sugerido dentro de F18:** H100 (validación de precio, P0) → H103 + H104 (base fiscal, antes de F3) → F3 + H107 + F17/H98 → H100 completo → H101 + H102 → H105 + H106 → H108 + H109 + H110 + H111 → H112. Corte de control: casos de prueba fiscales validados con un contador (venta mixta de alícuotas, percepción con padrón, NC con percepción, FCE) y conciliación de un mes real de tarjetas.

---

## TX — Mejoras transversales (UX y datos)

Quick wins pedidos explícitamente. Se hacen **primero** y luego se aplican de forma continua en todo el producto. No son una fase con fin: son estándar del proyecto.

- [x] **TX-1 — Calendario unificado con react-day-picker.**
  - [x] Librería: **react-day-picker (v9)** + **Radix Popover** (patrón shadcn), estilado con Tailwind/cva como el resto del sistema. Locale **español (es)** vía date-fns. *(Se descartó flatpickr por ser JS vanilla y chocar con el stack React/Radix; ver ADR.)*
  - [x] **Un solo calendario**, con **selección de rango** (desde/hasta) donde aplique (reportes, ventas, auditoría interna; promociones/suscripciones cuando existan).
  - [x] Presets rápidos (hoy, ayer, últimos 7/30 días, este mes, mes pasado).
  - [x] Componente reutilizable `DateRangePicker` único (`components/ui/DateRangePicker.tsx`); adoptado en /reportes, /ventas y /internal/audit.
  - [x] *Criterio:* en reportes se elige "últimos 30 días" o un rango con un calendario en español; mismo componente en todos lados.

- [x] **TX-2 — Exportaciones en XLSX con diseño (reemplazo de CSV).**
  - [x] Eliminar CSV como formato de export. Usar **XLSX con diseño**: encabezados con color de marca, filas alternadas, **fila de totales**, formato de moneda/fecha, **filtros (autofilter)** y **paneles congelados** (freeze header). *(`lib/utils/xlsx.ts`)*
  - [x] Aplicado a ventas, reportes, caja/cierres, stock/productos, clientes, CxC, garantías; nombre de archivo con fecha. *(promociones cuando exista F9)*
  - [x] Helper único `exportXlsx()` reutilizable.
  - [x] *Criterio:* descargar "Ventas del mes" da un .xlsx con encabezado de marca, totales, autofilter y header congelado.

- [x] **TX-4 — Importaciones masivas XLSX como estándar (reemplaza CSV).** — *Completado (2026-10-13, ADR-078): motor único, revisión en el servidor (dry-run), confirmación y auditoría para productos, clientes, stock por sucursal, listas de precios, sucursales, garantías y motivos; página `/importaciones` con export de la base completa. Migraciones `20261104100000` y `20261104100100` sin aplicar.*
  - [x] **Todo se importa en XLSX** con el asistente único de 3 pasos (`components/import/ImportWizard.tsx`): productos, clientes, **stock por sucursal**, **listas de precios**, **sucursales** (locales o depósitos), **garantías extendidas** y **motivos de devolución**. *(Medios de pago: los planes de cuotas ya se importan por medio en H27; las credenciales nunca van en un archivo. Depósitos internos de una sucursal dependen de H33.)*
  - [x] **Plantillas XLSX** generadas con `exportXlsx`: hoja de datos con ejemplo, obligatorias con `*`, listas desplegables donde aplica y hoja **Instrucciones**.
  - [x] **Exportar toda la base** en un XLSX (productos, clientes, stock por sucursal, listas, sucursales, garantías y motivos) desde `/importaciones`, con los encabezados de las plantillas para reimportar; se mantiene "Exportar XLSX" en productos y clientes.
  - [x] Toda importación: validación previa (Zod por fila), preview, **dry-run en el servidor** (misma lógica, revertida), conteos crear / actualizar / omitir, confirmación, **errores por fila descargables en XLSX** y auditoría por lote. Sin imports silenciosos.
  - [x] Helper único de import (`lib/utils/xlsxImport.ts` + `lib/import/`: encabezados tolerantes a mayúsculas y acentos, fila de encabezados detectada, tipos, duplicados, filas vacías) + `exportXlsx` (TX-2) para plantillas, errores y export de base. RPC `import_*` SECURITY DEFINER (dueño o encargado, `importacion_excel` y la feature de cada entidad).
  - [x] *Criterio:* el usuario baja la plantilla de productos, la completa, la importa con preview y errores por fila; y puede exportar toda su base de clientes/productos en XLSX.

- [~] **TX-5 — Reportes PRO configurables por usuario.** — *Base hecha (PR #46): mostrar/ocultar reportes persistido. Falta orden, más reportes y filtros guardables.*
  - [~] **Tablero de reportes configurable**: cada usuario **muestra/oculta** reportes con "Personalizar"; persistido en `users.settings.reports` (cross-device, merge sin pisar apariencia). **Orden (drag) pendiente.**
  - [~] **Catálogo de reportes ampliable**: día/medio/categoría/cajero + **top productos** + **stock bajo** + **top clientes** (PR #49). Comparativo contra el período anterior hecho (`app/(app)/reportes/page.tsx`, toggle "rep-compare"); margen sólo en gastronomía por receta (F13/H52, `modules/reports/api.ts`). Falta margen general por producto.
  - [ ] Filtros guardables (rango/sucursal/medio/categoría) y presets por usuario.
  - [x] **Reporte Excel avanzado**: export multi-hoja con marca, totales, autofilter, header congelado, formato moneda/fecha (`exportXlsx`).
  - [~] *Criterio:* el usuario muestra/oculta reportes y lo encuentra igual en otro dispositivo; descarga Excel. (Orden y filtros guardables pendientes.)

- [ ] **TX-3 — Pulido UX continuo.**
  - [ ] Estados vacíos, skeletons, toasts consistentes, accesibilidad, atajos de teclado en POS.
  - [ ] Se evalúa al cierre de cada hito como parte del gate manual.

---

## Benchmark de mercado (qué hace a un POS "pro")

Análisis de referentes (Square, Toast, Lightspeed, Clover, Shopify POS; locales: Fudo, Bistrosoft, Maxirest, Aligare; enterprise Latam: **Napse/TOTVS**). Mapeo de capacidades pro → dónde las cubre NinjaSoft. Sirve para validar que el roadmap no tenga huecos.

| Capacidad pro del mercado | Dónde la cubre NinjaSoft |
|---|---|
| Venta rápida, búsqueda, carrito, descuentos, pago mixto | F1 (MVP) + F8/H14 |
| Pantalla táctil de catálogo chico por botones | **F12/H36** |
| Modificadores simples por tamaño/sabor/topping | **F12/H37** + F13/H47 + F9/H54 para promos |
| Agenda, turnos, walk-ins y cobro desde servicio | **F12/H38** |
| Comisiones, propinas y productividad por profesional | **F12/H39** |
| Packs de sesiones, membresías simples y gift cards | **F12/H41** + F9/H55 |
| Promociones avanzadas (NxM, combos, cupones, fidelización, gift cards) | **F9 (nuevo)** |
| Pasarelas de pago presenciales y QR (MP Point, MODO, Payway, Getnet, Fiserv, etc.) | F8/H15+ |
| Orquestador de pagos, ruteo, conciliación, alarmas y fallback tipo VTOL | **F8/H21b** + F16/H85 |
| Facturación electrónica / fiscal (AFIP, CAE) | F3 |
| Fiscal hub multi-canal, contingencia, XML/PDF, almacenamiento y multi-país | **F16/H79** + F3 |
| Fotos de producto, branding, tickets a medida, catálogo público | F6 |
| Multi-sucursal, multi-caja, transferencias de stock | F4 → **F17/H89–H95** |
| Indicador y selector de sucursal y caja ("dónde estoy") | **F17/H90** |
| Configuración central con override por sucursal y caja (medios, tickets, impresión, POS) | **F17/H92** (primer corte de F14/H57) |
| Registro de terminales de cobro por sucursal y caja, n° de comercio | **F17/H93** |
| Listas de precios PRO: vigencias, programación, costo y markup, plazos, moneda, escalas, índices, etiquetas | F6/H10 + **F18/H100** |
| Compras, proveedores, costos e importaciones con costeo | F14/H64 → **F18/H101–H102** |
| Motor de impuestos: IVA por alícuota, internos, percepciones, retenciones, padrones | **F18/H103–H106** |
| Facturación electrónica completa (A/B/C/M/E, FCE MiPyME, tributos) y libros (Libro IVA Digital, SICORE/SIRE, DDJJ IIBB) | F3 + **F18/H107–H108** |
| Contabilidad: plan de cuentas, asientos, export a contador/ERP | **F18/H109** |
| Conciliación de tarjetas, liquidaciones y bancos por n° de comercio | **F18/H110** (+ F8/H21b) |
| Tesorería: caja fuerte, retiros a banco, rendiciones | **F18/H111** |
| Registros de producto (GTIN, sanitarios), SEPA y tags | **F18/H112** |
| Inventario avanzado: lotes, vencimientos, series, conteos, alertas | **F14/H64** |
| Compras y proveedores (órdenes de compra, recepción, costos) | **F14/H64** |
| Cuenta corriente de clientes (fiado) | **F11/H31** + gancha con F9/H55 |
| Cuenta corriente de proveedores | **F14/H64** |
| Medios de pago con variantes, cuotas y recargos | **F11/H27** |
| Configuración enterprise de cuotas, add-ons, límites y entitlements | **F14/H58** |
| Motor de recargos, financiación, tasas y redondeos por contexto | **F14/H59** |
| Gobierno de reglas comerciales, approvals y rollback | **F14/H60–H63** |
| Garantías extendidas con prima y comisión | **F11/H28** |
| Devoluciones/cambios con vales y motivos | **F11/H29** |
| Pedidos de salón, reservas y despacho separado | **F11/H32** |
| Depósitos, stock multi-depósito y transferencias | F4 + **F11/H33** + **F17/H94–H95** |
| Importación masiva por Excel de datos maestros | **F11/H34** + **TX-4** |
| Restaurante: mesas, comandas, KDS, división de cuenta, modificadores | **F13/H43–H52** |
| Variantes (talle/color), SKU compuesto (textil) | F6/H10 + F5 (perfil textil) |
| Ficha de producto PRO (marca, IVA, tags, temporada, foto WebP, garantía) | **F6/H10b** |
| Catálogo de marcas y categorías de 2 niveles | **F6/H10b** |
| Catálogos precargados / alta masiva por compra (storefront) | **F6/H10c (Tiendita)** |
| Control de stock por producto (servicios) y kit/combo con BOM | **F6/H10b** (+ F12/H35 sin stock) |
| Producto serializado (IMEI / N° de serie) | **F6/H10b** + F14/H64 (series enterprise) |
| Cierre Z inmutable e historial contable de caja | **F11/H30b** |
| Devoluciones, cambios, notas de crédito | **F11/H29** + F3 (NC fiscal cuando aplique) |
| Reportes/BI y exportaciones con diseño | F1 (reportes) + **TX-2 (XLSX)** + F9/H56 + F13/H52 |
| Hardware: impresora térmica/fiscal, cajón, balanza, lector | F4 + **F10/H22–H26** |
| Segunda pantalla / display cliente (carrito, QR, total, vuelto) | **F10/H25** |
| Pedidos online / delivery (PedidosYa, Rappi, Tienda Nube, Mercado Libre) | F5 (marketplace) |
| Click & Collect, Ship from Store, Endless Aisle, Stock Lookup, devoluciones cross-channel | **F16/H77–H78** |
| Cockpit central de comercio unificado | **F16/H76** |
| Clienteling, POS móvil y venta asistida en salón | **F16/H81** |
| Prevención de fraude y riesgo operativo omnicanal | **F16/H82** |
| Operación de cadenas, marcas, franquicias y multi-negocio | **F16/H83** |
| Integration hub con replay/dead-letter/health por conector | **F16/H84–H85** |
| Modo offline completo con sincronización | **F14/H65** (AFIP offline mínimo cubierto en F3) |
| App móvil para gerentes | Backlog, apoyada en API/webhooks F14/H68 |
| Roles y permisos granulares; staff multinivel | F1 (roles) + **F7/H11 (staff NinjaSoft)** |
| Multimoneda / listas de precios por canal | F6/H10 (listas) + **F14/H59/H66** |
| Reservas / turnos | **F12/H38** + F13/H51 para reservas gastronómicas |
| Escuela, tours, ayuda contextual y certificaciones | **F15/H69–H75** |

> **Conclusión del benchmark:** los huecos relevantes vs. POS líderes dejan de quedar en backlog: **inventario avanzado**, **compras/proveedores**, **modo offline completo**, **recargos/cuotas enterprise**, **API/webhooks** y **gobierno de configuración** pasan a **F14 — Motor comercial enterprise**. La revisión específica contra Napse/TOTVS agrega una capa separada: **F16 — Comercio unificado**, con cockpit, OMS, journeys omnicanal, pagos tipo VTOL, fiscal hub, fidelización, prevención de fraude, franquicias y demos enterprise. La oportunidad de adopción se cubre con **F15 — Escuela NinjaSoft + onboarding guiado configurable**, para reducir soporte y acelerar primera venta.

---

## Cortes de control y testing estricto

**Regla:** ningún hito se considera cerrado sin pasar su corte de control. No se avanza al siguiente hito con el anterior "al 80%".

### Gate automático (obligatorio en cada hito)
- [ ] `pnpm lint` sin warnings.
- [ ] `pnpm typecheck` limpio.
- [ ] `pnpm test` (unit + integración) en verde, **con tests nuevos que cubran el hito**.
- [ ] `pnpm build` exitoso.
- [ ] Migraciones aplicadas y `db:types` regenerado si cambió el esquema.
- [ ] RLS verificada: tests que prueben aislamiento por tenant del esquema nuevo.

### Gate manual (checklist por hito)
- [ ] Criterio de cierre del hito demostrado (demo concreta).
- [ ] Acciones críticas escriben en `audit_logs`.
- [ ] `service_role` no aparece en frontend.
- [ ] Feature nueva detrás de feature flag si es opcional.
- [ ] Control de diseño y estructura aprobado según [`26-design-structure-control.md`](./26-design-structure-control.md).
- [ ] Capturas o demo de responsive en mobile/tablet/desktop si el hito toca UI.
- [ ] Entrada en [`17-decision-log.md`](./17-decision-log.md) y `CHANGELOG.md`.
- [ ] Deploy a producción verificado (estado READY) y humo manual en la ruta nueva.

### Cobertura mínima de tests por capa
- [ ] **Edge Functions / RPC:** test de happy-path + test de autorización (rol incorrecto / otro tenant rechazado).
- [ ] **Componentes:** render + interacción principal.
- [ ] **Flujos críticos (pago, cobro, facturación):** test de integración end-to-end del camino feliz y de un error transitorio.

---

## Backlog para fases siguientes (no priorizado)

- [~] **Registro/login con Google (OAuth)** *(agregado 2026-06-06)*: alta y acceso con cuenta de Google vía Supabase Auth (provider google). **Feature de plan de pago** (gateado por feature flag / plan). Incluye vincular cuenta existente por email y respetar el flujo de onboarding actual. *Parcial: login y alta con Google (`signInWithOAuth` en `app/(auth)/login/page.tsx` y `app/(auth)/signup/page.tsx`). Falta gatearlo por plan (no hay feature key) y el vínculo explícito con cuenta existente.*
- [ ] **Inventario PRO avanzado fuera de F14:** WMS profundo, ubicaciones/bin picking, ondas de preparación, inventario por radiofrecuencia y terminales industriales.
- [ ] **Compras y proveedores avanzados fuera de F14:** EDI, portal de proveedor, licitaciones, conciliación automática de facturas de proveedor.
- [x] **Devoluciones y cambios avanzados:** cubierto en F11/H29; queda en backlog solo integración posterior con nota de crédito fiscal automática si AFIP requiere ampliar flujo. *Hecho: la devolución encola la nota de crédito fiscal sola (trigger `arca_returns_enqueue` sobre `sale_returns`, `20261101100100_arca_facturacion.sql`, ADR-072).*
- [~] **Cuenta corriente de clientes** (fiado) — base en F11/H31; gancha con F9/H55 (fidelización) y segmentos. *Base hecha (`20260601130000_customer_account.sql`, `20261011200000_cuenta_corriente_v2.sql`); falta el enganche con fidelización y segmentos (F9/H55).*
- [x] **Cuenta corriente de proveedores.** *Hecho: vista `supplier_balances` (`20261016100300_compras_facturas_pagos.sql`, ADR-050), saldo en `/compras/proveedores` y órdenes de pago (ADR-059).*
- [ ] **Reservas / turnos avanzados** multi-recurso o de capacidad compleja; base cubierta en F12/H38 y reservas gastronómicas en F13/H51.
- [ ] **Multimoneda avanzada:** cobertura multi-país, contabilidad bimonetaria y reglas fiscales por país; base comercial cubierta en F14/H59.
- [ ] App móvil nativa (React Native) para gerentes en movimiento.
- [ ] Offline industrial avanzado: sincronización multi-dispositivo con conflictos complejos y hardware local; base offline-first cubierta en F14/H65.
- [ ] Producción y recetas avanzadas / escandallo industrial; base gastronómica cubierta en F13/H50.
- [ ] E-commerce integrado (alternativa a Tienda Nube).
- [ ] Multi-país (Uruguay, Chile, México) — requiere abstraer facturación electrónica.

> *Nota:* **Fidelización (puntos/niveles), gift cards y cupones** se movieron del backlog a **F9 — Motor de promociones PRO** (H54–H55); packs de sesiones y membresías simples se cubren antes en F12/H41.

---

## Avance por fase

Calculado con `node scripts/roadmap-progress.mjs --write` (cuenta los checkboxes de cada fase; no cuenta los gates de "Cortes de control" ni el backlog). `[~]` es parcial; la última columna lo cuenta como medio ítem. Recalcular después de marcar ítems.

<!-- roadmap-progress:start -->
| Fase | Hechos/total | Parciales | Pendientes | % hecho | % con parciales a la mitad |
|---|---|---|---|---|---|
| **F0** | 7/10 | 3 | 0 | 70% | 85% |
| **F1.5** | 8/14 | 3 | 3 | 57% | 68% |
| **F2** | 16/16 | 0 | 0 | 100% | 100% |
| **F3** | 21/29 | 7 | 1 | 72% | 84% |
| **F4** | 12/29 | 10 | 7 | 41% | 59% |
| **F5** | 16/38 | 9 | 13 | 42% | 54% |
| **F6** | 55/62 | 4 | 3 | 89% | 92% |
| **F7** | 44/61 | 12 | 5 | 72% | 82% |
| **F8** | 12/47 | 21 | 14 | 26% | 48% |
| **F9** | 12/20 | 7 | 1 | 60% | 78% |
| **F10** | 30/46 | 11 | 5 | 65% | 77% |
| **F11** | 65/89 | 12 | 12 | 73% | 80% |
| **F12** | 39/51 | 7 | 5 | 76% | 83% |
| **F13** | 39/74 | 26 | 9 | 53% | 70% |
| **F14** | 5/61 | 39 | 17 | 8% | 40% |
| **F15** | 8/35 | 19 | 8 | 23% | 50% |
| **F16** | 4/59 | 32 | 23 | 7% | 34% |
| **F17** | 98/130 | 18 | 14 | 75% | 82% |
| **F18** | 33/106 | 56 | 17 | 31% | 58% |
| **TX** | 19/27 | 4 | 4 | 70% | 78% |
| **Total** | 543/1004 | 300 | 161 | 54% | 69% |
<!-- roadmap-progress:end -->

---

## Cómo se actualiza este roadmap

1. Al cerrar una fase, el PM actualiza el estado en la tabla principal y agrega un resumen de aprendizajes en [`17-decision-log.md`](./17-decision-log.md).
2. Cambios de prioridad mayor requieren PR con justificación.
3. Estimaciones de duración se ajustan según velocidad real medida en fases anteriores.

> **Principio.** El roadmap es un mapa, no una promesa. Lo que sí es promesa: cada fase termina con software que funciona, no con un avance del 80%.
