# 17 · Decision Log (ADRs)

Registro de **decisiones de arquitectura** (Architecture Decision Records). Toda decisión técnica relevante que afecte el producto, la arquitectura, la seguridad o la operación se documenta acá.

Si no está acá, no pasó. Si cambió, se agrega una nueva ADR que supersede la anterior.

---

## ¿Cuándo escribir una ADR?

- Cambia el stack o una librería principal.
- Cambia el modelo de datos de forma estructural.
- Se introduce una nueva integración externa.
- Se cambia el modelo de permisos, planes o feature flags.
- Se decide un patrón que va a aplicar a todo el repo (manejo de errores, validaciones, autenticación, etc.).
- Se descarta una alternativa que alguien podría volver a proponer.

Si la duda es "¿esto amerita ADR?", la respuesta es **sí**. Cuesta poco escribirla y vale mucho cuando alguien (humano o agente) revisita el código meses después.

---

## Cómo numerar

- Formato: `ADR-NNN — Título corto`
- NNN secuencial, sin reutilizar.
- Una ADR no se borra ni se edita. Si se supera, se agrega una nueva con estado `Superseded by ADR-XXX`.

---

## Template

```markdown
## ADR-NNN — Título corto y descriptivo

**Fecha:** YYYY-MM-DD
**Estado:** Proposed | Accepted | Deprecated | Superseded by ADR-XXX
**Autor:** Nombre o agente que propone
**Decisión tomada por:** Quien aprueba

### Contexto

Qué problema estamos resolviendo. Qué fuerzas están en juego (técnicas, de negocio, de plazos, de equipo). Hechos relevantes.

### Decisión

Qué decidimos. En presente, directo, sin ambigüedad.

### Alternativas consideradas

- **Opción A:** descripción breve. Por qué no.
- **Opción B:** descripción breve. Por qué no.
- **Opción elegida:** por qué sí.

### Consecuencias

- **Positivas:** qué ganamos.
- **Negativas:** qué cedemos. Qué deuda asumimos.
- **Seguimiento:** qué hay que revisar y cuándo.

### Referencias

- Links a PRs, issues, docs externos, conversaciones relevantes.
```

---

## ADRs vigentes

A continuación quedan registradas las ADRs iniciales del proyecto. Cada nueva decisión se agrega al final.

---

## ADR-001 — Stack base: Next.js 14 + Supabase + Vercel

**Fecha:** 2026-01-15
**Estado:** Accepted
**Autor:** Equipo NinjaSoft
**Decisión tomada por:** Equipo NinjaSoft

### Contexto

Necesitamos arrancar un POS SaaS multi-tenant para Argentina con dos personas. Los criterios fueron: velocidad de entrega, hosting con previews automáticos por rama, backend con Auth + DB + Storage + Functions sin armar infraestructura propia, y un ecosistema con buen soporte para agentes IA.

### Decisión

Stack inicial:

- **Frontend:** Next.js 14 (App Router) + TypeScript + Tailwind CSS.
- **Backend:** Supabase (PostgreSQL + Auth + Storage + Edge Functions).
- **Deploy:** Vercel (preview por rama, producción en `main`).
- **Asistencia IA:** Claude Code con agentes especializados.

### Alternativas consideradas

- **Vite + Express + Postgres propio:** más control, mucho más trabajo de setup, sin previews automáticos. Descartada.
- **Firebase:** buen ecosistema pero el modelo NoSQL no encaja con un POS que necesita SQL para reportes, cierres y trazabilidad. Descartada.
- **Next.js + Prisma + Postgres propio:** más flexible, pero perdemos Auth, Storage y RLS nativa. Descartada para el MVP.

### Consecuencias

- **Positivas:** entrega rápida, previews automáticos, RLS nativa, Auth resuelto, agentes pueden trabajar contra la DB local de Supabase CLI.
- **Negativas:** acoplamiento a Supabase. Migrar a otro provider sería costoso, especialmente Auth y RLS.
- **Seguimiento:** revisar en Fase 4 si el costo de Supabase escala bien con la base de clientes.

