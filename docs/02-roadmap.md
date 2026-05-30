# Roadmap — NinjaSoft POS

Plan de ejecución por fases. Cada fase tiene salida verificable, criterios de éxito y demo concreta. Este documento se actualiza al cierre de cada hito.

> **Convención.** Los hitos del MVP (`H0`–`H6`) están detallados en [`01-mvp.md`](./01-mvp.md). Este documento extiende el plan más allá del MVP.

## Visión por fases

| Fase | Nombre | Duración estimada | Estado |
|---|---|---|---|
| **F0** | Fundación técnica | 2 semanas | 🟢 Funcional |
| **F1** | MVP vendible (POS + Admin) | 10–12 semanas | 🟢 Funcional (base H0–H6) |
| **F2** | Plataforma SaaS (panel interno + suscripciones) | 4–6 semanas | 🟡 En progreso |
| **F3** | Integración AFIP y producción | 4–6 semanas | 🔴 No iniciado |
| **F4** | Escalado: multi-sucursal, hardware, integraciones | 8–10 semanas | 🟡 Planificación |
| **F5** | Perfiles por rubro y marketplace | 10–14 semanas | 🟡 Planificación |
| **F6** | Personalización del producto (fotos, branding, tickets, catálogo) | 6–8 semanas | 🟡 Planificación |
| **F7** | Panel interno PRO + comunicaciones (emails) | 5–7 semanas | 🟡 Planificación |
| **F8** | Pagos y cobros (arquitectura + pasarelas por etapas) | 6–10 semanas | 🟡 Planificación |
| **F9** | Motor de promociones PRO | 4–6 semanas | 🟡 Planificación |
| **TX** | Mejoras transversales (UX y datos) — quick wins | continuo | 🟡 Planificación |

