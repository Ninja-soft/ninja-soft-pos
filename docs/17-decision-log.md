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

### Addendum 2026-10-11: validación contra la API demo de mobbex.dev

Se replicaron `mobbex_create_qr` y `mobbex_webhook` con las credenciales demo públicas de mobbex.dev y se contrastó con la doc oficial (Checkout, Webhooks, Consulta de operaciones, Códigos de estado). Cambios:

- **Errores con HTTP 200.** Mobbex responde `200 { result:false, code, error }` (p. ej. `MRPERR` "Parametros obligatorios faltantes"); antes se tomaba como éxito. Ahora es `502 mobbex_error` con `code`/`detail`.
- **Re-consulta del webhook.** `GET /p/operations/{CHK:…}` devuelve `result:false GENERIC:EFCS`: el id del checkout (lo que se guardaba en `preference_id` y se consultaba primero) **no es una operación**. Ahora se consulta `data.payment.id` del cuerpo (`GET /p/operations/{uid}` → `data.transaction.payment`) y, si no resuelve, `GET /p/entity/operations?reference=<intentId>` (`docs[]`, con `status` string plano). Nunca el CHK. `mp_payment_id` guarda el id real de la operación.
- **Estados** (mobbex.dev/codigos-de-estado): aprobado = 200 Paga, 300 Acreditado, 301 Liquidado; pendiente = 0, 1, 2 En espera, 3 Autorizada, 100 En revisión, 210 Retenida; el resto (4xx/6xx) rechazo. Se aceptan códigos número o string.
- **`webhooksType: "final"`** (parámetro de raíz del checkout, aceptado por la API): no llegan los intentos fallidos. Además, un rechazo con el checkout abierto deja el intent **pendiente** (el cliente puede reintentar); sólo el webhook `checkout:expired` sin pago aprobado lo rechaza. Un `pending`/`rejected` ya no pisa un intent que no esté pendiente; `approved` sí gana sobre uno cancelado (queda en la conciliación).
- **Monto:** se compara `requestedTotal` (lo que pidió el checkout) y, si no viene, `total`, contra `mp_payment_intents.amount`.
- **`customer` obligatorio en la práctica:** sin él Mobbex devuelve el warning "No customer declared … your checkout won't be created on the future". Se manda `{ email, name, identification }` del cliente de la venta (`customer_id` desde el POS, validado contra el tenant) y, si falta algún dato, el email del cajero, "Consumidor Final" e identificación `"0"` (aceptado por la API demo sin warning; Mobbex no documenta un placeholder oficial).
- **Cuotas: se deja de mandar `installments`.** El formato documentado es un array de **referencias de planes de la cuenta Mobbex del comercio** (`["1","3","ahora_12"]`, `"-ref"` para ocultar, `"+uid:…"` reglas avanzadas); nuestro `{ enabled, list:[{ months, recharge }] }` no existe en la API y se ignoraba. Lo que se vio en la validación de junio eran los planes que la cuenta Mobbex ya tenía configurados, no los del grid. No se mapea grid → referencias porque las referencias (salvo `ahora_N`) dependen de cada cuenta y no son verificables desde acá. Consecuencia: en Mobbex el grid de Planes **sólo suma el recargo al total** (como en Mercado Pago); las cuotas e interés que ve el cliente son los de su cuenta Mobbex. Copy del editor de planes actualizado; no se promete `surcharge_pct` por checkout.
- Lógica pura en `supabase/functions/_shared/mobbex.ts`, testeada con las respuestas reales (`tests/unit/mobbexSandbox.test.ts`).
- **Pendiente:** confirmar con un pago real la forma exacta de `docs[]` del listado y de `requestedTotal` cuando el cliente elige cuotas con interés.

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

## ADR-027 — Mercado Point por Point Integration API reutilizando la conexión MP del tenant

**Fecha:** 2026-07-10 · **Estado:** aceptada · **Hito:** F8 · H15 (resto)

### Contexto

H15 dejó pendiente el cobro presencial con lectores Mercado Point. Las alternativas eran (a) integrar la Point Integration API de Mercado Pago con las credenciales MP que el tenant ya conecta (OAuth/token, `payment_secrets` provider `mercadopago`), o (b) pedir credenciales propias por proveedor como hace Mobbex/MODO.

### Decisión

(a): la Edge Function `mp_point` (actions `devices` / `pdv` / `create` / `status` / `cancel`) reutiliza el token MP del tenant (con el mismo refresh OAuth de `mp_create_qr`). El cobro se empuja AL lector (modo PDV) con `external_reference` = intent local (`mp_payment_intents`, `provider_key='mercadopago_point'`, nueva columna `point_device_id`; `preference_id` guarda el payment_intent_id de la Point API). El POS sondea `status`; sólo se acredita con verificación independiente contra `/v1/payments` (estado `approved` + monto exacto — patrón conservador de `modo_webhook`). La venta se registra como `debit`/`credit` según `payment_type_id` real; las cuotas las elige el cliente en el lector (como MODO), por eso Point no tiene grid de planes ni recargo propio en Medios de pago. Gating de plan server-side en `create` (`tenant_has_feature_for('mercadopago_point')`); la feature/planes/`payment_method_plan_key` ya existían.

### Consecuencias

- Un negocio con MP conectado habilita Point con un switch (sin credenciales nuevas); el lector se elige por caja (se recuerda el último en `localStorage`).
- Conciliación: los intents Point comparten `mp_payment_intents`, así que el modal "Cobros QR" de /ventas los cruza igual que MP/Mobbex/MODO.
- **Pendiente de validación con lector físico real** (criterio del roadmap: "cobro real en sandbox"): el dialecto de la Point API está implementado según documentación pública; el primer cobro en vivo puede requerir ajustes menores.
- Nave quedó con el backend de credenciales listo (`set_payment_secret` ALLOWED) pero **sin integración de cobro** (H21c): la UI lo mantiene como "Próximamente", igual que Payway/Getnet/Fiserv/Pagos360 (deuda MARKETING-FUTURO ya registrada en ADR-026).

### Referencias

- `supabase/functions/mp_point/index.ts`, `supabase/migrations/20260710140000_mp_point.sql`.
- `components/pos/PointCheckoutModal.tsx`, `app/(app)/pos/page.tsx`, `components/dashboard-team/PaymentMethodsCard.tsx`, `modules/pos/api.ts`.

---

## ADR-028 — Pagos360 por polling server-side (sin webhook obligatorio)

**Fecha:** 2026-07-10 · **Estado:** aceptada · **Hito:** F8 · H21

### Contexto

Pagos360 notifica pagos por webhooks configurados a nivel cuenta (panel), no por solicitud — exigirlo complica el alta de cada comercio. MP/Mobbex/MODO actualizan `mp_payment_intents` vía webhook propio y el POS sólo lee la fila local.

### Decisión

La Edge `pagos360` expone `create` (payment_request con `external_reference` = intent local, `checkout_url` como `init_point`) y `status`, que **sincroniza contra la API de Pagos360 en cada poll del POS** (patrón `mp_point`): sólo acredita con `state=paid` y monto exacto. `QrCheckoutModal` gana el provider `pagos360` (self-managed: medio/cuotas se eligen en el checkout hosted; sin grid de planes) y el poll usa la Edge en vez de la fila local. Sandbox: `tenant_payment_methods.sandbox` decide `api.sandbox.pagos360.com` vs producción — el flujo completo es probable sin plata real. La venta se registra como `method='qr'` → el trigger de `payments` resuelve el provider del intent y exige la feature `pagos360` (gating fino ya mapeado).

### Consecuencias

- Alta simple: API Key + switch sandbox; sin configuración de webhooks.
- El costo es un GET a Pagos360 cada 3 s mientras el modal espera (acotado a la vida del cobro).
- **Pendiente:** validar contra el sandbox real de Pagos360 con una API Key propia (criterio del roadmap, mismo estado que MODO/H16).

### Referencias

- `supabase/functions/pagos360/index.ts`, `components/pos/QrCheckoutModal.tsx`, `modules/pos/api.ts`, `app/(app)/pos/page.tsx`, `components/dashboard-team/PaymentMethodsCard.tsx`.

---

## ADR-029 — Payway por Formulario de pago hosted (checkout-payment-button)

**Fecha:** 2026-07-10 · **Estado:** aceptada · **Hito:** F8 · H17

### Contexto

Payway/Prisma es gateway de tarjetas e-commerce: el flujo clásico exige tokenizar la tarjeta (PCI, datos sensibles en el front). Para un POS de mostrador eso no aplica; lo que sí aplica es su **Formulario de pago hosted** ("checkout payment button"), documentado en el SDK oficial `payway-ar/sdk-node-ventaonline`, con **sandbox público** (`developers.decidir.com`).

### Decisión

Edge `payway` con `create` (POST `{checkout}/link` con apikey privada en header y `public_apikey`/`site` en el body → `{web}/checkout/{payment_id}` como `init_point`) y `status` (GET `{v2}/payments/{payment_id}`; sólo acredita con `approved` + **monto exacto en centavos** — v2 informa centavos). `payway_webhook` (verify_jwt=false) recibe `notifications_url` pero **nunca acredita a ciegas**: re-verifica contra la API con la apikey del tenant; su GET sirve la pantalla neutra de retorno del cliente (`success_url`/`cancel_url`). El POS reusa `QrCheckoutModal` (self-managed) y el canal `method='qr'` (gating fino por intent ya mapeado). Credenciales: API Key pública + privada + Nº de comercio (`site`); ambiente por el switch Sandbox del medio.

### Consecuencias

- Cobro con tarjeta vía link/QR sin PCI en NinjaPos (la tarjeta se ingresa en el form de Payway).
- Doble camino de confirmación (webhook re-verificado + polling) sin depender de configuración de webhooks en el panel del comercio.
- **Pendiente:** validar con credenciales de sandbox propias del comercio (mismo estado que MODO/Pagos360: el dialecto viene del SDK oficial, falta el cobro de prueba).
- `installments:[1]` en v1: los planes de cuotas de Payway (template/cc del comercio) quedan para el follow-up de cuotas (H58/F14).

### Referencias

- `supabase/functions/payway/index.ts`, `supabase/functions/payway_webhook/index.ts`, `components/pos/QrCheckoutModal.tsx`, `modules/pos/api.ts`, `app/(app)/pos/page.tsx`, `components/dashboard-team/PaymentMethodsCard.tsx`.
- SDK oficial: github.com/payway-ar/sdk-node-ventaonline (endpoints, headers, payload y URLs de formulario).

### Addendum 2026-10-11: checkout propio validado en el sandbox público

Desde H17b el cobro no usa el formulario hosted: `/pagar/{intent}` tokeniza la tarjeta en el navegador (`POST {v2}/tokens`, API Key pública) y `payway_checkout` cobra con la privada (`POST {v2}/payments`). El link del formulario hosted no se pudo validar (412 con las keys públicas). Validado en `developers.decidir.com` con las keys públicas de los SDK oficiales: token 201, pago 201 approved con **monto en centavos** (eco exacto), `GET /payments/{id}` igual al 201. Cambios:

- **Errores vs rechazos.** Sólo `status:"rejected"` (402, motivo en `status_details.error.reason.description`) es rechazo del emisor → `402 rejected_attempt`. Los errores reales de request/gateway (`404 not_found_error` por token inexistente, `400 invalid_request_error` con `validation_errors` como `repeated:token` o `CardData:expired card`, `400 api_error`) ahora son `502 payway_error` con `reason` (`token` / `card_data` / `gateway`), `error_type` y `detail`. Antes todo era "rechazado por el emisor". El copy del cliente en `/pagar` sale de `lib/payments/paywayMessages.ts`.
- **Eco del monto:** se aprueba sólo si `amount` de la respuesta == centavos calculados server-side; si difiere, el intent queda `rejected` y la respuesta es `502 payway_error amount_mismatch`.
- **Estados intermedios** (2xx sin approved/rejected): se guarda el id de pago, el intent sigue pendiente, la página muestra "en revisión" y no acepta otro pago (`409 payment_in_review`). El poll del POS (Edge `payway` action `status`) re-verifica con `row.mp_payment_id` contra `GET /payments/{id}` (approved + centavos exactos + `site_transaction_id` == intent).
- **Webhook:** no se manda `notifications_url` y la aprobación es sincrónica, así que `payway_webhook` queda **inofensivo**: se quitó el guard muerto de `preference_id` (que `create` nunca setea) y sólo actualiza con la misma verificación que el status (incluida la correlación por `site_transaction_id`).
- Ya no se escribe el string `"null"` en `mp_payment_id` (el status usaba `String(row.preference_id)`).
- **Marcas → `payment_method_id`** (tabla `PAYWAY_BRANDS` en `supabase/functions/_shared/payway.ts`): Visa 1 y **Visa Débito 31** aprobados en sandbox; Amex 65 aceptado por el sandbox (emisor de prueba fuera de línea); Mastercard 104, Maestro 106, Cabal 63, Naranja 24 y Diners 8 son de la doc pública, **sin verificar** (Mastercard devolvió `api_error` de 3DS en sandbox). Débito siempre en 1 pago.
- Lógica pura en `supabase/functions/_shared/payway.ts`, testeada con las respuestas reales (`tests/unit/paywaySandbox.test.ts`).

---

## ADR-030 — Nave (QR/link + Point) vía Payment Requests de Ranty

**Fecha:** 2026-10-11 · **Estado:** aceptada (pendiente de validar con credenciales sandbox del comercio) · **Hito:** F8 · H21c

### Contexto

Nave (Banco Galicia / Naranja X, plataforma Ranty) expone APIs públicas cloud para cobrar por **QR interoperable + checkout hosted** (`payment_requests/ecommerce` → `qr_data` + `checkout_url`) y por **terminal Nave Point** (`payment_requests/smart_pos` al terminal del `seller.pos_id`). Auth `client_credentials` contra apinaranja (`homoservices` sandbox / `services` prod, audience `https://naranja.com/ranty/merchants/api`, token 86400 s). La URL de notificaciones **se registra en el onboarding** (no viaja por request) y la notificación trae `{payment_id, payment_check_url, external_payment_id}`. Desde ADR-027 Nave estaba en el catálogo con credenciales aceptadas pero sin cobro; desde `20261011150000_payment_channels` existen las features `nave` (QR + link) y `nave_point` (Point, desde Pro), ya mapeadas en `payment_method_plan_key`.

### Decisión

- **Una conexión por marca:** `payment_secrets` provider `nave` guarda `client_id`, `client_secret`, `pos_id` (QR + link), `point_pos_ids` (terminales, "Nombre: id" separados por coma) y `audience` opcional; ambiente por `tenant_payment_methods.sandbox` de la fila `nave`. Nave Point **reutiliza** esa conexión (no hay secretos `nave_point`). Sin migraciones.
- **Edge `nave`** (create/status/cancel) y **Edge `nave_point`** (devices/create/status/cancel) sobre la tabla compartida `mp_payment_intents` (`provider_key` `nave` | `nave_point`): `external_payment_id` = id del intent (36 chars), `preference_id` = `payment_request_id`, `init_point` = `checkout_url`; el `qr_data` se devuelve al POS y se codifica **tal cual**. El intent se persiste antes de entregar el QR/link. Sin reintento automático del POST (Nave no documenta idempotencia).
- **Edge `nave_webhook`** (verify_jwt=false): nunca confía en el cuerpo. Correlación por `external_payment_id`; la URL a consultar se valida (https, host Nave **exacto del ambiente**: `api.ranty.io` en prod, `api-sandbox.ranty.io`/`e3-api.ranty.io` en sandbox, sin userinfo/puerto/query, path `/integrations/payments/{payment_id}` con el mismo id) o se construye desde la base confiable (anti-SSRF). Sólo `status.name=APPROVED` + correlación + **monto exacto** (transacción PURCHASE, sin propina) acredita. Transiciones condicionales (idempotente ante los 5 reintentos de Nave); 5xx ante fallas transitorias para que Nave reintente. También procesa la baja de intenciones Point (`DISABLED` por batería, cancelación en terminal, timeout).
- **Fallback del poll** (`status`): `GET payment_requests/{id}` → pago aprobado en `payment_attempts` → verificación contra `GET payments/{id}` con la MISMA lógica del webhook. `EXPIRED/DISABLED/BLOCKED` → cancelled; `FAILURE_PROCESSED` → rejected en Point, pendiente en QR (el cliente puede reintentar).
- **Cancelar** = `DELETE payment_requests/{id}` best-effort; si el pago ya estaba aprobado, gana el pago (queda approved para la conciliación "Cobros QR", nunca se pierde plata cobrada). Un pago verificado que llega tarde sobre un intent cancelado/rechazado también queda approved + auditoría `approved_after_*`.
- **Token:** cache en memoria por isolate (nunca en DB), renovado 60 s antes del vencimiento; 401 en cualquier llamada → descarta, re-autentica y reintenta UNA vez.
- **Gating server-side** en create: `tenant_has_feature_for(tenant,'nave' | 'nave_point')`; además el trigger de `payments` resuelve el provider del intent QR (`nave` → feature `nave`). El `pos_id` de Point debe ser una terminal configurada del tenant.
- **Auditoría** (`audit_logs`, entity `mp_payment_intents`): creación de la intención, aprobación, rechazo, mismatch de monto/correlación, cancelación, baja y estados post-pago (CANCELLED/REFUNDED/…, que se preservan sin remapear).
- Lógica pura (ambientes, payload, mapeo de estados, validación de host, verificación de monto, cliente con 401) en `supabase/functions/_shared/nave.ts`, testeada con Vitest (`tests/unit/nave.test.ts`).

