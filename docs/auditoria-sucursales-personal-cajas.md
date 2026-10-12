# Auditoría: sucursales, personal, cajas, PIN de supervisor y auditoría

**Fecha:** 2026-10-12 · **Rama:** `feat/sucursales-personal-cajas` · **ADR:** [ADR-051](./17-decision-log.md) · **Roadmap:** [F17 · H113 a H119](./02-roadmap.md)

Auditoría hecha leyendo el código (migraciones vivas, RPC, Edge Functions y pantallas) con dos sombreros: **operación retail** (cómo se trabaja de verdad un mostrador con varias cajas, varios turnos y rotación de personal) y **seguridad / control interno** (quién puede hacer qué, qué queda registrado y qué se puede saltear yendo directo a la API).

Pedido del dueño, resumido: "no se entiende la configuración de sucursal (me salen 4 principales), mejorala visualmente; al invitar un empleado desde el panel no me lleva a crear el usuario; quiero asignarle sucursal, trasladarlo, suspenderlo, darle licencia o darlo de baja, todo muy visual; cada usuario trabaja sólo en su sucursal; el dueño ve todas y cobra en la que quiera pero siempre abriendo su caja; nadie invade la caja de otro; mejorame el resumen del panel (Negocio, Plan, Uso), los gráficos y la configuración, compartida o por sucursal; quiero ver qué cajas están abiertas, hace cuánto y quién; configurame la auditoría y los PIN de supervisor".

Severidad: **P0** se puede explotar o rompe la operación hoy · **P1** hueco serio de control o de UX que genera errores · **P2** mejora importante · **P3** pulido.

---

## 1. Resumen ejecutivo

| # | Hallazgo | Sev. | Estado en esta rama |
|---|---|---|---|
| S-01 | Staff interno veía datos de todos los negocios en listas del panel (las "4 principales") | P0 | Resuelto en la base (ADR-052, `internal_scope()`) + filtros por negocio en el cliente |
| S-02 | Cualquier miembro puede cerrar el turno de otro (`close_cash_shift` es SECURITY INVOKER y no mira `opened_by`) | P0 | Resuelto (guarda en `cash_shifts`) |
| S-03 | Cualquier miembro puede vender en el turno abierto por otro (`resolve_sale_shift` acepta el turno de cualquiera) | P0 | Resuelto (`assert_shift_owner`) |
| S-04 | `cash_movements` tiene policy `for all`: un cajero puede insertar, editar o borrar movimientos (incluso ventas falsas) por REST | P0 | Resuelto (guarda: sólo ingreso, retiro y contramovimientos válidos; sin UPDATE/DELETE desde el cliente) |
| S-05 | Un encargado puede degradar al dueño (`member_admin.update_member` sólo valida el rol nuevo) y suspenderlo (`set_member_status`) | P0 | Resuelto (Edge + RPC nuevas) |
| S-06 | `invite_user` con el email de un miembro existente pisa su rol (puede degradar al dueño) | P0 | Resuelto |
| B-01 | El usuario invitado nunca recibe `app_metadata.current_tenant_id`: entra y la RLS le niega todo | P0 | Resuelto (invite + autocuración al entrar) |
| B-02 | "Invitar usuario" del Panel del dueño no abre el modal | P1 | Resuelto |
| S-07 | Un suspendido conserva el JWT con el negocio: sigue leyendo por API hasta que vence la sesión, y el refresh lo renueva | P1 | Mitigado (baja revoca sesiones y negocio activo; suspensión y licencia cortan operación por RPC); raíz en roadmap |
| S-08 | `audit_logs` lo lee cualquier miembro del negocio (incluye `before_data`/`after_data`) | P1 | Resuelto (policy restrictiva: dueño, encargado o lo propio) |
| G-01 | No hay estados de personal (licencia, baja, reingreso) ni historial; "suspendido" es un flag sin motivo ni fecha | P1 | Resuelto (H113) |
| G-02 | PIN de supervisor sólo existe para cuenta corriente (gateado por esa feature) | P1 | Resuelto (H116, PIN general y políticas) |
| G-03 | No hay monitor de cajas abiertas | P1 | Resuelto (H115) |
| G-04 | No hay visor de auditoría para el negocio | P1 | Resuelto (H117) |
| G-05 | Un usuario puede tener turnos abiertos en dos cajas a la vez | P1 | Resuelto |
| B-03..B-12 | Bugs varios de UI y datos (ver §8) | P2/P3 | Mayoría resueltos |

