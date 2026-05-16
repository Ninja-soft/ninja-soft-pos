# Agent Workflow

Cómo trabajamos con los agentes de Claude Code en NinjaSoft. Quién hace qué, cómo se paraleliza y dónde están los límites.

---

## Modelo mental

El humano describe una tarea en lenguaje natural. El **Project Manager** (agente orquestador) la recibe, decide cómo dividirla, asigna especialistas y entrega un plan antes de tocar código. Cada especialista trabaja en su propio **git worktree** para no pisar al resto.

```
Humano
  ↓
Project Manager  ←→  Plan visible y aprobable
  ↓        ↓        ↓
spec1   spec2   spec3   (cada uno en su worktree)
  ↓        ↓        ↓
       Integración + PR
```

---

## Roster de agentes

Definidos en `.claude/agents/`. Cada uno con su propio archivo Markdown que describe rol, alcance y reglas.

| Agente | Rol |
|---|---|
| `project-manager` | Orquesta, planifica, asigna, integra. |
| `supabase-architect` | Schema, migraciones, RLS, triggers, funciones SQL. |
| `supabase-functions` | Edge Functions (Deno). |
| `frontend-pos` | Pantalla del POS y flujos de venta. |
| `frontend-admin` | Panel de cliente y panel interno NinjaSoft. |
| `frontend-landing` | Páginas públicas, SEO. |
| `ui-designer` | Design system, componentes reutilizables, tokens. |
| `security-auditor` | Audita RLS, secretos, validaciones, permisos. |
| `qa-engineer` | Tests, checklists, smoke tests. |
| `devops` | Vercel, CI/CD, envs, monitoreo. |
| `docs-writer` | Mantiene docs/, ADRs, CHANGELOG. |

Ver `.claude/agents/README.md` para el detalle.

---

## Flujo estándar

### 1 · Humano pide una tarea al PM

El humano describe la tarea como se la describiría a un team lead: con contexto, no con instrucciones técnicas paso a paso.

> "Necesito que se pueda suspender una venta en curso desde el POS y retomarla después. Tiene que sobrevivir un refresh del navegador y respetar permisos."

### 2 · El PM presenta el plan

Antes de codear, el PM entrega un plan con:

- Resumen de qué entendió.
- Qué especialistas intervienen y en qué orden.
- Qué se hace en paralelo y qué es secuencial.
- Qué decisiones requiere del humano antes de arrancar.
- Estimación de scope (chico/mediano/grande) y de pasos.

El humano aprueba, ajusta o rechaza.

### 3 · El PM crea worktrees

Para cada especialista que va a trabajar en paralelo:

```bash
git worktree add ../ninjasoft-pos-<scope> feat/<scope>-<descripcion>
```

Ej.:

```bash
git worktree add ../ninjasoft-pos-db feat/suspender-venta-db
git worktree add ../ninjasoft-pos-ui feat/suspender-venta-ui
```

### 4 · Cada especialista trabaja en su worktree

- Solo toca archivos de su dominio.
- Commits frecuentes con Conventional Commits.
- Cuando termina su parte, avisa al PM (en el chat) qué hizo y qué probó.

### 5 · El PM integra

- Si las ramas son independientes, cada una abre su propia PR.
- Si dependen entre sí, el PM hace `rebase` o merge interno y abre una PR única.
- Antes de entregar al humano, el PM corre el checklist universal de `18-qa-checklist.md`.

### 6 · Cierre

- Humano revisa la PR.
- Si pide cambios, el PM los reparte al especialista correspondiente.
- Una vez mergeada, el PM elimina los worktrees y borra ramas remotas.

---

## Reglas universales para todos los agentes

Estas reglas están también en cada archivo de agente individual. Las repetimos acá porque son inviolables.

### Datos y seguridad

- **`service_role` jamás en frontend.** Solo en Edge Functions y backend confiable.
- Toda tabla operativa nueva: `tenant_id` + RLS en la misma migración que la crea.
- Inputs externos siempre validados con Zod.
- No loggear datos sensibles (passwords, tokens, datos fiscales completos).

### Código

- TypeScript estricto. Nada de `any` sin comentario justificándolo.
- Conventional Commits.
- Si el cambio merece ADR, agregarla en `docs/17-decision-log.md` antes de cerrar la tarea.
- Si afecta al usuario, actualizar `CHANGELOG.md`.

### Comunicación

- El agente reporta al humano (o al PM) lo que hizo, en español, sin marketing. Hechos.
- Si encontró algo raro durante la tarea (deuda técnica, bug colateral, decisión faltante), lo dice y propone qué hacer, no lo arregla en silencio.
- Si la tarea era ambigua, pregunta antes de inventar.