### Consecuencias

- El dueño conecta Nave con Client ID + Client Secret + punto de venta (+ terminales Point) y elige Producción/Prueba al conectar; el form muestra la URL de notificaciones que tiene que pasarle a Nave (una por ambiente).
- `QrCheckoutModal` gana el provider `nave` (self-managed, QR = `qr_data`, link = `checkout_url`, cancelar da de baja la intención) y `PointCheckoutModal` el provider `nave_point` (terminales configuradas, sin modo PDV, débito/crédito según `payment_method.card_type`; QR pagado en la terminal cuenta como débito). Los botones de cobro del POS quedan para el rediseño del POS (tenders).
- `payment_link` no se usa: `checkout_url` del tipo ecommerce ya cubre "mandar link" y la guía oficial lo deja fuera de alcance. Devoluciones/anulaciones quedan fuera (sin flujo de negocio definido).
- **Pendiente:** validar con credenciales sandbox del comercio (pos_id de prueba + URL de notificaciones registrada por Nave, `integraciones@navenegocios.com`) y luego producción. Sandbox de Point documentado en `e3-api.ranty.io`, el de QR en `api-sandbox.ranty.io`: confirmar en el primer cobro de prueba.

### Referencias

- `supabase/functions/nave/index.ts`, `supabase/functions/nave_point/index.ts`, `supabase/functions/nave_webhook/index.ts`, `supabase/functions/_shared/nave.ts`, `supabase/functions/_shared/nave_server.ts`.
- `components/pos/QrCheckoutModal.tsx`, `components/pos/PointCheckoutModal.tsx`, `modules/pos/api.ts`, `components/dashboard-team/PaymentMethodsCard.tsx`, `components/sales/QrIntentsModal.tsx`.
- Docs oficiales: developer-portal-doc-mfe-website-mfe.ranty.io (guía "Nave Dynamic QR Integration" V1.1 y sección Nave Point).

---

## ADR-031 — Getnet (QR/link) vía Checkout Geopagos

**Fecha:** 2026-10-11 · **Estado:** aceptada (pendiente de validación con cobro real) · **Hito:** F8 · H18

### Contexto

Getnet Argentina (Santander) corre sobre la plataforma white-label de **Geopagos**. No hay documentación pública de la API de Argentina (docs.globalgetnet.com cubre la API regional/global, que es otra) ni **sandbox público de Getnet AR** (no se encontró ninguno; las credenciales se generan en `dashboard.globalgetnet.com.ar/dashboard/merchant/credentials` y son de producción). La única referencia oficial ejecutable es el plugin de WooCommerce publicado por Getnet Argentina (`integrar-getnet-con-woo` v0.1.5).

### Decisión

Canal **QR + link** (`getnet`) por el Checkout de Geopagos, mismo patrón que Payway/Pagos360:

- Edge `getnet` (verify_jwt **true**) con `create` y `status`. `create` exige `tenant_has_feature_for(tenant,'getnet')`, pide token OAuth2 `client_credentials` a `https://auth.geopagos.com/oauth/token`, crea un intent en `mp_payment_intents` (`provider_key='getnet'`) y la orden `POST https://api.globalgetnet.com.ar/api/v2/orders` con un único ítem por el total (centavos, moneda `032`), `webhookUrl` por orden (`getnet_webhook?intent=<uuid>`), `redirect_urls` a la pantalla neutra de retorno y `expireLimitMinutes: 30`. El checkout hosted (`data.links[0].checkout`) es el `init_point` que `QrCheckoutModal` muestra como QR y "Abrir link de pago" (provider self-managed: tarjeta/cuotas se eligen en Getnet). `status` re-consulta `GET /api/v2/orders/{uuid}`.
- Edge `getnet_webhook` (verify_jwt **false**): **nunca confía en el cuerpo**. Re-consulta la orden guardada al crear (`preference_id`) con el token del tenant; el `data.order.uuid` del cuerpo sólo descarta notificaciones ajenas. Acredita sólo `APPROVED`/`PROCESSED`/`SUCCESS` con **monto exacto en centavos**; sin monto legible no acredita (queda pending). Idempotente con updates condicionales por estado; un intent ya aprobado no se toca, y uno que el POS dio por rechazado puede pasar a `approved` si Getnet lo confirma (aparece en la conciliación como cobro sin venta).
- Lógica pura (payload, token, estados, monto) en `supabase/functions/_shared/getnet.ts`, testeada con Vitest (`tests/unit/getnet.test.ts`). Auditoría en `audit_logs` (`getnet_order_created`, `getnet_payment_<estado>`).
- Credenciales por tenant: `client_id` + `client_secret` vía `set_payment_secret` (`getnet` ya estaba en ALLOWED). **Sin switch Sandbox** para Getnet: no hay ambiente de prueba AR; la columna `sandbox` se ignora.
- Gating: feature `getnet` (ya existente, `payment_method_plan_key('getnet')='getnet'`); la venta entra como `method='qr'` con `reference` = intent, y el trigger de `payments` resuelve el provider del intent. Sin migraciones nuevas.

**Verificado (plugin oficial):** URL y body del token; URL, headers `application/vnd.api+json` y body de la orden (ítems con `unitPrice.amount` en centavos como string, `redirect_urls`, `webhookUrl`, `expireLimitMinutes`); checkout en `data.links[0].checkout`; webhook con `data.order.uuid`; `GET /api/v2/orders/{uuid}` con `status` en la raíz y los estados aprobados `APPROVED`/`PROCESSED`/`SUCCESS`.

**Inferido (a confirmar con el primer cobro real):** uuid de la orden en `data.id` (fallback `attributes.uuid`); forma del monto en el GET (se prioriza la suma de ítems, fallback `amount`/`total`); estados de rechazo (`REJECTED`/`DECLINED`/`DENIED`/`FAILED`) y vencimiento (`EXPIRED`/`CANCELLED`); que el GET acepte el mismo Bearer (el plugin arma ese header de forma inválida, así que no lo prueba); que el checkout hosted ofrezca pago desde el celular escaneando el QR; tope de largo de `webhookUrl`.

### Getnet Point (`getnet_point`): NO se implementa

Sigue "Próximamente". La integración de terminales de Getnet ("Integrated POS" de Getnet Global: SDK .NET/JS/Android, modos Http/Usb/Cloud2Cloud) no está confirmada para Argentina y todo indica que es **sólo para partners homologados**. Para implementarla haría falta: (1) alta como partner/integrador con Getnet AR y credenciales de terminal; (2) documentación del modo Cloud2Cloud para AR (endpoint para empujar un monto a una terminal por id, consulta de estado y cancelación); (3) terminales de prueba o homologación; (4) una Edge `getnet_point` con el patrón de `mp_point` (intent + poll + verificación de monto) y su feature `getnet_point` (ya existe en el catálogo y en `payment_method_plan_key`).

### Consecuencias

- Getnet queda transaccionable por QR/link sin PCI en NinjaPos; el cobro de prueba debe hacerse con credenciales y tarjeta reales por un monto chico (no hay sandbox).
- Mientras el monto del GET no se confirme, un pago aprobado sin monto legible queda pending (el webhook o el poll lo resuelven cuando se ajuste el parser): se prefiere no acreditar a acreditar sin verificar.
- La botonera del POS (`app/(app)/pos/page.tsx`) no se tocó: el rediseño del POS cablea el tender de Getnet hacia `QrCheckoutModal` con `provider="getnet"`.

### Referencias

- `supabase/functions/getnet/index.ts`, `supabase/functions/getnet_webhook/index.ts`, `supabase/functions/_shared/getnet.ts`, `tests/unit/getnet.test.ts`, `components/pos/QrCheckoutModal.tsx`, `components/dashboard-team/PaymentMethodsCard.tsx`, `modules/pos/api.ts`, `lib/saas/featureInfo.ts`.
- Plugin oficial: wordpress.org/plugins/integrar-getnet-con-woo (v0.1.5, `wanderlust-getnet.php`).

---

## ADR-032 — Mercado Pago presencial sobre Orders API (QR dinámico + Point)

**Fecha:** 2026-10-11 · **Estado:** aceptada (pendiente de deploy y validación en sandbox) · **Hito:** F8 · H15

### Contexto

Mercado Pago unificó el cobro presencial en la **Orders API** (`/v1/orders`): "todas las nuevas funcionalidades se desarrollarán sobre esta API" (migration hub). NinjaPos cobraba (a) el "QR" de MP renderizando como QR el `init_point` de una preferencia de Checkout Pro (un link web, no un QR de caja interoperable) y (b) Point con la Payment Intents API, que la doc ya marca como legacy (ADR-027). Además el QR se dibujaba con un servicio externo de imágenes (`api.qrserver.com`), filtrando el payload de cobro a un tercero.

### Decisión

1. **QR dinámico en la caja** (Edge nueva `mp_qr`, feature `mercado_pago`): `POST /v1/orders` type `qr`, `config.qr.mode = "dynamic"`, `external_pos_id` de la caja del tenant, `X-Idempotency-Key` = id del intent, `expiration_time` PT15M; status por `GET /v1/orders/{id}` (polling server-side, no depende del webhook) y cancel por `POST /v1/orders/{id}/cancel`. **Alta única de sucursal + caja** desde Medios de pago (`GET /users/me` → `POST /users/{id}/stores` → `POST /v2/pos`, reutilizando los existentes por `external_id` estable del tenant); los ids se guardan por ambiente en `tenant_payment_methods(mercadopago).config.mp_qr.{prod|test}`. El QR se dibuja **local** desde `qr_data` con un encoder propio sin dependencias (`lib/qr/qrcode.ts`, mismo criterio que ADR-021), validado decodificando con zxing en los tests.
2. **Link de Checkout Pro se mantiene** como "Enviar link" (compartible) y como **fallback automático** cuando el negocio no configuró la caja (`qr_pos_not_configured`): nadie pierde el cobro por MP al deployar. Pasar de QR a link cancela la order y re-consulta su estado antes de generar el link (si el cliente justo pagó, se registra ese cobro; nunca dos).
3. **Point sobre Orders API** (`mp_point`, feature `mercadopago_point`): terminales `GET /terminals/v1/list`, modo PDV `PATCH /terminals/v1/setup`, `POST /v1/orders` type `point` con `terminal_id`, preselección opcional débito / crédito / cuotas (`default_installments` + `installments_cost: buyer`), cancel con `x-allow-cancelable-status: at_terminal` (202 = cancelación pedida: el modal sigue sondeando y si el cliente ya pagó la venta se registra igual). **Compatibilidad:** los intents sin `mp_order_id` (Payment Intents API) siguen resolviendo status/cancel por el camino legacy.
4. **Webhook topic `order`** (Edge nueva `mp_orders_webhook`, `--no-verify-jwt`): sólo toma `data.id`, busca el intent por `mp_order_id`, **re-lee la order con el token del tenant** en el ambiente del intent y aplica la misma regla que el polling (`_shared/mpIntents.ts`): acredita sólo order `processed` (detalle processed/accredited) + pago `processed` + **monto exacto en centavos** + `external_reference` = intent; idempotente (transiciones desde pending; `approved` se registra aunque el intent se haya cerrado localmente, para que la conciliación lo vea). Responde 200 enseguida (`EdgeRuntime.waitUntil`). La firma `x-signature` no se valida: el ancla de confianza es la re-lectura con el token del tenant (y con token manual el secreto sería el de la app del comercio, no el nuestro).
5. **Sandbox de Mercado Pago**: no hay host de prueba; cambia la credencial. `payment_secrets(mercadopago).test_access_token` convive con la conexión de producción (`set_payment_secret` gana `merge`/`remove`; el OAuth y el reemplazo del token de producción lo conservan). Se usa sólo con el switch (`tenant_payment_methods.sandbox`) **y** token de prueba cargado; el intent guarda `mp_env` para que status/cancel/webhooks usen la misma credencial. La migración normaliza `sandbox=false` en las filas MP (nacieron con default true y nunca tuvo efecto). Point comparte conexión y switch.
6. Lógica pura (payloads, mapeo de estados, monto, credencial, parseo de webhook, validación de sucursal) en `supabase/functions/_shared/mpOrders.ts`, sin imports, testeada con Vitest (`tests/unit/mpOrders.test.ts`). Gating sin cambios: `tenant_has_feature_for` en las Edge + trigger de `payments` (`payment_method_plan_key`: mercadopago → mercado_pago, mercadopago_point → mercadopago_point). Auditoría: alta/reset de caja, modo PDV, cancelaciones, acreditaciones y montos que no cierran.

### Alternativas consideradas

- **Seguir con Checkout Pro como QR:** funciona, pero no es un QR de caja (no interoperable, abre un checkout web) y queda fuera de la evolución de MP.
- **QR estático por caja:** un sticker sirve para cualquier monto, pero exige asociar la order a la caja en el momento y es más propenso a cobros cruzados entre cajeros; el dinámico (un QR por cobro) es más seguro para un POS.
- **Agregar una librería de QR (`qrcode`):** tocaba `package.json`/lockfile (archivos sensibles) para ~350 líneas de algoritmo estable; se prefirió el encoder propio testeado.

### Consecuencias

- Deploy: migración `20261011170000_mp_orders_api` **antes** de las Edge (usan `mp_order_id`/`mp_env`). Edges: `mp_qr`, `mp_point`, `mp_orders_webhook` (`--no-verify-jwt`), `mp_create_qr`, `mp_webhook`, `set_payment_secret`, `mp_oauth_callback`.
- Configurar en la app de MP de NinjaSoft (Webhooks → evento Order) la URL `.../functions/v1/mp_orders_webhook`. Los comercios con token manual usan su propia app: sin esa configuración el polling igual resuelve el cobro con el modal abierto.
- **Pendiente de validación:** alta de sucursal (MP valida `city_name` contra su catálogo de localidades: puede rechazar nombres que no coincidan), cuotas preseleccionadas en Point (las habilita el equipo comercial de MP), y el primer cobro QR + Point en sandbox y en vivo.
- La pantalla del cliente (H25) recibe el `qr_data` igual que antes recibía el link; sigue dibujando con el servicio externo hasta el rediseño del POS (fuera de alcance).
- **2026-10-12, "QR en el mostrador":** la alta ya no pide coordenadas. Acción `geocode` de `mp_qr`: sin dirección arma el borrador con `tenants.name` + `tenant_branding.address` (o la del local por defecto) y lo ubica con OpenStreetMap Nominatim (`countrycodes=ar`, User-Agent `NinjaPOS/1.0 (soporte@soft.ninja)`, 1 req/s por instancia, cache del último resultado en `config.mp_qr_geo`). `setup` acepta `latitude`/`longitude` o geocodifica él mismo (`geocode_not_found` / `geocode_unavailable`); en Capital, `city_name` es el barrio del mapa (MP no toma "CABA"); `mp_store_error` devuelve el campo señalado por MP. Lógica pura en `mpOrders.ts` (`parseBusinessAddress`, `normalizeArState`, `pickGeocodeResult`, `mpCityName`, `mapMpQrError`), testeada en `tests/unit/mpQrLocal.test.ts`. Coordenadas a mano sólo como respaldo oculto.

### Referencias

