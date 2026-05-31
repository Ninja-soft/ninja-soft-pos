# MVP — NinjaSoft POS

> Documento maestro del producto. Cualquier persona o agente que trabaje en el proyecto debe leer este archivo **antes** de tocar código o tomar decisiones de arquitectura.

---

## 0. Filosofía del MVP

El MVP no es "lo mínimo que se puede demostrar". Es **lo mínimo que se puede vender, operar y soportar** sin rehacer la base.

Tres reglas rectoras:

1. **Vendible desde el día uno.** Cada hito cerrado debe poder mostrarse a un cliente real.
2. **Multi-tenant desde el primer commit.** No existe "después lo separamos por cliente". Toda tabla operativa nace con `tenant_id` y RLS.
3. **Trazabilidad obligatoria.** Toda acción crítica deja rastro (`audit_logs`). El soporte y la auditoría no son features futuras: son base.

> La prioridad no es hacer todo; la prioridad es construir bien lo esencial.

---

## 1. Visión del producto

NinjaSoft POS es un sistema de punto de venta **SaaS multi-tenant** orientado a kioscos, retail, textiles, restaurantes y pymes argentinas, con foco en:

- **Velocidad operativa** en mostrador (POS sin fricción).
- **Personalización por cliente** sin romper el producto base (feature flags + settings por tenant).
- **Gestión centralizada** desde un panel interno de NinjaSoft.
- **Escalabilidad** real: multi-sucursal, multi-caja, multi-rubro.
- **Cumplimiento fiscal** argentino (AFIP) encapsulado en backend.

El sistema se compone de **tres planos** que deben permanecer separados desde el diseño:

| Plano | Quién lo usa | Qué hace |
|---|---|---|
| **Producto** | Cliente final (cajero, encargado, dueño) | Vende, gestiona stock, cobra, cierra caja |
| **Plataforma** | Cliente administrador | Configura su negocio, ve reportes, gestiona usuarios |
| **Operaciones** | Equipo NinjaSoft | Alta de tenants, suscripciones, soporte, auditoría |

---

## 2. Audiencia objetivo

**Rubros prioritarios (Fase 1):**

- Kioscos y autoservicios.
- Comercios de indumentaria y textiles.
- Retail general.

**Rubros secundarios (Fase 2):**

- Restaurantes (mesa, mostrador, takeaway).
- Resto-bares, cafeterías, heladerías, panaderías chicas, rotiserías, fast food y food trucks con mesas, mostrador, comandas o cobro rápido.
- Peluquerías, barberías, estética/uñas/spa y servicios con agenda.
- Pymes con stock y facturación electrónica.

**Personas del producto:**

- **Cajero:** necesita vender rápido, con búsqueda ágil y atajos.
- **Encargado de turno:** abre y cierra caja, controla arqueo, autoriza descuentos.
- **Dueño:** ve reportes, gestiona productos, define usuarios.
- **Administrador NinjaSoft:** crea tenants, activa funciones, da soporte.

---

## 3. Principios técnicos no negociables

Estos principios son **arquitectónicos**: si se rompe alguno, hay que detener y revisar antes de seguir.

1. **Multi-tenant por diseño.** Toda tabla operativa lleva `tenant_id` (uuid) y tiene RLS activa.
2. **UUID en todas las primary keys.** No autoincrementales en datos de negocio.
3. **Timestamps universales.** `created_at`, `updated_at`, `created_by`, `updated_by` en toda entidad mutable.
4. **Baja lógica.** Usar `deleted_at` en entidades de negocio; nunca `DELETE` físico en datos con auditoría.
5. **Feature flags antes que branches de código.** Toda funcionalidad opcional vive detrás de un flag.
6. **`service_role` nunca llega al navegador.** Solo en backend (Edge Functions, scripts de migración, panel interno con server-side rendering).
7. **Auditoría desde el día uno.** Las acciones críticas escriben en `audit_logs` antes de responder al cliente.
8. **Migraciones versionadas.** Todo cambio de esquema vive en `supabase/migrations/`, nada se aplica "a mano" en producción.
9. **Mobile-first en el POS.** El POS debe operar perfecto en tablet vertical y horizontal.
10. **Dark UI como tema base** (ver `docs/11-ui-brand.md`).

