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

## ADR-009 — `current_tenant_id()` lee `app_metadata.current_tenant_id`

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Claude Code (build Hito 0)
**Decisión tomada por:** Lucas Ponzoni

### Contexto

Dos documentos definían `current_tenant_id()` de forma distinta:

- `08-multi-tenant.md` y `03-architecture.md`: `(auth.jwt() -> 'app_metadata' ->> 'current_tenant_id')::uuid`.
- `04-database.md`: `(auth.jwt() ->> 'tenant_id')::uuid`.

Al implementar el esquema base del Hito 0 había que elegir una y que toda la RLS la use consistentemente.

### Decisión

`current_tenant_id()` resuelve el tenant desde `app_metadata.current_tenant_id` (la versión de `08-multi-tenant.md`, documento autoritativo del modelo multi-tenant). El cambio de tenant activo actualiza `app_metadata` vía Edge Function `switch_tenant` y refresca el JWT.

Se agregó además `is_internal()` que lee `app_metadata.is_internal`, usada por las policies de tablas globales.

### Alternativas consideradas

- **`jwt ->> 'tenant_id'` (top-level claim):** requeriría custom claims fuera de `app_metadata`, menos estándar en Supabase Auth. Descartada.
- **Versión `app_metadata`:** estándar Supabase (`updateUserById({ app_metadata })`), ya descrita en el doc autoritativo. Elegida.

### Consecuencias

- **Positivas:** una sola fuente de verdad, alineada con el flujo `switch_tenant`. Linter de seguridad de Supabase sin findings tras hardening (`search_path` fijo en helpers, `handle_new_user` sin EXECUTE público).
- **Negativas:** queda drift en `04-database.md` (snippet con `tenant_id`) que debe corregirse en una pasada de documentación. También `04-database.md` usa `plans.limits`/sin `rollout_strategy` mientras `16`/`07` describen `plans.features`/`rollout_strategy`: el esquema implementado sigue a `04` (autoridad de BD); reconciliar docs después.
- **Seguimiento:** corregir snippets de `04-database.md`; agregar suite de aislamiento `tests/multi-tenant.test.ts` cuando exista auth/frontend.

---

## ADR-010 — Plan ampliado del roadmap (F6–F8) + cortes de control

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Claude Code
**Decisión tomada por:** Lucas Ponzoni

### Contexto

Con el MVP (H0–H6) funcional y desplegado, el equipo definió extender el alcance del producto: medios de pago múltiples, panel interno robusto con gestión total de usuarios y staff, comunicaciones por email configurables, y un fuerte eje de personalización. Se pidió además rigor de testing al cierre de cada hito.

### Decisión

Se agregan al roadmap las fases **F6 (Personalización)**, **F7 (Panel interno PRO + comunicaciones)** y **F8 (Pagos y cobros)**. El orden original era **F6 → F7 → F8 → F3 (AFIP)**, luego actualizado por ADR-011/ADR-012/ADR-013/ADR-014/ADR-018/ADR-019/ADR-020 a **F6 → F7 → F8 → F10 → F11 → F12 → F13 → F9 → F14 → F15 → F16 → F3**. Definiciones clave:

- **Pagos:** arquitectura extensible primero (registro de proveedores, credenciales encriptadas por tenant, UI de cobro abstracta, pago mixto) y **una integración por etapas** por proveedor: Mercado Pago/Point, MODO (QR interoperable), Payway/Prisma, Getnet, Fiserv/Posnet/Clover, **Mobbex como orquestador opcional**, Pagos360. Medios manuales (efectivo, transferencia, mixto) desde la base.
- **Staff NinjaSoft:** tres niveles — **super-admin**, **admin**, **soporte** — con matriz de permisos versionada.
- **Emails:** editor de plantillas HTML + variables con versionado, catálogo de emails del sistema, logs de envío y campañas masivas. Proveedores: **Resend** (transaccional) + **Brevo** (masivos).
- **Personalización:** fotos de productos → **WebP vía Edge Function con `sharp`** (multi-tamaño en Storage), **branding por tenant**, **tickets/comprobantes personalizables** (58/80mm + A4), **catálogo público + motor de promociones + variantes por rubro**.
- **AFIP:** alcance base en F3 / `15-afip-integration.md`; luego robustecido por ADR-011 con cola fiscal, venta offline y gate de homologación → producción. Se ejecuta al final por dependencia de certificados, homologación, tickets y flujos comerciales previos.

Se establece un **corte de control obligatorio** al cierre de cada hito: gate automático (lint, typecheck, tests con cobertura nueva, build, migraciones+types, tests de aislamiento RLS) + gate manual (demo del criterio, auditoría, sin `service_role` en frontend, feature flag si aplica, decision-log/changelog, deploy READY verificado).

### Alternativas consideradas

- **Pagos todo-en-un-hito:** rechazado; obliga a tener 10 cuentas sandbox a la vez y bloquea el avance. Se eligió arquitectura + etapas.
- **Un solo proveedor de email:** se prefirió separar transaccional (Resend) de masivos (Brevo) por fortaleza de cada uno.
- **Conversión de imágenes en cliente:** descartada como default por calidad variable; se eligió Edge Function `sharp` para resultado consistente.
- **Date picker (TX-1):** se descartó **flatpickr** (JS vanilla, requiere wrapper y choca con React/Radix/Tailwind) a favor de **react-day-picker (v9) + Radix Popover** (patrón shadcn), por encaje con el sistema de diseño y soporte nativo de rango/i18n. `react-aria` quedó como alternativa de máxima accesibilidad; MUI X descartada por peso/estilo.

