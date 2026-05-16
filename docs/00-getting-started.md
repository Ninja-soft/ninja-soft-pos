# Getting Started — NinjaSoft POS

Guía operativa para poner el proyecto en marcha desde cero. Leer antes de tocar código.

## 1. Requisitos previos

- **Node.js** ≥ 20 LTS y **pnpm** ≥ 9 (preferido sobre npm/yarn).
- **Git** ≥ 2.40 y **GitHub Desktop** o CLI (`gh`).
- **Cuenta Supabase** con acceso a la organización NinjaSoft.
- **Cuenta Vercel** vinculada a la organización GitHub.
- **Supabase CLI** (`npm i -g supabase`).
- **Claude Code** instalado y autenticado.
- **VS Code** o editor compatible con Tailwind IntelliSense.

## 2. Primer arranque

```bash
# 1. Clonar el repositorio
git clone git@github.com:ninjasoft/ninjasoft-pos.git
cd ninjasoft-pos

# 2. Instalar dependencias
pnpm install

# 3. Copiar variables de entorno
cp .env.example .env.local

# 4. Pedirle a un mantenedor los valores reales para .env.local
#    (NUNCA comitear secretos)

# 5. Levantar Supabase local
supabase start

# 6. Aplicar migraciones
supabase db reset

# 7. Cargar seed de desarrollo
psql "$DATABASE_URL" -f supabase/seed.sql

# 8. Levantar el frontend
pnpm dev
```

La aplicación queda disponible en `http://localhost:3000`. Supabase Studio local en `http://localhost:54323`.

## 3. Variables de entorno mínimas

Ver `.env.example` para la lista completa. Las críticas:

| Variable | Dónde | Notas |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Front + Back | Pública. URL del proyecto. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Front + Back | Pública. Respeta RLS. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Solo backend / Edge Functions** | **Nunca** llega al navegador. |
| `APP_ENV` | Todos | `local`, `preview`, `staging`, `production`. |

## 4. Estructura del repositorio

```
ninjasoft-pos/
├── app/                    # Rutas Next.js (App Router)
├── components/             # UI compartida
├── lib/                    # Helpers (supabase, permissions, audit)
├── modules/                # Lógica de negocio por módulo
├── supabase/
│   ├── migrations/         # SQL versionado
│   ├── functions/          # Edge Functions
│   └── policies/           # Documentación de RLS
├── docs/                   # ESTE directorio
├── .claude/
│   ├── agents/             # Agentes especializados
│   └── settings.local.json # Config local de MCP
├── CLAUDE.md               # Contexto maestro para agentes
└── README.md
```

Ver [`03-architecture.md`](./03-architecture.md) para el detalle.

## 5. Antes del primer commit

1. Leer [`CLAUDE.md`](../CLAUDE.md) — contexto y principios no negociables.
2. Leer [`01-mvp.md`](./01-mvp.md) — alcance y criterios de éxito.
3. Leer [`02-roadmap.md`](./02-roadmap.md) — hito vigente.
4. Leer [`workflows/git-workflow.md`](./workflows/git-workflow.md) — flujo de ramas y PRs.
5. Verificar que `pnpm lint`, `pnpm typecheck` y `pnpm test` pasan en limpio.

## 6. Trabajar con agentes

Ver [`workflows/agent-workflow.md`](./workflows/agent-workflow.md). Resumen rápido:

```bash
# Invocar al Project Manager para cualquier tarea no trivial
claude

# En la sesión:
> @project-manager
> Tarea: <descripción clara y acotada>
```

El PM analiza, propone un plan, y delega a los especialistas (frontend-pos, supabase-architect, etc.).

## 7. Checklist del primer día

- [ ] Repositorio clonado y `pnpm install` exitoso.
- [ ] `.env.local` completo y funcionando.
- [ ] Supabase local levantado, migraciones aplicadas.
- [ ] `pnpm dev` levanta sin errores.
- [ ] Login funciona contra Supabase local.
- [ ] `CLAUDE.md` y `docs/01-mvp.md` leídos.
- [ ] Claude Code autenticado y agentes detectables (`/agents`).
- [ ] Primera rama creada siguiendo convención (`feature/<short-name>`).

## 8. Problemas comunes

| Problema | Causa probable | Solución |
|---|---|---|
| `supabase start` falla | Docker no corriendo | Iniciar Docker Desktop. |
| Migraciones no aplican | Conflicto de versiones | `supabase db reset` (¡destructivo!). |
| Variables no leídas | `.env.local` mal ubicado | Debe estar en raíz, no en `app/`. |
| Login 401 | Anon key incorrecta | Verificar `NEXT_PUBLIC_SUPABASE_ANON_KEY`. |
| RLS bloquea queries | Falta `tenant_id` en sesión | Verificar `current_tenant_id()`. |

## 9. Siguientes pasos

Una vez que el setup esté funcionando:

1. Familiarizarse con el sistema de agentes — ver [`.claude/agents/README.md`](../.claude/agents/README.md).
2. Revisar la base de datos — ver [`04-database.md`](./04-database.md).
3. Entender la convención de UI — ver [`11-ui-brand.md`](./11-ui-brand.md).
4. Conocer los workflows — ver [`workflows/`](./workflows/).

> **Regla de oro.** Si algo no está documentado, documentarlo antes de avanzar. La documentación viva es lo que permite que los agentes (y nuevos integrantes) trabajen sin pedir contexto cada vez.
