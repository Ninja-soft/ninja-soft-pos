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

### Adenda (2026-10-12): edición de la numeración y tabla nueva

**Contexto.** El dueño pidió "mejorame la tabla, que no se rompa; además permitime editar la numeración si es mi caja, o todas las cajas si soy supervisor". La tabla partía encabezados, mezclaba fuentes, llenaba de guiones y se rompía en anchos chicos.

**Decisión.**
- **Tabla:** encabezados cortos que no se parten (nombre completo en el tooltip) y fijos arriba con scroll propio dentro de la card; jerarquía día (fila con día de la semana, total y "x de y conciliados") → comercio (subencabezado liviano) → lote (checkbox, subtotal alineado con la columna Monto y estado: Conciliado, Pendiente o "x de y"); una sola familia tipográfica con `tabular-nums`; vacíos con `NoData`; estado por cobro; checkbox nuevo del sistema `components/ui/Checkbox.tsx` (selección neutra, estado mixto). Debajo de `md`, tarjetas por lote en lugar de la tabla.
- **Edición:** lápiz por cobro que abre `VoucherEditModal` (hoja en mobile) con lote, cupón, autorización, últimos 4, n° de comercio y cuotas, motivo opcional e historial (quién, cuándo, qué cambió). Validación en `lib/reports/voucherEdit.ts`, espejo de la del servidor.
- **Servidor:** RPC `update_payment_voucher(p_payment_id, p_patch, p_reason)` SECURITY DEFINER con `search_path`: cobro de tarjeta del tenant, plan con `conciliacion_tarjetas`; dueño o encargado editan cualquiera; cajero sólo cobros de ventas de un turno que abrió él; solo lectura nunca. Cobro ya conciliado: el cajero queda bloqueado; dueño o encargado lo editan, **sigue conciliado** y la edición queda con `was_reconciled = true` (la tabla lo marca en ámbar para revisarlo). Claves en lista blanca, valores validados (lote hasta 10 dígitos, cupón hasta 12, comercio hasta 20, autorización alfanumérica hasta 20 en mayúsculas, últimos 4 exactos, cuotas 1 a 99), vacío borra la clave, y se mezcla en `card_voucher` sin tocar `marca` ni otras claves. Historial en la tabla nueva `payment_voucher_edits` (lectura `tenant_id = current_tenant_id() or internal_scope()`, ADR-052; sin escritura por PostgREST) y `audit_logs` (`payment_voucher_updated`, antes y después). No toca `reconciled_*`: el guard `payments_reconcile_guard` sigue igual.

**Alternativas descartadas.** Guardar el historial dentro de `card_voucher._edits` (ensucia un dato que se imprime y viaja a otros lados); desconciliar solo al editar (el supervisor ya verificó el lote; se prefiere marcarlo y que lo revise).

**Consecuencias.** Migración `20261018200000_edicion_cupon_tarjeta` (no aplicada). Orden de deploy: migración primero; sin ella la pantalla funciona igual pero el historial pide una tabla que no existe (404 en consola) y el lápiz falla al guardar. Tests: `tests/unit/voucherEdit.test.ts` y `tests/integration/rls-voucher-edit.test.ts`.

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

## ADR-049: Configuración heredable por sucursal y caja, terminales e impresoras (F17 · H92 y H93)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/sucursales-config-terminales`; migraciones sin aplicar, Edges sin desplegar) · **Hitos:** F17 · H92, H93 (más cierres de H90, H91, H94 y H97) · **Base:** ADR-043, ADR-045, ADR-046 · **Numeración:** ADR-048 queda reservada para "cobros en espera".

### Contexto

El dueño pidió que la multi-sucursal sea "muy flexible y configurable, muy robusta, mucho mejor que Napse", y sumó impresoras por sucursal y caja y logo por sucursal. Hasta acá toda la configuración era del negocio (`tenant_payment_methods`, `pos_settings`, `tenant_branding`, `print_profiles`) y las terminales vivían en lugares sueltos: el lector Point en `localStorage`, una sola caja QR de MP por ambiente en `config.mp_qr`, los Point de Nave y las series de Clover como texto dentro de los secretos.

### Decisión

1. **Tabla genérica `config_overrides` con override por campo** (`patch` parcial) por alcance `store_group` / `store` / `register` y dominio (`payment_method` con `provider_key`, `pos_settings`, `ticket`). La sucursal sólo guarda lo que pisa; un cambio del negocio llega a todas las que no lo pisaron. Grupos (`store_groups`) como nivel intermedio. Orden negocio ← grupo ← sucursal ← caja; los mapas (n° de comercio por marca, descuento por rol, perfiles de impresión, diseño) se mezclan por clave.
2. **Whitelist por dominio y alcance** en SQL (`config_field_type`) con espejo en `lib/config/inheritance.ts`: la caja sólo puede apagar medios y pisar cierre, venta libre, display, impresión y diseño; numeración, SKU y secretos nunca se pisan.
3. **Resolución en el servidor**: `_effective_config` (service, triggers) y `effective_config` (JWT, con acceso a la sucursal) devuelven valor y origen por campo. `create_sale` toma redondeo, descuento máximo y venta sin stock de la configuración efectiva del turno; `close_cash_shift`, motivo y tolerancia. El trigger `payments_branch_method` rechaza un medio **apagado por override** en la sucursal o caja de la venta (un medio apagado en el negocio sin overrides se comporta como siempre). Las Edges de cobro presencial también lo chequean (`payment_method_blocked_at`).
4. **Gating antes de la herencia**: escribir overrides exige `multi_sucursal` (grupo y sucursal) o `multi_caja` (caja); un override nunca prende un medio cuyo `payment_method_plan_key` no está en el plan. Bajar de plan no borra overrides: dejan de aplicarse. Sin features nuevas: es parte de `multi_sucursal` / `multi_caja` (OPTIONAL); el registro de terminales y de impresoras es BASE.
5. **Escritura sólo por RPC** (`config_override_set`, `config_override_copy`, `config_override_reset_field`) con rol, alcance (un grupo exige alcance central), tipos y auditoría. "Volver a heredar" = sacar el campo; patch vacío = baja lógica.
6. **"Compartir configuración" sin copiar por defecto**: "Copiar de otra sucursal" (reemplazar o sólo sumar, con vista previa campo por campo), "Diferencias por sucursal" y "Aplicar a todas" (el campo vuelve a heredar en todos los alcances).
7. **Terminales como entidad (`payment_terminals`)**: sucursal, caja o flotante, proveedor, tipo (`point`, `qr_caja`, `clover`, `posnet_manual`), id externo y ambiente, n° de comercio, adquirente, default por caja y proveedor, activa y `last_seen_at`. El POS elige sola la de su caja (default, única de la caja, flotante única, recordada); con varias muestra el selector. Las Edges aceptan `terminal_id` y lo validan con `terminal_for_user` (negocio, activa, proveedor, sucursal del usuario y, si viene, la sucursal del POS); `device_id` suelto y la caja QR única siguen andando. La migración pasa lo existente al registro sin borrar lo viejo. Caja QR de MP por caja: `mp_qr setup` con `cash_register_id` crea sucursal y caja de MP con ids propios (`mpExternalIdsFor`).
8. **Impresoras (`printers`) y perfiles con impresora**: cada perfil por documento suma `printer_id` y `fallback_printer_id`, heredados por sucursal y caja. Resolución pura (`lib/print/printers.ts`): asignada → respaldo → compatible de la caja → de la sucursal → la del equipo, siempre informando dónde sale. Se suman los documentos comanda y remito. La salida sigue siendo web print: el registro decide papel y formato; ESC/POS directo queda para un conector local.
9. **Marca por sucursal**: logo propio opcional (`stores.logo_url`, hereda el del negocio con una sola sucursal o sin logo) en ticket, remito y display; datos del ticket por grupo o sucursal y `use_store_contact` (dirección y teléfono de la ficha de la sucursal).
10. **Políticas nuevas con `internal_scope()`** (ADR-052) y listas filtradas por el negocio actual además de la RLS.

### Alternativas descartadas

- **Una tabla de override por dominio** o **copiar la fila por sucursal**: más tablas y policies, y un cambio del negocio no llega a las sucursales (ADR-043).
- **Resolver sólo en el front**: un cajero podría cobrar con un medio apagado en su sucursal; el servidor resuelve con la caja del turno.
- **Terminal recordada en `localStorage` como fuente de verdad**: queda como respaldo de compatibilidad, no como registro.
- **Impresión directa ESC/POS ahora**: requiere un conector local por equipo; se modela el registro y la asignación para que el conector lo use cuando exista.

### Consecuencias

- Deploy en orden: migraciones `20261015100000` a `20261015130000` (más `20261015200000` y `20261015300000` de esta rama), después las Edges `mp_point`, `nave_point`, `clover_point`, `mp_qr` (e `invite_user`). Edges nuevas contra base vieja: `payment_method_blocked_at` faltante no bloquea; el POS sólo manda `terminal_id` si leyó terminales (es decir, con la migración aplicada).
- `create_sale` (desde `20261013120000`) y `close_cash_shift` (desde `20261014100000_cobros_en_espera`, firma de 4 args con `p_pending_action` y todo el manejo de cobros en espera) se recrean completos: cualquier rama que los toque tiene que partir de `20261015120000`.
- **Cobros en espera (ADR-048):** `_pc_dry_run` se recrea con el flag local `ninja.pc_dry_run` para que el pago ficticio en efectivo del ensayo no choque con "efectivo apagado en la caja". La venta del lado del servidor (`_pc_complete`) de un cobro en espera **ya pagado** no se bloquea por un medio que la sucursal apagó después de estacionar: la plata entró con un medio habilitado en ese momento y nunca se pierde un cobro hecho. Sí siguen valiendo, igual que en el ensayo, el stock por sucursal (`insufficient_stock_branch`) y el redondeo y descuento efectivos de la caja del turno: si cambian entre estacionar y cobrar y la venta falla, queda como "Cobro pagado sin venta" con aviso, como cualquier otro rechazo de `create_sale`.
- Pendiente: credenciales de proveedor por sucursal (`payment_secrets.store_id`), planes de cuotas por sucursal (F14/H59), plantilla para sucursales nuevas, editor de `pos_layout` por sucursal (hoy se pisa copiando), "Detectar lectores" desde la sección Terminales, impresión ESC/POS y monitor de terminales (H99).

---

## Próximas ADRs (placeholder)

Cuando se tomen decisiones sobre proveedor de pagos concreto por integración, motor de impresión de tickets, estrategia de backups o cualquier otra cosa estructural, se agregan acá siguiendo el template.

---

## ADR-051: Personal con estados, propiedad de la caja, PIN de supervisor por acción y auditoría del negocio (F17 · H113 a H119)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/sucursales-personal-cajas`, migraciones sin aplicar) · **Base:** ADR-045, ADR-049 (personal al invitar y `audit_logs.store_id`), ADR-052 · **Auditoría:** [`auditoria-sucursales-personal-cajas.md`](./auditoria-sucursales-personal-cajas.md)

### Contexto

El dueño pidió que cada usuario trabaje sólo en su sucursal, que el dueño cobre en cualquiera pero abriendo su caja, que nadie invada la caja de otro, estados de personal (suspensión, licencia, baja, reingreso), ver qué cajas están abiertas, configurar PIN de supervisor y auditoría, y un panel del dueño más útil. La auditoría encontró huecos P0: cualquier miembro cierra o vende en el turno de otro, `cash_movements` se escribe y borra por REST, un encargado puede degradar al dueño, el invitado no recibe el negocio activo y el PIN sólo existe para cuenta corriente.

### Decisión

1. **Estados del personal como historial con vigencias** (`staff_status_events`: `suspension`, `leave`, `termination`, `rehire`), igual que las asignaciones por sucursal: evaluación perezosa por fecha (`staff_effective_status`), sin cron, baja lógica para cancelar. Prioridad baja > suspensión > licencia. La suspensión y la licencia no tocan la membresía: cortan la operación en el servidor (`user_allowed_store_ids()` vacío, `assert_staff_operational()` en apertura de turno y en `resolve_sale_shift`, `is_tenant_manager()` falso). La baja además pasa `tenant_users.status` a `inactive` (valor nuevo), borra las sesiones del usuario y saca el negocio de `app_metadata.current_tenant_id` si era el activo, así la RLS lo deja afuera en el próximo refresh. El reingreso vuelve a `active` y restaura el negocio activo si no tiene otro. Un encargado no puede cambiar el estado del dueño ni de otro encargado; nadie se cambia a sí mismo.
2. **Propiedad de la caja en un helper, no en `create_sale`.** `assert_shift_owner(shift)` (dueño del turno o `shared_shift` para vender). `resolve_sale_shift` (que usan venta, devolución y cambio) lo exige y deja de inferir turnos ajenos; `open_cash_shift` (recreada desde `20261013120000`) exige un turno abierto por usuario y personal operativo. Guardas por trigger en `cash_shifts` (cierre sólo por el dueño del turno o con la marca de transacción que pone `cash_force_close`; sin insert ni delete desde el cliente) y en `cash_movements` (desde el cliente sólo ingreso, retiro o el contramovimiento de una anulación real del mismo turno; nunca UPDATE o DELETE). Se distingue cliente de RPC con `current_user in ('authenticated','anon')`, como en `20261012120000`. Así no se recrean `create_sale`, `close_cash_shift`, `void_sale` ni las devoluciones, que tocan otras ramas.
3. **Cierre forzado** `cash_force_close(shift, monto, motivo)`: supervisor por rol o con token de PIN, motivo obligatorio, llama a `close_cash_shift` (Z normal) con una marca de transacción y audita `cash_shift_force_closed` con el dueño del turno.
4. **PIN de supervisor general.** Misma tabla `account_supervisor_pins` (los PIN existentes siguen valiendo) con RPC nuevas sin gating de cuenta corriente. `security_settings` por negocio guarda la política: acciones con umbral, roles y usuarios supervisores, intentos, minutos de bloqueo, rotación y caja compartida. `supervisor_authorize` devuelve un token de un solo uso (acción, cajero, monto, 5 minutos). **El token viaja en el header `x-ninja-supervisor-token`** y lo consumen triggers en `sales` (descuento general sobre X % al insertar; anulación desde $Y), `sale_returns` (devolución desde $Y) y `cash_movements` (retiro e ingreso). Quien ya es supervisor actúa con su sesión. Es server-side real sin cambiar firmas de RPC.
5. **Monitor de cajas** por RPC `cash_monitor` (respeta `user_allowed_store_ids`), pantalla `/caja/monitor` y widget del panel.
6. **Auditoría:** registrar sigue siendo BASE. La lectura directa de `audit_logs` se restringe (policy RESTRICTIVE: dueño, encargado o filas propias). El visor usa `audit_log_search` gateada por `auditoria` (OPTIONAL Business), con export XLSX en el cliente.
7. **Features (CLAUDE.md §6):** `personal_estados`, `monitor_cajas` y `pin_supervisor` son BASE (`is_basic`, en todos los planes); `auditoria` (existente) pasa de MARKETING-FUTURO a OPTIONAL con gating real; `shared_shift` es FLAG-OPERATIVO.
8. **Cobros en espera (ADR-048) y caja propia.** Estacionar un cobro corre `create_sale` en seco (`_pc_dry_run`) con el usuario que estaciona: exige caja propia, personal activo y el PIN de supervisor si el descuento lo pide (el cliente manda el token al estacionar). Acreditarlo cuando el cliente paga (`_pc_complete`, recreada desde `20261014100000` en `20261017140000`) marca la transacción con `ninja.pc_complete`: `resolve_sale_shift` acepta el turno destino que elige `_pc_target_shift` aunque sea de otra persona (el de su caja o el más reciente de su sucursal) y no evalúa el estado de quien lo estacionó, y el trigger de supervisor de `sales` no vuelve a pedir PIN. La plata ya entró: la venta no puede quedar colgada por una regla de caja.
9. **`close_cash_shift` tiene una sola firma** (4 args con `p_pending_action`, de `20261014100000` y `20261015120000`). `cash_force_close(turno, monto, motivo, p_pending_action default 'carry')` la llama con 4 args: por defecto los cobros abiertos del turno forzado pasan a la próxima apertura de esa caja; con `'cancel'` se cancelan los que esperan (los pagados se acreditan igual).
10. **Invitación:** `invite_user` no pisa el rol de un miembro existente (sólo agrega o reactiva con el rol pedido si no era dueño), setea el negocio activo del invitado si no tiene, y deja el reingreso de una baja como evento. `member_admin` valida jerarquía (encargado no toca dueño ni encargados). `ensure_current_tenant()` cura al entrar a quienes tienen membresía activa sin negocio activo.

### Alternativas descartadas

- **Recrear `create_sale`, `close_cash_shift` y `void_sale` con los controles:** choca con `feat/cobros-en-espera` y `feat/sucursales-config-terminales`; los triggers y `resolve_sale_shift` cubren lo mismo.
- **`current_tenant_id()` que valide la membresía en cada policy:** es la raíz correcta para S-07 pero cambia el costo de todas las policies (no se pueden asumir initplans); queda en H118 con medición.
- **Cambiar parámetros de las RPC para mandar el token del PIN:** obliga a recrear funciones ajenas; el header es explícito, se valida en el servidor y no cambia firmas.
- **Suspensión como cambio de `tenant_users.status`:** no permite "vuelve sola el lunes" sin cron y saca al usuario de listas e historia; se usa el historial con vigencias.
- **pg_cron para vencer suspensiones y licencias:** igual que en ADR-045, la vigencia calculada al consultar es exacta y gratis.

### Consecuencias

- Migraciones `20261017100000_personal_estados`, `20261017110000_pin_supervisor_politicas`, `20261017120000_propiedad_caja`, `20261017130000_monitor_cajas_auditoria` y `20261017140000_caja_propia_cobros_en_espera` (sin aplicar). Van después de `20261014100000` (cobros en espera), `20261015*` (configuración por sucursal) y `20261016*` (compras). Orden de deploy: **front primero** (el cliente nuevo cae a la ruta vieja si una RPC no existe), después las migraciones en orden, después las Edge `invite_user` y `member_admin`.
- **Cambio de conducta:** desde el deploy nadie vende en el turno de otro. Si hoy dos personas comparten un turno, el dueño activa "Caja compartida" en Seguridad o cada uno abre su caja. Los turnos abiertos al momento del deploy siguen; sólo su dueño los opera y cierra (o un supervisor con cierre forzado).
- Un usuario con turno abierto en Centro tiene que cerrarlo para abrir otro en Norte (un turno por usuario).
- Residual S-07: un suspendido o de licencia con sesión viva todavía puede **leer** datos del negocio por API hasta H118; no puede operar caja ni vender.
- Tests: unitarios de la máquina de estados, reglas de propiedad y evaluación de políticas de PIN; RLS de propiedad del turno, cierre forzado, guardas de `cash_movements`, estados y PIN por header.

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

---

## ADR-053: Terminal integrada (posnet y pinpad conectados a la caja), base vendor-agnóstica y simulador

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/terminal-integrada-payway`; migración sin aplicar; Payway sin homologar; Fiserv y Getnet pendientes del kit) · **Hito:** F8 · H19b · **Base:** ADR-042, ADR-044, ADR-047, ADR-049, ADR-052 · **Numeración:** ADR-054 queda para la tarjeta en posnet offline.

### Contexto

El dueño: "lo que quiero es que la terminal cobre y envíe los datos al POS, ya sea posnet o pinpad", con terminales Payway clásicas (countertop o móvil) y pinpad conectado a la PC; después sumó Getnet. La Payway Smart (Android) queda fuera. Hoy la tarjeta con posnet propio se cobra en la terminal y el cajero carga el cupón a mano (Tarjeta en posnet, ADR-042). Relevamiento: [`docs/payments/terminal-integrada-payway.md`](payments/terminal-integrada-payway.md) y [`terminal-integrada-getnet.md`](payments/terminal-integrada-getnet.md). Hallazgos: el "POS Integrado" de LaPos / Payway por cable existe y lo usan otros sistemas; su protocolo (VPI PC, 19200 8N1, STX/ETX/LRC, comandos de 3 letras) sólo está descripto por fuentes públicas no oficiales; el pinpad Lane/3000 no tiene nada público; Payway tiene además una API cloud PayStore Terminals con homologación; Getnet tiene una librería con modos USB, HTTP local y Cloud2Cloud sin protocolo público; Fiserv Posnet no publica nada.

### Decisión

1. **Base vendor-agnóstica en el navegador** (`lib/payments/terminal`): `TerminalAdapter` (connect, sale, void, refund, closeBatch, status, lastTransaction opcional) que devuelve un `TerminalResult` normalizado (aprobado, autorización, lote, cupón, marca, tipo, últimos 4, cuotas, n° de comercio, código y mensaje, crudo). Transportes `ByteTransport`: **Web Serial** y **WebUSB** (Chrome / Edge de escritorio, permiso con gesto del usuario, emparejamiento guardado por PC en `localStorage`) y **Puente local NinjaPOS** (WebSocket en 127.0.0.1 con token y origen permitido; protocolo y referencia en Node en `tools/bridge`, sin binario). Framing ISO 1745 parametrizable (STX/ETX/LRC, ACK/NAK, reintentos).
2. **Adaptadores:** `SimulatorAdapter` (demos y tests, escenarios por centavos, lote y cupones, anulación, devolución, cierre y última operación); `PaywayAdapter` con el formato VPI implementado según las fuentes públicas, estado **`unverified`** (no se copió código ni se usan DLLs del fabricante; el protocolo pide el código de tarjeta, que el dueño carga desde la tabla que da Payway); `FiservPosnetAdapter` y `GetnetAdapter` **placeholders** (`pending_kit`: conexión física sí, operaciones `spec_pending`).
3. **Máquina de estados del cobro** (`charge.ts`): conectando, esperando, aprobado, rechazado, timeout, cancelado, error; reintentar nunca sobre un aprobado; el **timeout es incierto** (pudo cobrar) y una aprobación tardía se respeta; "Consultar la terminal" (última operación) para recuperar el cupón antes de reintentar.
4. **Registro por caja (extiende ADR-049):** `payment_terminals.kind` suma `posnet_integrado` y `pinpad` para las marcas `payway`, `fiserv` y `getnet`; la configuración compartida (protocolo, conexión, puerto, destino del puente, timeout, códigos de tarjeta, razón social, CUIT) va en `external_meta.integration`; lo de cada PC (dispositivo emparejado, token del puente) en el navegador. Configuración, Terminales: tipo, campos de integración y **Conectar** (emparejar, probar conexión, venta de prueba con el simulador).
5. **POS:** con una terminal integrada en la caja (o flotante de la sucursal), la hoja de cobro ofrece **"Tarjeta en terminal"** antes de "Tarjeta en posnet" (se engancha a nivel tender, `card:terminal`, sin tocar el asistente manual). Débito / crédito, cuotas con su recargo (y la marca si el protocolo la pide) y "Cobrar en la terminal": espera con cancelar, timeout y reintentar; aprobado completa `card_voucher` (lote, cupón, autorización, marca, últimos 4, cuotas, comercio, **adquirente**, `origen: "terminal"`, `terminal_tx`) y registra el pago (bloqueado en la hoja); rechazo muestra el motivo; siempre se puede pasar a la carga manual.
6. **Servidor (lo que se escribe):** bitácora `terminal_transactions` (sólo lectura por RLS con `internal_scope()` y sucursales del usuario; escritura sólo por la RPC `terminal_tx_record`: rol, terminal del usuario vía `terminal_for_user`, feature y `audit_logs`). Trigger en `payments`: un cupón con `origen: "terminal"` exige `terminal_tx` de una **venta aprobada** del mismo negocio, mismo monto, de las últimas 24 h y no usada (bloqueo `FOR UPDATE` y vínculo por un trigger `AFTER INSERT`), y pisa lote, cupón, autorización y últimos 4 con los de la bitácora; si vino del simulador, marca `simulado`. Si la bitácora no se pudo guardar, el POS registra el cobro como carga manual (la plata ya se cobró).
7. **Feature `terminal_integrada`:** OPTIONAL, grupo pagos, desde **Pro** (Pro, Business, Enterprise). Gating real en el trigger de `payment_terminals` (alta, cambio a integrada o reactivación; además la marca tiene que estar en el plan), en la RPC de bitácora y en el trigger de `payments`. Copy en `featureInfo`; la comparación de planes la deriva de la matriz.

### Alternativas descartadas

- **Usar la DLL del fabricante (`vpipc.dll`) con un agente local:** no se puede redistribuir sin permiso de Payway y ata la solución a Windows; el formato público alcanza para el navegador o el puente.
- **Cloud API (PayStore) como única vía:** no sirve para el pinpad por cable y no está confirmado para la Classic; queda como alternativa a evaluar con Payway.
- **Confiar en el cupón que manda el navegador:** el trigger lo valida contra la bitácora; un cupón "de terminal" no se puede inventar.
- **Rediseñar el asistente de Tarjeta en posnet:** otra rama lo está cambiando; la integración se suma como tender propio.

### Consecuencias

- Deploy: migración `20261018100000_terminal_integrada` (después de `20261015110000` de ADR-049 y de `20261013900000` de ADR-052). Sin Edges nuevas.
- Lo que el comercio necesita: Chrome o Edge de escritorio en https (o el puente), la terminal en modo integrado y, para Payway, los códigos de tarjeta.
- **Pendiente con los adquirentes:** especificación oficial y homologación de Payway (lista en el relevamiento), protocolo de Fiserv Posnet, librería o Cloud2Cloud de Getnet. Anulación, devolución y cierre de lote desde Ventas y la Caja quedan para cuando haya protocolo validado (el adaptador ya los tiene). Instalador del puente. Cobro de una venta aprobada cuya venta falla después queda en la bitácora sin pago (conciliable), igual que un Point.

---

## ADR-054: Posnet offline pro: adquirente, reglas del cupón y validación en el servidor

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/posnet-offline-pro`; migración `20261018300000_posnet_offline_cupon.sql` sin aplicar) · **Base:** ADR-042 (Tarjeta en posnet), ADR-044 (conciliación), ADR-049 (configuración heredable).