### Consecuencias

- **Positivas:** alcance y orden claros; criterios de cierre verificables; calidad forzada por los cortes de control.
- **Negativas:** dos proveedores de email aumentan operación; `sharp` agrega costo de cómputo server. Mobbex puede solapar funciones con integraciones directas (se evalúa por proveedor).
- **Seguimiento:** crear docs dedicadas (`payments`, `emails`, `branding`) al iniciar cada fase; definir esquema de credenciales encriptadas; sumar suite de aislamiento multi-tenant a CI.

---

## ADR-011 — Hardening pre-piloto, hardware PRO y AFIP robusto

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

Después de ampliar el roadmap con personalización, panel interno, pagos y promociones, aparecieron tres necesidades operativas:

- El MVP funcional necesita una fase explícita de hardening antes de piloto real.
- El hardware de mostrador (impresoras, scanners, balanzas, cajón, display cliente) tiene suficiente complejidad para ser fase propia.
- AFIP debe contemplar cola fiscal robusta, venta offline y gate formal de homologación a producción.

### Decisión

Se agrega **F1.5 — Hardening pre-piloto** como fase obligatoria antes de considerar piloto real: build estable, scripts alineados, tests multi-tenant/RLS/permisos, smoke E2E, health check, backup/restore y seed reproducible.

Se agrega **F10 — Hardware y mostrador PRO** antes de promociones y AFIP, con hitos para impresión avanzada, scanners, etiquetas/balanzas, doble pantalla/display cliente y diagnóstico de hardware. La doble pantalla se implementa como ruta dedicada sincronizada (`/customer-display`) porque el navegador no controla monitores como una app nativa.

Se robustece **F3 — AFIP** con cola fiscal, estados operativos, idempotencia fiscal, conciliación contra `FECompUltimoAutorizado`, venta offline con comprobante interno/provisorio y gate de homologación a producción.

### Alternativas consideradas

- **Dejar hardware dentro de F4:** descartado; F4 mezcla multi-sucursal, pagos e integraciones. Hardware necesita criterios de compatibilidad y diagnóstico propios.
- **Emitir AFIP sin cola fiscal:** descartado; bloquearía ventas cuando AFIP falle y haría frágil la operación.
- **Doble pantalla nativa desde el inicio:** descartada para MVP web; se prioriza display cliente vía navegador/tablet y se deja hardware serial/USB para etapa posterior.

### Consecuencias

- **Positivas:** el roadmap queda más operable, con checkboxes por entregable y capacidades reales de piloto/mostrador.
- **Negativas:** F10 agrega dependencia de pruebas con hardware físico y soporte de campo.
- **Seguimiento:** crear specs técnicas al iniciar F10; medir compatibilidad real de WebUSB/WebSerial/QZ Tray/conector local; sumar tests de cola fiscal e idempotencia antes de AFIP producción.

---

## ADR-012 — Configuración retail avanzada e importación masiva por Excel

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

Al comparar el roadmap con funcionalidades de un POS retail de referencia, aparecieron capacidades necesarias para rubros como electro, muebles, herramientas, indumentaria y retail medio: variantes de medios de pago con recargo, garantías extendidas, devoluciones/cambios con vales, cuenta corriente, pedidos de salón, despacho, depósitos, roles propios e importación masiva.

### Decisión

Se agrega **F11 — Configuración retail avanzada** y una regla transversal **TX-4 — Importaciones masivas XLSX como estándar**.

Todo dato maestro operativo que pueda cargarse en volumen debe ofrecer plantilla Excel, validación previa, preview, confirmación, reporte de errores por fila y auditoría. Esto aplica a productos, clientes, depósitos, stock inicial, listas de precios, medios de pago, garantías, motivos de devolución, grupos de clientes y tipos de entrega.

### Consecuencias

- **Positivas:** el producto queda preparado para carga inicial real de comercios existentes y para operación retail compleja sin SQL.
- **Negativas:** los imports requieren validadores robustos, reporting por fila y cuidado con reversión/idempotencia.
- **Seguimiento:** al iniciar F11, definir schemas de importación por entidad y tests con archivos XLSX válidos/invalidos.

---

## ADR-013 — Comercios simples, servicios y cobro rápido

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

El roadmap cubría retail pesado, hardware, pagos, promociones y AFIP, pero faltaba una línea clara para negocios con pocos productos o servicios: heladerías, cafeterías simples, panaderías chicas, peluquerías, barberías, estética, lavaderos, talleres livianos y profesionales con turnos.

Estos comercios no compran un POS por inventario complejo; lo compran para cobrar rápido, ordenar agenda, controlar staff/comisiones y empezar sin configuración pesada.

### Decisión

Se agrega **F12 — Comercios simples y servicios** antes de F9/AFIP. La fase cubre:

- Onboarding por rubro con presets listos.
- Modo catálogo chico con pantalla táctil de botones y cobro express.
- Modificadores simples para heladería/cafetería: tamaño, sabores, toppings y combos.
- Agenda para peluquería/estética: profesional, duración, walk-in, seña, no-show y cobro desde turno.
- Comisiones, propinas y productividad por staff.
- Clientes livianos, historial, recurrencia, packs de sesiones, membresías y gift cards.
- Demos/landings por rubro para convertirlo en oportunidad comercial.

