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
| Anular venta del día | ✅ | ✅ | ⚠️ (requiere PIN) | ❌ |
| Anular venta días anteriores | ✅ | ✅ | ❌ | ❌ |
| Ver ventas propias | ✅ | ✅ | ✅ | ✅ |
| Ver ventas de otros cajeros | ✅ | ✅ | ❌ | ✅ |

### 4.2 Caja

| Acción | Owner | Manager | Cashier | Viewer |
|---|---|---|---|---|
| Abrir turno propio | ✅ | ✅ | ✅ | ❌ |
| Cerrar turno propio | ✅ | ✅ | ✅ | ❌ |
| Cerrar turno de otro | ✅ | ✅ | ❌ | ❌ |
| Movimientos de caja (retiros, ingresos) | ✅ | ✅ | ⚠️ (solo ingresos < $10k) | ❌ |
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
| Reporte completo del negocio | ✅ | ✅ | ❌ | ✅ |
| Exportar reportes | ✅ | ✅ | ❌ | ✅ |
| Ver audit_logs | ✅ | ✅ | ❌ | ✅ |

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
| Convertir usuario en staff interno | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cambiar rol interno | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Ver audit_logs cross-tenant | ✅ | ✅ | ✅ | ⚠️ comercial | ✅ | ✅ |
| Modificar `system_settings` | ✅ | ❌ | ❌ | ❌ | ❌ | ⚠️ |

⚠️ en internos significa "requiere registro de motivo en audit_logs".

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
