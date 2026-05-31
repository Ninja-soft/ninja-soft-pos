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
