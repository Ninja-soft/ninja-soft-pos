# Feature Flags — NinjaSoft POS

Sistema de activación de funcionalidades por tenant. Permite escalar el producto sin duplicar código, ofrecer features Beta a clientes selectos y desactivar rápidamente algo que rompe.

> Estado actual vs objetivo: la migración MVP implementada hoy usa `feature_flags.key`, `description`, `default_enabled` y overrides por tenant en `tenant_feature_flags`. Las estrategias `rollout_strategy`, `rollout_config`, `plan_features` y `expires_at` de trials quedan como objetivo F11/F2+ para convertir este documento en contrato completo de rollout comercial.

## 1. Conceptos

| Término | Significado |
|---|---|
| **Feature flag** | Bandera booleana o tipada que controla disponibilidad de una funcionalidad. |
| **Default** | Valor que toma el flag si el tenant no tiene override explícito. |
| **Override por tenant** | Valor específico para un tenant en `tenant_feature_flags`. |
| **Override por plan** | Valor implícito según el plan suscripto. |

## 2. Modelo de datos

Ver detalle en [`04-database.md`](./04-database.md). Resumen:

```sql
-- Definición global del flag
feature_flags (
  id, key, name, description,
  default_enabled boolean,
  rollout_strategy text, -- 'all' | 'per_plan' | 'per_tenant' | 'percentage'
  rollout_config jsonb,
  created_at, updated_at
)

-- Override por tenant
tenant_feature_flags (
  tenant_id, feature_flag_id, enabled,
  configured_by, configured_at,
  expires_at -- opcional, para trials
)
```

## 3. Orden de resolución

Para determinar si un flag está activo para un tenant:

```
1. ¿Existe registro en tenant_feature_flags y no está expirado?
   → Usa ese valor.
2. ¿La rollout_strategy es 'per_plan'?
   → Busca en plan_features (definido por plan).
3. ¿La rollout_strategy es 'percentage'?
   → hash(tenant_id) % 100 < porcentaje configurado.
4. Sino, usa feature_flags.default_enabled.
```

## 4. Catálogo inicial

Lista canónica vive en `lib/feature-flags/catalog.ts` y se siembra vía migración.

| Key | Default | Rollout | Descripción |
|---|---|---|---|
| `afip_enabled` | `false` | `per_tenant` | Habilita facturación electrónica AFIP. |
| `multi_branch` | `false` | `per_plan` | Permite múltiples sucursales (Business+). |
| `advanced_promotions` | `false` | `per_plan` | Motor de promociones (Pro+). |
| `restaurant_mode` | `false` | `per_tenant` | Activa flujos de mesas/comandas. |
| `mercadopago_integration` | `false` | `per_tenant` | Cobros con MP Point. |
| `whatsapp_notifications` | `false` | `per_plan` | Notificaciones por WhatsApp (Business+). |
| `customer_credit` | `false` | `per_plan` | Cuenta corriente de clientes (Pro+). |
| `customer_loyalty` | `false` | `per_plan` | Programa de fidelidad (Business+). |
| `api_access` | `false` | `per_plan` | API pública (Enterprise). |
| `pin_for_voids` | `true` | `all` | Pedir PIN de manager para anulaciones. |
| `auto_print_ticket` | `true` | `per_tenant` | Imprimir ticket automáticamente al cerrar venta. |
| `negative_stock_warning` | `true` | `all` | Avisar al vender producto sin stock. |
| `force_customer_on_sale` | `false` | `per_tenant` | Obligar a asignar cliente a cada venta. |
| `dark_mode_only` | `false` | `per_tenant` | Forzar modo oscuro (no dejar elegir light). |
| `simple_pos_mode` | `false` | `per_tenant` | Activa pantalla de catálogo chico/cobro por botones. |
| `appointments_enabled` | `false` | `per_plan` | Activa agenda, turnos y cobro desde servicios. |
| `service_commissions` | `false` | `per_plan` | Activa comisiones, propinas y reportes por profesional. |
| `sessions_memberships` | `false` | `per_plan` | Activa packs de sesiones, membresías y gift cards simples. |
| `gastronomy_mode` | `false` | `per_tenant` | Activa salones, mesas, comandas y modos gastronómicos. |
| `kitchen_display` | `false` | `per_plan` | Activa KDS/pantalla de cocina y barra. |
| `kitchen_routing` | `false` | `per_plan` | Activa ruteo de comandas por estación/impresora. |
| `delivery_takeaway` | `false` | `per_plan` | Activa flujo gastronómico de delivery/takeaway y despacho. |
| `recipes_bom` | `false` | `per_plan` | Activa recetas/escandallo y descuento de insumos. |

## 5. Estrategias de rollout