### Contexto

En Medios de pago, Payway Point y Getnet Point figuraban como "Próximamente" aunque el comercio ya puede cobrar con esas terminales: pasa la tarjeta en el posnet y carga el cupón en "Tarjeta en posnet". El dueño pidió (1) que la fila lo explique y lleve a configurarlo, (2) que el cajero elija primero de qué terminal (adquirente) es el cobro, con pasos que avanzan solos y el último adquirente recordado por caja, y (3) reglas por dato del cupón (pedir, obligatorio, numérico o alfanumérico, largo) con excepciones por adquirente, que no se puedan saltear. Hasta acá `require_card_voucher` sólo lo exigía la UI.

### Decisión

1. **Adquirente como primer paso** (`lib/payments/acquirers.ts`): Getnet, Payway, Mercado Pago Point, Fiserv / Clover, Nave y Otra. Se guarda en `payments.card_voucher.adquirente` (clave), con los mismos nombres de campo que las terminales integradas (`lote`, `cupon`, `autorizacion`, `marca`, `ultimos4`, `cuotas`, `comercio`, `adquirente`). El POS ofrece los de la lista configurada o, sin lista, los de las marcas con algún canal habilitado; sin ninguno, todos. Otra va siempre (salvo que la lista la excluya). El último usado se recuerda por caja en `localStorage` (`ninja.posnet.acquirer.<caja>`) y se preselecciona; un solo adquirente se elige solo.
2. **Asistente de 4 pasos con avance automático** (`lib/pos/posnetWizard.ts`): terminal, entidad, tipo y cuotas, cupón. Cada toque pasa al siguiente; se saltean los pasos sin nada que elegir (entidad de un solo tipo sin cuotas, tipo sin cuotas). La terminal elegida queda visible con "Cambiar".
3. **Usos del adquirente**: n° de comercio (`acquirerMerchantNumber`: sólo medios del adquirente, terminal primero; Otra usa la resolución de siempre), planes de cuotas (`plansForAcquirer`: los suyos y los genéricos; si no tiene propios, todos, para no perder los recargos que el negocio cargó en otro medio) y conciliación (`CardRecRow.adquirente`, filtro `acquirer` y `acquirerOptions`, columna Adquirente del XLSX; la pantalla queda para la rama que rediseña la tabla).
4. **Reglas del cupón en `pos_settings.card_voucher_rules`** (`{acquirers?, fields?, by_acquirer?}`; regla `{ask, required, type, min, max}`, largo 1 a 20, igual = exacto). Base = lo que pedía el POS (lote, cupón y autorización opcionales y alfanuméricos; últimos 4 opcional, 4 dígitos; comercio y cuotas no se tipean: salen de Medios de pago y del plan). Valores sugeridos por adquirente aplicables con un botón (no se aplican solos). Forma validada en SQL (`card_voucher_rules_error`, CHECK de la columna y `config_field_error`) con espejo en `rulesShapeError`.
5. **Herencia por sucursal y caja con la capa existente** (ADR-049): `card_voucher_rules` entra a la whitelist de `pos_settings` como `map_any` en todos los alcances (también caja: el posnet es de la caja). Se pisa por clave de primer nivel (`acquirers`, `fields`, `by_acquirer`). `config_field_type` y `config_field_error` se recrean idénticos + el campo.
6. **Compatibilidad con `require_card_voucher` (H27)**: prendido, cupón, lote y autorización se piden y son obligatorios siempre (piso de las reglas). Ahora también lo exige el servidor.
7. **Validación en el servidor sin tocar `create_sale`**: trigger `payments_card_voucher` (BEFORE INSERT en `payments`) para débito y crédito con monto positivo. Saltea el ensayo de cobros en espera (`ninja.pc_dry_run`), los cobros integrados (referencia que coincide con un intent de `mp_payment_intents`, como el trigger de sucursal) y la diferencia de un cambio (devolución a crédito creada en la misma transacción, `sale_returns.created_at = now()`, porque la pantalla de cambios no carga cupón). Resuelve las reglas efectivas con la sucursal y caja del turno (`_effective_config`) y rechaza `card_voucher_required: <dato>` o `card_voucher_invalid: <dato>` (formato, largo o adquirente desconocido). Camino barato: sin reglas ni voucher obligatorio en el negocio ni en overrides, no consulta nada más. El POS valida lo mismo antes (espejo puro en `lib/payments/voucherRules.ts`) y traduce el error del servidor.
8. **Carga rápida**: teclado numérico en los datos numéricos, limpieza al tipear (numérico: sólo dígitos; alfanumérico: letras y números en mayúscula), salto al siguiente al completar el largo exacto o el máximo, Enter pasa al siguiente y en el último registra, validación en línea al salir del campo. La terminal de la marca sin integrar (Payway Point manual) usa las mismas reglas con su adquirente y muestra sólo los datos obligatorios.
9. **Configuración**: sección nueva "Tarjeta en posnet" (`?seccion=posnet`) con terminales que usa el negocio y la tabla de reglas (General y una pestaña por terminal, "Usar sugeridos", "Usar la general"), con selector de alcance negocio / grupo / sucursal / caja. En Medios de pago, Payway y Getnet "Terminal en el mostrador" pasan de "Próximamente" a "Disponible sin integrar" con el paso a paso, "Configurar datos del cupón" e "Integración directa en desarrollo" como dato secundario.

### Plan y gating

No es una feature de plan nueva: es parte de Tarjeta en posnet (BASE, ADR-042). Sin cambios en `features`, `plans.limits.modules`, `featureInfo` ni la comparación de planes.

### Alternativas descartadas

- **Validar dentro de `create_sale`**: obliga a recrear la función entera (recreada en `20261015120000`) y no cubre otros caminos de escritura; el trigger alcanza a todos.
- **Aplicar los valores sugeridos por defecto**: rompería cobros de negocios cuyas terminales imprimen otro formato; quedan como botón.
- **Tabla propia de reglas**: la capa de overrides ya resuelve herencia, auditoría y permisos.
- **Recordar el adquirente en el servidor**: es una preferencia del equipo de la caja; `localStorage` alcanza y no suma escrituras.

### Consecuencias

- Deploy: aplicar `20261018300000_posnet_offline_cupon.sql` después de `20261015100000` y `20261015120000` (usa `_effective_config`). El front nuevo funciona contra la base vieja (sin columna, `parseRules` devuelve `{}` y el POS pide lo de siempre); guardar reglas requiere la migración.
- Negocios con `require_card_voucher` prendido: desde la migración el servidor rechaza débito o crédito manual sin cupón, lote y autorización, o con caracteres que no sean letras y números (antes texto libre). El POS ya los exigía y ahora limpia lo tipeado.
- Límite conocido: un cambio con diferencia en tarjeta no valida el cupón (la pantalla de cambios no lo pide). Un pago con referencia de intent existente se toma como integrado.
- Terminal integrada (ADR-053): sus pagos traen `card_voucher.origen = 'terminal'` y `terminal_tx`; `payments_card_voucher` los saltea porque `payments_terminal_tx` (`20261018100000`) ya los valida contra `terminal_transactions`. Comparten los nombres del cupón (`lote`, `cupon`, `autorizacion`, `marca`, `ultimos4`, `cuotas`, `comercio`, `adquirente`) y las claves de adquirente (`payway`, `getnet`, `fiserv`: el POS traduce el `provider_key` de la terminal con `acquirerOfProvider`). La Conciliación nueva suma el filtro Adquirente cuando algún cobro lo trae.

---


---

## ADR-055: Cuentas para cobrar por transferencia, catálogo de bancos y pantalla de transferencia

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/transferencias-bancos`, migración sin aplicar) · **Base:** ADR-049 (herencia), ADR-052 (`internal_scope`)

### Contexto

El dueño pidió poder configurar en Transferencia el banco, el CBU, el alias y demás datos "para que se muestren en pantalla", con los logos de todas las entidades (las de Mercado Pago y el resto de bancos y billeteras de Argentina), la opción de subir un logo propio, y poder elegir si se muestra la pantalla para que el cliente transfiera o se cierra el ticket directo. Hasta acá la transferencia era un medio "directo" sin datos: se registraba tal cual.

### Decisión

1. **Catálogo estático de entidades** (`lib/payments/banks.ts`): slug, nombre, tipo (banco, billetera, fintech, cripto), códigos de entidad del BCRA (3 primeros dígitos del CBU), código de proveedor de CVU (dígitos 4 a 7) cuando hay fuente, alias de búsqueda y logos en `public/images/banks` (isotipo cuadrado y horizontal, WebP transparente, variante `-on-dark` cuando la marca es oscura). Sin logo oficial disponible, monograma neutro marcado `fallback` (nunca un logo inventado). Un código pertenece a una sola entidad (Cuenta DNI usa el de Provincia).
2. **`transfer_accounts` por negocio** con RLS (lectura del negocio, escritura owner/manager, baja lógica) y un guard que normaliza y valida CBU / CVU (dos dígitos verificadores), CUIT y alias, ata el logo propio a la carpeta del negocio y deja una sola cuenta por defecto. "Otra" entidad sube su logo al bucket `transfer-logos/<tenant>/` (png, jpeg o webp, sin SVG por seguridad).
3. **Herencia por sucursal y caja con ADR-049**, no una tabla nueva: campos del medio `transfer` en la whitelist. Grupo y sucursal eligen qué cuentas se muestran (mapa id → visible, se mezcla por clave) y la por defecto; la caja sólo muestra u omite la pantalla. La base del negocio vive en `tenant_payment_methods.config` y se guarda por RPC auditada.
4. **Pantalla de transferencia en la hoja de cobro** (y en la pantalla del cliente por el canal de siempre): cuenta (selector si hay varias), titular, CUIT, CBU / CVU y alias con copiar, monto, n° de operación y "Ya transfirió". Apagada, la transferencia cierra el ticket directo como antes. En la pantalla del cliente el QR lleva el alias (o el CBU) como texto para copiarlo desde la cámara: no existe un QR de transferencia interoperable a partir de un alias sin ser PSP, así que no se promete pago por QR.
5. **Conciliación en el servidor:** un trigger en `payments` guarda en `metadata.transfer` la cuenta elegida (o la por defecto de la sucursal de la venta) con un snapshot. La cuenta viaja en `card_voucher.transfer_account_id` porque `create_sale` pasa ese jsonb tal cual: así no se recrea `create_sale` (función larga que otras ramas tocan, ver ADR-049) y el trigger limpia `card_voucher`. Una cuenta oculta en la sucursal se rechaza.
6. **N° de operación obligatorio** exigido por el servidor cuando el pago viene del POS (marca `transfer_pos`). La diferencia de un cambio (`exchange_sale`) no lo pide: su pantalla no tiene el campo.
7. **Plan (CLAUDE.md §6):** una cuenta, la pantalla y el logo propio son **BASE** (parte de `transferencia`). Más de una cuenta activa y elegir cuentas por sucursal es **OPTIONAL** `transferencia_multicuenta` (Pro, Business y Enterprise), gateado en el guard de `transfer_accounts`, en el trigger de `config_overrides` y en la resolución (sin la feature sólo vale la cuenta por defecto). Copy en `featureInfo.ts`; la comparación de planes la toma de la matriz.

### Alternativas descartadas

- **Guardar CBU y alias en `tenant_payment_methods.config`:** una sola cuenta, sin RLS propia ni auditoría por cuenta.
- **Recrear `create_sale` para leer la cuenta:** choca con las ramas que la recrean; el trigger es independiente del orden de deploy.
- **Hotlink a logos de terceros:** dependencia externa y riesgo de cambio; se guardan normalizados en el repo.

### Consecuencias

- Deploy: migración `20261018400000_transferencias_cuentas` después de `20261015100000` (ADR-049) y de `20261016100100` (usa `cuit_is_valid`, que se recrea igual). Front antes o después: sin la migración la hoja de cobro no recibe cuentas (la lista falla y la transferencia se registra como siempre, sin marca).
- Pendiente: mostrar la cuenta y el n° de operación en el ticket, el detalle de la venta y un reporte de conciliación de transferencias; avisar la recepción automática si el banco o billetera ofrece API (fuera de alcance).

---

## ADR-056: Precio autoritativo en el servidor, cambio de precio con PIN e historial de precios (F18 · H100 P0)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/precio-servidor`, migraciones sin aplicar) · **Base:** ADR-043, ADR-045, ADR-048, ADR-049, ADR-051, ADR-052 · **Auditoría:** [`auditoria-fiscal-contable-precios.md`](./auditoria-fiscal-contable-precios.md) §1.2 · **Numeración:** ADR-053 a ADR-055 reservadas por otras ramas.

### Contexto

`create_sale` aceptaba el `unit_price` que mandaba el navegador. El tope de descuento por rol se controlaba, pero un precio unitario alterado (o una cantidad negativa usada como descuento escondido) no. Para un auditor es una debilidad de control interno y bloquea F3: no se puede facturar con CAE un precio que nadie validó. Además no había historial de precios consultable.

### Decisión

1. **El servidor calcula el precio.** `_resolve_unit_price(tenant, producto, variante, cantidad, cliente, sucursal, lista, fecha)` es el espejo SQL de `lib/prices/resolve.ts`: ítem de lista por variante, ítem por producto, `adjustment_pct` de la lista, base (`price_override` de la variante o precio del producto). La lista es la pedida o la activa del canal `mostrador`, igual que el POS hoy. Cantidad, cliente, sucursal y fecha quedan en la firma para escalas, listas por cliente o sucursal y vigencias (resto de H100), sin cambiarla después. Wrapper `resolve_unit_price` para el usuario (sólo su negocio o staff interno con scope). Los modificadores suman el `price_delta` del catálogo (`_sale_modifier_delta`), nunca el del navegador.
2. **`create_sale` recreada** desde su última definición (`20261015120000`: configuración efectiva, stock por sucursal, turno de la caja; `20261017*` no la recrea). Antes de calcular el subtotal valida cada línea: con producto, `|unit_price - esperado| <= 0,01` o error `price_mismatch:{"items":[{product_id, variant_id, expected, received}]}` con todas las líneas que no cierran; cantidad > 0, precio y descuento de línea >= 0. Se aceptan además el regalo de una promo a $0 (`gift_promo_id` de una promo del negocio), la línea cubierta por una sesión de pack a $0 (`pack_credit_id` presente en los extras `pack_session`) y el precio guardado en el ítem de la mesa o el delivery que se cobra. `sale_items` guarda `list_price` y `price_override_reason`.
3. **Ítems sin producto.** Se descuentan contra lo que ya tiene explicación: recargo y garantía (extras `surcharge` y `warranty`, mismo monto), packs vendidos (precio de `service_packs`) e ítems libres de la mesa o el delivery. Lo que sobra es **venta libre**: exige `allow_free_sale` efectivo de la sucursal y la caja (default true) y respeta un tope opcional por rol y por venta `max_free_sale` (mapa rol a $, pisable por grupo y sucursal). El botón sigue siendo de dueño y encargado en la UI; el servidor no lo restringe por rol porque los turnos de agenda y la recompra entran como monto y los cobra el cajero.
4. **Cambio manual de precio.** La línea viaja con `price_override: true` y `override_reason` (mínimo 3 caracteres). Lo puede hacer un supervisor (roles y usuarios de Seguridad, ADR-051) o cualquiera con PIN de la acción nueva **`cambio_precio`**, con umbral en % de desvío contra el precio de lista y **encendida por defecto** (hoy el POS no cambiaba precios, así que no cambia ningún flujo). Con la política apagada, el cambio pasa y queda registrado. Se audita `price_override` en `audit_logs` con las líneas, el desvío, el motivo y quién autorizó.
5. **Varios PIN en una venta.** El header `x-ninja-supervisor-token` acepta tokens separados por coma; `require_supervisor` usa el de su acción y, si vino alguno pero no el de esa acción, contesta `supervisor_required:<acción>` (no "token inválido"). `withSupervisor` reintenta una vez por acción acumulando tokens. Así una venta con precio cambiado y descuento sobre el tope pide los dos PIN.
6. **Cobro en espera (ADR-048).** Estacionar corre `_pc_dry_run`, que pasa por esta misma validación con el token del header: el precio se valida al estacionar. Acreditar (`_pc_complete`, marca `ninja.pc_complete`) **no revalida**: usa el snapshot guardado. La plata ya entró y un cambio de lista posterior no puede dejar la venta colgada; el recargo de cuotas que agrega `_pc_complete` tampoco es venta libre.
7. **Mesas y delivery.** Trigger `trg_order_item_price` en `table_order_items` y `delivery_order_items` (alta y cambio de precio, producto o modificadores): misma regla que la venta y venta libre según el flag. Cierra la escritura directa por REST que permitía la policy "for all". Al cobrar, vale el precio guardado en el pedido.
8. **POS.** Ante `price_mismatch` el POS reprecia las líneas con el precio del servidor, refresca productos y listas y avisa "El precio de X cambió a $Y"; no reintenta solo porque el total cambió. Acción "Cambiar precio" en la línea abierta del carrito, con motivo; la línea muestra "Precio manual" y el precio de lista.
9. **Historial de precios.** `product_price_history` (producto, variante, lista, precio anterior y nuevo, quién, origen `manual`, `import`, `bulk` o `list`, cuándo) por triggers en `products.price`, `product_variants.price_override` y `price_list_items` (alta, cambio y baja). El origen sale de `ninja.price_source` (RPC futuras) o del header `x-ninja-price-source` (el import de productos manda `import`). RLS de lectura `tenant_id = current_tenant_id()` con la feature, o `internal_scope()` (ADR-052); sin escritura desde el cliente. Pestaña "Historial de precios" en la ficha con gráfico escalonado (ECharts) y la lista.
10. **Features (CLAUDE.md §6).** La validación del precio es control interno, no una feature: no se puede apagar. `historial_precios` es BASE (`is_basic`, en todos los planes; gatea la consulta, el registro corre siempre). `cambio_precio` es una acción de `pin_supervisor` (BASE). `max_free_sale` es FLAG-OPERATIVO.

### Alternativas descartadas

- **Registrar la diferencia como descuento o recargo en vez de rechazar** (lo que proponía la auditoría): esconde el error de un POS desactualizado y mezcla precio con descuento en los reportes y en F3. Se rechaza con el precio esperado y el cambio intencional va marcado y autorizado.
- **Recalcular el precio en la acreditación del cobro en espera:** un cambio de lista entre el pago y la acreditación dejaría la venta pagada sin registrar.
- **Permiso de cambio de precio como columna nueva por rol:** duplica a los supervisores de Seguridad; el que autoriza descuentos y anulaciones es el que autoriza precios.
- **Validar la garantía y el recargo contra sus planes:** se mantiene la confianza de hoy (monto del extra); queda para H107 con los planes de cuotas.

### Consecuencias

- Migraciones `20261019100000_precio_servidor` y `20261019110000_historial_precios` (sin aplicar), después de `20261017140000`. Orden de deploy: **front primero** (el POS nuevo manda las marcas y entiende `price_mismatch`; el servidor viejo las ignora), después las migraciones en orden.
- **Cambio de conducta:** un POS con precios viejos en caché recibe `price_mismatch` y reprecia. Una venta a otro precio exige "Cambiar precio" con motivo (y PIN si no es supervisor). Una cantidad negativa ya no pasa. El ítem de mesa o delivery con precio distinto al de lista se rechaza al cargarlo.
- Fuera de alcance: `exchange_sale` (cambios) sigue tomando el precio del cliente para lo nuevo; el cambio del % de una lista no se expande en el historial (queda en `audit_logs`); promos y garantía siguen calculadas en el POS.
- Tests: unitarios del parseo y repreciado, del carrito, del mapeo a `create_sale`, de la política y de los tokens acumulados; integración (Supabase local) de precio alterado, lista aplicada, cambio con PIN, venta libre, cobro en espera y RLS del historial; recorrido en PGlite sobre la cadena completa de migraciones.

---

## ADR-057: Credenciales y planes por sucursal, plantilla de sucursal, clientes, comparativo y monitor de sucursales (F17 · H89, H93, H96, H97, H99)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/f17-resto`, migraciones `20261020100000` a `20261020150000` sin aplicar, Edges sin desplegar) · **Base:** ADR-043, ADR-045, ADR-049, ADR-051, ADR-052 · **Numeración:** ADR-053 a ADR-056 quedan para otras ramas.

### Contexto

Quedaban pendientes de F17 (ADR-049 y ADR-051): credenciales de proveedor por sucursal (GO Cuotas "API Key de la sucursal", Nave `pos_id`, Payway o Fiserv con un n° de comercio por local, una cuenta de Mercado Pago por franquicia), planes de cuotas por sucursal, plantilla para sucursales nuevas, reportes consolidados y comparativos, clientes por sucursal y un monitor de sucursales. Napse resuelve cada cosa con pantallas separadas y copias de configuración; acá todo hereda del negocio y la sucursal sólo pisa lo que cambia.

### Decisión

