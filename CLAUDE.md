# CLAUDE.md — Contexto maestro de NinjaSoft POS

> Este archivo es el **primer documento** que cualquier sesión de Claude (Claude Code, Claude Cowork, agente especializado) debe leer al arrancar. Define el proyecto, las reglas no negociables y el sistema de trabajo.

---

## 1. ¿Qué es NinjaSoft POS?

POS SaaS multi-tenant para Argentina. Soluciones para kioscos, textiles, retail, restaurantes y pymes.

Tres planos del sistema:
- **Producto:** lo que usan los clientes finales (POS, panel del cliente).
- **Plataforma:** lo que administra NinjaSoft (panel interno, tenants, planes).
- **Operaciones:** soporte, auditoría, suscripciones, trazabilidad.

Visión completa: [`docs/01-mvp.md`](docs/01-mvp.md).

---

## 2. Stack

- **Frontend:** Next.js 14+ (App Router) + TypeScript + Tailwind CSS.
- **Backend:** Supabase (Postgres + Auth + Storage + Edge Functions).
- **Deploy:** Vercel.
- **Estado servidor:** TanStack Query.
- **Estado cliente (POS):** Zustand.
- **Validación:** Zod.
- **Forms:** React Hook Form + Zod.
- **Tests:** Vitest + Playwright.

Detalle: [`docs/03-architecture.md`](docs/03-architecture.md).

---

## 3. Principios no negociables

Estas reglas son **arquitectónicas**: romper alguna obliga a detener y revisar.

1. **Multi-tenant desde el commit 1.** Toda tabla operativa lleva `tenant_id` con RLS activa.
2. **`service_role` nunca en frontend.** Solo en Edge Functions o scripts server-side.
3. **Auditoría obligatoria.** Acciones críticas escriben en `audit_logs` antes de responder.
4. **Migraciones versionadas.** Todo cambio de esquema vive en `supabase/migrations/`.
5. **Feature flags antes que branches de código.** Toda función opcional vive detrás de un flag.
6. **Baja lógica.** `deleted_at` en lugar de `DELETE` físico para datos de negocio.
7. **UUID primary keys** en todas las entidades de negocio.
8. **Mobile-first** en POS.
9. **Tema base: `ninja-dark`** (ver brand book).
10. **Documentación viva.** Las decisiones se registran, no se memorizan.

---

## 4. Sistema de agentes

Este proyecto trabaja con un **equipo de agentes especializados** orquestados por un Project Manager. **Toda tarea entra por el PM.**

- Roster completo: [`.claude/agents/README.md`](.claude/agents/README.md).
- Project Manager: [`.claude/agents/project-manager.md`](.claude/agents/project-manager.md).

Patrón de uso:

```
Actuá como el Project Manager descrito en .claude/agents/project-manager.md.

Tarea:
[descripción]
```

El PM:
1. Lee contexto.
2. Produce plan estructurado.
3. Delega a especialistas (en paralelo cuando es seguro).
4. Cierra con entrada en decision-log y changelog.

---

## 5. Estructura del repositorio

