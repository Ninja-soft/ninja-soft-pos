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
| **F3** | Integración AFIP y producción | 4–6 semanas | 🔴 No iniciado |
| **F4** | Escalado: multi-sucursal, hardware, integraciones | 8–10 semanas | 🟡 Planificación |
| **F5** | Perfiles por rubro y marketplace | 10–14 semanas | 🟡 Planificación |
| **F6** | Personalización del producto (fotos, branding, tickets, catálogo) | 6–8 semanas | 🟢 Funcional (H7–H10b + Tiendita) |
| **F7** | Panel interno PRO + comunicaciones (emails) | 5–7 semanas | 🟢 Funcional (staff, planes custom, emails Resend, notificaciones) |
| **F8** | Pagos y cobros (arquitectura + pasarelas por etapas) | 6–10 semanas | 🟡 En progreso (MP + Mobbex + MODO; gating por plan) |
| **F9** | Motor de promociones PRO | 4–6 semanas | 🟡 Planificación |
| **F10** | Hardware y mostrador PRO (impresoras, scanners, doble pantalla) | 5–8 semanas | 🟡 En progreso (impresión por documento H22, scanners H23, doble pantalla H25, diagnóstico H26) |
| **F11** | Configuración retail avanzada (devoluciones, garantías, cuenta corriente, despacho) | 6–8 semanas | 🟡 Planificación |
| **F12** | Comercios simples y servicios (catálogo chico, agenda, cobro rápido) | 5–7 semanas | 🟡 En progreso (H35 presets, H36 POS rápido, H37 modificadores, H38 agenda/turnos — core) |
| **F13** | Gastronomía PRO (mesas, comandas, cocina, delivery/takeaway) | 7–10 semanas | 🟡 En progreso (H43 modo gastronómico, H44 mesas/pedidos, H45 ruteo + comanda impresa por estación, H46 KDS, H47 cursos/despacho por tiempos, H49 delivery/takeaway, H51 reservas — núcleo, local) |
| **F14** | Motor comercial enterprise (planes, cuotas, recargos, reglas, inventario PRO) | 8–12 semanas | 🟡 Planificación |
| **F15** | Escuela NinjaSoft + onboarding guiado configurable | 5–7 semanas | 🟡 Planificación |
| **F16** | Comercio unificado tipo Napse/TOTVS (Omni, VTOL, Fiscal Flow, Promo) | 10–14 semanas | 🟡 Planificación |
| **TX** | Mejoras transversales (UX y datos) — quick wins | continuo | 🟡 Planificación |

