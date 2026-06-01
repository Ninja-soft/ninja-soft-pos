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
| **F2** | Plataforma SaaS (panel interno + suscripciones) | 4–6 semanas | 🟡 En progreso |
| **F3** | Integración AFIP y producción | 4–6 semanas | 🔴 No iniciado |
| **F4** | Escalado: multi-sucursal, hardware, integraciones | 8–10 semanas | 🟡 Planificación |
| **F5** | Perfiles por rubro y marketplace | 10–14 semanas | 🟡 Planificación |
| **F6** | Personalización del producto (fotos, branding, tickets, catálogo) | 6–8 semanas | 🟡 Planificación |
| **F7** | Panel interno PRO + comunicaciones (emails) | 5–7 semanas | 🟡 Planificación |
| **F8** | Pagos y cobros (arquitectura + pasarelas por etapas) | 6–10 semanas | 🟡 Planificación |
| **F9** | Motor de promociones PRO | 4–6 semanas | 🟡 Planificación |
| **F10** | Hardware y mostrador PRO (impresoras, scanners, doble pantalla) | 5–8 semanas | 🟡 Planificación |
| **F11** | Configuración retail avanzada (devoluciones, garantías, cuenta corriente, despacho) | 6–8 semanas | 🟡 Planificación |
| **F12** | Comercios simples y servicios (catálogo chico, agenda, cobro rápido) | 5–7 semanas | 🟡 Planificación |
| **F13** | Gastronomía PRO (mesas, comandas, cocina, delivery/takeaway) | 7–10 semanas | 🟡 Planificación |
| **F14** | Motor comercial enterprise (planes, cuotas, recargos, reglas, inventario PRO) | 8–12 semanas | 🟡 Planificación |
| **F15** | Escuela NinjaSoft + onboarding guiado configurable | 5–7 semanas | 🟡 Planificación |
| **F16** | Comercio unificado tipo Napse/TOTVS (Omni, VTOL, Fiscal Flow, Promo) | 10–14 semanas | 🟡 Planificación |
| **TX** | Mejoras transversales (UX y datos) — quick wins | continuo | 🟡 Planificación |

