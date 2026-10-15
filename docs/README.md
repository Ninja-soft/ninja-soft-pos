# Documentación — NinjaSoft POS

Documentación viva del proyecto. **Si un dato no está acá, no es fuente de verdad.**

---

## Para empezar

| # | Documento | Quién lo lee |
|---|---|---|
| [00](./00-getting-started.md) | **Getting Started** — levantar el proyecto desde cero | Dev nuevo, agentes |
| [01](./01-mvp.md) | **MVP** — alcance, hitos, criterios de éxito | Todos |
| [02](./02-roadmap.md) | **Roadmap** — fases y avance | Todos |

## Arquitectura y técnico

| # | Documento | Quién lo lee |
|---|---|---|
| [03](./03-architecture.md) | **Arquitectura** | Devs, agentes técnicos |
| [04](./04-database.md) | **Database** — esquema completo | Backend, supabase-architect |
| [05](./05-security.md) | **Seguridad** — secretos, RLS, validaciones | Todos |
| [06](./06-permissions-roles.md) | **Permisos y roles** — matriz | Frontend, backend |
| [07](./07-feature-flags.md) | **Feature flags** | Todos |
| [08](./08-multi-tenant.md) | **Multi-tenant** | Backend, security |
| [09](./09-api-conventions.md) | **API conventions** | Backend, frontend |
| [10](./10-frontend-conventions.md) | **Frontend conventions** | Frontend |
| [11](./11-ui-brand.md) | **UI Brand** — sistema visual | UI, frontend |
| [12](./12-testing.md) | **Testing** | QA, todos |
| [13](./13-deployment.md) | **Deployment** — Vercel, entornos | Devops |
| [14](./14-observability.md) | **Observability** — logs, métricas | Devops |

## Producto

| # | Documento | Quién lo lee |
|---|---|---|
| [15](./15-afip-integration.md) | **AFIP integration** (Fase 3) | Backend |
| [16](./16-subscription-model.md) | **Modelo de suscripción** | Producto, ventas |

## Operativos

| # | Documento | Quién lo lee |
|---|---|---|
| [17](./17-decision-log.md) | **Decision log** — registro de decisiones | Todos |
| [18](./18-qa-checklist.md) | **QA checklist** | QA |
| [19](./19-glossary.md) | **Glosario** | Todos |
| [20](./20-hardware-pos.md) | **Hardware y mostrador PRO** — impresoras, scanners, balanzas, doble pantalla | Frontend, soporte, hardware |
| [21](./21-retail-advanced-settings.md) | **Configuración retail avanzada** — recargos, garantías, devoluciones, cuenta corriente, depósitos, Excel masivo | Producto, frontend, backend |
| [22](./22-simple-commerce-services.md) | **Comercios simples y servicios** — heladerías, peluquerías, agenda, catálogo chico y cobro rápido | Producto, frontend, ventas |
| [23](./23-restaurant-cafe-operations.md) | **Gastronomía PRO** — mesas, comandas, cocina/KDS, cafetería, heladería, delivery/takeaway | Producto, frontend, soporte |
| [24](./24-internal-ops-panel.md) | **Panel internal NinjaSoft** — suscripciones, staff, invitaciones, soporte, billing y auditoría | Operaciones, soporte, ventas |
| [25](./25-account-notifications.md) | **Centro de notificaciones** — novedades, cobros, vencimientos, cambios de plan, alertas y acciones | Producto, operaciones |
| [26](./26-design-structure-control.md) | **Control de diseño y estructura** — gate UI/UX, responsive, accesibilidad y arquitectura frontend | UI, frontend, QA |
| [27](./27-commercial-configuration-engine.md) | **Motor comercial enterprise** — planes, cuotas, add-ons, recargos, reglas, inventario PRO, offline y API | Producto, backend, operaciones |
| [28](./28-school-onboarding.md) | **Escuela y onboarding guiado** — cursos, tours, sugerencias, laboratorio y certificaciones configurables desde internal | Producto, soporte, operaciones |
| [29](./29-napse-unified-commerce-benchmark.md) | **Benchmark Napse/TOTVS** — comercio unificado, VTOL, Fiscal Flow, Promo, Omni, OMS y cockpit enterprise | Producto, estrategia, backend |
| [30](./30-nubceo.md) | **Integración NubCeo**: envío de ventas para conciliar cobros, monitor y asientos contables (API y CSV) | Producto, backend, soporte |
| [31](./31-contabilidad.md) | **Contabilidad**: plan de cuentas, asientos automáticos, mapeos, cierres, libros y export a estudios (Tango, Holistor, Xubio, Colppy, CSV) | Producto, backend, soporte |