> **Orden de ejecución acordado (2026-05-30):** **TX (quick wins) → F6 → F7 → F8 → F10 → F11 → F12 → F13 → F9 → F14 → F15 → F16 → F3 (AFIP)**. Las **mejoras transversales (TX)** — calendario unificado con react-day-picker y export XLSX — se hacen primero por ser pedidos explícitos y de bajo costo, y luego se aplican de forma continua. Ver [§ Plan ampliado](#plan-ampliado-2026-05-30), [§ Mejoras transversales](#tx--mejoras-transversales-ux-y-datos) y los cortes de control obligatorios al cierre de cada hito.

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
- [~] `pnpm test` pasa con al menos un test por capa (component, hook, edge function). *15 archivos: 2 de componentes + 13 unit/dominio; faltan tests de hooks y de Edge Functions.*

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
- [~] Tests de permisos por rol: owner, manager, cashier, viewer. *Owner vs cashier cubierto (payment_plans, pos_settings); manager y viewer pendientes.*
- [ ] Smoke E2E mínimo: login → abrir caja → vender → ticket → anular → cerrar caja → reporte.
- [ ] Idempotencia documentada para venta/anulación antes de integrar pagos externos.
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
- [~] **Panel interno** (rutas protegidas para staff NinjaSoft): — *Base hecha: `/internal/tenants` + detalle, `/internal/staff`, `/internal/pagos`, `/internal/emails`. Guard `is_internal`.*
  - [x] Listado de tenants con filtros (estado, plan, última actividad). — *Búsqueda (nombre/slug/dueño), filtros por estado de suscripción y plan, y columna "Últ. actividad" (último login o última venta, vía `internal_tenant_health()`).*
  - [ ] Alta y baja de tenants. *(el alta hoy es self-service vía onboarding; falta alta/baja desde internal)*
  - [x] Cambio de plan en caliente. — *Detalle del tenant: select de plan → RPC `internal_set_plan`.*
  - [x] Activación / desactivación de feature flags por tenant. — *Toggles en el detalle del tenant → RPC `internal_set_flag`.*
  - [x] Vista de auditoría administrativa. — *`/internal/audit`: últimos 200 registros de `audit_logs` con filtros (negocio, entidad, acción, rango de fechas) y detalle expandible (motivo + before/after JSON). Solo lectura, guard `is_internal` por RLS.*
- [x] **Modelo de suscripciones** completo:
  - [x] Estados: `trial`, `active`, `past_due`, `suspended`, `cancelled` (migración `saas_catalog`).
  - [x] Trial automático de 14 días al alta (Edge Function `create_tenant` setea `trial_ends_at`).
  - [x] Suspensión por falta de pago (manual + **automática**). — *Staff cambia el estado a `suspended` desde el detalle (RPC `internal_set_subscription_status`); además **motor de dunning de 3 días** que pasa a `suspended` y **reactiva reanclando el período** al vencimiento anterior (migración `dunning_3day_grace_reanchor`, PR #237). El cliente suspendido ve un bloqueo de cuenta (`SuspendedGate`, PR #236).*
- [~] **Sistema de soporte interno:**
  - [x] Notas internas por tenant. — *Tabla `tenant_notes` (RLS solo `is_internal`, baja lógica) + card "Notas internas" en el detalle del tenant: agregar, listar con autor y fecha relativa, eliminar. Invisibles para los usuarios del tenant.*
  - [~] Vista rápida de salud operativa (último login, ventas últimos 7 días, errores). *KPIs en el detalle del tenant: último login, última venta, ventas 7 días (cantidad + total) y usuarios activos — RPC `internal_tenant_health()` (SECURITY DEFINER, guard `is_internal`, devuelve solo agregados). Errores quedan para observabilidad (F4/Sentry).*

### Criterios de cierre
- [ ] NinjaSoft puede dar de alta un cliente nuevo en < 5 minutos sin tocar SQL. *(el alta es self-service; falta el flujo desde internal)*
- [x] Cambiar un cliente de Start a Pro toma una sola acción y aplica de inmediato.
- [ ] Toda acción administrativa queda en `audit_logs`.

---

## F3 — Integración AFIP y producción

**Duración:** 4–6 semanas. **Objetivo:** el cliente piloto puede facturar electrónicamente con CAE válido.

### Entregables
- [ ] Edge Function `submit_invoice_afip` con manejo completo de:
  - [ ] Solicitud de CAE para Factura A, B, C, Nota de Crédito.
  - [ ] Reintentos con backoff exponencial.
  - [ ] Almacenamiento de XML de request/response.
  - [ ] Cola fiscal robusta: pendientes, reintentos, bloqueados, rechazados, dead-letter y reproceso manual.
  - [ ] Idempotencia fiscal por venta/tipo de comprobante/punto de venta.
  - [ ] Conciliación contra AFIP (`FECompUltimoAutorizado`) para detectar drift de numeración.
- [ ] Gestión de certificados AFIP por tenant (almacenados encriptados).
- [ ] Panel de monitoreo de facturación electrónica:
  - [ ] Comprobantes pendientes.
  - [ ] Errores recientes con código AFIP.
  - [ ] Última conexión al webservice AFIP.
- [ ] Modo **homologación** vs **producción** por tenant, con certificados separados, checklist de habilitación y bloqueo de cambio si faltan pruebas.
- [ ] **Venta offline / AFIP offline:**
  - [ ] La venta no se bloquea si no hay internet o AFIP no responde.
  - [ ] Se emite comprobante interno/provisorio y la factura queda en cola fiscal.
  - [ ] Al reconectar, el sistema sincroniza ventas pendientes, pide CAE y actualiza el comprobante.
  - [ ] El POS muestra estado fiscal claro: `pendiente`, `enviando`, `aprobado`, `rechazado`, `requiere acción`.
- [ ] Numeración de comprobantes por punto de venta.

### Criterios de cierre
- [ ] 100 comprobantes consecutivos en homologación sin error de integración.
- [ ] Recuperación automática si AFIP devuelve error transitorio.
- [ ] El cashier nunca ve un error de AFIP que lo bloquee — la venta se completa, la factura se reintenta en segundo plano.
- [ ] Una venta offline queda registrada localmente, se sincroniza al volver la conexión y termina con CAE o error fiscal accionable.
- [ ] El cambio de homologación a producción solo se habilita después de certificados válidos, numeración verificada y prueba exitosa.

---

## F4 — Escalado

**Duración:** 8–10 semanas. **Objetivo:** soportar clientes con múltiples sucursales y cajas, integraciones con hardware y pasarelas de pago.

### Entregables
- [ ] **Multi-sucursal:**
  - [ ] Stock por sucursal con transferencias.
  - [ ] Reportes consolidados.
  - [ ] Permisos por sucursal.
- [ ] **Multi-caja por sucursal:**
  - [ ] Asignación de cajero a caja específica.
  - [ ] Reportes por caja.
- [ ] **Integraciones de hardware:**
  - [ ] Impresoras térmicas (ESC/POS via plugin de impresión web).
  - [ ] Cajón de dinero.
  - [ ] Lectores de código de barras (USB HID, sin driver).
  - [ ] Balanzas (opcional, vía puerto serie).
- [ ] **Pasarelas de pago:**
  - [ ] Mercado Pago Point (QR + tarjeta).
  - [ ] Modo (transferencia).
  - [ ] Conciliación automática.
- [ ] **Observabilidad avanzada:**
  - [ ] Sentry para errores frontend.
  - [ ] Logs estructurados centralizados.
  - [ ] Alertas en Slack/email para errores críticos.

### Criterios de cierre
- [ ] Un cliente con 3 sucursales puede operar simultáneamente sin latencia perceptible.
- [ ] Una impresora térmica imprime un ticket en < 2s después de cobrar.
- [ ] Mercado Pago se acredita en la venta sin intervención del cashier.

---

## F5 — Perfiles por rubro y marketplace

**Duración:** 10–14 semanas. **Objetivo:** el producto se siente "hecho a medida" para cada rubro sin código específico.

### Entregables
- [ ] **Perfiles de rubro** activables por tenant:
  - [ ] **Kiosco:** venta ultrarrápida, atajos de teclado optimizados, gestión de cigarrillos / bebidas.
  - [ ] **Textil:** variantes (talle/color), control de prendas por SKU compuesto.
  - [ ] **Retail:** promociones complejas (2x1, descuentos por volumen).
  - [ ] **Restaurante / resto-bar:** mesas, salones, comandas, cocina/KDS, cursos, división de cuenta y propina.
  - [ ] **Cafetería / take away:** mostrador rápido, nombre del cliente, comandas de barra/cocina, combos y modificadores.
  - [ ] **Heladería:** productos por botón, tamaños, sabores/modificadores, balanza opcional y comanda de preparación.
  - [ ] **Peluquería / estética:** servicios, agenda, profesional, comisión y venta de productos complementarios.
  - [ ] **Pyme genérica:** módulo de cuenta corriente de clientes.
- [ ] **Motor de promociones** configurable:
  - [ ] Reglas declarativas (no código).
  - [ ] Vigencia por fecha/horario.
  - [ ] Combinables o exclusivas.
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
- [ ] **API pública** con OAuth para clientes Enterprise.
- [ ] **Tema visual personalizado** por tenant (logo, color de acento dentro de los límites de marca).

### Criterios de cierre
- [ ] Un cliente textil puede gestionar 500 SKUs con variantes sin pasar por NinjaSoft.
- [ ] Una promoción "Miércoles 30% en bebidas" se configura desde el panel del cliente y aplica automáticamente.
- [ ] La API permite a un cliente Enterprise sincronizar 1000 productos en < 60s.

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
  - [ ] Modo del negocio/rubro operativo (presets por rubro) — *pendiente; se cruza con F12/F13.*
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
  - [ ] **Stock inicial por depósito** desde el alta (gancha con F11/H33) y **variantes talle/color** (gancha con F6/H10) cuando el producto las tenga. — *Pendiente: depende de multi-depósito (H33) y variantes (H10), que no existen aún.*
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

- [~] **H11c — Consola internal completa + login independiente.** — *KPIs SaaS + buscador de tenants (2026-06-04); login interno diferenciado + buscador global multi-campo (2026-06-05). Faltan: ficha 360, gestión de miembros desde internal, impersonation.*
  - [x] Entrar directo a `/internal` redirige a `/internal/tenants`; si no hay sesión, login conserva destino interno (`/login?next=/internal/tenants`).
  - [x] Dashboard con 8 KPIs SaaS (total, trial, activos, con problemas, nuevos 7/30d, conversión, MRR), breakdown por plan, alerta de negocios con problemas, quick links y tabla con buscador. Componente `TenantSearchTable`.
  - [x] Pantalla de acceso interno con copy y layout diferenciado de POS/tenant. — *`/login-internal` (2026-06-05): card propia "Staff NinjaSoft / Panel interno" con aviso de auditoría, sin registro, link cruzado al login de clientes; al entrar va a `/internal/tenants`.*
  - [~] Dashboard internal con KPIs SaaS: MRR, ARR, trials, activos, past_due, suspendidos, churn, conversión trial→paid, tickets de soporte y alertas. — *10 KPIs en `/internal` (2026-06-07: +ARR estimado y Churn 30d; MRR incluye past_due). Tickets de soporte cuando exista ese módulo.*
  - [x] Buscador global por tenant, CUIT, email owner, teléfono, slug, plan, estado, feature flag y fecha de alta. — *`/internal/tenants` (2026-06-05): el texto matchea nombre/slug/dueño/email, y CUIT/teléfono por dígitos; filtros de estado, plan, feature flag (efectivo: override o default) y rango de fecha de alta (DateRangePicker).*
  - [ ] Ficha 360 del tenant: datos legales/comerciales, owners, usuarios, sucursales, cajas, ventas, módulos activos, flags, salud, últimos errores y actividad.
  - [ ] Desde internal se puede invitar usuarios al tenant, reenviar invitación, cambiar rol, suspender/reactivar miembro y resetear acceso con motivo.
  - [ ] Desde internal se puede convertir un usuario existente en staff NinjaSoft y asignarle rol/nivel interno según permiso.
  - [ ] Impersonation/abrir contexto de tenant solo con motivo, duración limitada, banner visible y auditoría.
  - [ ] Acciones peligrosas requieren confirmación fuerte, motivo y quedan en `audit_logs`.
  - [ ] *Criterio:* un super-admin entra por `/internal` sin pasar por POS, encuentra un tenant, invita un owner/cajero, cambia plan, activa módulos y promueve un usuario a admin interno, todo auditado.

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
  - [ ] Aumentar/limitar módulos y feature flags por tenant desde una sola consola.
  - [x] **Plan específico por cliente:** clonar un plan base, cambiar nombre comercial, límites, módulos, soporte, precio y condiciones sin afectar a otros tenants. — *RPCs `internal_clone_plan` / `internal_update_custom_plan` + `PlanCard` en el detalle del tenant (2026-06-07).*
  - [~] **Overrides de cuota/límites por cliente:** usuarios, sucursales, cajas, productos, ventas mensuales, almacenamiento, módulos, soporte y límites fiscales. — *Base hecha (2026-06-07): `subscriptions.limit_overrides` + RPC auditado + editor por límite (efectivo = override ?? plan). Cajas/almacenamiento/fiscales cuando existan esos límites.*
  - [ ] **Aumento de cuota/precio a un cliente:** cambio inmediato o programado con fecha efectiva, motivo, aviso previo, aceptación opcional y registro de antes/después.
  - [x] Trial configurable: extender trial, acortarlo, convertir a paid, marcar como perdido, registrar motivo. — *Completo (2026-06-05): extender (+7/14/30/60/90), "Fijar fin…" a fecha exacta (acortar/terminar — RPC `internal_set_trial_end`), "Convertir a pago" y "Marcar perdido" con motivo (RPC `internal_trial_outcome` → active/cancelled). Auditado con before/after + reason; migración `trial_lifecycle` aplicada en remoto.*
  - [x] Billing manual: registrar pago, medio, período cubierto, comprobante/recibo interno, deuda y próxima fecha de vencimiento. — *Completo (2026-06-05): a la base (`billing_records` append-only) se suma el bloque de cobranza en la card Facturación: próximo vencimiento = último `period_end`; si quedó en el pasado, "Vencido hace N días" + deuda estimada (meses vencidos × precio mensual del plan).*
  - [~] Descuentos comerciales, precio acordado, cupones/manual override y notas internas con vigencia. — *Descuentos percent/fixed con vigencia y precio mensual efectivo en Facturación (2026-06-07); cupones pendientes.*
  - [ ] Historial de cambios de plan/estado/precio con antes/después, autor, fecha, motivo y fuente.
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
  - [~] *Criterio:* al aumentar cuota/precio de un tenant, el owner ve una notificación in-app con fecha efectiva, motivo, nuevo monto, historial y acción de aceptación/consulta. — *La notificación automática con `requires_ack` está; la acción de aceptación transaccional queda pendiente.*

### F8 — Pagos y cobros

Objetivo: cobrar por cualquier medio, con arquitectura extensible. **Arquitectura primero, integraciones por etapas** (un sub-hito por proveedor).

- [x] **H14 — Arquitectura de pagos (base).** — *UI de cobro abstracta completada (2026-06-04).*
  - [x] Registro de **proveedores de pago** (`payment_providers`, catálogo global seedeado con los 10 medios) y config por tenant.
  - [x] Habilitación y **configuración por tenant** (`tenant_payment_methods`: enabled, recargo %, sandbox; RLS owner/manager). **Secretos** en `payment_secrets` (RLS deny: solo service_role/Edge Functions). UI `PaymentMethodsCard` en `/dashboard-team`.
  - [x] **UI de cobro abstracta** en el POS: `PaymentModal` lee `tenant_payment_methods.enabled` y muestra solo los medios del tenant (fallback a todos si no hay config). Selector de planes activos para débito/crédito con recargo. Recargo global del medio si `surcharge_pct > 0`. Hook `useEnabledPaymentMethods()`.
  - [x] Medios manuales reales: **Efectivo**, **Transferencia** (en catálogo; el POS ya cobra efectivo/transferencia/mixto).
  - [x] *Criterio:* el POS muestra solo los medios habilitados por el tenant y aplica el recargo configurado. ✓

- [~] **H15+ — Integraciones por proveedor** (un sub-hito cada uno, cableado incremental sobre la arquitectura de H14):
  - [~] **H15** — Mercado Pago. **Conexión por Access Token + QR de cobro (Checkout Pro) + OAuth "Conectar con MP" hechos**: Edge Functions `set_payment_secret`, `mp_create_qr`, `mp_webhook`, `mp_oauth_start`, `mp_oauth_callback` (`state` anti-CSRF, refresh de token); botón "Conectar con Mercado Pago" (un click) y "Cobrar con QR" en el POS; tabla `mp_payment_intents`. **Billing de suscripciones**: credenciales de plataforma en `platform_secrets` editables desde `/internal/pagos` (`set_platform_secret`), `mp_subscription_checkout` (preapproval) + `mp_billing_webhook`; "Generar link de cobro" en el detalle del tenant. **Conciliación básica hecha** (modal "Cobros QR" en /ventas: intents cruzados con sus ventas, alerta de "aprobado sin venta", filtros + export XLSX). **Falta:** Mercado **Point** (tarjeta presencial).
  - [~] **H16** — **MODO** vía QR interoperable. — *Transaccionable en el POS (2026-06-08, PRs #227/#229): Edge Functions `modo_create_qr` + `modo_webhook`, **gating real** por plan, sin botón de cuotas y **conexión de credenciales** desde Medios de pago. **Falta validar el dialecto de la API de MODO con credenciales reales** (cobro en vivo).*
  - [ ] **H17** — **Payway / Prisma**.
  - [ ] **H18** — **Getnet**.
  - [ ] **H19** — **Fiserv / Posnet / Clover**.
  - [~] **H20** — **Mobbex** como **orquestador** (abstrae varios proveedores; opcional según convenga). — *Cobro por QR funcionando con cuenta real (validado 2026-06-04): conexión por API Key + Access Token, checkout hosted → QR, planes del grid (cuotas + interés) aplicados en el checkout de Mobbex (`installments`), webhook actualiza el intent y la venta se registra. Edge Functions `mobbex_create_qr` + `mobbex_webhook`. Conciliación básica en el modal "Cobros QR" de /ventas.*
  - [ ] **H21** — **Pagos360** (links de pago / cobranzas).
  - [ ] **H21c** — **Nave (Banco Galicia)** (billetera/QR + links de cobro). Ya está en el catálogo de medios de pago (logo + "Próximamente"); falta la integración de cobro.
  - [ ] *Criterio por proveedor:* cobro real en sandbox + conciliación + manejo de error sin bloquear la venta.

- [ ] **H21b — Orquestador de pagos estilo VTOL.**
  - [ ] Router de pagos por proveedor/adquirente/terminal/canal con prioridad, fallback y reglas de ruteo.
  - [ ] Estado central de transacciones: iniciada, autorizada, capturada, rechazada, reversada, anulada, conciliada, en disputa.
  - [ ] Conciliación automática por lote, cupón, autorización, terminal, adquirente y liquidación.
  - [ ] Monitoreo de terminales, alarmas de caída, reintentos seguros y recuperación automática.
  - [ ] Trazabilidad por transacción y auditoría completa sin guardar datos sensibles de tarjeta.
  - [ ] *Criterio:* si un proveedor falla, el POS ofrece fallback autorizado y la operación queda conciliable sin duplicar cobro.

### F10 — Hardware y mostrador PRO

Objetivo: que el POS opere como sistema de mostrador profesional: impresoras configurables, scanners confiables, periféricos por caja/sucursal y segunda pantalla para el cliente. Todo debe ser configurable por tenant, sucursal, caja y perfil de dispositivo.

- [~] **H22 — Configuración avanzada de impresión.** — *Buildable por tenant hecho (2026-06-08, PR #262): config por TIPO DE DOCUMENTO (formato, copias, auto/manual) en Configuración → Impresión, respetada por el POS al cobrar, en Caja (Z) y en Devoluciones. Per-sucursal/caja, ESC/POS y cola → F4.*
  - [~] Perfiles de impresión por **tenant / sucursal / caja**: ticket 58mm, ticket 80mm, A4, etiqueta, cocina/comanda, comprobante interno. — *Por **tenant** hecho (formato 58/80/A4 por tipo, según aplique). **Sucursal/caja → F4**; comanda de cocina → F13 (gastronomía).*
  - [x] Selector de destino por tipo de documento: ticket de venta, cierre Z, movimiento de caja, etiqueta de producto, comanda, devolución, nota de crédito futura. — *5 tipos configurables (ticket de venta, cierre Z, movimiento de caja, etiqueta de producto, devolución/NC) en `pos_settings.print_profiles` (migración `20260608470000_print_profiles`). Comanda → F13.*
  - [~] Plantillas con variables: logo, datos fiscales, QR, leyendas legales, redes, promociones, cajero, caja, sucursal, medios de pago. — *Ya resuelto por el editor de plantillas de H9b (`ticket_templates`, modos bloques/canvas/HTML con variables). H22 elige formato/copias/auto sobre esa plantilla activa, sin duplicarla.*
  - [~] Márgenes, tamaño de fuente, densidad, cantidad de copias, corte de papel, apertura de cajón, impresión automática o manual. — *Copias (1..20), impresión automática vs manual, y ajustes básicos de **fuente y margen** por tipo. Densidad, corte de papel y apertura de cajón requieren ESC/POS → F4.*
  - [x] Web print nativo: `window.print()` para navegador, A4 y fallback universal. — *La impresión es web; las copias se imprimen llamando a `window.print()` N veces (`lib/print/webPrint.ts`).*
  - [ ] ESC/POS por conector local: app/servicio local para térmicas USB/LAN/Bluetooth cuando el browser no alcanza. — *F4 (documentado en la UI de Impresión y en `lib/print/profiles.ts`).*
  - [ ] QZ Tray / WebUSB / WebSerial evaluados por compatibilidad. — *F4.*
  - [ ] Cola de impresión con reintentos: pendiente, impreso, fallido, reimprimir, cancelar. — *F4 (documentado como límite del web print).*
  - [~] *Criterio:* un tenant configura ticket 80mm para caja principal, etiqueta 58mm para productos y cierre Z A4; cada documento sale por su destino correcto. — *Cumplido a nivel **tenant** (formato + copias + auto/manual por tipo, aplicado en venta/Z/devolución). "Por caja" queda para F4.*

- [~] **H23 — Scanners y captura de códigos PRO.** — *Base (PR #80) + perfil/beep/anti-dup/diagnóstico (2026-06-07). Quedan: QR de pago/fidelización y etiquetas de balanza.*
  - [x] Soporte para lector USB HID tipo teclado y Bluetooth (`useScanner`: captura global de teclado por velocidad de tipeo + Enter, sin foco previo), cámara (`BarcodeDetector`) y entrada manual (búsqueda).
  - [~] Perfiles de scanner por caja: prefijo/sufijo, Enter automático, delay entre caracteres, normalización de EAN/UPC/Code128/QR. — *Perfil por tenant hecho (prefijo/sufijo/anti-dup en Configuración → Escáner); por caja → F4. Formato inferido EAN/UPC/QR en diagnóstico.*
  - [x] Modo continuo en POS: lectura sin tocar mouse (escaneo en cualquier parte agrega al carrito), **beep de confirmación** y **anti-duplicado** configurable. — *useScanner v2 (2026-06-07).*
  - [x] Producto por SKU/barcode (`productsApi.findByCode`).
  - [ ] QR de pago.
  - [ ] QR de cliente/fidelización.
  - [ ] Etiquetas internas de balanza/precio-peso.
  - [x] Diagnóstico de scanner: pantalla de prueba que muestra caracteres recibidos, tiempos y formato detectado. — *Configuración → Escáner: últimas 10 capturas con código/crudo/largo/duración/gap/formato/duplicado (2026-06-07).*
  - [ ] *Criterio:* un lector USB escanea 100 productos seguidos sin perder foco ni duplicar lecturas; un móvil usa cámara como fallback.

- [~] **H24 — Etiquetas, códigos y balanzas.** — *Generador + impresión por lote hechos (PR #79). Balanza (parsing/WebSerial) pendiente.*
  - [x] Generador de etiquetas de producto con nombre, precio y código de barras (Code 39 sin dependencias, SVG). Variantes pendientes (cruza con F6/H10).
  - [x] Impresión por lote: selección de productos + cantidad de copias por producto, vista previa y `window.print()` (página `/etiquetas`, hoja `ticket-print`). Hasta 200 copias por producto.
  - [ ] Soporte para etiquetas de balanza: parsing configurable de código con precio o peso embebido.
  - [ ] WebSerial para balanzas compatibles cuando aplique; fallback por código de barra de balanza.
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
  - [x] Pruebas guiadas: imprimir ticket de prueba, abrir cajón, probar scanner, probar display cliente, probar balanza. — *Impresora: render oculto del ticket de muestra + `window.print()` (web print, reusa `TicketRenderer`/`ticket-print`). Escáner: captura en vivo con `useScanner` (mismo motor del POS, últimas lecturas con código/largo/ms/formato/duplicado). Pantalla cliente: "Abrir pantalla de prueba" (`window.open('/customer-display')`) + "Probar sincronización" (round-trip real de `BroadcastChannel`). Cajón: documenta la limitación (se abre por pulso ESC/POS de la térmica vía conector local; no disponible en navegador). Balanza: placeholder honesto (requiere WebSerial, H24).*
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

- [~] **H30b — Cierres Z inmutables e historial contable de caja.** — *Auditoría contra el código (2026-06-07): el grueso ya estaba implementado desde el 2026-05-31 (`cash_z_closures`); roadmap sincronizado con evidencia. Quedan: items resumidos en el snapshot y correlativo por sucursal/caja (hoy por tenant — cruza con F4 multi-caja).*
  - [x] Al cerrar una caja se genera un **Cierre Z**: cierre **contable diario del turno**, registro **inmutable** (no editable ni borrable) con su **snapshot consolidado** del turno. — *`close_cash_shift` v2 inserta en `cash_z_closures` (append-only: RLS sin UPDATE/DELETE, unique por turno).*
  - [~] Snapshot del Z: número correlativo de Z por sucursal/caja, apertura/cierre, cajero, ventas (cantidad y total), **desglose por medio de pago**, ingresos/egresos de caja, descuentos, anulaciones, monto esperado vs. contado, **diferencia**, e items vendidos resumidos. — *Todo presente salvo items resumidos; correlativo hoy por tenant (por caja → F4).*
  - [x] **Historial de Cierres Z** (pantalla dedicada en Caja): lista filtrable por fecha; cada Z se puede ver, **reimprimir** (ticket vía `ticket-print`) y exportar XLSX. Nunca se edita. — *`ZClosuresHistory` en /caja; filtro por rango de fechas agregado 2026-06-07. Filtro por sucursal/caja/cajero → F4 multi-caja.*
  - [x] Integridad: el Z queda enlazado a sus ventas/movimientos (vía `cash_shift_id`); cualquier ajuste posterior va por contramovimiento auditado, no por edición del Z (la tabla no admite UPDATE/DELETE).
  - [x] *Criterio:* al cerrar caja aparece su Z en el historial con el consolidado del turno; se puede reimprimir y exportar, pero no modificar. ✓

- [~] **H31 — Cuenta corriente y grupos de clientes.** — *Criterio principal cumplido (2026-06-07). Restan: deuda en historial desde el selector del POS y grupos para precios/promos/riesgo.*
  - [~] **Historial del cliente**: modal en /clientes con saldo a favor (vale), compras y devoluciones (`CustomerHistoryModal`). Falta deuda de cuenta corriente (depende de este hito) y acceso desde el selector del POS.
  - [x] Medio de pago "Cuenta corriente" que deja deuda del cliente (trigger en `payments` → `customer_account_movements`).
  - [x] Límite de deuda por cliente (`customers.credit_limit`; 0 = sin límite; se valida al cobrar fiado). Deuda visible en el historial del cliente.
  - [~] Cuentas por cobrar: registrar pagos de deuda desde el historial del cliente (reduce la deuda) + **vista global de CxC** en /clientes (`AccountsReceivableModal`) con buckets de antigüedad 0-30/31-60/61-90/+90 días (FIFO: los pagos cancelan los cargos más viejos) y export XLSX. Plazo/vencimiento por venta fiada hecho (2026-06-07): `due_date` por cargo (plazo configurable en Operación del POS), columna Vencido en CxC y próximo vencimiento en el historial.
  - [~] Grupos de clientes (tabla `customer_groups` + `customers.group_id`; alta inline y selector en la ficha del cliente). Falta usarlos para precios/promos/riesgo.
  - [x] Reglas de datos obligatorios del cliente: documento, IVA, teléfono, email, domicilio, nacimiento. Configurable por el dueño en Operación del POS (`pos_settings.customer_required`); se exige en la ficha del cliente (alta/edición) con marca " *" y bloqueo de guardado. Se agregó `customers.birth_date` (fecha de nacimiento). Default: nada obligatorio salvo el nombre.
  - [x] **Escaneo de DNI argentino para alta rápida de cliente** *(agregado 2026-06-06; hecho 2026-06-08, PR #263)*: lee el código **PDF417** del frente del DNI (scanner 2D USB tipo teclado vía `useScanner`, cámara con `BarcodeDetector` cuando soporta `pdf417`, o pegado manual) y parsea **offline** los campos separados por `@` (apellido, nombre, sexo, N° de DNI, fecha de nacimiento) con `parseDni` (`lib/customers/dniParse.ts`, +16 tests) para autocompletar la ficha del cliente en alta/edición (`CustomerFormModal`) y el alta rápida del selector del POS (`createQuick`). Sin servicios ni registros gubernamentales — el dato vive en el propio código del documento. Componente `DniScanModal` con **validación visual** de los datos parseados antes de guardar (no autocompleta sin confirmación); degrada honestamente si el navegador no lee `pdf417` por cámara.
  - [x] *Criterio:* una venta fiada genera deuda con vencimiento y aparece en cuentas por cobrar. ✓

- [ ] **H32 — Pedidos de salón, reservas y despacho.**
  - [ ] Pedidos pendientes de facturar: vendedor arma pedido y cajera lo cobra.
  - [ ] Reserva de stock con expiración en minutos.
  - [ ] Anulación automática o liberación al vencer reserva.
  - [ ] Despacho/expedición separado: ventas pagadas pasan a queue de armado/entrega.
  - [ ] Tipos de entrega: retiro inmediato, retiro pendiente en sucursal, envío a domicilio.
  - [ ] Cross-branch configurable por tipo de entrega.
  - [ ] *Criterio:* vendedor crea pedido reservado, cajera lo levanta, cobra y expedición lo marca entregado.

- [ ] **H33 — Depósitos, stock multi-depósito y transferencias.**
  - [ ] Depósitos por sucursal: principal, reserva, devolución, merma, tránsito.
  - [ ] Stock por depósito.
  - [ ] Transferencias entre depósitos con origen/destino, motivo, estado y auditoría.
  - [ ] Recepción parcial y diferencias.
  - [ ] Depósito default por tipo de entrega/devolución.
  - [ ] *Criterio:* se transfiere stock de depósito central a sucursal, queda en tránsito y luego recibido.

- [~] **H34 — Importación masiva por Excel.** — *Productos y clientes hechos (parsers `exceljs`, plantilla descargable, preview con errores, import por lote en `/productos` y `/clientes`). Faltan depósitos/stock/listas (dependen de F4) y reversión. Auditoría hecha (2026-06-07): cada import de productos/clientes deja entrada en audit_logs con el total importado (best-effort, no bloquea el import).*
  - [x] Importar productos por XLSX (parser `parseProductsXlsx` + `ImportProductsModal`).
  - [x] Importar clientes por XLSX (parser `parseCustomersXlsx` + `ImportCustomersModal`).
  - [ ] Importar depósitos/sucursales por XLSX. *(depende de F4 multi-depósito)*
  - [ ] Importar stock inicial y transferencias por XLSX. *(depende de F4)*
  - [ ] Importar listas de precios, medios de pago/planes, garantías extendidas y motivos de devolución por XLSX.
  - [x] Plantillas descargables por entidad con columnas obligatorias y ejemplos.
  - [x] Preview antes de confirmar: filas válidas, errores.
  - [ ] Modo dry-run formal y archivo de errores descargable. *(el preview ya muestra errores)*
  - [ ] Importaciones auditadas y reversibles cuando sea posible.
  - [ ] *Criterio:* un tenant carga productos, clientes, depósitos y stock inicial desde Excel sin tocar SQL.

### F12 — Comercios simples y servicios

Objetivo: que negocios con pocos productos o servicios puedan vender en minutos con pantallas de cobro ultrarrápidas, sin sentirse obligados a cargar inventario pesado. Apunta a heladerías, cafeterías simples, panaderías chicas, peluquerías, barberías, estética/uñas/spa, lavaderos, talleres livianos, profesionales con turnos y comercios de mostrador con catálogo chico. Ver [`22-simple-commerce-services.md`](./22-simple-commerce-services.md).

- [~] **H35 — Onboarding por rubro de catálogo chico.** — *Core entregado (PR #269, 2026-06-08): wizard de "configuración rápida por rubro" (3 pasos) + RPC `apply_industry_preset(p_preset, p_sells)` SECURITY DEFINER tenant-scoped, idempotente y auditada (migración `20260608530000_industry_presets.sql`) que siembra categorías + productos/servicios de muestra (favoritos · H36), servicios sin stock y defaults sensatos de `pos_settings`. Reachable desde el onboarding (`OnboardingChecklist`) y Configuración → Rubro (`RubroCard`). Verificado por SQL (alta limpia siembra; re-aplicar NO duplica). La automatización de impuestos/ticket/medios de pago/roles se apoya en sus propios pasos del onboarding y queda fuera de este PR.*
  - [x] Wizard inicial con pregunta operativa: "vendo productos", "vendo servicios", "vendo ambos". — *Paso 1 del `IndustryPresetWizard`; filtra qué presets/ítems se siembran y los defaults del POS.*
  - [x] Presets de rubro: heladería, cafetería/take away, panadería simple, peluquería/barbería, estética/uñas/spa, lavadero, taller liviano, servicios profesionales. — *8 presets en `modules/onboarding/presets.ts` + la RPC; cada uno con categorías y un puñado de ítems de muestra marcados favorito.*
  - [~] Creación automática de categorías, botones rápidos, impuestos/ticket, medios de pago y roles mínimos. — *Categorías + botones rápidos (favoritos H36) + defaults de `pos_settings` (servicios: sin exigir cliente/documento, venta libre on) sembrados por el preset. Impuestos/ticket/medios de pago/roles los cubren sus secciones del onboarding (cruza con F3/H8/H30) — no se rehacen acá.*
  - [x] Modo "sin stock" para servicios y comercios donde el inventario no importa al inicio. — *Los ítems de servicio se crean con `track_stock=false` (no descuentan inventario en `create_sale`); en modo "servicios" los defaults arrancan sin inventario ni cliente obligatorio.*
  - [x] *Criterio:* una heladería o peluquería queda lista para cobrar una primera venta en menos de 10 minutos, sin importar Excel ni tocar SQL. — *Un preset deja categorías + botones rápidos + defaults en un par de clics; el cajero abre el POS y cobra.*

- [~] **H36 — POS rápido por botones / catálogo chico.** — *Core de cobro rápido por botones entregado (PR#267): favoritos como botones grandes + cantidades rápidas + venta libre por permiso. Sólo queda la cantidad "sesión individual/pack" (depende de H41 — packs/sesiones).*
  - [x] Pantalla de cobro con grilla táctil de favoritos, categorías grandes y botones de alto contraste. — *`components/pos/FavoritesGrid.tsx` (botones grandes alto contraste, mobile/tablet-first) arriba de la grilla del POS; categorías grandes ya existían (`CategoryNav`).*
  - [x] Productos/servicios sin búsqueda obligatoria: el cajero toca 2-3 botones y cobra. — *Favoritos (`products.is_favorite`) se muestran sin buscar; tap = agrega al carrito.*
  - [x] Cantidades rápidas: `+1`, `+2`, `x6`, `x12`, medio kilo/kilo, sesión individual/pack. — *`+1` (tap del botón) + chips `×2/×6/×12` en botones y en la línea del carrito; `½ kg`/`1 kg` para productos por peso. Sesión/pack entregado en H41 (consumo de sesión por línea en el carrito).*
  - [x] Botón "Venta libre" con monto manual y motivo, controlado por permiso. — *Botón "Venta libre (monto manual)" gateado por `pos_settings.allow_free_sale` + rol owner/manager; reusa el mecanismo de línea product-less (`addFreeAmount` → `create_sale` con `product_id` null, no descuenta stock). Probado por SQL.*
  - [x] Cobro express: efectivo exacto, efectivo con vuelto, QR, tarjeta, transferencia. — *Reusa `PaymentModal`/QR existentes (no se duplicó).*
  - [ ] *Criterio:* una venta típica de 3 ítems se carga y cobra en menos de 15 segundos en pantalla táctil.

- [~] **H37 — Modificadores simples para heladería/cafetería.** — *Core hecho (PR #268, 2026-06-08): grupos de modificadores por producto (Tamaño/Sabores/Toppings) con min/max, obligatorio y orden; opciones con +precio; selector en el POS al agregar; precio = base + deltas; persistencia del snapshot en `sale_items.modifiers`. **Combos** (café + medialuna) → F9; **comanda de cocina/producción** → F13.*
  - [x] Tamaños: vasito, cucurucho, 1/4 kg, 1/2 kg, 1 kg, café chico/mediano/grande. — *Modelados como un grupo "Tamaño" (radio, min1/max1) con opciones libres por tenant; no hay lista fija, el dueño carga las suyas.*
  - [x] Sabores/toppings como modificadores, con límite configurable por tamaño. — *Grupos multi con `max_select` configurable (ej. Sabores hasta 3) y opciones con `price_delta` (ej. Crema +200). El POS valida el tope al elegir.*
  - [x] Modificadores obligatorios/opcionales y ordenados para que no frenen al cajero. — *`required` + `min_select`/`max_select` + `sort`; en el selector del POS los obligatorios van primero y se valida min/max antes de confirmar.*
  - [ ] Combos simples: café + medialuna, kilo + cucuruchos, docena, promo familiar. — *Follow-up: se trata a fondo en [F9 — Motor de promociones PRO](#f9--motor-de-promociones-pro).*
  - [ ] Impresión opcional de comanda/producción para preparación. — *Follow-up: comanda de cocina/KDS va con [F13 — Gastronomía PRO](#f13--gastronomía-pro). El snapshot ya queda en `sale_items.modifiers` para alimentarla.*
  - [x] *Criterio:* el cajero vende "1/2 kg, 3 sabores" sin crear 200 productos distintos. — *Verificado: schema `product_modifier_groups`/`product_modifier_options` (migración `product_modifiers`, RLS por tenant), editor plegable en `ProductFormModal`, `ModifierPickerModal` en el POS (radio/multi con límite + precio en vivo), `create_sale` persiste `sale_items.modifiers` con el precio ajustado (probado por SQL).* 

- [~] **H38 — Agenda y servicios para peluquería/estética.** — *Core entregado (local, pendiente de push — migración `20260608540000_agenda.sql` aplicada en remoto vía MCP y validada por SQL): servicios + profesionales + agenda día/semana + cobro desde el turno. **Follow-up (NO en este hito):** liquidación de comisiones (H39), seña/pago de reserva, propinas y lista de espera avanzada.*
  - [x] Servicios con duración, precio, profesional asignable y comisión. — *Un servicio es un `products` con `track_stock=false` + dos campos nuevos `products.service_duration_min` y `products.commission_pct` (sección “Servicio para agenda” en el form de producto). Reusa categorías/precio/favoritos/listas. El profesional se asigna por turno (no es un atributo fijo del servicio).*
  - [~] Agenda diaria/semanal por profesional, silla/cabina o recurso. — *Vista **día** (columnas por profesional + “Sin asignar”) y **semana** (columnas por día, filtrable por profesional), grid horario 8–21h con bloques coloreados por profesional, click en hueco = agendar (`AgendaBoard`). Silla/cabina/recurso genérico queda como extensión (hoy el recurso es el profesional).*
  - [~] Turnos, walk-ins y lista de espera. — *Turnos (`appointments`: snapshot servicio + estado + `sale_id`), **walk-in** (turno ahora, `is_walk_in`, en_curso) hechos. **Lista de espera** queda como follow-up.*
  - [x] Cobro desde turno: servicio realizado → agregar productos extra → cobrar. — *Botón “Cobrar este turno” → `/pos?appointment=<id>`: el POS carga el servicio en el carrito (permite agregar productos extra) y cobra con el flujo existente (`create_sale` intacto); al confirmar, `link_appointment_sale()` enlaza la venta y marca el turno `realizado`.*
  - [~] Señas, cancelaciones, no-show y reprogramación. — *Cancelación con motivo, **no-show**, reprogramación (editar fecha/hora) y todos los estados (reservado/confirmado/en_curso/realizado/cancelado/no_show) hechos. **Seña/pago de reserva** queda como follow-up (H39/pagos).*
  - [x] *Criterio:* una peluquería agenda corte + color con profesional, cobra el turno y calcula comisión. — *Cumplido a nivel core (validado por SQL: profesional + servicio + turno → cambio de estado → venta enlazada; la comisión se calcula y muestra en el detalle del turno). La **liquidación** de comisiones es H39.*

- [~] **H39 — Comisiones, propinas y productividad del staff.** — *Core hecho (migración `20260608550000_commissions_tips`, aplicada en remoto; **local, pendiente de push**). Propinas al cobrar (monto + medio efectivo/tarjeta/QR) en `sales.tip_amount`/`tip_method`, aparte del total de productos. Atribución de vendedor/profesional a la venta (`sales.professional_id`, selector en el PaymentModal) y comisión por línea `coalesce(products.commission_pct, professional.commission_pct, 0)% × subtotal`. Reporte de productividad por profesional en Reportes (servicios, productos, facturado, comisión, propinas, ticket prom. + export XLSX) vía RPC `staff_productivity` SECURITY DEFINER tenant-scoped. Flag `pos_settings.staff_sees_own_only` (toggle en Configuración → Operación) con RLS de lectura sólo-propia en la agenda y filtro en el reporte. Probado por SQL (rollback). **Reparto de propina entre varios profesionales** → futuro (hoy la propina va al profesional de la venta).*
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

- [ ] **H42 — Oportunidad comercial y plantillas vendibles.**
  - [ ] Landing/demo por rubro: "POS para heladerías", "POS para peluquerías", "POS para estética", "POS para cafeterías chicas".
  - [ ] Datos demo precargados por rubro para mostrar valor en 3 minutos.
  - [ ] Plan Start orientado a catálogo chico: bajo setup, pantalla simple, agenda básica o botones rápidos.
  - [ ] Métrica de activación: primer cobro real, primer turno agendado, primer cliente recurrente.
  - [ ] *Criterio:* ventas puede demoear cada rubro con flujo real sin configurar datos manualmente.

### F13 — Gastronomía PRO

Objetivo: cubrir restaurantes, resto-bares, cafeterías, heladerías, panaderías, rotiserías, food trucks y fast food con mesas, comandas, cocina/barra, delivery/takeaway y variantes de atención. No reemplaza F12: F12 cubre cobro simple; F13 cubre operación gastronómica completa. Ver [`23-restaurant-cafe-operations.md`](./23-restaurant-cafe-operations.md).

- [~] **H43 — Configuración de negocio gastronómico y modos de atención.** — *Núcleo del modo gastronómico hecho (local, pendiente de push): toggle `pos_settings.dining_enabled` (Configuración → Operación → "Modo gastronómico / mesas"). ADITIVO: con off, el POS mostrador queda idéntico; con on, aparece la sección Salón en el menú y "Salones y mesas" en Configuración. **Presets por tipo de rubro gastronómico** que activan la suite F13 (mesas/cocina/delivery) → hechos (H47 — restaurante / resto_bar / rotiseria / dark_kitchen, ver abajo; local pendiente de push). **Follow-up:** modos de venta como tales (take away / delivery / pickup / QR como modo seleccionable), selector por caja/dispositivo y reglas por modo (cobrar antes/después, comanda al enviar/cobrar) → siguen pendientes (se cruzan con H45/H49).*
  - [x] Modo gastronómico on/off por tenant (`dining_enabled`), aditivo (mostrador intacto con off).
  - [~] Presets por tipo: restaurante salón, resto-bar, cafetería, heladería, panadería, rotisería, fast food, food truck, dark kitchen, delivery/takeaway. — *Presets gastronómicos que ENGANCHAN la suite F13 hechos (H47, local pendiente de push). Migración `20260608760000_gastro_presets` extiende `apply_industry_preset` con 4 presets nuevos en `modules/onboarding/presets.ts` + SQL (nombres de categorías/ítems sincronizados): **`restaurante`** (mesas+cocina: `dining_enabled=true`, siembra salón "Salón" con 6 mesas, comidas → `products.station='cocina'`, bebidas → `'barra'`), **`resto_bar`** (mesas+cocina+barra+delivery: `dining_enabled`+`delivery_enabled`, salón "Salón"+mesas + zona "Zona local", tragos/cervezas → `'barra'`), **`rotiseria`** (mostrador+delivery: `delivery_enabled=true` + zona "Zona local", comidas → `'cocina'`, sin mesas), **`dark_kitchen`** (SOLO delivery, sin mostrador: `delivery_enabled=true` + zona, comidas → `'cocina'`). Idempotente/seguro: enciende sólo el flag del módulo elegido (no apaga ni pisa otros settings); no duplica salón/mesas/zona/ítems al re-aplicar (probado por SQL). Heladería/cafetería/etc. **intactos** (no tocan dining/delivery/salón — probado). La tarjeta del wizard (`IndustryPresetWizard`) muestra "Incluye mesas y cocina (KDS)" / "Incluye delivery" por preset (`PresetDef.enables`). **Follow-up (NO en este tick):** cafetería/heladería/panadería como presets de mostrador gastronómico (hoy son los presets clásicos F12), fast food / food truck, menú por horario/canal (H48), pickup / drive-through / QR-mesa como modos separados.*
  - [ ] Modos de venta: mesa, mostrador, take away, delivery propio, pickup, drive-through, pedido por QR, evento/food truck.
  - [ ] Selector por caja/dispositivo: salón, barra, cocina, mostrador, despacho.
  - [ ] Reglas por modo: cobrar antes/después, imprimir comanda al enviar/cobrar, pedir nombre de cliente, pedir mesa, pedir teléfono/dirección.
  - [ ] *Criterio:* un tenant cambia de cafetería de mostrador a cafetería con mesas sin tocar código ni migraciones manuales.

- [~] **H44 — Mesas, salones y comandas de salón.** — *Núcleo hecho (local, pendiente de push): migración `20260608580000_dining_tables` (`dining_areas`, `dining_tables`, `table_orders`, `table_order_items`, RLS por tenant + RPCs tenant-scoped con guard de miembro activo y auditoría). CRUD de salones/mesas en Configuración → "Salones y mesas". Vista de **Salón** (`/salon`): grid de mesas por salón, color por estado (libre/ocupada/cuenta_pedida/bloqueada), capacidad y total vivo; tap libre → abrir + cargar, tap ocupada → ver/editar cuenta, agregar ítems (picker de productos + ítem libre), cancelar o cobrar. **Cobrar mesa** reusa el POS: `/pos?table=<order_id>` carga los ítems al carrito y, al confirmar, `close_dining_table` enlaza la venta, marca el pedido 'cobrada' y libera la mesa (espeja el cobro de turno · H38). Probado por SQL (abrir → cargar → editar/quitar → cobrar con create_sale → cerrar). **Follow-up (NO en este PR):** mover/unir/transferir mesas, reservas (H51), propina por mesa, ticket separado por comensal (varias ventas). **Ya hechos después:** ruteo por estación (H45 mínimo), KDS / pantalla de cocina (H46), comanda impresa (H45 print) y **división de cuenta** (N pagos por partes/monto/porcentaje/ítem en un solo `create_sale`, local pendiente de push).*
  - [x] Configuración visual de salones/sectores (salón principal, terraza, barra, etc.) — CRUD en Configuración.
  - [x] Mesas con número/nombre, capacidad, estado y mozo asignado. (posición/forma → follow-up).
  - [x] Estados de mesa núcleo: libre, ocupada, cuenta pedida, bloqueada. (esperando pedido/en cocina/servida/limpieza/reservada → con KDS/reservas).
  - [x] Apertura de mesa, cargar pedido y cerrar mesa (cobro). (mover/unir/transferir → follow-up).
  - [x] División de cuenta por ítem, por comensal, por porcentaje o por monto. — *Hecho (N pagos, local pendiente de push): opción "Dividir cuenta" en el modal de cobro (`PaymentModal`) — aplica al cobro de mesa (`/pos?table=`) y al mostrador. Arma N líneas de pago que suman EXACTO el total (`payTotal`) y se mandan como `p_payments` en UN solo `create_sale` (una venta; la mesa se cierra/libera igual con `close_dining_table`). 4 modos: partes iguales (N comensales), por monto, por porcentaje (suma 100%) y por ítem (asignar ítems del pedido a cada comensal; lo no asignado → última línea). Cada línea elige su medio (efectivo/tarjeta/QR/…) respetando el gating de medios de pago (misma lista que el cobro simple; vale/cuenta corriente excluidos del split); voucher de tarjeta por línea si el negocio lo exige. Reconciliación en centavos: el remanente de redondeo va a la última línea para cuadrar al centavo. Muestra total/asignado/restante/vuelto. **Follow-up (NO en este PR):** ticket/comprobante SEPARADO por comensal (varias ventas), propina por comensal distinta, y dejar la mesa parcialmente abierta (pagar parte y seguir).*
  - [ ] Propina sugerida y propina libre. — *Base de propina en H39; propina por mesa → follow-up.*
  - [x] *Criterio:* un mozo abre mesa 12, carga pedido, envía comanda, divide la cuenta en dos pagos y libera la mesa. — *Abrir/cargar/enviar comanda (H45 impresa)/cobrar/liberar OK; división de cuenta → hecho (N pagos: p. ej. una línea efectivo + una tarjeta en un solo `create_sale`, mesa liberada). Ticket separado por comensal = follow-up.*

- [~] **H45 — Comandas impresas y ruteo por estación.** — *Ruteo por estación + **comanda IMPRESA por estación** hechos (local, pendiente de push). Ruteo: `products.station` (cocina/barra/cafeteria/parrilla/postres/despacho + "sin estación"), snapshot en `table_order_items.station` al cargar el ítem (alimenta el KDS H46). Comanda impresa: acción **"Imprimir comanda"** en la cuenta de la mesa (`TableAccountModal`) y un botón por mesa en el KDS. Agrupa los ítems por estación y emite **una comanda por estación** (cocina lo suyo, barra lo suyo; ítems sin estación → comanda "Sin estación"), filtrable por estación. Es ticket de COCINA **sin precios ni totales**: nombre del local (opcional), mesa + salón, hora, mozo, e ítems con cantidad + modificadores + notas; estación como encabezado grande. Reusa el flujo de impresión web de los tickets (`window.print` + CSS print `.comanda-print`/`.comanda-page` con salto de página por estación; rollo 58/80mm). Evita re-imprimir: `table_order_items.printed_at` (migración `20260608620000_comanda_printed`) + RPCs `comanda_items`/`mark_comanda_printed`; por defecto imprime sólo lo NUEVO (no enviado) y lo marca, con opción "reimprimir todo". **Follow-up (NO en este PR):** impresión física automática a impresora de RED por estación (acá es print del navegador) + fallback a cola, cancelación parcial con re-impresión de anulación, agrupar por curso (entradas/principales), prioridad/modo de entrega/alergias en la comanda, QZ Tray. Default de estación por categoría → follow-up.*
  - [x] Comanda antes del pago para restaurante/cafetería cuando corresponda. — *"Imprimir comanda" desde la cuenta de la mesa (mesa abierta, antes de cobrar) y desde el KDS.*
  - [x] Ruteo por estación: cocina, barra, cafetería, parrilla, postres, despacho. — *`products.station` + snapshot en la línea; el KDS agrupa por estación.* (cocina fría/heladería como estaciones extra → follow-up; la lista es ampliable sin migración.)
  - [ ] Impresora por estación y fallback a cola si falla. — *Follow-up: hoy es print del navegador (una hoja por estación con salto de página); impresora de red por estación + cola ESC/POS → F4.*
  - [~] Comanda con mesa/pedido, mozo/cajero, hora, ítems, modificadores, notas, alergias, prioridad y modo de entrega. — *Comanda impresa con mesa/salón, hora, mozo, ítems + modificadores + notas (sin precios). Alergias/prioridad/modo de entrega → follow-up.*
  - [~] Reimpresión, cancelación parcial, agregado posterior y marca de "ya enviado". — *Marca "ya enviado" (`printed_at`) + imprime sólo lo nuevo + "reimprimir todo" hechos. Cancelación parcial con re-impresión de anulación → follow-up.*
  - [x] Separación de comandas por estación sin duplicar ítems. — *`kds_tickets(p_station)` (pantalla) y `comanda_items` + agrupado por estación en cliente (impresa): cada línea va a una sola estación, una comanda por estación.*
  - [x] *Criterio:* café va a barra, tostado a cocina y helado a estación heladería en tickets separados, con el mismo pedido. — *La comanda emite una hoja IMPRESA por estación (salto de página) del mismo pedido; en pantalla el KDS separa por estación.*

- [~] **H46 — KDS / pantalla de cocina y barra.** — *Núcleo hecho (local, pendiente de push): migración `20260608590000_kds` (`table_order_items.kds_status`/`kds_ready_at` + `products.station`; RPCs tenant-scoped `kds_tickets`/`set_item_kds_status` con guard de miembro activo). Pantalla **`/kds`** en route group propio (fullscreen, alto contraste, sin AppShell — para un monitor en cocina/barra; se abre con `window.open('/kds')` desde el Salón). Muestra los ítems de pedidos de mesa ABIERTOS pendientes/preparando/listo **agrupados por estación** (tabs `?station=` + "Todas") y dentro por mesa/pedido; cada tarjeta: mesa/salón, cantidad + ítem, modificadores, notas y **timer** desde la carga, con **alertas por demora** (>5 min ámbar, >10 min rojo). Botones para avanzar estado (pendiente → preparando → listo → entregado; "entregado" lo saca de la vista) y retroceder. **Tiempo real por polling** (`useQuery` con `refetchInterval` ~4s sobre `kds_tickets`, tenant-scoped por RLS). Probado por SQL (ítem con estación → aparece en `kds_tickets` de esa estación; avanzar a listo sella `ready_at`; entregado lo saca). **Follow-up (NO en este PR):** comanda IMPRESA por estación (H45 print), SLA configurable avanzado, cancelación parcial con re-impresión, KDS de barra físicamente separado, modo offline con cola de sincronización.*
  - [x] Vista KDS por estación con tarjetas de pedido en tiempo real. — *`/kds`, polling ~4s, tabs por estación.*
  - [~] Estados: nuevo, aceptado, preparando, listo, entregado, demorado, cancelado. — *Núcleo: pendiente → preparando → listo → entregado; "demorado" se refleja visualmente por el timer (ámbar/rojo). Aceptado/cancelado finos → follow-up.*
  - [~] Timers por estación, SLA configurable y alertas visuales por demora. — *Timer por ítem + alertas a 5/10 min hechas; SLA configurable por estación → follow-up.*
  - [~] Agrupación por mesa/pedido, por estación, por curso/plato o por orden de llegada. — *Por estación (tabs) y por mesa/pedido (columnas), orden de llegada FIFO. Por curso/plato: cada tarjeta del KDS muestra el **Tiempo N** del ítem (cursos / despacho por tiempos, local, pendiente de push — ver H47); agrupar columnas por curso → follow-up.*
  - [ ] Modo offline local con cola de sincronización cuando la red cae. — *Follow-up.*
  - [x] *Criterio:* cocina marca un plato como listo y el mozo/caja ve el cambio sin recargar. — *`set_item_kds_status` + polling: el estado se refresca solo (~4s) en el KDS y la cuenta de la mesa se invalida.*

- [ ] **H47 — Menú gastronómico, modificadores y cursos.**
  - [ ] Menú por horario/canal: desayuno, almuerzo, merienda, cena, happy hour, delivery.
  - [ ] Modificadores obligatorios/opcionales: punto de cocción, guarnición, salsa, leche, tamaño, sabor, topping, sin TACC, sin sal, extra.
  - [x] Cursos/platos: entrada, principal, postre, bebida; enviar todo o "fire course" por etapa. — *Cursos / despacho por tiempos hecho (local, pendiente de push). Cada ítem del pedido lleva un **tiempo (`table_order_items.course`** smallint, 1=entrada/2=principal/3=postre…) y un **`fired_at`** (cuándo se disparó a cocina; null = "en espera"). Al cargar un ítem (`add_table_order_item` + params opcionales `p_course`/`p_hold`) se elige el tiempo y si va a cocina al toque (default, = flujo actual) o **en espera**. Disparar por etapa: **`fire_table_order_course(p_order_id, p_course)`** sella `fired_at` de los ítems en espera de ese tiempo (o de todos si `p_course` null = "disparar todo"); audita en `audit_logs` (`fire_course`). **Sólo lo disparado llega a cocina**: `kds_tickets` y `comanda_items` filtran `fired_at is not null` (lo en espera NO aparece en KDS/comanda). En la cuenta de la mesa (`TableAccountModal`) los ítems van **agrupados por tiempo** con selector para cambiar el tiempo de un ítem (`set_table_order_item_course`), badge "En espera · Tiempo N" y botón **"Disparar Tiempo N"** (+ "Disparar todo"); el picker permite elegir tiempo y hold. El **KDS y la comanda muestran el Tiempo N** en cada tarjeta/línea para la secuencia. Migración `20260608680000_dining_courses`; **backfill** `fired_at = created_at` de lo existente (lo ya cargado cuenta como ya disparado, nada se rompe). **Follow-up (NO en este PR):** tiempos automáticos por timer, sugerencia de curso por categoría de producto, "llamar postre" como notificación push, coordinación multi-estación del mismo curso.*
  - [ ] Notas por ítem y notas generales de pedido.
  - [ ] Alergias/intolerancias destacadas en comanda y KDS.
  - [ ] Combos y menús cerrados sin obligar al cajero a tocar 20 botones.
  - [ ] *Criterio:* "menú ejecutivo entrada + principal + bebida" se carga en un flujo guiado y cocina recibe cada curso correcto.

- [ ] **H48 — Cafetería, heladería y mostrador híbrido.**
  - [ ] Flujo de mostrador con nombre del cliente, número de orden o pager.
  - [ ] Pedido abierto: cobrar antes, enviar comanda y marcar listo para retirar.
  - [ ] Modificadores de cafetería: tamaño, tipo de leche, temperatura, extra shot, syrup, para llevar/en taza.
  - [ ] Modificadores de heladería: tamaño, cantidad de sabores, topping, cucuruchos, balanza opcional.
  - [ ] Cola de preparación visible para barra/heladería.
  - [ ] *Criterio:* se cobra "latte mediano leche vegetal + medialuna" y barra ve el pedido con nombre del cliente.

- [~] **H49 — Delivery, take away y despacho gastronómico.** — *Núcleo hecho (local, pendiente de push): HERMANO de H44 (mesas) pero SIN mesa. Migración `20260608720000_delivery_orders` (tablas `delivery_orders` + `delivery_order_items` espejando `table_orders`/`table_order_items` — mismas columnas KDS/comanda/cursos; RLS tenant-scoped; gating `pos_settings.delivery_enabled` default false + `useDeliveryEnabled`). RPCs SECURITY DEFINER tenant-scoped (guard `_dining_assert_member`): `create_delivery_order` / `add_delivery_order_item` (FOR UPDATE + snapshot de station, igual que H44) / `set_delivery_order_item_qty` / `set_delivery_status` (transiciones válidas por tipo + audit) / `assign_courier` / `cancel_delivery_order` / `fire_delivery_order_course`. **KDS unificado:** `kds_tickets` y la comanda ahora UNEN mesa + delivery con etiqueta de origen (`source` 'mesa'/'delivery' + `source_label` "Mesa 5" / "DELIVERY #1234" / "TAKEAWAY #1234"); preserva `fired_at not null`, excluir 'entregado', orden FIFO; `set_item_kds_status` resuelve mesa o delivery. **Cobro atómico:** `create_sale` ganó `p_delivery_order_id` que ESPEJA EXACTO la rama de mesa (FOR UPDATE del pedido al inicio → aborta si ya cobrado/cancelado; al final enlaza `sale_id` + marca 'entregado' + audit, misma TX → sin doble cobro). El costo de envío entra como LÍNEA del carrito ("Costo de envío"); `create_sale` no calcula el fee (totales/redondeo/stock intactos). Mostrador (todos null), QR y la rama de mesa quedaron INTACTOS (probado por SQL). **Board `/delivery`** (kanban por estado, gateado por `delivery_enabled`, independiente de las mesas): tarjetas con cliente/tel/dirección/canal/horario prometido/cadete/total; avanzar estado, abrir cuenta, alta de pedido. **Alta** (`DeliveryOrderModal`): canal + tipo (delivery/takeaway), cliente existente o suelto (nombre+tel), dirección+referencia (sólo delivery), horario prometido, costo de envío. **Cuenta** (`DeliveryAccountModal`): ver/editar ítems (picker estilo `TableProductPicker`), asignar cadete, cobrar (link `/pos?delivery=<id>` que carga ítems + envío y cobra atómico, espejando `?table=`). Nav: entrada **Delivery** gateada por `delivery_enabled`. Probado por SQL (crear → ítem en KDS con etiqueta delivery → cobro atómico fee incluido, 2º intento `delivery_order_not_open` → estados; takeaway rechaza `en_camino`; mostrador/mesa intactos). **Follow-up (NO en este PR):** integración marketplace (PedidosYa/Rappi/MercadoLibre/TiendaNube), tracking GPS del cadete, mapa/geocoding de direcciones, zonas de envío con tarifa automática, tiempos automáticos por estado, notificación al cliente por WhatsApp del estado, comanda IMPRESA / etiqueta de despacho de delivery (la comanda impresa sigue siendo de mesa; `delivery_comanda_items` ya existe en DB para cuando se sume).*
  - [x] Pedidos con canal: mostrador, teléfono, WhatsApp, QR, delivery propio, marketplace futuro. — *Canal en `delivery_orders.channel` (mostrador/telefono/whatsapp/qr/delivery_propio); marketplace → follow-up.*
  - [x] Datos por pedido: cliente, teléfono, dirección, referencia, horario prometido, cadete/repartidor, costo de envío. — *Todos en `delivery_orders` + alta + cuenta.*
  - [x] **H49 follow-up — Zonas de envío con tarifa automática.** — *Local, pendiente de push. Migración `20260608730000_delivery_zones`: tabla `delivery_zones` (nombre, `fee`, `eta_minutes` opcional, `is_active`, `sort_order`, baja lógica) con RLS tenant-scoped — lectura por miembros, **escritura sólo owner/manager** (espeja `tenant_branding`, enforced server-side; probado por SQL que cashier no puede insertar/actualizar). `delivery_orders.zone_id` (FK on delete set null). `create_delivery_order` ganó `p_zone_id`: al tomar un pedido de delivery, elegir la zona **autocompleta el costo de envío** con su tarifa y lo **snapshotea** en `delivery_orders.delivery_fee` (cambiar la tarifa de la zona después NO altera pedidos viejos — probado por SQL); el fee queda **editable** (override manual gana sobre la zona). Takeaway ignora zona (envío 0). Gestión de zonas en **Configuración → Zonas de envío** (`ZonasManager`, gateada por `delivery_enabled`); selector de zona en el alta (`DeliveryOrderModal`, sólo si hay zonas cargadas — si no, el fee manual sigue como antes); zona/eta visibles en la tarjeta del board y en la cuenta. **Sigue follow-up (NO en este PR):** geocoding/mapa, detección automática de zona por dirección/GPS, polígonos, tarifa por distancia/peso, mínimos por zona.*
  - [~] Estados: recibido, aceptado, en preparación, listo, en camino, entregado, cancelado. — *Delivery: recibido → preparando → en_camino → entregado (+ cancelado). Takeaway: recibido → preparando → listo → entregado (+ cancelado). "Aceptado" fino → follow-up.*
  - [~] Comanda a cocina y ticket/etiqueta para despacho. — *A cocina vía KDS unificado (el pedido aparece con su identificador delivery). **Comanda IMPRESA de delivery/takeaway hecha (local, pendiente de push):** botón "Imprimir comanda" en la cuenta del pedido (`DeliveryAccountModal`) → reusa `ComandaModal` generalizado (`source="delivery"`) con `delivery_comanda_items` + `mark_delivery_comanda_printed`; encabezado "DELIVERY/TAKEAWAY #1234" + cliente/teléfono/dirección/horario/cadete, agrupado por estación, sin precios, "sólo lo nuevo"/"reimprimir todo" + anti-reimpresión idempotente. Etiqueta de despacho específica → follow-up.*
  - [ ] Integración futura con PedidosYa, Rappi, Mercado Libre/Tienda Nube cuando aplique. — *Follow-up.*
  - [x] *Criterio:* una rotisería toma pedido telefónico, cocina lo prepara, despacho lo marca en camino y caja lo concilia. — *Alta telefónica → KDS prepara → board marca "en camino" → cobro atómico desde el pedido (caja). Probado por SQL.*

- [~] **H50 — Inventario gastronómico, recetas y merma básica.** — *Arrancado: receta/escandallo + costo y margen por plato (ver sub-ítems). Falta descuento de insumos al vender, producción/batch, merma y alertas.*
  - [x] Recetas/escandallo por producto: ingredientes, cantidad, unidad y costo estimado. — *Hecho (local). Migración `20260609160000_product_recipes` (aplicada en remoto): tabla `product_recipes` (ingrediente texto + qty + unit + unit_cost, RLS por tenant, una policy como el resto del dominio de producto). UI: sección plegable **"Receta / escandallo (costo y margen)"** en la ficha del producto (`RecipeEditor`, espeja `ModifiersEditor`): filas ingrediente/cantidad/unidad/costo-unitario, costo por línea, y resumen **costo del plato + precio + margen** ($ y %, rojo si se vende bajo costo) calculado en vivo. Helpers puros y testeados (`recipeCost`/`marginAmount`/`marginPct` en `modules/products/recipes.ts` + `tests/unit/recipe-cost.test.ts`). Modelo v1: ingrediente como texto libre; vincularlo a un producto de stock → follow-up (habilita el descuento al vender).*
  - [ ] Descuento de insumos al vender cuando el tenant lo active.
  - [ ] Producción/preparación previa: batch de helado, masa, prep de cocina, stock de barra.
  - [ ] Merma: vencido, roto, devolución, preparación fallida.
  - [ ] Alertas de insumos críticos y reporte de margen por plato.
  - [ ] *Criterio:* vender 10 combos descuenta insumos configurados y muestra margen estimado.

- [~] **H51 — Reservas gastronómicas, waitlist y ocupación.** — *Núcleo local: agenda de reservas con sentar y seña. `dining_reservations` + RPCs `create_reservation` / `set_reservation_status` / `cancel_reservation` / `seat_reservation` (SECURITY DEFINER tenant-scoped, search_path fijo) en `supabase/migrations/20260609120000_dining_reservations.sql`. UI `/reservas` (agenda hoy / próx. 7 días, alta con picker de cliente optimizado, confirmar / cancelar / no-show / sentar), gateada por `dining_enabled` (toggle del dueño, no plan), nav en AppShell.*
  - [x] Reservas por mesa/sector/capacidad, fecha, hora, duración estimada y seña opcional. — *`dining_reservations`: area_id/table_id/party_size/reserved_at/duration_minutes/deposit_amount; alta en `ReservationModal`.*
  - [ ] Lista de espera con prioridad y aviso por WhatsApp/email futuro. — *Follow-up (waitlist + recordatorio automático al cliente; reservas online públicas también).*
  - [ ] Turnover de mesas: tiempo sentado, tiempo sin ordenar, tiempo desde cuenta pedida. — *Follow-up.*
  - [x] Bloqueo de mesas por evento, mantenimiento o configuración del salón. — *Estado `reservada` en `dining_tables`: una reserva con mesa asignada la bloquea; al sentar pasa a ocupada, al cancelar/no_show vuelve a libre. (Bloqueo manual por mantenimiento ya existía vía `bloqueada`.)*
  - [x] *Criterio:* una reserva bloquea mesa/sector, luego se convierte en mesa ocupada y conserva cliente/seña. — *`seat_reservation` reusa `open_dining_table` (abre la mesa → ocupada), enlaza `table_order_id`, marca la reserva `sentada` y conserva cliente/comensales/seña (snapshot en la reserva + notas del pedido). Probado por SQL (crear → confirmar → sentar → cancelar/no_show, con ROLLBACK).*

- [~] **H52 — Reportes gastronómicos y operación.** — *Núcleo (local). RPCs tenant-scoped `gastro_tables_report` / `gastro_kitchen_report` / `gastro_delivery_report` / `gastro_top_items_report` (SECURITY DEFINER, search_path fijo, agregan EN SQL) + sección "Gastronomía" en `/reportes` (gateada por `dining_enabled || delivery_enabled`) con tabla/chart por sub-bloque, estados vacíos y export XLSX (gateado por `export_xlsx`). Migración `20260609130000_gastro_reports.sql`. Probado por SQL (datos sintéticos + cleanup).*
  - [x] Ventas por mozo, mesa, sector, estación, canal, producto. — *`gastro_tables_report` (salón/mesa/mozo + ticket prom. + rotación = pedidos cerrados), `gastro_delivery_report` (canal/zona/tipo), `gastro_top_items_report` (estación/curso). Modificador y horario fino → follow-up.*
  - [x] Tiempos: pedido a cocina (pendiente→listo) por estación y global, rotación de mesa. — *`gastro_kitchen_report` (avg/min/máx de `created_at`→`kds_ready_at`, mesa + delivery). "Listo→entregado", cancelaciones/reimpresiones/comandas demoradas → follow-up.*
  - [x] Top productos por estación y curso/tiempo. — *`gastro_top_items_report` (qty + importe, mesa + delivery).*
  - [ ] Margen por plato si hay recetas. — *Follow-up: requiere recetas/costo de mercadería (H50).*
  - [x] Export XLSX. — *Hojas gastro por salón/mesa/mozo/cocina/delivery(canal,zona)/top, gateadas por export_xlsx + el modo del tenant.*
  - [ ] *Criterio:* el owner identifica cuellos de botella de cocina/barra y productos con más margen. — *Cuellos de cocina/barra ✓ (tiempos por estación). Margen por plato → H50 (recetas).*

### F9 — Motor de promociones PRO

Objetivo: igualar o superar a los POS líderes (Square, Lightspeed, Toast, Fudo, Shopify POS) en promociones. Motor **declarativo** (reglas sin código), evaluado en el carrito en tiempo real, auditable y combinable. Configurable 100% por el dueño desde el panel.

- [ ] **H53 — Núcleo del motor de reglas.**
  - [ ] Modelo declarativo: **condiciones** (productos, categorías, marcas, cantidad, monto, cliente/segmento, día/horario, canal, sucursal, medio de pago) → **acciones** (% descuento, monto fijo, precio fijo, producto bonificado, envío/recargo).
  - [ ] Evaluación en el carrito en vivo, con prioridad, **combinables o exclusivas**, y tope de descuento.
  - [ ] Vigencia por fecha/horario (usa el calendario unificado de TX).
  - [ ] *Criterio:* "Miércoles 30% en bebidas de 18 a 21hs" se configura sin código y aplica solo en ese rango.

- [ ] **H54 — Catálogo de tipos de promoción.**
  - [ ] **2x1 / 3x2 / NxM**, **% por volumen** (escalonado), **combos/bundles** a precio especial, **descuento por segundo ítem**, **precio por pack**, **regalo por compra** (gift with purchase), **descuento por medio de pago**, **happy hour**, **liquidación por temporada**.
  - [ ] **Cupones / códigos** (únicos o multiuso, con límite de usos, por cliente o global).
  - [ ] *Criterio:* cada tipo tiene su preset configurable y un ejemplo de demo.

- [ ] **H55 — Segmentación y fidelización.**
  - [ ] Reglas por **segmento de cliente** (nuevos, frecuentes, cumpleaños, lista mayorista).
  - [ ] Base para **fidelización**: puntos, niveles, recompensas canjeables (gancha con cuenta corriente de clientes).
  - [ ] **Gift cards** y saldo a favor.
  - [ ] *Criterio:* un cliente "VIP" recibe automáticamente un precio/beneficio distinto en el POS.

- [ ] **H56 — Gobierno, simulación y reporte de promociones.**
  - [ ] **Simulador**: previsualizar el efecto de una promo sobre ventas históricas antes de activarla.
  - [ ] **Tope de impacto** y aprobación (rol manager/owner), todo auditado.
  - [ ] **Reporte de performance** por promoción (uso, descuento otorgado, margen, incremental).
  - [ ] Export en **XLSX** (ver TX) y al catálogo/canales.
  - [ ] *Criterio:* el dueño ve cuánto descuento otorgó cada promo y su impacto en margen.

### F14 — Motor comercial enterprise

Objetivo: convertir la configuración comercial en un sistema central y auditado: planes, cuotas, recargos, impuestos, costos, reglas, inventario avanzado, compras, offline completo, omnicanal, API y analítica. F11 cubre retail avanzado; F14 lo vuelve **enterprise, versionado, simulable y gobernado**. Ver [`27-commercial-configuration-engine.md`](./27-commercial-configuration-engine.md).

- [ ] **H57 — Jerarquía de configuración y precedencia.**
  - [ ] Niveles: global NinjaSoft → plan → tenant → rubro → sucursal → caja → canal → rol → usuario → horario/campaña.
  - [ ] Resolución de valor efectivo con explicación: "este recargo viene de tenant, sobrescrito por sucursal".
  - [ ] Conflictos detectados antes de guardar.
  - [ ] *Criterio:* un owner ve por qué una caja usa una regla distinta y puede volver al default sin SQL.

- [ ] **H58 — Planes, cuotas, add-ons y entitlements enterprise.**
  - [ ] Plan base, plan custom por tenant, add-ons, paquetes de módulos, límites blandos/duros y medición de uso.
  - [ ] Cuotas configurables: usuarios, sucursales, cajas, productos, ventas, comprobantes AFIP, almacenamiento, mensajes, integraciones, API calls.
  - [ ] Exceso de uso: aviso, grace period, upgrade sugerido, cargo adicional o bloqueo gradual según política.
  - [ ] *Criterio:* internal crea un plan específico para un cliente con 8 sucursales, add-on gastronómico y límite de 100.000 ventas/mes.

- [ ] **H59 — Recargos, financiación, tasas y redondeos por contexto.**
  - [ ] Recargos/descuentos por medio, marca, adquirente, plan de cuotas, canal, sucursal, horario, ticket mínimo y rol.
  - [ ] Configuración de financiación: interés compuesto/simple, cuotas sin interés absorbidas por comercio, costo financiero total visible, vigencia y topes.
  - [ ] Service charge, propina sugerida, fee delivery, cargo por packaging, impuesto/tasa local y redondeo por moneda.
  - [ ] Transparencia: todo recargo aparece antes de cobrar y en ticket/comprobante cuando corresponda.
  - [ ] *Criterio:* "Visa 6 cuotas +18%" aplica solo en sucursal A, de lunes a viernes, con simulación del total antes de cobrar.

- [ ] **H60 — Motor de reglas comerciales unificado.**
  - [ ] Condiciones/acciones para precio, descuento, recargo, comisión, límite, alerta, bloqueo o sugerencia.
  - [ ] Prioridad, exclusividad, combinabilidad, vigencia, audiencia, test A/B y simulador con ventas históricas.
  - [ ] Unifica promociones F9, recargos F11, planes F7/F14, comisiones F12 y reglas gastronómicas F13.
  - [ ] *Criterio:* una regla "mayorista paga transferencia sin recargo y 5% menos desde 20 unidades" se configura sin código.

- [ ] **H61 — Facturación SaaS, dunning y ledger de cobros NinjaSoft.**
  - [ ] Ledger interno por tenant: cargos, créditos, descuentos, impuestos, pagos, deuda, vencimientos y recibos.
  - [ ] Dunning configurable: aviso preventivo, vencido, grace period, suspensión parcial, suspensión total y reactivación.
  - [ ] Aumentos masivos segmentados con preview, exclusiones, aceptación requerida y notificaciones automáticas.
  - [ ] *Criterio:* billing programa aumento del 20% para planes Pro, excluye clientes con contrato vigente y ve impacto MRR antes de aplicar.

- [ ] **H62 — Centro de configuración PRO.**
  - [ ] Plantillas por rubro: kiosco, retail, electro, textil, cafetería, heladería, restaurante, peluquería, servicios.
  - [ ] Import/export de configuración XLSX/JSON: medios, recargos, roles, tickets, tipos de entrega, depósitos, reglas, salones, mesas, comisiones.
  - [ ] Versionado, diff, preview, rollback y ambiente sandbox por tenant.
  - [ ] *Criterio:* se clona la configuración de una sucursal a otra, se revisa diff y se revierte en un click.

- [ ] **H63 — Gobierno de cambios y aprobaciones.**
  - [ ] Maker-checker para cambios sensibles: precio, plan, recargo, regla fiscal, permiso, suspensión, integración, export masivo.
  - [ ] Motivo obligatorio, adjuntos, antes/después, aprobación por rol y expiración de solicitud.
  - [ ] Alertas a owner/manager/internal cuando una configuración crítica cambia.
  - [ ] *Criterio:* un manager crea un recargo nuevo, owner lo aprueba y el audit log conserva todo el circuito.

- [ ] **H64 — Inventario PRO, compras y proveedores.**
  - [ ] Lotes, vencimientos, números de serie, garantías por serie, conteos cíclicos, inventario físico, ajustes masivos y auditoría.
  - [ ] Proveedores, órdenes de compra, recepción parcial, costos, listas de proveedor, reposición sugerida y cuenta corriente de proveedores.
  - [ ] Alertas de stock mínimo/máximo, demanda proyectada y transferencia recomendada entre depósitos/sucursales.
  - [ ] *Criterio:* se crea una orden de compra por reposición sugerida, se recibe parcial y actualiza costo/stock/lote.

- [ ] **H65 — Offline-first completo.**
  - [ ] POS/PWA con cache local, cola de ventas/pagos/comandas/stock, reintentos y resolución de conflictos.
  - [ ] Reconciliación al reconectar: stock, caja, numeración interna, cola fiscal, pagos y auditoría.
  - [ ] Políticas por tenant: qué se permite offline, montos máximos, usuarios autorizados, duración máxima y bloqueo preventivo.
  - [ ] *Criterio:* un local vende 3 horas sin internet y al volver sincroniza sin duplicar ventas ni romper caja/stock/AFIP.

- [ ] **H66 — Omnicanal, marketplace hub y catálogo sincronizado.**
  - [ ] Canales: mostrador, catálogo público, QR mesa, WhatsApp, Tienda Nube, Mercado Libre, delivery propio, PedidosYa/Rappi futuro.
  - [ ] Stock reservado por canal, precios/listas por canal, estados de pedido, cancelación, reembolso y conciliación.
  - [ ] Mapeo de productos/modificadores/categorías por canal sin duplicar catálogo base.
  - [ ] *Criterio:* un producto cambia de precio y se sincroniza a catálogo/QR/marketplace según reglas del canal.

- [ ] **H67 — BI/AI operativo y recomendaciones.**
  - [ ] Forecast de demanda, alertas de anomalías, productos muertos, margen bajo, quiebres probables, staff necesario y horarios pico.
  - [ ] Recomendaciones accionables: subir stock, cambiar precio, crear combo, revisar cajero, reponer insumo, contactar cliente inactivo.
  - [ ] Explicabilidad: cada recomendación muestra datos usados y confianza.
  - [ ] *Criterio:* el owner recibe "te vas a quedar sin café el viernes" con evidencia y orden de compra sugerida.

- [ ] **H68 — API pública, webhooks y app marketplace.**
  - [ ] API versionada con OAuth/API keys por tenant, scopes, rate limits, logs y rotación de credenciales.
  - [ ] Webhooks para venta, pago, stock, cliente, turno, factura, comanda, notificación y cambio de plan.
  - [ ] Marketplace de apps: integración aprobada, permisos visibles, instalación/desinstalación y health por app.
  - [ ] *Criterio:* un partner recibe webhook de venta, consulta detalle por API y queda auditado por tenant.

### F15 — Escuela NinjaSoft + onboarding guiado configurable

Objetivo: que cada cliente aprenda el sistema sin depender de soporte: escuela interna, recorridos guiados, checklist por rubro, ayuda contextual y configuración desde internal para cambiar qué se enseña, cuándo y a quién. Ver [`28-school-onboarding.md`](./28-school-onboarding.md).

- [ ] **H69 — Escuela NinjaSoft por módulos.**
  - [ ] Biblioteca de cursos: primeros pasos, POS, caja, productos, clientes, reportes, hardware, AFIP, retail, servicios, gastronomía, internal para staff.
  - [ ] Cada lección tiene objetivo, pasos, capturas/video, demo interactiva, errores comunes, checklist y prueba corta.
  - [ ] Progreso por usuario, rol, tenant y rubro.
  - [ ] *Criterio:* un cajero completa "Cobrar una venta" y queda certificado para operar POS básico.

- [ ] **H70 — Tours y recorridos guiados configurables.**
  - [ ] Internal define tours por plan, rubro, rol, feature flag, país, estado del tenant y evento disparador.
  - [ ] Pasos con ancla en UI, tooltip, modal, spotlight, tarea, bloqueo opcional o "hacer ahora".
  - [ ] Versionado de tours, draft/publicado, A/B test y métricas de finalización.
  - [ ] *Criterio:* al registrar una heladería, el sistema guía por productos favoritos, sabores, medios de pago y primer cobro.

- [ ] **H71 — Checklist de activación y health de adopción.**
  - [ ] Checklist dinámico por rubro: cargar productos, abrir caja, configurar ticket, invitar cajero, medio de pago, prueba de impresión, AFIP cuando aplique.
  - [ ] Score de activación: setup, primera venta, uso de caja, usuarios activos, configuración crítica completa, soporte pendiente.
  - [ ] Internal ve cuentas trabadas y puede disparar ayuda específica.
  - [ ] *Criterio:* sales/support identifica tenants que no llegaron a primera venta y lanza recorrido correctivo.

- [ ] **H72 — Ayuda contextual y base de conocimiento.**
  - [ ] Panel de ayuda dentro de cada pantalla con artículos filtrados por módulo, rol y acción actual.
  - [ ] Buscador, etiquetas, contenido relacionado, feedback útil/no útil y sugerencia de artículo desde soporte.
  - [ ] Modo "mostrarme con mis datos" usando demo segura o datos anonimizados.
  - [ ] *Criterio:* desde `/pos`, un cajero busca "anular venta" y ve guía exacta para su rol.

- [ ] **H73 — Laboratorio/demo segura.**
  - [ ] Sandbox por tenant con datos de ejemplo para practicar sin afectar caja/stock/facturación real.
  - [ ] Reset de demo, escenarios por rubro y ejercicios guiados.
  - [ ] Separación visual fuerte entre demo y producción.
  - [ ] *Criterio:* un owner practica una devolución y una comanda sin generar movimientos reales.

- [ ] **H74 — Configuración internal de sugerencias, nudges y comunicaciones de onboarding.**
  - [ ] Internal crea sugerencias por evento: registro, primer login, sin productos, sin caja abierta, venta fallida, hardware no probado, trial por vencer.
  - [ ] Audiencia, prioridad, frecuencia, cooldown, expiración, canal, CTA y fallback a soporte.
  - [ ] No molestar: límite de mensajes por sesión/día y preferencias por tenant.
  - [ ] *Criterio:* operaciones cambia el recorrido inicial de restaurantes sin deploy y mide conversión a primera venta.

- [ ] **H75 — Certificaciones, soporte asistido y analítica de aprendizaje.**
  - [ ] Certificados por rol: cajero, manager, gastronómico, retail avanzado, AFIP, soporte interno.
  - [ ] Métricas: lecciones vistas, tours completados, pasos abandonados, tickets reducidos, tiempo a primera venta.
  - [ ] Sugerencias automáticas de capacitación según errores reales del tenant.
  - [ ] *Criterio:* internal ve que un tenant falla en cierres de caja y le recomienda curso + tour de arqueo.

### F16 — Comercio unificado tipo Napse/TOTVS

Objetivo: tomar como benchmark las capacidades de Napse/TOTVS (Bridge, Omni, VTOL, Fiscal Flow y Promo) y llevar NinjaSoft a una capa de **comercio unificado** para cadenas, franquicias y retailers que necesitan operar tienda física, e-commerce, marketplaces, pagos, fiscal, promociones, fidelización y devoluciones desde un solo cockpit. Ver [`29-napse-unified-commerce-benchmark.md`](./29-napse-unified-commerce-benchmark.md).

- [ ] **H76 — Unified Commerce Cockpit.**
  - [ ] Cockpit central de ventas, inventario, pedidos, pagos, fiscal, devoluciones, promociones y fidelización por canal/sucursal/marca.
  - [ ] Vista 360 de operación en tiempo real: tiendas físicas, catálogo público, e-commerce, marketplace, QR, WhatsApp y delivery.
  - [ ] Alertas operativas con SLA: pedido demorado, stock roto, pago sin conciliar, factura bloqueada, devolución pendiente, terminal caída.
  - [ ] *Criterio:* un gerente ve en una sola pantalla qué canal vende, qué pedidos faltan surtir, qué pagos fallaron y qué stock está comprometido.

- [ ] **H77 — Jornadas omnicanal avanzadas.**
  - [ ] Stock Lookup / Endless Aisle: vender desde una tienda usando stock de otra sucursal o depósito.
  - [ ] Click & Collect: compra online, retiro en tienda, reserva de stock, preparación y entrega con identidad validada.
  - [ ] Ship from Store: venta online o de tienda con envío desde sucursal óptima.
  - [ ] Reserve Online, Try/Pay in Store: reserva online, prueba en tienda y conversión a venta.
  - [ ] Devoluciones y cambios cross-channel: comprar online y devolver/cambiar en tienda con stock y fiscal consistentes.
  - [ ] *Criterio:* un cliente compra online, retira en sucursal, cambia un producto en otra sucursal y todo queda conciliado.

- [ ] **H78 — OMS y surtido multi-origen.**
  - [ ] Order Management System liviano: pedidos, reservas, picking, packing, despacho, entrega, cancelación y reembolso.
  - [ ] Asignación de origen por reglas: cercanía, stock, margen, SLA, capacidad, horario y costo de envío.
  - [ ] Picking por app/PWA, sustituciones autorizadas, faltantes, preparación parcial y split fulfillment.
  - [ ] *Criterio:* un pedido con 3 ítems se divide entre depósito central y sucursal sin perder trazabilidad.

- [ ] **H79 — Fiscal Hub multi-canal y multi-país.**
  - [ ] Abstracción fiscal por país/provincia/canal: AFIP/ARCA Argentina primero, arquitectura preparada para otros países.
  - [ ] Ciclo completo de comprobante: emitir, almacenar XML/PDF, enviar al cliente, reimprimir, anular, nota de crédito/débito y auditar.
  - [ ] Contingencia autónoma por tienda/caja con cola fiscal, alertas 24/7, reintento, bloqueo preventivo y tablero fiscal.
  - [ ] Diseñador PDF fiscal/no fiscal con mensajes, promociones y anexos permitidos.
  - [ ] *Criterio:* una cadena opera ventas físicas y online con comprobantes centralizados, contingencia y trazabilidad por país/canal.

- [ ] **H80 — Promo & Loyalty omnicanal enterprise.**
  - [ ] Campañas omnicanal: POS, catálogo, e-commerce, WhatsApp, QR, marketplace y app futura.
  - [ ] Simulador de campañas, coexistencia, exclusividad, conflictos, presupuesto, forecast de impacto y ticket promedio esperado.
  - [ ] Fidelización avanzada: puntos, niveles, cupones, vales, gift cards, monedero, cashback, cliente frecuente y beneficios por comportamiento.
  - [ ] Automatizaciones por evento: primera compra, cumpleaños, abandono, recompra, cliente inactivo, devolución, ticket alto.
  - [ ] *Criterio:* una campaña se simula, se publica en todos los canales y mide uso, margen, ticket promedio y recurrencia.

- [ ] **H81 — Clienteling y venta asistida móvil.**
  - [ ] POS móvil para vendedor: buscar cliente, ver historial, preferencias, talles, garantías, deuda, puntos y recomendaciones.
  - [ ] Venta asistida desde celular/tablet con QR de pago, stock de otra tienda, cross-selling/up-selling y envío a domicilio.
  - [ ] Lista de deseos, carrito persistente omnicanal y recuperación de venta iniciada en otro canal.
  - [ ] *Criterio:* un vendedor atiende en salón desde celular, cobra con QR y evita que el cliente pase por caja.

- [ ] **H82 — Prevención de fraude y riesgo operativo.**
  - [ ] Detección de operaciones sospechosas: anulaciones repetidas, descuentos excesivos, devoluciones anómalas, pagos fallidos, caja fuera de patrón.
  - [ ] Reglas de bloqueo, revisión manual, aprobación por supervisor y scoring de riesgo.
  - [ ] Señales de fraude omnicanal: abuso de cupones, cambios cross-channel, múltiples cuentas, chargebacks, vale/gift card sospechosa.
  - [ ] *Criterio:* una devolución de alto riesgo pide aprobación y queda marcada para auditoría.

- [ ] **H83 — Operación de cadenas, marcas y franquicias.**
  - [ ] Multi-marca/multi-negocio dentro de un grupo empresarial.
  - [ ] Franquicias: configuración central con overrides locales, catálogo central, precios sugeridos/obligatorios y reportes por franquiciado.
  - [ ] Consolidación regional: país, moneda, impuestos, canales, depósitos, roles y permisos por unidad de negocio.
  - [ ] *Criterio:* una franquicia recibe catálogo/precios desde central, opera localmente y reporta ventas consolidadas.

- [ ] **H84 — Marketplace y e-commerce integration hub.**
  - [ ] Conectores configurables para Tienda Nube, Mercado Libre, Shopify/WooCommerce futuro, PedidosYa/Rappi futuro y ERP externo.
  - [ ] Mapeo de catálogo, categorías, variantes, modifiers, impuestos, estados y medios por canal.
  - [ ] Sincronización con colas, dead-letter, replay, comparación de divergencias y health por integración.
  - [ ] *Criterio:* si Mercado Libre queda desincronizado, el cockpit muestra divergencia y permite replay controlado.

- [ ] **H85 — Observabilidad enterprise de comercio unificado.**
  - [ ] Tableros de salud: pagos, fiscal, integraciones, stock, OMS, promociones, webhooks, hardware y offline.
  - [ ] Alarmas por SLA, error rate, latencia, backlog de colas, terminal caída, fiscal bloqueado o integración degradada.
  - [ ] Runbooks operativos para soporte: qué revisar, cómo reintentar, cómo escalar y cómo cerrar incidente.
  - [ ] *Criterio:* soporte detecta una caída de pagos, identifica proveedor/canal afectado y ejecuta runbook sin consultar SQL.

- [ ] **H86 — Benchmark Napse parity y demos enterprise.**
  - [ ] Matriz de paridad contra Napse Bridge/Omni/VTOL/Fiscal Flow/Promo, mantenida por producto.
  - [ ] Demos enterprise por vertical: supermercado, moda, farmacia, tienda departamental, franquicia, mayorista.
  - [ ] Dataset demo con miles de productos, múltiples sucursales, e-commerce, promociones, fidelización, devoluciones y pagos conciliados.
  - [ ] *Criterio:* ventas puede mostrar un flujo omnicanal completo tipo cadena retail sin preparar datos manualmente.

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

- [~] **TX-4 — Importaciones masivas XLSX como estándar (reemplaza CSV).** — *Productos y clientes hechos; depósitos/stock/listas dependen de F4/F11.*
  - [~] **Productos y clientes se importan SIEMPRE en XLSX**: **productos ✅** (`ImportProductsModal`) y **clientes ✅** (`ImportCustomersModal`). Resto (depósitos, stock, listas, medios, garantías, motivos) pendiente.
  - [x] **Descargar plantilla de muestra XLSX** (productos y clientes: hoja de datos + ejemplo + ayuda). *(Planes de pago también: plantilla por medio en el grid H27.)*
  - [x] **Exportar toda la base** en XLSX (productos y clientes, botón "Exportar XLSX" en cada página).
  - [ ] Toda importación: validación previa, preview, dry-run, confirmación, reporte de errores por fila y auditoría. Sin imports silenciosos.
  - [ ] Helper único de import (parse XLSX con `exceljs`) + reuso del `exportXlsx` (TX-2) para plantillas y export de base.
  - [ ] *Criterio:* el usuario baja la plantilla de productos, la completa, la importa con preview y errores por fila; y puede exportar toda su base de clientes/productos en XLSX.

- [~] **TX-5 — Reportes PRO configurables por usuario.** — *Base hecha (PR #46): mostrar/ocultar reportes persistido. Falta orden, más reportes y filtros guardables.*
  - [~] **Tablero de reportes configurable**: cada usuario **muestra/oculta** reportes con "Personalizar"; persistido en `users.settings.reports` (cross-device, merge sin pisar apariencia). **Orden (drag) pendiente.**
  - [~] **Catálogo de reportes ampliable**: día/medio/categoría/cajero + **top productos** + **stock bajo** + **top clientes** (PR #49). Faltan márgenes y comparativos por período.
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
| Multi-sucursal, multi-caja, transferencias de stock | F4 |
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
| Depósitos, stock multi-depósito y transferencias | F4 + **F11/H33** |
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

- [ ] **Registro/login con Google (OAuth)** *(agregado 2026-06-06)*: alta y acceso con cuenta de Google vía Supabase Auth (provider google). **Feature de plan de pago** (gateado por feature flag / plan). Incluye vincular cuenta existente por email y respetar el flujo de onboarding actual.
- [ ] **Inventario PRO avanzado fuera de F14:** WMS profundo, ubicaciones/bin picking, ondas de preparación, inventario por radiofrecuencia y terminales industriales.
- [ ] **Compras y proveedores avanzados fuera de F14:** EDI, portal de proveedor, licitaciones, conciliación automática de facturas de proveedor.
- [ ] **Devoluciones y cambios avanzados:** cubierto en F11/H29; queda en backlog solo integración posterior con nota de crédito fiscal automática si AFIP requiere ampliar flujo.
- [ ] **Cuenta corriente de clientes** (fiado) — base en F11/H31; gancha con F9/H55 (fidelización) y segmentos.
- [ ] **Cuenta corriente de proveedores.**
- [ ] **Reservas / turnos avanzados** multi-recurso o de capacidad compleja; base cubierta en F12/H38 y reservas gastronómicas en F13/H51.
- [ ] **Multimoneda avanzada:** cobertura multi-país, contabilidad bimonetaria y reglas fiscales por país; base comercial cubierta en F14/H59.
- [ ] App móvil nativa (React Native) para gerentes en movimiento.
- [ ] Offline industrial avanzado: sincronización multi-dispositivo con conflictos complejos y hardware local; base offline-first cubierta en F14/H65.
- [ ] Producción y recetas avanzadas / escandallo industrial; base gastronómica cubierta en F13/H50.
- [ ] E-commerce integrado (alternativa a Tienda Nube).
- [ ] Multi-país (Uruguay, Chile, México) — requiere abstraer facturación electrónica.

> *Nota:* **Fidelización (puntos/niveles), gift cards y cupones** se movieron del backlog a **F9 — Motor de promociones PRO** (H54–H55); packs de sesiones y membresías simples se cubren antes en F12/H41.

---

## Cómo se actualiza este roadmap

1. Al cerrar una fase, el PM actualiza el estado en la tabla principal y agrega un resumen de aprendizajes en [`17-decision-log.md`](./17-decision-log.md).
2. Cambios de prioridad mayor requieren PR con justificación.
3. Estimaciones de duración se ajustan según velocidad real medida en fases anteriores.

> **Principio.** El roadmap es un mapa, no una promesa. Lo que sí es promesa: cada fase termina con software que funciona, no con un avance del 80%.