### Límites

- Un agente no escribe código fuera de su dominio. Si `frontend-pos` necesita una columna nueva en la DB, le pide al PM que invoque a `supabase-architect`.
- Un agente no aprueba sus propios cambios. Toda PR la cierra el humano o el PM con confirmación humana.
- Un agente no toca producción. Solo desarrollo local y, vía PR, llegada a producción.

---

## Cuándo NO usar el PM

Para tareas chicas y atómicas, el humano puede invocar directamente al especialista correspondiente y saltearse al PM.

Ejemplos:

- "Agregame un test unitario para `calcularDescuento`." → `qa-engineer`.
- "Refactorizá este componente para que use `cva`." → `ui-designer`.
- "Renombrá esta migración, le falta el verbo." → `supabase-architect`.

Si la tarea toca dos o más dominios, o tiene cualquier ambigüedad, mejor por PM.

---

## Acceso a la base de datos

Resumen (ver `.claude/agents/supabase-architect.md` y ADR-007 para detalle).

### Desarrollo local

Los agentes y devs tienen **acceso total** a la DB local de Supabase CLI, incluyendo `service_role` en `.env.local`. Pueden:

- Crear/borrar tablas, funciones, políticas.
- Ejecutar SQL libremente.
- Resetear la DB local cuando haga falta.

Esto es necesario para iterar rápido. La DB local es desechable.

### Preview (Vercel preview deploys)

Cada PR genera un preview con Supabase preview branch. Las migraciones se aplican vía CI. Los agentes no acceden con `service_role` a preview, salvo para diagnóstico autorizado.

### Staging

Migraciones aplicadas por CI, acceso de lectura libre. Cambios estructurales solo vía PR.

### Producción

Ningún agente accede directo. **Todo cambio entra por PR → migración versionada → review humano → deploy.** Acceso `service_role` solo desde panel oficial de Supabase con doble autorización humana.

---

## Configuración local

Cada dev tiene en su máquina:

1. `.env.local` con `SUPABASE_SERVICE_ROLE_KEY` apuntando a la **DB local** (la que genera `supabase start`), nunca a producción.
2. `.claude/settings.local.json` (no versionado) con MCP de Supabase configurado para apuntar a la DB local.

Hay un `.env.example` y un `.claude/settings.local.json.example` en el repo como referencia.

---

## Ejemplo completo

**Humano al PM:**

> "Quiero que el POS soporte un descuento por porcentaje aplicable a la venta total, con permiso configurable: cashier puede aplicar hasta 10%, manager hasta 50%, owner sin límite."

**PM responde con plan:**

```
Tarea: descuento por porcentaje en venta total con permisos.

Plan:

1. supabase-architect (paralelo)
   - Agregar columna `discount_percent` en sales (nullable).
   - Migración + RLS sin cambios.

2. ui-designer (paralelo)
   - Componente DiscountInput reutilizable con validación de rango.

3. frontend-pos (depende de 1 y 2)
   - Botón "Descuento" en pantalla de cobro.
   - Llama a Edge Function que valida permiso según rol.

4. supabase-functions (paralelo a 3, depende de 1)
   - Edge function apply_discount: valida tenant, valida permiso, devuelve venta actualizada.

5. security-auditor (al final)
   - Audita que la Edge function valide rol y tenant.

6. qa-engineer (al final)
   - Tests unitarios de validación.
   - Test E2E: cashier intenta 20%, debe fallar; manager intenta 30%, debe pasar.

Decisiones pendientes:
- ¿Los límites por rol son fijos o configurables por feature flag? → necesito confirmación.

Si confirmás los límites como fijos, arranco con 1, 2 y 4 en paralelo.
```

**Humano confirma:**

> "Límites fijos por ahora. Adelante."

**PM ejecuta**, crea worktrees, asigna a cada especialista, y al cerrar entrega una PR (o varias) con la implementación completa y los tests pasando.

---

## Antipatrones

- **Codear sin plan.** Si el agente arrancó a tocar archivos antes de confirmar el alcance, se pausa y se pide el plan.
- **Un agente haciendo todo.** Si una tarea de DB + UI + Function la hizo un solo agente, casi seguro está mal modularizado.
- **PR gigante "todo en uno".** Romper en piezas reviewables.
- **Tests al final como trámite.** Los tests salen junto con el código, no después.
- **Decisiones estructurales sin ADR.** Si un agente cambió la forma de manejar errores en todo el repo y no hay ADR, vuelve atrás hasta agregarla.