```
ninjasoft-pos/
├── app/                          # Next.js App Router
│   ├── (public)/                 # landing, pricing
│   ├── (auth)/                   # login, signup, recover
│   ├── (pos)/                    # punto de venta
│   ├── (admin)/                  # panel del cliente
│   └── (internal)/               # panel interno NinjaSoft
├── components/
│   ├── ui/                       # primitivos (Button, Input, Card…)
│   ├── pos/
│   ├── admin/
│   ├── internal/
│   └── landing/
├── modules/                      # lógica de negocio por dominio
│   ├── pos/
│   ├── products/
│   ├── stock/
│   ├── cash-register/
│   ├── customers/
│   ├── sales/
│   ├── reports/
│   ├── subscriptions/
│   └── auth/
├── lib/
│   ├── supabase/                 # clientes Supabase
│   ├── edge/                     # llamadas tipadas a Edge Functions
│   ├── permissions/              # roles, permisos, feature flags
│   ├── audit/                    # helpers de auditoría
│   ├── theme/                    # tokens y helpers de tema
│   └── utils/
├── hooks/
├── types/
│   └── database.ts               # generado por Supabase CLI
├── supabase/
│   ├── migrations/
│   ├── functions/
│   ├── policies/                 # documentación de policies RLS
│   └── seed.sql
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── factories/
├── scripts/
├── public/
├── docs/                         # documentación viva (ver docs/README.md)
├── .claude/
│   ├── agents/                   # definiciones de agentes
│   └── settings.local.json       # config local (no commitear con secretos)
├── .env.example
├── CLAUDE.md                     # este archivo
├── CHANGELOG.md
├── README.md
└── package.json
```

---

## 6. Convenciones

### Git