---

## ADR-002 — Multi-tenant desde el primer commit

**Fecha:** 2026-01-15
**Estado:** Accepted
**Autor:** Equipo NinjaSoft
**Decisión tomada por:** Equipo NinjaSoft

### Contexto

El producto es SaaS multi-tenant. Agregar multi-tenancy después es siempre más costoso que arrancar con eso. La opción más simple y segura para Postgres + Supabase es **shared database, shared schema, tenant_id por fila + RLS**.

### Decisión

- Toda tabla operativa lleva `tenant_id uuid not null references tenants(id)`.
- Toda tabla operativa tiene **RLS habilitada** desde la migración que la crea.
- El `tenant_id` activo se resuelve vía función `current_tenant_id()` desde el JWT del usuario.
- El `service_role` **nunca** se usa en el frontend. Solo en Edge Functions o backend confiable.

### Alternativas consideradas

- **Schema por tenant:** más aislamiento pero migraciones complejas, costo operativo alto. Descartada.
- **Database por tenant:** máximo aislamiento, máximo costo. Descartada para SaaS pyme.
- **Tenant_id sin RLS, filtrado por app:** un bug en una query y un cliente ve datos de otro. Descartada.

### Consecuencias

- **Positivas:** un solo schema, un solo set de migraciones, aislamiento garantizado a nivel DB.
- **Negativas:** RLS agrega complejidad en queries y testing. Toda función helper que use `service_role` requiere validación explícita de `tenant_id`.
- **Seguimiento:** auditar trimestralmente que ninguna tabla operativa quedó sin RLS.

Ver `08-multi-tenant.md` para detalle de implementación.

---

## ADR-003 — Feature flags antes que branches de código

**Fecha:** 2026-01-15
**Estado:** Accepted

### Contexto

El producto se vende a rubros distintos (kiosco, textil, retail, restaurante) y a planes distintos (Start, Pro, Business, Enterprise). La tentación es ramificar código por cliente o por rubro, lo que rompe el producto base rápidamente.

### Decisión

Toda funcionalidad opcional, experimental o diferencial entre planes pasa por **feature flags**. La tabla `feature_flags` define la flag; `tenant_feature_flags` la activa por cliente. El código consulta la flag, no el plan ni el rubro.

### Consecuencias

- **Positivas:** un único producto, configurable. Las personalizaciones quedan trazadas.
- **Negativas:** hay que disciplinarse: si la flag no se borra después de un tiempo, se acumula deuda.
- **Seguimiento:** revisar flags cada release. Si una flag lleva 6 meses al 100% activada, se promueve a default y se borra la flag.

Ver `07-feature-flags.md`.

---

## ADR-004 — Edge Functions para todo lo sensible

**Fecha:** 2026-01-15
**Estado:** Accepted

### Contexto

AFIP, integraciones de pago, webhooks de suscripciones, envío de emails: todo lo que use credenciales sensibles, lógica de negocio que el cliente no debería poder manipular, o requiera idempotencia, no puede vivir en el frontend.

### Decisión

Toda lógica sensible se encapsula como **Edge Function de Supabase**. El frontend nunca ve credenciales fiscales, claves de proveedores de pago ni secrets de proveedores externos.

### Consecuencias

- **Positivas:** secretos contenidos, lógica auditable, frontend más simple.
- **Negativas:** un salto extra (frontend → edge → DB/API externa) que hay que monitorear.
- **Seguimiento:** todas las Edge Functions deben loggear en `audit_logs` cuando corresponde.

Ver `15-afip-integration.md` para el caso AFIP.

---

## ADR-005 — Migraciones versionadas con timestamp

**Fecha:** 2026-01-15
**Estado:** Accepted

### Contexto

Con agentes generando código y dos devs trabajando en paralelo, las migraciones pueden colisionar fácilmente si no se ordenan bien.