1. **Credenciales: `payment_secrets.store_id` (null = del negocio).** Las filas existentes quedan como default del negocio sin tocarlas. La PK pasa a `id` y la unicidad a `(tenant_id, provider_key, store_id) NULLS NOT DISTINCT` (sirve como target de `onConflict` de PostgREST para las dos clases de fila). Resolución en las Edges (`_shared/paymentSecrets.ts`): sucursal del cobro → negocio; la sucursal sale de la terminal validada si hay, si no del `store_id` del body (el POS manda su sucursal en cada cobro). El intent guarda `secret_store_id` y status, cancel, poll y webhooks usan **esa** credencial (si se borró, la del negocio), así un cambio de credencial no deja cobros sin verificar. `set_payment_secret` valida el alcance con `payment_secret_scope_check` (dueño o encargado activo, acceso a la sucursal y `multi_sucursal`); una credencial de sucursal no marca "conectado" al negocio. OAuth de Mercado Pago por sucursal: la sucursal viaja en el `state` (fila de un solo uso creada por `mp_oauth_start`, no se puede forjar). El ambiente (prueba o producción) sigue siendo del negocio. La UI usa `payment_secret_scopes()` (sin valores) y el selector `ScopeBar` de ADR-049 en el asistente de conexión.
2. **Planes: `payment_plans.store_id` con herencia por `(medio, code)`.** Una fila de sucursal pisa al plan del negocio con la misma combinación (base, marca y cuotas); inactiva lo oculta en esa sucursal; lo que no pisa, lo hereda. Sin `multi_sucursal` no se aplican (no se borran). Gating real: policies RESTRICTIVE en insert y update (`multi_sucursal` y `user_can_access_store`). El POS cobra con los planes efectivos de su sucursal (`lib/payments/planScope.ts`, espejo de `effective_payment_plans`). El recargo único y el n° de comercio por sucursal siguen en `config_overrides` (ADR-049). La conciliación no cambia.
3. **Plantilla de sucursal.** Al crear una sucursal: "Heredar todo del negocio" (recomendado), "Copiar de otra sucursal" o "Usar una plantilla", eligiendo partes (operación y ticket, medios de pago, impresoras con sus perfiles, planes propios y, sólo desde una sucursal, personal como acceso adicional con su rol). `store_templates` guarda una foto (no un vínculo: cambiar la sucursal después no cambia la plantilla). Todo pasa por `config_override_set` (whitelist, tipos, gating antes de la herencia y auditoría por campo) y `staff_branch_schedule`; los perfiles de impresión se remapean a las impresoras copiadas. **Nunca se copian terminales ni credenciales**: son de cada local.
4. **Reportes: Consolidado / Por sucursal / Comparar.** Consolidado y por sucursal reutilizan las RPC con `p_store_id` (20261015200000) y el chip de sucursal. Comparar usa `branch_compare_report` (acceso por sucursal; comparar más de una exige `multi_sucursal`): tabla lado a lado con la mejor marcada, gráficos ECharts y XLSX con una hoja por sucursal más el consolidado. El margen usa el costo actual del producto (no hay costo histórico por línea) e informa su cobertura.
5. **Clientes por sucursal.** El cliente sigue siendo del negocio (RLS sin cambios). `customers.store_id_alta` lo completa un trigger con la sucursal actual del usuario (turno abierto → asignación vigente → única permitida → principal); la enviada por el cliente sólo se respeta si es del negocio y el usuario la puede operar. Historial filtrable por sucursal y estadísticas por sucursal (`customer_branch_stats`); el comparativo suma clientes nuevos, compradores y recurrentes por sucursal.
6. **Monitor de sucursales.** `branch_monitor_overview()` devuelve hechos por sucursal; las alertas (caja abierta hace más de N horas, sucursal sin caja en horario, cobros pagados sin venta, terminal sin señal en horario, diferencia de Z sobre la tolerancia efectiva, faltantes) se calculan en `lib/branches/monitorAlerts.ts` con umbrales por equipo. BASE dentro de `monitor_cajas` (es lo mismo que el dueño ya ve en otras pantallas, junto); el heartbeat por equipo y `monitoreo_sucursales` (Enterprise) siguen en H99.
7. **Features (CLAUDE.md §6):** sin keys nuevas. Credenciales, planes, plantilla y comparar son parte de `multi_sucursal` (OPTIONAL, Business) con gating server-side; sucursal de alta y estadísticas del cliente son BASE; la vista de sucursales del monitor es BASE (`monitor_cajas`). Se actualiza la copy de `multi_sucursal` en `featureInfo.ts`.
8. **Compatibilidad.** Front y Edges funcionan contra una base sin las migraciones (cada consulta con alcance cae a la de siempre). No se tocan `create_sale`, `close_cash_shift` ni `_pc_complete`.

### Alternativas descartadas

- **Tabla aparte para credenciales de sucursal:** más simple de desplegar, pero duplica la lectura en cada Edge y no permite una sola regla de unicidad; se eligió la columna con la PK nueva y Edges tolerantes.
- **Code de plan con sufijo de sucursal** (para no tocar el índice único): ensucia los datos y el import XLSX; se cambió el índice a NULLS NOT DISTINCT.
- **Plantilla como vínculo vivo** (la sucursal sigue a la plantilla): ya existe la herencia negocio ← grupo ← sucursal (ADR-049) para eso; la plantilla es una foto para arrancar.
- **Copiar credenciales o terminales con la plantilla:** una credencial o un Point de otro local cobraría en la cuenta equivocada.
- **Alertas del monitor en SQL:** los umbrales son por pantalla y equipo, y se testean mejor como función pura.

### Consecuencias

- **Deploy en orden:** front (tolera la base vieja) → migraciones `20261020100000` a `20261020150000` → **en seguida** las Edges `set_payment_secret` y `mp_oauth_callback` (las versiones viejas hacen upsert con `onConflict "tenant_id,provider_key"`, que deja de existir con la PK nueva) → el resto de las Edges de cobro: `mp_oauth_start`, `mp_qr`, `mp_point`, `mp_create_qr`, `mp_webhook`, `mp_orders_webhook`, `nave`, `nave_point`, `nave_webhook`, `gocuotas`, `gocuotas_webhook`, `directo`, `directo_webhook`, `clover_point`, `clover_webhook`, `getnet`, `getnet_webhook`, `mobbex_create_qr`, `mobbex_webhook`, `modo_create_qr`, `modo_webhook`, `payway`, `payway_checkout`, `payway_webhook`, `pagos360`, `pending_charges_sync`. Hasta desplegarlas, nadie debería cargar credenciales de sucursal (una Edge vieja con `maybeSingle()` falla si hay dos filas del mismo proveedor).
- El editor de planes guarda con `onConflict "tenant_id,provider_key,code,store_id"`; contra la base vieja cae al target anterior.
- El backfill de `customers.store_id_alta` recorre los clientes una vez (sin tocar `updated_at`).
- Riesgos: el margen comparativo usa el costo actual; un negocio con muchos productos sin costo verá una cobertura baja (se informa). La plantilla no guarda `pos_layout` por sucursal si no estaba pisado (igual que la copia de ADR-049).
- Tests: unitarios de herencia de credenciales y planes, plan de copia, comparativo y alertas; RLS `tests/integration/rls-f17-resto.test.ts`; `deno check` de las Edges tocadas; cadena completa de migraciones sobre PGlite con un recorrido de humo.

---

## ADR-059: Compras v2: devoluciones a proveedor, anulación de recepciones, órdenes de pago, tesorería básica, consumo por lote y listas del proveedor (F18 · H101, H102, H106, H111)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/compras-v2` sobre `integ/tanda-h`, migraciones `20261022100000` a `20261022100500` sin aplicar) · **Base:** ADR-046, ADR-050, ADR-051, ADR-052, ADR-055 · **Numeración:** ADR-058 queda para otra rama.

### Contexto

Compras v1 (ADR-050) dejó pendientes: devoluciones al proveedor, recepciones inmutables, pagos sin aplicación a comprobantes ni integración con caja o bancos, lotes sin consumo y sin trazabilidad hasta la venta, e importación de la lista del proveedor. La auditoría fiscal (H101, H102, H106, H111) pide órdenes de pago con retenciones y certificado, tesorería con cheques y conciliación, n° de despacho disponible en la venta y costos de reposición desde la lista. Restricción: no tocar `create_sale`, `close_cash_shift`, `_pc_complete` ni el resolutor de precios (otras ramas).

### Decisión

1. **Devoluciones a proveedor** (`purchase_returns` + `purchase_return_items`, numeración `DEV-`): desde una recepción (hasta lo recibido menos lo devuelto, al `valued_unit_cost` de la línea, incluido el costeo de importación) o libres (producto, sucursal y costo; por defecto el promedio). Dueño o encargado. Cada línea saca stock de la sucursal (movimiento `purchase_return`, exige saldo en la sucursal), descuenta del lote de la línea o, si no, por vencimiento y antigüedad, y recalcula el promedio. **Regla de costo:** `promedio nuevo = (S × P − q × c) / (S − q)`; sin stock remanente no cambia; nunca negativo; el último costo no cambia (es el último precio de compra). **Crédito:** la NC del proveedor, cargada con la devolución (pasa por `supplier_invoice_save`) o vinculada después; sin NC la devolución queda "NC pendiente" y no toca la cuenta corriente (el crédito fiscal y el importe los fija el comprobante del proveedor, no el costo interno).
2. **Anulación de recepciones** (`purchase_receipt_void`, dueño o encargado, motivo obligatorio): sólo sin factura vinculada, sin devoluciones, con lotes sin consumir y con stock en la sucursal (si no, corresponde una devolución o un ajuste). Revierte stock (`purchase_void`), promedio con la misma fórmula al costo valuado, último costo (si era la recepción más reciente vuelve a la vigente anterior o al valor previo de `product_cost_history`), último costo del proveedor, cantidades y estado de la OC (enviada, recibida en parte o recibida) y da de baja los lotes. La recepción queda `voided` y un guard impide cualquier cambio posterior (costeo, factura).
3. **Órdenes de pago** = `supplier_payments` con `kind = 'order'` (misma numeración `OP-` y misma cuenta corriente) + `supplier_payment_lines` (medios) + `supplier_payment_allocations` (imputación en pesos a facturas y ND vigentes; nunca más que el saldo abierto ni que el total; lo no imputado queda a cuenta). Medios: **efectivo de la caja propia** (retiro `expense` en el turno abierto de quien paga con `assert_shift_owner(.., 'cash_out')`, `assert_staff_operational` y el PIN de retiro de ADR-051; usa el tipo `expense` para que el arqueo de `close_cash_shift` lo cuente sin recrearlo), transferencia o depósito desde una cuenta de tesorería (o sólo con referencia, como v1), cheque o e-cheq propio (nace `entregado` contra una cuenta bancaria), cheque de terceros en cartera (se endosa), tarjeta u otro. Retenciones de IVA, Ganancias, IIBB y SUSS con n° de certificado en el jsonb existente (placeholder hasta H106). Orden de pago imprimible con importe en letras. **Anulación** (`supplier_payment_void` recreada): libera la imputación, devuelve el efectivo a la caja propia abierta de quien anula (ingreso), revierte movimientos de tesorería, vuelve a cartera los cheques de terceros y anula los propios; un cheque ya depositado o rechazado la bloquea. El aging usa la imputación explícita y aplica FIFO sólo al crédito sin imputar.
4. **Tesorería básica** (OPTIONAL `tesoreria`): `treasury_accounts` (caja general o banco, saldo inicial, sucursal opcional), `treasury_movements` (importe con signo, conciliación manual con referencia del extracto, anulación lógica de los manuales no conciliados), transferencias entre cuentas, vista `treasury_balances` (saldo y saldo conciliado), `cheques` con máquina de estados (`en_cartera → entregado | depositado | rechazado`, `entregado → depositado | rechazado | en_cartera (terceros, anulación de OP) | anulado (propio)`, `depositado → rechazado`): depositar suma, debitar un propio resta y rechazar uno depositado revierte. Flujo de fondos proyectado (día, semana o mes, 30 a 90 días) con el saldo de tesorería, comprobantes de proveedor abiertos (aging con imputación), cuenta corriente de clientes (`treasury_receivables`) y cheques; lo vencido cae en el primer período. **Unificación con `transfer_accounts` (ADR-055, `feat/transferencias-bancos`):** esa tabla no está en esta base; `treasury_accounts.transfer_account_id` (sin FK) queda para que, cuando convivan, una cuenta bancaria de tesorería apunte a la cuenta de cobro por transferencia; una migración posterior agrega la FK, la sugiere al crear cuentas y lleva los cobros por transferencia a movimientos de tesorería.
5. **Consumo por lote y n° de despacho** sin tocar `create_sale`: trigger AFTER INSERT en `stock_movements` (la venta ya inserta un `sale` por línea y componente con la sucursal del turno). Consume los lotes con saldo de esa sucursal por vencimiento (FEFO) y, sin vencimiento o empatados, por ingreso (FIFO); lo que no alcanza queda "sin lote" (nunca bloquea). `sale_void` y `return` devuelven lo de esa venta (primero lo sin lote, después del último lote consumido). Libro `lot_allocations` y vista `lot_sales` (qué ventas se llevó cada lote y su n° de despacho). Sólo trabaja con productos que tienen lotes (un `exists` por movimiento para el resto). Backfill de `qty_available` repartiendo el stock de la sucursal del lote más nuevo al más viejo.
6. **Listas de precios del proveedor:** el cliente lee el XLSX, el usuario mapea columnas (sugerencia por encabezado, mapeo guardado por proveedor), cruza por código del proveedor o por SKU y código de barras, aplica la bonificación y muestra la vista previa con la variación en %. `supplier_price_list_apply` actualiza `list_cost` (y código, moneda y unidades por bulto), vincula productos nuevos si se pide y opcionalmente pasa el costo a `replacement_cost` (lista × TC ÷ unidades por bulto) con historia `supplier_list`; registro en `supplier_price_list_imports` y auditoría.
7. **Features (CLAUDE.md §6):** `compras` (OPTIONAL Pro) se extiende con devoluciones, anulación, órdenes de pago con efectivo y transferencia por referencia, lotes y listas (gating en `purchase_assert`). `tesoreria` nueva OPTIONAL Business+, requiere `compras`: gating en `treasury_assert` (todas las RPC de tesorería), en la policy de `treasury_accounts` y en las líneas de OP que mueven una cuenta o un cheque. Copy en `featureInfo.ts`; la comparación de planes deriva de la matriz.

### Alternativas descartadas

- **Asignar lotes dentro de `create_sale`:** la tocan otras ramas; el trigger sobre el libro de movimientos cubre ventas, kits, anulaciones y devoluciones sin cambiar firmas.
- **Crédito automático de la devolución en la cuenta corriente al costo:** el importe y el IVA los fija la NC del proveedor; acreditar al costo interno duplicaría o desfasaría la cuenta cuando llega la NC.
- **Tipo nuevo de `cash_movements` para la OP en efectivo:** `close_cash_shift` sólo cuenta `income`, `expense`, `sale` y `sale_void`; un tipo nuevo descuadraría el arqueo sin recrearla.
- **Tabla nueva de órdenes de pago separada de `supplier_payments`:** obligaba a cambiar la cuenta corriente, el aging y la numeración; la OP es un pago con medios e imputación.
- **Revertir automáticamente la OP al rechazarse un cheque entregado:** queda manual (ND del proveedor o anulación de la OP) porque el rechazo puede llegar con la deuda ya renegociada.

### Consecuencias

- **Deploy:** migraciones `20261022100000` a `20261022100500` en orden, después de las de ADR-050, ADR-051 y ADR-056. Front primero o junto (las pantallas nuevas fallan con mensaje si la RPC no existe). Backfill liviano de `product_lots.qty_available`.
- **Recrea** `purchase_log` (suma `return`) y `supplier_payment_void` (reversas). No toca `create_sale`, `close_cash_shift`, `_pc_complete` ni el resolutor de precios.
- **Riesgos:** lotes recibidos antes del deploy parten de un saldo estimado; los traslados no mueven lotes (lo que se vende en otra sucursal sale "sin lote"); un costeo aplicado sobre una línea sin lote crea el lote con todo su saldo aunque parte ya se haya vendido; ventas con dos líneas del mismo producto asignan la línea por la primera coincidencia; las OP son en pesos (los pagos en moneda extranjera siguen por el pago simple de v1); el flujo de fondos no incluye ventas futuras ni gastos fijos.
- **Pendiente:** cálculo de retenciones como agente y certificado PDF (H106), conciliación bancaria por extracto importado (H110), caja fuerte por sucursal y rendiciones (H111), anulación de devoluciones, n° de despacho impreso en la factura de venta (F3/H107), lotes en traslados, diferencia de cambio (H109), unificación con `transfer_accounts`.
- **Tests:** unitarios de imputación y totales de OP, máquina de estados de cheques, reglas de costo al sacar unidades y último costo al anular, asignación FEFO/FIFO y devolución a lotes, lista de precios y flujo de fondos; RLS `tests/integration/rls-compras-v2.test.ts`; cadena completa de migraciones sobre PGlite con recorrido de humo (lotes con venta y anulación reales, devolución, anulación, OP con caja, banco y cheques, cheques, lista).

---

## ADR-060: PIN autenticador: rotativo, de un uso y app TOTP para autorizar como supervisor

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/pin-autenticador`, migración `20261023100000_pin_autenticador.sql` sin aplicar) · **Base:** ADR-051 (PIN por acción, `supervisor_auth_tokens`, `require_supervisor()`), ADR-052 (`internal_scope`), ADR-056 (varios tokens por request) · **Numeración:** ADR-058 y ADR-059 quedan para otras ramas.

### Contexto

Pedido del dueño: "El PIN puede ser fijo, pero lo ideal sería que los usuarios que elija y el dueño tengan una sección de PINes donde se generen aleatoriamente como un autenticador, y sea ese el que tenga que pasar al empleado para autorizar; pueden ser PINes que cambian cada 12 horas, 24 hs, o PINes aleatorios que duren 5 minutos o menos". Un PIN fijo de 4 a 6 números termina conocido en el local; el supervisor que no está en la caja necesita pasar algo que se venza solo.

### Decisión

1. **Cuatro modos, un solo campo.** El diálogo global de PIN (`withSupervisor()` + `SupervisorPinHost`) no cambia de flujo: el cajero elige al supervisor y escribe el código. `supervisor_authorize()` (misma firma) detecta el modo en este orden: PIN de un uso, app autenticadora, rotativo, fijo. El token resultante (5 minutos, atado a acción, cajero y monto) y su consumo en los triggers por `require_supervisor()` no cambian; el token guarda `auth_mode`.
2. **Rotativo.** 6 dígitos `HOTP(HMAC-SHA256, secreto de 32 bytes, contador)` con contador `floor((epoch - 10800) / (horas * 3600))`: pasos de N horas alineados a la hora argentina (UTC-3, sin horario de verano), así 12 h cambia a las 0 y a las 12 y 24 h a medianoche. Período del negocio (12, 24 o a medida de 1 a 168 h). Tolerancia: el código anterior vale 5 minutos después del cambio. El código lo calcula el servidor y sólo se lo devuelve a su dueño (`supervisor_rotating_code`); se puede usar varias veces en su ventana (es el sentido del pedido). "Cambiar secreto" lo invalida al instante.
3. **De un uso.** 6 dígitos al azar (`gen_random_bytes`) generados a pedido con duración de 1 a 30 minutos (tope del dueño, por defecto 5), opcionalmente atados a una acción y a un monto máximo, con nota. Se guarda `HMAC-SHA256(sal de 16 bytes, código)`; el código sale una sola vez en la respuesta y queda sólo en el estado de la pantalla. Al usarse se marca (quién, acción, monto, token) con `FOR UPDATE` (dos cajas a la vez no lo usan dos veces). Revocable por su supervisor o el dueño; tope de 20 activos por supervisor. Si el código coincide pero la acción o el monto no, `one_time_scope` (cuenta como fallo y no lo consume).
4. **App autenticadora (TOTP estándar).** RFC 6238 con HMAC-SHA1, 6 dígitos, paso de 30 o 60 s, para Google y Microsoft Authenticator. Enrolamiento en dos pasos: `supervisor_totp_begin` crea un secreto pendiente (20 bytes) y devuelve **una vez** el base32 y la cuenta para el QR `otpauth://` (dibujado local con `LocalQr`, sin servicios externos); `supervisor_totp_confirm` exige un código válido dentro de 15 minutos. Verificación ±1 paso y **anti repetición**: no se acepta un contador menor o igual al último usado.
5. **Secretos sólo en el servidor.** `supervisor_pin_methods`, `supervisor_one_time_pins` y `supervisor_pin_guard` con RLS activa, sin policies y sin grants a `anon` ni `authenticated`: ni el dueño ni el propio supervisor los leen por PostgREST. Todo pasa por RPC `SECURITY DEFINER` con `search_path` fijo (incluye `extensions`, donde Supabase instala pgcrypto) que exigen `current_tenant_id()`, la feature, `is_supervisor(auth.uid())` y el modo permitido. Las funciones internas (`otp_hotp`, `otp_base32`, guardas) no tienen `execute` para el cliente. La única salida de un secreto es el base32 del enrolamiento TOTP hacia el propio supervisor (inevitable para cargarlo en la app).
6. **Bloqueo y ritmo.** `supervisor_pin_guard` cuenta fallos por supervisor **y por quien pide**: con N fallos (`pin_max_attempts`) en la ventana de `pin_lock_minutes` se bloquea el supervisor, quien pide, o ambos; quien pide bloqueado no autoriza con ningún supervisor (`requester_locked`). Además, 30 intentos por minuto por usuario (`rate_limited`). El bloqueo heredado de `account_supervisor_pins.locked_until` se sigue respetando. El dueño desbloquea (`supervisor_unlock`). Cada éxito y fallo queda en `audit_logs` con el modo (`auth_mode`), el supervisor y quien pidió; también activar, cambiar secreto, vincular, generar, revocar y desbloquear.
7. **Política del dueño.** `security_settings` suma `pin_modes` (modos del negocio), `pin_default_mode` (el primero en Mis PINes), `pin_rotation_hours` y `pin_one_time_max_minutes`; cada acción de `pin_policy` puede llevar `modes` (p. ej. anulaciones sólo con PIN de un uso). `pin_action_modes()` es la regla (espejo `actionModes()` en `lib/security/pinPolicy.ts`): los del negocio recortados por los de la acción; sin la feature, sólo el fijo. `security_settings_save` valida que el modo por defecto esté entre los permitidos y que ninguna acción quede sin modos.
8. **Mis PINes.** Pestaña nueva en Configuración, Seguridad y auditoría para el dueño y los supervisores: código rotativo grande con anillo de cuenta regresiva (se pide de nuevo justo al cambiar, con el reloj del servidor), Copiar y WhatsApp (`wa.me` sin número), "Generar PIN de un uso" con duración, acción y monto opcionales, lista de activos con Revocar, vinculación de la app con QR y clave manual, PIN fijo e historial de quién usó cada autorización. Supervisores muestra los modos de cada uno, Desbloquear y "Borrar PINes" (fijo, rotativo, app y un uso).
9. **Feature (CLAUDE.md §6).** `pin_autenticador` OPTIONAL (`is_basic=false`), en Pro, Business y Enterprise, no en Start; requiere `pin_supervisor`. Gating real en `pin_action_modes()` (verificación) y en cada RPC de generación. Copy en `featureInfo.ts`; la comparación de planes la deriva de la matriz.

### Alternativas descartadas

- **Pedir el modo al cajero:** un selector más en un momento de apuro; el servidor lo detecta sin ambigüedad práctica (una colisión entre modos del mismo supervisor es de 1 en un millón y no tiene efecto: es la misma persona).
- **Rotativo con TOTP estándar de 12 h:** las apps no admiten pasos de horas; por eso el rotativo es propio (SHA-256 y alineado a la hora local) y la app usa el TOTP estándar.
- **bcrypt para los PIN de un uso:** costo alto por cada código activo en cada intento; con 6 dígitos, vida de minutos, tabla sin lectura y bloqueo por intentos, HMAC con sal alcanza.
- **Cifrar los secretos con Vault:** suma manejo de claves sin cambiar el modelo de amenaza principal (el cliente no los lee); queda como mejora si se exige cifrado en reposo.