- Docs oficiales: developers/es/docs/qr-code/overview · reference/in-person-payments/qr-code/orders/create-order/post · docs/qr-code/notifications · docs/qr-code/create-store-and-pos · docs/qr-code/resources/status-order-transaction · docs/mp-point/payment-processing · docs/mp-point/notifications · docs/qr-code/resources/migration-hub.
- `supabase/functions/mp_qr/index.ts`, `supabase/functions/mp_point/index.ts`, `supabase/functions/mp_orders_webhook/index.ts`, `supabase/functions/_shared/{mpOrders,mpAuth,mpIntents}.ts`, `supabase/migrations/20261011170000_mp_orders_api.sql`, `lib/qr/qrcode.ts`, `components/pos/QrCheckoutModal.tsx`, `components/pos/PointCheckoutModal.tsx`, `components/dashboard-team/PaymentMethodsCard.tsx`, `modules/pos/api.ts`.

---

## ADR-033 — GO Cuotas (QR + link) vía API Redirect V1

**Fecha:** 2026-10-11 · **Estado:** aceptada (pendiente de migración, deploy y validación en sandbox) · **Hito:** F8 · H21d

### Contexto

El dueño pidió integrar GO Cuotas: el cliente paga en 2 a 4 cuotas sin interés con su **tarjeta de débito**. GO Cuotas publica su API en Stoplight (`gocuotas-api.stoplight.io/docs/gocuotas`, leída 2026-10-11) con varias APIs: **Redirect V1** (checkout web), **QR V1** (venta en local), Light/Full Sale V1 (código por SMS que carga el comercio) y Client V1 (liquidaciones). Hosts: `https://www.gocuotas.com` (producción) y `https://sandbox.gocuotas.com`. Cada sucursal tiene **API Key** propia (una de producción y otra de prueba) que se manda como `Authorization: Bearer <API_KEY>` y no expira.

### Decisión

- **Canal QR + link por Redirect V1** (provider/feature `gocuotas`, marca `gocuotas`, canal `qr_link`, OPTIONAL desde Pro). `POST /api_redirect/v1/checkouts` con los parámetros **por query** (como documenta la API): `amount_in_cents`, `order_reference_id` = id del intent, `webhook_url` = `gocuotas_webhook?intent=<uuid>`, `url_success`/`url_failure` a la pantalla neutra de retorno. La respuesta es `{ url_init }`, que el POS muestra como QR y "Abrir link de pago" (`QrCheckoutModal`, provider self-managed: el cliente elige las cuotas en GO Cuotas).
- **QR V1 descartado:** `POST /api/qr/v1/checkouts` devuelve sólo `sale_token`/`status`/`expire_at`, sin un payload escaneable (el QR es el del local) y con **una sola venta activa por vendedor**. No sirve para un QR por cobro en pantalla; Redirect sí.
- **Edge `gocuotas`** (JWT): `create` (gating `tenant_has_feature_for(tenant,'gocuotas')`, valida monto y **mínimo de $1.500** antes de crear el intent → `gocuotas_min_amount` con copy claro; 401/403 → `gocuotas_auth_failed`), `status` (re-consulta) y `cancel` (baja local: Redirect no anula checkouts sin pagar; antes de cancelar re-consulta por si el cliente justo pagó).
- **Correlación sin id de orden:** el checkout no devuelve id. La orden se ubica por la pista del webhook (`order_id` → `GET /api_redirect/v1/orders/{id}`) y, si no corresponde, por `GET /api_redirect/v1/orders?delivered_start&delivered_end&order_reference_id=<intent>` (ventana en hora AR desde 24 h antes del intent). **Sólo cuenta una orden con `order_reference_id` = intent.** El id de orden aprobado se guarda en `mp_payment_id` y una orden acredita a un único intent.
- **Edge `gocuotas_webhook`** (verify_jwt **false**): GO Cuotas no documenta firma, así que el cuerpo es sólo una pista. Re-consulta con la API Key del tenant en el ambiente del intent y acredita sólo `approved` + referencia propia + **monto exacto en centavos**; `denied` → rejected. Idempotente (updates condicionales; un approved verificado pasa también desde rejected/cancelled para que la conciliación lo vea). Siempre 200. Su GET sirve la pantalla neutra de retorno.
- **Ambiente:** switch Sandbox del medio (`tenant_payment_methods.sandbox`). El intent guarda `mp_env` (`test` = sandbox) y status/webhook usan ese host aunque cambie el switch.
- Credencial `payment_secrets(gocuotas) = { api_key }` vía `set_payment_secret` (ALLOWED += `gocuotas`). Lógica pura en `supabase/functions/_shared/gocuotas.ts` (Vitest, `tests/unit/gocuotas.test.ts`); helpers server en `_shared/gocuotas_server.ts`. Auditoría: `gocuotas_checkout_created`, `gocuotas_checkout_cancelled`, `gocuotas_payment_<estado>`.
- Gating: la venta entra como `method='qr'` con `reference` = intent; el trigger de `payments` resuelve el provider y `payment_method_plan_key('gocuotas')='gocuotas'` (migración `20261011180000_gocuotas_directo`).

**Verificado (doc oficial):** hosts, Bearer con API Key, endpoint y parámetros del checkout, `url_init`, `GET /orders/{id}` y su esquema (`id`, `amount_in_cents`, `status`, `order_reference_id`), listado con `delivered_start`/`delivered_end` requeridos y filtro `order_reference_id`, cuerpo del webhook, estados `undefined`/`approved`/`denied`, mínimo $1.500.

**Inferido (a confirmar con la API Key de prueba de una sucursal):** forma exacta del listado (array, objeto o envoltorio: se normaliza), zona horaria de `delivered_*` (AR), que `GET /orders/{id}` devuelva el `order_reference_id` que mandamos (el ejemplo de la doc lo muestra `null` en una orden creada sin referencia; si no viniera, el listado por referencia es el respaldo), y que el listado incluya órdenes aprobadas recién creadas.

### Consecuencias

- Deploy: migración `20261011180000_gocuotas_directo` antes de usar el medio; Edges `gocuotas`, `gocuotas_webhook` (`--no-verify-jwt`) y `set_payment_secret`.
- Pendiente de cablear (fuera de este cambio): botón "Cobrar con GO Cuotas" en el POS (igual que Payway). La conexión de GO Cuotas quedó en el modal genérico de Medios de pago (ADR-035; `GoCuotasConnectForm` se reemplazó).
- Credenciales de prueba: la API Key de prueba sale del panel de la sucursal (Sucursales, Editar, Ver ApiKeys) o pidiéndola a integraciones@gocuotas.com. El comprador de prueba del sandbox es público (FAQ oficial).

---

## ADR-034 — Directo como tender manual (sin API pública)

**Fecha:** 2026-10-11 · **Estado:** parcialmente reemplazada por ADR-041 (el tender manual queda como respaldo sin API conectada) · **Hito:** F8 · H21e

### Contexto

El dueño pidió sumar "Directo, medio de pago de crédito directo": **Crédito Directo S.A.** (directo.com.ar), financiación en cuotas fijas sin tarjeta de crédito. Los comercios cobran "con QR o link de pago a través de nuestro portal" (`minegocio.directo.com.ar`). No se encontró API pública, portal de desarrolladores, sandbox ni webhooks.

### Decisión

- **Tender manual** (provider/feature `directo`, marca `directo`, canal `manual`, OPTIONAL desde Pro): el cajero genera el cobro en el portal de Directo y en el POS elige **"Directo (crédito)"** y carga el **número de operación**, obligatorio para confirmar.
- **`payments.method = 'directo'`** (se extiende `payments_method_check`) en lugar de `'other'`: queda identificado en caja, reportes, cierres y ticket ("Directo"), y el **gating coarse** del trigger de `payments` lo corta por plan vía `payment_method_plan_key('directo')='directo'`, sin reescribir `create_sale`. Constraint `payments_directo_reference_check`: con `method='directo'` el `reference` (Nº de operación) es obligatorio (1 a 64 caracteres).
- No se ofrece en "Dividir cuenta" (pediría un número de operación por línea).
- Sin credenciales: `DirectoInfo` explica el circuito en Medios de pago (portal y alta de comercio). Copy de plan: "Tener cuenta de comercio en Directo; el cobro se hace en su portal y en el POS se registra el número de operación".

### Alternativas consideradas

- `method='other'` + provider en metadata: `create_sale` no persiste metadata y el trigger no podría gatear por plan sin reescribir la RPC.
- Esperar una API privada: se puede pedir por contacto comercial; si aparece, se suma un canal `qr_link` sin romper el tender manual.

### Consecuencias

- No hay verificación automática del cobro: el número de operación es la evidencia para conciliar con las liquidaciones de Directo.
- `DirectoInfo` cableado en Medios de pago (ADR-035).

---

## ADR-035 — Gráficos con ECharts (reemplaza Recharts)

**Fecha:** 2026-10-11 · **Estado:** aceptada · **Hito:** Reportes

### Contexto

El dueño pidió ECharts para los gráficos y marcó como mal diseñado el switch de íconos gráfico/tabla de `ReportSection`. Recharts sólo se usaba en Reportes.

### Decisión

- `echarts@5.5.1` (exacto, igual que ninja-soft-web); `recharts` se quita. Registro mínimo en `components/charts/echarts-core.ts` (bar, line, pie, heatmap, treemap + grid, tooltip, legend, dataZoom, visualMap, markLine, title, canvas) importado **siempre de forma dinámica** por `components/charts/EChart.tsx`, que además lo carga recién cuando el gráfico entra al viewport.
- Colores leídos de las CSS vars del tema en el contenedor (los 4 temas) y re-dibujo al cambiar `data-theme`. Paleta categórica fija de 6 tonos (dark y light), validada con el validador de dataviz (banda OKLCH, croma, CVD adyacente, contraste 3:1); lo que excede 6 se pliega en "Otros".
- Builders puros en `components/charts/builders.ts` (serie temporal con comparación, ranking, dona, mosaico, heatmap día × hora, apiladas, flujo de caja, bullet), testeados.
- Switch Gráfico/Tabla: `components/ui/SegmentedControl.tsx` (radiogroup, flechas/Inicio/Fin, pulgar relleno deslizante, sin bordes de color), preferencia por sección en localStorage con try/catch.
- Datos nuevos sin backend nuevo: comparación vs. período anterior = la misma RPC `sales_report` con el rango previo (se pide después del reporte principal); heatmap día × hora y flujo de caja = lecturas bajo RLS de `sales` y `cash_movements`, paginadas de a 1000 y diferidas hasta que la sección entra en pantalla.

### Consecuencias

- El chunk de ECharts (~228 kB gzip) no entra en el First Load de Reportes: se baja sólo con el primer gráfico visible. La ruta pasa de ~14 kB a ~28 kB por el código de las secciones nuevas.
- El heatmap y el flujo de caja no tienen key de plan propia: son parte del módulo Reportes existente. Si comercialmente se quieren como "métricas avanzadas", hay que moverlos a RPCs con `tenant_has_feature_for` (la lectura directa bajo RLS no se puede gatear por plan).
- La hora del heatmap es la local del navegador (Argentina en la práctica).

### Referencias

- `components/charts/*`, `components/reports/ReportSection.tsx`, `components/reports/KpiCard.tsx`, `components/ui/SegmentedControl.tsx`, `modules/reports/derive.ts`, `app/(app)/reportes/page.tsx`, `tests/unit/reportCharts.test.ts`.
## ADR-036 — POS por presets y hoja de cobro única

**Fecha:** 2026-10-11 · **Estado:** aceptada (pendiente de migración) · **Hito:** rediseño del POS

> Numerada 036 para no chocar con la ADR-035 de la rama del rediseño de Medios de pago.

### Contexto

El dueño pidió poder elegir entre varios diseños del punto de venta y arreglar los botones de cobro. Había dos caminos de cobro que no se hablaban (PaymentModal con redondeo, división y promo por medio, y seis botones por proveedor que abrían el QR directo sin nada de eso), un solo breakpoint con el carrito debajo del catálogo en el celular y una página de 2700 líneas.

### Decisión

- **Presets** Mostrador, Boutique, Salón y Caja rápida sobre los mismos datos y reglas (la lógica de negocio se movió sin cambios a `modules/pos/screen/*`). `pos_settings.pos_layout` es el diseño del negocio y `users.settings.pos_layout` el override del usuario (sin teclas rápidas). Todo pasa por `lib/pos/layout.ts` (Zod, campo por campo).
- **Clasificación (CLAUDE.md §6):** diseño, presets y orden/ocultar/fijar medios = **FLAG-OPERATIVO**. **`pos_quick_keys_pro`** = OPTIONAL desde Pro (más de 12 teclas o color por tecla), con trigger `pos_settings_assert_layout`.
- **Hoja de cobro única** (`CheckoutSheet`) con un **registro de tenders** (`lib/pos/tenders.ts`): medio, proveedor, marca, canal, logo y feature (de `providerFeature`). La UI sólo espeja: ordenar u ocultar nunca habilita un medio; el gating real sigue en `payment_method_plan_key`, `create_sale` y cada Edge.
- **Pago dividido secuencial**: cada línea se cobra con su medio; los QR y Point quedan como líneas aprobadas (varias referencias de intent en un mismo `create_sale`, ya soportado). Si una línea electrónica cierra el saldo, la venta se registra sola; salir con cobros aprobados pide confirmación.
- **Promo por medio** sólo si se paga todo con un único medio (como antes en la división). Payway Point y Getnet Point sin integración se registran como tarjeta manual (terminal).

### Consecuencias

- Deploy: migración `20261011190000_pos_layout` antes de guardar diseños (sin la columna, el POS cae al preset Mostrador).
- Directo ahora puede ir en un pago dividido (cada línea pide su número de operación).
- Se eliminó `PaymentModal` y `FavoritesGrid`.

---

## ADR-037 — Cuenta corriente v2: ledger tipado, cobros por RPC y reversas

**Fecha:** 2026-10-11 · **Estado:** aceptada · **Hito:** F11 · H31 · Spec: [`docs/specs/cuenta-corriente-v2.md`](specs/cuenta-corriente-v2.md)

### Contexto

La cuenta corriente v1 era un ledger plano (`delta` + texto): plazo único por negocio, chequeo de límite sin lock (dos ventas simultáneas lo pasaban), cobro de deuda por **insert directo** desde el cliente (sin medio, sin caja/Z, sin recibo, sin auditoría, sin gating de plan), aging calculado en el navegador por fecha de cargo y un bug de datos: **anular, devolver o cambiar una venta a cuenta no revertía la deuda**. El dueño pidió plazos configurables, punitorios y gestión de cobranza.

### Decisión

1. **Ledger tipado** (`customer_account_movements.kind`: charge / payment / interest / interest_waiver / adjust_debit / adjust_credit / reversal, backfill por signo) con CHECK de signo, cuotas, `parent_id`, medio, turno de caja, recibo correlativo por tenant (advisory lock), clave de idempotencia y baja lógica (`voided_at`).
2. **Imputación explícita** (`customer_account_allocations`, con `released_at` en vez de DELETE). Orden por defecto: punitorio más viejo, luego cargos por vencimiento (FIFO); la imputación elegida se respeta y el resto sigue el orden por defecto; el excedente queda como saldo a favor y se aplica solo a cargos futuros (`account_reconcile`). Backfill FIFO de lo histórico.
3. **Escrituras sólo por RPC security definer** (se revoca insert/update/delete del ledger a `authenticated`): `account_collect`, `account_void_payment`, `account_waive_interest`, `account_adjust`, `account_save_settings`, `account_set_customer_terms`, items de cobranza. Todas chequean tenant, rol, plan (`tenant_has_feature_for`) y escriben `audit_logs`.
4. **Cargo con lock**: `payment_account_charge` toma `FOR UPDATE` el cliente, calcula vencimiento(s) con la config efectiva (negocio ← grupo ← cliente, jsonb validado con CHECK), genera N cuotas y bloquea por mora (`account_overdue_blocked`) o estado manual. Cuotas y override viajan en `payments.reference` como JSON (`{"installments":N,"override_reason":"..."}`) para **no redefinir `create_sale`**; el override sólo vale con rol dueño/encargado y queda auditado.
5. **Caja**: el cobro en efectivo entra como `income` (el arqueo existente lo cuenta sin cambios en `close_cash_shift`/IA/front); otros medios como `account_payment` (no suman al efectivo esperado). El Z agrega `account_collected` por medio.
6. **Punitorios** (`account_accrue_interest`, pg_cron diario 06:17 UTC): por período empezado (mes o fracción / día) desde vencimiento + gracia; simple o compuesto; tope sobre el capital original; mínimo por liquidación; único por (cargo, período). Misma lógica en `lib/account/interest.ts` (TDD).
7. **Reversas**: anulación por trigger AFTER UPDATE en `sales` (sin tocar `void_sale`), reversa total + condonación de punitorios abiertos; `return_sale` / `return_sale_v2` reproducidas completas: la parte pagada con cuenta vuelve a la cuenta en vez de salir en efectivo, y existe el reintegro `account`. **El cambio (`exchange_sale`) no se toca**: devuelve a vale y aplica ese vale a la mercadería nueva, así que la deuda original sigue correspondiendo.
8. **Cobranza automática**: Edge `account_reminders` (cron pg_net con `X-Cron-Secret`, mismo patrón que `dispatch-system-emails`) usa el email **del negocio** (`tenant_email_smtp`), deduplica por vencimiento y registra `reminder_log`. WhatsApp por link `wa.me` (sin API).
9. **Plan**: `cc_punitorios` y `cc_cobranza` OPTIONAL, `requires: cuenta_corriente`, marcadas en cada plan con el mismo valor que `cuenta_corriente` (Business+). `payment_method_plan_key('account') → cuenta_corriente`, así el trigger de `payments` también corta la venta a cuenta.

