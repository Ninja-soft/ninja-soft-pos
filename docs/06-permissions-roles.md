# Permisos y Roles — NinjaSoft POS

Define los roles del sistema, sus permisos asociados y la lógica de autorización. Es referencia única para frontend, Edge Functions y revisiones de seguridad.

## 1. Tipos de usuarios

NinjaSoft POS distingue dos categorías de usuarios:

| Categoría | Atributo identificador | Acceso |
|---|---|---|
| Usuarios de cliente | `is_internal = false` | Solo a su(s) tenant(s) vía `tenant_users`. |
| Staff interno NinjaSoft | `is_internal = true` | Panel interno + acceso controlado a cualquier tenant con auditoría. |

## 2. Roles de cliente

Los roles viven en la tabla `tenant_users.role`. Un usuario puede tener distinto rol en distintos tenants.

| Rol | Quién | Alcance |
|---|---|---|
| `owner` | Dueño / titular del negocio | Todo dentro del tenant. Único que puede cambiar el plan, ceder titularidad, eliminar el tenant. |
| `manager` | Encargado, gerente | Operación completa salvo administración de plan y titularidad. |
| `cashier` | Cajero, mozo, vendedor | Solo POS, caja, clientes (lectura). |
| `viewer` | Contador, auditor externo | Solo lectura de reportes y comprobantes. |

> **Regla.** Un tenant siempre tiene al menos un `owner`. No se puede dejar un tenant sin owner.

## 3. Roles internos NinjaSoft

Definidos por la combinación `is_internal = true` + `internal_level` en `app_metadata` y espejo `users.internal_level`.

### 3.1 Niveles implementados

| Nivel interno | Quién | Alcance |
|---|---|---|
| `super_admin` | Founders, CTO | Todo el panel interno. Único que puede asignar/quitar staff crítico. |
| `admin` | Operaciones NinjaSoft | Gestiona tenants, planes, estados, flags y soporte. No puede quitar el último super-admin. |
| `support` | Equipo de soporte | Lectura + acciones acotadas de soporte con motivo. No cambia planes ni staff. |

### 3.1b Permiso Cobranzas (implementado, F20-1 · ADR-115)

Permiso que **se suma al nivel** (tabla `platform_staff_permissions`, no viaja en el JWT): una persona de `support` con **Cobranzas** ve y opera las cuentas corrientes de la plataforma (registrar pagos, bonificar, cargo manual, anular un cargo, revertir un pago) sin administrar negocios, porque las RPC de negocios siguen rechazando a `support`. `admin` y `super_admin` operan cobranzas por su nivel. Lo da o lo quita un `super_admin` desde `/internal/staff` con motivo (`internal_set_staff_permission`).

| Acción de cobranza | support | support + Cobranzas | admin | super_admin |
|---|---|---|---|---|
| Ver estado de cuenta, Cobranzas e historia | ✅ | ✅ | ✅ | ✅ |
| Registrar pago, cargo manual, revertir pago | ❌ | ✅ | ✅ | ✅ |
| Bonificar o anular un cargo | ❌ | ✅ hasta el tope | ✅ hasta el tope | ✅ (tope configurable, por defecto sin tope) |
| Condiciones de cobro (modalidad, plazo) | ❌ | ❌ | ✅ (exento no) | ✅ |
| Marcar negocio de prueba, editar topes, dar Cobranzas | ❌ | ❌ | ❌ | ✅ |

Los **topes** (`platform_billing_caps`, por nivel: `cobranzas`, `admin`, `super_admin`) son por operación y por mes calendario por negocio, suman bonificaciones, anulaciones, ajustes a favor y condonaciones de todo el staff, y se validan en el servidor (`platform_assert_forgiveness_cap`). Defaults: $ 50.000 por operación y $ 150.000 por mes para Cobranzas y admin; super_admin sin tope.

**Mora y punitorios (F20-9 · ADR-128):**