### Consecuencias

- Deploy: aplicar `20261023100000_pin_autenticador.sql` después de `20261019100000` (ADR-056). Front tolerante: sin la migración, Mis PINes avisa que no está disponible y el diálogo sigue con el PIN fijo.
- Compatibilidad: los PIN fijos, `supervisor_set_pin`, `require_supervisor` y las RPC `account_*` de cuenta corriente no cambian. `supervisor_list.has_pin` pasa a significar "tiene algún modo listo"; con la feature, todo supervisor figura en el diálogo porque puede generar un PIN de un uso en el momento.
- Riesgos: el reloj del servidor manda (el anillo usa su hora); un celular con la hora mal hace fallar la app (±1 paso de tolerancia y aviso al vincular). Los secretos quedan en claro para `service_role` (como cualquier dato del negocio). Un cajero malintencionado puede bloquear a un supervisor con N fallos (igual que antes); ahora también se bloquea a sí mismo.
- Tests: `tests/unit/otp.test.ts` (vectores RFC 4226, 6238 y 4648, paridad TS y SQL del rotativo, tolerancias, anti repetición y ciclo del PIN de un uso), `tests/unit/pinPolicy.test.ts` (modos por acción), RLS `tests/integration/rls-pin-autenticador.test.ts` (secretos ilegibles para todos, la cajera no genera, otro negocio sin acceso, un uso, rotativo, TOTP y bloqueo) y la cadena completa de migraciones sobre PGlite con **pgcrypto real** (contrib de PGlite 0.3) y un recorrido de humo con los mismos vectores.

---

## ADR-058: Listas de precios PRO: tipos, programados, plazos, escalas, redondeo, mantenimiento masivo y etiquetas (F18 · H100)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/listas-precios-pro`, migraciones `20261021100000` a `20261021100300` sin aplicar) · **Base:** ADR-049, ADR-050, ADR-052, ADR-056 · **Auditoría:** [`auditoria-fiscal-contable-precios.md`](./auditoria-fiscal-contable-precios.md) §2.

### Contexto

Con el precio autoritativo (ADR-056) el servidor ya calculaba el precio de lista, pero las listas sólo tenían canal, % y precio fijo. Faltaba lo que pide quien compra e importa (lista sobre costo, en dólares, escalas, plazos con recargo, redondeo, márgenes mínimos, índices, aprobación) y lo que pide cualquier comercio (vigencias, precios programados, lista por cliente o sucursal, actualización masiva con deshacer, etiquetas a reimprimir), sin volver complicado lo simple.

### Decisión

1. **Modelo aditivo sobre `price_lists`.** `kind` (`fixed` como hoy, `derived` de `base_list_id`, `cost` con `cost_basis` + `markup_mode` markup o margen + `markup_value`, `currency` con `currency` + `fx_source`), `adjustment_amount` además del %, `rounding` jsonb (múltiplo o terminación psicológica, arriba, abajo o al más cercano), `min_margin_pct`, `valid_from` / `valid_to`, `pos_selectable`. `products.min_price` (piso). Tablas nuevas: `price_list_breaks` (escalas por producto, variante o toda la lista; precio fijo o %), `payment_terms` (días, recargo, cómo se calculó) + `customers.payment_term_id`, `price_list_assignments` (cliente, grupo de clientes, sucursal, grupo de sucursales; una lista por destino), `fx_rates`, `price_index_values`, `price_schedules`, `price_settings`, `price_bulk_batches` + `price_bulk_lines`, `price_label_queue`.
2. **Un solo resolver, dos lados.** `_resolve_unit_price` gana `p_term` y `p_pos_list` (con default) y `resolveUnitPrice` (TS) es su espejo exacto, en centavos enteros con mitad hacia arriba. Lista: explícita; si no, la elegida en el POS (sólo `pos_selectable`), cliente, grupo, sucursal, grupo de sucursales, mostrador; la inactiva o fuera de vigencia se saltea. Base con programado vigente. Precio de lista: programado o ítem (variante, producto); si no, por tipo. PRO: escala, recargo de la condición (parámetro, header o ficha del cliente; `none` = contado), redondeo de la lista sólo sobre precios calculados (un precio cargado a mano se respeta) y piso (precio mínimo y margen mínimo). **Paridad probada** con una matriz de 40 casos (`tests/fixtures/priceMatrix.ts`) en unit (TS) y en integración (SQL), con y sin PRO; corrida también sobre PGlite con la cadena completa.
3. **`create_sale` no se toca.** Llama al resolver por posición y resuelve la firma nueva. La lista y la condición elegidas en el POS viajan como headers (`x-ninja-price-list`, `x-ninja-payment-term`, como el token de supervisor): el resolver los lee, así el ensayo del cobro en espera y los ítems de mesa o delivery cargados desde el POS cobran lo mismo que muestra la pantalla. El recargo del plazo va dentro del precio unitario (criterio fiscal: los intereses de financiación siguen el tratamiento de IVA de la operación principal).
4. **Programados sin cron.** `price_schedules` (por lista o base, producto y variante) los aplica el resolver cuando llega la fecha; `price_schedules_apply_due` (la llaman el POS, Etiquetas y Precios al abrir) los consolida en la tabla para el historial y las etiquetas. Un cambio manual posterior los da por aplicados (gana lo último).
5. **Mantenimiento masivo por RPC.** Vista previa (`price_bulk_preview`: cantidad, antes y después, bajo costo), creación (`price_bulk_create`: ahora, programado o pendiente de aprobación), decisión del dueño (`price_bulk_decide`, quien carga no aprueba) y deshacer (`price_bulk_revert`: cancela lo programado y vuelve al precio anterior lo que nadie cambió después). Alcance por categoría, marca, proveedor (`supplier_products`), tag o productos; destino el precio de venta o una lista (se fija por producto). Índice (PRO): % entre dos valores de `fx_rates` o `price_index_values` con tope, guardado en el lote. Todo con `ninja.price_source = bulk` (historial) y `audit_logs`. Import XLSX (`price_list_import`, ahora o programado) y export con desplegable de listas.
6. **Etiquetas.** Triggers en el precio del producto, de la variante y de los ítems de listas de mostrador o asignadas a una sucursal encolan "a reimprimir" por sucursal (`price_label_queue`, una pendiente por producto); Etiquetas las muestra con el precio de góndola de la sucursal y las marca impresas.
7. **Features (CLAUDE.md §6).** `listas_precios` (OPTIONAL, existe): listas, %, fijos, vigencia, programados de listas, asignaciones (por sucursal además `multi_sucursal`), import a listas. **`listas_precios_pro` nueva (OPTIONAL, Business y Enterprise, requiere `listas_precios`)**: tipos, escalas, plazos, redondeo y piso de lista, `products.min_price`, cotizaciones e índices, actualización por índice, modo profesional y aprobación. Gating real en triggers (`price_lists_pro`, `products_min_price`, `customers_payment_term`, `price_list_breaks_check`, `price_list_assignments_check`), policies (`price_pro_can_write`) y RPC. Bajar de plan no borra: el resolver deja de aplicar lo PRO (una lista en moneda sin PRO ignora sus ítems) y se puede seguir desactivando lo cargado. El actualizador masivo del precio de venta, el historial y las etiquetas son BASE. Copy en `featureInfo.ts`; la comparación de planes deriva de la matriz.
8. **UI simple por defecto.** Listas con % y fijos, Actualizar precios en 3 pasos, Exportar / Importar. "Profesional" (preferencia del negocio, exige PRO) suma tipos, programados, plazos, dólar e índices y aprobación. Ficha del producto: precio por lista y próximos. Cliente: lista y condición. POS: chip de lista (elegibles) y de condición con el total por plazo; el carrito se reprecia al cambiar lista, condición, cliente o cantidad.

### Alternativas descartadas

- **Versiones de lista completas (borrador → aprobada → vigente → histórica):** se cubre lo necesario con precios programados por fila y lotes aprobables; la versión entera queda para cuando haga falta comparar listas completas.
- **Cron para aplicar programados:** depende de `pg_cron` y deja ventanas; el resolver los aplica en el instante exacto.
- **Recargo del plazo como ítem "intereses" o extra `surcharge`:** el extra no se valida contra el plazo; dentro del precio lo valida el servidor. El ítem aparte queda para F3 si el contador lo pide.
- **Lista por sucursal como campo de `config_overrides`:** obligaba a recrear `config_field_type`/`config_field_error` y el espejo; una tabla de asignaciones con la misma precedencia (grupo ← sucursal) sirve también para cliente y grupo.
- **Resolver el precio sólo en el navegador y validar después:** el servidor ya manda (ADR-056); acá se comparte la lógica y se prueba la paridad.

### Consecuencias

- **Deploy en orden:** front primero (sin la migración el POS cae a la lista mostrador de siempre y la sección de precios al modo simple) → migraciones `20261021100000` a `20261021100300` en orden, después de las de ADR-056.
- La firma de `resolve_unit_price` cambia (dos parámetros con default): un cliente viejo que la llame con 8 argumentos nombrados sigue andando.
- **Riesgos:** en el POS, una variante sin precio propio con un programado vencido del producto puede diferir del servidor hasta que se consolide (cae en `price_mismatch` y se reprecia). El recargo del plazo no aplica a los modificadores. El editor de precios por producto de una lista muestra el cálculo simple (% y fijos). El cambio del % de una lista no encola etiquetas. La aprobación usa los precios calculados al cargar el lote.
- **Pendiente:** franjas horarias y días, versiones de lista, actualización desde la lista del proveedor con mapeo de columnas guardado, unidad de venta por bulto, flejes con precio por unidad de medida y sin impuestos nacionales, factura en moneda extranjera (F3).
- Tests: `price-resolver-parity`, `price-rounding-bulk`, `price-cart-reprice`, `listasPreciosPro` (unit); `tests/integration/rls-listas-precios-pro.test.ts` (paridad SQL, RLS, aprobación, etiquetas, deshacer, bajar de plan); cadena completa sobre PGlite con humo de ADR-056 y de esta ADR.

---

## ADR-061: Detalle de la venta con datos del procesador y conciliación de procesadores (Mercado Pago automático, Payway y adquirentes por archivo)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/detalle-venta-conciliacion`; migraciones `20261024100000` y `20261024100100` sin aplicar; Edges `payment_provider_data` y `settlements` sin desplegar) · **Base:** ADR-032 (Orders API), ADR-041, ADR-044 (conciliación de tarjetas), ADR-047, ADR-049 y ADR-057 (n° de comercio y credenciales por sucursal), ADR-052 (`internal_scope`), ADR-053.

### Contexto

El dueño pidió (1) ver en el detalle de la venta todo lo de cada cobro: procesador, tarjeta, medio, cuotas, autorización, cupón y lo que informa el gateway, trayéndolo del proveedor cuando está conectado y con la pantalla viva; (2) conciliar con Mercado Pago usando la conexión que ya existe, y con Payway hasta donde dé su API; (3) n° de comercio por sucursal. Además: un negocio que sólo cobra con Mercado Pago tiene que poder conciliar todo dentro de NinjaPos, sin NubCeo, de forma simple para alguien que no es contador.

### Decisión

1. **Detalle de la venta** (`TicketModal` con pestañas Ticket y Cobros; el ticket sigue montado para imprimir y mandar por email). Cada cobro muestra logo del procesador, medio, marca y últimos 4, cuotas, autorización, cupón, lote, n° de comercio, adquirente, terminal, ids del intent, de la orden y del pago (copiables), estado de conciliación y línea de tiempo. **"Datos del procesador"** bajo demanda por la Edge `payment_provider_data`: lee el intent (`payments.reference`), consulta con **la credencial con la que se creó el cobro** (`mp_payment_intents.secret_store_id`, ADR-057) y en su ambiente (`mp_env`), normaliza (`_shared/processorData.ts`: estado, bruto, comisiones e impuestos del vendedor, neto, devuelto, fecha y estado de acreditación, cuotas y valor de cuota, tarjeta, pagador, ids y línea de tiempo) y guarda la foto en `payment_provider_snapshots` (normalizada y cruda, una por proveedor y pago). Caché de 10 minutos y "Actualizar" con un mínimo de 15 s. **Vivo por sondeo** (el proyecto no usa Realtime): cobros e intents cada 15 s mientras hay algo pendiente y cada 60 s si no, sólo con la pestaña abierta.
2. **Proveedores consultados:** Mercado Pago (`GET /v1/payments/{id}`; en Orders, `GET /v1/orders/{id}` y el `reference_id` del pago), Payway (`GET /api/v2/payments/{id}`, montos en centavos, sin aranceles ni acreditación), Nave (`/integrations/payments/{id}`), GO Cuotas (orden), Clover (`/v3/merchants/{mId}/payments/{id}`) y Getnet (orden). Directo, MODO, Mobbex y Pagos360 responden `no_api`: se muestra lo guardado en el POS.
3. **Conciliación v2: vista "Procesadores"** en `/reportes/conciliacion?vista=procesadores` (la de tarjetas por lote queda como "Tarjetas por lote"). Datos en `settlement_lines` (una fila por movimiento del procesador, con bruto, comisión, impuestos, neto, devuelto, fecha y estado de acreditación, tarjeta, lote, cupón, autorización, comercio y el resultado del cruce) y `settlement_imports`.
   - **Mercado Pago primero y automático:** la Edge `settlements` trae `GET /v1/payments/search` del período (por `date_created`, de a 100, tope 3.000 por credencial) con **cada credencial del negocio y de sus sucursales**; comisiones e impuestos de `charges_details` (o `fee_details` y `taxes_amount`), neto de `transaction_details.net_received_amount`, `money_release_date` y `money_release_status`. Excluye rechazados y movimientos que no son ventas (transferencias salientes, retiros, cargas). **Cron diario** `settlements-sync` (06:20 de Argentina, patrón `internal_cron` de `pending_charges_sync`): últimos 7 días por creación más las acreditaciones de los últimos 3 días, y vuelve a cruzar 40 días. "Actualizar ahora" a mano y switch "Actualizar solo todos los días" (`settlement_sync_state.auto_sync`). Sin conexión, la pantalla ofrece **"Conectar Mercado Pago"** con el mismo asistente de Medios de pago (OAuth o token).
   - **Payway y cualquier adquirente por archivo:** XLSX o CSV con mapeo de columnas sugerido por encabezado (fecha, bruto, arancel, retenciones, neto, fecha de pago, lote, cupón, autorización, n° de comercio, últimos 4, marca, cuotas, id, terminal), números y fechas argentinas, vista previa y `settlement_import_lines` (upsert por clave de fila: reimportar no duplica). Payway no publica una API de liquidaciones; su API de pagos no trae aranceles ni acreditación.
   - **Motor de cruce puro** (`_shared/settlementMatch.ts`, lo usan la Edge y los tests): por id del procesador (pago, orden o `external_reference` = intent), después n° de comercio + lote + cupón, después autorización + últimos 4 con tolerancia de fecha, y por último monto + día sólo con pareja única de los dos lados (avisado como coincidencia débil). Montos efectivos: bruto menos devuelto contra el cobro (0 si la venta está anulada). Un intent aprobado sin venta queda como cobro sin venta con su intent. Lo manual y lo revisado no se pisa.
   - **Estados en lenguaje simple:** Conciliado, Cobro sin venta, Venta sin cobro (cobros del POS que el procesador no informa), Diferencia de monto, Revisado; y por la plata: Acreditado, Pendiente de acreditación (con fecha) o Sin fecha. **Resumen para el dueño:** "Vendiste $X con Mercado Pago. Mercado Pago te cobró $Y de comisiones e impuestos (Z % de lo vendido). Te acreditó $W. Falta acreditar $V, lo próximo el ...". KPIs, gráficos ECharts (neto, comisiones e impuestos por día; desglose de comisiones por concepto) y XLSX con resumen, cobros y ventas sin cobro.
   - **Resolver excepciones** (`settlement_line_resolve`): crear la venta de un cobro sin venta (venta libre por el monto en la caja abierta del usuario, por `create_sale`, con el intent o el id del pago de MP como referencia, y queda vinculada), vincular a una venta a mano, marcar revisado con nota, desvincular, volver a revisar.
   - **Conciliado = `payments.reconciled_at`** (misma semántica que `set_payments_reconciled`, ADR-044, ahora para cualquier medio): el cruce automático marca los cobros que cierran (audit `payments_reconciled` con `source = 'settlement_auto'`), y desvincular o una diferencia desmarca sólo lo que marcó esta conciliación (`settlement_lines.reconciled_payment`).
4. **Seguridad:** tablas nuevas con RLS `tenant_id = current_tenant_id() or internal_scope()` (ADR-052) más una RESTRICTIVE de dueño o encargado (comisiones e impuestos son administrativos); sin policies de escritura (RPC SECURITY DEFINER y service_role). `_settlement_apply_matches` es sólo de service_role y vuelve a validar que líneas, cobros e intents sean del negocio. Para cajeros, `payment_provider_data` devuelve los datos del procesador sin comisiones, neto ni pagador.
5. **Plan (CLAUDE.md §6):** `conciliacion_procesadores` **OPTIONAL**, grupo reportes, **Business y Enterprise** (planes a medida heredan `tesoreria`). Gating real en `settlement_import_lines`, `settlement_line_resolve`, `settlement_set_auto_sync`, `_settlement_apply_matches` y la Edge `settlements` (usuario y cron). Copy en `featureInfo.ts`; la comparación de planes la toma de la matriz. El detalle de la venta y los datos del procesador son **BASE**.
6. **N° de comercio por sucursal (verificado):** ya lo resuelve ADR-049 (`merchant_numbers` en la whitelist de `config_overrides`, editor por sucursal y grupo en Configuración, Medios de pago con el selector de alcance) y el POS cobra con los efectivos de su sucursal (`usePaymentMethodsStatus` → `effectiveProviderRows`); las terminales registradas tienen su n° de comercio (`payment_terminals`). No hizo falta UI nueva.

### Alternativas descartadas

- **Reporte de liberaciones de MP (`/v1/account/release_report`):** es asincrónico (se pide, se genera y se descarga un CSV) y no trae el cruce con el pago; `payments/search` da por pago comisiones, neto y fecha de acreditación en una sola llamada. Queda como mejora para retiros y movimientos que no son pagos.
- **Supabase Realtime en el detalle:** el resto del proyecto sondea; el sondeo acotado alcanza y no suma infraestructura.
- **Cruce en SQL:** las reglas (prioridades, unicidad, tolerancias) se testean mejor como función pura compartida; la escritura sigue en SQL con validación de aislamiento.
- **Extender `conciliacion_tarjetas` (Pro):** la conciliación automática por API es otro nivel comercial (lo que hoy se paga aparte); Pro mantiene la de tarjetas manual.

### Consecuencias

- **Deploy en orden:** migraciones `20261024100000` y `20261024100100` → Edges `payment_provider_data` y `settlements` (verify_jwt = true) → front. El front contra una base sin las migraciones: el detalle muestra lo del POS y la vista Procesadores no trae datos. El cron usa `platform_secrets('internal_cron')` (ya existe por `pending_charges_sync`).
- **Riesgos:** cuentas con más de 3.000 pagos en el período (se marca `truncated`; achicar el período); límites de tasa de MP en `payments/search` (una corrida diaria por negocio); el cruce por monto y día puede emparejar mal dos ventas iguales del mismo día sin ids (sólo con pareja única y avisado); los campos de `charges_details` varían por país y producto (fallback a `fee_details`). Payway: aranceles y acreditación sólo por archivo. "Conectar Mercado Pago" por OAuth vuelve a Configuración (el callback no conoce la pantalla de origen).
- **Pendiente:** conciliación de MODO, Mobbex, Pagos360 y Directo por archivo con preset; presets de columnas por adquirente guardados por negocio; retiros y movimientos de saldo de MP; liquidación de Payway por API si la publican.
- Tests: `tests/unit/processorData.test.ts` (normalizadores con fixtures), `settlementMatch.test.ts` (motor), `processorReconciliation.test.ts` (resumen, filtros, importación), `paymentDetail.test.ts` (detalle); `tests/integration/rls-conciliacion-procesadores.test.ts` (RLS, RPC, gating, aislamiento y `rls_internal_scope_leaks`); `deno check` de las Edges.

### Adenda (2026-10-12): transferencias recibidas en un CVU de Mercado Pago

**Contexto.** El dueño pidió que, si la cuenta de transferencia (ADR-055) es un CVU de Mercado Pago, el POS detecte sola la transferencia mientras espera y cierre o avise.

**Decisión.**
- Cuenta de transferencia con `auto_detect`, `auto_tolerance` (± pesos), `auto_mode` (`notify`: avisa y el cajero cierra; `auto_close`: cierra la venta sola) y `auto_window_min`. Sólo para cuentas de Mercado Pago (slug `mercado-pago` o CVU que empieza con `0000003`, PSP 0003): lo exige el trigger `transfer_accounts_zauto_guard` junto con el plan.
- Edge `transfer_watch` (start, poll, pick, reject, cancel, close, probe). Al abrir la pantalla de transferencia el POS crea un *watch* (`transfer_watches`) con monto, tolerancia, modo y vencimiento tomados de la cuenta en el servidor y la credencial de MP de la sucursal. El sondeo (cada 4 s en el POS, como mucho una búsqueda cada 3 s por watch en el servidor) busca en `GET /v1/payments/search` los movimientos entrantes (`isIncomingTransfer`: aprobados, `bank_transfer` / `cvu` / `debin`, `money_transfer` / `account_fund`, sin los salientes de la propia cuenta) y los empareja con `pairTransfer` (`_shared/mpTransfers.ts`, puro con tests): monto dentro de la tolerancia, desde 2 minutos antes del watch hasta su vencimiento, sin movimientos usados ni rechazados. **Una sola opción y ningún otro watch abierto que también la acepte** = coincidencia; si no, ambiguo y elige el cajero. Un movimiento nunca se reusa (índice único por negocio sobre `mp_payment_id`, reclamo atómico). El n° de operación de la transferencia queda con el id del movimiento de MP, así la conciliación de procesadores lo cruza.
- Todo auditado (`transfer_watch_started`, `_matched`, `_ambiguous`, `_picked`, `_rejected`, `_cancelled`, `_closed`). RLS de `transfer_watches` con `internal_scope()`, sin escritura por PostgREST.
- Plan: `transferencia_auto_mp` **OPTIONAL** (grupo pagos, Pro, Business y Enterprise; planes a medida heredan `transferencia_multicuenta`). Gating en el trigger y en la Edge; copy en `featureInfo.ts`.
- **"Probar detección"** en la configuración de la cuenta busca los últimos 7 días y dice con honestidad si Mercado Pago informa transferencias entrantes para esa cuenta; si no aparece ninguna, se sigue confirmando a mano ("Ya transfirió" no cambia).