### Alternativas consideradas

- **Resolverlo dentro de F5 perfiles por rubro:** insuficiente; F5 queda como marco general, pero estos rubros necesitan pantallas y métricas propias.
- **Usar solo productos normales con variantes:** descartado para heladería; tamaños/sabores/toppings explotan combinaciones y vuelven lento el cobro.
- **Poner agenda en backlog:** descartado; peluquería/estética no puede operar bien sin turnos, profesional y comisión.

### Consecuencias

- **Positivas:** amplía mercado hacia negocios chicos de alta repetición, reduce fricción de onboarding y permite demos verticales muy rápidas.
- **Negativas:** suma otro modo de POS y exige cuidado para no duplicar lógica con retail/restaurante.
- **Seguimiento:** crear schemas de `service_items`, `appointments`, `service_sessions`, `staff_commissions` al iniciar F12; validar UX con demo de heladería y peluquería.

---

## ADR-014 — Gastronomía PRO: mesas, comandas y cocina

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

Restaurante, cafetería, heladería y rotisería no son variantes menores del POS retail. Necesitan mesas/salones, comandas antes del pago, ruteo por estación, cocina/barra, KDS, cursos, delivery/takeaway y reportes de tiempos. F12 cubre cobro simple y servicios; gastronomía completa requiere fase propia.

### Decisión

Se agrega **F13 — Gastronomía PRO** antes de F9/AFIP. La fase cubre:

- Configuración de tipos de negocio gastronómico y modos de atención.
- Mesas, salones, estados, mozos, unión/movimiento/división de cuentas.
- Comandas impresas y ruteo por estación.
- KDS / pantalla de cocina y barra.
- Menú gastronómico, modificadores, cursos, alergias y notas.
- Flujos específicos de cafetería, heladería, mostrador híbrido, delivery/takeaway y despacho.
- Recetas/escandallo, producción previa, merma y margen por plato.
- Reservas gastronómicas, waitlist, ocupación y reportes operativos.

### Alternativas consideradas

- **Dejarlo en F5 como perfil restaurante:** insuficiente; F5 define perfiles, pero mesas/comandas/KDS son operación completa.
- **Meterlo en F10 hardware:** descartado; F10 cubre impresión y periféricos, pero no la lógica de mesa, curso, cocina, delivery ni reportes.
- **Usar F12 catálogo chico:** solo sirve para cafetería/heladería simple. Cuando hay salón, cocina o despacho, pasa a F13.

### Consecuencias

- **Positivas:** habilita vertical gastronómico vendible y evita que el flujo restaurante quede como parche del POS retail.
- **Negativas:** agrega complejidad de concurrencia, impresión/KDS, sincronización y auditoría de cambios de pedido.
- **Seguimiento:** diseñar modelos `dining_tables`, `restaurant_orders`, `kitchen_tickets`, `kitchen_stations`, `recipes`; probar ruteo idempotente de comandas antes de piloto gastronómico.

---

## ADR-015 — Panel internal como consola operativa completa

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

NinjaSoft necesita operar suscripciones, tenants, staff, soporte e invitaciones desde un panel propio. El panel internal no debe depender de que el usuario entre primero al POS del cliente ni de acciones manuales en SQL/Supabase.

### Decisión

El panel internal será una consola separada:

- `/internal` redirige a `/internal/tenants`.
- Si no hay sesión, se usa login con `next=/internal/tenants` para volver directo al panel.
- Usuarios no internos se redirigen fuera de internal.
- La consola internal debe cubrir tenants, suscripciones, billing manual, staff NinjaSoft, invitaciones a tenants, feature flags, soporte, impersonation con motivo, auditoría y health.
- Super-admin puede convertir usuarios existentes en staff y asignar roles/niveles. Roles no privilegiados no pueden modificar staff crítico.
- Toda acción sensible exige motivo y queda auditada con antes/después.

### Alternativas consideradas

- **Usar el mismo dashboard del tenant:** descartado; mezcla operación de cliente con operación SaaS y hace confuso el acceso de staff.
- **Gestionar staff desde Supabase Auth manualmente:** descartado; es riesgoso, no auditable para operación diaria y no escala.
- **Dejar invitaciones solo en el panel del cliente:** insuficiente; soporte/ventas necesita resolver altas y cambios de rol desde internal.

### Consecuencias

- **Positivas:** operación SaaS sin SQL, soporte más rápido, control claro de roles internos y auditoría completa.
- **Negativas:** mayor superficie de seguridad; requiere MFA, rate limits, confirmaciones fuertes y tests E2E específicos.
- **Seguimiento:** completar UI de staff/invitaciones/billing en `/internal`, agregar MFA para super-admin y tests de permisos internal.

---

## ADR-016 — Planes custom, aumentos de cuota y notificaciones por cuenta

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

El modelo de planes base (Start/Pro/Business/Enterprise) no alcanza para operar ventas reales: algunos clientes necesitarán límites especiales, módulos puntuales, precio acordado, aumento de cuota individual o condiciones comerciales temporales. Además, cada cambio relevante debe comunicarse dentro de la cuenta, no solo por email.

### Decisión

Se agregan tres capacidades:

- **Plan custom por tenant:** clonado desde un plan base, con límites, módulos, soporte, precio, moneda, ciclo y vigencia propios.
- **Aumentos de cuota/precio por cliente:** inmediatos o programados, con fecha efectiva, motivo, aviso, aceptación opcional, antes/después y auditoría.
- **Centro de notificaciones por cuenta:** inbox in-app, banners y acciones para novedades, cobros, vencimientos, límites, cambios de plan, AFIP, seguridad y soporte.

El panel internal será la fuente operativa para crear planes custom, modificar cuota/límites, programar aumentos y enviar notificaciones a tenants o segmentos.

### Alternativas consideradas

- **Crear un plan global por cada excepción comercial:** descartado; ensucia catálogo comercial y vuelve inmanejable el producto.
- **Guardar precio custom solo como nota:** descartado; no se puede auditar ni aplicar límites de forma consistente.
- **Comunicar cambios solo por email:** descartado; el email se pierde y no da una fuente de verdad dentro de la cuenta.

### Consecuencias

- **Positivas:** permite cerrar acuerdos comerciales flexibles sin romper planes globales; mejora transparencia con clientes; deja trazabilidad fuerte.
- **Negativas:** agrega complejidad de billing, comunicación y permisos; requiere UI cuidadosa para no aplicar aumentos silenciosos.
- **Seguimiento:** diseñar `tenant_plan_overrides`, `subscription_price_changes`, `account_notifications` y métricas de lectura/acción antes de activar cobro real.

---

## ADR-017 — Gate de diseño y estructura

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

El producto está creciendo en muchas verticales: POS, internal, retail avanzado, servicios, gastronomía, AFIP y notificaciones. Sin un control explícito, cada módulo puede sumar pantallas con estructura distinta, componentes duplicados o deuda visual.

### Decisión

Se crea [`26-design-structure-control.md`](./26-design-structure-control.md) como gate obligatorio para toda PR que toque UI o estructura frontend.

El gate valida:

- Reutilización de componentes del sistema.
- Jerarquía visual y layout correcto por tipo de pantalla.
- Responsive mobile/tablet/desktop.
- Accesibilidad mínima.
- Estados loading/empty/error/success.
- Separación de lógica por módulo.
- Evidencia visual o demo para pantallas críticas.

### Consecuencias

- **Positivas:** consistencia visual, menos duplicación, menos regresiones responsive y una barra clara para aceptar UI.
- **Negativas:** cada PR de UI requiere más evidencia y revisión.
- **Seguimiento:** agregar Playwright screenshots/visual checks cuando el suite E2E esté consolidado.

---

## ADR-018 — Motor comercial enterprise y configuracion centralizada

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

El roadmap ya cubria pagos, recargos retail, promociones, planes custom, notificaciones, gastronomia y servicios. Pero varias capacidades clave de un POS de primer nivel seguian dispersas o en backlog: cuotas enterprise, add-ons, medicion de uso, reglas comerciales unificadas, aprobaciones, inventario PRO, compras/proveedores, offline completo, omnicanal y API/webhooks.

### Decisión

Se agrega **F14 — Motor comercial enterprise** y [`27-commercial-configuration-engine.md`](./27-commercial-configuration-engine.md) como especificacion central.

F14 define:

- Jerarquia de configuracion: global, plan, tenant, rubro, sucursal, caja, canal, rol, usuario y vigencia.
- Planes, cuotas, add-ons, entitlements y usage metering.
- Recargos, financiacion, tasas, redondeos, service charge, propinas y fees por contexto.
- Motor de reglas comerciales unificado para precio, descuento, recargo, comision, bloqueo, alerta o sugerencia.
- Gobierno de cambios con maker-checker, motivo, version, diff y rollback.
- Inventario PRO, compras, proveedores, lotes, vencimientos, series y reposicion sugerida.
- Offline-first completo con colas locales, idempotencia y reconciliacion.
- Omnicanal, API, webhooks, marketplace de apps y BI/AI operativo.

### Alternativas consideradas

- **Mantener estas capacidades en backlog:** descartado; eran brechas directas frente a POS lideres y a comercios grandes.
- **Repartir reglas en cada modulo:** descartado; duplicaria logica de recargos/promos/comisiones/precios y haria dificil auditar.
- **Crear planes globales para cada excepcion:** descartado; ensucia el catalogo comercial. Plan custom + add-ons + entitlements es mas mantenible.

### Consecuencias

- **Positivas:** el producto gana una capa enterprise coherente, auditable y simulable; se reducen configuraciones manuales y excepciones invisibles.
- **Negativas:** requiere una arquitectura cuidadosa de versionado, evaluacion de reglas, performance y permisos.
- **Seguimiento:** disenar tablas `tenant_entitlements`, `tenant_usage_counters`, `pricing_rules`, `config_snapshots`, `billing_ledger`, `purchase_orders`, `offline_operation_queue`, `api_clients` y `webhook_subscriptions` antes de iniciar F14.

---

## ADR-019 — Escuela NinjaSoft y onboarding guiado configurable

**Fecha:** 2026-05-30
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

El producto crece hacia muchos rubros y operaciones complejas. Sin educacion dentro del sistema, soporte queda obligado a explicar cada flujo manualmente y los clientes tardan mas en llegar a primera venta, caja cerrada, AFIP configurado o uso correcto de mesas/comandas.

### Decisión

Se agrega **F15 — Escuela NinjaSoft + onboarding guiado configurable** y [`28-school-onboarding.md`](./28-school-onboarding.md).