| Acción | support | support + Cobranzas | admin | super_admin | Dueño | Encargado | Cajero |
|---|---|---|---|---|---|---|---|
| Ver mora, punitorios, promesas y pasos de la escalera | ✅ | ✅ | ✅ | ✅ | Su cuenta (`my_billing_mora`) | Su cuenta | ❌ (sólo la restricción, sin importes) |
| Condonar o saldar punitorios | ❌ | ✅ hasta el tope | ✅ hasta el tope | ✅ | ❌ | ❌ | ❌ |
| Aprobar una condonación que superó el tope | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Cargar, ampliar o cancelar una promesa | ❌ | ✅ | ✅ | ✅ | Cargar la suya (`owner_promise_create`, con límites) | ❌ | ❌ |
| Política, escalera y promesas propias de un negocio; pausar punitorios | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Configuración: políticas, planes, escaleras, feriados, interruptores | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |

### 3.1c Participación del staff (implementado, F21 · ADR-121)

| Acción | support | admin | Cobranzas | super_admin | La propia persona |
|---|---|---|---|---|---|
| Configurar personas, %, reglas por cliente, gastos, cotización, ajustes | ❌ | ❌ | ❌ | ✅ | ❌ |
| Ver gastos, liquidaciones de todos y el panel `/internal/participacion` | ❌ | ❌ | ❌ | ✅ | ❌ |
| Cerrar liquidaciones y registrar o anular pagos | ❌ | ❌ | ❌ | ✅ | ❌ |
| Ver su %, sus reglas, sus liquidaciones, sus pagos y su proyección | | | | | ✅ |
| Cargar o editar sus cuentas de cobro (CBU / CVU / alias) | | | | ✅ | ✅ |

Todo con `(select internal_scope())` (panel interno) y `staff_is_owner()` (= `internal_level() = 'super_admin'`); cada persona lee sus filas por `staff_my_member_ids()`. Los insumos del cálculo (`staff_settlement_inputs`) son sólo `service_role` (Edge `staff_payouts`).

### 3.2 Roles objetivo por área

Estos roles pueden implementarse como permisos granulares sobre `internal_level` o como una tabla futura `internal_staff_roles`:

| Rol objetivo | Quién | Alcance |
|---|---|---|
| `sales` | Equipo comercial | Alta comercial, trials, upgrades, reactivaciones y notas comerciales. |
| `billing` | Administración/cobranzas | Pagos manuales, deuda, vencimientos, suspensión/reactivación por cobranza. |
| `developer` | Equipo técnico | Logs, health, flags técnicos y debugging. No cambia precio/plan. |
| `support_lead` | Soporte avanzado | Impersonation controlada, escalaciones y acciones temporales con motivo. |

## 4. Matriz de permisos — Clientes

Notación: ✅ tiene el permiso · ❌ no lo tiene · ⚠️ con restricciones.

### 4.1 Punto de Venta

| Acción | Owner | Manager | Cashier | Viewer |
|---|---|---|---|---|
| Vender productos | ✅ | ✅ | ✅ | ❌ |
| Aplicar descuento ≤ 10% | ✅ | ✅ | ✅ | ❌ |
| Aplicar descuento > 10% | ✅ | ✅ | ⚠️ (requiere PIN de manager) | ❌ |
| Anular venta del día | ✅ | ✅ | ⚠️ (PIN de supervisor sólo si el dueño prende la regla "Anular una venta"; apagada por defecto) | ❌ |
| Anular venta días anteriores | ✅ | ✅ | ❌ | ❌ |
| Ver ventas propias | ✅ | ✅ | ✅ | ✅ |
| Ver ventas de otros cajeros | ✅ | ✅ | ❌ | ✅ |

### 4.2 Caja

| Acción | Owner | Manager | Cashier | Viewer |
|---|---|---|---|---|
| Abrir turno propio | ✅ | ✅ | ✅ | ❌ |
| Cerrar turno propio | ✅ | ✅ | ✅ | ❌ |
| Cerrar turno de otro | ✅ | ✅ | ❌ | ❌ |
| Movimientos de caja (retiros, ingresos) | ✅ | ✅ | ⚠️ (sólo en su turno; PIN de supervisor desde el monto que fije el dueño en las reglas "Retiro de caja" e "Ingreso de caja", apagadas por defecto) | ❌ |
| Ver arqueo histórico | ✅ | ✅ | ✅ (solo el propio) | ✅ |

### 4.3 Productos y stock