- `main` = producción. Nunca commit directo.
- Ramas: `feature/<nombre>`, `fix/<nombre>`, `chore/<nombre>`, `docs/<nombre>`.
- Commits: [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Una rama, un PR, un objetivo claro.

Detalle: [`docs/workflows/git-workflow.md`](docs/workflows/git-workflow.md).

### Código

- TypeScript estricto (`strict: true`).
- ESLint + Prettier.
- Imports absolutos con alias `@/` para `src/` (o `./` si no usás src).
- Componentes con `forwardRef` y `displayName` cuando hace falta.
- Tests al lado del archivo o en `tests/` (decidir y mantener consistencia).

### Base de datos

Ver [`docs/04-database.md`](docs/04-database.md) y el agente `supabase-architect`.

### Convención de features de plan

Toda nueva funcionalidad, módulo o medio de pago se agrega como **check en la tabla `features`** y se marca por plan en **`plans.limits.modules`** según análisis comercial. El **gating real** (`tenant_has_feature` / `tenant_has_feature_for` + los triggers correspondientes, p. ej. el de `payments` para medios de pago) **debe cubrirla**: la UI nunca es la única barrera. La UI la muestra en la **matriz interna del editor de planes** y en la **comparación de planes** (`lib/saas/planComparison.ts`). Para medios de pago, la feature key coincide con `payment_providers.key` y se mapea en `payment_method_plan_key(method)`; el espejo de UI vive en `components/pos/PosModals.tsx` (`PROVIDER_FEATURE`). Sumá también su copy en `lib/saas/featureInfo.ts` (desc / impact / minPlan).

**Toda función nueva DEBE** (checklist, sin saltarse ningún paso):

1. **Key en `features`** (migración versionada con `is_basic` y `grupo` correctos).
2. **Marcada por plan en `plans.limits.modules`** según análisis comercial.
3. **Gating real server-side**: `tenant_has_feature_for(tenant, key)` en el trigger / RPC / policy RLS que escribe el dato. **La UI NUNCA es la única barrera** — si sólo está en el front, no está gateada.
4. **Copy en `lib/saas/featureInfo.ts`** (desc / impact / minPlan).
5. **Aparece en la comparación de planes** (`lib/saas/planComparison.ts`, derivado de la matriz; nada hardcodeado por nivel).

**Clasificá la función** en una de estas categorías y respetá su tratamiento:

- **BASE** — siempre on; es parte de pagar cualquier plan. Se marca `is_basic=true` (entra por defecto en todo plan salvo apagado explícito `modules[key]=false`). Ej.: `pos`, `caja`, `stock`, `productos`, `clientes`, `panel_dueno`, `devoluciones`.
- **OPTIONAL** — gateada por plan (`is_basic=false`, se activa por nivel comercial). Ej.: `garantias`, `cuenta_corriente`, `listas_precios`, `variantes`, `tickets_pro`.
- **ADDON** — no entra por plan; se contrata por negocio (tabla de addons). Ej.: `asistente_ia`. No se gatea por `modules`.
- **FLAG-OPERATIVO** — elección del dueño según su rubro, gratis y sin costo de plan; es un switch operativo (`pos_settings`), no una feature de plan. Ej.: mesas/KDS/comandas, delivery propio, venta libre, PLU, scanner.
- **MARKETING-FUTURO** — prometida en la comparación pero **la función todavía no existe**, por lo que no se puede enforce hoy (sólo copy/marketing). Ej.: `promociones`, `facturacion_afip`, `roles_permisos` (granular), `metricas_avanzadas`, `backup`, `api_publica`, `soporte_prioritario`. Documentá la deuda en el decision-log.

**Fuente de verdad de la matriz:** el **editor de planes en internal** (`components/internal/plans/PlanEditorModal.tsx` → `FeatureMatrix`), que lee `features` + `plans.limits.modules`. Lo que se vea ahí es lo que el cliente recibe; `planComparison.ts` y el panel del dueño derivan de los mismos datos.

---

## 7. Antes de empezar a trabajar

Cualquier sesión (humano o agente) debe:

1. Leer este archivo.
2. Leer [`docs/01-mvp.md`](docs/01-mvp.md) y [`docs/02-roadmap.md`](docs/02-roadmap.md).
3. Revisar las últimas entradas de [`docs/17-decision-log.md`](docs/17-decision-log.md) y [`CHANGELOG.md`](CHANGELOG.md).
4. Identificar qué agente corresponde a la tarea.
5. Si es tarea no trivial → ir vía PM.

---

## 8. Reglas de comunicación con el equipo humano

- **Plan antes de código** en tareas no triviales.
- **Resumen al cerrar** con archivos tocados, riesgos y próximo paso.
- **Sin código de relleno.** Si una sección de archivo no cambia, no se reescribe.
- **Honestidad ante bloqueos.** Si falta información, se pide; no se asume.
- **Sin "ya que estaba".** No mezclar cambios fuera del alcance del PR.

---

## 9. Archivos sensibles

Estos archivos requieren cuidado especial. No tocarlos sin razón clara:

- `supabase/migrations/*` aplicadas (son inmutables; se corrigen con migraciones nuevas).
- `next.config.mjs` (afecta build y producción).
- `tailwind.config.ts` (afecta el sistema visual entero).
- `package.json` y `pnpm-lock.yaml` (mantener versiones consistentes).
- Cualquier archivo en `.env*`.

---

## 10. Comandos de bolsillo

```bash
# Setup local
pnpm install
pnpm db:start            # Supabase local con Docker
pnpm db:reset            # reset + migraciones + seed
pnpm db:types            # regenera types/database.ts
pnpm dev                 # Next.js dev

# Calidad
pnpm lint
pnpm typecheck
pnpm test

# Base de datos
pnpm db:migrate:new <nombre>
supabase functions serve
```

---

## 11. Referencia rápida de documentos

| Necesito… | Voy a… |
|---|---|
| Saber qué hace el producto | [`docs/01-mvp.md`](docs/01-mvp.md) |
| Ver en qué hito estamos | [`docs/02-roadmap.md`](docs/02-roadmap.md) |
| Entender la arquitectura | [`docs/03-architecture.md`](docs/03-architecture.md) |
| Diseñar una tabla | [`docs/04-database.md`](docs/04-database.md), `supabase-architect` |
| Manejar permisos | [`docs/06-permissions-roles.md`](docs/06-permissions-roles.md) |
| Implementar UI | [`docs/11-ui-brand.md`](docs/11-ui-brand.md), `ui-designer` |
| Hacer un deploy | [`docs/13-deployment.md`](docs/13-deployment.md), `devops` |
| Reportar un bug | `qa-engineer` |
| Empezar una feature | Project Manager |

---

> Si después de leer esto tenés dudas, pedí al PM que las aclare antes de tocar código.