---

## 4. Alcance del MVP

El MVP se divide en **núcleo obligatorio** (sin esto no hay producto) y **deseable Fase 1** (si entra, mejor; si no, no bloquea la salida).

### 4.1. Núcleo obligatorio del MVP

Estos ocho módulos son **bloqueantes**. Sin todos ellos no se sale a piloto.

#### 4.1.1. Autenticación y selección de tenant

- Login con email + password (Supabase Auth).
- Recuperación de contraseña.
- Selección de tenant cuando el usuario pertenece a más de uno.
- Selección de sucursal y caja activa.
- Logout con limpieza de contexto.

**Criterio de aceptación:** Un usuario nuevo recibe invitación por email, se loguea, elige su negocio y entra al POS en menos de 60 segundos.

#### 4.1.2. Productos, precios y stock

- Alta, edición y baja lógica de productos.
- Campos: SKU, nombre, descripción, categoría, precio de venta, costo, stock actual, stock mínimo, foto opcional, activo/inactivo.
- Categorías jerárquicas (1 nivel en MVP, n niveles en Fase 2).
- Búsqueda por nombre, SKU o código de barras.
- Importación masiva por CSV (deseable Fase 1).
- Ajuste de stock con motivo (`compra`, `merma`, `ajuste manual`, `devolución`).
- Historial de movimientos de stock por producto.

**Criterio de aceptación:** Un dueño carga 200 productos, los organiza en 5 categorías, ajusta stock con motivo y ve el historial sin tocar SQL.

#### 4.1.3. Punto de venta (POS)

- Búsqueda rápida por nombre, SKU o escaneo de código de barras.
- Carrito con cantidad editable, descuento por línea y descuento global.
- Atajos de teclado para operación rápida (búsqueda, cantidad, cobrar, anular).
- Selección de cliente opcional (para fidelización futura).
- Selección de medio de pago: efectivo, débito, crédito, transferencia, QR (configurables por tenant).
- Cálculo automático de vuelto en efectivo.
- Impresión de ticket no fiscal en MVP; ticket fiscal en F3 con AFIP.
- Anulación de venta con motivo y permiso requerido.

**Criterio de aceptación:** Un cajero hace 50 ventas en una hora sin tocar el mouse.

#### 4.1.4. Caja y turnos

- Apertura de caja con monto inicial y registro de cajero.
- Movimientos de caja: ventas, ingresos manuales, egresos manuales (con motivo).
- Arqueo intermedio (contar plata sin cerrar).
- Cierre de caja con diferencia automática vs. esperado.
- Reporte de cierre exportable (PDF/CSV).
- Bloqueo de venta si no hay caja abierta.

**Criterio de aceptación:** Un encargado abre caja, hace ventas, registra un egreso por compra de bolsas, cierra caja y exporta el Z del turno.

#### 4.1.5. Clientes

- Alta, edición y baja lógica de clientes.
- Campos: razón social/nombre, CUIT/DNI, condición frente al IVA, email, teléfono, dirección, notas.
- Búsqueda por nombre o CUIT.
- Histórico de compras del cliente.

**Criterio de aceptación:** Un encargado da de alta un cliente con CUIT válido, lo asocia a una venta y ve su historial.

#### 4.1.6. Usuarios y roles

Roles base del MVP (no editables por el cliente en Fase 1):

| Rol | Permisos clave |
|---|---|
| `owner` | Todo el tenant: configuración, usuarios, reportes, POS |
| `manager` | Configuración operativa, reportes, POS, no maneja suscripción |
| `cashier` | Solo POS y apertura/cierre de caja propia |
| `viewer` | Solo lectura de reportes |

