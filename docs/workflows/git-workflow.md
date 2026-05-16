# Git Workflow

Cómo trabajamos con Git en NinjaSoft. Reglas pensadas para un equipo chico con agentes que generan código en paralelo.

---

## Ramas

### Rama principal

- `main` — siempre desplegable. Lo que está acá es lo que está en producción (o a un deploy de distancia).

### Ramas de trabajo

Prefijos obligatorios. El nombre describe qué hace, no quién lo hace.

- `feat/` — funcionalidad nueva. Ej.: `feat/pos-suspender-venta`.
- `fix/` — corrección de bug. Ej.: `fix/cierre-caja-arqueo`.
- `chore/` — tareas que no afectan al usuario: deps, refactors internos, configuración. Ej.: `chore/upgrade-supabase-cli`.
- `docs/` — solo cambios de documentación. Ej.: `docs/agregar-adr-pagos`.
- `refactor/` — reorganización de código sin cambio funcional.
- `test/` — solo tests nuevos o ajustes a tests existentes.

Usar guiones, todo minúscula, sin tildes ni eñes.

### Una rama por tarea

Una rama hace una cosa. Si la PR termina mezclando tres temas distintos, se divide en tres ramas.

---

## Commits

### Conventional Commits

Formato:

```
<tipo>(<scope opcional>): <mensaje en presente>
```

Tipos: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`.

Ejemplos:

- `feat(pos): permitir suspender venta con F4`
- `fix(caja): corregir cálculo de arqueo cuando hay egresos`
- `chore: actualizar dependencias de tailwind`
- `docs(adr): agregar ADR-009 sobre proveedor de pagos`

### Reglas

- En español, en presente, sin punto al final.
- Una idea por commit. Si tu commit dice "y", probablemente son dos commits.
- Si el commit toca migraciones, mencionarlo: `feat(db): agregar tabla customers (migración 20260120120000)`.
- Si el commit cierra un issue, mencionarlo: `fix(pos): evitar doble cobro (#42)`.

### Lo que NO va en mensajes de commit

- "Cambios varios".
- "WIP" (en `main` nunca; en una rama personal está bien, pero antes del PR se hace `rebase -i` y se limpia).
- Nombres de personas o agentes ("hecho por Claude", "fix de Juan").
- Emojis (excepto en commits de release tipo `release: v0.4.0` si el equipo lo decide).

---

## Pull Requests

### Cuándo abrir una PR

Cuando la rama está lista para revisión. Si está en progreso y solo se quiere feedback temprano, abrir como **draft**.

### Título

Mismo formato que un commit: `tipo(scope): descripción`. Si la PR es un solo commit, suele coincidir con el mensaje del commit.

### Descripción

Plantilla recomendada:

```markdown
## Qué cambia

Breve descripción en lenguaje natural, no técnico.

## Por qué

Contexto: qué problema resuelve, qué decisión la motiva.

## Cómo probarlo

Pasos para reproducir y verificar.

## Checklist

- [ ] Pasa `pnpm lint`, `pnpm type-check`, `pnpm test`.
- [ ] Tests nuevos o ajustados (si aplica).
- [ ] Migración con naming versionado (si aplica).
- [ ] RLS habilitada en tablas nuevas (si aplica).
- [ ] `CHANGELOG.md` actualizado (si afecta al usuario).
- [ ] `.env.example` actualizado (si agregó env vars).
- [ ] ADR agregada (si la decisión es estructural).

## Screenshots / GIFs

Si cambia UI, mostrar antes/después.
```

### Tamaño

Ideal: < 400 líneas cambiadas. Si pasa de 800, casi siempre conviene dividir.

### Reviews

Mínimo un review antes de mergear. Si la PR toca RLS, pagos, AFIP o el modelo de datos, revisión obligatoria de quien tiene más contexto en ese tema.

Para revisar lo que generó un agente, no se aprueba "porque parece estar bien". Se lee, se ejecuta, se cuestiona. El humano firma con su nombre, no el agente.

---

## Merge

### Estrategia

- **Squash and merge** por default. La rama queda como un solo commit en `main`.
- Excepción: si los commits cuentan una historia clara y vale la pena preservarla, **rebase and merge**.
- **Nunca merge commits** en `main`.

### Después del merge

- Borrar la rama remota.
- Si era una rama local con worktree, eliminar el worktree con `git worktree remove`.

---

## Hooks y verificaciones

### Pre-commit

Configurado con Husky + lint-staged. Corre en cada commit:

- `eslint --fix` sobre archivos modificados.
- `prettier --write` sobre archivos modificados.
- `tsc --noEmit` (rápido, sin generar archivos).

### Pre-push

- `pnpm test` (suite rápida, sin E2E).

### CI (GitHub Actions)

Corre en cada push de cualquier rama:

- Lint completo.
- Type-check completo.
- Tests unitarios + integración.
- Build de producción.
- (En `main` y release branches) E2E con Playwright.

Si CI falla, no se puede mergear. Sin excepciones.

---

## Casos especiales

### Hotfixes en producción

1. Rama desde `main`: `fix/descripcion-corta`.
2. Cambio mínimo, foco solo en el bug.
3. PR con label `hotfix`. Review acelerado.
4. Merge a `main` → deploy automático.
5. Verificar en producción.

### Reverts

Si algo rompe en producción y no se puede arreglar rápido: `git revert` del merge commit (o equivalente desde el panel de GitHub). Después se investiga con calma.

### Migraciones conflictivas

Si dos ramas crean migraciones con timestamps cercanos:

- La que se mergea segunda tiene que **rebasarse** sobre `main` y renombrar su archivo con un timestamp posterior.
- Si la migración ya se aplicó en preview, generar una migración correctiva en vez de modificar la existente.

### Cuándo NO usar Git para resolver algo

- Si la duda es de producto, hablar antes de codear.
- Si la duda es de arquitectura, escribir ADR antes de la PR.
- Si el cambio toca varios módulos a la vez, planificarlo con el PM agente antes de abrir ramas.

---

## Comandos pocket

```bash
# Crear rama
git checkout -b feat/mi-feature

# Limpiar commits antes de PR
git rebase -i origin/main

# Actualizar rama con main
git fetch origin
git rebase origin/main

# Crear worktree para que un agente trabaje en paralelo
git worktree add ../ninjasoft-pos-supabase feat/supabase-trabajo

# Eliminar worktree después
git worktree remove ../ninjasoft-pos-supabase

# Ver todos los worktrees activos
git worktree list
```

Para el uso de worktrees con agentes, ver `agent-workflow.md`.