| Acción | Owner | Manager | Cashier | Viewer |
|---|---|---|---|---|
| Crear producto | ✅ | ✅ | ❌ | ❌ |
| Editar producto | ✅ | ✅ | ❌ | ❌ |
| Cambiar precio | ✅ | ✅ | ❌ | ❌ |
| Baja lógica de producto | ✅ | ✅ | ❌ | ❌ |
| Ajuste manual de stock | ✅ | ✅ | ❌ | ❌ |
| Ver stock | ✅ | ✅ | ✅ | ✅ |
| Importar productos masivamente | ✅ | ⚠️ (con confirmación) | ❌ | ❌ |

### 4.4 Clientes

| Acción | Owner | Manager | Cashier | Viewer |
|---|---|---|---|---|
| Alta de cliente | ✅ | ✅ | ✅ | ❌ |
| Editar cliente | ✅ | ✅ | ⚠️ (solo datos de contacto) | ❌ |
| Baja de cliente | ✅ | ✅ | ❌ | ❌ |
| Ver cuenta corriente | ✅ | ✅ | ❌ | ✅ |

### 4.5 Usuarios y configuración

| Acción | Owner | Manager | Cashier | Viewer |
|---|---|---|---|---|
| Invitar usuario | ✅ | ⚠️ (no puede invitar owners) | ❌ | ❌ |
| Cambiar rol | ✅ | ⚠️ (no puede crear/quitar owners) | ❌ | ❌ |
| Eliminar usuario | ✅ | ✅ (no a owners) | ❌ | ❌ |
| Cambiar configuración del tenant | ✅ | ⚠️ (no plan, no titularidad) | ❌ | ❌ |
| Cambiar plan | ✅ | ❌ | ❌ | ❌ |
| Ceder titularidad | ✅ | ❌ | ❌ | ❌ |
| Eliminar tenant | ✅ | ❌ | ❌ | ❌ |

### 4.6 Reportes

| Acción | Owner | Manager | Cashier | Viewer |
|---|---|---|---|---|
| Reporte del día (propio) | ✅ | ✅ | ✅ | ✅ |
| Reporte completo del negocio | ✅ | ✅ | ⚠️ (ve Reportes, acotado a sus sucursales) | ✅ (sus sucursales) |
| Exportar reportes | ✅ | ✅ | ❌ | ✅ |
| Ver audit_logs | ✅ | ✅ | ❌ | ✅ |

### 4.7 Qué garantiza la base (ADR-071)

Las matrices de arriba son la regla de negocio. Esta tabla dice qué parte la hace cumplir **la base** (RLS, triggers y RPC), o sea lo que vale aunque alguien llame a la API sin pasar por la UI. La cubre `tests/integration/roles.test.ts`.

Notación: ✅ puede · ❌ la base lo rechaza · ⚠️ con condición.