- Invitación por email.
- Asignación de rol y sucursales permitidas.
- Suspensión y reactivación de usuario.

**Criterio de aceptación:** El dueño invita a tres cajeros, les asigna sucursales distintas y suspende a uno sin afectar a los demás.

#### 4.1.7. Reportes base

- Reporte de ventas por día / rango.
- Reporte por medio de pago.
- Reporte por categoría y por producto.
- Reporte por cajero / turno.
- Exportación CSV de cualquier reporte.

**Criterio de aceptación:** El dueño ve cuánto vendió ayer, cómo se reparte por medio de pago y qué cajero atendió cada turno.

#### 4.1.8. Suscripciones y planes (panel interno)

- Panel interno NinjaSoft para:
  - Alta de tenant.
  - Asignación de plan (Start, Pro, Business, Enterprise — ver `docs/16-subscription-model.md`).
  - Estado de suscripción: `trial`, `active`, `past_due`, `suspended`, `cancelled`.
  - Activación/desactivación de feature flags por tenant.
  - Vista de uso por tenant (ventas/día, usuarios activos, sucursales).
- Bloqueo de operación cuando la suscripción pasa a `suspended`.

**Criterio de aceptación:** Un administrador NinjaSoft da de alta un tenant nuevo, le asigna plan Pro, activa AFIP y ve la actividad del cliente en tiempo real.

### 4.2. Deseable en Fase 1 (no bloqueante)

- Importación masiva de productos por CSV.
- Lector de código de barras vía cámara en mobile.
- Configuración de impresora térmica (USB o IP).
- Promociones simples (descuento por categoría, 2x1).
- Cierres automáticos por día.

### 4.3. Fuera del MVP

Estas funcionalidades son importantes pero **explícitamente** fuera del MVP. No deben implementarse sin aprobación documentada en `decision-log.md`.

- Facturación electrónica AFIP (F3).
- Multi-sucursal real con consolidación (F4).
- Motor avanzado de promociones (combos, escalonadas, por horario).
- Programa de fidelización y puntos.
- Integración con e-commerce (Tiendanube, WooCommerce, Mercado Libre).
- App nativa móvil (backlog; evaluar PWA primero).
- Multi-moneda y multi-país.
- Integraciones con hardware avanzado (balanzas, displays de cliente).

---

## 5. Stack técnico de referencia

| Capa | Tecnología | Por qué |
|---|---|---|
| Frontend | Next.js 14+ (App Router) + TypeScript | SSR/RSC, deploy nativo en Vercel, ecosistema React |
| Estilos | Tailwind CSS + sistema propio | Velocidad + consistencia visual (ver `docs/11-ui-brand.md`) |
| UI primitives | Componentes propios + Radix UI (headless) | Accesibilidad sin perder identidad |
| Estado servidor | TanStack Query (React Query) | Cache, mutaciones, optimistic updates |
| Estado cliente | Zustand para estado global del POS | Liviano, simple, sin boilerplate |
| Backend | Supabase (Postgres + Auth + Storage + Edge Functions) | BaaS maduro, RLS nativa, escalable |
| Validación | Zod | Schemas compartidos cliente/servidor |
| Forms | React Hook Form + Zod | Mejor performance, validación integrada |
| Deploy | Vercel | Previews por rama, edge network |
| Observabilidad | Vercel Analytics + Supabase Logs + Sentry (F3+) | Métricas, errores, performance |
| Testing | Vitest (unit) + Playwright (hardening pre-piloto) | Velocidad + cobertura real |

---

## 6. Hitos del MVP

> La duración es **orientativa** para un equipo de 2 personas con asistencia de agentes. Cada hito termina con una demo interna y una entrada en `decision-log.md`.

### Hito 0 — Fundación técnica (Semana 1–2)

**Objetivo:** dejar el proyecto caminando con base sólida.