### 5.1 `all`
Todos los tenants reciben el flag con su `default_enabled`.

### 5.2 `per_plan`
El plan suscripto determina el valor. Tabla auxiliar `plan_features (plan_id, feature_flag_id, enabled)`.

### 5.3 `per_tenant`
Solo se activa con override explícito en `tenant_feature_flags`. Útil para Beta features y opt-in.

### 5.4 `percentage`
Rollout gradual. `rollout_config = { "percentage": 10 }` activa para ~10% de tenants determinísticamente.

```typescript
function isInPercentage(tenantId: string, percentage: number) {
  const hash = sha256(tenantId).slice(0, 8)
  const bucket = parseInt(hash, 16) % 100
  return bucket < percentage
}
```

## 6. Uso en código

### 6.1 Frontend (React)

```tsx
import { useFeatureFlag } from '@/lib/feature-flags/useFeatureFlag'

function POSFooter() {
  const showLoyalty = useFeatureFlag('customer_loyalty')
  return (
    <footer>
      {showLoyalty && <LoyaltyPointsBadge />}
    </footer>
  )
}
```

Variante con componente:

```tsx
<FeatureGate flag="restaurant_mode">
  <TableManagementPanel />
</FeatureGate>

<FeatureGate flag="restaurant_mode" fallback={<RegularPOS />}>
  <RestaurantPOS />
</FeatureGate>
```

### 6.2 Backend (Edge Functions)

```typescript
import { isFeatureEnabled } from '../_shared/feature-flags.ts'

const canUseAFIP = await isFeatureEnabled(tenant_id, 'afip_enabled')
if (!canUseAFIP) return badRequest('AFIP no habilitado para este tenant')
```

### 6.3 SQL (cuando es inevitable)

Función helper:

```sql
create or replace function feature_enabled(p_tenant_id uuid, p_key text)
returns boolean
language plpgsql stable
as $$
declare
  v_override boolean;
  v_default boolean;
begin
  -- 1. Override por tenant
  select tff.enabled into v_override
  from tenant_feature_flags tff
  join feature_flags ff on ff.id = tff.feature_flag_id
  where tff.tenant_id = p_tenant_id
    and ff.key = p_key
    and (tff.expires_at is null or tff.expires_at > now());
  
  if v_override is not null then
    return v_override;
  end if;
  
  -- 2. Default
  select default_enabled into v_default
  from feature_flags
  where key = p_key;
  
  return coalesce(v_default, false);
end;
$$;
```

## 7. Quién puede modificar flags

| Quién | Qué puede hacer |
|---|---|
| `super_admin` interno | Crear, modificar, borrar flags globales. |
| `developer` interno | Activar/desactivar por tenant para debugging (con motivo). |
| `support` interno | Activar features Beta solicitadas (con motivo). |
| `sales` interno | Activar features incluidas en el plan al hacer upgrade. |
| `owner` del tenant | Solo flags marcados como `user_configurable: true` (subset). |

Todo cambio se audita en `audit_logs` con before/after.

## 8. Vida de un flag

1. **Propuesta.** Se documenta en el PR que introduce la feature, con motivo y plan de rollout.
2. **Creación.** Migración SQL agrega el flag al catálogo.
3. **Implementación.** Código nuevo siempre detrás del flag (default `false` salvo casos triviales).
4. **Rollout.** Activación gradual (un tenant interno → 10% → 50% → 100%).
5. **Estabilización.** Si la feature funciona en 100% durante 30 días, se considera estable.
6. **Limpieza.** El flag se marca como `deprecated` y se programa su remoción. El código condicional se simplifica.

**Regla:** un flag no debe vivir indefinidamente. Tras 90 días al 100% sin issues, se elimina (o se mueve a configuración permanente).

## 9. Anti-patrones

❌ Flag con default `true` y nadie revisó qué pasa si está `false`. El flag tiene que poder apagarse.
❌ Lógica anidada profunda de flags: si necesitás `flag_a && flag_b && !flag_c`, refactorizá.
❌ Flag que controla seguridad. Los permisos van en la matriz de roles, no en flags.
❌ Activar un flag en producción sin haberlo probado en staging.
❌ Llamar a `useFeatureFlag` en un loop o condicional — siempre top-level, como cualquier hook.

## 10. Performance

- Los flags resueltos para un tenant se cachean en memoria del cliente Supabase server-side por la duración del request.
- En el frontend, se cachean con TanStack Query por 5 minutos.
- Invalidación inmediata vía Supabase Realtime cuando un admin cambia un flag (opcional, Fase 2+).

## 11. Tests

- Test unitario por flag verificando que la rama `enabled` y `disabled` se renderizan.
- Test de integración con dos tenants: uno con el flag, otro sin él. Verifica aislamiento.