---

## 2. Gestión de sucursales (pantalla "Sucursales y cajas")

**Estado:** ABM completo (ADR-045): sucursal con datos, horario, color, estados activa / pausada / archivada, principal única por índice parcial, cajas con tipo y baja lógica, gating por plan en triggers.

**Hallazgos**

- **S-01 (P0): "4 sucursales principales".** `branchesAdminApi.list()` leía `stores` sin filtrar por negocio y la policy era `tenant_id = current_tenant_id() OR is_internal()`. El dueño es staff interno, entonces veía las 4 principales de los 4 negocios. Resuelto en la base con `internal_scope()` (ADR-052) y, como defensa en profundidad, todas las listas de esta pantalla filtran por `getCurrentTenantId()`.
- **UX (P1):** la pantalla es una lista larga de tarjetas con menú "..." y el personal abajo como chips sueltos. No responde las preguntas de operación: ¿qué cajas están abiertas ahora?, ¿quién trabaja hoy en cada local?, ¿cuánto vendió hoy cada sucursal? El badge "Principal" en tono de marca compite con el estado y se lee como "la buena".
- **Sin logo por sucursal (P2):** lo hace `feat/sucursales-config-terminales` (logos, impresoras, medios y terminales por sucursal). Acá se deja el lugar del logo con un placeholder (iniciales sobre el color de la sucursal) y los links a Configuración con `?sucursal=`.
- **Sin vista de detalle (P2):** todo se edita desde modales. Falta un detalle por sucursal con pestañas (Resumen, Cajas, Personal, Configuración, Historial).
- **Sin historial por sucursal (P2):** `audit_logs.store_id` existe desde `20261015300000` pero nadie lo muestra.
- **Pendientes heredados (ADR-045):** grupos o zonas, plantilla de sucursal nueva, importación XLSX, PV y razón social por sucursal (H92, H98).

## 3. Ciclo de vida del personal

**Estado:** `tenant_users.status` admite `active | suspended | invited`; `member_admin` cambia entre `active` y `suspended` sin motivo, sin fecha de vuelta y sin historial. `staff_branch_assignments` resuelve muy bien sucursal base, coberturas y traslados con vigencias, pero no hay estados laborales.

| Evento real del mostrador | Hoy | Debería |
|---|---|---|
| Alta con sucursal y rol | Invitar sin sucursal (la otra rama sumó `store_ids`) | Sucursal base + adicionales + rol por sucursal en el mismo paso |
| Traslado | Modal de sucursales (bien, pero escondido tras un ícono) | Timeline visible por persona |
| Suspensión (sanción) | Flag sin motivo ni fecha | Motivo obligatorio, desde y hasta (vuelve sola), corta la operación al instante |
| Licencia (vacaciones, enfermedad, maternidad, estudio) | No existe | Fechas y tipo; no opera; programable |
| Baja (despido, renuncia, fin de contrato) | No existe (se suspende) | Fecha y motivo; corta el acceso al negocio (sesiones y negocio activo); conserva historia; no consume asiento |
| Reingreso | No existe | Vuelve a activo con nueva sucursal base; queda en el historial |

**Hallazgos**

- **G-01 (P1):** sin máquina de estados ni historial: no se puede responder "¿quién estaba de licencia el 3 de marzo?" ni "¿por qué se dio de baja?".
- **S-05 (P0):** `member_admin.update_member` permite a un encargado cambiar el rol del dueño a cajero (sólo controla que el rol nuevo no sea `owner`) y `set_member_status` permite a un encargado suspender al dueño o a otro encargado.
- **S-06 (P0):** `invite_user` hace `upsert` sobre la membresía: invitar el email del dueño con rol cajero lo degrada.
- **B-01 (P0):** `invite_user` crea la membresía pero no setea `app_metadata.current_tenant_id`; `current_tenant_id()` devuelve null y la RLS niega todo. El layout deja pasar (mira la membresía) y la app aparece vacía o con errores.
- **S-07 (P1):** el JWT lleva el negocio por `app_metadata`; un usuario suspendido sigue teniendo `current_tenant_id` y el refresh lo renueva sin límite. La RLS de tablas de negocio no mira el estado de la membresía. Raíz pendiente: que `current_tenant_id()` valide la membresía como initplan (alto impacto: toca todas las policies; queda en roadmap H118 con medición).
- **Perfiles sin cuenta (P2):** `cashier_profiles.status` sólo `active | suspended`; mismo tratamiento que los usuarios (estados con motivo).
- **Cupos (P2):** las bajas no deben contar para `max_users`; hoy se cuenta `status = 'active'` y una suspensión libera el cupo (lo correcto: suspensión y licencia ocupan cupo, baja no).