F15 define:

- Escuela por modulos con cursos, lecciones, pasos, evaluaciones y certificaciones.
- Tours guiados configurables desde internal por plan, rubro, rol, tenant, feature flag, estado y disparador.
- Checklist de activacion dinamico por rubro.
- Ayuda contextual dentro de cada pantalla.
- Laboratorio/demo segura para practicar sin afectar datos reales.
- Sugerencias/nudges con frecuencia, cooldown, CTA, metricas y relacion con notificaciones.

### Alternativas consideradas

- **Resolver capacitacion solo con soporte humano:** descartado; no escala y aumenta costo operativo.
- **Usar solo una base de conocimiento estatica:** insuficiente; no guia al usuario dentro del flujo ni mide adopcion.
- **Hardcodear tours en frontend:** descartado; operaciones necesita ajustar recorridos sin deploy.

### Consecuencias

- **Positivas:** menor friccion de adopcion, menos tickets repetitivos, onboarding por rubro y certificacion por rol.
- **Negativas:** exige gobierno de contenido, versionado de tours y cuidado para no saturar al usuario con mensajes.
- **Seguimiento:** disenar `learning_courses`, `guided_tours`, `onboarding_checklists`, `onboarding_suggestions`, `suggestion_events` y el panel internal de configuracion antes de iniciar F15.

---

## ADR-020 — Benchmark Napse/TOTVS y comercio unificado

**Fecha:** 2026-05-31
**Estado:** Accepted
**Autor:** Codex
**Decisión tomada por:** Lucas Ponzoni

### Contexto

Se pidió revisar el roadmap especialmente contra Napse/TOTVS. La comparación muestra que el producto no debe quedarse solo en POS + pagos + promociones: para competir en retail enterprise necesita una capa de comercio unificado que conecte tienda física, e-commerce, marketplace, stock, OMS, pagos, fiscal, promociones, fidelización, devoluciones, riesgo y operación de cadenas.

Referencias analizadas:

- Napse Bridge: punto de venta omnicanal, inventario, OMS, reglas, pagos, fiscal y fidelización.
- Napse VTOL: medios de pago omnicanal, ruteo, conciliación, alarmas, trazabilidad y alta disponibilidad.
- Napse Fiscal Flow: emisión fiscal centralizada, XML/PDF, contingencia, multi-negocio y multi-país.
- Napse Promo: promociones, simulación, coexistencia, cupones, puntos, gift cards y automatizaciones.
- Napse Omni: Click & Collect, Ship from Store, devoluciones cross-channel, stock centralizado e integración con e-commerce/marketplaces.

### Decisión

Se agrega **F16 — Comercio unificado tipo Napse/TOTVS** y [`29-napse-unified-commerce-benchmark.md`](./29-napse-unified-commerce-benchmark.md).

F16 define:

- Unified Commerce Cockpit.
- Jornadas omnicanal: Stock Lookup, Endless Aisle, Click & Collect, Ship from Store, Reserve Online/Try in Store y devoluciones cross-channel.
- OMS y fulfillment multi-origen.
- Fiscal Hub multi-canal y multi-país.
- Promo & Loyalty enterprise.
- Clienteling y mobile POS.
- Prevención de fraude y riesgo operativo.
- Operación de cadenas, marcas y franquicias.
- Integration hub con health, retry, dead-letter y replay.
- Observabilidad enterprise y demos por vertical.

### Alternativas consideradas

- **Meter todo en F14:** descartado. F14 es el motor comercial; F16 es la experiencia enterprise integrada sobre ese motor.
- **Tratar Napse solo como proveedor de pagos/fiscal:** descartado. Napse opera como suite de comercio unificado, no solo gateway.
- **Dejarlo como benchmark informal:** descartado. Para que sea accionable necesita fase, hitos, QA, modelo de datos y ADR.

### Consecuencias

- **Positivas:** NinjaSoft queda con una ruta clara para cadenas, franquicias y retailers grandes; el roadmap compite contra suites Latam reales, no solo POS livianos.
- **Negativas:** F16 agrega mucha complejidad de OMS, sincronización, conciliación, fiscal, integraciones y soporte.
- **Seguimiento:** diseñar `commerce_orders`, `fulfillment_tasks`, `payment_transactions`, `fiscal_documents`, `promo_campaigns`, `loyalty_accounts`, `integration_jobs`, `risk_events` y el cockpit antes de iniciar F16.

---

## ADR-021 — Código de barras Code 39 sin dependencias

**Fecha:** 2026-05-31
**Estado:** Accepted
**Autor:** Claude
**Decisión tomada por:** Corrida autónoma (orden de Lucas Ponzoni)

### Contexto

H24 (etiquetas) necesita renderizar un código de barras escaneable en la etiqueta. Las librerías típicas (`jsbarcode`, `bwip-js`) agregan una dependencia y el build local cuelga por Dropbox, lo que vuelve riesgoso instalar paquetes sin poder validar el build localmente.

### Decisión

Implementar un generador **Code 39** propio, sin dependencias (`lib/barcode/code39.ts`): tabla de patrones de 9 elementos por carácter → segmentos barra/espacio → SVG (`components/products/Barcode.tsx`). Code 39 es alfanumérico, auto-checkeante y legible por lectores USB/cámara comunes; suficiente para etiquetas internas de góndola.

### Alternativas descartadas