### Decisión

Naming: `YYYYMMDDHHMMSS_verbo_descripcion.sql` (ej. `20260115143022_create_products_table.sql`). El timestamp garantiza orden cronológico y evita colisiones entre ramas.

Toda migración:

- Es **idempotente cuando es posible** (`if not exists`, `create or replace`).
- Habilita RLS en la misma migración que crea la tabla.
- Documenta en comentarios qué hace y por qué.
- Se aplica primero en local (Supabase CLI), después en preview, después en producción.

### Consecuencias

- Positivas: orden cronológico claro, rollback identificable.
- Negativas: hay que mantener disciplina al nombrar.

Ver `supabase/README.md`.

---

## ADR-006 — Project Manager como agente orquestador

**Fecha:** 2026-01-15
**Estado:** Accepted

### Contexto

El equipo usa Claude Code con varios agentes especializados (frontend POS, supabase-architect, security, QA, etc.). Si cada humano elige a mano qué agente invocar para cada tarea, se pierde tiempo y se cometen errores de delegación.

### Decisión

Existe un agente **Project Manager** que recibe la tarea, la analiza, decide qué especialistas la pueden hacer en paralelo (cada uno en su git worktree) y entrega un plan antes de ejecutar. Los humanos hablan con el PM; el PM coordina a los especialistas.

### Consecuencias

- **Positivas:** un solo punto de entrada, paralelismo real, menos errores de "le pedí al agente equivocado".
- **Negativas:** una capa extra. Para tareas chicas el PM puede ser overhead; en esos casos se invoca al especialista directo.
- **Seguimiento:** revisar después de la Fase 1 si el patrón escala o necesita ajustes.

Ver `.claude/agents/project-manager.md`.

---

## ADR-007 — Acceso total a DB en desarrollo, control estricto en producción

**Fecha:** 2026-01-15
**Estado:** Accepted

### Contexto

Para que los agentes (y los devs) sean productivos, necesitan poder crear tablas, funciones, políticas RLS y triggers sin pedir permiso constantemente. Pero la misma libertad en producción es un riesgo enorme.

### Decisión

**Desarrollo (local + preview):** los agentes y devs tienen acceso completo a la DB local de Supabase CLI, incluida `service_role`. Pueden ejecutar SQL libremente, crear funciones, modificar políticas. La DB local es desechable.

**Staging:** acceso con migraciones aplicadas vía CI. Se permite inspección con anon/service según necesidad.

**Producción:** ningún agente ni dev tiene acceso directo con `service_role`. Todo cambio entra vía PR aprobada, migración versionada y deploy. Acceso de emergencia con `service_role` solo desde panel oficial de Supabase con doble autorización.

### Consecuencias

- **Positivas:** velocidad en dev, seguridad en prod.
- **Negativas:** disciplina obligatoria: lo que funciona en local tiene que estar en una migración para que llegue a prod.
- **Seguimiento:** auditar trimestralmente accesos `service_role` en logs de Supabase.

---

## ADR-008 — Theme oscuro por defecto, claro disponible

**Fecha:** 2026-01-15
**Estado:** Accepted

### Contexto

La marca NinjaSoft tiene identidad oscura (Void Violet + Ninja Flame). Los POS típicamente se usan en mostrador con luz alta, donde un theme claro puede ser mejor.

### Decisión

`ninja-dark` es el theme por defecto. `ninja-light` está disponible y el usuario puede cambiar desde su perfil. La persistencia es por usuario, no por tenant, con override opcional por tenant para clientes Enterprise.

### Consecuencias

- Positivas: marca fuerte, opción para escenarios con luz.
- Negativas: hay que mantener ambos themes consistentes.

Ver `11-ui-brand.md`.

---

## Próximas ADRs (placeholder)

Cuando se tomen decisiones sobre proveedor de pagos, motor de impresión de tickets, estrategia de backups o cualquier otra cosa estructural, se agregan acá siguiendo el template.