### Consecuencias

- Fin de la carrera del límite y de la deuda fantasma por anulación/devolución; todo cambio crítico auditado.
- El aging y el estado de cuenta se calculan en el server (`account_aging`, `account_statement`): el navegador ya no baja todo el ledger.
- `pos_settings.account_due_days` queda como respaldo de lectura (migrado a `account_config.terms.days`).
- **Deuda / pendientes**: los punitorios usan el capital pendiente al momento de liquidar (no prorratean pagos parciales dentro del período); el cron de recordatorios necesita `pg_net` + `platform_secrets.internal_cron` (ya existentes) y el deploy de la Edge. (El PIN de supervisor, el punitorio diario por mes, el editor de grupos y la vista previa de emails se resolvieron en el addendum.)

### Addendum (2026-10-11): PIN de supervisor, punitorio diario mensual, grupos y vista previa de emails

Decisiones del dueño sobre los pendientes:

1. **PIN de supervisor** ("me sirve lo del PIN de supervisor"). Dueños y encargados cargan un PIN de 4 a 6 dígitos (Configuración → Cuenta corriente). Sólo se guarda el **hash bcrypt** (pgcrypto) en `account_supervisor_pins`, con RLS sin policies y sin grants a `authenticated`: todo pasa por RPC security definer (`account_set_supervisor_pin`, `account_clear_supervisor_pin`, `account_supervisor_pin_status`, `account_supervisors`). Se rechazan PIN repetidos o en escalera. Desde el POS, el cajero elige al supervisor y éste escribe su PIN: `account_authorize_override` verifica, **limita intentos** (5 fallidos cada 15 minutos por negocio y supervisor; al quinto, bloqueo de 15 minutos; los resultados de PIN se devuelven en vez de lanzarse para que el conteo no se deshaga con el rollback) y audita (`account_override_authorized`, `supervisor_pin_failed`, `supervisor_pin_locked`) con supervisor, cajero, motivo, cliente y monto. Entrega un **token de un solo uso** (`account_override_tokens`, vence a los 5 minutos) atado al cliente, al cajero que lo pidió y al monto del intento; el trigger de cargo lo consume (`{"override_token": "..."}` en `payments.reference`). Si la venta falla, el rollback deja el token sin consumir para reintentar. Sigue el camino de sesión de dueño/encargado con motivo. El override cubre **mora, cuenta bloqueada y límite de crédito** (antes el límite no tenía override), siempre que `blocking.allow_manager_override`. Gating: `cuenta_corriente` server-side (sin feature nueva).
2. **Punitorio diario**: un movimiento de interés por **cargo y mes calendario** (`period` = día 1 del mes), actualizado por el cron con upsert idempotente por `(parent_id, period)` y la columna `accrued_through` (último día devengado; el upsert sólo avanza si la fecha es posterior). Corridas atrasadas que cruzan meses arman un movimiento por mes; el mínimo se mide contra el total del mes y los días de un mes cerrado que no llega pasan al siguiente. La tasa mensual no cambia. El estado de cuenta muestra "Punitorio de octubre 2026 (al 20/10)".
3. **Condiciones por grupo**: tarjeta "Condiciones por grupo" en Configuración → Cuenta corriente (badge de herencia y vista previa de la config efectiva). Escritura por `account_set_group_config` (dueño/encargado, validada) y guard + auditoría (`account_group_terms_changed`) en `customer_groups` para que un UPDATE directo tampoco pase sin rastro. La ficha del cliente indica si hereda del grupo o del negocio.
4. **Vista previa de emails** `account_reminder` (antes y después del vencimiento) y `account_statement` en `/internal/emails`, con datos de ejemplo y el mismo HTML que la Edge (`lib/email/accountTemplates.ts`, espejo de `account_reminders`). Son de sólo lectura: los envía cada negocio con su email y su marca.

### Addendum (2026-10-11): integración con la hoja de cobro única (ADR-036)

- El `PaymentModal` ya no existe: la cuenta corriente es el tender `account` del registro `lib/pos/tenders.ts` (grupo "Cuenta del cliente", método `account`, feature `cuenta_corriente`, sólo con cliente elegido). Al elegirlo, `CheckoutSheet` muestra `AccountPayPanel` (vía `renderAccount` de `CheckoutSheetConnected`, carga diferida) para el monto de esa línea: saldo, disponible, vencido, cuotas y bloqueo con autorización (motivo de dueño/encargado o PIN de supervisor). El botón queda deshabilitado mientras el panel reporte bloqueo, y su JSON (`installments`, `override_reason` u `override_token`) viaja en `payments.reference` de ese pago.
- **Pago dividido**: la cuenta corriente puede ser una parte del cobro (el límite, las cuotas y la autorización se calculan sobre el monto de esa parte, que es lo que valida `payment_account_charge` por fila), pero **una sola línea de cuenta por venta**: el token de autorización es de un solo uso y las cuotas se arman por pago. Con una línea de cuenta cargada, el tender desaparece de la grilla hasta quitarla.
- Los errores del cargo (`account_overdue_blocked`, `account_blocked`, `installments_not_allowed`, `override_token_invalid`, `override_reason_required`) tienen mensaje propio en `saleErrorTitle` (`modules/pos/screen/usePosSale.ts`).
- `payment_method_plan_key` (redefinida en `20261011200000`) conserva `gocuotas` y `directo` de `20261011180000_gocuotas_directo`, y `system_emails_kind_check` conserva `password_recovery` de `20261011120000`.

### Referencias

- Migraciones `20261011200000_cuenta_corriente_v2.sql`, `20261011200100_cuenta_corriente_v2_rpc.sql`, `20261011200200_cuenta_corriente_v2_reversas.sql`, `20261011200300_cuenta_corriente_v2_pin_supervisor.sql`.
- `lib/account/*`, `modules/customers/account.ts`, `components/account/*`, `components/pos/AccountPayPanel.tsx`, `app/(app)/clientes/cuentas/**`, `supabase/functions/account_reminders/index.ts`.

---

## ADR-038 — Configuración de medios de pago por marca y canal (rediseño)

**Fecha:** 2026-10-11 · **Estado:** aceptada · **Hito:** F8

### Contexto

El dueño pidió: "Planes · Mercado Pago debe ir en Point, no en QR", mejorar mucho la configuración de medios de pago, logos oficiales y pantallas lindas (sin bordes ni anillos de color en la opción elegida del ambiente).

### Decisión

- **Tarjetas por marca con canales adentro** (`QR + link` · `Point`), leídas de `payment_providers.brand/channel`. Si la base todavía no tiene esas columnas, `lib/payments/catalog.ts` resuelve marca y canal con un mapeo local por `provider_key` (la UI funciona antes y después de la migración `20261011150000_payment_channels`). Canales esperados no implementados (Payway Point, Getnet Point) se muestran como "Próximamente" sin acciones.
- Efectivo y transferencia van juntos en "Cobros directos". Directo tiene su tarjeta (gating por plan + explicación del circuito en su portal); GO Cuotas se conecta con el mismo modal que el resto (API Key + ambiente).
- **Planes por canal que los usa:** Mercado Pago → Point; Payway → QR + link (y Point cuando exista); Mobbex → su checkout. **Modelo de datos intacto:** los Planes de MP siguen en `payment_plans.provider_key = 'mercadopago'` (y su recargo único en la fila `mercadopago` de `tenant_payment_methods`); sólo se mueve la UI (`PLANS_KEY_BY_CHANNEL`). El QR + link de MP muestra "Recargo en Planes de Point" porque el cobro QR del POS (`QrCheckoutModal`) sigue leyendo esos mismos planes; si el dueño quiere que el QR deje de ofrecer cuotas, es un cambio aparte del flujo de cobro.
- **Modal de conexión con stepper** (Credenciales → Ambiente → Listo), formularios declarativos por proveedor, selector de ambiente segmentado con segmento activo relleno (sin bordes ni anillos de color), validación inline, spinner al guardar y estado de éxito. "Administrar" muestra resumen, ambiente (MP: token de prueba, ADR-032), actualizar credenciales y desconexión con confirmación en línea (sin `confirm()`).
- **Logos** en `public/images/payments/<marca>-icon.webp` (isotipo cuadrado) y `<marca>-wordmark.webp` (horizontal, sobre placa blanca en los 4 temas). Fuente única `lib/payments/logos.ts`. Se quitan los assets viejos sin uso; quedan en `public/img/medios_de_pago/` sólo los que todavía usa `app/(app)/pos/page.tsx` (`*_cube.webp` de MP, Mobbex, MODO, Pagos360, Payway) y `cards/` (marcas de tarjeta).
- Los tokens semánticos del tema (`--muted`, `--foreground`, `--destructive`) son colores completos: los modificadores de opacidad de Tailwind (`bg-muted/50`) no generan nada. Para tintes se usa `color-mix(in srgb, var(--token) N%, transparent)`.

### Consecuencias

- `PaymentMethodsCard` sólo trae datos y guarda; la vista vive en `components/dashboard-team/payments/*` y se puede probar con datos simulados.
- Pendiente: migrar `app/(app)/pos/page.tsx` a `paymentIcon()` y borrar los `*_cube.webp` legacy.

---

## ADR-039 — Asistente IA: acceso total de lectura (`ai_query`) e historial por usuario de 15 días

**Fecha:** 2026-10-11 · **Estado:** aceptada · **Hito:** Asistente IA (addon `asistente_ia`)

### Contexto

El asistente sólo respondía lo que cubrían 7 tools curadas (ventas, top, clientes, caja, stock, búsqueda de productos, panorama). Preguntas simples como "¿cuántas categorías tengo cargadas?" quedaban sin respuesta ("no tengo una herramienta…"). Además el chat se perdía al cerrar la burbuja. El dueño pidió que la IA "tenga acceso a todo" y que los mensajes se guarden 15 días por usuario.

### Decisión

**1. Consulta genérica de solo lectura `ai_query` sobre una whitelist.**
- El modelo no escribe SQL: manda un pedido JSON (`entity`, `select`, `filters` eq/neq/gt/gte/lt/lte/ilike/in/between/is_null/not_null, `group_by` ≤ 2 con `trunc` day/week/month/year en hora AR, `aggregates` count/count_distinct/sum/avg/min/max, `order_by` ≤ 3, `limit` 1..200). Columnas de entidades relacionadas con `ref.col` (joins acotados declarados en el catálogo, hasta un nivel extra con `via`).
- Catálogo único en `supabase/functions/_shared/aiQuery.ts` (47 entidades: catálogo, variantes, stock, listas de precios, clientes y grupos, cuenta corriente, saldo a favor y vales, ventas, renglones, pagos, devoluciones, sucursales, cajas, turnos, movimientos, cierres Z, promociones, cupones, garantías, seriales, profesionales, agenda, packs, salón/mesas/comandas/reservas, delivery y zonas, cartas, equipo, cajeros, planes de cuotas, medios de pago, suscripción, complementos). La copia SQL (`ai__query_catalog()`) se genera de `catalogForSql()` y un test de Vitest verifica que no diverjan.
- Doble validación: TS (`validateQuery`, errores claros para que el modelo corrija) y SQL (`ai_query`, la barrera real): cada identificador se resuelve contra la whitelist y se cita con `quote_ident`; los valores pasan por cast tipado + `quote_literal`; operadores, agregados y `trunc` son listas cerradas.
- **`SECURITY INVOKER` con el JWT del usuario** (la Edge la llama con el cliente del usuario, nunca con service_role): RLS de cada tabla aplica y además se fuerza `t.tenant_id = current_tenant_id()` (también en los joins), así que ni el staff interno con policies `or is_internal()` cruza tenants. Filas con `deleted_at` excluidas.
- Fuera de la whitelist: `payment_secrets`, `platform_secrets`, SMTP, `email_providers`, `mp_*` internos, `audit_logs`, `users`, `invite_codes`, `pin_hash`, `tenant_payment_methods.config`, `payments.metadata/card_voucher`, código de vales y todo jsonb interno.
- Tool `ai_schema` (pura, sin DB) describe columnas y relaciones en español; el system prompt lista las entidades, la fecha/hora AR actual y la regla "responder desde los datos, citar cifras, no inventar; si el dato no está, decir qué no es accesible".
- Las tools curadas existentes se mantienen. Claude pasa a tener el mismo loop de tool use que Gemini (antes era single-shot). Tope de 8 vueltas y de 40 000 caracteres por resultado.

**2. Historial por usuario (`ai_conversations`, `ai_messages`).**
- RLS de lectura: `tenant_id = current_tenant_id() and user_id = auth.uid()` (sin excepción para staff: el chat es personal). Sin policies de escritura: escribe sólo la Edge `ai_assistant` (service_role server-side) con tenant y usuario resueltos del JWT; un `conversation_id` ajeno se ignora y se abre una conversación nueva.
- La UI lee con el cliente del navegador bajo RLS: al abrir retoma la última conversación, lista las de los últimos 15 días, "Nueva conversación" y borrar (confirmación en línea).
- **Borrado del usuario = baja lógica** (`deleted_at`, vía Edge). **Retención = borrado físico** por pg_cron diario (`purge_ai_conversations`, 04:41 UTC) de conversaciones sin actividad hace más de 15 días (incluidas las dadas de baja); los mensajes caen por cascade. Excepción explícita a la regla de baja lógica: es dato transitorio de conversación, no dato de negocio, y conservarlo indefinidamente sólo suma riesgo de privacidad y volumen.

### Consecuencias

- `ai_query` se otorga a `authenticated`: un usuario podría llamarla por PostgREST sin el addon, pero sólo lee lo que RLS ya le permite leer por PostgREST (sólo suma agregados y joins acotados). No es una superficie nueva de datos; el addon sigue gateado en la Edge.
- El tiempo máximo lo pone el `statement_timeout` del rol `authenticated` (8 s en Supabase) más un timeout de 12 s en la Edge. Para tenants enormes, consultas agregadas sin filtros pueden cortar por timeout: el modelo recibe el error y puede acotar.
- Si una columna nueva debe ser visible para la IA, hay que sumarla al catálogo TS y regenerar el bloque `$catalog$` de la migración nueva (el test falla si divergen).
- Fuera de alcance: proveedores/compras (no existen tablas), facturación AFIP (marketing futuro).
- Cuota mensual y bitácora `ai_usage` sin cambios.

### Referencias

- `supabase/migrations/20261011220000_ai_acceso_total_historial.sql`, `supabase/functions/_shared/aiQuery.ts`, `supabase/functions/ai_assistant/index.ts`, `components/ai/AssistantBubble.tsx`, `components/ai/AssistantChat.tsx`, `tests/unit/aiQuery.test.ts`, `tests/unit/aiHistory.test.ts`.

---

## ADR-040 — Opacidad de Tailwind sobre los tokens temados (`var(--x)`)

**Fecha:** 2026-10-12 · **Estado:** aceptada · **Hito:** limpieza de UI

### Contexto