> **Orden de ejecución acordado (2026-05-30):** **TX (quick wins) → F6 → F7 → F8 → F10 → F11 → F12 → F13 → F9 → F14 → F15 → F16 → F3 (AFIP)**. Las **mejoras transversales (TX)** — calendario unificado con react-day-picker y export XLSX — se hacen primero por ser pedidos explícitos y de bajo costo, y luego se aplican de forma continua. Ver [§ Plan ampliado](#plan-ampliado-2026-05-30), [§ Mejoras transversales](#tx--mejoras-transversales-ux-y-datos) y los cortes de control obligatorios al cierre de cada hito.

---

## F0 — Fundación técnica

**Duración:** 2 semanas. **Objetivo:** dejar el proyecto listo para que cualquier agente o persona pueda contribuir sin pedir contexto.

### Entregables
- [ ] Repositorio en GitHub con estructura definitiva.
- [ ] CI/CD: GitHub Actions corriendo lint, typecheck, tests, build.
- [ ] Vercel conectado: production en `main`, previews por rama.
- [ ] Supabase: proyecto local + staging + production, con migraciones versionadas.
- [ ] Documentación viva (`docs/`, `CLAUDE.md`, agentes en `.claude/agents/`).
- [ ] Sistema de diseño base: tokens, primitives (Button, Input, Card, etc.).
- [ ] Auth funcional con Supabase + selección de tenant.

### Criterios de cierre
- [ ] Un dev nuevo puede clonar, instalar y levantar el proyecto en < 30 min siguiendo `00-getting-started.md`.
- [ ] El PM puede invocar a cualquier agente y este encuentra su archivo en `.claude/agents/`.
- [ ] `pnpm test` pasa con al menos un test por capa (component, hook, edge function).

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
- [ ] `pnpm build` estable y reproducible en local/CI.
- [ ] Scripts documentados y alineados con `package.json`.
- [ ] Suite de aislamiento multi-tenant con dos tenants y datos cruzados conocidos.
- [ ] Tests de RLS para tablas críticas: productos, ventas, caja, clientes, audit logs.
- [ ] Tests de permisos por rol: owner, manager, cashier, viewer.
- [ ] Smoke E2E mínimo: login → abrir caja → vender → ticket → anular → cerrar caja → reporte.
- [ ] Idempotencia documentada para venta/anulación antes de integrar pagos externos.
- [ ] Health endpoint básico (`/api/health`) y checklist de monitoreo manual.
- [ ] Backup/restore de Supabase probado en staging o entorno descartable.
- [ ] Seed/demo reproducible para ventas, productos, clientes y caja.

### Criterios de cierre
- [ ] El gate automático pasa completo: lint, typecheck, test y build.
- [ ] Dos tenants operan en paralelo sin fuga de datos validada por test.
- [ ] Una demo de piloto corre de punta a punta sin tocar SQL manualmente.

---

## F2 — Plataforma SaaS

**Duración:** 4–6 semanas. **Objetivo:** NinjaSoft puede operar el SaaS sin tocar SQL: alta de clientes, cambios de plan, activación de features.

### Entregables
- [ ] **Panel interno** (rutas protegidas para staff NinjaSoft):
  - [ ] Listado de tenants con filtros (estado, plan, última actividad).
  - [ ] Alta y baja de tenants.
  - [ ] Cambio de plan en caliente.
  - [ ] Activación / desactivación de feature flags por tenant.
  - [ ] Vista de auditoría administrativa.
- [ ] **Modelo de suscripciones** completo:
  - [ ] Estados: `trial`, `active`, `suspended`, `cancelled`.
  - [ ] Trial automático de 14 días al alta.
  - [ ] Suspensión por falta de pago (manual en esta fase).
- [ ] **Sistema de soporte interno:**
  - [ ] Notas internas por tenant.
  - [ ] Vista rápida de salud operativa (último login, ventas últimos 7 días, errores).

### Criterios de cierre
- [ ] NinjaSoft puede dar de alta un cliente nuevo en < 5 minutos sin tocar SQL.
- [ ] Cambiar un cliente de Start a Pro toma una sola acción y aplica de inmediato.
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
  - [ ] Mercado Libre (publicación y sincronización de stock).
  - [ ] Tienda Nube.
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

- [ ] **H9b — Editor visual de ticket (canvas) + envío por email.**
  - [ ] **Editor visual tipo canvas**: el dueño diseña su ticket/comprobante arrastrando bloques (logo, encabezado, datos del negocio, ítems, totales, QR, leyendas, redes, imagen, separadores). Muy personalizable, WYSIWYG.
  - [ ] Plantillas guardables por tenant y por tipo (ticket 58/80mm, comprobante A4, recibo). Preview en vivo con datos reales de una venta.
  - [ ] Render a imagen/PDF desde el diseño (canvas → PNG/PDF) para imprimir, descargar y adjuntar.
  - [ ] **Envío del comprobante por email al cliente** (usa el proveedor de H13: Resend) con el diseño elegido; registro de envío y reenvío.
  - [ ] Botón "Enviar por email" en el ticket de una venta (pide/usa el email del cliente).
  - [ ] *Criterio:* el dueño diseña su ticket en el editor visual, lo guarda, y al cobrar puede enviarlo por email al cliente con ese diseño.

- [~] **H10 — Catálogo público + variantes.** — *Catálogo público base hecho (PR #32); variantes y listas por canal pendientes.*
  - [x] Catálogo web público por tenant en `/c/<slug>` (RPC `public_catalog` SECURITY DEFINER, anónimo; solo tenants activos y productos activos). Muestra logo/branding, fotos, precios y categorías.
  - [ ] Variantes por rubro (talle/color para textil; SKU compuesto).
  - [ ] Listas de precios por canal (mostrador / catálogo / mayorista).
  - [ ] Carrito/pedido desde el catálogo (cruza con F12/F13 y delivery).
  - [x] *Criterio (base):* un tenant con productos activos publica su catálogo en `/c/<slug>` sin tocar código.
  - *Nota:* el motor de promociones se trata aparte y a fondo en **[F9 — Motor de promociones PRO](#f9--motor-de-promociones-pro)**.

- [ ] **H10b — Catálogo PRO: ficha de producto completa, marcas y categorías.**
  - [ ] **Form de alta/edición de producto rico** (mejor que la competencia: una sola pantalla, todo opcional, defaults inteligentes): nombre, **EAN/código de barras**, **SKU interno** (auto-generado al guardar si no se carga, con prefijo configurable — gancha con H30), precio de venta, costo, **categoría**, **marca**, **IVA %**, **unidad de medida**.
  - [ ] **Subida de fotos opcional con conversión a WebP** en el propio alta (no solo en edición): arrastrar/elegir imagen → WebP liviano client-side → galería; también admite **URL de imagen**. (Reusa H7.)
  - [ ] **Datos adicionales plegables:** descripción larga (para ticket/catálogo), **tags** (lista separada por coma, para filtros y promos), **temporada** (ej. "Verano 2026"), **garantía de fábrica en meses** (gancha con H28: imprime en ticket y habilita garantía extendida).
  - [ ] **Categorías con 2 niveles** (rubro → sub-rubro, ej. Indumentaria → Calzado): alta/edición/orden, máximo 2 niveles, asignables al producto. *(La tabla `categories` ya soporta `parent_id`.)*
  - [ ] **Catálogo de marcas** por tenant: alta/edición, asignación a productos y uso como **condición de promociones por marca** (gancha con F9/H54).
  - [ ] **Controla stock (toggle por producto):** si está apagado, el producto **no descuenta stock** al venderse (ej. servicios). Default según rubro.
  - [ ] **Permite venta en cero/negativo (override por producto)** del setting global (gancha con H30).
  - [ ] **Producto serializado (IMEI/N° de serie):** cada unidad tiene serie única; al vender, el cajero elige el serial que sale. Útil para celulares, notebooks, electro. *(Base avanzada en F14/H64; acá queda el flag y el flujo básico de captura/selección.)*
  - [ ] **Kit / combo (BOM de retail):** un kit no tiene stock propio; al venderse descuenta el stock de sus **componentes** según cantidades configuradas. *(Distinto del combo de precio de F9/H54 y de las recetas gastronómicas de F13/H50.)*
  - [ ] **Stock inicial por depósito** desde el alta (gancha con F11/H33) y **variantes talle/color** (gancha con F6/H10) cuando el producto las tenga.
  - [ ] *Criterio:* el dueño crea un producto con marca, IVA, foto WebP, tags y garantía en una sola pantalla; arma una categoría de 2 niveles; marca un servicio como "no controla stock"; define un kit que descuenta sus componentes; y un electro como serializado que pide el N° de serie al vender.

### F7 — Panel interno PRO + comunicaciones

Objetivo: que NinjaSoft opere el SaaS completo sin SQL, con control fino de usuarios, planes y comunicaciones.

- [x] **H11 — Roles de staff NinjaSoft + gestión total de usuarios.** — *Hecho (PR #33 backend + PR #40 UI). Página `/internal/staff`: listar, agregar por email, cambiar nivel y quitar. Bootstrap del primer super_admin desde la propia página.*
  - [x] Tres niveles de staff: **super-admin**, **admin**, **soporte**.
    - *super-admin:* todo (sumar/quitar staff, borrar tenants, facturación, acciones peligrosas).
    - *admin:* gestión de tenants/usuarios/soporte; sin tocar staff ni acciones destructivas.
    - *soporte:* solo-lectura + acciones limitadas (notas, ver salud, reset de contraseña).
  - [ ] Gestión total de usuarios (staff): ver todos, **pausar/suspender/reactivar**, cambiar roles, **sumar poderes**, y **sumar usuarios como staff NinjaSoft** (con su nivel).
  - [ ] Toda acción crítica en `audit_logs`; matriz de permisos versionada en [`06-permissions-roles.md`](./06-permissions-roles.md).
  - [ ] *Criterio:* un super-admin suma a otra persona como admin de NinjaSoft en una acción; un admin no puede tocar staff.

- [ ] **H11c — Consola internal completa + login independiente.**
  - [x] Entrar directo a `/internal` redirige a `/internal/tenants`; si no hay sesión, login conserva destino interno (`/login?next=/internal/tenants`).
  - [ ] Pantalla de acceso interno con copy y layout diferenciado de POS/tenant.
  - [ ] Dashboard internal con KPIs SaaS: MRR, ARR, trials, activos, past_due, suspendidos, churn, conversión trial→paid, tickets de soporte y alertas.
  - [ ] Buscador global por tenant, CUIT, email owner, teléfono, slug, plan, estado, feature flag y fecha de alta.
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

- [ ] **H12 — Suscripciones, billing manual y lifecycle comercial.**
  - [ ] Upgrade/downgrade de plan, cambio de estado (`trial`/`active`/`past_due`/`suspended`/`cancelled`), fechas de período.
  - [ ] Aumentar/limitar módulos y feature flags por tenant desde una sola consola.
  - [ ] **Plan específico por cliente:** clonar un plan base, cambiar nombre comercial, límites, módulos, soporte, precio y condiciones sin afectar a otros tenants.
  - [ ] **Overrides de cuota/límites por cliente:** usuarios, sucursales, cajas, productos, ventas mensuales, almacenamiento, módulos, soporte y límites fiscales.
  - [ ] **Aumento de cuota/precio a un cliente:** cambio inmediato o programado con fecha efectiva, motivo, aviso previo, aceptación opcional y registro de antes/después.
  - [ ] Trial configurable: extender trial, acortarlo, convertir a paid, marcar como perdido, registrar motivo.
  - [ ] Billing manual: registrar pago, medio, período cubierto, comprobante/recibo interno, deuda y próxima fecha de vencimiento.
  - [ ] Descuentos comerciales, precio acordado, cupones/manual override y notas internas con vigencia.
  - [ ] Historial de cambios de plan/estado/precio con antes/después, autor, fecha, motivo y fuente.
  - [ ] Automatizaciones futuras: avisos de vencimiento, suspensión, reactivación y webhooks de pago.
  - [ ] *Criterio:* pasar un tenant de Start trial a un plan custom "Pro Heladería Lucas" activo con vencimiento, pago registrado, cuota aumentada, módulos activados y notificación pendiente queda auditado de punta a punta.

- [~] **H13 — Emails del sistema (NinjaSoft, en `/internal/emails`).** — *Editor + remitente + envío Resend hechos (PR #51). Falta cargar el secret `RESEND_API_KEY`.*
  - [x] **Emails del sistema son GLOBALES y se editan en `/internal/emails`** (no en el POS del cliente). Tablas `system_email_templates` + `system_email_config` (RLS solo `is_internal`). Override de defaults de `lib/email/templates.ts`.
  - [x] **Editor HTML + variables + preview en vivo**; catálogo: bienvenida, invitación, reset, trial por vencer, pago vencido, suspensión.
  - [x] **Remitente configurable** (nombre + email de dominio verificado) en `/internal/emails`.
  - [x] **Envío real por SMTP propio** (denomailer, sin secrets de backend): el remitente y el servidor SMTP se configuran desde `/internal/emails` (host/puerto/usuario/clave/secure/from). Edge Functions `set_email_smtp` (guarda) y `send_email` (envía, guard `is_internal`); clave en `system_email_smtp` (RLS solo service_role), lectura sin clave vía `get_email_smtp()`. Botón "Enviar prueba".
  - [x] **Log de envío** en `audit_logs` (acción `email_sent`).
  - [ ] **Brevo** + **envíos masivos** y reintentos (siguiente etapa).
  - [ ] **POS del cliente:** los tenants suman **sus propios proveedores** para **campañas masivas** a sus clientes (en `/configuracion` del tenant) — *fase aparte (no son los emails del sistema).*
  - [x] *Criterio:* en `/internal/emails` se edita una plantilla, se previsualiza con variables y se envía una prueba (una vez cargado `RESEND_API_KEY`).

- [ ] **H13b — Centro de notificaciones por cuenta.**
  - [ ] Panel de notificaciones dentro de cada tenant: novedades, cambios de plan, vencimientos, pagos, alertas de uso, seguridad, AFIP, mantenimiento y soporte.
  - [ ] Notificaciones dirigidas por audiencia: owner, manager, cashier, viewer, todos, sucursal específica o usuario específico.
  - [ ] Estados: no leída, leída, archivada, requiere acción, vencida.
  - [ ] Severidad: info, éxito, advertencia, crítica, bloqueo.
  - [ ] Acciones embebidas: pagar, actualizar datos, aceptar cambio de plan, descargar comprobante, ver deuda, renovar, contactar soporte.
  - [ ] Preferencias por canal: in-app obligatorio para eventos críticos; email/WhatsApp/push futuro configurables por tipo.
  - [ ] Composer internal para enviar novedades globales o por segmento de clientes.
  - [ ] *Criterio:* al aumentar cuota/precio de un tenant, el owner ve una notificación in-app con fecha efectiva, motivo, nuevo monto, historial y acción de aceptación/consulta.

### F8 — Pagos y cobros

Objetivo: cobrar por cualquier medio, con arquitectura extensible. **Arquitectura primero, integraciones por etapas** (un sub-hito por proveedor).

- [~] **H14 — Arquitectura de pagos (base).** — *Base hecha (PR #41): catálogo + config por tenant + secretos. Falta wiring en el POS.*
  - [x] Registro de **proveedores de pago** (`payment_providers`, catálogo global seedeado con los 10 medios) y config por tenant.
  - [x] Habilitación y **configuración por tenant** (`tenant_payment_methods`: enabled, recargo %, sandbox; RLS owner/manager). **Secretos** en `payment_secrets` (RLS deny: solo service_role/Edge Functions). UI `PaymentMethodsCard` en `/dashboard-team`.
  - [ ] **UI de cobro abstracta** en el POS que lea los medios habilitados + aplique recargo; **pago mixto** ya existe en el POS, falta integrarlo con esta config.
  - [x] Medios manuales reales: **Efectivo**, **Transferencia** (en catálogo; el POS ya cobra efectivo/transferencia/mixto).
  - [ ] *Criterio:* el POS muestra solo los medios habilitados por el tenant y aplica el recargo configurado.

- [~] **H15+ — Integraciones por proveedor** (un sub-hito cada uno, cableado incremental sobre la arquitectura de H14):
  - [~] **H15** — Mercado Pago. **Conexión por Access Token + QR de cobro (Checkout Pro) + OAuth "Conectar con MP" hechos**: Edge Functions `set_payment_secret`, `mp_create_qr`, `mp_webhook`, `mp_oauth_start`, `mp_oauth_callback` (`state` anti-CSRF, refresh de token); botón "Conectar con Mercado Pago" (un click) y "Cobrar con QR" en el POS; tabla `mp_payment_intents`. **Billing de suscripciones**: credenciales de plataforma en `platform_secrets` editables desde `/internal/pagos` (`set_platform_secret`), `mp_subscription_checkout` (preapproval) + `mp_billing_webhook`; "Generar link de cobro" en el detalle del tenant. **Falta:** Mercado **Point** (tarjeta presencial) y conciliación.
  - [ ] **H16** — **MODO** vía QR interoperable.
  - [ ] **H17** — **Payway / Prisma**.
  - [ ] **H18** — **Getnet**.
  - [ ] **H19** — **Fiserv / Posnet / Clover**.
  - [ ] **H20** — **Mobbex** como **orquestador** (abstrae varios proveedores; opcional según convenga).
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

- [ ] **H22 — Configuración avanzada de impresión.**
  - [ ] Perfiles de impresión por **tenant / sucursal / caja**: ticket 58mm, ticket 80mm, A4, etiqueta, cocina/comanda, comprobante interno.
  - [ ] Selector de destino por tipo de documento: ticket de venta, cierre Z, movimiento de caja, etiqueta de producto, comanda, devolución, nota de crédito futura.
  - [ ] Plantillas con variables: logo, datos fiscales, QR, leyendas legales, redes, promociones, cajero, caja, sucursal, medios de pago.
  - [ ] Márgenes, tamaño de fuente, densidad, cantidad de copias, corte de papel, apertura de cajón, impresión automática o manual.
  - [ ] Web print nativo: `window.print()` para navegador, A4 y fallback universal.
  - [ ] ESC/POS por conector local: app/servicio local para térmicas USB/LAN/Bluetooth cuando el browser no alcanza.
  - [ ] QZ Tray / WebUSB / WebSerial evaluados por compatibilidad.
  - [ ] Cola de impresión con reintentos: pendiente, impreso, fallido, reimprimir, cancelar.
  - [ ] *Criterio:* un tenant configura ticket 80mm para caja principal, etiqueta 58mm para productos y cierre Z A4; cada documento sale por su destino correcto.

- [~] **H23 — Scanners y captura de códigos PRO.** — *Base hecha (PR #80): lector USB/BT (HID) + cámara + producto por código. Perfiles/diagnóstico pendientes.*
  - [x] Soporte para lector USB HID tipo teclado y Bluetooth (`useScanner`: captura global de teclado por velocidad de tipeo + Enter, sin foco previo), cámara (`BarcodeDetector`) y entrada manual (búsqueda).
  - [ ] Perfiles de scanner por caja: prefijo/sufijo, Enter automático, delay entre caracteres, normalización de EAN/UPC/Code128/QR.
  - [~] Modo continuo en POS: lectura sin tocar mouse (escaneo en cualquier parte agrega al carrito). Falta beep/feedback y anti-duplicado fino.
  - [x] Producto por SKU/barcode (`productsApi.findByCode`).
  - [ ] QR de pago.
  - [ ] QR de cliente/fidelización.
  - [ ] Etiquetas internas de balanza/precio-peso.
  - [ ] Diagnóstico de scanner: pantalla de prueba que muestra caracteres recibidos, tiempos y formato detectado.
  - [ ] *Criterio:* un lector USB escanea 100 productos seguidos sin perder foco ni duplicar lecturas; un móvil usa cámara como fallback.

- [~] **H24 — Etiquetas, códigos y balanzas.** — *Generador + impresión por lote hechos (PR #79). Balanza (parsing/WebSerial) pendiente.*
  - [x] Generador de etiquetas de producto con nombre, precio y código de barras (Code 39 sin dependencias, SVG). Variantes pendientes (cruza con F6/H10).
  - [x] Impresión por lote: selección de productos + cantidad de copias por producto, vista previa y `window.print()` (página `/etiquetas`, hoja `ticket-print`). Hasta 200 copias por producto.
  - [ ] Soporte para etiquetas de balanza: parsing configurable de código con precio o peso embebido.
  - [ ] WebSerial para balanzas compatibles cuando aplique; fallback por código de barra de balanza.
  - [x] *Criterio (impresión):* el negocio selecciona productos e imprime un lote de etiquetas con nombre/precio/código sin tocar código. *(Balanza queda pendiente.)*

- [ ] **H25 — Doble pantalla / display cliente.**
  - [ ] Ventana secundaria del navegador: el cajero abre una pantalla cliente en otro monitor (`/customer-display`), sincronizada por BroadcastChannel/local storage o Realtime.
  - [ ] Display cliente dedicado: tablet/celular en la misma caja mostrando carrito, total, promociones y QR de pago.
  - [ ] Modo hardware futuro: integración con display serial/USB de dos líneas para importes básicos.
  - [ ] Nombre del negocio y caja en pantalla cliente.
  - [ ] Ítems del carrito en vivo.
  - [ ] Subtotal, descuentos, total y vuelto.
  - [ ] QR de Mercado Pago/MODO cuando aplique.
  - [ ] Mensaje final: “Pago recibido”, “Gracias”, promoción o invitación a fidelización.
  - [ ] Configuración por tenant: tema, logo, mostrar/ocultar precios unitarios, banners, idle screen, idioma.
  - [ ] Seguridad: nunca mostrar datos sensibles del cajero, panel interno, tokens ni información privada de otros clientes.
  - [ ] Limitación técnica documentada: el navegador no puede controlar monitores como una app nativa; el flujo robusto es abrir una URL de display cliente y mantenerla sincronizada.
  - [ ] *Criterio:* el cajero cobra en el POS y el segundo monitor/tablet muestra carrito, QR y total en tiempo real sin recargar.

- [ ] **H26 — Centro de diagnóstico de hardware.**
  - [ ] Pantalla `/configuracion/hardware` con estado de impresoras, scanners, pantalla cliente, cajón y balanza.
  - [ ] Pruebas guiadas: imprimir ticket de prueba, abrir cajón, probar scanner, probar display cliente, probar balanza.
  - [ ] Logs locales de hardware y errores legibles para soporte.
  - [ ] Export de diagnóstico para NinjaSoft.
  - [ ] *Criterio:* soporte puede pedir “Exportar diagnóstico” y ver qué periférico falla sin conectarse a la máquina del cliente.

### F3 — AFIP (robustecida, se ejecuta al final de esta tanda)

Alcance robustecido: ver [F3](#f3--integración-afip-y-producción) y [`15-afip-integration.md`](./15-afip-integration.md). Se prioriza **después** de F6–F8/F10/F11/F12/F13 (requiere certificados por tenant, homologación, tickets/comprobantes configurables, medios de pago y flujos de devolución/cambio/servicios/gastronomía definidos).

---

### F11 — Configuración retail avanzada

Objetivo: cubrir configuraciones de retail profesional inspiradas en POS líderes: formas de pago con recargos, garantías extendidas, devoluciones/cambios, cuenta corriente, pedidos de salón, despacho, depósitos, roles propios e importación masiva por Excel.

- [ ] **H27 — Medios de pago configurables + recargos.**
  - [ ] Alta de medios de pago visibles al cobrar: efectivo, transferencia, débito, crédito, QR, cuenta corriente, otros.
  - [ ] Variantes por medio con recargo/descuento automático: ejemplo "Visa 3 cuotas +8%".
  - [ ] Planes de financiación AR por tarjeta/marca/cuotas con vigencia.
  - [ ] Recargo agregado al total del ticket y registrado separado del subtotal.
  - [ ] Configuración de voucher obligatorio para tarjeta: lote, cupón, autorización.
  - [ ] *Criterio:* el cajero elige "Visa 3 cuotas +8%" y el ticket suma el recargo automáticamente.

- [ ] **H28 — Garantías extendidas.**
  - [ ] Campo "garantía de fábrica" por producto.
  - [ ] Planes de garantía extendida por tenant/categoría/producto: meses adicionales, prima (% del precio) y comisión del vendedor.
  - [ ] Oferta contextual al cobrar productos con garantía declarada.
  - [ ] Prima agregada al ticket como línea/servicio asociado.
  - [ ] Reporte de garantías vendidas y comisiones.
  - [ ] *Criterio:* al cobrar un producto con garantía de fábrica, el POS ofrece planes aplicables y registra prima/comisión.

- [~] **H29 — Devoluciones, cambios y vales.** — *Devolución parcial hecha (RPC `return_sale` + `ReturnModal` en /ventas): tablas `sale_returns`/`sale_return_items`, `sale_items.returned_qty` anti doble-devolución, reintegro por efectivo (sale de caja) o vale (`store_credit_movements`). Faltan: redención del vale en el POS, vigencia del vale, catálogo de motivos y "diferencia a cobrar" (cambio).*
  - [x] Política de devolución: el cajero elige caso a caso reintegro en efectivo o vale.
  - [ ] Vigencia configurable del vale/saldo a favor.
  - [~] Motivos: por ahora texto libre (catálogo configurable pendiente).
  - [x] Destinos de stock por línea: vuelve a stock / a revisión / descarte (revisión y descarte no reponen).
  - [~] Wizard de devolución con trazabilidad y reintegro por efectivo o vale. Cambio con diferencia a cobrar y redención del vale en el POS quedan pendientes.
  - [x] **Búsqueda de venta en el histórico** (/ventas): por N° de comprobante / ticket (formato personalizado o correlativo).
  - [x] **Sección dedicada de Devoluciones** (`/devoluciones`): buscar la venta por **ticket / N° de comprobante** y arrancar la devolución desde ahí (reusa ReturnModal).
  - [x] **Redención del vale en el POS**: medio de pago "Vale (saldo a favor)" cuando el cliente tiene saldo que cubre el total; `create_sale` valida saldo y descuenta de `store_credit_movements`.
  - [~] *Criterio:* devolución parcial con destino de stock por línea, auditada; sección de devoluciones con búsqueda, redención del vale y cambio con diferencia pendientes.

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

- [ ] **H30b — Cierres Z inmutables e historial contable de caja.**
  - [ ] Al cerrar una caja se genera un **Cierre Z**: cierre **contable diario del turno**, registro **inmutable** (no editable ni borrable) con su **snapshot consolidado** del turno.
  - [ ] Snapshot del Z: número correlativo de Z por sucursal/caja, apertura/cierre, cajero, ventas (cantidad y total), **desglose por medio de pago**, ingresos/egresos de caja, descuentos, anulaciones, monto esperado vs. contado, **diferencia**, e items vendidos resumidos.
  - [ ] **Historial de Cierres Z** (pantalla dedicada en Caja): lista filtrable por fecha/sucursal/caja/cajero; cada Z se puede ver, **reimprimir** (ticket/A4, gancha con F10/H22) y exportar XLSX (TX-2). Nunca se edita.
  - [ ] Integridad: el Z queda enlazado a sus ventas/movimientos; cualquier ajuste posterior va por contramovimiento auditado, no por edición del Z.
  - [ ] *Criterio:* al cerrar caja aparece su Z en el historial con el consolidado del turno; se puede reimprimir y exportar, pero no modificar.

- [ ] **H31 — Cuenta corriente y grupos de clientes.**
  - [ ] **Historial del cliente**: ficha con sus compras, devoluciones, saldo a favor (vale), deuda de cuenta corriente y totales. Accesible desde Clientes y desde el selector de cliente del POS.
  - [ ] Medio de pago "Cuenta corriente" que deja deuda del cliente.
  - [ ] Límite default de deuda por cliente y override por ficha.
  - [ ] Plazo default de pago y buckets de antigüedad en cuentas por cobrar.
  - [ ] Grupos de clientes para precios, promociones, riesgo, mayorista/VIP.
  - [ ] Reglas de datos obligatorios del cliente: documento, IVA, teléfono, email, domicilio, nacimiento.
  - [ ] *Criterio:* una venta fiada genera deuda con vencimiento y aparece en cuentas por cobrar.

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

- [~] **H34 — Importación masiva por Excel.** — *Productos y clientes hechos (parsers `exceljs`, plantilla descargable, preview con errores, import por lote en `/productos` y `/clientes`). Faltan depósitos/stock/listas (dependen de F4) y auditoría/reversión.*
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

- [ ] **H35 — Onboarding por rubro de catálogo chico.**
  - [ ] Wizard inicial con pregunta operativa: "vendo productos", "vendo servicios", "vendo ambos".
  - [ ] Presets de rubro: heladería, cafetería/take away, panadería simple, peluquería/barbería, estética/uñas/spa, lavadero, taller liviano, servicios profesionales.
  - [ ] Creación automática de categorías, botones rápidos, impuestos/ticket, medios de pago y roles mínimos.
  - [ ] Modo "sin stock" para servicios y comercios donde el inventario no importa al inicio.
  - [ ] *Criterio:* una heladería o peluquería queda lista para cobrar una primera venta en menos de 10 minutos, sin importar Excel ni tocar SQL.

- [ ] **H36 — POS rápido por botones / catálogo chico.**
  - [ ] Pantalla de cobro con grilla táctil de favoritos, categorías grandes y botones de alto contraste.
  - [ ] Productos/servicios sin búsqueda obligatoria: el cajero toca 2-3 botones y cobra.
  - [ ] Cantidades rápidas: `+1`, `+2`, `x6`, `x12`, medio kilo/kilo, sesión individual/pack.
  - [ ] Botón "Venta libre" con monto manual y motivo, controlado por permiso.
  - [ ] Cobro express: efectivo exacto, efectivo con vuelto, QR, tarjeta, transferencia.
  - [ ] *Criterio:* una venta típica de 3 ítems se carga y cobra en menos de 15 segundos en pantalla táctil.

- [ ] **H37 — Modificadores simples para heladería/cafetería.**
  - [ ] Tamaños: vasito, cucurucho, 1/4 kg, 1/2 kg, 1 kg, café chico/mediano/grande.
  - [ ] Sabores/toppings como modificadores, con límite configurable por tamaño.
  - [ ] Modificadores obligatorios/opcionales y ordenados para que no frenen al cajero.
  - [ ] Combos simples: café + medialuna, kilo + cucuruchos, docena, promo familiar.
  - [ ] Impresión opcional de comanda/producción para preparación.
  - [ ] *Criterio:* el cajero vende "1/2 kg, 3 sabores" sin crear 200 productos distintos.

- [ ] **H38 — Agenda y servicios para peluquería/estética.**
  - [ ] Servicios con duración, precio, profesional asignable y comisión.
  - [ ] Agenda diaria/semanal por profesional, silla/cabina o recurso.
  - [ ] Turnos, walk-ins y lista de espera.
  - [ ] Cobro desde turno: servicio realizado → agregar productos extra → cobrar.
  - [ ] Señas, cancelaciones, no-show y reprogramación.
  - [ ] *Criterio:* una peluquería agenda corte + color con profesional, cobra el turno y calcula comisión.

- [ ] **H39 — Comisiones, propinas y productividad del staff.**
  - [ ] Comisión por servicio, por producto, por garantía/extra y por profesional.
  - [ ] Propinas por efectivo/tarjeta/QR con reparto manual o por profesional.
  - [ ] Reporte diario por profesional: servicios, productos vendidos, comisión, propina, ticket promedio.
  - [ ] Permisos para que el staff vea solo su agenda/ventas si el owner lo decide.
  - [ ] *Criterio:* el owner liquida comisiones de la semana sin planilla externa.

- [ ] **H40 — Clientes livianos y recurrencia.**
  - [ ] Ficha mínima opcional: nombre, teléfono/WhatsApp, cumpleaños, preferencias y notas.
  - [ ] Historial de servicios/productos por cliente.
  - [ ] Recordatorios por WhatsApp/email: próximo turno, mantenimiento, cumpleaños, promo de regreso.
  - [ ] Recompra rápida: "repetir último servicio" o "repetir pedido frecuente".
  - [ ] *Criterio:* un cliente frecuente se cobra desde su historial en menos de 3 taps.

- [ ] **H41 — Paquetes, membresías y sesiones.**
  - [ ] Packs de sesiones: 4 cortes, 8 clases, 10 sesiones de estética, mantenimiento mensual.
  - [ ] Saldo de sesiones consumibles con vencimiento opcional.
  - [ ] Membresía simple recurrente o prepaga, conectable a suscripciones/pagos después.
  - [ ] Gift cards para servicios y consumos.
  - [ ] *Criterio:* se vende un pack de 5 sesiones, se consume una al cobrar y queda saldo visible.

- [ ] **H42 — Oportunidad comercial y plantillas vendibles.**
  - [ ] Landing/demo por rubro: "POS para heladerías", "POS para peluquerías", "POS para estética", "POS para cafeterías chicas".
  - [ ] Datos demo precargados por rubro para mostrar valor en 3 minutos.
  - [ ] Plan Start orientado a catálogo chico: bajo setup, pantalla simple, agenda básica o botones rápidos.
  - [ ] Métrica de activación: primer cobro real, primer turno agendado, primer cliente recurrente.
  - [ ] *Criterio:* ventas puede demoear cada rubro con flujo real sin configurar datos manualmente.

### F13 — Gastronomía PRO

Objetivo: cubrir restaurantes, resto-bares, cafeterías, heladerías, panaderías, rotiserías, food trucks y fast food con mesas, comandas, cocina/barra, delivery/takeaway y variantes de atención. No reemplaza F12: F12 cubre cobro simple; F13 cubre operación gastronómica completa. Ver [`23-restaurant-cafe-operations.md`](./23-restaurant-cafe-operations.md).

- [ ] **H43 — Configuración de negocio gastronómico y modos de atención.**
  - [ ] Presets por tipo: restaurante salón, resto-bar, cafetería, heladería, panadería, rotisería, fast food, food truck, dark kitchen, delivery/takeaway.
  - [ ] Modos de venta: mesa, mostrador, take away, delivery propio, pickup, drive-through, pedido por QR, evento/food truck.
  - [ ] Selector por caja/dispositivo: salón, barra, cocina, mostrador, despacho.
  - [ ] Reglas por modo: cobrar antes/después, imprimir comanda al enviar/cobrar, pedir nombre de cliente, pedir mesa, pedir teléfono/dirección.
  - [ ] *Criterio:* un tenant cambia de cafetería de mostrador a cafetería con mesas sin tocar código ni migraciones manuales.

- [ ] **H44 — Mesas, salones y comandas de salón.**
  - [ ] Configuración visual de salones/sectores: salón principal, terraza, barra, patio, VIP.
  - [ ] Mesas con número/nombre, capacidad, posición, forma, estado y mozo asignado.
  - [ ] Estados de mesa: libre, ocupada, esperando pedido, en cocina, servida, cuenta pedida, limpieza, reservada, bloqueada.
  - [ ] Apertura de mesa, mover mesa, unir mesas, transferir mesa entre mozos y cerrar mesa.
  - [ ] División de cuenta por ítem, por comensal, por porcentaje o por monto.
  - [ ] Propina sugerida y propina libre.
  - [ ] *Criterio:* un mozo abre mesa 12, carga pedido, envía comanda, divide la cuenta en dos pagos y libera la mesa.

- [ ] **H45 — Comandas impresas y ruteo por estación.**
  - [ ] Comanda antes del pago para restaurante/cafetería cuando corresponda.
  - [ ] Ruteo por estación: cocina caliente, cocina fría, barra, cafetería, heladería, parrilla, despacho, postres.
  - [ ] Impresora por estación y fallback a cola si falla.
  - [ ] Comanda con mesa/pedido, mozo/cajero, hora, ítems, modificadores, notas, alergias, prioridad y modo de entrega.
  - [ ] Reimpresión, cancelación parcial, agregado posterior y marca de "ya enviado".
  - [ ] Separación de comandas por estación sin duplicar ítems.
  - [ ] *Criterio:* café va a barra, tostado a cocina y helado a estación heladería en tickets separados, con el mismo pedido.

- [ ] **H46 — KDS / pantalla de cocina y barra.**
  - [ ] Vista KDS por estación con tarjetas de pedido en tiempo real.
  - [ ] Estados: nuevo, aceptado, preparando, listo, entregado, demorado, cancelado.
  - [ ] Timers por estación, SLA configurable y alertas visuales por demora.
  - [ ] Agrupación por mesa/pedido, por estación, por curso/plato o por orden de llegada.
  - [ ] Modo offline local con cola de sincronización cuando la red cae.
  - [ ] *Criterio:* cocina marca un plato como listo y el mozo/caja ve el cambio sin recargar.

- [ ] **H47 — Menú gastronómico, modificadores y cursos.**
  - [ ] Menú por horario/canal: desayuno, almuerzo, merienda, cena, happy hour, delivery.
  - [ ] Modificadores obligatorios/opcionales: punto de cocción, guarnición, salsa, leche, tamaño, sabor, topping, sin TACC, sin sal, extra.
  - [ ] Cursos/platos: entrada, principal, postre, bebida; enviar todo o "fire course" por etapa.
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

- [ ] **H49 — Delivery, take away y despacho gastronómico.**
  - [ ] Pedidos con canal: mostrador, teléfono, WhatsApp, QR, delivery propio, marketplace futuro.
  - [ ] Datos por pedido: cliente, teléfono, dirección, referencia, horario prometido, cadete/repartidor, costo de envío.
  - [ ] Estados: recibido, aceptado, en preparación, listo, en camino, entregado, cancelado.
  - [ ] Comanda a cocina y ticket/etiqueta para despacho.
  - [ ] Integración futura con PedidosYa, Rappi, Mercado Libre/Tienda Nube cuando aplique.
  - [ ] *Criterio:* una rotisería toma pedido telefónico, cocina lo prepara, despacho lo marca en camino y caja lo concilia.

- [ ] **H50 — Inventario gastronómico, recetas y merma básica.**
  - [ ] Recetas/escandallo por producto: ingredientes, cantidad, unidad y costo estimado.
  - [ ] Descuento de insumos al vender cuando el tenant lo active.
  - [ ] Producción/preparación previa: batch de helado, masa, prep de cocina, stock de barra.
  - [ ] Merma: vencido, roto, devolución, preparación fallida.
  - [ ] Alertas de insumos críticos y reporte de margen por plato.
  - [ ] *Criterio:* vender 10 combos descuenta insumos configurados y muestra margen estimado.

- [ ] **H51 — Reservas gastronómicas, waitlist y ocupación.**
  - [ ] Reservas por mesa/sector/capacidad, fecha, hora, duración estimada y seña opcional.
  - [ ] Lista de espera con prioridad y aviso por WhatsApp/email futuro.
  - [ ] Turnover de mesas: tiempo sentado, tiempo sin ordenar, tiempo desde cuenta pedida.
  - [ ] Bloqueo de mesas por evento, mantenimiento o configuración del salón.
  - [ ] *Criterio:* una reserva bloquea mesa/sector, luego se convierte en mesa ocupada y conserva cliente/seña.

- [ ] **H52 — Reportes gastronómicos y operación.**
  - [ ] Ventas por mozo, mesa, sector, estación, canal, producto, modificador y horario.
  - [ ] Tiempos: pedido a cocina, preparación, listo a entregado, rotación de mesa.
  - [ ] Top productos/modificadores, cancelaciones, reimpresiones y comandas demoradas.
  - [ ] Margen por plato si hay recetas.
  - [ ] Export XLSX con filtros por canal/sector/estación.
  - [ ] *Criterio:* el owner identifica cuellos de botella de cocina/barra y productos con más margen.

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

- [ ] **TX-1 — Calendario unificado con react-day-picker.**
  - [ ] Librería: **react-day-picker (v9)** + **Radix Popover** (patrón shadcn), estilado con Tailwind/cva como el resto del sistema. Locale **español (es)** vía date-fns. *(Se descartó flatpickr por ser JS vanilla y chocar con el stack React/Radix; ver ADR.)*
  - [ ] **Un solo calendario**, con **selección de rango** (desde/hasta) donde aplique (reportes, promociones, suscripciones, filtros).
  - [ ] Presets rápidos (hoy, ayer, últimos 7/30 días, este mes, mes pasado).
  - [ ] Componente reutilizable `DateRangePicker` único; nada de inputs de fecha sueltos.
  - [ ] *Criterio:* en reportes se elige "últimos 30 días" o un rango con un calendario en español; mismo componente en todos lados.

- [ ] **TX-2 — Exportaciones en XLSX con diseño (reemplazo de CSV).**
  - [ ] Eliminar CSV como formato de export. Usar **XLSX con diseño**: encabezados con color de marca, filas alternadas, **fila de totales**, formato de moneda/fecha, **filtros (autofilter)** y **paneles congelados** (freeze header).
  - [ ] Aplicar a reportes de ventas, caja, stock, clientes, promociones; nombre de archivo con tenant + rango.
  - [ ] Helper único `exportXlsx()` reutilizable; respeta el branding del tenant (TX se apoya en F6/H8).
  - [ ] *Criterio:* descargar "Ventas del mes" da un .xlsx con encabezado de marca, totales, autofilter y header congelado.

- [~] **TX-4 — Importaciones masivas XLSX como estándar (reemplaza CSV).** — *Productos hecho (PR #37); clientes y demás entidades pendientes.*
  - [~] **Productos y clientes se importan SIEMPRE en XLSX**: **productos ✅** (se eliminó el modal CSV, ahora `ImportProductsModal` XLSX). Clientes y resto (depósitos, stock, listas, medios, garantías, motivos) pendientes.
  - [x] **Descargar plantilla de muestra XLSX** (productos: hoja de datos + ejemplo + hoja "Ayuda").
  - [x] **Exportar toda la base** en XLSX (productos: botón "Exportar XLSX" en `/productos`). Clientes pendiente.
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