## 4. Propiedad de la caja (turnos)

Regla pedida: cada usuario opera sólo SU turno; el dueño puede vender en cualquier sucursal pero abriendo su propia caja; nadie vende, retira ni cierra en el turno de otro; un supervisor puede forzar el cierre ajeno con PIN, motivo y auditoría.

**Hallazgos**

- **S-03 (P0):** `resolve_sale_shift` (a) con turno explícito valida negocio, abierto y sucursal, **no el dueño del turno**; (b) con una sola sucursal toma "el último turno abierto de la principal", de cualquiera; (c) con varias, si todos los turnos abiertos están en una sucursal, toma el último de cualquiera. El test `rls-sucursales` incluso vende como dueño en el turno del encargado.
- **S-02 (P0):** `close_cash_shift` es SECURITY INVOKER y sólo filtra por negocio y estado: cualquier miembro cierra el turno de otro. Peor: como es invoker, un cliente puede hacer el `UPDATE` de `cash_shifts` directo por REST.
- **S-04 (P0):** `cash_movements` tiene policy `for all` de negocio: insertar `type='sale'` falsos, editar montos o borrar movimientos por REST (el trigger de auditoría registra insert y delete, pero no lo impide).
- **G-05 (P1):** `open_cash_shift` impide dos turnos en la misma caja pero no que un usuario tenga dos turnos abiertos (dos cajas, dos sucursales).
- **POS (P1):** `useOpenShift` muestra el turno de la caja aunque sea de otro; el cajero cree que está vendiendo en "su" caja.
- **Caja compartida (decisión):** hay kioscos donde dos empleados comparten cajón. Se agrega el flag operativo `shared_shift` (apagado por defecto) en Seguridad: con él, cualquier usuario habilitado en la sucursal vende en el turno abierto, pero retiros, ingresos y cierre siguen siendo del dueño del turno o de un supervisor.

## 5. Monitor de cajas

**G-03 (P1):** no existe. El dueño no sabe qué cajas están abiertas, desde cuándo ni quién las tiene. Hace falta: por sucursal, cajas abiertas, usuario, desde cuándo (contador en vivo), ventas y total del turno, efectivo esperado, última actividad y acciones (detalle, cierre forzado con PIN). También como widget del Panel del dueño. Lectura por RPC (`cash_monitor`) que respeta el alcance por sucursal del que mira.

## 6. Auditoría

**Estado:** `audit_logs` append-only, triggers genéricos en tablas de negocio, inserts a mano en las RPC, `store_id` completado por trigger (`20261015300000`).

**Hallazgos**

- **S-08 (P1):** cualquier miembro (cajero, solo lectura) lee toda la auditoría del negocio, con datos antes y después.
- **G-04 (P1):** no hay visor para el negocio (sólo el panel interno).
- **Cobertura (P2):** no se audita apertura de turno con contexto (lo hace el trigger genérico, sin sucursal ni caja legibles), cambios de estado del personal, intentos de PIN fuera de cuenta corriente, cierres forzados ni cambios de la política de seguridad. Todo eso entra con esta rama.
- **Retención y export (P2):** sin export; se agrega XLSX desde el visor. Retención por plan queda en roadmap.
- **Feature:** `auditoria` existe en planes (Business) como MARKETING-FUTURO. Pasa a real: **registrar siempre es BASE** (principio no negociable 3); el **visor** (filtros, diff, export) es OPTIONAL `auditoria`, gateado en la RPC `audit_log_search`.

## 7. PIN de supervisor

**Estado:** `account_supervisor_pins` (bcrypt, bloqueo 5 intentos / 15 min, token de un solo uso) sólo para destrabar cuenta corriente, y gateado por `cuenta_corriente`: un negocio sin cuenta corriente no puede cargar PIN. `SupervisorPinCard` vive en Configuración de cuenta corriente.