Los tokens semánticos de `tailwind.config.ts` (`background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`) se declaraban como `"var(--x)"`. Tailwind 3 no puede inyectar alpha en un `var()` cuyo valor desconoce, así que las clases con modificador (`bg-muted/50`, `border-border/60`, `bg-destructive/10`, `text-muted-foreground/70`, `bg-background/80`...) **no generaban CSS**: el elemento quedaba sin fondo, con el borde base o con el color de texto heredado. Había ~200 usos así en la app. Además el color por defecto de `ring` (sin clase de color) era el azul de Tailwind (`rgb(59 130 246 / 0.5)`). Como parche se habían sumado utilidades `bg-fg-4/6/10` y valores arbitrarios `bg-[color-mix(...)]`, y ADR-038 registraba la limitación.

Los valores de los tokens son hex en unos temas y `rgba()` en otros, por lo que convertirlos a tripletas RGB (`<alpha-value>`) obligaba a rehacer los cuatro temas y perdía el alpha propio de los tokens translúcidos.

### Decisión

- `tailwind.config.ts` (archivo sensible, cambio acotado a esto) declara cada token como **función de color** `themed("x")`:
  - sin modificador (Tailwind pasa `opacityVariable`, o nada en `fill`/`stroke`) devuelve `var(--x)`, idéntico a antes;
  - con modificador devuelve `color-mix(in srgb, var(--x) calc(<alpha> * 100%), transparent)`, que multiplica el alpha propio del token.
- `ringColor.DEFAULT = themed("ring")`: un `ring-*` sin color usa el token `--ring` del tema al 50 % (opacidad por defecto de ring en Tailwind 3) en lugar del azul.
- Se mantienen `bg-fg-4/6/10` (nombres estables de la escala del POS) y los `bg-[color-mix(...)]` existentes: generan lo mismo y no vale la pena el churn.

### Consecuencias

- CSS generado: las clases sin modificador sólo suman la declaración inerte `--tw-*-opacity: 1`; el resto es igual. Aparecen ~100 reglas nuevas, una por cada clase con modificador que antes no existía.
- **Impacto visual (intencional, es lo que el código pedía):** los rellenos `bg-muted/N`, `bg-destructive/10`, `bg-card/N`, `bg-background/N`, `bg-popover/N` ahora se ven (en oscuro son tintes muy sutiles porque `--muted` ya es translúcido; en los temas claros se notan más); los `hover:bg-*/N` ahora tienen hover; los textos `text-muted-foreground/N` pasan de heredar el color de texto (claro) a gris atenuado; `border-border/N` y `border-destructive/N` quedan más suaves; los degradados `from-popover` se desvanecen al popover transparente y no a blanco transparente.
- ADR-038 queda superada en el punto "los modificadores de opacidad no generan nada": desde acá `bg-muted/50` y `bg-foreground/[.05]` son válidos.
- Requiere `color-mix()` (Chrome 111, Safari 16.2, Firefox 113), ya usado en la app.

Archivos: `tailwind.config.ts`, `app/globals.css` (comentario de `bg-fg-*`).

---

## ADR-041: Directo por API de comercios (QR + link) con respaldo manual

**Fecha:** 2026-10-12 · **Estado:** aceptada (pendiente de migración, deploy y validación en QA) · **Hito:** F8 · H21e · **Reemplaza parcialmente:** ADR-034

### Contexto

ADR-034 asumió que Directo (Crédito Directo S.A.) no tenía API. El dueño confirmó que sí: Directo ofrece plugins (WooCommerce, etc.), "integración personalizada o botón de pago" por API, "Multiconsulta" (validación de oferta sin generar orden) y su portal de comercios. Las guías técnicas (`IntegracionApiCommerce20.pdf`, `IntegracionApiMulti20.pdf`) están en Drive con descarga deshabilitada, así que la superficie de la API se tomó del **código del plugin oficial de WooCommerce** (`directo-gateway.php`, "Wanderlust Directo" 0.0.1).

### Decisión

- **Canal QR + link** (provider/feature `directo`, marca `directo`, canal `qr_link`, OPTIONAL desde Pro, sin cambio de plan). Edge `directo` (JWT): `create` (gating `tenant_has_feature_for(tenant,'directo')`) hace login (`POST {base}api/merchant/login`, `{ user, password }` con headers `ApiKey` y `Ocp-Apim-Subscription-Key`, devuelve `credentials`, que se cachea por invocación) y crea la orden (`POST {base}api/merchant/orders`, headers `Credentials` y `MerchantHash`) con `Merchant_Order_Id` = id del intent, `Notify_Url` = `directo_webhook?intent=<uuid>` y retornos a la pantalla neutra. El `redirect_Url` es el `init_point` que `QrCheckoutModal` muestra como QR y link (provider self-managed: el cliente arma su crédito en Directo). `status` re-verifica sólo si el webhook ya dejó el id de notificación; `cancel` es baja local (no hay endpoint conocido para anular).
- **MerchantHash:** `base64(AES-256-CBC(PKCS#7)(cuerpo JSON exacto))` con la clave e IV fijos publicados en el plugin. Se pueden pisar con los secrets de función `DIRECTO_HASH_KEY` / `DIRECTO_HASH_IV` si Directo los rota. Test cruzado contra `openssl` (Node `createCipheriv`).
- **Edge `directo_webhook`** (verify_jwt **false**): el cuerpo `{ notification_id }` es sólo una pista. Re-consulta `GET {base}api/merchant/notification/{id}` con las credenciales del tenant (y MerchantHash de `{ Merchanthash, notification_id }`) y acredita sólo `status = "Successful"` + `merchant_Order_Id` = intent + **monto exacto si la notificación lo informa** (si no lo informa, se audita `amount_not_reported`: el monto lo fijó nuestro servidor al crear la orden). `Cancel` → cancelled. Idempotente (updates condicionales; un approved verificado pasa también desde rejected/cancelled para la conciliación). Siempre 200. GET sirve la pantalla neutra de retorno. El id de notificación queda en `preference_id` y, si aprueba, en `mp_payment_id`.
- **Credenciales por tenant** vía `set_payment_secret('directo')`: `api_key`, `merchant_username`, `merchant_password`, `merchant_name`, `api_base_url` y `subscription_key` (opcional). **Ambiente:** switch Sandbox del medio (QA). El plugin no trae hosts (el comercio carga `API_BASE_URL`) y no se pudieron leer los PDF técnicos, así que `DIRECTO_BASE` queda sin hosts y la **URL de la API es un campo obligatorio** de la conexión (https, sin parámetros). Cuando Directo confirme los hosts de QA y producción se completan en `_shared/directo.ts` y el campo pasa a ser opcional (override avanzado). El intent guarda `mp_env` y status/webhook usan ese ambiente.
- **Respaldo manual (se mantiene ADR-034):** si el negocio no conectó la API, el POS sigue ofreciendo "Directo (crédito)" con número de operación (`payments.method = 'directo'`). Con la API conectada, ese tender se oculta (`manualFallback` en `lib/pos/tenders.ts`) y aparecen Directo QR y Link. La tarjeta de Medios de pago muestra "Registro manual" sin conexión y el modal de conexión con stepper (Datos, Ambiente, Listo) y "Dónde lo encuentro".
- Lógica pura en `supabase/functions/_shared/directo.ts` (Vitest, `tests/unit/directo.test.ts`); helpers server en `_shared/directo_server.ts`. Auditoría: `directo_order_created`, `directo_order_cancelled`, `directo_payment_<estado>`.
- Migración `20261012020000_directo_api`: `payment_providers(directo)` pasa a `kind='gateway'`, `channel='qr_link'` y se actualiza la descripción de la feature. El gating ya existía: `payment_method_plan_key('directo')='directo'` cubre tanto `method='qr'` con intent `directo` (trigger de `payments`) como `method='directo'`.

**Verificado (código del plugin oficial):** rutas `api/merchant/login`, `api/merchant/orders`, `api/merchant/notification/{id}`; headers `ApiKey`, `Ocp-Apim-Subscription-Key`, `Credentials` (token crudo, sin Bearer) y `MerchantHash`; cuerpo de login `{ user, password }` y respuesta `credentials`; campos de la orden y respuesta `redirect_Url`; webhook `{ notification_id }`; notificación `{ merchant_Order_Id, status }` con `Successful` y `Cancel`; algoritmo, clave e IV del MerchantHash.

**Inferido (a confirmar en QA):** hosts de QA y producción; si la Subscription Key es obligatoria; otros estados (rechazo, vencimiento) y si la notificación informa el monto; `Integration_Type` para integraciones propias (mandamos `API`; el plugin manda `WOO`); que `Phone_Number`/`Email` acepten `null`; que el token de login no expire dentro de una invocación.

### Consecuencias

- Deploy: migración `20261012020000_directo_api`; Edges `directo`, `directo_webhook` (`--no-verify-jwt`) y `set_payment_secret`.
- QA: tarjetas de prueba de Directo (VISA débito 4978 2600 0000 0000 y Mastercard débito 5100 1200 0000 0004, 01/30, CVV 123); el ambiente QA además muestra una barra para elegirlas.
- Pendiente: pedir a Directo los PDF técnicos (Commerce 2.0 y Multiconsulta 2.0) para confirmar hosts y estados. **Multiconsulta** (mostrar cuotas y elegibilidad del cliente antes de cobrar) queda como próximo paso: su API no es descubrible sin ese PDF.

---

## ADR-042: Hoja de cobro rediseñada, variantes en pos_layout.checkout y Tarjeta en posnet

**Fecha:** 2026-10-12 · **Estado:** aceptada · **Hito:** POS (diseño)

### Contexto

El dueño marcó la hoja de cobro como fea: muchos degradados (monto en degradado rojo a rosa, botón naranja a amarillo), esquinas muy redondeadas, logos sobre placas blancas, selección con tinte marrón y un rótulo por cada grupo. Pidió más variantes, sacar la burbuja de IA del POS y un acceso rápido a la venta desde cualquier pantalla. La "tarjeta manual" (dos accesos, Débito y Crédito) en realidad es cobrar con un posnet no integrado y cargar el cupón a mano.

### Decisión

- **Lenguaje visual del cobro** igual al resto del POS: superficies neutras con borde sutil, esquinas de 8px (`rounded-lg`) en tiles y botones y `rounded-xl` sólo en la hoja; selección con relleno neutro + insignia de check (`choice-on` / `choice-check`); montos en el color de primer plano con números tabulares; un solo color sólido en el CTA (`--pos-via` del acento con su tinta), sin texto en degradado. Partir el monto, propina, garantía y vendedor usan `Segmented`. Logos con su fondo transparente directo sobre el tile (`TenderLogo` + `lib/pos/tenderLogo.ts`, preparado para la variante oscura de cada logo).
- **Variantes** en `pos_layout.checkout` (jsonb, sin migración; FLAG-OPERATIVO, sin gating de plan): `layout` (`two_columns`, `compact_list`, `keypad_first`, `big_buttons`), `favorites` (hasta 6 medios arriba), `hiddenGroups` (nunca deja la hoja vacía), `channelChips` (marcas con varios canales en una fila segmentada) y `density`. Caja rápida arranca en "Teclado primero". Validación por sub-campo como `payments`; el usuario pisa al negocio campo por campo. Se editan en Configuración, Diseño del POS, con miniaturas en vivo.
- **Tarjeta en posnet:** un solo tender `card` (los ids viejos `card:debit` / `card:credit` guardados en el diseño se traducen solos). Asistente de 3 pasos: entidad (logos; según los planes cargados, siempre "Otra"), tipo y cuotas (se salta si la entidad es sólo débito; recargo y total por plan), datos del cupón con resumen tipo cupón y "Registrar cobro con tarjeta". El pago sigue saliendo como `debit`/`credit` con `card_voucher`; se suman `marca` y `ultimos4` (opcionales) al jsonb, sin cambio de esquema.
- **IA fuera del POS:** la burbuja del asistente no se monta en `/pos` (ni subrutas).
- **Acceso rápido "Vender / Cobrar":** botón primario arriba del menú lateral y en el header mobile (fuera de `/pos`), atajo global **F1** (el POS ya usa F2 buscar y F12 cobrar). Con carrito en curso lleva a `/pos?cobrar=1`, que abre la hoja (o pide abrir caja) y limpia el parámetro. Sólo para roles que venden (owner, manager, cashier).

### Consecuencias

- Los selectores de diseño (presets del POS y del cobro) usan el mismo sistema: relleno neutro + check, wireframes en tonos del tema y un único acento mínimo. Salón sin modo gastronómico muestra candado y "Activar modo gastronómico" (lleva a Configuración, Operación).
- Logos integrados con el sistema de logos oficiales (`lib/payments/logos.ts`): `TenderLogo` delega en `ThemedLogo` (variante `-on-dark` según `data-theme`, sin placa), `tenderLogoSrc` deriva la variante oscura con `logoOnDark` y `cardBrandLogo` / `cardLogoKey` usan `cardLogo` (`public/images/cards/*.webp`; Visa débito con su logo). El asistente y los chips de cuotas muestran el logo de la tarjeta con `CardBrandLogo`.
- En "Billeteras y links", cada marca con más de un canal (GO Cuotas QR + Link, Mobbex, Directo con API) va en una fila con canales como Payway o Nave (`brandRuns`); las de un canal siguen como tile. Los favoritos siguen siendo tiles por canal.

---

## ADR-043: Multi-sucursal como contexto de primera clase, configuración heredable y bloque fiscal-contable (F17 y F18)

**Fecha:** 2026-10-12 · **Estado:** propuesta (sólo documentación; sin código ni migraciones) · **Hitos:** F17 (H89 a H99) y F18 (H100 a H112)

### Contexto

El dueño pidió auditar Napse (relevamiento de Bridge Manager 7.9, 253 pantallas) con foco en gestión de sucursales, "en qué sucursal estoy", medios de pago y terminales en todas las sucursales, compartir configuración, clientes, productos y contabilidad; y después una auditoría con mirada de contador sobre listas de precios, compras e importaciones, impuestos internos, padrones, percepciones, retenciones, facturación y contabilidad. Resultado en [`auditoria-napse-vs-ninjapos.md`](./auditoria-napse-vs-ninjapos.md) y [`auditoria-fiscal-contable-precios.md`](./auditoria-fiscal-contable-precios.md). Hallazgos clave en el código:

- `stores` y `cash_registers` existen sin ABM. `create_sale`, `exchange_sale`, `return_sale` y los RPC de stock eligen **la sucursal default** (`order by is_default desc, created_at limit 1`) en vez de la de la caja del turno: con dos sucursales, las ventas quedarían en la equivocada.
- Stock único (`products.stock`); toda la configuración (medios, credenciales, cuotas, POS, tickets, impresión) es por negocio; roles por negocio; terminales Point recordadas en `localStorage`.
- `create_sale` acepta el `unit_price` que manda el navegador: debilidad de control interno.
- `products.tax_rate` numérico sin distinguir exento, no gravado y 0 %; sin impuestos internos, percepciones, retenciones, padrones, compras, libros ni asientos.
- `multi_sucursal` y `facturacion_afip` están en planes sin función (MARKETING-FUTURO).

### Decisión

1. **Sucursal y caja como contexto de primera clase (F17).** La sucursal de toda operación se deriva de `cash_shift → cash_register → store`. Indicador visible siempre (chip en el topbar del panel, "Centro · Caja 1" en el POS, ticket, Z y display); selector "Todas / sucursal" para quien tiene alcance central.
2. **Configuración heredable negocio → grupo → sucursal → caja** con una tabla genérica de overrides **por campo** (`config_overrides`) y una función de valor efectivo que informa el origen de cada campo. "Compartir configuración" = no copiar: la sucursal sólo guarda lo que pisa; acciones explícitas "Aplicar a todas", "Copiar desde" (con diff) y "Plantilla de sucursal". Es el primer corte concreto de F14/H57. El override nunca habilita algo fuera del plan.
3. **Terminales como entidad** (`payment_terminals`, con sucursal, caja, proveedor, id externo, adquirente y n° de comercio) y credenciales de proveedor opcionalmente por sucursal (`payment_secrets.store_id`).
4. **Permisos por sucursal** con `tenant_user_stores` (rol que pisa el del negocio) y helper RLS `user_can_access_store`; sin filas = acceso total (compatibilidad). Maestros (productos, clientes, medios, listas) siguen por negocio.
5. **Bloque fiscal y contable (F18)** con toda alícuota, tope, mínimo y código de tributo como **parámetro con vigencia**. Antes de F3 deben estar el catálogo de alícuotas IVA e internos (H103) y la condición fiscal del receptor con padrones (H104). El POS genera asientos inmutables y exporta a los sistemas de los estudios; no pretende reemplazar al sistema contable.
6. **Dos P0 inmediatos e independientes:** fix de sucursal en los RPC de venta (F17/H90) y validación del precio en el servidor (F18/H100).
7. **Clasificación de features** según `CLAUDE.md`: `multi_sucursal` (existe) cubre sucursales, herencia, stock y reportes; nuevas keys OPTIONAL `multi_caja`, `transferencias_stock`, `multi_razon_social`, `monitoreo_sucursales`, `listas_precios_pro`, `compras`, `importaciones`, `impuestos_internos`, `padrones`, `percepciones`, `retenciones`, `factura_exportacion`, `export_contable`, `contabilidad`, `conciliacion_tarjetas`, `conciliacion_bancaria`, `tesoreria`, `sepa`; ADDON `integracion_erp`. BASE: primera sucursal y caja, indicador, registro de terminales, validación de precio, historial de precios, alícuotas IVA, condición fiscal manual y campos de registro de producto.