- **jsbarcode/bwip-js:** descartado por ahora para no sumar dependencia con build local no verificable; se puede revisar si se necesita EAN-13/Code128 con dígito verificador.
- **EAN-13 manual:** descartado; más complejo (dígito verificador, codificación L/G/R) para el objetivo de etiquetas internas.

### Consecuencias

- **Positivas:** cero dependencias nuevas; función pura testeable (unit tests); SVG liviano e imprimible.
- **Negativas:** Code 39 es menos denso que Code128 y no trae dígito verificador; si se requieren EAN-13 reales de góndola, habrá que sumar un generador específico (futura ADR).

---

## ADR-022 — Patrón de policies RLS: initplan y sin `FOR ALL`

**Fecha:** 2026-06-04
**Estado:** Accepted
**Autor:** Claude
**Decisión tomada por:** Lucas Ponzoni (autorización explícita para aplicar en producción)

### Contexto

Los advisors de performance de Supabase (primera corrida) reportaron 13 policies con `auth_rls_initplan` (funciones `auth.uid()`/`current_tenant_id()`/`is_internal()` re-evaluadas **por fila**) y 40 `multiple_permissive_policies` (8 policies `*_write` declaradas `FOR ALL` que solapaban SELECT con su `*_select`, duplicando evaluación en cada lectura).

### Decisión

Patrón obligatorio para **toda policy nueva o reescrita**:

1. Las funciones de contexto se envuelven en subquery escalar: `(select auth.uid())`, `(select current_tenant_id())`, `(select is_internal())` — Postgres las evalúa una vez por query (initplan) en vez de una vez por fila.
2. **No usar `FOR ALL`** cuando existe una policy de SELECT separada: las policies de escritura se dividen en `for insert` / `for update` / `for delete` con el mismo predicado.

Aplicado retroactivamente en `20260604121000_perf_rls_initplan` (mismas reglas de acceso, verificadas contra `pg_policies` antes y después).

### Alternativas consideradas

- **Dejar las policies como estaban:** funcionaban, pero el costo por fila crece con el volumen de datos; barato arreglarlo ahora.
- **Función helper `is_tenant_admin()`:** menos repetición, pero suma una función SECURITY DEFINER más que mantener; se prefirió SQL inline explícito.

### Consecuencias

- **Positivas:** advisors de performance en cero; lecturas sobre tablas con RLS escalan mejor.
- **Negativas:** policies más verbosas (3 por tabla en vez de 1 `FOR ALL`).
- **Seguimiento:** el job `rls` de CI (ADR-023) valida que las reglas de acceso se mantienen.

---

## ADR-023 — Suite RLS de integración en CI + replay de migraciones como gate

**Fecha:** 2026-06-04
**Estado:** Accepted
**Autor:** Claude
**Decisión tomada por:** Corrida autónoma (orden de Lucas Ponzoni)

### Contexto

F1.5 exigía tests de aislamiento multi-tenant y de RLS, inexistentes hasta hoy. Además, nadie había intentado nunca reproducir el historial de migraciones en una DB fresca: las migraciones se aplicaban solo al remoto vía MCP.

### Decisión

1. Suite de integración `tests/integration/rls.test.ts`: crea dos tenants con datos cruzados y usuarios reales (JWTs de verdad, no mocks) y verifica aislamiento de lectura/escritura en productos, clientes, ventas, caja y audit_logs; `payment_secrets` deny-all; `tenant_notes` solo staff; permisos owner vs cashier. Sin las env `SUPABASE_TEST_*`, la suite se salta (dev local sin Docker sigue verde).
2. Job `rls` en CI: `supabase start` (stack local del runner con **todas** las migraciones aplicadas, vía `supabase/config.toml` nuevo) + `pnpm test:rls`. Node 22 (supabase-js v2.106 exige WebSocket nativo).
3. **El replay completo del historial de migraciones pasa a ser gate de CI.** Regla derivada: si un archivo histórico rompe el replay, se permite editarlo *solo* para repararlo (drop previo, rename de timestamp) — nunca para cambiar su efecto; el remoto no se ve afectado porque ya las tiene aplicadas.

### Resultado de la primera corrida (justifica la decisión)

- `tenant_members()` cambiaba su row type con `create or replace` (prohibido) → replay roto.
- Dos migraciones compartían timestamp `20260531120000` → PK duplicada en `schema_migrations`.
- **9 migraciones aplicadas en producción nunca se habían commiteado** (`tenant_branding`, `public_catalog`, `ticket_width`, `staff_levels_backward_compat`, `sales_report_by_product/customer`, `harden_internal_level`, `user_avatars_bucket`, `product_images_no_listing`). Se recuperaron byte a byte de `supabase_migrations.schema_migrations.statements` del remoto. Hasta este fix, levantar staging o local con `pnpm db:reset` era imposible.

### Alternativas consideradas

- **Tests de policies por snapshot de `pg_policies`:** frágil y no prueba comportamiento real con JWTs.
- **Correr la suite contra producción:** descartado; crea y borra tenants/usuarios.
- **pgTAP:** válido, pero la suite en Vitest reusa el stack del repo y el mismo cliente supabase-js que usa la app.

### Consecuencias