Cobertura de acciones (lo que un experto de retail espera que pida PIN):

| Acción | RPC o punto de escritura | ¿Pide PIN hoy? | Esta rama |
|---|---|---|---|
| Descuento sobre el tope | `create_sale` (tope por rol, rechaza) | No (rechaza sin alternativa) | PIN por encima de X % (trigger en `sales`, sin tocar `create_sale`) |
| Anulación de venta | `void_sale` (invoker) | No; cualquier miembro anula | PIN desde $Y (trigger en `sales`) |
| Devolución | `return_sale`, `return_sale_v2`, `exchange_sale` | No | PIN desde $Y (trigger en `sale_returns`) |
| Retiro de caja | insert directo en `cash_movements` | No | PIN desde $Y + dueño del turno |
| Ingreso de caja | insert directo | No | PIN opcional + dueño del turno |
| Cierre de turno ajeno | `close_cash_shift` | No (cualquiera cierra) | Sólo con `cash_force_close` (supervisor con PIN o sesión, motivo) |
| Cuenta corriente bloqueada | `payment_account_charge` | Sí | Sin cambios (comparte el PIN) |
| Cambio de precio en la línea | `create_sale` acepta `unit_price` del navegador | No | Roadmap H119 (necesita precio resuelto en el servidor) |
| Borrar ítem tras cobro parcial | Carrito (cliente) + cobros en espera | No | Roadmap H119 (coordinar con `feat/cobros-en-espera`) |
| Reapertura de turno | No existe | n/a | Roadmap H119 |
| Abrir cajón sin venta | Hardware | No | Roadmap H119 |

**Hallazgos**

- **G-02 (P1):** PIN atado a una feature opcional; sin políticas por acción ni umbrales; sin lista de quién puede ser supervisor (siempre dueño y encargado); sin rotación; intentos y bloqueo fijos.
- **Diseño elegido:** el PIN pasa a ser general (misma tabla, RPC nuevas sin gating de cuenta corriente, que siguen funcionando). Una autorización devuelve un token de un solo uso atado a acción, cajero y monto; el cliente lo manda en el header `x-ninja-supervisor-token` y los triggers lo consumen. Así se exige en el servidor **sin recrear `create_sale`, `void_sale` ni las devoluciones** (que tocan otras ramas). Quien ya es supervisor por rol actúa con su sesión (queda auditado "por sesión").

## 8. Bugs encontrados leyendo el código

| # | Dónde | Bug | Sev. | Estado |
|---|---|---|---|---|
| B-02 | `TeamSection` + Panel del dueño | Los diálogos son componentes definidos **dentro** de `TeamSection`: cada render del padre los vuelve a montar y pierden el estado (el modal abierto por `#invitar` se cierra apenas cargan los miembros). Además `next/link` con `#invitar` no dispara `hashchange` | P1 | Resuelto |
| B-03 | `branchesAdminApi.assignments` (base) | `.eq()` antes de `.select()`: supabase-js no lo admite | P1 | Resuelto |
| B-04 | `useBranchScope` | Lee el rol de `tenant_users` sin filtrar por negocio: con dos membresías toma cualquiera | P2 | Resuelto |
| B-05 | `useCurrentRegister` (respaldo) y `cashier_profiles` en `TeamSection` / `useStaffDirectory` | Sin filtro por negocio | P2 | Resuelto |
| B-06 | Panel del dueño, "Sucursales" en Uso del plan | Cuenta sucursales sin filtrar las pausadas ni mostrar cajas | P3 | Resuelto |
| B-07 | `useStaffDirectory` | Oculta suspendidos pero no a los de licencia o baja | P2 | Resuelto |
| B-08 | `invite_user` | Reinvitar a un suspendido lo reactiva sin rastro de motivo | P2 | Resuelto (reingreso explícito) |
| B-09 | `member_admin.set_member_status` | Suspender no corta sesiones ni turnos abiertos | P2 | Resuelto (la baja corta; la suspensión bloquea operación) |
| B-10 | `close_cash_shift` | El encargado no tiene forma legítima de cerrar la caja que un cajero dejó abierta al irse | P1 | Resuelto (`cash_force_close`) |
| B-11 | `resolveRegister` | Puede elegir una caja ocupada por otro sin avisar | P2 | Resuelto (aviso de caja ajena en el POS) |
| B-12 | Panel del dueño | Sin gráficos, sin vista por sucursal | P2 | Resuelto (H118) |