**Hallazgos de la API.** Verificado: los webhooks de pagos de Mercado Pago notifican pagos creados por la aplicación, no transferencias entrantes a la cuenta ([webhooks](https://www.mercadopago.com/developers/es/docs/your-integrations/notifications/webhooks), [notificaciones](https://www.mercadopago.com.ar/developers/es/docs/checkout-api-v2/notifications)): la detección es por sondeo. No encontramos documentación oficial que confirme que las transferencias entrantes a un CVU aparecen en `payments/search` ni qué campos traen; los filtros (`payment_type_id`, `payment_method_id`, `operation_type`, `payer.identification`, `point_of_interaction.transaction_data.bank_info.payer`) son supuestos a validar con "Probar detección" en una cuenta real antes de venderlo.

**Consecuencias.** Migración `20261024100200_transferencia_auto_mp.sql` (no aplicada) y Edge `transfer_watch`. Pendiente: llamar `close` con la venta al confirmar (la hoja no recibe el id de la venta), override por sucursal y caja, barrido de watches vencidos. Riesgos: se asume que la credencial conectada es la dueña del CVU; costo de sondeo contra la API de MP; cancelar un watch emparejado libera el movimiento. Tests: `tests/unit/mpTransfers.test.ts`, `tests/integration/rls-transferencia-auto.test.ts`.

**Fuentes:** [Mercado Pago, búsqueda de pagos](https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-api-payments/search-payments/get) · [Mercado Pago, reporte de liberaciones](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/additional-content/reports/released-money/introduction) · [Payway ventas online (SDK oficial)](https://github.com/decidir/sdk-php-v2) · base de la API de Payway en uso: `https://ventasonline.payway.com.ar/api/v2` (sandbox `https://developers.decidir.com/api/v2`).

### Adenda (2026-10-12): rediseño de la pantalla de Conciliación (hub)

**Contexto.** El dueño pidió "que se entienda mejor, con logos, más linda y visual, que se pueda bajar todo lindo en Excel y conciliar varios a la vez". La pantalla tenía dos vistas separadas (Tarjetas por lote y Procesadores, un procesador por vez) y la acción era cobro por cobro o lote por lote.

**Decisión.**
- **Un solo hub** en `/reportes/conciliacion` (`components/reports/conciliacion/*`): encabezado con una frase, resumen del período (Vendiste, Te cobraron comisiones e impuestos, Te acreditaron, Falta acreditar con la próxima fecha, En riesgo), período y sucursal compartidos, y tres vistas por URL (`?vista=procesadores|tarjetas|pendientes`, `&p=<procesador>` para el detalle; el link de los avisos `?vista=procesadores&filtro=disputas` abre Pendientes con disputas). Sin `conciliacion_procesadores` o para el cajero, el resumen es el de tarjetas y no hay Por procesador ni Pendientes.
- **Por procesador:** lee `settlement_lines` de todos los procesadores en una consulta (misma RLS) y corre el cruce de cada uno con datos (misma clave de caché que su detalle). Tarjeta por procesador con logo, plata y barra de estados; el catálogo suma Directo, GO Cuotas, MODO y Transferencias por archivo (`settlement_import_lines` acepta cualquier `provider_key`). Filtro por sucursal: línea de la credencial de la sucursal o cruzada con una venta de esa sucursal. Gráficos ECharts (apilado por día: acreditado, por acreditar, comisiones; dona por procesador) y calendario de acreditaciones (14 días, lo de después y lo sin fecha). El detalle es el componente de siempre (`ProcessorReconciliation`) embebido.
- **Pendientes de revisar:** bandeja pura (`lib/reports/reconciliationHub.ts`, `buildInbox`) con disputas abiertas o sin ver, cobros sin venta, ventas sin cobro, diferencias y lotes de tarjeta de días anteriores con cobros pendientes.
- **Acciones en lote** sin RPC nueva: `set_payments_reconciled` en tandas de 200 ids, `settlement_line_resolve` (`ignore`) y `payment_dispute_ack` de a una con 4 en paralelo; `runInBatches` sigue ante errores y el toast dice cuántas salieron. Cada RPC valida rol, plan y negocio: la selección sólo aparece para dueño o encargado, y el cajero sigue editando el cupón de sus turnos.
- **Excel:** `lib/utils/xlsxWorkbook.ts` suma bajada combinada, tipos `datetime` y `percent`, formato propio por columna, alineación, relleno por valor (columna Estado), filas de subtotal y varias tablas en una hoja (Resumen). Hojas: Resumen, Por procesador, Detalle de cobros, Por lote, Cupones, Pendientes y Disputas; fechas reales de Excel (`xlsxDate` con la hora local).
- **Visual:** chips de estado neutros con ícono de color (nunca relleno ni borde de color), franja arriba para alertas, logos de procesadores en placa neutra, de tarjetas con `CardBrandLogo`, de adquirentes en el comercio y de bancos en Transferencias.

**Consecuencias.** Sin migraciones. Tests: `tests/unit/reconciliationHub.test.ts`, `reconciliationSelection.test.ts` y `xlsxWorkbookExtras.test.ts`. Pendiente: atajos de teclado más allá de Esc, rango con Shift en la selección y presets de columnas por adquirente para los nuevos procesadores por archivo.

---

## ADR-062: Integración con NubCeo: envío de ventas con sus cobros, monitor y asientos contables

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/nubceo`, migraciones `20261025100000` y `20261025100100` sin aplicar, Edge `nubceo_sync` sin desplegar) · **Base:** ADR-052 (`internal_scope`), ADR-054 (`card_voucher.adquirente`), patrón de cron interno de `account_reminders` y `pending_charges_sync` · **Numeración:** ADR-061 queda para otra rama. Documento vivo: [`30-nubceo.md`](./30-nubceo.md).

### Contexto

El dueño pidió mandar las ventas a NubCeo (conciliación de cobros) configurado desde una pantalla: mapeo de campos, cada cuánto se manda y qué medios van, una vista de lo enviado y los asientos contables que devuelve NubCeo. El mismo dueño ya lo tiene andando en ANDESMAR (servicio Node en Railway, una venta por comprobante con sus pagos, idempotente por `venta_id`, ritmo y ventana, "solo simular", estados sincronizada, excluida, pendiente y error), que sólo manda. Había que investigar si la API de NubCeo deja leer asientos.

### Decisión

1. **API.** Se reusa el conocimiento de ANDESMAR (login, ventas, borrado, compañías, lectura de respuestas) y la **especificación oficial "API Ventas y Contabilidad, Conciliaciones 5.0"**, que **sí tiene lectura de asientos**: `GET /v1/tenants/:tenant/accounting/ledger-header` (cabeceras con renglones y cuenta) y `PATCH .../ledger-header/status` (confirmar). Se implementa la importación por API y, como alternativa, por CSV de la exportación.
2. **Nativo, sin Railway.** Lógica pura en `supabase/functions/_shared/nubceo.ts` (armado, clasificación, respuestas, reintentos, ventana, credenciales, asientos y cliente HTTP con cola secuencial; la usan la Edge, la pantalla y los tests). Edge `nubceo_sync` (verify_jwt = true) con dos modos: cron (`X-Cron-Secret` de `platform_secrets('internal_cron')`) y usuario (probar conexión, enviar ahora, vista previa, traer y confirmar asientos). pg_cron cada minuto llama a la Edge sólo si `nubceo_any_due()`; el ritmo de cada negocio (5 minutos a 1 día) y su ventana horaria los decide la base (`next_run_at`, `nubceo_in_window`, espejo de `inWindow` en TS).
3. **Cola `nubceo_sync`.** Una fila por venta o devolución con `venta_id` (prefijo + n° de venta o uuid, fijado al encolar, único por negocio), estado (`pending`, `sending`, `synced`, `excluded`, `error`, `simulated`, `delete_pending`, `deleted`), intentos y próximo intento (1, 5, 15, 30, 60 y 180 min), último error y su tipo, respuesta HTTP, payload enviado y su huella (FNV-1a). Toma con lease de 10 min y `FOR UPDATE SKIP LOCKED`; resultados fila por fila (`nubceo_apply_results`). Encolado por trigger en `sales` (completada, anulada) y `sale_returns` (nota de crédito en efectivo), envuelto en `exception when others` (nunca frena una venta) y con siembra desde la fecha de inicio como red de seguridad. Anular una venta ya enviada la borra de NubCeo (configurable); si NubCeo ya la concilió, queda enviada con el aviso.
4. **Armado** igual al de ANDESMAR (mismos casos de prueba): total = pagos incluidos (sin el vuelto), neto e impuestos en centavos para que `gross = net + tax` cierre, nota de crédito negativa, lo vacío no viaja. Como NinjaPOS guarda precios finales, el neto es el total salvo que el negocio elija IVA incluido (21, 10,5 o 27 %). Plataforma por medio fijo, por proveedor del intent (QR, link, Point) o por la terminal del cupón; marca del cupón traducida a la lista de NubCeo con variante de débito.
5. **Configuración por negocio** (`nubceo_settings`): activa, ambiente (prueba o producción), solo simular (por defecto), desde, ritmo, ventana, sucursales incluidas, tanda y máximo de intentos, mapeo (`mapping` jsonb normalizado en TS: id, código de sucursal cabecera por sucursal, categorías, referencia interna, fecha del pago, medios con `paymentType` y plataforma, plataforma por proveedor, marcas, datos opcionales del pago, IVA, devoluciones y anulaciones) y asientos automáticos. Guardar devuelve a la cola lo excluido por regla y lo fallado por configuración. Apagar la simulación no manda lo simulado (se manda a pedido).
6. **Credenciales** en `nubceo_credentials` (por ambiente: API key, secreto, tenant, CUIT, URL, compañía): RLS sin policies y sin grants a `anon` ni `authenticated`, escritura por RPC `nubceo_credentials_set` (el secreto vacío conserva el guardado), lectura sólo service_role en la Edge, URL limitada a `https://*.nubceo.com`. Equivalente al patrón `set_payment_secret` (nunca service_role en el front) sin sumar otra Edge.
7. **Pantalla** en Configuración > **Integraciones** (grupo nuevo) > NubCeo con tres pestañas: Configuración (conexión, envío, sucursales, medios, mapeo con vista previa del JSON, asientos), Envíos (estado del sincronizador, filtros, pestañas por estado con cantidades, JSON y respuesta, reintentar, excluir y borrar con motivo, totales por día, últimas vueltas) y Asientos contables (traer, importar CSV, renglones con Debe y Haber, confirmar). Logo oficial (wordmark azul y su versión blanca para oscuro).
8. **Feature (CLAUDE.md §6).** `integracion_nubceo` **OPTIONAL** (`is_basic=false`, grupo `integraciones`) en **Business y Enterprise**, y además disponible como **add-on** (`plan_addons` inactivo hasta definir precio; se puede otorgar por negocio). Se descartó Pro: es una integración contable de negocios con varias pasarelas y volumen, como `tesoreria` y `conciliacion_tarjetas`. Gating real: `nubceo_assert(true)` en toda RPC que escribe, el encolado (trigger y siembra), `nubceo_due_tenants` (el cron no procesa sin la feature) y `nubceo_edge_guard` en la Edge. Leer lo ya enviado sólo pide el rol. Copy en `featureInfo.ts`; la comparación de planes la deriva de la matriz.

### Alternativas descartadas

- **Servicio externo (como ANDESMAR en Railway):** otra pieza para desplegar y vigilar; pg_cron + Edge alcanza para ritmos de minutos y deja todo en la base con RLS.
- **Upsert en lote de resultados:** la lección de ANDESMAR (`meli_publications`) es que un lote con claves distintas pone NULL donde faltan; se escribe fila por fila dentro de una RPC.
- **Mandar lo simulado al apagar la simulación:** avalancha silenciosa; queda a pedido ("Mandar las simuladas"), igual que en ANDESMAR.
- **Nota de crédito para anular:** NubCeo tiene borrado; una anulación no es una devolución. La nota de crédito queda para las devoluciones.
- **Endpoints asincrónicos (`insert-async`):** suman un estado intermedio y otra consulta; con tandas de 100 el sincrónico alcanza.

### Consecuencias

- **Deploy:** migraciones `20261025100000` y `20261025100100` (después de ADR-060) y Edge `nubceo_sync` con verify_jwt = true (secrets estándar; el cron usa `platform_secrets('internal_cron')`). Front tolerante: sin la migración, la sección muestra "No disponible".
- **Lo que tiene que dar el dueño:** API key, API secret y n° de tenant de NubCeo (por ambiente), el CUIT si la cuenta tiene varias empresas y el código de cada sucursal cabecera dada de alta en NubCeo.
- **Riesgos:** el signo de `LedgerEntry.amount` (se asume positivo = Debe) y el formato de la exportación CSV no están documentados por NubCeo; `moddo_ar` como código de MODO sin confirmar; sin ambiente de prueba público (por eso "Solo simular" es el valor por defecto). Una venta con el id cambiado a mano en NubCeo se duplicaría (el id es la llave). Las credenciales quedan en claro para service_role (como los demás secretos de cobro).
- **Pendiente:** estado de conciliación por venta (`GET /reconciler/sales` con `reconciliationStatus`), modificar con `PUT`, devoluciones a tarjeta, avisos fuera de la pantalla.
- **Tests:** `tests/unit/nubceo.test.ts` (armado con los casos de ANDESMAR, clasificación de ventas de NinjaPOS, vuelto e IVA, marcas e ids, respuestas de la especificación, reintentos, ventana horaria, URL, asientos y cliente HTTP con fetch falso y cola secuencial), `tests/unit/nubceoLedgerCsv.test.ts`, RLS `tests/integration/rls-nubceo.test.ts` (credenciales ilegibles, aislamiento, cajera, sin feature, funciones internas, cola, anulación y asientos, `rls_internal_scope_leaks` = 0), `deno check` de la Edge y la cadena completa de migraciones sobre PGlite con un humo de la cola, triggers, ventana y asientos. Nunca se llamó a la API real de NubCeo.

---

## ADR-065: Getnet con dos APIs: tipo de API detectado, ambiente explícito y diagnóstico de credenciales

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `fix/getnet-credenciales`; sin migraciones; Edges `getnet`, `getnet_webhook` y `payment_provider_data` sin redesplegar) · **Base:** ADR-031 (Getnet QR + link), ADR-057 (credenciales por sucursal), ADR-061 (datos del procesador) · **Numeración:** si otra rama tomó el 065, renumerar al mergear.

### Contexto

En producción el dueño conectó Getnet y todo cobro QR o link fallaba en el token con "Getnet rechazó las credenciales". El código sólo conocía la API del plugin de WooCommerce de Getnet Argentina (OAuth `auth.geopagos.com`, órdenes en `api.globalgetnet.com.ar/api/v2/orders`). Getnet también publica **Web Checkout** en el portal global (`docs.globalgetnet.com`), disponible en Argentina (ARS: crédito, débito, Click to Pay y QR interoperable), con otro OAuth y otros hosts. Las credenciales de una API no sirven en la otra, y el error no decía qué servicio, qué HTTP ni qué código había devuelto Getnet.

### Decisión

1. **Perfiles de API** (`_shared/getnet.ts`): `geopagos` (sólo producción), `global_prod` (`api.globalgetnet.com`), `global_sbx` (`api-sbx.globalgetnet.com`) y `global_pre` (`api.pre.globalgetnet.com`, homologación). Web Checkout: token `POST /authentication/oauth2/access_token` form-urlencoded `client_credentials`; cobro `POST /dpy/web-checkout/v1/payment-intent` → `redirect_url` (QR y link); estado `GET /dpy/web-checkout/v1/payment-intent/{id}` (`paid`, `denied`, `error`, `expired`, `cancelled`, `pending`, `registered`).
2. **Autodetección:** se prueban los perfiles del ambiente en orden (producción: Geopagos y Web Checkout; prueba: sandbox y homologación), el guardado primero; el que da token se guarda en `secrets.api_profile` con `secrets.environment`. Si ninguno anda, se prueban los del otro ambiente **sólo para avisar** el error de ambiente (nunca se cobra con ellos). Una credencial vieja sin perfil se detecta en el primer cobro y se guarda sola.
3. **Ambiente explícito:** Getnet pasa a `SANDBOX_PROVIDERS` (el wizard deja elegir Prueba); el ambiente viaja en la credencial (por sucursal, ADR-057) y, si falta, se usa el switch Sandbox. Un perfil de prueba nunca vale en producción (`profileMatchesEnv`). El intent guarda `mp_env`.
4. **Diagnóstico sin secretos:** cada rechazo trae API, ambiente, endpoint (host + path), HTTP, código y mensaje de Getnet y una clase (credenciales, producto no habilitado, servicio no encontrado, caída, red). Va en la respuesta de la Edge (`detail`, `attempts`), en el POS y en `console.error` como JSON (`fn`, `step`, `profile`, `status`, `provider_code`). Se borra del texto cualquier aparición del Client ID o el Secret.
5. **"Probar credenciales"** (action `probe` de la Edge `getnet`, dueño o encargado, no guarda nada): en el paso Ambiente del wizard y "Probar conexión" en Administrar. Con Web Checkout lee `GET /sellers` (nombre del comercio, producto habilitado, país) y muestra la URL del webhook.
6. **Web Checkout en el cobro:** comprador "Consumidor Final" (el esquema exige customer con documento y domicilio) con email, CUIT, calle y código postal opcionales del comercio; aprobado sólo con `paid` y monto cobrado mayor o igual al de la venta (las cuotas con interés pueden sumar); `mp_payment_id` = `payment_id` del intento aprobado. El webhook de Web Checkout es una URL única por comercio (Portal Getnet, Basic auth): `getnet_webhook` sin `?intent` busca el cobro por `payment_intent_id` y re-consulta la API; sin webhook el POS confirma igual por su consulta.

### Alternativas descartadas

- **Pedirle al dueño que elija la API a mano:** no sabe cuál le dieron; la prueba lo resuelve sin preguntar.
- **Configurar el webhook por API** (`PUT /technical-configurations`): pisaría la configuración del comercio (otra tienda o integración).
- **Payment Link API:** según su OpenAPI sólo opera en Brasil.

### Consecuencias

- **Redesplegar** `getnet`, `getnet_webhook` (pública, `verify_jwt = false`) y `payment_provider_data`. Sin migraciones.
- **Supuestos a validar con un cobro real:** que Getnet acepte el comprador genérico de Web Checkout, la forma exacta del webhook en Argentina y que el checkout hosted muestre el QR interoperable si el comercio lo tiene habilitado. La API Geopagos sigue sin sandbox público (`auth.preprod.geopagos.com` responde 404).
- **Tests:** `tests/unit/getnetProfiles.test.ts` (requests de token por API, errores y clasificación, sin secretos, orden de autodetección y error de ambiente con fetch simulado, payload, respuesta, estados, webhook, sellers, detalle del procesador y lectura de la prueba en el wizard).

**Fuentes:** [Web Checkout, autenticación](https://docs.globalgetnet.com/en/products/online-payments/web-checkout?doc=authentication-wbc) · [Web Checkout, crear un pago](https://docs.globalgetnet.com/en/products/online-payments/web-checkout?doc=quickstart-create-a-payment-wbc) · [Web Checkout, API reference (OpenAPI 1.6.0)](https://docs.globalgetnet.com/en/products/online-payments/web-checkout/swagger) · [Payment Link API](https://docs.globalgetnet.com/en/products/online-payments/payment-link-api) · [Plugin Getnet Argentina para WooCommerce](https://wordpress.org/plugins/integrar-getnet-con-woo/).

---

## ADR-064: Contracargos, reclamos y devoluciones de Mercado Pago: detección, avisos, Ventas y conciliación

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/contracargos-devoluciones`; migración `20261027100000_payment_disputes.sql` sin aplicar; Edges `settlements` y `mp_webhook` sin redesplegar) · **Base:** ADR-061 (conciliación de procesadores, `settlement_lines`, Edge `settlements` y cron `settlements-sync`), ADR-052 (`internal_scope`), ADR-057 (credenciales por sucursal), ADR-048 (patrón de notificaciones del sistema) · **Numeración:** ADR-063 queda para otra rama.

### Contexto

El dueño pidió ver los contracargos y las devoluciones de Mercado Pago en la conciliación y en Ventas, con alertas. Hoy un contracargo o una devolución hecha desde el panel de Mercado Pago sólo se nota mirando la cuenta de MP: el POS sigue mostrando la venta como cobrada y se puede vencer el plazo para presentar la documentación del contracargo.

### Decisión

1. **Datos (`payment_disputes`).** Una fila por devolución, contracargo o reclamo: negocio, proveedor, tipo (`refund`, `chargeback`, `claim`), clave (`mp_refund:<id de la devolución>`, `mp_cb:<pago>`, `mp_claim:<pago>`: el sondeo y el aviso caen en la misma fila), pago del procesador, id del caso, alcance de la credencial, cobro, venta, intent y línea de liquidación del POS, monto, estado normalizado (`open`, `in_review`, `won`, `lost`, `refunded`, `closed`), estado y detalle de MP, motivo, origen de la devolución en MP (`refunds[].source.type`), **origen para el aviso** (`pos` si la venta está anulada o tiene una devolución registrada; si no, `provider`), estado de la documentación, **plazo** (`date_documentation_deadline`), cobertura (`coverage_eligible`, `coverage_applied`), foto cruda, primera y última vez visto, resuelto, avisado, recordado y visto por el dueño. RLS `tenant_id = current_tenant_id() or internal_scope()` + RESTRICTIVE de dueño o encargado (como `settlement_lines`); sin policies de escritura.
2. **Detección (sondeo, la fuente principal).** Pura en `_shared/paymentDisputes.ts`: de cada pago de `payments/search` o `GET /v1/payments/{id}` salen las devoluciones (`refunds[]`, o una por `transaction_amount_refunded` si la búsqueda no trae el detalle), el contracargo (`status = charged_back`; `status_detail` `in_process` abierto, `settled` perdido, `reimbursed` ganado) y el reclamo (`status = in_mediation`). Lo abierto cuyo pago ya no está en mediación o contracargo se cierra. Los contracargos abiertos se completan con **`GET /v1/chargebacks/{id}`** (con `X-Caller-Id` del vendedor por `GET /users/me`): monto, motivo, `documentation_status`, plazo y cobertura; prioridad para el estado: `coverage_applied` > `documentation_status = review_pending` (en revisión) > `status_detail`. Como MP no documenta una búsqueda de contracargos por pago, se prueba `GET /v1/chargebacks/search?payment_id=` (tope de 15 casos por corrida y alcance) y, si no responde, el contracargo queda armado desde el pago hasta que llegue el aviso.
   - **Edge `settlements`:** la sincronización manual y el cron guardan las disputas de los pagos que traen; el cron suma la ventana `date_last_updated` de 3 días (los contracargos llegan semanas después de la venta). Los negocios **sin** la conciliación (o con la automática apagada) pasan igual por un barrido liviano: pagos actualizados en los últimos 3 días, tope 1.000 por credencial.
   - **Avisos de MP (`mp_webhook`, compatible hacia atrás):** sin `?intent` y con tópico `topic_chargebacks_wh` o `topic_claims_integration_wh` (también `chargebacks` / `claims`), identifica la cuenta por `user_id` (`payment_secrets.secrets.mp_user_id`, sólo conexión por OAuth), vuelve a leer con la credencial de cada negocio el caso (`/v1/chargebacks/{id}` o `/post-purchase/v1/claims/{id}`, sólo si el recurso es un pago) y el pago, y guarda. Nunca usa el cuerpo del aviso como dato. Los avisos de pagos con `?intent` siguen igual.
3. **Escritura y avisos (`_payment_disputes_upsert`, service_role).** Valida el negocio en cada vínculo (línea, intent por `mp_payment_id` o `external_reference`, cobro por `reference` = intent o id del pago), audita `payment_dispute_detected` y `payment_dispute_updated`, y notifica (tipo nuevo **`disputas`**, a los roles dueño y encargado, link a `/ventas?venta=<id>&tab=cobros` o a la conciliación): contracargo nuevo (crítico, con el plazo), reclamo abierto, **devolución hecha desde Mercado Pago con la venta vigente** (las del POS no avisan), resultado del contracargo (a favor o en contra) y **recordatorio 2 días antes del plazo**, una vez. Para no inundar al traer un período viejo por primera vez, las devoluciones y los contracargos ya resueltos de más de 15 días no avisan. `payment_dispute_ack` marca como visto (auditado).
4. **Conciliación (vista Procesadores, `conciliacion_procesadores`).** Estados nuevos por línea, aparte del cruce: **Devuelto, Devuelto parcial, Contracargo, Reclamo abierto**. **Neto efectivo:** devolución total o contracargo no ganado = 0 (el resumen, lo acreditado y lo pendiente usan este neto); la devolución parcial no se recalcula (el neto de MP, o el calculado, ya la descuenta); un reclamo retiene la plata y cuenta como **en riesgo**. Tarjetas con monto y cantidad que filtran, filtro "Devoluciones y contracargos", "En riesgo" y "Neto perdido", frases del resumen, lista de **contracargos y reclamos abiertos de cualquier fecha** con el plazo, detalle de la línea con línea de tiempo y plazo, y columna Disputa en el Excel.
5. **Ventas.** Marcas "Contracargo" (o "Contracargo ganado"), "Devuelto por MP" y "Reclamo abierto" en la lista (abren la pestaña Cobros) y en cada cobro del detalle con la tarjeta de la disputa (estado, motivo, documentación, cobertura, n° de caso, plazo con días restantes, línea de tiempo, "Marcar como visto"); filtro **"Con alertas"** (`?alertas=1`). **Panel del dueño:** tarjeta con las alertas sin ver y links a Ventas y a la conciliación.
6. **Plan (CLAUDE.md §6).** `alertas_contracargos` **BASE** (`is_basic = true`, grupo pagos, todos los planes): es plata del negocio en riesgo y sólo requiere Mercado Pago conectado. Gating real en `_payment_disputes_upsert` y en las Edges (`disputesEnabled`). Las vistas de conciliación siguen dentro de `conciliacion_procesadores` (Pro+), que ya está gateada. Copy en `featureInfo.ts`; la comparación de planes la toma de la matriz. Los datos de las disputas los ve sólo el dueño o el encargado (RLS), igual que comisiones e impuestos.

### Alternativas descartadas

- **Sólo webhooks:** el aviso es de la aplicación (no por pago), requiere configurar los tópicos en "Tus integraciones" y sólo identifica cuentas conectadas por OAuth; el sondeo diario cubre todo y el aviso adelanta.
- **Estado de disputa dentro de `match_status`:** mezcla dos preguntas (¿cierra con una venta? y ¿la plata sigue siendo mía?); son dimensiones distintas y una línea puede estar Conciliada y con Contracargo.
- **Recalcular el neto de las devoluciones parciales proporcionalmente:** no está documentado si `net_received_amount` se actualiza con la devolución; el cálculo propio ya la descuenta y recalcular la contaría dos veces.
- **Avisar todas las devoluciones:** las que hizo el negocio desde el POS (venta anulada o devuelta) son ruido.

### Consecuencias

- **Deploy en orden:** migración `20261027100000_payment_disputes.sql` (después de ADR-061) → Edges `settlements` (verify_jwt = true) y `mp_webhook` (pública, como hoy) → front. Sin la migración, el front no muestra marcas ni tarjetas (las lecturas fallan en silencio) y las Edges fallan sólo en el paso de disputas (la sincronización sigue). **Manual:** en la aplicación de Mercado Pago, "Tus integraciones" > Webhooks, suscribir `topic_chargebacks_wh` y `topic_claims_integration_wh` a `https://<proyecto>.supabase.co/functions/v1/mp_webhook` (sin `?intent`).
- **Riesgos y supuestos a validar con un caso real:** la forma exacta del aviso de contracargos (`data.id` = id del caso, `user_id`), la búsqueda de casos por pago (no documentada), si `payments/search` acepta `range=date_last_updated` y trae `refunds[]`, el significado de `status_detail` `settled` y `reimbursed`, y que el reclamo apunte a un pago (`resource = payment`); conexiones por token manual no tienen `mp_user_id` (sólo sondeo diario). Costo de API: una búsqueda más por credencial y día, y hasta 15 casos por corrida.
- **Pendiente:** subir la documentación desde NinjaPos (`POST /v1/chargebacks/{id}/documentation`), resumen diario por email, registrar la devolución en el POS desde la alerta, otros procesadores (Payway, archivos con contracargos).
- **Tests:** `tests/unit/paymentDisputes.test.ts` (normalizador con fixtures de pagos y del caso de contracargo de la documentación, estados, cierre de lo viejo, avisos y reclamos, estado de la línea, neto efectivo, resumen, filtros, plazo, línea de tiempo, marcas y conteo del panel), `tests/integration/rls-payment-disputes.test.ts` (RLS por negocio y rol, sin escritura por PostgREST, upsert sólo del servidor con vínculo, origen, avisos y auditoría, gating, `payment_dispute_ack`, `rls_internal_scope_leaks`), humo de la migración sobre PGlite con stubs y `deno check` de las dos Edges.

**Fuentes:** [MP, gestionar contracargos](https://www.mercadopago.com.ar/developers/en/docs/checkout-pro-preferences/chargebacks/manage) · [MP, obtener contracargo](https://mercadopago.com.pe/developers/en/reference/chargebacks/_chargebacks_id/get) · [MP, webhooks y tópicos](https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks) · [MP, buscar reclamos](https://mercadopago.com.br/developers/en/reference/claims/search-claims/get) · [MP, detalle de reclamo](https://mercadopago.cl/developers/en/reference/claims/get-claim-details/get) · [MP, búsqueda de pagos](https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-api-payments/search-payments/get).

---

## ADR-063: Balanza y cajón de dinero: reglas por negocio o sucursal, equipos por caja y apertura auditada

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/balanza-cajon`; migraciones `20261026100000` y `20261026100100` sin aplicar; presets de balanza sin validar con equipos) · **Hitos:** F10 · H23 (etiquetas de balanza), H24 (lectura de balanza), H26 (diagnóstico) y F17 · H119 ("abrir el cajón sin venta con PIN") · **Base:** ADR-049 (herencia y registros por caja), ADR-051 y ADR-060 (PIN de supervisor), ADR-052 (`internal_scope`), ADR-053 (transportes Web Serial, WebUSB y puente local).

### Contexto

El dueño pidió productos pesables con balanza y apertura del cajón por caja, y que se entienda bien qué se configura por sucursal y qué por caja. Hasta acá el POS vendía por kilo tipeando los gramos, no reconocía las etiquetas de la balanza etiquetadora, la prueba de balanza era un aviso de "pendiente" y el cajón "requería un conector local" que no existía.

### Decisión

1. **Dos niveles, una regla para el dueño.**
   - **Reglas (por negocio, grupo o sucursal):** vende pesables (`scale_enabled`), formato de la etiqueta de balanza (`scale_label`), abrir el cajón al cobrar en efectivo (`drawer_open_on_cash`) y abrirlo sin venta (`drawer_no_sale`: `allow`, `pin`, `deny`). Son columnas de `pos_settings` en la capa de herencia de ADR-049 (whitelist `config_field_type` y espejo `CONFIG_FIELDS`), pisables por grupo o sucursal y **nunca por caja**: si la política del cajón se pudiera pisar por caja, el cajero elegiría la caja más permisiva.
   - **Equipos (por caja):** tabla nueva `register_hardware` (una fila por caja: `scale` y `drawer` jsonb). Es un **registro de equipos** como `payment_terminals` y `printers`, no configuración heredable: lo que está enchufado en una caja no se hereda de la sucursal. No depende de `multi_caja` (un kiosco con una sola caja también tiene balanza). Escritura sólo por `register_hardware_set` (dueño o encargado con acceso a la sucursal, forma validada por `register_hardware_error`, impresora de la sucursal y de esa caja, auditoría `register_hardware_changed`). Lectura por RLS con las sucursales del usuario e `internal_scope()`.
   - **Lo de la PC (navegador):** el puerto emparejado por Web Serial o WebUSB y el token del puente local en `localStorage` (`ninja.hw.pair.<caja>.<scale|drawer>`, `ninja.hw.bridge`), como en ADR-053.
   - UI: Configuración, Hardware con una explicación de los dos niveles, "Reglas de balanza y cajón" dentro de `ScopedSection` (negocio, grupo o sucursal, con "heredado / personalizado"; el formato de etiqueta tiene editor propio con etiqueta de ejemplo) y la tabla **"Qué tiene cada caja"** (balanza y cajón de la caja, reglas efectivas de su sucursal, botón Equipos con el modal de la caja, emparejamiento en esta PC y pruebas).
2. **Etiquetas de balanza (H23)** en `lib/barcode/scaleLabel.ts`: EAN-13 `[prefijo 20-29][código 4-6][DV del valor opcional][valor][DV]`, precio o peso, decimales 0 a 3, validación del DV del EAN y del DV del valor (pesos GS1 2-, 3, 5+, 5- para 4 y 5 dígitos). El escáner del POS lo prueba antes de la búsqueda común sólo si la sucursal vende pesables; el código embebido se busca como PLU (tal cual, sin ceros o a 6 dígitos) o SKU (`productsApi.findByScaleCode`). Peso embebido: cantidad = peso. Precio embebido: cantidad = importe / precio por kg con 3 decimales (el total puede diferir unos centavos del impreso; el servidor sigue siendo la fuente del precio, ADR-056). La línea entra como pesada (`unit = kg`).
3. **Lectura de balanza (H24)** generalizando los transportes de ADR-053 a `lib/hardware`: `FrameSplitter` y `parseFrame` (tramas ASCII con CR, LF, STX y ETX; número por expresión regular; marcas ST, US y OL), presets **Systel, Kretz, Moretti** (estado `verified: false`, con hint y trama cruda en la prueba para ajustar) y **genérico** (continuo o a pedido, comando con escapes, regex propia, kg o g), `StableDetector` (manda la marca de la balanza; si no la da, N lecturas dentro de ±2 g durante 400 ms), tara del POS y `ScaleReader`. `ScaleSimulatorTransport` para demos y tests. En el POS el editor de peso muestra el peso en vivo y completa los gramos con el peso estable; tipear sigue andando (la balanza nunca traba la venta).
4. **Cajón** (`lib/hardware/drawer.ts`, `devices.ts`): pulso ESC/POS `ESC p m t1 t2` por la impresora de la caja (pin 2 o 5, tiempos en ms) por Web Serial, WebUSB o el puente local (puerto serie de la PC o TCP 9100 de una impresora de red); `DrawerSimulatorTransport`. **Toda apertura pasa por `cash_drawer_open(caja, tipo, motivo, venta)`**: decide con la política efectiva de la caja (`_effective_config`), con el turno abierto de esa caja y `shift_owner_ok`, registra la fila en `cash_drawer_events` (permitida o rechazada, con usuario, caja, turno, motivo, supervisor y venta) y en `audit_logs` (`cash_drawer_opened` o `cash_drawer_denied`), y devuelve `allowed`. El navegador manda el pulso sólo con `allowed = true`.
   - `sale`: la venta tiene que ser del turno de esa caja, de los últimos 15 minutos y con un cobro en efectivo; una sola apertura por venta (índice único parcial).
   - `no_sale`: motivo obligatorio; `deny` rechaza, `pin` llama a `require_supervisor('abrir_cajon')` (un supervisor por rol pasa con su sesión; si no, `supervisor_required:abrir_cajon` y `withSupervisor` reintenta con el token del header).
   - `test`: sólo dueño o encargado, sin turno, aunque la política prohíba (es la prueba de hardware).
   - "Esta caja no tiene cajón" rechaza todo con `no_drawer` y el POS no muestra el botón.
5. **PIN:** acción nueva `abrir_cajon` en `security_default_policy()` y en `PIN_ACTIONS`; `pin_action_required` la devuelve siempre en true (como el cierre forzado): quien decide si hace falta PIN es la política del cajón de la sucursal, no el interruptor de Seguridad. En Seguridad figura como "Siempre" y se eligen sus modos (ADR-060).
6. **Features (CLAUDE.md §6):** `balanza` y `cajon_dinero` son **BASE** (`is_basic`, grupo `pos`, en los cuatro planes): vender por kilo y abrir el cajón son parte de pagar cualquier plan; no hace falta un `hardware_pro`. Gating real donde se escribe: guardas en `pos_settings` y `config_overrides` (prender la balanza o tocar la política), `register_hardware_set` (balanza prendida o cajón configurado) y `cash_drawer_open`. Copy en `featureInfo.ts`; la comparación de planes la deriva de la matriz.

### Alternativas descartadas

- **Equipos de la caja como override de caja en `config_overrides`:** la capa de caja exige `multi_caja` y un negocio de una caja quedaría sin balanza; además lo enchufado no se hereda.
- **Política del cajón por caja:** permitiría saltear el PIN eligiendo la caja más permisiva.
- **Confiar en el navegador para decidir la apertura:** el servidor decide y registra cada pedido. Límite físico honesto: quien tenga la impresora puede mandarle el pulso por fuera del sistema (igual que la llave del cajón); el sistema garantiza que toda apertura **desde NinjaPOS** queda autorizada y auditada.
- **QZ Tray o un agente nativo:** el puente local de ADR-053 ya resuelve serie y TCP sin binarios nuevos.

### Consecuencias

- Deploy: migraciones `20261026100000_features_balanza_cajon` y `20261026100100_balanza_cajon`. Recrean `config_field_type` y `config_field_error` (desde `20261019100000`) y `security_default_policy` y `pin_action_required` (desde `20261019100000`): cualquier rama que los toque tiene que partir de acá. Sin Edges. Front tolerante: sin la migración no hay equipos (la tabla no existe) y el POS sigue como antes.
- La cadena completa de migraciones corre sobre PGlite (salvo las tres que crean `pg_cron` o `pg_net`) y un recorrido de humo de las RPC dio lo esperado.
- **Pendiente:** validar Systel, Kretz y Moretti con equipos reales (y ajustar presets), corte de papel e impresión de tickets ESC/POS directo (F4), re-pesar una línea ya cargada, balanza en el autoservicio, avisar al supervisor de aperturas sin venta frecuentes, listar `cash_drawer_events` en el arqueo de caja.
- Tests: `tests/unit/scaleLabel.test.ts`, `tests/unit/scaleReader.test.ts`, `tests/unit/drawer.test.ts` y RLS `tests/integration/rls-balanza-cajon.test.ts` (equipos por rol y negocio, forma e impresora, whitelist, política permitido, con PIN y prohibido con token de un uso, venta en efectivo una sola vez, prueba por rol, caja sin cajón, bitácora y auditoría).


---

## ADR-067: Reintegro por Mercado Pago en las devoluciones y ficha del cliente 360

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/reintegro-mp-cliente360`; migraciones `20261030100000`, `20261030100100` y `20261030100200` sin aplicar; Edge `mp_refund` sin desplegar) · **Base:** ADR-051 y ADR-060 (PIN de supervisor por acción y sus modos), ADR-052 (`internal_scope`), ADR-057 (credenciales por sucursal: `secret_store_id` del intent), ADR-061 (detalle de la venta y conciliación de procesadores), ADR-064 (disputas con origen `pos` / `provider`) · **Numeración:** ADR-065 y ADR-066 quedan para otras ramas (impuestos y contabilidad).

### Contexto

Lucas pidió (2026-10-12) dos cosas: **H21h**, devolver la plata por Mercado Pago cuando la venta se cobró con MP (QR, link o Point), además de efectivo o vale; y **H31b**, una ficha del cliente completa, en página propia, con todo lo que pasó con ese cliente. Hoy una devolución de una venta cobrada con MP se reintegra en efectivo o vale, o el dueño la hace a mano en el panel de MP (y ADR-064 la avisa como "devolución desde Mercado Pago"). El historial del cliente (`CustomerHistoryModal`) muestra vale, compras y devoluciones.

### Decisión

**H21h · Reintegro por Mercado Pago**

1. **Dos tiempos, sin perder la devolución ni la plata.** `return_sale_v2` (copia de la última definición, `20261013120000`, con `p_mp_payment_id` y `p_mp_amount`; se dropea la firma de 7 argumentos y `exchange_sale` sigue resolviendo porque usa argumentos con nombre) registra la devolución en una sola transacción: stock, ítems, la **parte por Mercado Pago** y el **resto** como hasta hoy (efectivo, vale o cuenta corriente, con la política del negocio aplicada sólo al resto). La pata MP deja una fila `mp_refunds` en `pending`. Después la Edge `mp_refund` llama a Mercado Pago. Si MP no puede, `mp_refund_fallback` lo pasa a efectivo (turno propio) o a vale.
2. **Validaciones en el servidor:** feature `reintegro_mp`; ajuste del dueño prendido; motivo de devolución obligatorio; el cobro es de la venta y su intent es de Mercado Pago (`mercadopago` o `mercadopago_point`) aprobado; plazo de **180 días** desde el cobro (`mp_refund_window_days()`); monto ≤ lo cobrado (menor entre el cobro y el intent) menos lo ya reintegrado desde el POS (`pending`, `processing`, `approved`, `in_process`, `error`) y las devoluciones hechas desde MP que ya conocemos (`payment_disputes` con origen `provider`); y ≤ lo devuelto. Lock del cobro (`for update`) para que dos devoluciones no se pasen del tope.
3. **Permiso:** acción de PIN nueva **`reintegro_mp`**, siempre pedida (como el cierre forzado y el cajón): el dueño y los supervisores por rol pasan sin PIN (`require_supervisor`); un cajero necesita el token del supervisor (cualquier modo de ADR-060). Copias de `security_default_policy` y `pin_action_required` (desde `20261026100100`). Queda quién autorizó en `mp_refunds.authorized_by`.
4. **Edge `mp_refund` (verify_jwt = true).** `_mp_refund_claim` (service_role) valida negocio, que lo pida quien lo registró o un dueño o encargado, feature y estado, y lo pasa a `processing` (o lo retoma si quedó trabado más de 2 minutos). Usa **la credencial exacta con la que se creó el cobro** (`secret_store_id` y `mp_env` del intent, `tenantMpCredential`), resuelve el id numérico del pago (`mp_payment_id`, o el `reference_id` del pago de la orden en la Orders API) y llama a **`POST /v1/payments/{id}/refunds`** con `{ amount }` y **`X-Idempotency-Key = <id de la fila>:<secuencia>`**. La secuencia sólo cambia después de un rechazo firme (MP devolvería el mismo rechazo con la misma clave); tras un error dudoso (red, 5xx, 408, 409, 429) se reintenta con la **misma** clave y MP no duplica. Clasificación pura en `_shared/mpRefund.ts`: `approved`, `in_process` (cuenta como hecho), `failed` (rechazo con código honesto: saldo insuficiente, plazo vencido, pago en disputa, ya devuelto, monto inválido, pago no encontrado, credencial) y `error` (no se sabe; sólo se ofrece reintentar, nunca efectivo a ciegas). `_mp_refund_finish` guarda el id y el estado de la devolución de MP y audita (`mp_refund_requested`, `mp_refund_approved`, `mp_refund_in_process`, `mp_refund_failed`, `mp_refund_error`, `mp_refund_fallback`).
5. **Coordinación con ADR-064.** Al aprobarse, `_mp_refund_finish` inserta la devolución en `payment_disputes` con clave `mp_refund:<id de MP>` y **origen `pos`** (si la sincronización ya la había traído, corrige el origen). Como la actualización de `_payment_disputes_upsert` no toca el origen, la sincronización posterior no la avisa como "devolución hecha desde Mercado Pago" y Ventas no la marca "Devuelto por MP". La conciliación muestra **"Devuelto (POS)" / "Devuelto parcial (POS)"** cuando todas las devoluciones de la línea son del POS (`lineDisputeLabel`).
6. **Ajuste del dueño:** `tenant_payment_methods(mercadopago).config.mp_refunds_enabled`, apagado por defecto, sólo por `mp_refund_settings_save` (dueño, auditado). Un trigger (`tpm_mp_refunds_guard`, distingue cliente de RPC por `current_user`) impide cambiarlo por PostgREST, porque `tpm_write` deja escribir `config` también al encargado. En Configuración, Medios de pago, Mercado Pago: "Permitir devolver el dinero por Mercado Pago".
7. **Tabla `mp_refunds`:** venta, devolución, cobro, intent, sucursal, monto, estado, ids de MP, error, credencial y ambiente, intentos y secuencia de idempotencia, quién pidió, quién autorizó y el respaldo (medio, quién, cuándo, movimiento o vale). RLS `tenant_id = current_tenant_id() or internal_scope()` + RESTRICTIVE de alcance de sucursal (como `sales_branch_scope`); sin escritura del cliente.
8. **UI.** Wizard de devolución: tarjeta "Reintegrar por Mercado Pago" (sólo si hay un cobro de MP con saldo, en plazo, con feature y ajuste; si no, explica por qué), elección del cobro si hay más de uno, monto (por defecto el máximo) y el resto por efectivo o vale; tras registrar llama a la Edge y muestra el estado con **Reintentar**, **Devolver en efectivo** y **Dar un vale** según corresponda; el comprobante de la devolución dice "Mercado Pago". Detalle de la venta, pestaña Cobros: "Reintegros desde el POS" con el mismo panel (sirve para retomar uno que quedó pendiente).

**H31b · Ficha del cliente 360**

9. **Página `/clientes/[id]`** (accesos desde el nombre y un botón en la lista de clientes y "Ver ficha completa" en el historial): perfil y datos fiscales, segmentos, 8 indicadores, por sucursal, compras por mes (12 meses con promedio), medios de pago, productos más comprados, notas internas y línea de tiempo con filtros por tipo y fecha, filtro de sucursal arriba, "Ver más" por cursor y el detalle de la venta al tocar un movimiento. **Exportar XLSX** con Resumen, Línea de tiempo (con los filtros), Productos, Medios de pago y Por sucursal.
10. **RPC rápidas (SECURITY DEFINER, todo validado adentro):** `customer_360_summary(cliente, sucursal?)` e `customer_360_timeline(cliente, tipos?, desde?, hasta?, sucursal?, límite, cursor)`. Negocio del JWT y membresía activa; **alcance de sucursal con `report_store_filter`** (el mismo criterio que los reportes: el cajero de Norte no ve ni suma lo de Centro y no puede pedir otra sucursal); contracargos y gestión de cobranza sólo para dueño o encargado; deuda y deuda vencida con `account_open_debits`. La línea de tiempo une ventas, devoluciones, cuenta corriente, gestiones de cobranza, vales y saldo a favor, cobros en espera, reintegros por MP, disputas y notas; cada rama trae como mucho límite + 1 filas por índices por cliente (nuevos: ventas, devoluciones, vales, cuenta corriente y cobros en espera por cliente y fecha), y el cursor es (fecha, id).
11. **Segmentos en el front** (`lib/customers/c360.ts`, puro y testeado) con los indicadores y el umbral VIP que manda el servidor (percentil 90 de lo comprado por cliente en 12 meses, con al menos 10 clientes): Sin compras, Nuevo, Frecuente, VIP, En riesgo, Inactivo, Con deuda, Deuda vencida, Devuelve mucho.
12. **Notas internas (`customer_notes`):** fijables, baja lógica, RLS `tenant_id = current_tenant_id() or internal_scope()`, alta por `customer_note_add` (cualquier miembro activo) y baja por `customer_note_delete` (la autora o un encargado), auditadas.

**Plan (CLAUDE.md §6)**

13. `reintegro_mp` **OPTIONAL**, grupo pagos, Pro, Business y Enterprise (va con Mercado Pago, que es Pro+); los planes a medida heredan `mercado_pago`. `requires: mercado_pago`. Gating real en `return_sale_v2`, `mp_refund_settings_save` y `_mp_refund_claim`.
14. `clientes_360` **OPTIONAL**, grupo clientes, Pro, Business y Enterprise (CRM liviano, con grupos de clientes y listas); los planes a medida heredan `grupos_clientes`. El historial básico sigue BASE con `clientes`. Gating real en las tres RPC (`_c360_assert`). Copy de las dos en `featureInfo.ts`; la comparación de planes las toma de la matriz.

### Alternativas descartadas

- **Llamar a MP antes de registrar la devolución:** si MP devuelve y la devolución falla (cantidades, caja), la plata salió sin registro. Al revés, la devolución queda y el reintegro pendiente se ve y se retoma o se pasa a efectivo o vale.
- **Registrar la devolución dentro de la Edge:** obliga a pasar el token del supervisor y el turno por la Edge y mezcla dos transacciones; la RPC ya hace todo eso.
- **Orders API (`POST /v1/orders/{id}/refund`) para QR dinámico y Point:** el pago de la orden existe en `/v1/payments` (su `reference_id`), y la API de pagos permite parcial con un solo camino para QR, link y Point. Queda como alternativa si MP rechaza devoluciones de pagos de órdenes por la API de pagos.
- **Línea de tiempo con una vista o con RLS de invocador:** varias tablas sólo las lee `service_role` (`account_open_debits`) y las reglas de rol (disputas, cobranza) y de sucursal son más claras en una sola función.
- **Segmentos en SQL:** son reglas comerciales que van a cambiar; en TS se testean y se ajustan sin migración.

### Consecuencias

- **Deploy en orden:** `20261030100000_features_reintegro_mp_cliente_360` → `20261030100100_reintegro_mp` (después de ADR-063 y ADR-064) → `20261030100200_cliente_360` → Edge `mp_refund` (verify_jwt = true) → front. Sin las migraciones, el wizard no ofrece MP (las opciones fallan en silencio) y la ficha 360 muestra el error de carga.
- **Riesgos a validar con un caso real (sandbox de MP):** que `POST /v1/payments/{id}/refunds` acepte pagos de órdenes (QR dinámico y Point) y pagos con tarjeta de Point; los textos exactos de error de MP (la clasificación busca palabras clave y cae en "Mercado Pago rechazó la devolución"); el plazo real (180 días es el general de MP); que la respuesta 201 traiga `status` y que una devolución quede `in_process` a veces. Si la cuenta de MP no tiene saldo, MP rechaza y se ofrece efectivo o vale. Sin `pin_supervisor` en el plan, sólo los supervisores por rol pueden reintegrar por MP.
- **Pendiente:** comprobante de devolución con el id de la devolución de MP impreso; el mismo patrón para Payway y otros medios con API de devolución; en la ficha 360, comprobantes con reimprimir y reenviar, cuenta Debe / Haber con saldo acumulado, PDF del estado de cuenta, adjuntos, cambios de datos auditados y acceso desde el selector de cliente del POS.
- **Tests:** `tests/unit/mpRefund.test.ts` (clasificación de MP, orden, tope, opciones, mensajes, acción de PIN y "Devuelto (POS)"), `tests/unit/c360.test.ts` (segmentos, títulos, montos, páginas, fechas, Excel, normalización), `tests/integration/rls-reintegro-mp.test.ts` y `tests/integration/rls-cliente-360.test.ts`, `deno check` de `mp_refund` y humo de la cadena completa de migraciones sobre PGlite (reintegro con PIN, tope, claim con clave de idempotencia, origen `pos` sin aviso, respaldo en vale; ficha con alcance de sucursal, cursor, notas y gating; `rls_internal_scope_leaks` vacío).

**Fuentes:** [MP, crear reembolso](https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-api-payments/create-refund/post) · [MP, reembolsos y cancelaciones](https://www.mercadopago.com.ar/developers/es/docs/checkout-api-payments/payment-management/cancellations-and-refunds) · [MP, idempotencia](https://www.mercadopago.com.ar/developers/es/docs/checkout-api-payments/integration-configuration/idempotency).

---

---

## ADR-066: Contabilidad v1: plan de cuentas, asientos automáticos por triggers, mapeos, cierre mensual, libros y export a estudios (F18 · H109)

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/contabilidad` sobre `integ/tanda-j`, migraciones `20261029100000` a `20261029100300` sin aplicar) · **Base:** ADR-050 y ADR-059 (compras, órdenes de pago, tesorería), ADR-061 y ADR-064 (conciliación de procesadores y disputas), ADR-062 (asientos de NubCeo), ADR-052 (`internal_scope`) · **Numeración:** ADR-065 queda para la rama del motor de impuestos. Documento vivo: [`31-contabilidad.md`](./31-contabilidad.md).

### Contexto

La auditoría fiscal (§6) marcó la contabilidad como faltante P1: sin plan de cuentas, asientos, centros de costo, cierre mensual, libros ni export a estudios. El criterio del auditor: el POS no tiene que ser el sistema contable del estudio; tiene que generar asientos correctos, inmutables y trazables desde los documentos y exportarlos. Restricción: no tocar `create_sale`, `close_cash_shift`, `_pc_complete` ni el resolutor de precios (otra rama cambia `create_sale` por impuestos).

### Decisión

1. **Modelo propio por negocio** (`acc_settings`, `acc_accounts` en árbol con imputable, tipo y código externo, `acc_cost_centers` uno por sucursal, `acc_mappings`, `acc_periods`, `acc_entries` + `acc_entry_lines`, `acc_issues`) con plantilla argentina comercial (`acc_install_template('comercial_ar')`: Caja, Bancos, Valores a depositar, Mercado Pago, Deudores por ventas, Tarjetas a cobrar por adquirente, IVA DF y CF, percepciones y retenciones, Proveedores, Cheques diferidos, Mercaderías, CMV, Ventas, Devoluciones, comisiones, contracargos, faltantes y sobrantes) y todas las reglas generales.
2. **Asientos por triggers diferidos sobre las tablas existentes** (`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`): corren al commit, con la venta y sus cobros ya insertados, sin cambiar firmas ni RPC. Cubren ventas (por medio de cobro con adquirente, propina, vuelto, IVA por alícuota, CMV opcional) y su anulación, devoluciones, cuenta corriente (cobro y anulación, interés, condonación, ajustes, cargos manuales), cierres de caja (faltante o sobrante), ingresos y retiros manuales de caja, comprobantes de proveedor (con percepciones y tipo de cambio) y su anulación, pagos y órdenes de pago (medios, tesorería, cheques y retenciones) y su anulación, movimientos de tesorería (transferencias entre cuentas) y su anulación, acreditación de liquidaciones de procesadores (comisión, impuestos, neto, diferencia) y contracargos o devoluciones desde el procesador. **Nunca frenan la operación:** el error queda en `acc_issues` (Resumen, Reintentar) y la venta se guarda igual.
3. **Idempotencia y trazabilidad:** un asiento automático por `(source_type, source_id, source_event)` entre los vigentes; las anulaciones son contra-asientos con su fecha; `acc_generate(desde, hasta, rehacer)` trae lo que falte y, con rehacer, da de baja lógica los automáticos del rango en meses abiertos y los rearma con los mapeos de hoy.
4. **Mapeos configurables:** `acc_account_for(concepto, calificador, sucursal)` busca calificador exacto (`credit:payway`), `*:adquirente`, el medio y `*`, y en cada nivel la regla de la sucursal (espejo TS `resolveMapping`). Calificadores: medio y adquirente o proveedor (del cupón o del intent, sin `_point`), alícuota, proveedor, tipo de tributo, cuenta de tesorería, tipo de movimiento, procesador.
5. **Inmutabilidad en la base:** renglones sin update ni delete; asiento sólo con baja lógica (regeneración) o numeración oficial; balance (debe = haber, dos renglones o más) por trigger diferido; altas y bajas bloqueadas en meses cerrados. Las guardas dejan pasar sólo el borrado en cascada del negocio.
6. **Cierre mensual:** `acc_period_close` exige mes terminado y anteriores con asientos cerrados, numera el Diario correlativo por ejercicio y bloquea; `acc_period_reopen` sólo el dueño, con motivo, el último cerrado. Lo que llega con fecha de un mes cerrado va al primer día del mes abierto siguiente con la nota.
7. **Libros:** vista `acc_journal_lines` (`security_invoker`), `acc_trial_balance` (saldo anterior de patrimoniales desde el inicio y de resultados desde el ejercicio), `acc_vat_sales` y `acc_vat_purchases` (resúmenes con los datos de hoy), `acc_periods_overview`; árbol, resultados, mayor y resúmenes en `lib/accounting/journal.ts`. XLSX con el helper de `lib/utils/xlsx`.
8. **Export a estudios:** Tango Gestión, Holistor, Xubio, Colppy y CSV a medida (`lib/accounting/exporters.ts`), detallado o resumido por día o mes y sucursal, con código externo de la cuenta, Latin-1 para los de escritorio y UTF-8 con BOM para los web. Los layouts son una propuesta documentada a validar con cada estudio; el CSV a medida cubre lo que no coincida.
9. **Seguridad:** lectura `tenant_id = current_tenant_id() or internal_scope()` + RESTRICTIVE dueño o encargado; sin escritura por PostgREST (se revocan insert, update y delete); RPC `SECURITY DEFINER` con `search_path` y `audit_logs` (`acc_setup`, `acc_settings_saved`, `acc_account_*`, `acc_mapping_set`, `acc_generate`, `acc_regenerate`, `acc_entry_manual_created`, `acc_entry_reversed`, `acc_period_closed`, `acc_period_reopened`, `acc_issue_dismissed`). Las funciones internas no tienen `execute` para el cliente.
10. **Feature (CLAUDE.md §6):** `contabilidad` OPTIONAL (`is_basic=false`, grupo reportes) en **Business y Enterprise**; planes a medida heredan `tesoreria`. Gating real en `acc_assert` (todas las RPC, también las de libros) y en `acc_tenant_active` (los triggers no generan sin la feature). Copy en `featureInfo.ts`; la comparación de planes la deriva de la matriz. `export_contable` (Pro) e `integracion_erp` (ADDON) quedan para H108 y los conectores.
11. **UI:** grupo de navegación **Contabilidad** (dueño y encargado, candado sin la feature): Resumen (alta, KPIs, generar o rehacer, pendientes), Asientos (filtros, detalle con link al documento, manual y reversión), Libros (Diario, Mayor, sumas y saldos, resultados, IVA ventas y compras, export), Plan de cuentas (árbol, centros de costo), Mapeos (por concepto con excepciones) y Cierres (meses y configuración).

### Alternativas descartadas

- **Generar desde `create_sale` y las RPC de cada módulo:** las tocan otras ramas; el trigger diferido sobre las tablas cubre ventas, anulaciones, devoluciones y documentos de cualquier camino (RPC, cron, service role) sin cambiar firmas.
- **Sólo generación por lotes (sin triggers):** dejaba la contabilidad desactualizada hasta que alguien la corriera; se mantiene como red de seguridad y para rehacer.
- **Cola de eventos y cron:** suma infraestructura sin ganancia: la generación por documento es barata y el error queda en `acc_issues`.
- **Asientos resumidos guardados:** se guardan detallados (trazables al documento) y se resumen al exportar; la sumatoria del libro no cambia.
- **Borrado físico al regenerar:** contradice la baja lógica de datos de negocio; los asientos rehechos quedan con `deleted_at` y motivo.
- **Libro IVA Digital acá:** es un régimen de información con formato propio (H108) y depende del motor de impuestos y de F3.

### Consecuencias

- **Deploy:** migraciones `20261029100000` a `20261029100300` en orden, después de las de ADR-059, ADR-061, ADR-062 y ADR-064. Sin Edges. Front tolerante: sin la migración, la pantalla muestra el alta y la RPC falla con mensaje.
- **Costo acotado:** cada venta, cobro y documento de un negocio **sin** contabilidad hace una búsqueda por clave primaria en `acc_settings` al commit; con contabilidad, el armado del asiento (unas decenas de filas).
- **Riesgos:** el IVA de ventas sale de `products.tax_rate` con IVA incluido (la rama de impuestos cambia la fuente); el CMV perpetuo usa el costo vigente al generar; los impuestos de la liquidación van enteros a una cuenta de retenciones sufridas (incluyen el IVA de la comisión); los layouts de export no están validados con un estudio real; una venta insertada sin cobros en otra transacción queda pendiente hasta el próximo Generar.
- **Pendiente:** IVA por alícuota real, exento, no gravado, internos y percepciones de ventas (H103 y H105), Libro IVA Digital y regímenes (H108), Bejerman y conectores con API (`integracion_erp`), diferencias de cambio, cheques de terceros recibidos de clientes, apertura de saldos de tesorería, asientos de recepciones sin factura, desglose de impuestos de procesadores, ajuste por inflación.
- **Tests:** `tests/unit/accounting.test.ts` (IVA incluido y redondeo, mapeos, balanceo, resúmenes, sumas y saldos, resultados, mayor, exportadores, cierres, feature) y RLS `tests/integration/rls-contabilidad.test.ts` (gating, RLS por rol y negocio, venta, manual y reversión, libros, cierre y reapertura, `rls_internal_scope_leaks`). La cadena completa de migraciones corre sobre PGlite con un recorrido de humo de todos los eventos (venta con vuelto, Payway y propina, anulación, devolución a cuenta, cobro de cuenta corriente y anulación, faltante y retiro de caja, factura con percepción, NC en dólares, orden de pago con cheque y retención, tesorería y transferencia, liquidación de Mercado Pago, contracargo, mapeo faltante y reintento, manuales, inmutabilidad, RLS, libros, cierre, evento atrasado, regeneración y baja en cascada).

---

---

## ADR-068: Base fiscal: catálogo de IVA, impuestos internos, condición fiscal, percepciones con padrones y retenciones sugeridas

**Fecha:** 2026-10-12 · **Estado:** aceptada (código en `feat/impuestos`; migraciones `20261028100000` a `20261028100300` sin aplicar; valores normativos orientativos a validar con un contador) · **Hitos:** F18 · H103 (IVA e internos), H104 (condición fiscal y padrones), H105 (percepciones), H106 (retenciones, parte) · **Base:** ADR-043 (auditoría fiscal), ADR-050 y ADR-059 (compras, órdenes de pago), ADR-052 (`internal_scope`), ADR-056 y ADR-058 (precio en el servidor y resolver PRO). **Numeración:** 065 a 067 tomadas por otras ramas.

### Contexto

`products.tax_rate` era un número (21 por defecto) que no distinguía exento de no gravado ni de 0 %, `create_sale` guardaba `tax_total = 0`, no existían impuestos internos, percepciones, retenciones ni padrones y la condición fiscal del cliente tenía cinco valores sin validar el documento en el servidor. La auditoría (ADR-043) pide esto antes de F3: facturar con un IVA de una sola columna da comprobantes que no cierran en el Libro IVA. No se llama a ARCA en este hito.

### Decisión

1. **Catálogo cerrado de IVA** (`tax_iva_rates`): 21, 10,5, 27, 5, 2,5, 0, exento y no gravado con su id de ARCA (AlicIva 3 a 9; 1 no gravado y 2 exento para el Libro IVA). `products.tax_rate_code` manda y `tax_rate` queda como espejo numérico por trigger (compras, import y cualquier cliente viejo siguen escribiendo `tax_rate`; una alícuota fuera del catálogo se rechaza). Backfill por valor (el 0 queda como "0 %", no como exento: lo revisa el dueño). `product_variants.tax_rate_code` pisa al producto. `products.is_service` para el concepto de WSFE. `price_lists.prices_include_tax` (lista final o neta).
2. **Precio final siempre en la venta.** `unit_price` sigue siendo lo que paga el cliente. El resolver (`_resolve_unit_price`, copia de la última, y su espejo TS `resolveUnitPrice`) termina con `_tax_price_to_final` / `priceToFinal`: una lista neta suma el IVA del producto o la variante y los internos "adicionales" se suman al precio. El caso común (lista con IVA, sin internos adicionales) devuelve exactamente lo de antes, así la validación de ADR-056 y la paridad de ADR-058 no cambian. `price_context_snapshot` manda `tax` (si el emisor discrimina, si hay internos y los datos fiscales de los productos sólo cuando algún precio cambia).
3. **Motor (`_sale_tax_compute`, espejo `lib/tax/engine.ts`)**, en centavos enteros con mitad hacia arriba:
   - el total de la venta sin percepciones (con descuentos, promo, cupón, redondeo de caja y envío) se reparte entre las líneas por **resto mayor** en proporción a su bruto;
   - **internos** por línea: monto fijo × cantidad, % sobre el costo × cantidad o % sobre el precio con **tasa nominal** (integra su propia base: efectiva = t / (1 − t), N = G / (1 + IVA + efectiva)); no integran la base del IVA;
   - **IVA por alícuota sobre la base agregada** (lo que pide AlicIva): base = redondeo(Σ(G − I) / (1 + alícuota)), IVA = resto; la base se reparte a las líneas por resto mayor. El IVA de cada alícuota difiere de base × alícuota en un centavo como mucho y cada línea cierra exacto;
   - emisor monotributista o exento: sin IVA discriminado (comprobante C);
   - **paridad probada** con `tests/fixtures/taxMatrix.ts` (10 casos: mixta, descuento repartido, internos de los tres tipos, centavos, monotributo, todas las alícuotas, variante e ítem libre) en unit (TS) y en integración (SQL vía `sale_tax_preview`), corrida también sobre PGlite.
4. **Condición fiscal y comprobante.** Cliente: RI, monotributo, monotributo social, exento, consumidor final, no responsable, sujeto no categorizado, no alcanzado, IVA liberado y exterior, con id de ARCA (RG 5616) y tipo de documento de ARCA (80, 86, 96, 94, 99); CUIT y CUIL con dígito verificador y DNI de 7 u 8 dígitos validados **en el servidor** (sólo cuando cambia el documento, para no romper filas viejas); jurisdicción de IIBB. Negocio: `tax_settings` (condición, CUIT, IIBB, jurisdicción, Convenio Multilateral, alícuota de los ítems sin producto, emite M), con respaldo en `tenant_branding` y espejo de la condición para el ticket. `cbte_letter_infer` / `inferLetter`: RI a RI o monotributista → A (M si corresponde), RI al resto → B, emisor no RI → C, receptor del exterior → E, sin configurar → sin letra. Avisos `cf_identification_required` (tope de `tax_parameters`, parámetro con vigencia) y `receptor_cuit_missing` (A sin CUIT).
5. **Percepciones (el negocio como agente).** `tax_regimes`: jurisdicción × impuesto × rol (percepción o retención) con padrón (ARBA, AGIP o genérico), alícuota general, alícuota por condición, base (neto, neto gravado o total), mínimo de base, mínimo de monto, condiciones alcanzadas, n° de agente y código de régimen; `tax_exemptions` (certificados con % y vigencia, por cliente o proveedor). La alícuota sale del padrón vigente a la fecha de la venta; si el CUIT no figura, la de su condición o la general (sin ninguna, no percibe y avisa). Las percepciones se **suman al total** después del redondeo de caja, se guardan en `sale_tax_lines` con el id de tributo de WSFE y van como líneas aparte en el ticket. El POS las calcula antes de cobrar con `sale_tax_preview` sobre los mismos ítems que `create_sale` (más garantía y recargos) y no confirma mientras se calculan.
6. **Padrones.** `tax_padron_imports` + `tax_padron_entries` (CUIT, vigencia, alícuota de percepción y de retención, grupo). El archivo se lee **en el navegador por partes** (`PadronReader`; los padrones completos pesan cientos de MB) y se sube en tandas de hasta 5000 filas (`tax_padron_import_start` → `_rows` → `_finish`); por defecto sólo los CUIT de clientes y proveedores. Al cerrar, reemplaza los imports del mismo período y jurisdicción y conserva los de otros meses (ventas con fecha vieja). Diseños de registro documentados en `lib/tax/padron.ts` y `docs/32-impuestos.md`, con fixtures.
7. **Retenciones.** `tax_retention_suggest` arma, con los regímenes de retención y el padrón, las líneas de `supplier_payments.withholdings` sobre lo imputado sin IVA (proporción neto / total de cada comprobante) o sobre el monto; la orden de pago (ADR-059) las sugiere con "Calcular con el padrón". Las sufridas quedan en la vista `tax_suffered` (percepciones de los comprobantes de compra) como registro base para H106 y H108.
8. **create_sale** (copia de `20261019100000`, la última) guarda el desglose: `sales` (letra, foto fiscal del emisor y del receptor, netos, IVA, internos, percepciones; `tax_total` = IVA + internos + percepciones; `discount_total` sigue siendo subtotal − total sin percepciones), `sale_items` (alícuota, precio final repartido, neto, IVA, internos) y `sale_tax_lines`. Mantiene validación de precio, cobro en espera, mesas, delivery, cupón, promo, packs y stock por sucursal; el consumo por lote sigue por su trigger. En el **cobro en espera que se acredita**, una percepción que el monto ya cobrado no cubre (padrón cambiado en el medio) no se percibe y queda el aviso `perception_skipped_pending_charge`.
9. **Reportes y ticket:** `report_iva_ventas` (dueño o encargado, sucursales accesibles): por alícuota, exento, no gravado, internos, percepciones por jurisdicción, por letra y por sucursal; pantalla Reportes > IVA con CSV. Ticket con percepciones antes del total y, en el B, el IVA contenido y otros impuestos nacionales (Ley 27.743).
10. **Features (CLAUDE.md §6):** `impuestos_iva` **BASE** (catálogo, condición fiscal, desglose, reporte: cualquier negocio que factura lo necesita); `impuestos_internos` **OPTIONAL Pro** (rubros puntuales); `percepciones_retenciones` **OPTIONAL Business** (agentes designados: medianos y grandes). Percepciones, retenciones y padrones van en una sola key porque no sirven por separado (la auditoría proponía `padrones`, `percepciones` y `retenciones`). Gating real: `tax_settings_save` y el trigger de productos (`impuestos_iva`), el trigger de productos para internos, las policies de `tax_regimes` y `tax_exemptions`, las RPC de padrones y retenciones y `_sale_tax_compute` (sin la feature no percibe ni calcula internos). Copy en `featureInfo.ts`; la comparación de planes deriva de la matriz.

### Referencias normativas (orientativas: validar con el contador y la norma vigente)

Ley de IVA (texto ordenado 1997), art. 10 (internos discriminados fuera del precio neto gravado) y art. 28 (alícuotas); Ley 24.674 de impuestos internos (la tasa sobre el precio integra su propia base); RG 1415 de ARCA y modificatorias (tipos de comprobante); RG 5616 (condición frente al IVA del receptor en WSFE); RG 2408 (percepción de IVA); Ley 27.743 (Transparencia Fiscal al Consumidor); ARBA, Disposición Normativa Serie B 1/2004 y padrón de regímenes generales; AGIP, padrón de regímenes generales (archivo mensual); Convenio Multilateral (códigos de jurisdicción 901 a 924). Los ids de ARCA (alícuotas, condiciones, documentos, tributos) y el tope de identificación del consumidor final se confirman con `FEParamGet*` y la RG vigente cuando se integre WSFE (F3).

### Alternativas descartadas

- **Guardar precios netos en el producto:** rompe la exhibición de precio final y todo el POS; se eligió precio final siempre y lista neta como opción por lista.
- **IVA redondeado por línea y sumado:** con muchas líneas la suma se aleja de base × alícuota más de lo que tolera AlicIva.
- **Percepción como diferencia tolerada en el pago:** la percepción es parte del comprobante y el cliente la paga; el POS la muestra antes y el servidor exige cubrirla.
- **Subir el padrón entero por Storage y una Edge:** más infraestructura para un archivo que el agente descarga con su clave; la lectura por partes en el navegador alcanza y deja filtrar a los CUIT propios.
- **Descarga programada de padrones:** ARBA exige la clave CIT del agente y el padrón de AGIP pesa mucho; queda como deuda.

### Consecuencias

- Deploy: migraciones `20261028100000_features_impuestos`, `20261028100100_impuestos_base`, `20261028100200_impuestos_motor` y `20261028100300_impuestos_venta`, en orden, después de ADR-064. Recrean `_resolve_unit_price` y `price_context_snapshot` (desde `20261021100200`) y `create_sale` (desde `20261019100000`): cualquier rama que los toque tiene que partir de acá. No tocan `config_field_type` ni `config_field_error`. Sin Edges. El front escribe `tax_rate_code` e internos en productos y `iibb_jurisdiction` en clientes: **migración antes que el front**.
- Ventas viejas: sin desglose (el reporte las cuenta aparte). Productos con `tax_rate` fuera del catálogo quedan en 21 % hasta que se editen.
- **Deuda:** devoluciones y notas de crédito con reversa proporcional de IVA, internos y percepciones (H105, con F3); alícuota por operación según receptor (27 % a RI en ciertos servicios); internos por sucursal y con vigencia por decreto; Convenio Multilateral con coeficientes; constancia de ARCA por CUIT y alertas de CUIT dado de baja; descarga programada de padrones; retenciones de Ganancias (RG 830 con acumulado mensual) y SUSS; certificados de retención en PDF; SICORE, SIRE, Libro IVA Digital y DDJJ de IIBB (H108); un recargo de tarjeta con percepción puede dejar centavos por cobrar al cerrar el pago (el cajero agrega el resto).
- Tests: `tests/unit/taxEngine.test.ts`, `tests/unit/taxComprobante.test.ts`, `tests/unit/taxPadron.test.ts`, `tests/unit/featureInfo.test.ts`; RLS `tests/integration/rls-impuestos.test.ts` (paridad SQL, datos fiscales por rol, regímenes y padrón por rol y plan, percepción en `create_sale` con pago insuficiente, monotributista con alícuota 0, retención sugerida, documento y gating de internos, reporte y `rls_internal_scope_leaks` = 0). Cadena completa de migraciones sobre PGlite con humo de todo lo anterior y de las policies con rol `authenticated`.

## ADR-070: Observabilidad de los webhooks de cobro sin servicios externos (webhook_events y Salud de webhooks)

**Fecha:** 2026-10-13 · **Estado:** aceptada (código en `feat/observabilidad`; migración `20261031100000_webhook_events.sql` sin aplicar; Edges sin desplegar) · **Base:** ADR-052 (`internal_scope`), ADR-048 (log JSON de tiempos en las Edge de cobro). **Numeración:** 069 queda libre para otra rama.

### Contexto

Cuando un webhook de un procesador falla (credencial vencida, API del proveedor caída, monto que no coincide) hoy sólo queda una línea suelta en los logs de cada Edge en Supabase, sin negocio asociado y sin vista de conjunto. Soporte se entera porque el cajero dice que "el QR no se acreditó". No queremos sumar Sentry ni otro servicio, ni dependencias nuevas.

### Decisión

1. **Tabla `webhook_events`** (log técnico, no dato de negocio): `tenant_id` (nullable: hay avisos sin negocio identificable), `provider`, `function_name`, `status` (`ok` procesado, `error`, `ignored` aviso válido sin nada que hacer: ajeno, duplicado, intent ya aprobado), `http_status`, `error` (500 caracteres como máximo, con tokens tapados), `duration_ms`, `payload_ref` (id externo de la notificación, pago, orden o intent). **Nunca el payload** ni secretos. Sin `deleted_at`: se borra físicamente a los **30 días** con el cron `webhook-events-retention` (pg_cron; se omite si no existe). Es distinta de `mp_webhook_events`, que es el dedup de `mp_billing_webhook`.
2. **RLS (ADR-052):** `internal_scope() or (tenant_id = current_tenant_id() and is_tenant_manager())`. Nada de `is_internal()` suelto: `rls_internal_scope_leaks()` sigue en 0. Sin policies de escritura: escribe sólo `service_role`.
3. **Helper Deno `_shared/webhookLog.ts`:** `withWebhookLog(provider, fn, handler)` envuelve el handler de `Deno.serve`. El handler marca `wh.tenant()`, `wh.ref()`, `wh.done()` y `wh.fail()`; `wh.defer()` para el trabajo en segundo plano (`mp_orders_webhook`). Resultado: `error` si se marcó un fallo, si respondió 5xx, 401 o 403 o si lanzó; `ok` si se procesó; `ignored` en el resto. Escribe una línea JSON (`{"evt":"webhook",...}`) y la fila por PostgREST con `service_role` (sin cliente ni dependencias), en segundo plano con `EdgeRuntime.waitUntil` y con timeout de 3 s. **La respuesta del webhook no cambia** y un fallo del registro no lo rompe; una excepción del handler se vuelve a lanzar como antes. Las GET (páginas de retorno del navegador) no se registran.
4. **Instrumentados:** `mp_webhook`, `mp_orders_webhook`, `getnet_webhook`, `payway_webhook`, `nave_webhook`, `gocuotas_webhook`, `directo_webhook`, `clover_webhook`, `modo_webhook` y `mobbex_webhook`. Cambio mínimo: envoltura, `ref` y `tenant` donde se conocen, `done` al aplicar el estado y `fail` en los caminos que ya logueaban un error (sin credencial, el proveedor respondió mal, monto o referencia que no coinciden, excepción).
5. **Panel interno, Operaciones > Webhooks (`/internal/webhooks`):** server component con `createClient({ scope: "internal" })`. RPC `webhook_health(p_hours)` (security invoker, respeta la RLS) con procesados, errores, ignorados, último aviso, último error y duración promedio por proveedor en las últimas 24 h; tarjetas con franja de estado arriba y punto de color (brand book: sin sombras, sin bordes laterales) y tabla de los últimos 20 errores con negocio, status HTTP y referencia. Normalización pura en `lib/internal/webhookHealth.ts`.
6. **No es feature de plan:** es una herramienta de plataforma (Operaciones), no una función que el cliente contrata. No va en `features` ni en la comparación de planes. El dueño puede leer lo suyo por RLS, pero no hay UI de cliente por ahora.

### Alternativas descartadas

- **Sentry, Logflare u otro servicio:** costo, otra cuenta y datos de cobro fuera de Supabase; pedido explícito de no sumar servicios.
- **Guardar el payload completo:** útil para depurar, pero mete datos de tarjetas, pagadores y firmas en una tabla legible por el staff; alcanza con el id externo para ir al panel del proveedor.
- **Leer los logs de Edge con la Management API:** requiere un token de plataforma y no da negocio ni resultado normalizado.
- **Insertar con supabase-js en cada Edge:** más acoplamiento; el `fetch` a PostgREST no suma dependencias ni cambia los imports de las funciones.

### Consecuencias

- Deploy: aplicar `20261031100000_webhook_events.sql` **antes** de redesplegar las 10 Edge (si la tabla no existe, el insert falla en silencio y el webhook sigue igual). Las Edge mantienen su `verify_jwt` actual.
- Volumen: una fila por aviso POST; con la retención de 30 días queda acotado. Índices por fecha, proveedor y negocio.
- **Deuda:** alertas activas (mail o campana interna cuando un proveedor pasa a "Con errores"); instrumentar los crons (`settlements`, `nubceo_sync`, `pending_charges_sync`) y `mp_billing_webhook` y `catalog_purchase_webhook` con el mismo helper; vista para el dueño en Configuración > Medios de pago.
- Tests: `tests/unit/webhookLog.test.ts` (estado, saneo del error, fila, respuesta intacta, registro que falla, excepción, diferido, GET), `tests/unit/webhookHealth.test.ts` y caso en `tests/integration/rls.test.ts` (A no ve los de B, el cajero no ve nada, `webhook_health` respeta la RLS, nadie inserta desde el cliente).
---

## ADR-071: Permisos por rol en la base: solo lectura no escribe, el cajero no toca catálogo ni stock a mano y anula sólo ventas del día

**Fecha:** 2026-10-13 · **Estado:** aceptada (código en `test/permisos-roles`; migración `20261031200000_permisos_por_rol.sql` sin aplicar) · **Base:** docs/06-permissions-roles.md §4, ADR-045 (alcance por sucursal), ADR-051 (caja propia y PIN), ADR-052 (`internal_scope`). **Numeración:** 069 y 070 reservadas por otras ramas.

### Contexto

La suite nueva `tests/integration/roles.test.ts` recorre la matriz de docs/06 rol por rol contra la base. Las tablas del núcleo (H1/H2: `products`, `stock_movements`, `categories`, `brands`, `customers`, `sales`, `payments`, `cash_*` y las de salón, delivery y agenda) tienen una sola policy `tenant_id = current_tenant_id()` para todo: cualquier miembro activo podía escribir por REST, y las RPC `SECURITY INVOKER` (`adjust_product_stock`, `register_stock_waste`, `register_production`, `void_sale`) no miraban el rol. Huecos encontrados:

1. **viewer** (solo lectura) podía crear y editar productos, ajustar stock, dar de alta y de baja clientes, abrir un turno (`open_cash_shift`), vender y anular ventas.
2. **cashier** podía crear, editar y borrar productos, cambiar precios, editar variantes, categorías y marcas, y ajustar stock a mano (RPC o `INSERT` directo en `stock_movements`, o `UPDATE products.stock`).
3. **cashier** podía dar de baja o borrar clientes.
4. **cashier** podía anular ventas de días anteriores, y cualquiera podía cambiar `sales.status` por REST sin revertir stock ni caja.

Los módulos nuevos (listas PRO, compras, tesorería, impuestos, contabilidad, cuotas, transferencias, terminales) ya tenían gating por rol y la suite lo confirma.

### Decisión

1. **Trigger `role_write_guard`** (`trg_role_write_guard`, SECURITY INVOKER) BEFORE INSERT/UPDATE/DELETE en las tablas operativas, con un modo por tabla. Lee el rol con `member_role_in(tenant)` (SECURITY DEFINER) en el negocio **de la fila**:
   - `viewer`: `forbidden_read_only` siempre, también dentro de una RPC.
   - modo `manage` (`products`, `product_variants`, `categories`, `brands`, `stock_movements`): `cashier` recibe `forbidden_role` cuando `current_user` es cliente (REST o RPC INVOKER). Las RPC SECURITY DEFINER (`create_sale`, `void_sale`, `return_sale`, compras, traslados) siguen moviendo stock en su nombre.
   - modo `customers`: `cashier` no da de baja (`deleted_at`) ni borra.
   - modo `sales`: nadie cambia `status` por REST (`use_void_sale`).
   - Sin `auth.uid()` (cron, `service_role`) o sin membresía (staff interno, ya acotado por `internal_scope()` en RLS) no aplica. No se agrega ninguna policy con `OR is_internal()`.
2. **`void_sale` pasa a SECURITY DEFINER** (copia de la única definición, `20260530170000`) con chequeos explícitos: miembro no viewer, `assert_staff_operational()`, acceso a la sucursal de la venta (antes lo hacía la RLS restrictiva) y, si el rol efectivo en esa sucursal (`user_store_role`) es `cashier`, sólo ventas del día en hora de Argentina (`forbidden_void_past_day`). El PIN por política (`sales_supervisor`) no cambia.
3. **Merma y producción quedan para dueño y encargado** (son ajustes manuales de stock según docs/06 §4.3; sus pantallas viven en Productos). Si un rubro necesita que cocina registre merma, se resuelve con una RPC SECURITY DEFINER con su propio permiso, no abriendo `stock_movements`.

### Alternativas descartadas

- **Policies RESTRICTIVE por rol en cada tabla:** bloquean también a las RPC INVOKER legítimas y no distinguen REST de RPC DEFINER; el viewer seguiría pudiendo escribir a través de una RPC DEFINER (`open_cash_shift`, `create_sale`).
- **Reescribir `create_sale`, `open_cash_shift` y compañía con chequeo de rol:** copiar funciones enormes (la de `create_sale` es la de `20261028100300`) para un chequeo que el trigger hace en un solo lugar.
- **Gatear sólo en la UI:** viola CLAUDE.md §3 y docs/06 §10.

### Consecuencias

- Deploy: migración `20261031200000_permisos_por_rol.sql`, después de `20261030100200`. Sin Edges ni cambios de front.
- UX: un cajero que hoy entra a Productos y edita verá el error del servidor (`forbidden_role`). Deuda de front: ocultar en `/productos` las acciones de edición, merma, producción y ajuste para cajero y solo lectura, y mapear `forbidden_role`, `forbidden_read_only` y `forbidden_void_past_day` a mensajes.
- Costo: una búsqueda por clave en `tenant_users` por fila escrita.
- Pendiente (no lo hace cumplir la base): edición de clientes limitada a contacto para el cajero, tope de ingresos del cajero, confirmación de importación masiva del encargado y cambio de rol de usuarios (Edge Functions sin test de integración acá).
- Tests: `tests/integration/roles.test.ts` (owner, manager, cashier y viewer: catálogo, precios, stock manual, clientes, caja, venta, anulación, configuración, contabilidad). Corre en el job `rls` de CI (`pnpm test:rls` = `vitest run tests/integration`).
---

## ADR-069: Getnet con dos juegos de credenciales y checkout propio con la Checkout API

**Fecha:** 2026-10-12 · **Estado:** aceptada con el cobro APAGADO hasta resolver PCI (código en `feat/getnet-checkout-api`; migración `20261031300000` sin aplicar; Edges sin desplegar; adenda 2026-10-13: sólo Web Checkout para el cliente) · **Base:** ADR-029 y H17b (checkout propio de Payway), ADR-031, ADR-057 (credenciales por sucursal), ADR-065 (Getnet con dos APIs) · **Numeración:** si otra rama tomó el 069, renumerar al mergear.

### Contexto

El dueño tiene dos juegos de credenciales de Getnet: "Web Checkout / Plugin Magento / Plugin WooCommerce" (anda para QR y link con el checkout hosted) y "Checkout API / Plugin VTEX" (el QR falla: es una API de cobro directo con tarjeta, sin página de Getnet). Pidió que el producto diga qué credencial va en cada lugar y un checkout propio como el de Payway (`/pagar`) con la Checkout API. Investigación con fuentes en [`docs/payments/getnet-checkout-api.md`](payments/getnet-checkout-api.md).

### Decisión

1. **Dos slots en la conexión Getnet**, cada uno opcional, por ambiente y por sucursal: **Web Checkout** (`client_id`, `client_secret`, `api_profile`, `environment`, datos del comprador) y **Checkout API** (`api_client_id`, `api_client_secret`, `api_environment`, `api_seller_id`, `api_channel_entry`). Se guardan en la misma fila de `payment_secrets` con `merge` (un slot no pisa el otro; las claves viejas del mismo slot se borran). Cada slot se hereda por separado: si la credencial de la sucursal no trae ese slot, se usa el del negocio (`loadGetnetSlot`). `set_payment_secret` marca `config.web_checkout_connected`, `config.checkout_api_connected` y `connected` = alguno; una conexión vieja sin flags es Web Checkout.
2. **Wizard:** tarjetas "Web Checkout: para cobrar con QR o link: el cliente paga en la página de Getnet. Usá las credenciales que dicen Web Checkout / Plugin Magento / Plugin WooCommerce." y "Checkout API: para tu propio checkout con tu marca (como Payway): el cliente carga la tarjeta en NinjaPos y elige cuotas. Usá las credenciales que dicen Checkout API / Plugin VTEX.", estado de cada una, "Probar" y "Quitar" por slot.
3. **"Probar credenciales" por slot** (Edge `getnet`, action `probe` con `slot`): prueba Web Checkout (token + `GET /sellers`) y la Checkout API (token con Basic auth) y avisa si la credencial está en el slot equivocado (`classifyCredential`): Web Checkout falla en el token o en `/sellers` con 401/403/404 y la Checkout API da token, o al revés. Con la Checkout API lee `sellerId` y `country` del JWT y guarda el Seller ID.
4. **Checkout propio para Getnet:** la misma página `/pagar/[id]` con `?p=getnet` (adaptador por procesador en `lib/payments/checkoutProviders.ts`): marca del negocio, tarjeta, cuotas de los Planes de Getnet con su interés, detección de marca y validaciones. Edge pública **`getnet_checkout`** (`verify_jwt = false`): `info` y `pay`. `pay` toma el monto del intent más el recargo del plan (nunca del cliente), pide token, tokeniza (`/dpm/cofre-gw-proxy/v1/tokens/card`), cotiza las cuotas (`/payments/quotes`, obligatorio en AR) y cobra (`/payments`) con `payment_id` e `idempotency_key` propios. **Idempotencia:** el `payment_id` se reserva en el intent con un update condicional antes de cobrar (dos clics no cobran dos veces); un intento que quedó en curso se re-consulta antes de aceptar otro. Aprobado sólo con monto exacto; DENIED deja el intent pendiente para otra tarjeta. El intent es un `mp_payment_intents` `getnet` con `init_point` `/pagar/`; `getnet` status, `payment_provider_data` y la conciliación lo leen por `payment_id` (`GET /payments/info`).
5. **POS:** tender **"Link (checkout propio)"** de Getnet (`getnet:own`) sólo con el slot Checkout API y la feature; QR y Link de Getnet exigen Web Checkout. Link + QR, compartir y cobros en espera (ADR-048) como Payway; regenerar un cobro en espera respeta el modo. Errores claros si falta el slot correcto.
6. **Feature `getnet_checkout_propio`** (OPTIONAL, pagos, Pro+, requiere `getnet`; planes a medida heredan `getnet`). Gating real en `getnet` create (mode own) y `getnet_checkout` pay.
7. **PCI (bloqueo):** Getnet no ofrece tokenización desde el navegador (el endpoint pide el Bearer del comercio y no habilita CORS: preflight 403/404 sin `Access-Control-Allow-Origin`, verificado). Con la Checkout API la tarjeta **tiene que pasar por nuestro servidor**, lo que pone a NinjaSoft dentro del alcance PCI DSS como proveedor de servicios. Por eso `getnet_checkout` pay y `getnet` create (mode own) responden `checkout_api_unavailable` hasta que el secret `GETNET_CHECKOUT_API_PCI_ATTESTED=true` esté cargado. Mientras tanto la tarjeta nunca toca el servidor. Cuando se habilite: la tarjeta vive sólo en memoria en ese request, no se guarda ni se loguea (los mensajes del proveedor pasan por un filtro que tapa PAN) y nunca vuelve en una respuesta.

### Alternativas descartadas

- **Darle al navegador un access token** para que tokenice directo: el token tiene el scope completo del gateway (cobrar, anular, devolver) por una hora. Inaceptable.
- **Cifrar la tarjeta en el navegador:** Getnet no publica una clave pública para eso.
- **Usar las credenciales de Checkout API para QR y link:** la API no tiene página hosted; por eso fallaba.
- **Iframe o lightbox de Web Checkout** (la tarjeta la carga Getnet en un formulario embebido): mantiene a NinjaSoft fuera de PCI, pero usa las credenciales de Web Checkout y la marca y las cuotas las pone Getnet. Queda como opción si no se avanza con PCI.
- **Webhooks de la Global API:** piden otro scope y una suscripción por comercio; el cobro es sincrónico y el POS re-consulta.

### Consecuencias

- **Lo que tiene que decidir el dueño:** encarar la validación PCI DSS (SAQ D de proveedor de servicios, con un QSA) para prender el checkout propio de Getnet, o quedarse con Web Checkout (QR y link, y si interesa, iframe embebido). Sin eso el tender propio responde "todavía no está habilitado" y la prueba lo avisa.
- **Deploy:** migración `20261031300000_feature_getnet_checkout_propio.sql`; Edges `getnet`, `getnet_checkout` (nueva, **`verify_jwt = false`**), `getnet_webhook` (pública), `payment_provider_data` y `set_payment_secret`. El front tolera la base sin la migración (la feature falta = tender oculto).
- **Supuestos a validar con el primer cobro real:** bóveda y cuotas habilitadas en la Checkout API, `INSTALL_NO_INTEREST` con cotización `no_interest` para nuestro recargo, `x-transaction-channel-entry`, forma del monto en `GET /payments/info`, datos del comprador para antifraude.
- **Deuda:** anular y devolver un cobro del checkout propio desde el POS (endpoints `cancellation` / `refund` legacy en AR); 3DS si Getnet lo exige; TTL de cobros en espera de Getnet propio (hoy 30 minutos como el hosted).
- **Tests:** `tests/unit/getnetCheckoutApi.test.ts` (token Basic, JWT, hosts, errores sin secretos, detección de slot, tarjeta, cotización, payload, respuestas, estados, normalización, slots del wizard y del POS, body de `/pagar`), `tests/unit/posTenders.test.ts`; `deno check` de las Edges tocadas.

### Adenda 2026-10-13: sólo Web Checkout para el cliente

**Contexto.** Las credenciales que le funcionan al dueño son las de "Web Checkout / Plugin Magento / Plugin WooCommerce". Las de "Checkout API / Plugin VTEX" dan error al generar el QR y no sirven sin certificación PCI. Con dos tarjetas en el asistente el cliente podía cargar las equivocadas.

**Decisión.** Se deja el código de la Checkout API, pero al cliente se le pide una sola credencial y la otra no se toma:

1. **Asistente:** una sola tarjeta activa, "Web Checkout / Plugin Magento / Plugin WooCommerce", con "Estas son las credenciales que tenés que cargar. Las encontrás en el portal de Getnet como Web Checkout, Plugin Magento o Plugin WooCommerce." y el aviso "No uses las de Checkout API / Plugin VTEX: no funcionan para cobrar con QR ni link desde NinjaSoft." (`visibleGetnetSlots`, `GETNET_VTEX_WARNING` en `lib/payments/getnetSlots.ts`).
2. **La tarjeta Checkout API sólo con el checkout propio habilitado.** La Edge `getnet` expone el flag como booleano (`action: "capabilities"` → `{ own_checkout_enabled }`), nunca el secret. Apagado: no se muestra, la Edge no prueba ese slot y `set_payment_secret` rechaza cualquier clave `api_*` con `checkout_api_unavailable` (409).
3. **Credenciales de Checkout API / Plugin VTEX en Web Checkout se rechazan** con "Estas credenciales son de Checkout API / Plugin VTEX. Cargá las de Web Checkout / Plugin Magento / Plugin WooCommerce.", en "Probar" y al guardar. Se eligió **no guardar** (y no guardar marcadas como no verificadas): el asistente prueba antes de "Conectar" y no guarda si la prueba falla; `set_payment_secret` repite la detección (`assessGetnetCredential` + `webCheckoutSaveVerdict`) y responde 422 `getnet_checkout_api_credentials` o `getnet_invalid_credentials`. Un corte de Getnet (red, 5xx) no bloquea el guardado del servidor.
4. **POS:** "Link (checkout propio)" exige además `own_checkout_enabled` (ProviderStatus de Getnet); `paymentMethodsStatus` sólo pregunta a la Edge si hay Checkout API cargada y ante error lo deja apagado.
5. **Migración renumerada** a `20261031300000_feature_getnet_checkout_propio.sql` (el `20261031200000` lo usa otra rama).

**Consecuencias.** Guardar Web Checkout tarda un poco más (el servidor llama a Getnet: token de Web Checkout, `GET /sellers` y token de la Checkout API). La detección depende de `classifyCredential`: si una credencial de Checkout API también obtiene token y `GET /sellers` de Web Checkout, no se distingue (no se vio con las del dueño). Para prender el checkout propio basta cargar `GETNET_CHECKOUT_API_PCI_ATTESTED=true`: vuelven la segunda tarjeta y el tender, sin deploy de front. Tests: `tests/unit/getnetCheckoutApi.test.ts` (tarjeta única, textos, veredicto del guardado, errores, tender con y sin flag).