### Alternativas descartadas

- **Copiar la configuración a cada sucursal** (una fila de `tenant_payment_methods` por sucursal): duplica datos, un cambio central no llega a todas y el dueño no sabe qué local es distinto.
- **Una tabla de override por dominio** (`store_payment_methods`, `store_pos_settings`...): más tablas, más policies y la misma lógica repetida; se usa la tabla genérica y, si un dominio caliente lo necesita, una vista materializada.
- **Parámetros sueltos por categoría como Napse** (52 categorías de `systemProperty`): potente pero opaco; se elige mostrar valor efectivo y origen en la misma pantalla de cada configuración.
- **Resolver impuestos y precios sólo en el front:** no es auditable ni seguro; el servidor recalcula.

### Consecuencias

- Roadmap: F4 apunta a F17; nuevas fases F17 (H89 a H99) y F18 (H100 a H112); F3 lista sus prerrequisitos fiscales; F11/H33 y F14/H64 apuntan a F17 y F18.
- RLS de `sales` y `payments` cambia en H91: requiere `EXPLAIN` y tests por rol y sucursal antes de activar.
- La comparación de planes debe mostrar como "Próximamente" las keys sin función (hoy `multi_sucursal`, `facturacion_afip` y las nuevas) hasta que existan.
- **Pendiente con el dueño:** confirmar qué quiso decir con "tag registration" (interpretaciones en §5 de la auditoría fiscal) y validar el alcance fiscal con un estudio contable antes de implementar F18.

---

## ADR-044: Conciliación de tarjetas v1 (día, n° de comercio y lote)

**Fecha:** 2026-10-12 · **Estado:** aceptada (pendiente de migración y validación en QA) · **Hito:** Reportes

### Contexto

Los comercios cobran con tarjeta en posnets propios (Tarjeta en posnet, ADR-042) o integrados (Point, Payway, Getnet, Nave...) y después tienen que controlar, contra la liquidación de cada adquirente, que cada lote se haya acreditado. Hoy ese control se hace a mano con el cierre de lote impreso. Los datos ya están: `payments.card_voucher` guarda lote, cupón, autorización, marca y últimos 4, y desde la rama de números de comercio también `comercio` (el n° de comercio de la marca configurado en `tenant_payment_methods.config.merchant_numbers`).

### Decisión

- **Pantalla `/reportes/conciliacion`** (botón en Reportes e ítem "Conciliación de tarjetas" en el menú, con candado sin plan). Filtros: período, tipo (débito / crédito), marca, n° de comercio y estado (pendiente / conciliado). Tabla agrupada como la liquidación del adquirente: **día → n° de comercio → lote**, con cantidad y monto en cada nivel; filas con fecha y hora, ticket, marca (`CardBrandLogo`), tipo, cuotas (si el cupón las trae), lote, cupón, autorización, últimos 4, comercio y monto. Checkbox por cobro y por lote (con estado intermedio). Resumen total / conciliado / pendiente. "Exportar XLSX" (gateado por `export_xlsx`) con hoja de detalle con subtotales por lote, comercio y día y hoja resumen por lote. Se excluyen las ventas anuladas.
- **Datos:** `payments.reconciled_at` / `reconciled_by` (null = pendiente). La lectura es un SELECT sobre `payments` + `sales` con RLS (índice existente `payments_tenant_method_idx`). La escritura **sólo** por la RPC `set_payments_reconciled(p_payment_ids uuid[], p_reconciled boolean)`: SECURITY DEFINER con `search_path`, exige tenant activo, rol owner o manager (`is_tenant_manager()`), plan con la feature (`tenant_has_feature_for`), y que **todos** los ids sean pagos de tarjeta del tenant (si no, no cambia nada). Sólo toca los que cambian de estado y escribe `audit_logs` (`payments_reconciled` / `payments_unreconciled` con ids, cantidad y monto). Un trigger `BEFORE UPDATE` rechaza cambiar esas columnas desde `authenticated` / `anon` (la policy de aislamiento de `payments` es FOR ALL).
- **Feature de plan** `conciliacion_tarjetas`: **OPTIONAL**, grupo `reportes`, desde **Pro** (Pro, Business y Enterprise; Start no). Mismo nivel que `export_xlsx`: es control administrativo de un comercio que ya opera con varios medios; los planes a medida heredan el valor de `export_xlsx`. Copy en `lib/saas/featureInfo.ts` (sin `requires`; `needs` aclara que rinde más con los números de comercio cargados en Medios de pago, Planes de cuotas). Aparece en la comparación de planes por derivación de la matriz.
- Lógica pura (normalización del cupón, filtros, agrupado y subtotales, filas del XLSX) en `lib/reports/cardReconciliation.ts` con tests (`tests/unit/cardReconciliation.test.ts`). Tests de RLS / RPC en `tests/integration/rls.test.ts`.

### Consecuencias

- Deploy: migración `20261012120000_conciliacion_tarjetas` (no aplicada).
- Cobros sin `comercio` (anteriores a los números de comercio o de marcas sin número) se agrupan como "Sin n° de comercio"; los integrados sin cupón quedan como "Sin lote" y muestran la referencia del proveedor como ayuda.
- Pendiente (v2): importar la liquidación del adquirente (CSV / Excel) y conciliar automático por lote y cupón; fecha de acreditación y aranceles / retenciones por cobro; conciliación de QR y billeteras.

---

## ADR-047: Clover Point (Fiserv) por Cloud Pay Display y estado del resto de los Points

**Fecha:** 2026-10-12 · **Estado:** aceptada (pendiente de migración, deploy y validación en sandbox de Clover) · **Hito:** F8 · H19

### Contexto

El dueño pidió avanzar con Fiserv y Clover y con los Points que falten. Fiserv estaba en el catálogo como un único canal `fiserv` marcado `point` sin flujo (sólo habilitaba la tarjeta en posnet). El relevamiento ([`docs/payments/research-points-2026-10.md`](payments/research-points-2026-10.md)) encontró que Clover es la única terminal de un adquirente grande con API cloud documentada y sandbox self-service: **Cloud Pay Display** (REST Pay Display API en la nube), listada para Argentina en la guía LATAM en español y en la matriz por región, aunque la página "Argentina merchants" la marca como no soportada. Payway y Getnet no publican una API utilizable hoy; el resto no tiene terminal propia o API.

### Decisión

- **Canal nuevo `fiserv_point`** (marca `fiserv`, canal `point`, nombre "Clover Point"), siguiendo el patrón `<marca>_point`. `fiserv` pasa a canal `manual` ("Posnet o Clover sin integrar": habilita la Tarjeta en posnet) y **guarda la conexión de la marca** (`BrandDef.connection = "fiserv"`, porque Fiserv no tiene canal QR + link). Marca en `MANUAL_FALLBACK`: sin conectar, igual se cobra a mano.
- **Plan:** OPTIONAL desde **Business** (no Pro como el resto de los Point) porque depende de la feature `fiserv` (`requires: ["fiserv"]` en `featureInfo`), que es Business+: la dependencia tiene que estar activa en el mismo plan. `needs`: "Marca Fiserv conectada (Merchant ID y token de Clover) y la app Cloud Pay Display abierta en cada terminal".
- **Gating real:** `payment_method_plan_key('fiserv_point') = 'fiserv_point'` (trigger de `tenant_payment_methods`), y la Edge `clover_point` exige `tenant_has_feature_for` de **`fiserv_point` y `fiserv`** antes de crear el cobro; sin conexión Fiserv responde `not_connected`. La terminal pedida tiene que ser del comercio (lista de Clover acotada por las series cargadas).
- **Conexión** (`set_payment_secret` provider `fiserv`, ya permitido): `merchant_id`, `access_token`, `refresh_token` (opcional) y `device_serials` (opcional, "Caja 1: serie"). Ambiente por `tenant_payment_methods.sandbox` de la fila `fiserv`: sandbox `apisandbox.dev.clover.com`, producción `api.la.clover.com`. El intent guarda `mp_env` y status/cancel/webhook usan ese ambiente. Si Clover responde 401 y hay `refresh_token` + secret de función `CLOVER_APP_ID`, se renueva el par (`/oauth/v2/refresh`) una vez y se persiste.
- **Edge `clover_point`** (JWT): `devices` (`GET /v3/merchants/{mId}/devices`, id = número de serie), `ping`, `create`, `status`, `cancel`. `create` inserta el intent (`mp_payment_intents`, `provider_key='fiserv_point'`, `point_device_id` = serie) y lanza en segundo plano (`EdgeRuntime.waitUntil`) `POST /connect/v1/payments` con `Idempotency-Key` = id del intent, `externalPaymentId` = id sin guiones (32), `final: true` y el monto **del intent guardado** en centavos; cuotas opcionales por `regionalExtras.argentina.numInstallments`. El POST bloquea hasta que el cliente termina, por eso no se espera en la request: el POS sondea `status`.
- **Fuente de verdad:** `GET /connect/v1/payments/external/{ext}`. Sólo `SUCCESS` (o `VOID_FAILED`) + `externalPaymentId` del intent + **monto exacto** en centavos (sin propina) acredita; `FAIL` → rejected; `VOIDED` → cancelled; el resto sigue pending. Débito o crédito por el tender del pago (`expand=tender`); sin dato, crédito. Errores del POST: 209 → cancelled, 503 → rejected `device_busy`, 400/415/501 → rejected, 500/504/red → indeterminado (decide la consulta). Transiciones condicionales e idempotentes; un pago verificado sobre un intent cancelado queda `approved` con auditoría `approved_after_*` (nunca se pierde plata cobrada). `cancel` = `PUT /connect/v1/device/reset`, re-consulta y cancela local.
- **Edge `clover_webhook`** (`--no-verify-jwt`): los webhooks de Clover son por app. `{ verificationCode }` se escribe en el log; el resto exige `X-Clover-Auth` igual al secret `CLOVER_WEBHOOK_AUTH` (comparación de tiempo constante) y, por cada merchant con pagos (`P:`), re-consulta los intents pendientes de las últimas 24 h de los tenants con ese Merchant ID. Nunca usa el cuerpo como verdad. Opcional: el poll alcanza.
- **UI:** fila "Clover Point · Terminal en el mostrador" en la tarjeta Fiserv, conexión con stepper (Merchant ID, token, refresh, terminales; Prueba/Producción; aviso de Cloud Pay Display), tender "Clover Point" en el POS (`PointCheckoutModal` con terminal recordada por caja y cuotas En la terminal / 1 / 3 / 6 / 12), conciliación en "Cobros QR". Logos oficiales de ar.clover.com (`clover-icon` / `clover-wordmark` + `-on-dark` en blanco) vía `LOGO_OVERRIDE` en `lib/payments/logos.ts`.
- **Payway Point y Getnet Point** siguen "Próximamente" con la explicación honesta en la fila (`CHANNEL_SOON_REASON`). Mobbex, MODO, Ualá Bis, Viumi, Naranja X, Posnet/LaPos legacy, Cuenta DNI y Personal Pay se descartan como Point.
- Lógica pura en `supabase/functions/_shared/clover.ts` (Vitest, `tests/unit/clover.test.ts`); helpers server en `_shared/clover_server.ts`.

### Consecuencias

- Deploy: migración `20261013300000_fiserv_clover_point`; Edges `clover_point` y `clover_webhook` (`--no-verify-jwt`). Secrets de función opcionales: `CLOVER_APP_ID` (renovar tokens) y `CLOVER_WEBHOOK_AUTH` (webhook).
- **Inferido, a confirmar en el primer cobro de sandbox:** que Cloud Pay Display esté habilitado para comercios AR en producción; que el token de API del comercio sirva para Pay Display (los docs piden token OAuth de app); que `regionalExtras` viaje en Cloud Pay Display; que el tender traiga `debit_card` / `credit_card`.
- Fuera de alcance: anulación y devolución desde el POS (`/void`, `/refunds`), recibos por la terminal, propinas en la terminal y el flujo OAuth completo de alta (redirect desde el App Market): se suman cuando la app de NinjaSoft esté aprobada.

---

## ADR-045: Sucursales y cajas administrables, venta en la sucursal del turno y personal por sucursal con vigencias (F17 · H89 a H91)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/multisucursal-base`; migraciones sin aplicar) · **Hitos:** F17 · H89, H90 y H91 · **Base:** ADR-043

### Contexto

El dueño pidió "todo muy flexible y configurable, que pueda mover empleados de sucursales, programar traslados, etc, muy robusto, mucho mejor que Napse" y delegó las decisiones. Estado de partida (auditoría de ADR-043): `stores` y `cash_registers` sin ABM; `create_sale`, `return_sale`, `return_sale_v2`, `exchange_sale` y `account_open_shift` elegían la sucursal default (`order by is_default desc ... limit 1`); el POS tomaba "la primera caja activa del negocio" y "el último turno abierto del negocio"; roles sólo por negocio; `multi_sucursal` sin función. En paralelo otra rama (`feat/stock-sucursales`) hace stock por sucursal y transferencias (H94 y H95): esta ADR no toca stock.

### Decisión