- [ ] Repositorio creado, ramas configuradas, conventions documentadas.
- [ ] Next.js + TypeScript + Tailwind funcionando.
- [ ] Supabase proyecto creado, variables en Vercel.
- [ ] Esquema base: `tenants`, `users`, `tenant_users`, `roles`, `permissions`, `subscriptions`, `audit_logs`, `feature_flags`, `tenant_feature_flags`.
- [ ] RLS activa en todas las tablas base.
- [ ] Auth funcionando con login, registro restringido, recuperación de password.
- [ ] App shell con tema `ninja-dark` y `ninja-light`.
- [ ] Componentes base: Button, Input, Card, Modal, Toast, Dropdown.
- [ ] `docs/` y `.claude/` poblados con la documentación inicial.

**Demo:** un usuario se loguea, ve el shell vacío con el tema NinjaSoft, navega entre páginas sin errores.

### Hito 1 — Catálogo y stock (Semana 3–4)

**Objetivo:** gestionar el catálogo del negocio.

- [ ] CRUD de productos con todos los campos.
- [ ] Categorías de 1 nivel.
- [ ] Búsqueda por nombre, SKU, código de barras.
- [ ] Ajuste de stock con motivo.
- [ ] Historial de movimientos por producto.
- [ ] Tabla `products`, `categories`, `stock_movements` con RLS.
- [ ] Edge Function para ajuste atómico de stock.

**Demo:** un dueño carga 50 productos en 3 categorías, ajusta stock por compra y por merma, ve el historial.

### Hito 2 — POS operativo (Semana 5–7)

**Objetivo:** vender de verdad.

- [ ] Pantalla POS con búsqueda rápida, atajos de teclado.
- [ ] Carrito con descuentos por línea y global.
- [ ] Selección de medio de pago.
- [ ] Generación de ticket no fiscal (HTML imprimible).
- [ ] Anulación con motivo y permiso.
- [ ] Tablas `sales`, `sale_items`, `payments`.
- [ ] Edge Function para crear venta atómica (resta stock + crea venta + crea pagos + escribe audit log en una sola transacción).

**Demo:** un cajero hace 20 ventas variadas, anula una, imprime el ticket y todo queda registrado correctamente.

### Hito 3 — Caja y turnos (Semana 8)

**Objetivo:** controlar el dinero.

- [ ] Apertura de caja con monto inicial.
- [ ] Movimientos manuales (ingresos/egresos con motivo).
- [ ] Arqueo intermedio.
- [ ] Cierre de caja con diferencia.
- [ ] Reporte Z exportable.
- [ ] Tabla `cash_shifts`, `cash_movements`.
- [ ] Bloqueo de venta sin caja abierta.

**Demo:** un encargado abre caja con $5.000, vende, registra un egreso de $2.000, cierra y exporta el Z.

### Hito 4 — Clientes y reportes (Semana 9–10)

**Objetivo:** información para decidir.

- [ ] CRUD de clientes con validación CUIT/DNI.
- [ ] Histórico de compras por cliente.
- [ ] Dashboard del cliente con métricas clave.
- [ ] Reportes: ventas por día/rango, por medio de pago, por categoría, por cajero.
- [ ] Exportación CSV en todos los reportes.

**Demo:** un dueño ve qué vendió esta semana, qué medio de pago más usaron, qué categoría rinde más y exporta a Excel.

### Hito 5 — Panel interno NinjaSoft (Semana 11–12)

**Objetivo:** operar el SaaS.

- [ ] Alta de tenants desde el panel interno.
- [ ] Asignación y cambio de plan.
- [ ] Estado de suscripción y transiciones.
- [ ] Activación de feature flags por tenant.
- [ ] Vista de actividad por tenant (MRR, usuarios, ventas).
- [ ] Auditoría de acciones administrativas.

**Demo:** un admin NinjaSoft crea un tenant nuevo, le activa AFIP por feature flag, ve cuánto vende y suspende otro tenant por falta de pago.

### Hito 6 — Hardening y piloto (Semana 13–14)

