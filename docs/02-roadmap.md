# Roadmap — NinjaSoft POS

Plan de ejecución por fases. Cada fase tiene salida verificable, criterios de éxito y demo concreta. Este documento se actualiza al cierre de cada hito.

> **Convención.** Los hitos del MVP (`H0`–`H6`) están detallados en [`01-mvp.md`](./01-mvp.md). Este documento extiende el plan más allá del MVP.

## Visión por fases

| Fase | Nombre | Duración estimada | Estado |
|---|---|---|---|
| **F0** | Fundación técnica | 2 semanas | 🔴 No iniciado |
| **F1** | MVP vendible (POS + Admin) | 10–12 semanas | 🔴 No iniciado |
| **F2** | Plataforma SaaS (panel interno + suscripciones) | 4–6 semanas | 🔴 No iniciado |
| **F3** | Integración AFIP y producción | 4–6 semanas | 🔴 No iniciado |
| **F4** | Escalado: multi-sucursal, hardware, integraciones | 8–10 semanas | 🟡 Planificación |
| **F5** | Perfiles por rubro y marketplace | 10–14 semanas | 🟡 Planificación |

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

## Backlog para fases siguientes (no priorizado)

- App móvil nativa (React Native) para gerentes en movimiento.
- Modo offline con sincronización al recuperar conexión.
- Sistema de fidelización (puntos, niveles).
- Compras y proveedores.
- Cuenta corriente de clientes.
- Cuenta corriente de proveedores.
- Producción y recetas (para restaurantes y manufactura).
- E-commerce integrado (alternativa a Tienda Nube).
- Multi-país (Uruguay, Chile, México) — requiere abstraer facturación electrónica.

---

## Cómo se actualiza este roadmap

1. Al cerrar una fase, el PM actualiza el estado en la tabla principal y agrega un resumen de aprendizajes en [`17-decision-log.md`](./17-decision-log.md).
2. Cambios de prioridad mayor requieren PR con justificación.
3. Estimaciones de duración se ajustan según velocidad real medida en fases anteriores.

> **Principio.** El roadmap es un mapa, no una promesa. Lo que sí es promesa: cada fase termina con software que funciona, no con un avance del 80%.
