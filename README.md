# NinjaSoft POS

> Software seguro para negocios inteligentes.

POS SaaS multi-tenant para Argentina. Pensado para kioscos, textiles, retail, restaurantes y pymes que necesitan algo robusto, simple y que entienda el contexto local (AFIP, formas de pago, rubros).

---

## Stack

- **Frontend:** Next.js 14 (App Router) + TypeScript + Tailwind CSS.
- **Backend:** Supabase (PostgreSQL + Auth + Storage + Edge Functions).
- **Deploy:** Vercel.
- **Asistencia IA:** Claude Code con agentes especializados (`.claude/agents/`).

Decisiones detalladas en `docs/17-decision-log.md`.

---

## Empezar acá

1. Lee `CLAUDE.md` si vas a trabajar con Claude Code.
2. Lee `docs/00-getting-started.md` para levantar el entorno local.
3. Lee `docs/01-mvp.md` para entender qué estamos construyendo.
4. Lee `docs/workflows/agent-workflow.md` si vas a delegar tareas a agentes.

Todo lo importante vive en `docs/`. El índice está en `docs/README.md`.

---

## Estructura del repo

```
.
├── CLAUDE.md                  # Contexto maestro para Claude Code
├── README.md                  # Este archivo
├── CHANGELOG.md               # Historial de versiones
├── .env.example               # Variables de entorno (referencia)
├── .claude/
│   ├── agents/                # Subagentes especializados
│   └── settings.local.json.example
├── docs/                      # Documentación del proyecto
│   ├── 00-getting-started.md
│   ├── 01-mvp.md
│   ├── ...
│   └── workflows/
├── supabase/
│   ├── migrations/            # Migraciones versionadas
│   ├── functions/             # Edge Functions
│   ├── policies/              # Políticas RLS de referencia
│   └── seed.sql.example
├── app/                       # Código Next.js (creado por agentes)
├── components/                # Componentes UI
├── lib/                       # Helpers, utilidades, clientes
└── tests/                     # Tests unitarios, integración, E2E
```

---

## Requisitos

- Node.js 20+
- pnpm 9+
- Supabase CLI (`brew install supabase/tap/supabase` o equivalente).
- Docker (para que Supabase CLI levante Postgres local).
- Cuenta de GitHub con acceso al repo.
- Claude Code instalado (opcional pero recomendado).

---

## Setup rápido

```bash
# 1. Clonar
git clone <repo> ninjasoft-pos
cd ninjasoft-pos

# 2. Instalar deps
pnpm install

# 3. Variables de entorno
cp .env.example .env.local
# Editar .env.local con los valores que correspondan

# 4. Supabase local
supabase start
# Esto da URLs y keys locales — copiarlas a .env.local

# 5. Aplicar migraciones
supabase db reset

# 6. (Opcional) seed de datos de ejemplo
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" -f supabase/seed.sql

# 7. Levantar Next.js
pnpm dev
```

Detalles en `docs/00-getting-started.md`.

---

## Trabajar con agentes de Claude Code

Si tenés Claude Code instalado:

1. Abrí el repo: `claude` (desde la raíz).
2. Pedile al **Project Manager** lo que necesités. Ej.: *"Necesito agregar suspensión de venta al POS."*
3. El PM te va a entregar un plan antes de tocar código. Aprobás, ajustás o rechazás.
4. Los especialistas trabajan en paralelo en sus worktrees y entregan PR(s) listas para revisión.

Ver `docs/workflows/agent-workflow.md` para el flujo completo.

---

## Scripts útiles

```bash
pnpm dev              # Next.js en modo dev
pnpm build            # Build de producción
pnpm lint             # ESLint
pnpm type-check       # TypeScript sin emitir
pnpm test             # Vitest
pnpm test:e2e         # Playwright

supabase start        # Levantar stack local
supabase stop         # Bajar stack local
supabase db reset     # Reset + reaplicar migraciones
supabase migration new <nombre>   # Nueva migración
```

---

## Convenciones esenciales

- **Multi-tenant desde el primer commit.** Toda tabla operativa lleva `tenant_id` + RLS. Ver `docs/08-multi-tenant.md`.
- **`service_role` jamás en el frontend.** Solo en Edge Functions. Ver `docs/05-security.md`.
- **Feature flags antes que branches de código.** Ver `docs/07-feature-flags.md`.
- **Conventional Commits, ramas con prefijo, PRs pequeñas.** Ver `docs/workflows/git-workflow.md`.
- **Toda decisión estructural tiene su ADR.** Ver `docs/17-decision-log.md`.

---

## Licencia

Propietario. © NinjaSoft. No distribuir sin autorización.

---

## Contacto

Equipo interno NinjaSoft. Para temas técnicos, abrí un issue. Para temas de producto, hablá con el equipo de producto.
