# 19 · Glosario

Términos del producto, del negocio y del stack que usamos en la documentación, el código y las conversaciones del equipo. Si una palabra aparece más de tres veces en los docs, vive acá.

---

## A

**ADR (Architecture Decision Record).** Registro de una decisión de arquitectura. Una por decisión, no se edita, se supera con otra. Ver `17-decision-log.md`.

**AFIP.** Administración Federal de Ingresos Públicos. Organismo fiscal argentino. La integración para facturación electrónica se documenta en `15-afip-integration.md`.

**Agenda.** Calendario operativo de turnos por profesional, recurso o sucursal. En F12 se usa para peluquerías, estética, barberías y servicios con reserva.

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

**Cola fiscal.** Cola de comprobantes AFIP pendientes de emisión, reintento, corrección o revisión manual. Permite que la venta no se bloquee aunque AFIP esté caído. Ver `15-afip-integration.md`.

**Comanda.** Orden enviada a cocina, barra, cafetería, heladería o despacho. Puede imprimirse o mostrarse en KDS. No es lo mismo que ticket fiscal.

**CUIT/CUIL.** Identificadores fiscales argentinos. CUIT para empresas, CUIL para personas. Algunos clientes los exigen en el ticket.

**Cuota / límite de plan.** Capacidad contratada por un tenant: usuarios, sucursales, cajas, productos, ventas mensuales, almacenamiento o módulos. Puede venir del plan base o de un override custom.

## D

**Default_enabled.** Atributo de un feature flag que indica si arranca activa sin override. Ver `07-feature-flags.md`.

**Deploy.** Publicación de una versión. En NinjaSoft pasa por Vercel automáticamente cuando se mergea a una rama configurada. Ver `13-deployment.md`.

**Depósito.** Ubicación lógica de stock dentro de una sucursal o entre sucursales: principal, reserva, devolución, merma o tránsito.

**Display cliente.** Segunda pantalla del POS, visible para el comprador. Muestra carrito, total, vuelto, QR de pago y mensajes del negocio. En web se implementa como ruta dedicada sincronizada con la caja. Ver `20-hardware-pos.md`.

## E

**Edge Function.** Función serverless de Supabase escrita en Deno/TypeScript. Donde vive la lógica sensible: AFIP, webhooks, integraciones de pago.

**Enterprise.** Plan superior, con SLA, integraciones a medida y soporte priorizado. Ver `16-subscription-model.md`.

## F

**Feature flag.** Switch que activa o desactiva una funcionalidad sin tocar código. Toda diferencia entre planes o rubros pasa por una flag. Ver `07-feature-flags.md`.

**Fiado / cuenta corriente.** Venta que queda como deuda del cliente para cobrar después. Tiene límite, vencimiento y antigüedad de deuda.

## G

**Git worktree.** Mecanismo de Git que permite tener varios checkouts del mismo repo en directorios distintos. Cada agente especialista trabaja en su propio worktree para no pisarse con los demás. Ver `workflows/agent-workflow.md`.

## H

**HxN.** Convención para hitos del MVP (`H0`, `H1`, etc.). Ver `01-mvp.md`.

**Homologación AFIP.** Ambiente de prueba de AFIP. Todo tenant que use facturación electrónica debe validar certificados, numeración y comprobantes en homologación antes de pasar a producción.

## I

**Idempotencia.** Propiedad de una operación que da el mismo resultado si se ejecuta una o varias veces. Crítica en pagos, webhooks y Edge Functions.

**Impresora térmica.** Impresora de ticket de 58mm u 80mm usada en mostrador. Puede operar con impresión web básica o con conector ESC/POS cuando se necesita corte, cajón o control fino. Ver `20-hardware-pos.md`.

**Importación masiva XLSX.** Carga de datos maestros desde Excel con plantilla, validación previa, preview, confirmación y reporte de errores por fila.

## J

**JWT.** JSON Web Token. Token de sesión que emite Supabase Auth. Contiene `sub` (user id) y claims con los que se resuelve el `tenant_id` activo.

## K

**KDS (Kitchen Display System).** Pantalla de cocina/barra que muestra comandas en tiempo real, con estados y tiempos de preparación. Ver `23-restaurant-cafe-operations.md`.

## M

**Manager.** Rol de cliente con acceso a reportes y configuración del tenant. No puede borrar el tenant ni cambiar plan. Ver `06-permissions-roles.md`.

**Mesa.** Unidad operativa de salón gastronómico. Tiene sector, capacidad, estado, mozo/pedido asociado y puede moverse, unirse, transferirse o cerrarse.

**Migration.** Archivo SQL versionado en `supabase/migrations/`. Naming: `YYYYMMDDHHMMSS_verbo_descripcion.sql`. Habilita RLS en la misma migración que crea la tabla.

**Modificador.** Opción que completa un producto o servicio sin crear otro SKU: sabor de helado, topping, tamaño, extra, profesional o variante simple. Ver `22-simple-commerce-services.md`.

