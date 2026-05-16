# Sistema de agentes — NinjaSoft POS

> Este directorio define el equipo de **agentes especializados** que trabajan sobre NinjaSoft POS, coordinados por un Project Manager.

---

## Filosofía

Un solo agente genérico se confunde, duplica trabajo, rompe cosas que no entendía y mezcla responsabilidades. Un **equipo de agentes especializados con un PM al frente** se comporta como un equipo de desarrollo real:

- El PM analiza, planifica y delega.
- Cada especialista tiene un alcance claro y archivos permitidos.
- Las tareas paralelas usan worktrees o ramas separadas.
- Cada agente entrega trazabilidad para que el siguiente continúe sin perder contexto.

---

## Cómo usar el sistema

### 1. Toda tarea entra por el Project Manager

Al abrir una sesión de Claude Code, el primer prompt es:

```
Actuá como el Project Manager descrito en .claude/agents/project-manager.md.

Tarea:
[lo que quiero hacer]

Antes de delegar:
1. Leé CLAUDE.md, docs/01-mvp.md, docs/02-roadmap.md y docs/17-decision-log.md.
2. Producí el plan de ejecución completo.
3. Esperá mi confirmación antes de invocar especialistas.
```

### 2. El PM produce un plan

El plan dice exactamente:

- Qué sub-tareas hay.
- Qué agente especialista hace cada una.
- Qué archivos tocará cada uno.
- Qué corre en paralelo y qué es secuencial.
- Criterios de aceptación.

### 3. Ejecutar especialistas

Para cada sub-tarea, abrir una sesión (o worktree) con el prompt del especialista:

```
Actuá como el agente descrito en .claude/agents/<especialista>.md.

Sub-tarea asignada por el PM:
[descripción]

Archivos permitidos: [lista]
Criterios de aceptación: [lista]
```

### 4. Paralelismo seguro con git worktrees

```bash
# Crear worktree para cada agente paralelo
git worktree add ../ninjasoft-pos-db    feature/promos-db
git worktree add ../ninjasoft-pos-admin feature/promos-admin
git worktree add ../ninjasoft-pos-pos   feature/promos-pos

# Abrir Claude Code en cada uno
cd ../ninjasoft-pos-db    && claude
cd ../ninjasoft-pos-admin && claude
cd ../ninjasoft-pos-pos   && claude
```

### 5. Cierre

Cuando todos los especialistas terminan, el PM:

- Revisa los entregables.
- Verifica que cumplen los criterios.
- Escribe la entrada en `docs/17-decision-log.md`.
- Actualiza `CHANGELOG.md`.
- Marca el progreso en `docs/02-roadmap.md`.

---

## Roster de agentes

| Agente | Especialidad | Archivo |
|---|---|---|
| **project-manager** | Orquestación, planificación, delegación | [project-manager.md](./project-manager.md) |
| **frontend-pos** | UI del punto de venta | [frontend-pos.md](./frontend-pos.md) |
| **frontend-admin** | Panel cliente y panel interno | [frontend-admin.md](./frontend-admin.md) |
| **frontend-landing** | Páginas públicas y marketing | [frontend-landing.md](./frontend-landing.md) |
| **ui-designer** | Sistema de diseño y brand compliance | [ui-designer.md](./ui-designer.md) |
| **supabase-architect** | Modelo de datos, migraciones, RLS | [supabase-architect.md](./supabase-architect.md) |
| **supabase-functions** | Edge Functions, integraciones backend | [supabase-functions.md](./supabase-functions.md) |
| **security-auditor** | Auditoría de seguridad y RLS | [security-auditor.md](./security-auditor.md) |
| **qa-engineer** | Tests, checklists, bug reports | [qa-engineer.md](./qa-engineer.md) |
| **docs-writer** | Documentación viva | [docs-writer.md](./docs-writer.md) |
| **devops** | Vercel, CI/CD, variables, monitoreo | [devops.md](./devops.md) |

---

## Reglas universales para todos los agentes

1. **Leer antes de tocar.** `CLAUDE.md` + el archivo del propio agente + los `docs/` relevantes.
2. **Respetar el alcance.** Si una tarea requiere tocar archivos fuera del alcance, devolver al PM para re-delegar.
3. **Entregar trazabilidad.** Cada sesión termina con un resumen estructurado de lo hecho.
4. **No saltarse principios del MVP.** Si un atajo rompe multi-tenant o RLS o auditoría, no se toma.
5. **Ante duda, preguntar.** Mejor pausar y aclarar que producir código que se va a deshacer.

---

## Anti-patrones a evitar

- ❌ Un solo agente intentando todo.
- ❌ Dos agentes editando los mismos archivos en paralelo.
- ❌ Saltar el PM "porque la tarea es chica".
- ❌ Especialista que mete cambios fuera de su alcance "ya que estaba".
- ❌ Cerrar sesión sin actualizar decision-log si hubo decisión.
- ❌ Aprobar trabajo de un agente sin que el QA o el Security lo revisen cuando aplica.

---

## Variantes futuras

A medida que crezca el producto, podrían sumarse:

- `mobile-agent` — para una app PWA o nativa.
- `data-analyst-agent` — para queries analíticos y reportes complejos.
- `support-agent` — para automatizar respuestas y triage de soporte.
- `afip-specialist` — para toda la integración fiscal AFIP cuando se profundice.

Cada nuevo agente debe seguir el mismo contrato: archivo en este directorio, misión clara, archivos permitidos/prohibidos, entregable estándar, prompt de arranque.