| Acción | Owner | Manager | Cashier | Viewer | Dónde se hace cumplir |
|---|---|---|---|---|---|
| Ver productos, stock, ventas, clientes | ✅ | ✅ | ✅ (sus sucursales) | ✅ (sus sucursales) | RLS por negocio + alcance por sucursal (ADR-045) |
| Crear, editar o dar de baja productos y variantes | ✅ | ✅ | ❌ | ❌ | trigger `role_write_guard` (modo `manage`) + policy de `product_variants` |
| Cambiar precio de producto | ✅ | ✅ | ❌ | ❌ | `role_write_guard` (modo `manage`) |
| Categorías y marcas | ✅ | ✅ | ❌ | ❌ | `role_write_guard` (modo `manage`) |
| Ajuste manual de stock, merma, producción | ✅ | ✅ | ❌ | ❌ | `role_write_guard` en `products` y `stock_movements`; `adjust_store_stock` exige owner/manager |
| Mover stock al vender, anular o devolver | ✅ | ✅ | ✅ | ❌ | RPC SECURITY DEFINER (`create_sale`, `void_sale`, `return_sale`) |
| Alta de cliente y edición de contacto | ✅ | ✅ | ✅ | ❌ | `role_write_guard` (modo `customers`) |
| Baja de cliente | ✅ | ✅ | ❌ | ❌ | `role_write_guard` (modo `customers`) |
| Abrir turno de caja | ✅ | ✅ | ✅ | ❌ | `open_cash_shift` + `role_write_guard` en `cash_shifts` |
| Cerrar turno propio / ajeno | ✅ / ⚠️ forzado | ✅ / ⚠️ forzado | ✅ / ❌ | ❌ | `cash_shifts_guard`, `cash_force_close` (ADR-051) |
| Ingresos y retiros de caja | ✅ | ✅ | ⚠️ turno propio, PIN por política | ❌ | `cash_movements_guard` (ADR-051) |
| Vender | ✅ | ✅ | ✅ (turno propio) | ❌ | `create_sale` + `role_write_guard` en `sales` |
| Descuento sobre el tope | ✅ | ✅ | ⚠️ PIN | ❌ | `sales_supervisor` (ADR-051) |
| Anular venta del día | ✅ | ✅ | ⚠️ PIN por política | ❌ | `void_sale` (SECURITY DEFINER) + `sales_supervisor` |
| Anular venta de días anteriores | ✅ | ✅ | ❌ | ❌ | `void_sale`: el cajero (rol efectivo en la sucursal) sólo anula ventas del día, hora de Argentina |
| Cambiar `sales.status` por REST | ❌ | ❌ | ❌ | ❌ | `role_write_guard` (modo `sales`): se anula con `void_sale` |
| Devoluciones y reintegros | ✅ | ✅ | ⚠️ PIN por política | ❌ | `return_sale` / `return_sale_v2` + `sale_returns_supervisor` (ADR-067) |
| Listas de precios, condiciones de pago, escalas | ✅ | ✅ | ❌ | ❌ | `price_can_write()` / `price_pro_can_write()` (ADR-058) |
| Planes de cuotas | ✅ | ✅ | ❌ | ❌ | policies de `payment_plans` |
| Configuración del POS (`pos_settings`) | ✅ | ⚠️ sólo la política de venta offline | ❌ | ❌ | policies de `pos_settings`; `offline_policy_save` acepta dueño o encargado (ADR-077) |
| Medios de pago y cuentas de transferencia | ✅ | ✅ | ❌ | ❌ | policies de `transfer_accounts`, `payment_terminals` (ADR-055) |
| Conectar logísticas de envío (credenciales) | ✅ | ✅ | ❌ | ❌ | Edge `shipping` + `shipping_access_check` (modo `manage`; por sucursal con `multi_sucursal`), ADR-103 |
| Crear envíos, cotizar e imprimir etiquetas | ✅ | ✅ | ✅ | ❌ | `shipment_create` + `role_write_guard` (modo `operate`), ADR-103 |
| Cancelar un envío ya creado en la logística, reintentar | ✅ | ✅ | ⚠️ sólo si todavía no está en la logística | ❌ | `shipment_cancel` / `shipment_retry`, ADR-103 |
| Seguridad y PIN de supervisor | ✅ | ❌ | ❌ | ❌ | `security_settings_save` exige dueño |
| Impuestos (regímenes, exenciones) | ✅ | ✅ | ❌ | ❌ | `tax_can_write()` (ADR-068) |
| Valores impositivos del negocio (versiones con vigencia, conceptos y reglas propias, perfiles de padrón, alícuota a mano por CUIT) | ✅ | ✅ | ❌ | ❌ | `tax_custom_save` / `_tax_custom_assert`, `tax_can_write('percepciones_retenciones')`, `role_write_guard` (ADR-105) |
| Contabilidad | ✅ | ✅ (reabrir: sólo owner) | ❌ | ❌ | `acc_assert()`, `acc_period_reopen` (ADR-066) |
| Compras, proveedores, tesorería | ✅ | ✅ | ❌ | ❌ | `purchase_can_write()`, `treasury_can_write()` (ADR-050, ADR-059) |

Reglas del trigger `role_write_guard` (migración `20261031200000_permisos_por_rol.sql`):