1. **La sucursal sale del turno de caja (P0).** `resolve_sale_shift(p_cash_shift_id, p_strict)` devuelve turno y sucursal: (a) turno explícito, validado (del negocio, abierto, sucursal permitida); (b) negocio con **una sola sucursal viva**: exactamente el criterio anterior, sin cambio de conducta para los negocios actuales; (c) varias sucursales sin turno: el último turno abierto **por el propio usuario** en una sucursal permitida; si no, el último abierto si todos los abiertos están en una sola sucursal permitida; si hay turnos en varias, `shift_ambiguous`. `create_sale`, `return_sale_v2` y `exchange_sale` suman `p_cash_shift_id` opcional al final (se dropea la firma vieja, como en `20260609320000`); `return_sale` y `account_open_shift` mantienen firma. Las funciones se recrean completas desde su última definición y sólo cambia el bloque de sucursal y turno. En devoluciones sin efectivo el reingreso de stock va a la sucursal del turno en uso o, si no hay, a la de la venta.
2. **El POS manda el turno de SU caja.** Cada dispositivo recuerda sucursal y caja (`localStorage` por usuario y negocio, `modules/branches/store.ts`). La caja se resuelve dentro de la sucursal del POS: la recordada; si no, la que tiene un turno abierto por el usuario; si no, la primera libre. `useOpenShift` pasa a ser el turno de esa caja (antes era "el último del negocio") y su id viaja en las RPC de venta, devolución y cambio.
3. **"Dónde estoy" siempre visible.** Chip de sucursal en el panel (sidebar y header mobile) con "Todas las sucursales" para quien ve más de una; oculto si el usuario opera en una sola. En el POS: "Centro · Caja 1" (mobile "Centro · C1") con el selector "¿Dónde vendés hoy?" (cajas libre / abierta / abierta por vos); bloqueado con carrito cargado o con un turno propio abierto. Apertura y cierre de caja dicen dónde. Elegir una sucursal en el panel mueve el POS ahí salvo que el dispositivo tenga un turno abierto. Ventas (lista y XLSX) y cierres Z filtran por la sucursal del chip y, con "Todas", muestran la columna Sucursal.
4. **Sucursales y cajas como entidades (H89).** `stores` suma código, nombre corto, color, dirección estructurada, zona horaria, PV fiscal (placeholder para H98), horario semanal (`opening_hours` jsonb, validado en la UI), notas y orden; `cash_registers` suma código, tipo (fija, móvil, autoservicio), notas de dispositivo e impresora, PV propio opcional y **baja lógica** (`deleted_at`). Estados: activa, **pausada** (`is_active=false`: no abre caja ni se elige para vender) y **archivada** (`deleted_at`, restaurable). Una sola principal por negocio (índice parcial + `set_default_store`). Reglas en trigger: no se archiva la principal ni una sucursal o caja con turno abierto, no se pausa la última sucursal activa, una sucursal viva no se queda sin cajas, mover una caja de sucursal exige que no tenga turno abierto (la historia queda en `cash_shifts.store_id`, que ahora se desnormaliza por trigger).
5. **Gating real.** `multi_sucursal` deja de ser MARKETING-FUTURO: el trigger exige la feature desde la segunda sucursal viva y `max_stores` (`tenant_limit_for`). Nueva feature OPTIONAL `multi_caja` (Pro, Business, Enterprise; planes a medida la heredan de `multi_sucursal`) desde la segunda caja de una sucursal, con límite nuevo `max_registers_per_store` (Start 1, Pro 3, Business 10, Enterprise sin límite). La primera sucursal y la primera caja son BASE. Las restauraciones también cuentan. La UI anticipa con `UpgradeModal`, el servidor decide.
6. **Personal por sucursal con vigencias (H91).** Tabla `staff_branch_assignments` (no `tenant_user_stores`): sirve para usuarios con login y para **perfiles de cajero sin cuenta**, con tres tipos: `home` (sucursal base; un **traslado definitivo** corta la base vigente el día anterior y reemplaza bases futuras), `cover` (**cobertura temporal exclusiva** con fecha de fin: mientras dura sólo opera ahí y al terminar vuelve sola a su base) y `extra` (acceso adicional con o sin fin). Rol opcional por sucursal que pisa el del negocio (nunca dueño); `create_sale` lo usa para el tope de descuento. **Evaluación perezosa** por fecha (`branch_today()`, hora de Argentina), sin cron. Cancelar un movimiento programado lo da de baja y **restaura** lo que había cortado (`superseded_by`, `prev_valid_until`); cancelar uno vigente lo finaliza desde hoy. Escritura sólo por RPC (`staff_branch_schedule`, `staff_branch_cancel`), owner o manager, gateada por `multi_sucursal` y auditada.
7. **Alcance por sucursal.** `staff_allowed_store_ids` / `user_allowed_store_ids` / `user_can_access_store`: dueño, staff interno y negocios con una sola sucursal viva ven **todas** (incluidas archivadas, para no perder historia); con asignaciones vigentes: cobertura exclusiva, si no base + adicionales; sin asignaciones vigentes: **encargado = todas** (alcance central), **cajero o solo lectura = la sucursal principal**. Así crear la segunda sucursal no deja a nadie sin acceso ni le abre a un cajero las demás.
8. **RLS de lectura por sucursal** con policies **RESTRICTIVE** (se suman con AND a las de tenant, sin tocarlas) en `sales`, `cash_shifts`, `cash_movements` y `cash_z_closures`, con `(select user_allowed_store_ids())` evaluado una vez por consulta. Para el dueño y para los 4 negocios actuales (una sucursal) no cambia nada. `open_cash_shift` valida caja, sucursal activa y acceso del usuario (y de paso que la caja sea del negocio).

### Alternativas descartadas

- **`tenant_user_stores(user_id, store_id, role)` sin fechas** (ADR-043): no permite programar traslados ni coberturas y no cubre perfiles sin cuenta; se generaliza con vigencias y tipos.
- **pg_cron para aplicar traslados programados:** agrega un proceso que puede fallar y deja estados intermedios; la vigencia calculada al consultar es exacta y gratis.
- **"Sin filas = todas" para cajeros** (ADR-043): al crear la segunda sucursal cada cajero vería todas; se elige "principal" para cajeros y "todas" para encargados.
- **Mandar la sucursal en un header HTTP o setting de sesión:** implícito y frágil; se prefiere el parámetro explícito más la inferencia segura en el servidor.
- **Mover la sucursal default al archivar:** cambio silencioso; se exige elegir otra principal antes.

### Consecuencias

- Migraciones `20261013100000_sucursales_cajas`, `20261013110000_personal_por_sucursal`, `20261013120000_venta_sucursal_del_turno` (sin aplicar). Backfill: `cash_shifts.store_id` desde la caja (sin auditoría ni `updated_at`), normalización de una sola principal por negocio, `multi_caja` y `max_registers_per_store` en planes.
- **Coordinación con `feat/stock-sucursales`:** si esa rama recrea `create_sale`, `return_sale`, `return_sale_v2` o `exchange_sale`, tiene que partir de `20261013120000` (sino pisa el fix); conviene que use `resolve_sale_shift`.
- Devolver una venta de otra sucursal: un cajero limitado no la ve (RLS); la hace un encargado o el dueño. Queda para H96/H97 una búsqueda controlada para devoluciones cruzadas.
- Pendiente: `payments`, `sale_items` y `stock_movements` no tienen policy por sucursal (se leen por la venta); `store_id` en `audit_logs`; reportes por RPC (consolidado y comparativo, H97) siguen por negocio; invitación de usuario con sucursales; asignar terminales y overrides de configuración por sucursal (H92, H93).

---

## ADR-046: Stock por sucursal derivado de movimientos y traslados entre sucursales (F17 · H94 y H95)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/stock-sucursales`, migraciones no aplicadas) · **Hitos:** F17/H94 (stock por sucursal) y F17/H95 (traslados) · **Numeración:** ADR-043 y ADR-044 ya existen y ADR-045 queda reservada para `feat/multisucursal-base`.

### Contexto

El dueño pidió traslados "muy flexibles y configurables, programados, muy robustos, mucho mejor que Napse". Hoy el stock es uno solo (`products.stock`, `product_variants.stock`) aunque `stock_movements.store_id` ya guarda la sucursal. Las RPC que mueven stock (`create_sale`, `exchange_sale`, `return_sale*`, anulaciones, cuenta corriente, ajuste, merma y producción) escriben el total y luego insertan el movimiento. En paralelo, `feat/multisucursal-base` corrige esas RPC para tomar la sucursal del turno; esta rama no puede tocarlas.

### Decisión

1. **`product_stock` es un saldo derivado del libro `stock_movements`.** Un trigger `AFTER INSERT/DELETE` suma el delta en la sucursal del movimiento; un `BEFORE INSERT` completa la sucursal si falta (la de la venta referenciada o la principal). Así cualquier RPC presente o futura que inserte su movimiento con `store_id` queda por sucursal sin cambiarla: cuando `create_sale` tome la sucursal del turno, el stock por sucursal sale correcto solo.
2. **`products.stock` sigue siendo el total consolidado** (todas las pantallas y el control de "sin stock" del POS siguen igual). No se recalcula con un trigger que lo escriba (las RPC existentes ya lo escriben y se duplicaría): se **garantiza** con triggers de restricción diferidos que, al commit, comparan el total con la suma por sucursal y, si una escritura cambió el total sin movimiento (alta con stock inicial, edición directa, import), registran la diferencia como `adjustment` en la sucursal principal. Nunca bloquea la operación (un error queda como warning). Diagnóstico: `product_stock_mismatches`.
3. **En tránsito no suma en ninguna sucursal ni en el total**: el despacho descuenta el origen; la recepción suma en el destino; lo pendiente se ve en `stock_by_store` (llegan / salieron). Un faltante cerrado queda en el ítem con motivo y no vuelve a ninguna sucursal; cancelar en tránsito devuelve lo despachado al origen (`transfer_return`).
4. **Máquina de estados** `draft → pending_approval → scheduled → in_transit → partially_received → received / cancelled` en RPC SECURITY DEFINER (`transfer_save`, `_submit`, `_approve`, `_reject`, `_reschedule`, `_dispatch`, `_receive`, `_cancel`) con espejo puro en `lib/stock/transfers.ts` para la UI. Edición sólo en borrador; rechazo vuelve a borrador; despacho con cantidades distintas a lo pedido; recepciones parciales sucesivas; cierre con motivo por diferencia.
5. **Programación perezosa, sin cron:** `scheduled_for` (fecha); la UI muestra "Para despachar hoy" o "Atrasado". Se descartó pg_cron porque no hay nada que ejecutar sin una persona que despache.
6. **Configuración por negocio** (`stock_transfer_settings`): aprobación (todos o desde N unidades o $ valor a costo; aprueba el dueño o un encargado distinto de quien lo armó; el dueño no se pide aprobación a sí mismo), cajero puede recibir (sí por defecto) o despachar (no por defecto), permitir sobrantes, exigir motivo en diferencias, bloquear despacho sin stock en origen.
7. **Remito interno** con número correlativo por negocio (`R-000123`, lock por advisory como las ventas), imprimible (aislamiento de impresión igual que la comanda, A4 con firmas) y XLSX; timeline en `stock_transfer_events` y `audit_logs` en cada paso.
8. **Features (convención CLAUDE.md §6), ambas OPTIONAL desde Business:** `stock_sucursales` (requiere `multi_sucursal`) y `traslados` (requiere `stock_sucursales`). El roadmap y ADR-043 las nombraban `multi_sucursal` (stock) y `transferencias_stock`; se usan estas keys por pedido explícito del PM. Gating server-side: `adjust_store_stock` fuera de la sucursal principal y `set_store_stock_settings` exigen `multi_sucursal` + `stock_sucursales`; toda RPC `transfer_*` exige `multi_sucursal` + `traslados`, y crear o confirmar exige 2+ sucursales activas. Los saldos por sucursal se mantienen siempre (barato y sin huecos si el negocio sube de plan).
9. **UI sin romper el caso de una sucursal:** con una sola sucursal Productos y la ficha quedan igual; con varias (y la feature) la lista muestra la sucursal actual bajo el total con desglose expandible, la ficha muestra stock, en camino, mínimo, máximo y ubicación por sucursal, y el ajuste pasa a ser por sucursal (ingreso, egreso o conteo). Pantalla nueva **Catálogo, Traslados** (visible con 2+ sucursales) con lista por estado, asistente (ruta, fecha, búsqueda y lector de códigos), despacho, recepción con diferencias, remito y "Sugerir traslados" (faltantes bajo mínimo cubiertos desde sucursales con sobrante sin dejarlas bajo su mínimo, `lib/stock/suggest.ts`). La "sucursal actual" es la principal hasta que exista el contexto de H90 (`useCurrentStoreId`).

### Alternativas descartadas

- **Editar `create_sale` y compañía para escribir `product_stock`:** fuera del alcance de esta rama (lo toca `feat/multisucursal-base`) y frágil: cada RPC nueva tendría que acordarse.
- **`products.stock` como vista o columna calculada:** rompe las RPC que lo actualizan y el control de stock del POS.
- **Trigger que reescribe `products.stock` desde `product_stock`:** doble conteo con las RPC actuales.
- **pg_cron para traslados programados:** no hay acción automática segura; el vencimiento perezoso alcanza.
- **Policies de escritura en las tablas de traslado:** todo por RPC para que estado, stock y auditoría no se desincronicen.

### Consecuencias

- **Deploy:** la migración `20261013200100` hace backfill del stock actual de cada producto y variante a la sucursal principal de su negocio (idempotente, sólo si no tiene filas). Con 4 negocios y 1 sucursal cada uno es un `insert ... select` chico. Hay que aplicar las tres migraciones en orden y después la de `feat/multisucursal-base` puede ir antes o después (no se pisan).
- **Desde el deploy, cada movimiento de stock agrega un trigger por fila y una conciliación al commit** (una suma por producto tocado); despreciable a la escala actual, medir con `EXPLAIN` si crece.
- **Ventas con 2+ sucursales:** mientras `create_sale` use la sucursal default, las ventas descuentan esa sucursal; al mergear el fix de H90 descuentan la del turno sin cambios acá. El control "sin stock" del POS sigue siendo sobre el total (por sucursal queda como pendiente de H94).
- **Pendiente:** RLS por sucursal (`user_can_access_store`, H91) en `product_stock` y `stock_transfers`; recepción restringida a usuarios de la sucursal destino; seriales por sucursal; solicitud de traslado desde la sucursal que necesita; reporte de artículos en tránsito; stock por sucursal en el buscador del POS; tabla en el asistente IA.

---

## ADR-048: Cobros en espera con venta del lado del servidor, y QR más rápido (F8 · H21f y H21g)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/cobros-en-espera`, migración no aplicada) · **Hitos:** F8/H21f (cobros en espera) y F8/H21g (QR más rápido).

### Contexto

El dueño pidió: QR más rápidos; poder compartir el QR o link (email, WhatsApp, lo que elija) o marcar "ya lo compartí" y dejar el pago esperando mientras sigue cobrando; que avise al acreditarse para imprimir ticket o factura; decidir al cerrar la caja si cancela los pendientes o los pasa a la próxima apertura; pestaña propia para ver el detalle, cancelar, editar y volver a compartir. "Muy robusto."

Hoy la venta de un cobro QR la crea **el POS** cuando su sondeo ve el intent aprobado (`create_sale` con `payments.reference` = intent). Si el modal se cierra, el pago aprobado queda "sin venta" en Cobros QR para conciliar a mano. Los webhooks de todos los proveedores ya actualizan `mp_payment_intents`, pero nadie crea la venta en el servidor.

### Decisión

1. **`pending_charges` + `pending_charge_events`.** El cobro estacionado guarda los **argumentos de `create_sale`** (mismo mapeo que la venta inmediata: `buildSaleItemsAndExtras`), el carrito para editar, líneas para mostrar, sucursal, caja, turno, cliente y contacto, intent vigente e intents anteriores, link, QR, canales usados, vencimiento, estado y `version` (edición optimista). RLS de lectura por sucursal permitida; **sin policies de escritura**: todo por RPC SECURITY DEFINER con evento y `audit_logs`. Baja lógica con `deleted_at`.
2. **Estados:** `waiting → paid → completed`, `waiting → cancelled | expired`, `expired → waiting` (regenerar). `paid` = el proveedor acreditó pero la venta todavía no se pudo crear (no hay caja abierta, falta stock, etc.; se reintenta sola). No hay `failed` aparte: es `paid` con `last_error`. `needs_review` marca los casos que sólo se completan a mano (encargado o dueño): pago tardío sobre un cobro cancelado o vencido, pago de un link reemplazado, monto acreditado menor.
3. **Montos nunca del cliente.** Al estacionar se corre `create_sale` **en seco** (subtransacción revertida con `raise` y captura del resultado) con el mismo carrito y turno: valida todo lo que valida la venta real (stock, cupón, topes de descuento por rol, gating) y devuelve el total autoritativo; se exige total + propina = monto del intent. Al completar se usa el carrito guardado y el monto del intent (escrito sólo por Edges tras verificar con el proveedor); si el proveedor cobró más (Payway con cuotas con recargo elegidas por el cliente) la diferencia entra como ítem "Recargo cuotas"; si cobró menos, revisión.
4. **La venta la crea el servidor.** `_pc_complete` (lock del cobro y del intent, idempotente: un completado devuelve su venta) llama a `create_sale` fijando los claims de la transacción (`request.jwt.claims` con el usuario que estacionó y su negocio) y los restaura al salir, así reusa sin copiar las 600 líneas de `create_sale` (stock, caja, cuenta corriente, packs, cupones, triggers de gating de `payments`). Disparadores, todos idempotentes:
   - **Trigger `AFTER UPDATE OF status` en `mp_payment_intents`**: cubre a la vez los webhooks y los sondeos de TODOS los proveedores (sin tocar sus Edges). Nunca hace fallar la actualización del intent (errores a `last_error`).
   - **El POS** (y la pestaña) sondean los cobros abiertos contra su proveedor y llaman a `complete_pending_charge`.
   - **Apertura de caja** (trigger `AFTER INSERT` en `cash_shifts`) y **cron** `pending-charges-tick` cada 2 min (vence y reintenta hasta 30 veces).
   - **Cron `pending-charges-sync`** (Edge `pending_charges_sync`, X-Cron-Secret) para Pagos360, que no tiene webhook, con la misma lógica que su Edge (`_shared/pagos360_server.ts`).