| [32](./32-impuestos.md) | **Impuestos**: IVA por alícuota, internos, condición fiscal, comprobante, percepciones, padrones (diseños de registro) y retenciones | Producto, backend, soporte |
| [33](./33-facturacion-arca.md) | **Facturación electrónica ARCA**: WSFEv1, cola fiscal, certificados, homologación y producción, contingencia CAEA, asistente, errores frecuentes y smoke test | Producto, backend, soporte |
| [34](./34-venta-offline.md) | **Venta offline**: qué se vende sin conexión, límites del dueño, cola local, sincronización idempotente, conflictos y revisión | Producto, backend, soporte |
| [38](./38-mercadolibre.md) | **Mercado Libre**: crear la app en DevCenter (callbacks y tópicos), secrets, usuarios de test, OAuth con PKCE, webhook e inbox, cola de escrituras, stock y precio, órdenes a ventas, facturación y fases MVP, v2 y v3 | Producto, backend, soporte |
| [41](./41-mercadolibre-gestor.md) | **Gestor de Mercado Libre**: qué se tomó de ANDESMAR, publicación rápida, precios por tipo de publicación, métricas y reputación, posventa y reclamos, embudos, configuración experta, endpoints, tópicos y límites | Producto, backend, soporte |
| [40](./40-cobranza-saas.md) | **Cobranza SaaS (diseño)**: cómo NinjaSoft cobra y factura la suscripción, con ledger de plataforma, factura con CAE automática, datos fiscales con padrón ARCA, NC y ND, cuenta corriente, punitorios, mora, conciliación, KPIs con definición exacta y participación del staff (futuro) | Plataforma, operaciones, backend |
| [42](./42-mercadolibre-full.md) | **Mercado Libre Full**: depósito virtual Full por cuenta (no vendible en el POS), envíos a Full con tránsito y conciliación, etiquetas por unidad (Code 128 del código de inventario) y por bulto, cobertura y alertas de quiebre, costos, API de fulfillment usada y permisos | Producto, backend, soporte |
| [39](./39-catalogo-sync.md) | **Catálogo Tiendita sincronizado con el scraper**: feed de Railway, `FEED_TOKEN`, secrets de Supabase, cron semanal, continuación por minuto y plan B por Excel | Plataforma, operaciones |
| [36](./36-canales-delivery.md) | **Canales de delivery**: PedidosYa, Rappi, Uber Eats y MP Delivery, ingesta idempotente, comanda automática, facturación, repartidor, simulador y qué tramitar con cada app | Producto, backend, soporte |
| [Auditoría Napse vs NinjaPOS](./auditoria-napse-vs-ninjapos.md) | **Multi-sucursal:** sucursal y caja como contexto, configuración heredable, terminales, stock, clientes y reportes por sucursal (F17) | Producto, backend, UI |
| [Auditoría fiscal y contable](./auditoria-fiscal-contable-precios.md) | **Fiscal, contable, precios y compras (Argentina):** listas PRO, importaciones, IVA, internos, percepciones, retenciones, padrones, libros, asientos (F18) | Producto, backend, contable |
| [Post-mortems](./post-mortems/README.md) | Incidentes productivos y degradaciones serias | Devops, soporte |
| [Security reviews](./security-reviews/README.md) | Incidentes, revisiones y hallazgos de seguridad | Seguridad, devs |
| [Templates](./templates/post-mortem.md) | Plantillas operativas reutilizables | Todos |

## Workflows

| Documento | Tema |
|---|---|
| [Git workflow](./workflows/git-workflow.md) | Ramas, commits, PRs |
| [Agent workflow](./workflows/agent-workflow.md) | Cómo trabajar con agentes |
| [Release workflow](./workflows/release-workflow.md) | Releases y deploys |

---

## Cómo se mantiene esta carpeta

1. **Cualquier cambio importante** se registra en `17-decision-log.md`.
2. **Cambios visibles para el usuario** se anotan en `CHANGELOG.md` (raíz).
3. **El agente `docs-writer` es responsable** de la coherencia y los índices.
4. **Si algo está obsoleto, se corrige.** No se acumula deuda documental.

> Si encontrás algo desactualizado, abrí un PR con `docs:` o decile al PM.