- Toma el rol del usuario del JWT **en el negocio de la fila** (`member_role_in`). Sin usuario (cron, `service_role`) o sin membresía (staff interno, acotado por `internal_scope()` en RLS) no aplica.
- `viewer` no escribe nunca en las tablas operativas, ni por REST ni a través de una RPC.
- `cashier` no escribe catálogo ni stock por REST ni por RPC `SECURITY INVOKER`; las RPC `SECURITY DEFINER` (vender, anular, devolver, recibir compras, traslados) siguen moviendo stock en su nombre.

Notas sobre lo que hace cumplir la base (diferencias detectadas en ADR-086):

- **Anular venta del día:** el cajero anula ventas del día sin PIN salvo que el dueño prenda la regla "Anular una venta" (`security_settings.pin_policy.sale_void`, apagada por defecto).
- **Reportes:** no hay corte por rol. Todos los roles ven Reportes; la base limita ventas, turnos, movimientos y cierres Z por sucursal (`user_allowed_store_ids()`, ADR-045).
- **Ingresos de caja del cajero:** no hay un tope fijo de $10k. Lo reemplaza la regla configurable "Ingreso de caja" (`pin_policy.cash_in`, con umbral en pesos, apagada por defecto): sobre el umbral, quien no es supervisor necesita PIN (`require_supervisor` en `trg_cash_movements_guard`). Un tope nominal fijo no se implementó a propósito: en pesos queda viejo enseguida y bloquearía cajas que hoy operan. Deuda: si se quiere un tope duro por rol, sumarlo como umbral configurable por rol en `security_settings`.

Pendiente (no lo hace cumplir la base): edición de clientes acotada a datos de contacto para el cajero, importación masiva con confirmación para el encargado y el cambio de rol de usuarios (lo hacen las Edge Functions `member_admin` e `invite_user`, sin test de integración en esta suite).

## 5. Matriz de permisos — Internos NinjaSoft

| Acción | super_admin | admin | support | sales | billing | developer |
|---|---|---|---|---|---|---|
| Ver listado de tenants | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Crear tenant | ✅ | ✅ | ⚠️ | ✅ | ❌ | ❌ |
| Suspender tenant | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Eliminar tenant | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Abrir contexto de tenant (impersonation) | ✅ | ✅ | ⚠️ solo lectura | ❌ | ❌ | ⚠️ debugging |
| Cambiar plan | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Extender trial | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Registrar pago manual | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Crear plan custom por cliente | ✅ | ✅ | ❌ | ⚠️ propuesta | ✅ | ❌ |
| Aumentar cuota/precio de cliente | ✅ | ⚠️ | ❌ | ⚠️ propuesta | ✅ | ❌ |
| Enviar notificación a tenant | ✅ | ✅ | ⚠️ soporte | ✅ | ✅ | ⚠️ técnica |
| Activar/desactivar feature flag global | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Activar/desactivar feature flag por tenant | ✅ | ✅ | ❌ | ⚠️ comercial | ❌ | ✅ |
| Invitar usuarios a tenant | ✅ | ✅ | ⚠️ soporte | ✅ | ❌ | ❌ |
| Suspender/reactivar cuenta de usuario | ✅ | ✅ (no staff) | ❌ | ❌ | ❌ | ❌ |
| Convertir usuario en staff interno | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cambiar rol interno | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Ver audit_logs cross-tenant | ✅ | ✅ | ✅ | ⚠️ comercial | ✅ | ✅ |
| Modificar `system_settings` | ✅ | ❌ | ❌ | ❌ | ❌ | ⚠️ |

⚠️ en internos significa "requiere registro de motivo en audit_logs".

**Implementado (H11):** la Edge Function `staff_admin` aplica esta matriz para `set_level` (solo `super_admin`, con bootstrap del primero y protección del último super admin) y `set_active` (suspender/reactivar cuentas: `admin`+; a un staff solo lo toca un `super_admin`; nadie se suspende a sí mismo). Ambas acciones auditan en `audit_logs` (`staff_level_set`, `user_suspended`/`user_reactivated`). La suspensión es un ban en `auth` (espejo visible en `users.suspended_at`). UI: `/internal/staff` y `/internal/usuarios`.

## 6. Convención de nombres de permisos

Formato: `<recurso>:<acción>`. Lista canónica vive en `lib/permissions/permissions.ts`:

```typescript
export const PERMISSIONS = [
  // POS
  'sales:create',
  'sales:void',
  'sales:discount_high',
  'sales:view_all',
  
  // Caja
  'cash_shift:open',
  'cash_shift:close_own',
  'cash_shift:close_any',
  'cash_movement:create',
  
  // Productos
  'products:create',
  'products:update',
  'products:delete',
  'products:price_change',
  'stock:adjust',
  'stock:import',
  
  // Clientes
  'customers:create',
  'customers:update',
  'customers:delete',
  
  // Usuarios y config
  'users:invite',
  'users:role_change',
  'users:delete',
  'tenant:settings',
  'tenant:plan_change',
  'tenant:transfer',
  'tenant:delete',
  
  // Reportes
  'reports:view_own',
  'reports:view_all',
  'reports:export',
  'audit:view',
  
  // Internos
  'internal:tenants_manage',
  'internal:plans_manage',
  'internal:flags_manage',
  'internal:impersonate',
  'internal:roles_assign',
] as const

export type Permission = typeof PERMISSIONS[number]
```

## 7. Helper `can()`

API canónica:

```typescript
// lib/permissions/can.ts
export function can(user: User | null, permission: Permission, context?: object): boolean
```

Uso en componentes:

```tsx
import { can } from '@/lib/permissions/can'

function VoidSaleButton({ sale }: { sale: Sale }) {
  const user = useUser()
  if (!can(user, 'sales:void', { sale })) return null
  return <Button onClick={handleVoid}>Anular</Button>
}
```

Uso en Edge Functions: igual, importando desde un módulo compartido.

## 8. Componente `<PermissionGate>`

Para envolver UI condicional:

```tsx
<PermissionGate permission="users:invite">
  <InviteUserButton />
</PermissionGate>

<PermissionGate permission="users:invite" fallback={<p>No tenés permisos.</p>}>
  <InviteUserForm />
</PermissionGate>
```

## 9. Cambios de permisos

Los permisos asociados a roles son **definiciones de código**, no datos en BD. Esto es intencional: mantiene la matriz versionada y trazable.

Para overrides puntuales por tenant (ej. un cliente que necesita que sus managers también puedan eliminar usuarios), usar feature flags + lógica explícita en `can()`.

```typescript
// Ejemplo conceptual
if (hasFeatureFlag('manager_can_delete_users') && user.role === 'manager') {
  return permission === 'users:delete'
}
```

## 9.1 Roles retail propios

F11 agrega roles configurables por tenant para comercios con separación de salón, caja y despacho. Los presets iniciales son:

| Rol | Descripción |
|---|---|
| `salesperson_retail` | Vendedor de salón. Arma pedidos para que cobre la cajera. No cobra ni anula. |
| `dispatcher` | Expedicionista. Prepara y entrega pedidos pendientes de despacho. No toca caja ni POS. |
| `cashier_plus` | Cajero estándar + facturar pedidos de salón + reimprimir + descuentos por encima del tope. |
| `retail_manager` | Encargado con visibilidad total: manager + pedidos de todos + configuración comercial + stock de otras sucursales. |

Reglas:

- [ ] Los roles de sistema se pueden editar pero no borrar.
- [ ] El tenant puede crear roles propios con permisos granulares.
- [ ] Cada cambio de permiso queda en `audit_logs`.
- [ ] Las Edge Functions revalidan permisos; no alcanza con ocultar botones.

## 9.1b Alcance por sucursal (F17 · H91, ADR-045)

El rol sigue siendo por negocio (`tenant_users.role`); la sucursal define **dónde** se opera y, opcionalmente, pisa el rol en esa sucursal.

| Situación | Sucursales que ve y opera |
|---|---|
| Dueño, staff interno, o negocio con una sola sucursal viva | Todas (incluidas archivadas, para la historia) |
| Con cobertura temporal vigente | Sólo la de la cobertura (exclusiva) |
| Con base y/o accesos adicionales vigentes | Esas |
| Encargado sin asignaciones vigentes | Todas (alcance central) |
| Cajero o solo lectura sin asignaciones vigentes | La sucursal principal |