5. **Regla contable:** la venta entra en la fecha y el **turno abierto al momento de acreditarse** (el suyo si sigue abierto; si no, el abierto de su caja; si no, el más reciente de su sucursal). Sin turno abierto queda `paid` y se registra en el próximo turno que se abra en la sucursal. El método es `qr` (no suma al efectivo esperado del arqueo). El que reintenta a mano registra la venta a su nombre; el resto, a nombre de quien la estacionó.
6. **Cierre de caja:** `close_cash_shift` suma `p_pending_action` (`cancel` | `carry`); con cobros abiertos en el turno y sin decisión responde `pending_charges_decision_required` (sin estados huérfanos, exigido en el servidor). `cancel` cancela los que esperan (los ya pagados no se cancelan: pasan); `carry` los desengancha (`cash_shift_id = null`, `carry_over`) y se enganchan solos al próximo turno de su caja (o de su sucursal si la caja ya no está). La UI del cierre muestra cuántos y por cuánto y obliga a elegir.
7. **Cancelar** marca el cobro y deja el intent `cancelled` localmente (`create_sale` exige `approved`); el POS además lo da de baja en el proveedor donde hay API (order QR de MP, Nave, GO Cuotas, Directo). Si igual se paga, el webhook lo pasa a `approved`, el trigger lo marca `paid` + `needs_review` y avisa: nunca se pierde un pago ni se vende dos veces algo que pudo venderse de nuevo.
8. **Editar** = "Editar en el POS": el carrito vuelve al POS con un banner; al generar el QR nuevo, "Actualizar cobro en espera" llama a `replace_pending_charge_intent` (carrito y monto nuevos, validados en seco, intent anterior cancelado y guardado en `previous_intent_ids`). Si se cobra en el momento con otro medio, el cobro en espera se cancela. **Regenerar** (vencido) = mismo carrito, link nuevo, sin dry-run si el monto no cambia.
9. **Sólo se estaciona un cobro con un único medio que cubra toda la venta**, fuera de mesas, delivery y turnos de agenda (tienen su cierre atómico propio) y con caja abierta. Un pago parcial en efectivo ya entró a la caja: no se puede postergar.
10. **QR de la caja de Mercado Pago (Orders API) no se estaciona:** bloquea la caja para la venta siguiente. "Dejar en espera" y "Compartir" lo pasan antes a link de Checkout Pro (cancelando la order y re-consultándola, como el "Enviar link" existente).
11. **Vencimiento por proveedor** (minutos, espejo en `pending_charge_max_ttl` y `PROVIDER_MAX_TTL_MINUTES`, test que los compara): MP 7 días, Mobbex y Payway 3 días, Pagos360, GO Cuotas y Directo 24 h, Nave 60 min, Getnet y MODO 30 min. Default 24 h acotado al tope. Extender cuenta desde ahora. Vencido = el cron lo marca y cancela el intent; la UI lo muestra vencido aunque el cron no haya corrido (evaluación perezosa).
12. **Compartir:** Web Share API cuando existe, WhatsApp (`wa.me` con el celular normalizado a 549 y texto armado), email, copiar y SMS. El **email lo manda el servidor** (Edge `pending_charge_share`, cadena de `_shared/mailer.ts`: Resend y SMTP) con un template con la marca del negocio (`lib/email/paymentLinkTemplate.ts`, espejado en la Edge y verificado por test), registro en `system_emails` (`payment_link`) y en la línea de tiempo; límites 5 por cobro y 60 por hora por negocio. Desde el modal, "Enviar y dejar en espera" estaciona y envía. También se ofrece la app de correo (`mailto`).
13. **Avisos:** el POS sondea (10 s con cobros abiertos, 30 s sin; sin Realtime en el proyecto todavía) y muestra un toast con "Imprimir ticket", "Emitir factura" (por ahora abre el comprobante: la factura electrónica llega con F3) y "Visto" (`ack_pending_charge`, para todos los POS de la sucursal); además `notifications` (`type = 'cobros'`) a cada usuario que opera la sucursal, con link a `/cobros-en-espera?id=`.
14. **Feature `cobros_en_espera`, OPTIONAL desde Pro** (`is_basic=false`, Pro, Business y Enterprise). Gating real en `park_pending_charge`, `replace_pending_charge_intent` y la Edge de email. La completitud **no** se gatea (si el cliente pagó, la venta se registra), y la pestaña sigue accesible si el plan baja para gestionar lo que quedó abierto.
15. **QR más rápido.** Antes, crear un QR de MP encadenaba en la Edge `getUser` → body → membresía → plan → secreto → sandbox → config → insert del intent → order de MP → update (7 rondas a la base + auth + proveedor en serie), y el modal esperaba dos consultas (planes y config del medio) antes de llamar a la Edge. Ahora: auth y body en paralelo; membresía, plan, credencial y config en **una** ronda; el id del intent se genera en la Edge y el insert corre **en paralelo** con la order o preferencia del proveedor; MODO cachea su token por instancia (10 min); la hoja pasa al modal los planes y el modo del medio que ya tenía (el QR se pide al montar); al abrir la hoja se precalientan las Edges de los medios QR con un OPTIONS; si MP no tiene caja QR, el link se pide directo durante 10 min. Cada Edge loguea `{"fn","total","steps"}` y devuelve `Server-Timing` para medir antes y después.

### Alternativas descartadas

- **Copiar `create_sale` en una variante "server"**: 600 líneas que se desincronizan con cada cambio (cupones, packs, sucursales). Fijar los claims de la transacción reusa la función viva.
- **Crear la venta en cada Edge de webhook**: nueve Edges a tocar y a mantener; el trigger sobre el intent cubre todas, también el sondeo.
- **Venta "pendiente" en `sales` con estado nuevo**: rompe reportes, arqueos, stock y Z, que asumen `completed`/`voided`.
- **Reservar stock al estacionar**: complejidad alta (liberar al vencer o cancelar); el dry-run valida y la venta real vuelve a validar al acreditarse. Si no hay stock y el negocio no permite negativo, queda `paid` con el error para resolver.
- **Realtime de Supabase**: no está en uso en el proyecto; el sondeo con TanStack Query alcanza a esta escala. Queda como mejora.
- **Detectar "visto por el cliente"**: ningún proveedor lo informa.

### Consecuencias

- **Deploy:** aplicar `20261014100000_cobros_en_espera` (feature, tablas, RPC, triggers, crons; redefine `close_cash_shift` y dropea su firma de 3 args: el front nuevo manda `p_pending_action` sólo si hace falta, así que el front viejo sigue cerrando mientras no haya cobros en espera). Edges nuevas: `pending_charge_share` y `pending_charges_sync` (ambas con verify_jwt; el cron usa el patrón `internal_cron`). Re-deploy de `mp_qr`, `mp_create_qr`, `pagos360`, `modo_create_qr` (comparten `_shared/mpAuth.ts`, `_shared/timing.ts`, `_shared/pagos360_server.ts`; también conviene re-deploy de las que importan `mpAuth`: `mp_point`, `mp_webhook`, `mp_orders_webhook`).
- Cada cambio de estado de un intent dispara un trigger que busca su cobro en espera por índice único: costo despreciable. Completar dentro de la transacción del webhook alarga esa transacción lo que tarda `create_sale` (ms).
- **Riesgo conocido:** si un usuario quedó sin acceso a la sucursal entre estacionar y acreditarse, la venta automática falla (queda `paid`) y la registra un encargado con "Registrar la venta igual" o "Reintentar".
- **Pendiente:** Realtime; factura electrónica desde el aviso (F3); el mismo patrón de latencia en `mobbex_create_qr`, `payway`, `getnet`, `nave`, `gocuotas` y `directo`; medir en producción con los logs de tiempos.

---

---

## ADR-050: Compras, proveedores, costos e importaciones v1 (F18 · H101 y H102)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/compras-proveedores`, migraciones no aplicadas) · **Hitos:** F18/H101 (compras, proveedores y costos) y F18/H102 (costeo de importación) · **Numeración:** ADR-048 y ADR-049 reservadas por otras ramas; ADR-052 tomada por el aislamiento del staff interno.

### Contexto

No había proveedores, compras ni costos más allá de `products.cost` (único y manual). El dueño pidió un módulo "muy configurable, con un modo simple y uno muy profesional para quien compra e importa", con contexto argentino. Debe convivir con el stock por sucursal derivado de movimientos (ADR-046) y con el contexto de sucursal (ADR-045).

### Decisión

1. **Modelo.** `suppliers` (razón social, CUIT validado por dígito verificador en TS y en un check SQL, condición IVA, contacto, plazo de pago, moneda, CBU/alias, baja lógica), `supplier_products` (código del proveedor, último costo, costo de lista, plazo de entrega, mínimo y unidad de compra), `purchase_orders` + `purchase_order_items`, `goods_receipts` + `goods_receipt_items`, `product_lots` (lote, vencimiento, n° de despacho), `supplier_invoices`, `supplier_payments`, `purchase_events` (timeline común), `purchase_settings` y `product_cost_history`. Vistas `supplier_account_entries` y `supplier_balances` con `security_invoker`.
2. **Escrituras.** Proveedores y productos por proveedor por tabla con RLS (rol dueño o encargado y feature `compras` en la policy). Órdenes, recepciones, costeo, comprobantes y pagos sólo por RPC `SECURITY DEFINER` con `search_path` fijo que validan plan, rol, estado y sucursal, y escriben `purchase_events` y `audit_logs`. Las tablas sólo tienen policies de lectura, siempre `tenant_id = current_tenant_id() or internal_scope()` (ADR-052); el front filtra además por el negocio activo.
3. **Máquina de estados de la OC** `draft → sent → partially_received → received`, `sent → draft` (reabrir sin recepciones), `partially_received → received` (cerrar con faltante y motivo) y `draft | sent → cancelled` sin nada recibido. Espejo puro en `lib/purchases/orders.ts`. Descuentos en cascada por línea (10 + 5) y descuento global; numeración `OC-`, `REC-` y `OP-` por negocio con lock por advisory.
4. **Recepción** contra OC o libre (configurable), parcial, con diferencias y motivo, por sucursal destino (la de la OC o la elegida; el cajero sólo en las sucursales que tiene asignadas). Cada línea suma `products.stock` / `product_variants.stock` e inserta `stock_movements` con motivo `purchase` (ya estaba en el check) y `store_id`: `product_stock` lo mantiene el trigger de ADR-046. Actualiza el último costo del producto en ese proveedor (lo crea si no existía).
5. **Costos (BASE, sin key).** `products.last_cost`, `avg_cost` (promedio ponderado móvil: el stock negativo cuenta como cero) y `replacement_cost`, netos de IVA y en pesos, con historia (`product_cost_history`, por trigger, con la fuente: recepción, costeo, lista del proveedor, manual). El negocio elige la base del margen (`purchase_settings.cost_basis`, último por defecto) y, con `sync_product_cost` (activo por defecto), `products.cost` sigue a esa base: márgenes, valor del inventario, traslados y el asistente usan el costo correcto sin cambios. Backfill: último y promedio parten del costo cargado hoy. Costos a nivel producto (las variantes comparten costo en v1).
6. **Modo simple / profesional** (`purchase_settings.mode`, preferencia de UI). Profesional muestra moneda y tipo de cambio por operación (OC, recepción, comprobante y pago), peso y volumen por línea y la hoja de costeo. El saldo de la cuenta corriente va en pesos al tipo de cambio de cada documento; la diferencia de cambio queda para H109.
7. **Costeo de importación** (`compras_importacion`): lógica pura en `lib/purchases/landed.ts` (FOB + flete + seguro = CIF; derechos por línea, tasa de estadística con tope, otros tributos que son costo y gastos de nacionalización, cada concepto prorrateado por valor, peso, volumen o cantidad en centavos exactos). El IVA de importación y las percepciones se calculan aparte y **nunca** se suman al costo. Se aplica sobre una recepción ya registrada y es re-aplicable: el servidor guarda la hoja, el costo puesto en depósito por línea y el n° de despacho en el lote, y ajusta el promedio repartiendo la diferencia sobre el stock actual (último costo sólo si es la recepción más reciente).
8. **Comprobantes y pagos.** Letra A/B/C/M/E, punto de venta y número (único por proveedor y tipo entre los vigentes), neto por alícuota del catálogo (21, 10,5, 27, 5, 2,5, 0), exento, no gravado, percepciones y otros tributos como líneas libres; B y C no discriminan IVA; el total tiene que cerrar (servidor y TS). Vínculo con recepciones (control de dos vías). Pagos con medio, referencia y retenciones practicadas como placeholder hasta H106; anulación con motivo en ambos. Aging FIFO por vencimiento en `lib/purchases/aging.ts`.
9. **Sugerencia de compra** por sucursal (`purchase_suggestions`): bajo el mínimo contando traslados en camino y OC abiertas; cantidad a máximo o mínimo, redondeada a la unidad de compra y al mínimo del proveedor (`lib/purchases/suggest.ts`).
10. **Features (CLAUDE.md §6):** `compras` OPTIONAL desde Pro; `compras_importacion` OPTIONAL desde Business, requiere `compras`. El roadmap y la auditoría proponían `importaciones` (Enterprise); se usa `compras_importacion` en Business por pedido explícito del PM. Gating server-side en `purchase_assert` (todas las RPC), en las policies de proveedores y en `purchase_apply_costing`; el modo profesional exige `compras` al guardarse. Copy en `featureInfo.ts`; la comparación de planes deriva de la matriz.

### Alternativas descartadas

- **Escribir `product_stock` desde la recepción:** rompe el invariante de ADR-046 (el saldo sale del libro de movimientos).
- **FIFO / capas de costo:** más preciso pero caro; el promedio móvil con ajuste por costeo alcanza para v1.
- **Calcular el costeo de importación en SQL:** duplicaría una lógica larga y parametrizable; el servidor guarda la hoja completa y el resultado por línea (auditable) y valida montos no negativos.
- **Comprobantes con tablas hijas de alícuotas y tributos:** jsonb validado alcanza para v1 y para exportar el libro de compras; se normaliza con H108.

### Consecuencias

- **Deploy:** aplicar `20261016100000` a `20261016100300` en orden, después de las de ADR-046 y de `20261013900000` (ADR-052; si no está, la migración crea `internal_scope()` con la misma definición sin pisarla). Backfill liviano de `last_cost` y `avg_cost`.
- **Riesgos:** recepciones inmutables en v1 (una corrección es un ajuste de stock o una recepción nueva); el costeo confía en el costo unitario calculado por el cliente (queda la hoja guardada); sin integración con caja ni tesorería para pagos en efectivo (H111); sin padrones ni retenciones como agente (H104 y H106); sin devoluciones al proveedor con salida de stock.
- **Pendiente:** devoluciones a proveedor, órdenes de pago con aplicación manual a comprobantes, anticipos, importación de listas de precios del proveedor (H100), libro IVA compras (H108), n° de despacho en la factura de venta y consumo por lote, unidad de compra con conversión en la OC.

---


## Próximas ADRs (placeholder)

Cuando se tomen decisiones sobre proveedor de pagos concreto por integración, motor de impresión de tickets, estrategia de backups o cualquier otra cosa estructural, se agregan acá siguiendo el template.

---

## ADR-052: Aislamiento del staff interno: internal_scope() en vez de is_internal() en RLS de negocio

**Fecha:** 2026-10-12 · **Estado:** aceptada · **Severidad:** incidente de aislamiento multi-tenant

**Contexto.** Muchas políticas RLS de tablas de negocio eran `tenant_id = current_tenant_id() OR is_internal()`. Un usuario interno usando el panel de SU negocio veía filas de todos los negocios en cualquier lista sin filtro explícito por tenant (Sucursales y cajas mostró las sucursales de los 4 negocios). Ningún cliente final podía ver datos ajenos (requiere JWT interno), pero la UI mezclaba negocios.

**Decisión.**
- `internal_scope()` = `is_internal()` y header `x-ninja-scope: internal`. Sólo lo mandan los clientes Supabase en rutas `/internal` (navegador: fetch con el header según la ruta; servidor: `createClient({ scope: "internal" })`).
- Migración `20261013900000_aislamiento_staff_interno` reescribe todas las políticas PERMISSIVE de tablas con `tenant_id` que usaban `is_internal()`. Las RESTRICTIVE (alcance por sucursal) y las de tablas de plataforma no cambian.
- Defensa en profundidad: las listas del panel del negocio filtran por `getCurrentTenantId()`.
- Guardarraíl: `rls_internal_scope_leaks()` (service_role) y un test en el job `rls` de CI que exige 0 filas; regla agregada en CLAUDE.md §3.

**Consecuencias.** Toda política nueva de negocio debe usar `internal_scope()`. Las Edge Functions internas no cambian (validan el JWT y usan service_role). Orden de deploy: front primero (el header es inocuo sin la migración), después la migración.