- **Positivas:** toda PR valida aislamiento multi-tenant y replay de migraciones; staging/local levantables por primera vez; tres deudas ocultas saneadas.
- **Negativas:** +2-3 min por corrida de CI; las migraciones nuevas aplicadas vía MCP **deben** commitearse en el mismo PR o CI rompe (esto es deliberado).
- **Seguimiento:** sumar tests de roles manager/viewer; evaluar smoke E2E (Playwright) sobre el mismo stack local.

---

## ADR-024 — Mobbex como segunda pasarela QR (validada en producción)

**Fecha:** 2026-06-04
**Estado:** Accepted
**Autor:** Claude
**Decisión tomada por:** Lucas Ponzoni ("avanza con mobbex")

### Contexto

Mercado Pago QR no puede fijar cuotas: el cliente las elige en su app y el plan del grid solo aumenta el precio base. Se necesitaba una pasarela donde las cuotas configuradas en NinjaPos se apliquen de verdad en el checkout. Del ranking de integrabilidad (Mobbex > Pagos360 > MODO/Nave > Payway/Getnet/Fiserv), Mobbex ganó por API REST simple, credenciales directas (API Key + Access Token) y checkout hosted.

### Decisión

Integrar **Mobbex** (kind `orchestrator`) como segunda pasarela de cobro QR: Edge Functions `mobbex_create_qr` (checkout hosted → URL → QR, con los planes de crédito del grid mapeados al payload `installments`) y `mobbex_webhook` (status 200=approved; 1/2/3/100/201=pending; resto=rejected). Reusa `payment_secrets` y `mp_payment_intents` (columna `provider_key`).

**Validada con cuenta real el 2026-06-04:** transacción de punta a punta exitosa, cuotas del grid aplicadas en el checkout de Mobbex al primer intento (el formato `installments` no necesitó ajustes).

### Alternativas consideradas

- **MP Checkout API/Bricks para fijar cuotas:** requiere tarjeta tipeada (PCI) — no sirve para mostrador.
- **MP Point:** fija cuotas pero exige hardware; queda como ítem propio (H15).
- **Pagos360/MODO primero:** más fricción de integración; Mobbex era el camino más corto a cuotas reales.

### Consecuencias

- **Positivas:** NinjaPos cobra por dos pasarelas reales; las cuotas+interés del grid H27 son ejecutables, no solo informativas.
- **Negativas:** dos proveedores que conciliar (mitigado por ADR-025); comisión de Mobbex sobre cada cobro.
- **Seguimiento:** conciliación contra liquidaciones de Mobbex cuando haya volumen; evaluar Mobbex como orquestador de otros adquirentes (su rol natural).

---

## ADR-025 — Conciliación de cobros QR vía `payments.reference`

**Fecha:** 2026-06-04
**Estado:** Accepted
**Autor:** Claude
**Decisión tomada por:** Lucas Ponzoni ("continua con 1")

### Contexto

Un cobro QR aprobado puede quedar sin venta registrada (el cajero cierra el modal antes de confirmar, se cae la conexión): plata cobrada sin ticket, invisible hasta el arqueo. Hacía falta cruzar los intents (`mp_payment_intents`, MP + Mobbex) con las ventas.

### Decisión

Conciliación **read-only** en el cliente: el POS ya guarda el `intent_id` en `payments.reference` al registrar la venta, así que el cruce es `payments.reference = intent.id` (con `intent.sale_id` como fallback). Modal "Cobros QR" en /ventas con la señal clave **"aprobado sin venta"** resaltada, filtros, total aprobado y export XLSX con el ID de pago del proveedor. Sin cambios de esquema ni de `create_sale`.

### Alternativas consideradas

- **Setear `intent.sale_id` desde `create_sale`:** más directo, pero toca el RPC crítico (congelado salvo OK explícito) y exige pasarle contexto del intent; el cruce por referencia ya es confiable.
- **Conciliación server-side (vista/función):** innecesario al volumen actual; si crece, se materializa.

### Consecuencias

- **Positivas:** los cobros huérfanos se detectan en segundos; cierre del criterio "conciliación" básico de H15/H20.
- **Negativas:** matching depende de que el POS siga guardando el intent en `reference` (convención, no constraint).
- **Seguimiento:** al tocar `create_sale` por otros motivos, evaluar setear `intent.sale_id` transaccionalmente y conciliar contra liquidaciones del proveedor.

---

## ADR-026 — Auditoría de feature-gating: clasificación de features y reclasificación a BASE

**Fecha:** 2026-06-09
**Estado:** Accepted
**Autor:** Claude
**Decisión tomada por:** Lucas Ponzoni

### Contexto

El sistema gatea funcionalidades por `plans.limits.modules` + el catálogo `features` (semántica: una feature está incluida si `modules[key]=true`, o si está ausente pero `is_basic=true` → fallback). El enforcement real vive server-side en `tenant_has_feature` / `tenant_has_feature_for` dentro de triggers/RPCs. Se hizo una auditoría completa de qué se gatea de verdad vs. qué es sólo decorativo en la UI.

Hallazgos:

- **Bug:** `panel_dueno` figuraba como feature de plan (`is_basic=false`, marcada en planes Pro+) pero su acceso no estaba realmente gateado: era **decorativa**. La UI la mostraba como diferencial de plan sin que ningún `tenant_has_feature` la respaldara. Lo mismo aplicaba a `devoluciones` como "valor de plan" cuando en la práctica es parte del piso operativo.
- **OPTIONAL bien gateadas (server-side):** `descuentos`, `garantias`, `cuenta_corriente`, `listas_precios` (en `create_sale` / triggers). Enforcement recién agregado por el agente de DB para: `tickets_pro`, `grupos_clientes`, `personalizacion_marca`, `variantes`, `catalogo_publico` y los gateways de tarjeta.
- **SOLO-MARKETING (la función no existe, no se puede enforce hoy):** `promociones`, `facturacion_afip`, `roles_permisos` (granular), `metricas_avanzadas`, `backup`, `api_publica`, `soporte_prioritario`. Aparecen en la comparación pero no hay código que las haga cumplir. (La auditoría sí se graba para todos los tenants, sin vista tenant-facing.)
- **Módulos nuevos sin key de plan diferenciada:** `agenda` y `packs` existen en `features` con `is_basic=true` (on para todos) y, hasta hoy, sin copy en `featureInfo`. `asistente_ia` se gatea como ADDON (correcto). La suite de Gastronomía (mesas/KDS/comanda/cursos/división/modificadores) y Delivery (board/zonas) son **flags operativos del dueño** (`pos_settings.dining_enabled` / `delivery_enabled`), no features de plan.

### Decisión

1. **Reclasificar a BASE** (`is_basic=true`, incluidas en todo plan) a `panel_dueno` y `devoluciones`: son piso de "pagar cualquier plan", no diferenciales. Esto elimina el gating decorativo.
2. **Mantener el enforcement server-side** recién agregado para las OPTIONAL listadas arriba (la UI nunca es la única barrera).
3. **Documentar la deuda MARKETING-FUTURO**: las features prometidas sin función quedan registradas; antes de venderlas como gateadas hay que implementar el enforcement.
4. **Agregar copy** de `agenda` y `packs` en `lib/saas/featureInfo.ts` (hoy `minPlan: Start` porque son básicas).
5. **Formalizar la taxonomía** de features en `CLAUDE.md` §6: BASE / OPTIONAL / ADDON / FLAG-OPERATIVO / MARKETING-FUTURO, con el checklist de los 5 pasos obligatorios (key en `features`, marca por plan, gating server-side, copy en `featureInfo`, aparición en la comparación).

### Alternativas consideradas

- **Dejar `panel_dueno`/`devoluciones` como OPTIONAL e implementar su gating real:** comercialmente no tiene sentido cobrar el panel del dueño ni las devoluciones aparte; son esperables en cualquier plan. Descartada.
- **Borrar las features MARKETING-FUTURO de la comparación:** se prefieren conservar como roadmap visible, pero marcadas como deuda en este ADR para no confundir "prometido" con "gateado".

### Decisiones diferidas (follow-up)

- **Convertir Gastronomía y Delivery en diferenciadores de plan (Business+):** crear keys `gastronomia` y `delivery` en `features` y gatear sus RPCs con `tenant_has_feature_for`, manteniendo el flag operativo del dueño como capa adicional (el negocio elige activarlo si su plan lo incluye). Hoy son sólo flags operativos gratuitos. **No se crean keys nuevas en este PR** (es trabajo de migración/RPC de otro agente); por eso no se agregan a `featureInfo` todavía.
- **Mover `agenda` y `packs` a Pro+** como diferenciadores (hoy `is_basic=true`), con su gating server-side.

### Distribución sugerida de los 4 planes (referencia comercial)

- **Start:** sólo BASE (pos, caja, stock, productos, clientes, categorías, reportes, efectivo, transferencia, notificaciones, email_comprobantes, **panel_dueno**, **devoluciones**).
- **Pro:** Start + `agenda`, `packs`, `descuentos`, `tickets_pro`, `grupos_clientes`, `variantes`, `catalogo_publico`, `personalizacion_marca`, Mercado Pago.
- **Business:** Pro + Gastronomía, Delivery, `garantias`, `cuenta_corriente`, `listas_precios`, `multi_sucursal`, `metricas_avanzadas`, gateways de tarjeta restantes.
- **Enterprise:** todo (incluye `api_publica`, `backup`, `soporte_prioritario`, `roles_permisos` granular cuando existan).

### Consecuencias

- **Positivas:** se cierra el gating decorativo de `panel_dueno`; la taxonomía deja explícito qué se puede vender como gateado y qué no; el checklist evita que una feature nueva quede sin enforcement server-side.
- **Negativas:** `agenda`/`packs`/Gastronomía/Delivery siguen siendo "gratis para todos" hasta ejecutar la decisión diferida; la comparación muestra features MARKETING-FUTURO aún sin enforce.
- **Seguimiento:** ejecutar las decisiones diferidas (keys `gastronomia`/`delivery`, mover `agenda`/`packs` a Pro+) y, antes de vender cualquier MARKETING-FUTURO como diferencial, implementar su gating real.

### Referencias

- `lib/saas/featureInfo.ts`, `lib/saas/planComparison.ts`, `components/internal/plans/PlanEditorModal.tsx`.
- `CLAUDE.md` §6 (Convención de features de plan).
- Migraciones: `20260608110000_features_plans_addons.sql`, `20260608150000_plans_overhaul.sql`, `20260608540000_agenda.sql`, `20260608560000_service_packs.sql`, `20260608410000_writefeature_gating.sql`.

---

## Próximas ADRs (placeholder)

Cuando se tomen decisiones sobre proveedor de pagos concreto por integración, motor de impresión de tickets, estrategia de backups o cualquier otra cosa estructural, se agregan acá siguiendo el template.