## 9. Fuga de datos del staff interno en páginas del negocio

Con `internal_scope()` (ADR-052) la RLS ya no abre negocios ajenos fuera de `/internal`. Igual se listan las lecturas del panel del negocio que **sólo** dependen de la RLS (sin `.eq("tenant_id")`), porque son las que se rompían (`.maybeSingle()` con varias filas) o mezclaban datos:

- Arregladas en esta rama: `stores`, `cash_registers`, `staff_branch_assignments` (base), `cashier_profiles` (`TeamSection`, `useStaffDirectory`), respaldo de caja de `useCurrentRegister`, `tenant_users` en `useBranchScope`, y todo lo nuevo (`cash_monitor`, `audit_log_search`, `staff_*` son RPC que resuelven el negocio en el servidor).
- Pendientes (cubiertas por `internal_scope()`, sin riesgo para clientes finales; conviene agregar el filtro al tocarlas): `pos_settings` (`modules/pos/api.ts`, `modules/customers/api.ts`, `modules/sales/api.ts`, `modules/products/api.ts`, `modules/catalog/hooks.ts`, `modules/dining/hooks.ts`, `modules/delivery/hooks.ts`, `modules/tickets/hooks.ts`, `hooks/usePageSize.ts`, `components/sales/TicketModal.tsx`), `tenant_payment_methods` (`modules/pos/api.ts`, `components/pos/QrCheckoutModal.tsx`, `components/dashboard-team/PaymentPlansGridModal.tsx`), `payment_plans`, `mp_payment_intents`, `ticket_templates`, `tenant_branding` (`modules/tickets/hooks.ts`, pantalla del cliente), `warranty_plans`, `return_reasons`, `customer_groups`, `sale_returns`, `store_credit_vouchers`, `store_credit_movements`, `customer_account_movements`, `cash_z_closures`, `stock_transfers*`, `tenant_catalog_purchases`. Recomendación: helper `tenantScoped(query)` y regla de lint (H118).

## 10. Panel del dueño

- Las tres tarjetas (Negocio, Plan, Uso) son correctas pero planas: no hay nada operativo (ventas de hoy, cajas abiertas, personal trabajando) ni comparación por sucursal.
- "Uso del plan" no muestra cajas por sucursal (`max_registers_per_store`) ni usuarios en baja.
- Sin gráficos. Ya existe `components/charts/EChart` (ADR-035) para reutilizar.
- Sin selector "Todas / sucursal".

## 11. Qué se hace en esta rama (resumen de decisiones, ver ADR-051)

1. **Sucursales y cajas** rediseñada: tablero con tarjetas por sucursal (logo o iniciales, dirección, estado, cajas abiertas, personal hoy, ventas de hoy) y detalle por sucursal con pestañas Resumen, Cajas, Personal, Configuración (links con `?sucursal=`) e Historial. "Principal" pasa a ser una marca neutra con estrella.
2. **Personal:** estados `activo`, `suspendido`, `licencia`, `baja` con historial (`staff_status_events`), evaluación perezosa por fecha (sin cron), RPC auditadas, baja que revoca sesiones y negocio activo, reingreso; tablero visual por sucursal con avatares y chips de estado; timeline por persona (estados + traslados); invitar desde el panel con sucursal base, adicionales y rol por sucursal.
3. **Propiedad de la caja:** `assert_shift_owner()` usada por `resolve_sale_shift`, guardas en `cash_shifts` y `cash_movements`, un turno abierto por usuario, `cash_force_close` con PIN y motivo, aviso de caja ajena en el POS, flag `shared_shift`.
4. **Monitor de cajas** (`/caja/monitor`) y widget en el Panel del dueño.
5. **Seguridad y auditoría** en Configuración: políticas de PIN por acción con umbrales, roles y usuarios supervisores, intentos y bloqueo, rotación, PIN propio, visor de auditoría con filtros, diff y XLSX.
6. **Panel del dueño:** tarjetas rehechas, gráficos (ventas de hoy vs ayer por sucursal, cajas abiertas, personal), barras de uso con límites, selector de sucursal.

Lo que no entra queda en el roadmap F17 (H113 a H119) con su clasificación.
