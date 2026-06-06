# H9b — Editor visual de tickets multi-modo + envío por email

> Spec aprobada en diseño colaborativo (2026-06-06). Hito H9b del roadmap (F6).

## Objetivo

El dueño diseña sus tickets/comprobantes/promos con total flexibilidad, guarda **varios modelos** por tipo de documento, los imprime (térmica 58/80mm y A4) y envía el comprobante **por email** al cliente.

## Decisiones de diseño

- **Tres modos de edición** sobre una misma infraestructura: `blocks` (pila de bloques reordenables, default), `canvas` (posicionamiento libre XY tipo Canva) y `html` (HTML + variables, avanzado).
- El ticket de venta es flujo vertical de altura variable (N ítems) → en modo canvas la **tabla de ítems es un elemento de flujo**: ancla lo de arriba y empuja lo de abajo (canvas de altura elástica). Promos/gift cards usan alto fijo.
- **Compatibilidad:** tenant sin plantilla → ticket actual hard-coded (`TicketModal`). Cero ruptura.

## Modelo de datos

Tabla `ticket_templates` (migración nueva):

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK | RLS por tenant |
| `name` | text | nombre del modelo |
| `kind` | text | `sale` \| `promo` \| `gift` |
| `mode` | text | `blocks` \| `canvas` \| `html` |
| `paper` | text | `58` \| `80` \| `a4` |
| `content` | jsonb | bloques ordenados / elementos XY / `{ html }` según modo |
| `show_ninjasoft_logo` | boolean default false | logo NinjaSoft al pie (opt-in, los 3 modos) |
| `is_default` | boolean | un default por `kind` por tenant (índice parcial único) |
| `created_at` / `updated_at` / `deleted_at` | | baja lógica |

RLS: lectura miembros del tenant; escritura `owner`/`manager`. Sin acceso anónimo.

## Modo bloques (default)

Catálogo (~14 bloques): logo · datos del negocio · título · datos de venta (fecha/cajero/caja/N°) · cliente · tabla de ítems (columnas configurables) · totales · medios de pago · QR · código de barras · texto libre · **imagen (promos/banners)** · separador · pie/redes.

Cada bloque: mostrar/ocultar, alineación, tamaño S/M/L, negrita, opciones propias. Reordenamiento por drag.

## Modo canvas

Elementos con XY/ancho/alto libres: texto, imagen, logo, QR, barcode, separador/forma. Snap básico y z-order. Para `kind: sale`, el elemento "tabla de ítems" es de flujo (ver decisiones). Ideal para `promo`/`gift`.

## Modo HTML

Textarea con HTML + variables `{{...}}` (mismo motor mustache de `lib/email/templates.ts`) + preview en vivo con venta de muestra. **5 plantillas precargadas** como punto de partida (constantes en código, se copian al editar):

1. Clásico 80mm
2. Compacto 58mm
3. A4 estilo factura
4. Volante promo
5. Gift card

## Variables disponibles (todos los modos)

Branding (`tenant_branding`): logo, razón social, CUIT, dirección, teléfono, pie. Venta: número formateado, fecha, cajero, caja, ítems, subtotal, descuentos, recargos, total, pagos, vuelto, cliente. QR con datos de la venta (igual que H9).

## Render e impresión

Componente único `TicketRenderer(template, data)` usado por:

- **Editor** (preview en vivo con venta de muestra).
- **`TicketModal`** (impresión térmica vía hoja CSS `ticket-print` existente; usa plantilla default `kind: sale` o fallback actual).
- **A4/PDF** (flujo `jspdf` existente alimentado por la plantilla).
- **Email** (render a PNG).
- **Promos:** impresión a demanda desde Configuración → Tickets (y acceso desde /etiquetas).

`show_ninjasoft_logo` agrega el logo NinjaSoft al pie del documento final en cualquier modo.

## Envío por email

Tres vías de envío del comprobante:

1. **Al momento de la impresión/cobro:** botón "Enviar por email" en el ticket de la venta. Si el cliente de la venta tiene email precargado lo usa; si no, **input para cargarlo en el momento** (con opción de guardarlo en la ficha del cliente).
2. **Reenvío desde el historial:** en `/ventas`, acción "Enviar/Reenviar por email" por venta (mismo flujo; muestra si ya fue enviado y cuándo).
3. **Envío automático:** setting por tenant en Operación del POS (`pos_settings.auto_email_receipt`, default off). Al registrar una venta cuyo cliente tiene email precargado, el comprobante se envía solo, sin bloquear el cobro (fire-and-forget; error de SMTP no afecta la venta).

Mecánica común:

- Render client-side a PNG (`html2canvas` del nodo ya renderizado) → Edge Function nueva `send_receipt_email`: guard de membresía del tenant, reusa SMTP del sistema (`system_email_smtp`, H13), adjunta PNG en email HTML simple.
- Auditoría: `audit_logs` acción `receipt_emailed` (tenant, venta, destinatario, vía manual/auto). Reenvío siempre permitido; el historial muestra el último envío.

## UI

- **Configuración → Tickets (nuevo):** listado de modelos (nombre, tipo, modo, papel, default), crear ("¿Cómo querés diseñar? Bloques / Canvas / HTML"), editar, duplicar, eliminar (lógico), marcar default.
- Editor a pantalla completa: panel de herramientas + preview en vivo.
- Solo `owner`/`manager` ven la sección (consistente con branding H8).

## Testing

- Unit: render de bloques con venta de muestra; sustitución de variables; resolución de plantilla default/fallback.
- RLS: `ticket_templates` aislamiento entre tenants + escritura solo owner/manager (suite `tests/integration/rls.test.ts`).
- Edge Function: guard de membresía y manejo de error SMTP sin romper la venta.

## Entrega

- **PR 1:** migración + RLS + CRUD de modelos + modo **bloques** completo + integración TicketModal/A4 + **email** + footer NinjaSoft.
- **PR 2:** modos **canvas** y **HTML** (con las 5 plantillas precargadas) sobre la misma infra.

## Fuera de alcance

- Perfiles de impresión por sucursal/caja y cola de impresión (F10/H22).
- Editor de emails del cliente (los emails del sistema ya tienen el suyo en `/internal/emails`).