**Objetivo:** salir a piloto real.

- [ ] Testing manual completo siguiendo `docs/18-qa-checklist.md`.
- [ ] Pruebas de carga básicas (1.000 productos, 10.000 ventas/mes simuladas).
- [ ] Backups automáticos verificados.
- [ ] Monitoreo configurado (errores, performance, uptime).
- [ ] Documentación de soporte para el equipo NinjaSoft.
- [ ] Onboarding documentado para clientes piloto.

**Demo:** primer cliente real opera un día completo y cierra caja sin asistencia.

---

## 7. Criterios de éxito del MVP

El MVP se considera **completado** cuando se cumplen los seis criterios:

1. **Vendible:** un cliente puede operar el sistema un día completo sin tocar base de datos manualmente.
2. **Multi-tenant real:** dos clientes distintos operan en paralelo sin ver datos cruzados (validado por test automatizado y revisión manual).
3. **Trazabilidad:** toda venta, anulación, cambio de stock y movimiento de caja queda en `audit_logs`.
4. **Recuperable:** un backup restaurado de Supabase permite volver al estado anterior sin pérdida de datos críticos.
5. **Operable por NinjaSoft:** el equipo interno puede dar de alta un cliente, activarle features y darle soporte sin pedir ayuda al desarrollador.
6. **Documentado:** un desarrollador nuevo puede leer `docs/` y entender el sistema completo en menos de 4 horas.

---

## 8. Métricas operativas a medir desde el día uno

Desde el Hito 0 se debe medir:

- **Errores por sesión** (Sentry / Supabase Logs).
- **Latencia p50 y p95** del POS (búsqueda de producto, crear venta).
- **Uptime** (Vercel / Better Stack).
- **Uso por tenant**: ventas por día, usuarios activos diarios, sucursales activas.
- **Tiempo de carga inicial** (Web Vitals, LCP < 3s objetivo).
- **Tasa de error en Edge Functions** (debe ser < 0.5%).

---

## 9. Riesgos conocidos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Diseñar mal multi-tenant y tener que rehacer | Media | Crítico | RLS desde el commit 1, tests automatizados de aislamiento |
| AFIP cambia su API o certificación | Media | Alto | Encapsular en Edge Function dedicada, contrato versionado interno |
| Picos de venta saturan Supabase | Baja | Alto | Índices correctos, read replicas en plan Pro de Supabase, caché en TanStack Query |
| Equipo bloqueado por agentes mal coordinados | Alta | Medio | PM Agent (ver `.claude/agents/project-manager.md`) y reglas claras de archivos por agente |
| Personalización por cliente rompe producto base | Alta | Crítico | Toda personalización va por feature flags o settings; nada de código condicional por tenant |
| Pérdida de datos por DELETE accidental | Baja | Crítico | Baja lógica obligatoria, backups diarios, RLS impide acceso sin contexto |

---

## 10. Glosario rápido

- **Tenant:** cliente del SaaS (un negocio).
- **Tenant user:** relación entre un usuario y un tenant, con un rol.
- **Plan:** nivel de suscripción (Start, Pro, Business, Enterprise).
- **Feature flag:** interruptor que activa/desactiva una función para un tenant.
- **RLS:** Row Level Security de Postgres, asegura aislamiento de tenants.
- **POS:** Punto de venta. La pantalla de mostrador.
- **Edge Function:** función serverless de Supabase, usada para lógica de negocio sensible.
- **Z:** cierre de caja del turno (reporte tradicional).
- **CAE:** Código de Autorización Electrónico de AFIP (F3).

---

## 11. Cómo se mantiene este documento

- Cualquier cambio importante de alcance se discute, se decide y se registra en `docs/17-decision-log.md`.
- Si un hito cambia, se actualiza acá y se etiqueta el commit como `docs: actualiza MVP — hito N`.
- Este archivo es **fuente de verdad**: si algo no está acá, no es parte del MVP.

> Última revisión: editar al hacer cambios significativos.
