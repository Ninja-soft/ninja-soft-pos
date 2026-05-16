# 19 · Glosario

Términos del producto, del negocio y del stack que usamos en la documentación, el código y las conversaciones del equipo. Si una palabra aparece más de tres veces en los docs, vive acá.

---

## A

**ADR (Architecture Decision Record).** Registro de una decisión de arquitectura. Una por decisión, no se edita, se supera con otra. Ver `17-decision-log.md`.

**AFIP.** Administración Federal de Ingresos Públicos. Organismo fiscal argentino. La integración para facturación electrónica se documenta en `15-afip-integration.md`.

**Agente.** Subagente de Claude Code con instrucciones específicas que vive en `.claude/agents/`. Cada agente tiene un rol (PM, supabase-architect, frontend-pos, etc.).

**Anon key.** Clave pública de Supabase que el frontend usa para conectarse. Por sí sola no rompe RLS: las queries siguen filtradas por las políticas del usuario autenticado.

**Arqueo.** Conteo de efectivo al cerrar una caja. Se compara lo declarado por el cajero contra lo que el sistema esperaba.

**Audit log.** Registro append-only de acciones sensibles (cambios de precio, anulaciones, cambios de rol, accesos críticos). Tabla `audit_logs`.

## B

**Baja lógica.** Marcar un registro como eliminado sin borrarlo de la DB. Se hace con `deleted_at timestamp`. Toda tabla operativa la implementa.

**Branch (rama).** Rama de Git. Convención: `feat/`, `fix/`, `chore/`, `docs/`. Ver `workflows/git-workflow.md`.

## C

**Caja (cash register).** Punto físico o lógico desde el cual se cobra. Un local puede tener varias cajas. Tabla `cash_registers`.

**Cashier.** Rol de cliente que solo opera el POS. No accede a reportes globales ni configuración. Ver `06-permissions-roles.md`.

**Cierre de caja.** Acción de cerrar un turno (`cash_shift`). Genera arqueo y bloquea nuevas operaciones en esa caja hasta una nueva apertura.

**Claude Code.** Herramienta CLI de Anthropic para que un dev trabaje con Claude sobre un repo. Soporta agentes definidos en `.claude/agents/`.

**CUIT/CUIL.** Identificadores fiscales argentinos. CUIT para empresas, CUIL para personas. Algunos clientes los exigen en el ticket.

## D

**Default_enabled.** Atributo de un feature flag que indica si arranca activa sin override. Ver `07-feature-flags.md`.

**Deploy.** Publicación de una versión. En NinjaSoft pasa por Vercel automáticamente cuando se mergea a una rama configurada. Ver `13-deployment.md`.

## E

**Edge Function.** Función serverless de Supabase escrita en Deno/TypeScript. Donde vive la lógica sensible: AFIP, webhooks, integraciones de pago.

**Enterprise.** Plan superior, con SLA, integraciones a medida y soporte priorizado. Ver `16-subscription-model.md`.

## F

**Feature flag.** Switch que activa o desactiva una funcionalidad sin tocar código. Toda diferencia entre planes o rubros pasa por una flag. Ver `07-feature-flags.md`.

## G

**Git worktree.** Mecanismo de Git que permite tener varios checkouts del mismo repo en directorios distintos. Cada agente especialista trabaja en su propio worktree para no pisarse con los demás. Ver `workflows/agent-workflow.md`.

## H

**HxN.** Convención para hitos del MVP (`H0`, `H1`, etc.). Ver `01-mvp.md`.

## I

**Idempotencia.** Propiedad de una operación que da el mismo resultado si se ejecuta una o varias veces. Crítica en pagos, webhooks y Edge Functions.

## J

**JWT.** JSON Web Token. Token de sesión que emite Supabase Auth. Contiene `sub` (user id) y claims con los que se resuelve el `tenant_id` activo.

## M

**Manager.** Rol de cliente con acceso a reportes y configuración del tenant. No puede borrar el tenant ni cambiar plan. Ver `06-permissions-roles.md`.

**Migration.** Archivo SQL versionado en `supabase/migrations/`. Naming: `YYYYMMDDHHMMSS_verbo_descripcion.sql`. Habilita RLS en la misma migración que crea la tabla.

**Multi-tenant.** Una sola instancia del software sirve a múltiples clientes (tenants) con aislamiento de datos. NinjaSoft usa shared schema + tenant_id + RLS. Ver `08-multi-tenant.md`.

## N

**NinjaSoft staff.** Empleados internos de NinjaSoft. Tienen un panel propio (`/internal`) para gestionar tenants, planes, flags y soporte. No son usuarios de un tenant.

## O

**Owner.** Rol más alto dentro de un tenant. Tiene control total sobre ese tenant. Un tenant tiene al menos un owner; puede tener más de uno.

## P

**Plan.** Categoría comercial del cliente (`start`, `pro`, `business`, `enterprise`). Define límites y feature flags por defecto. Ver `16-subscription-model.md`.

**POS.** Point of Sale, punto de venta. Es la pantalla principal del producto: lo que ven cajeros y vendedores.

**PR (Pull Request).** Solicitud de merge en GitHub. Toda PR pasa por el checklist de `18-qa-checklist.md`.

**Preview.** Deploy de una rama distinta de `main`, generado automáticamente por Vercel. Una URL única para revisar antes de mergear.

**Project Manager.** Agente orquestador. Recibe la tarea, decide qué especialistas la pueden hacer en paralelo, presenta un plan antes de ejecutar. Ver `.claude/agents/project-manager.md`.

## R

**Rate limit.** Límite de cantidad de requests por unidad de tiempo. Aplica a endpoints públicos y a Edge Functions sensibles.

**RLS (Row Level Security).** Mecanismo de Postgres para filtrar filas según el usuario autenticado. Es la columna vertebral de la seguridad multi-tenant.

**Rubro.** Tipo de negocio del cliente: kiosco, textil, retail, restaurante. No se hardcodea en código, se expresa con feature flags y plantillas de configuración.

## S

**SaaS.** Software as a Service. El cliente paga una suscripción y accede al producto vía web, sin instalación local.

**Service role.** Clave privilegiada de Supabase. Saltea RLS. **Nunca** en frontend. Solo en Edge Functions o backend confiable.

**SKU.** Stock Keeping Unit. Código interno único de un producto dentro de un tenant. Distinto al código de barras (que puede ser compartido entre tenants si es un EAN estándar).

**Suspensión.** Estado de un tenant que pierde acceso por falta de pago u otra razón. No se borran datos. Se reactiva restaurando el acceso.

## T

**Tenant.** Cliente de NinjaSoft. Cada tenant tiene sus locales, cajas, productos, ventas, usuarios, configuración. Tabla `tenants`.

**Tenant_id.** UUID que identifica al tenant. Aparece en toda tabla operativa. Resuelto en el JWT y leído por `current_tenant_id()`.

**Trial.** Estado inicial de un tenant nuevo. Acceso completo por X días, después se exige plan pago o pasa a suspendido.

**Turno (cash shift).** Lapso entre apertura y cierre de una caja. Toda venta pertenece a un turno. Tabla `cash_shifts`.

## V

**Vercel.** Plataforma de hosting para Next.js. Deploy automático por rama. NinjaSoft tiene 4 environments: local, preview, staging, production. Ver `13-deployment.md`.

**Viewer.** Rol de cliente solo lectura. No modifica nada. Útil para contadores externos, auditores, dueños no operativos.

## Z

**Zod.** Librería de validación de esquemas en TypeScript. Estándar del proyecto para validar inputs en Edge Functions, Server Actions y formularios.