**Modo catálogo chico.** Variante del POS pensada para negocios con pocos productos o servicios. Prioriza botones grandes, favoritos, cantidades rápidas y cobro express por encima de búsqueda/inventario pesado.

**Multi-tenant.** Una sola instancia del software sirve a múltiples clientes (tenants) con aislamiento de datos. NinjaSoft usa shared schema + tenant_id + RLS. Ver `08-multi-tenant.md`.

## N

**NinjaSoft staff.** Empleados internos de NinjaSoft. Tienen un panel propio (`/internal`) para gestionar tenants, planes, flags y soporte. No son usuarios de un tenant.

## O

**Owner.** Rol más alto dentro de un tenant. Tiene control total sobre ese tenant. Un tenant tiene al menos un owner; puede tener más de uno.

## P

**Plan.** Categoría comercial del cliente (`start`, `pro`, `business`, `enterprise`). Define límites y feature flags por defecto. Ver `16-subscription-model.md`.

**Plan custom.** Plan específico para un tenant, creado desde un plan base pero con límites, módulos, soporte, precio o condiciones comerciales propias.

**POS.** Point of Sale, punto de venta. Es la pantalla principal del producto: lo que ven cajeros y vendedores.

**PR (Pull Request).** Solicitud de merge en GitHub. Toda PR pasa por el checklist de `18-qa-checklist.md`.

**Preview.** Deploy de una rama distinta de `main`, generado automáticamente por Vercel. Una URL única para revisar antes de mergear.

**Project Manager.** Agente orquestador. Recibe la tarea, decide qué especialistas la pueden hacer en paralelo, presenta un plan antes de ejecutar. Ver `.claude/agents/project-manager.md`.

**Pedido de salón.** Pedido armado por un vendedor antes del cobro. Reserva stock y luego una cajera lo levanta para facturarlo/cobrarlo.

## R

**Rate limit.** Límite de cantidad de requests por unidad de tiempo. Aplica a endpoints públicos y a Edge Functions sensibles.

**RLS (Row Level Security).** Mecanismo de Postgres para filtrar filas según el usuario autenticado. Es la columna vertebral de la seguridad multi-tenant.

**Rubro.** Tipo de negocio del cliente: kiosco, textil, retail, restaurante, cafetería, heladería, estética, servicios, etc. No se hardcodea en código, se expresa con feature flags y plantillas de configuración.

**Recargo de medio de pago.** Incremento automático del total según variante de cobro, por ejemplo tarjeta en cuotas.

## S

**SaaS.** Software as a Service. El cliente paga una suscripción y accede al producto vía web, sin instalación local.

**Service role.** Clave privilegiada de Supabase. Saltea RLS. **Nunca** en frontend. Solo en Edge Functions o backend confiable.

**Servicio.** Ítem vendible que no necesariamente descuenta stock: corte, color, manicura, lavado, reparación, clase o consulta. Puede tener duración, profesional, comisión y agenda.

**SKU.** Stock Keeping Unit. Código interno único de un producto dentro de un tenant. Distinto al código de barras (que puede ser compartido entre tenants si es un EAN estándar).

**Scanner.** Lector de códigos usado en POS. Puede ser USB HID tipo teclado, Bluetooth o cámara móvil. El POS debe mantener foco, normalizar códigos y evitar lecturas duplicadas. Ver `20-hardware-pos.md`.

**Suspensión.** Estado de un tenant que pierde acceso por falta de pago u otra razón. No se borran datos. Se reactiva restaurando el acceso.

**Saldo a favor / vale.** Crédito generado para un cliente en una devolución o cambio. Puede tener vencimiento.

**Notificación in-app.** Mensaje visible dentro de la cuenta del tenant. Puede informar novedades, cobros, vencimientos, cambios de plan, alertas operativas o acciones requeridas.

## T

**Tenant.** Cliente de NinjaSoft. Cada tenant tiene sus locales, cajas, productos, ventas, usuarios, configuración. Tabla `tenants`.

**Tenant_id.** UUID que identifica al tenant. Aparece en toda tabla operativa. Resuelto en el JWT y leído por `current_tenant_id()`.

**Trial.** Estado inicial de un tenant nuevo. Acceso completo por X días, después se exige plan pago o pasa a suspendido.

**Turno (cash shift).** Lapso entre apertura y cierre de una caja. Toda venta pertenece a un turno. Tabla `cash_shifts`.

## V

**Vercel.** Plataforma de hosting para Next.js. Deploy automático por rama. NinjaSoft tiene 4 environments: local, preview, staging, production. Ver `13-deployment.md`.

**Venta offline.** Venta registrada sin conexión estable. Usa número interno/provisorio, se sincroniza al recuperar conexión y luego entra a la cola fiscal si requiere AFIP.

**Viewer.** Rol de cliente solo lectura. No modifica nada. Útil para contadores externos, auditores, dueños no operativos.

## Z

**Zod.** Librería de validación de esquemas en TypeScript. Estándar del proyecto para validar inputs en Edge Functions, Server Actions y formularios.