- Asignaciones en `staff_branch_assignments` con vigencia por fecha (hora de Argentina), evaluadas al consultar: traslados y coberturas se programan sin cron.
- `user_allowed_store_ids()` alimenta las policies RESTRICTIVE de `sales`, `cash_shifts`, `cash_movements` y `cash_z_closures`, el alta de turnos (`open_cash_shift`) y la venta (`resolve_sale_shift`).
- `user_store_role(store)` devuelve el rol efectivo (el pisado por la asignación vigente o el del negocio); `create_sale` lo usa para el tope de descuento.
- Programar, cancelar o finalizar movimientos: owner o manager, con `multi_sucursal` en el plan, auditado (`staff_branch_scheduled`, `staff_branch_cancelled`, `staff_branch_ended`).

## 9.1c Estados del personal, caja propia y PIN de supervisor (F17 · H113 a H117, ADR-051)

**Estados** (`staff_status_events`, evaluados por fecha): activo, suspendido (motivo, vuelve solo si tiene fecha), de licencia (tipo y fechas) y de baja (despido, renuncia, fin de contrato, otro). Prioridad: baja > suspensión > licencia.

| Estado | Opera caja y vende | Ve datos del negocio | Membresía |
|---|---|---|---|
| Activo | Sí | Sí | `active` |
| Suspendido o de licencia | No (`user_allowed_store_ids()` vacío, `assert_staff_operational()`) | Sólo lo que no depende de sucursal, hasta que vence la sesión (residual, H118) | `active` |
| De baja | No | No desde el próximo refresh: se borran sus sesiones y se saca el negocio de `app_metadata` | `inactive` (no ocupa cupo) |

- Quién cambia estados: dueño a encargados, cajeros y perfiles; encargado sólo a cajeros y perfiles; nadie a sí mismo; nadie al dueño. Mismo criterio en `member_admin` (editar rol o suspender) e `invite_user` (no pisa miembros; sólo el dueño suma encargados).
- **Caja propia:** sólo quien abrió el turno vende, retira, ingresa y cierra (`assert_shift_owner`). Un turno abierto por usuario. El dueño vende en cualquier sucursal abriendo su caja ahí. Con "Caja compartida" (`security_settings.shared_shift`) otros venden en el turno abierto, pero retiros, ingresos y cierre siguen siendo del que lo abrió.
- **Cierre forzado** (`cash_force_close`): supervisor por rol o con PIN, motivo obligatorio, genera el Z y queda auditado con el dueño del turno.
- **PIN de supervisor:** supervisores = dueño + roles elegidos + personas elegidas (`security_settings`). Cada acción (descuento sobre %, anulación, devolución, retiro, ingreso desde $) pide PIN si quien la hace no es supervisor. El token de un solo uso viaja en el header `x-ninja-supervisor-token` y lo consumen triggers; intentos, bloqueo y rotación configurables.
- **PIN autenticador** (ADR-060, feature `pin_autenticador` desde Pro): además del fijo, cada supervisor autoriza con un PIN rotativo (cambia cada N horas), PIN de un uso (generado en "Mis PINes", vence en minutos, opcionalmente atado a una acción y un monto) o una app autenticadora (TOTP). Sólo un supervisor genera o ve sus propios códigos; los secretos y hashes no los lee nadie por PostgREST (ni el dueño). El dueño elige qué modos acepta cada acción (p. ej. anulaciones sólo con PIN de un uso), desbloquea y borra los PINes de otros. Bloqueo tras N fallos por supervisor y por quien pide.
- **Auditoría:** la leen dueño y encargado (o cada uno lo propio). Visor con filtros y export: feature `auditoria`.

## 9.2 Roles de servicios y agenda

F12 agrega presets para comercios de servicios donde importa la agenda, el profesional y la comisión:

| Rol | Descripción |
|---|---|
| `service_professional` | Profesional que ve su agenda, cobra o solicita cobro según configuración y consulta su productividad. |
| `front_desk` | Recepción/caja. Agenda turnos, maneja walk-ins, cobra servicios y productos. |
| `service_manager` | Encargado de servicios. Ve agenda de todos, comisiones, propinas, no-shows y reportes. |

Reglas:

- [ ] El profesional puede quedar limitado a su propia agenda y ventas.
- [ ] La recepción puede cobrar sin modificar comisiones ni reportes globales.
- [ ] Cambios de comisión, propina o profesional asignado quedan auditados.
- [x] **Recursos de agenda** (sillas, cabinas, `agenda_resources`): los cargan y editan dueño y encargado (policy + feature `agenda_recursos`); el resto los ve para agendar. ADR-082.
- [x] **Lista de espera** (`agenda_waitlist`): anotan, cancelan y pasan a turno dueño, encargado y cajero (recepción); solo lectura sólo mira. El paso a turno es sólo por RPC (`agenda_waitlist_schedule`). ADR-082.
- [x] **Datos de ejemplo de la agenda** (`agenda_demo_seed` / `agenda_demo_clear`): dueño y encargado. ADR-082.

## 9.3 Roles gastronómicos

F13 agrega presets para restaurante/cafetería/heladería con operación por salón, cocina/barra y despacho:

| Rol | Descripción |
|---|---|
| `waiter` | Mozo. Abre mesas, carga pedidos, envía comandas y puede pedir cuenta según permisos. |
| `head_waiter` | Encargado de salón. Mueve/une mesas, reasigna mozos, autoriza anulaciones de comanda. |
| `kitchen_staff` | Cocina/barra. Ve KDS/comandas de su estación y cambia estados de preparación. |
| `delivery_dispatcher` | Despacho. Gestiona take away/delivery, cadetes, estados y etiquetas de pedido. |
| `restaurant_manager` | Manager gastronómico. Configura salones, estaciones, menú, ruteo, reportes y permisos. |

Reglas:

- [ ] Cocina/barra no toca caja ni precios.
- [ ] Mozo no anula ítems ya enviados a cocina sin autorización.
- [ ] Cambios de mesa, transferencia de mozo, reimpresión y cancelación de comanda quedan auditados.
- [ ] El manager puede configurar estaciones e impresoras/KDS, pero no cambiar plan del tenant.

## 9.4 Rol de integración: API pública (ADR-094)

La API pública no usa una sesión de persona: actúa con una **credencial del negocio** (OAuth2 client_credentials) que crea el dueño. Equivale a un encargado recortado por los alcances de la credencial:

| Área | Qué puede |
|---|---|
| Productos | Leer (`products:read`); crear y editar por SKU (`products:write`). |
| Precios | Cambiar precio y costo por SKU (`prices:write`). |
| Stock | Leer sucursales y stock (`stock:read`); ajustar y contar con motivo (`stock:write`). |
| Ventas | Sólo lectura por rango (`sales:read`). |
| Clientes | Leer (`customers:read`); crear y editar datos de contacto y fiscales (`customers:write`). |
| Nunca | Caja, cobros, anulaciones, devoluciones, personal, permisos, plan, cuenta corriente del cliente. |

Reglas:

- [x] Crear, editar, rotar y revocar credenciales: **sólo el dueño**, auditado (`api_client_*`).
- [x] El negocio sale de la credencial, nunca del pedido; cada operación es una RPC SECURITY DEFINER que filtra por ese negocio.
- [x] Alcance insuficiente, credencial revocada o rotada y plan sin `api_publica` se rechazan en la base.
- [x] Cada lote queda en `audit_logs` con el id de la credencial (`entity_type = 'api_client'`); las filas tocadas, por los triggers de cada tabla.

## 10. Anti-patrones

❌ Hardcodear el chequeo del rol en lugar de usar `can()`:
```tsx
{user.role === 'owner' && <Button>Editar plan</Button>}  // MAL
```
✅ Correcto:
```tsx
<PermissionGate permission="tenant:plan_change">
  <Button>Editar plan</Button>
</PermissionGate>
```

❌ Confiar solo en ocultar UI: la Edge Function **siempre** revalida.

❌ Crear roles nuevos sin discusión: la matriz está pensada para cubrir 95% de casos. Casos especiales se modelan con feature flags.

## 11. Tests obligatorios

El agente `qa-engineer` debe garantizar:

- Test por rol que verifique que **no puede** hacer las acciones que no le corresponden.
- Test de Edge Function que rechace requests con `tenant_id` ajeno.
- Test de RLS que verifique aislamiento entre tenants (ver `05-security.md`).