> **Orden de ejecución acordado (2026-05-30):** **TX (quick wins) → F6 → F7 → F8 → F9 → F3 (AFIP)**. Las **mejoras transversales (TX)** — flatpickr y export XLSX — se hacen primero por ser pedidos explícitos y de bajo costo, y luego se aplican de forma continua. Ver [§ Plan ampliado](#plan-ampliado-2026-05-30), [§ Mejoras transversales](#tx--mejoras-transversales-ux-y-datos) y los cortes de control obligatorios al cierre de cada hito.

---

## F0 — Fundación técnica

**Duración:** 2 semanas. **Objetivo:** dejar el proyecto listo para que cualquier agente o persona pueda contribuir sin pedir contexto.

### Entregables
- Repositorio en GitHub con estructura definitiva.
- CI/CD: GitHub Actions corriendo lint, typecheck, tests, build.
- Vercel conectado: production en `main`, previews por rama.
- Supabase: proyecto local + staging + production, con migraciones versionadas.
- Documentación viva (`docs/`, `CLAUDE.md`, agentes en `.claude/agents/`).
- Sistema de diseño base: tokens, primitives (Button, Input, Card, etc.).
- Auth funcional con Supabase + selección de tenant.

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

## F2 — Plataforma SaaS

**Duración:** 4–6 semanas. **Objetivo:** NinjaSoft puede operar el SaaS sin tocar SQL: alta de clientes, cambios de plan, activación de features.

### Entregables
- **Panel interno** (rutas protegidas para staff NinjaSoft):
  - Listado de tenants con filtros (estado, plan, última actividad).
  - Alta y baja de tenants.
  - Cambio de plan en caliente.
  - Activación / desactivación de feature flags por tenant.
  - Vista de auditoría administrativa.
- **Modelo de suscripciones** completo:
  - Estados: `trial`, `active`, `suspended`, `cancelled`.
  - Trial automático de 14 días al alta.
  - Suspensión por falta de pago (manual en esta fase).
- **Sistema de soporte interno:**
  - Notas internas por tenant.
  - Vista rápida de salud operativa (último login, ventas últimos 7 días, errores).

### Criterios de cierre
- [ ] NinjaSoft puede dar de alta un cliente nuevo en < 5 minutos sin tocar SQL.
- [ ] Cambiar un cliente de Start a Pro toma una sola acción y aplica de inmediato.
- [ ] Toda acción administrativa queda en `audit_logs`.

---

## F3 — Integración AFIP y producción

**Duración:** 4–6 semanas. **Objetivo:** el cliente piloto puede facturar electrónicamente con CAE válido.

### Entregables
- Edge Function `submit_invoice_afip` con manejo completo de:
  - Solicitud de CAE para Factura A, B, C, Nota de Crédito.
  - Reintentos con backoff exponencial.
  - Almacenamiento de XML de request/response.
  - Cola de comprobantes pendientes.
- Gestión de certificados AFIP por tenant (almacenados encriptados).
- Panel de monitoreo de facturación electrónica:
  - Comprobantes pendientes.
  - Errores recientes con código AFIP.
  - Última conexión al webservice AFIP.
- Modo "homologación" vs "producción" por tenant.
- Numeración de comprobantes por punto de venta.

### Criterios de cierre
- [ ] 100 comprobantes consecutivos en homologación sin error de integración.
- [ ] Recuperación automática si AFIP devuelve error transitorio.
- [ ] El cashier nunca ve un error de AFIP que lo bloquee — la venta se completa, la factura se reintenta en segundo plano.

---

## F4 — Escalado

**Duración:** 8–10 semanas. **Objetivo:** soportar clientes con múltiples sucursales y cajas, integraciones con hardware y pasarelas de pago.

### Entregables
- **Multi-sucursal:**
  - Stock por sucursal con transferencias.
  - Reportes consolidados.
  - Permisos por sucursal.
- **Multi-caja por sucursal:**
  - Asignación de cajero a caja específica.
  - Reportes por caja.
- **Integraciones de hardware:**
  - Impresoras térmicas (ESC/POS via plugin de impresión web).
  - Cajón de dinero.
  - Lectores de código de barras (USB HID, sin driver).
  - Balanzas (opcional, vía puerto serie).
- **Pasarelas de pago:**
  - Mercado Pago Point (QR + tarjeta).
  - Modo (transferencia).
  - Conciliación automática.
- **Observabilidad avanzada:**
  - Sentry para errores frontend.
  - Logs estructurados centralizados.
  - Alertas en Slack/email para errores críticos.

### Criterios de cierre
- [ ] Un cliente con 3 sucursales puede operar simultáneamente sin latencia perceptible.
- [ ] Una impresora térmica imprime un ticket en < 2s después de cobrar.
- [ ] Mercado Pago se acredita en la venta sin intervención del cashier.

---

## F5 — Perfiles por rubro y marketplace

**Duración:** 10–14 semanas. **Objetivo:** el producto se siente "hecho a medida" para cada rubro sin código específico.

### Entregables
- **Perfiles de rubro** activables por tenant:
  - **Kiosco:** venta ultrarrápida, atajos de teclado optimizados, gestión de cigarrillos / bebidas.
  - **Textil:** variantes (talle/color), control de prendas por SKU compuesto.
  - **Retail:** promociones complejas (2x1, descuentos por volumen).
  - **Restaurante:** mesas, comandas a cocina, división de cuenta.
  - **Pyme genérica:** módulo de cuenta corriente de clientes.
- **Motor de promociones** configurable:
  - Reglas declarativas (no código).
  - Vigencia por fecha/horario.
  - Combinables o exclusivas.
- **Marketplace de integraciones:**
  - Mercado Libre (publicación y sincronización de stock).
  - Tienda Nube.
  - WhatsApp Business para notificaciones.
- **API pública** con OAuth para clientes Enterprise.
- **Tema visual personalizado** por tenant (logo, color de acento dentro de los límites de marca).

### Criterios de cierre
- [ ] Un cliente textil puede gestionar 500 SKUs con variantes sin pasar por NinjaSoft.
- [ ] Una promoción "Miércoles 30% en bebidas" se configura desde el panel del cliente y aplica automáticamente.
- [ ] La API permite a un cliente Enterprise sincronizar 1000 productos en < 60s.

---

## Plan ampliado (2026-05-30)

Extensión del roadmap acordada con el equipo humano. Define hitos nuevos (`H7+`) sobre la base del MVP ya funcional. **Orden de ejecución: F6 → F7 → F8 → F3.** Cada hito cierra con el [corte de control](#cortes-de-control-y-testing-estricto) obligatorio.

### F6 — Personalización del producto

Objetivo: que el producto se sienta "a medida" de cada negocio. Todo configurable por tenant, con persistencia y multi-dispositivo.

- **H7 — Fotos de productos → WebP.**
  - Subida de imágenes por producto (drag&drop, múltiples).
  - Conversión a **WebP** en **Edge Function con `sharp`**: genera varios tamaños (thumb / card / full), guarda en Supabase Storage con RLS por tenant.
  - Galería por producto (orden, foto principal, baja lógica).
  - Optimización de peso (target < 100 KB en `card`).
  - *Criterio:* subir un JPG de 4 MB resulta en un WebP servido < 100 KB sin pérdida visible.

- **H8 — Branding por tenant.**
  - Logo del negocio, color de acento (dentro de límites de marca), datos fiscales/contacto.
  - Aplicado en POS, tickets, emails y catálogo.
  - (Opcional Enterprise) dominio propio para el catálogo.
  - *Criterio:* el logo y color del tenant se ven en ticket, email y catálogo sin tocar código.

- **H9 — Tickets y comprobantes personalizables.**
  - Plantillas de ticket configurables: logo, leyendas, QR, redes, pie legal.
  - Formatos **58mm / 80mm** (térmica) y **A4** (PDF).
  - Preview en vivo y selección por sucursal.
  - *Criterio:* un tenant configura su ticket y lo imprime/descarga sin intervención.

- **H10 — Catálogo público + variantes.**
  - Catálogo web por tenant (productos, fotos, precios, stock visible opcional).
  - Variantes por rubro (talle/color para textil; SKU compuesto).
  - Listas de precios por canal (mostrador / catálogo / mayorista).
  - *Criterio:* un tenant publica su catálogo con fotos y variantes sin tocar código.
  - *Nota:* el motor de promociones se trata aparte y a fondo en **[F9 — Motor de promociones PRO](#f9--motor-de-promociones-pro)**.

### F7 — Panel interno PRO + comunicaciones

Objetivo: que NinjaSoft opere el SaaS completo sin SQL, con control fino de usuarios, planes y comunicaciones.

- **H11 — Roles de staff NinjaSoft + gestión total de usuarios.**
  - Tres niveles de staff: **super-admin**, **admin**, **soporte**.
    - *super-admin:* todo (sumar/quitar staff, borrar tenants, facturación, acciones peligrosas).
    - *admin:* gestión de tenants/usuarios/soporte; sin tocar staff ni acciones destructivas.
    - *soporte:* solo-lectura + acciones limitadas (notas, ver salud, reset de contraseña).
  - Gestión total de usuarios (staff): ver todos, **pausar/suspender/reactivar**, cambiar roles, **sumar poderes**, y **sumar usuarios como staff NinjaSoft** (con su nivel).
  - Toda acción crítica en `audit_logs`; matriz de permisos versionada en [`06-permissions-roles.md`](./06-permissions-roles.md).
  - *Criterio:* un super-admin suma a otra persona como admin de NinjaSoft en una acción; un admin no puede tocar staff.

- **H11b — Miembros del negocio (lo gestiona el DUEÑO en `/dashboard-team`).**
  - **Dos clases de miembro** (el dueño elige al crear):
    - **Con login:** email + contraseña, recibe invitación (Edge Function `invite_user`). Nombre real **o** genérico (ej. "Cajero A").
    - **Perfil sin login:** etiqueta para identificar quién vende (ej. "Cajero A"), **sin email**, con **PIN opcional** para fichar en el POS. Útil en kioscos con caja compartida.
  - **Nombre por membresía:** el rótulo (real o genérico) vive en la membresía, no en la cuenta global → la misma persona puede ser "Cajero A" en un negocio y otra cosa en otro. Nueva columna `display_name` en `tenant_users` (+ tabla `cashier_profiles` para los sin-login, con `pin_hash`).
  - **Avatares:** set de **presets** (iniciales con color de marca + ilustraciones/emoji) elegibles ya; **subida de imagen propia** se habilita en **F6 (WebP)**. Columna `avatar` en la membresía/perfil.
  - **Edición por el dueño:** el rol `owner` (y `manager` según permisos) puede **editar** miembros (nombre, rol, avatar), **suspender/reactivar** y resetear PIN. Validado por RLS + Edge Function `update_member` (guard owner/manager del tenant). Todo auditado.
  - *Backend requerido (deploy con Supabase):* migración (`tenant_users.display_name`, `tenant_users.avatar`, tabla `cashier_profiles`), Edge Functions `invite_user` (extendida con nombre/genérico) y `update_member`, RPC de listado ya cubierto por `tenant_members()`.
  - *Criterio:* el dueño crea "Cajero A" sin email con avatar preset y PIN; luego lo renombra y lo suspende; un cajero no puede editar a otros.

- **H12 — Suscripciones y planes en caliente.**
  - Upgrade/downgrade de plan, cambio de estado (`trial`/`active`/`past_due`/`suspended`/`cancelled`), fechas de período.
  - Aumentar/limitar poderes y feature flags por tenant.
  - *Criterio:* pasar un tenant de Start a Pro aplica al instante y queda auditado.

- **H13 — Emails configurables (HTML + variables).**
  - **Editor de plantillas HTML** con variables (`{{nombre}}`, `{{negocio}}`, `{{monto}}`, …), preview y **versionado**.
  - **Catálogo de emails del sistema**: bienvenida, invitación de usuario, reset de contraseña, trial por vencer, pago vencido, suspensión, etc. — cada uno editable.
  - **Proveedores de envío:** **Resend** (transaccional) + **Brevo** (masivos/campañas). Credenciales encriptadas; abstracción de proveedor.
  - **Logs de envío** (estado, destinatario, plantilla, proveedor) y reintentos.
  - **Envíos masivos / campañas** a segmentos de tenants/usuarios.
  - *Criterio:* editar la plantilla "trial por vencer", previsualizar con variables reales y enviarla; el envío queda registrado con su estado.

### F8 — Pagos y cobros

Objetivo: cobrar por cualquier medio, con arquitectura extensible. **Arquitectura primero, integraciones por etapas** (un sub-hito por proveedor).

- **H14 — Arquitectura de pagos (base).**
  - Registro de **proveedores de pago** y catálogo de medios.
  - Habilitación y **configuración por tenant** (credenciales **encriptadas**, modo sandbox/producción).
  - **UI de cobro abstracta** en el POS (un medio → un flujo), **pago mixto** (varios medios en una venta) y conciliación básica.
  - Medios manuales reales desde el arranque: **Efectivo**, **Transferencia bancaria**, **Pago mixto**.
  - *Criterio:* una venta se cobra con efectivo + transferencia (mixto) y queda conciliada.

- **H15+ — Integraciones por proveedor** (un sub-hito cada uno, cableado incremental sobre la arquitectura de H14):
  - **H15** — Mercado Pago + **Mercado Point** (QR + tarjeta presencial).
  - **H16** — **MODO** vía QR interoperable.
  - **H17** — **Payway / Prisma**.
  - **H18** — **Getnet**.
  - **H19** — **Fiserv / Posnet / Clover**.
  - **H20** — **Mobbex** como **orquestador** (abstrae varios proveedores; opcional según convenga).
  - **H21** — **Pagos360** (links de pago / cobranzas).
  - *Criterio por proveedor:* cobro real en sandbox + conciliación + manejo de error sin bloquear la venta.

### F3 — AFIP (ya proyectada, se ejecuta al final de esta tanda)

Sin cambios de alcance: ver [F3](#f3--integración-afip-y-producción) y [`15-afip-integration.md`](./15-afip-integration.md). Se prioriza **después** de F6–F8 (requiere certificados por tenant y homologación).

---

### F9 — Motor de promociones PRO

Objetivo: igualar o superar a los POS líderes (Square, Lightspeed, Toast, Fudo, Shopify POS) en promociones. Motor **declarativo** (reglas sin código), evaluado en el carrito en tiempo real, auditable y combinable. Configurable 100% por el dueño desde el panel.

- **H22 — Núcleo del motor de reglas.**
  - Modelo declarativo: **condiciones** (productos, categorías, marcas, cantidad, monto, cliente/segmento, día/horario, canal, sucursal, medio de pago) → **acciones** (% descuento, monto fijo, precio fijo, producto bonificado, envío/recargo).
  - Evaluación en el carrito en vivo, con prioridad, **combinables o exclusivas**, y tope de descuento.
  - Vigencia por fecha/horario (usa el calendario unificado de TX).
  - *Criterio:* "Miércoles 30% en bebidas de 18 a 21hs" se configura sin código y aplica solo en ese rango.

- **H23 — Catálogo de tipos de promoción.**
  - **2x1 / 3x2 / NxM**, **% por volumen** (escalonado), **combos/bundles** a precio especial, **descuento por segundo ítem**, **precio por pack**, **regalo por compra** (gift with purchase), **descuento por medio de pago**, **happy hour**, **liquidación por temporada**.
  - **Cupones / códigos** (únicos o multiuso, con límite de usos, por cliente o global).
  - *Criterio:* cada tipo tiene su preset configurable y un ejemplo de demo.

- **H24 — Segmentación y fidelización.**
  - Reglas por **segmento de cliente** (nuevos, frecuentes, cumpleaños, lista mayorista).
  - Base para **fidelización**: puntos, niveles, recompensas canjeables (gancha con cuenta corriente de clientes).
  - **Gift cards** y saldo a favor.
  - *Criterio:* un cliente "VIP" recibe automáticamente un precio/beneficio distinto en el POS.

- **H25 — Gobierno, simulación y reporte de promociones.**
  - **Simulador**: previsualizar el efecto de una promo sobre ventas históricas antes de activarla.
  - **Tope de impacto** y aprobación (rol manager/owner), todo auditado.
  - **Reporte de performance** por promoción (uso, descuento otorgado, margen, incremental).
  - Export en **XLSX** (ver TX) y al catálogo/canales.
  - *Criterio:* el dueño ve cuánto descuento otorgó cada promo y su impacto en margen.

---

## TX — Mejoras transversales (UX y datos)

Quick wins pedidos explícitamente. Se hacen **primero** y luego se aplican de forma continua en todo el producto. No son una fase con fin: son estándar del proyecto.

- **TX-1 — Calendario unificado con react-day-picker.**
  - Librería: **react-day-picker (v9)** + **Radix Popover** (patrón shadcn), estilado con Tailwind/cva como el resto del sistema. Locale **español (es)** vía date-fns. *(Se descartó flatpickr por ser JS vanilla y chocar con el stack React/Radix; ver ADR.)*
  - **Un solo calendario**, con **selección de rango** (desde/hasta) donde aplique (reportes, promociones, suscripciones, filtros).
  - Presets rápidos (hoy, ayer, últimos 7/30 días, este mes, mes pasado).
  - Componente reutilizable `DateRangePicker` único; nada de inputs de fecha sueltos.
  - *Criterio:* en reportes se elige "últimos 30 días" o un rango con un calendario en español; mismo componente en todos lados.

- **TX-2 — Exportaciones en XLSX con diseño (reemplazo de CSV).**
  - Eliminar CSV como formato de export. Usar **XLSX con diseño**: encabezados con color de marca, filas alternadas, **fila de totales**, formato de moneda/fecha, **filtros (autofilter)** y **paneles congelados** (freeze header).
  - Aplicar a reportes de ventas, caja, stock, clientes, promociones; nombre de archivo con tenant + rango.
  - Helper único `exportXlsx()` reutilizable; respeta el branding del tenant (TX se apoya en F6/H8).
  - *Criterio:* descargar "Ventas del mes" da un .xlsx con encabezado de marca, totales, autofilter y header congelado.

- **TX-3 — Pulido UX continuo.**
  - Estados vacíos, skeletons, toasts consistentes, accesibilidad, atajos de teclado en POS.
  - Se evalúa al cierre de cada hito como parte del gate manual.

---

## Benchmark de mercado (qué hace a un POS "pro")

Análisis de referentes (Square, Toast, Lightspeed, Clover, Shopify POS; locales: Fudo, Bistrosoft, Maxirest, Aligare). Mapeo de capacidades pro → dónde las cubre NinjaSoft. Sirve para validar que el roadmap no tenga huecos.

| Capacidad pro del mercado | Dónde la cubre NinjaSoft |
|---|---|
| Venta rápida, búsqueda, carrito, descuentos, pago mixto | F1 (MVP) + F8/H14 |
| Promociones avanzadas (NxM, combos, cupones, fidelización, gift cards) | **F9 (nuevo)** |
| Pasarelas de pago presenciales y QR (MP Point, MODO, Payway, Getnet, Fiserv, etc.) | F8/H15+ |
| Facturación electrónica / fiscal (AFIP, CAE) | F3 |
| Fotos de producto, branding, tickets a medida, catálogo público | F6 |
| Multi-sucursal, multi-caja, transferencias de stock | F4 |
| Inventario avanzado: lotes, vencimientos, series, conteos, alertas | **Backlog → promover a fase de Inventario PRO** |
| Compras y proveedores (órdenes de compra, recepción, costos) | Backlog |
| Cuenta corriente de clientes y proveedores (fiado) | Backlog (gancha con F9/H24) |
| Restaurante: mesas, comandas, KDS, división de cuenta, modificadores | F5 (perfil restaurante) |
| Variantes (talle/color), SKU compuesto (textil) | F6/H10 + F5 (perfil textil) |
| Devoluciones, cambios, notas de crédito | F1 (anulación) + F3 (NC) — *falta flujo de cambio/devolución → backlog* |
| Reportes/BI y exportaciones con diseño | F1 (reportes) + **TX-2 (XLSX)** + F9/H25 |
| Hardware: impresora térmica/fiscal, cajón, balanza, lector | F4 |
| Pedidos online / delivery (PedidosYa, Rappi, Tienda Nube, Mercado Libre) | F5 (marketplace) |
| Modo offline con sincronización | Backlog |
| App móvil para gerentes | Backlog |
| Roles y permisos granulares; staff multinivel | F1 (roles) + **F7/H11 (staff NinjaSoft)** |
| Multimoneda / listas de precios por canal | F6/H10 (listas) + Backlog (multimoneda) |
| Reservas / turnos | Backlog |

> **Conclusión del benchmark:** los huecos relevantes vs. POS líderes son **inventario avanzado**, **compras/proveedores**, **cuenta corriente (fiado)** y **devoluciones/cambios**. Se agregan al backlog priorizado abajo; inventario y compras son candidatos a fase propia tras F9.

---

## Cortes de control y testing estricto

**Regla:** ningún hito se considera cerrado sin pasar su corte de control. No se avanza al siguiente hito con el anterior "al 80%".

### Gate automático (obligatorio en cada hito)
1. `pnpm lint` sin warnings.
2. `pnpm typecheck` limpio.
3. `pnpm test` (unit + integración) en verde, **con tests nuevos que cubran el hito**.
4. `pnpm build` exitoso.
5. Migraciones aplicadas y `db:types` regenerado si cambió el esquema.
6. RLS verificada: tests que prueben aislamiento por tenant del esquema nuevo.

### Gate manual (checklist por hito)
- [ ] Criterio de cierre del hito demostrado (demo concreta).
- [ ] Acciones críticas escriben en `audit_logs`.
- [ ] `service_role` no aparece en frontend.
- [ ] Feature nueva detrás de feature flag si es opcional.
- [ ] Entrada en [`17-decision-log.md`](./17-decision-log.md) y `CHANGELOG.md`.
- [ ] Deploy a producción verificado (estado READY) y humo manual en la ruta nueva.

### Cobertura mínima de tests por capa
- **Edge Functions / RPC:** test de happy-path + test de autorización (rol incorrecto / otro tenant rechazado).
- **Componentes:** render + interacción principal.
- **Flujos críticos (pago, cobro, facturación):** test de integración end-to-end del camino feliz y de un error transitorio.

---

## Backlog para fases siguientes (no priorizado)

- **Inventario PRO** (candidato a fase propia tras F9): lotes, vencimientos, números de serie, conteos/ajustes, alertas de stock mínimo, multi-depósito.
- **Compras y proveedores:** órdenes de compra, recepción, costos, actualización de precios.
- **Devoluciones y cambios:** flujo dedicado (cambio de talle/producto, nota de crédito, reintegro por medio de pago).
- **Cuenta corriente de clientes** (fiado) — gancha con F9/H24 (fidelización) y segmentos.
- **Cuenta corriente de proveedores.**
- **Reservas / turnos** (servicios, peluquerías, gastronomía).
- **Multimoneda** y tipo de cambio.
- App móvil nativa (React Native) para gerentes en movimiento.
- Modo offline con sincronización al recuperar conexión.
- Producción y recetas / escandallo (restaurantes y manufactura).
- E-commerce integrado (alternativa a Tienda Nube).
- Multi-país (Uruguay, Chile, México) — requiere abstraer facturación electrónica.

> *Nota:* **Fidelización (puntos/niveles), gift cards y cupones** se movieron del backlog a **F9 — Motor de promociones PRO** (H23–H24).

---

## Cómo se actualiza este roadmap

1. Al cerrar una fase, el PM actualiza el estado en la tabla principal y agrega un resumen de aprendizajes en [`17-decision-log.md`](./17-decision-log.md).
2. Cambios de prioridad mayor requieren PR con justificación.
3. Estimaciones de duración se ajustan según velocidad real medida en fases anteriores.

> **Principio.** El roadmap es un mapa, no una promesa. Lo que sí es promesa: cada fase termina con software que funciona, no con un avance del 80%.
