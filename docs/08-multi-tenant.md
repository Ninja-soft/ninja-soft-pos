# Multi-Tenant — NinjaSoft POS

Documento técnico que define cómo se modela, asegura y opera el multi-tenant. Es la decisión arquitectónica más importante del producto y no se discute después de F0.

## 1. Modelo elegido: shared database, shared schema

| Opción | Descripción | Decisión |
|---|---|---|
| Database por tenant | Cada cliente tiene su propia BD. | ❌ Costo operativo prohibitivo. |
| Schema por tenant | Misma BD, schemas separados. | ❌ Migraciones se complican N veces. |
| **Shared DB + RLS** | **Una BD, todas las tablas con `tenant_id`, RLS aplica el aislamiento.** | ✅ Elegido. |

**Razones:**
- Una sola migración aplica a todos.
- Costo de infraestructura predecible (cobramos por uso real).
- Supabase y Postgres están diseñados para esto.
- Operación simple: un solo backup, una sola cadena de logs.

**Trade-off aceptado:** un bug en RLS puede exponer datos entre tenants. La política de seguridad (`05-security.md`) y los tests de aislamiento existen para mitigar este riesgo.

## 2. Identificación del tenant

### 2.1 Tenant actual

Cada usuario tiene un "tenant activo" en su JWT (`app_metadata.current_tenant_id`). Todas las queries usan `current_tenant_id()` (función SQL) para filtrar.

### 2.2 Relación usuario ↔ tenant

```
users (
  id, email, ...,
  is_internal boolean
)

tenant_users (
  user_id, tenant_id, role,
  invited_at, accepted_at,
  unique(user_id, tenant_id)
)
```

Un usuario puede pertenecer a 0, 1 o varios tenants. Un usuario sin tenants y sin `is_internal` no puede hacer nada útil — solo aceptar una invitación.

### 2.3 Selector de tenant

Si un usuario tiene > 1 tenant, al hacer login se le presenta un selector. La selección actualiza el JWT vía Edge Function `switch_tenant`:

```typescript
// Pseudocódigo
async function switchTenant(targetTenantId: string) {
  // 1. Validar membership
  const membership = await db
    .from('tenant_users')
    .select('*')
    .eq('user_id', user.id)
    .eq('tenant_id', targetTenantId)
    .single()
  
  if (!membership) return forbidden()
  
  // 2. Actualizar app_metadata vía admin API
  await adminClient.auth.admin.updateUserById(user.id, {
    app_metadata: { ...user.app_metadata, current_tenant_id: targetTenantId }
  })
  
  // 3. Forzar refresh del JWT en el cliente
  return { refresh_required: true }
}
```

## 3. La función `current_tenant_id()`

Toda policy de RLS la usa. Definición vigente: `20261106200000_seguridad_tenant_membresia_auditoria_inmutable` (ADR-083, H118).

```sql
create or replace function public.current_tenant_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  -- negocio del JWT (app_metadata.current_tenant_id, sólo lo escribe el servidor)
  -- que vale sólo con membresía activa o, para el staff, bajo internal_scope()
  ...
$$;
```

**Comportamiento:**
- Sin JWT (anónimo) o sin `current_tenant_id`: `null`. Las policies `tenant_id = current_tenant_id()` nunca matchean: bloqueo total.
- Con `current_tenant_id` en el JWT: lo devuelve **sólo si** el usuario tiene una fila en `tenant_users` de ese negocio con `status = 'active'`. Un miembro dado de baja o suspendido, o un JWT con un negocio que no es suyo, recibe `null` en el acto, sin esperar a que venza el token.
- Staff interno sin membresía: sólo dentro del panel interno (`internal_scope()`, ADR-052). En el panel del negocio necesita ser miembro como cualquiera.
- `user_metadata` (lo que el usuario puede editar de su perfil) no se lee nunca.
- **Rendimiento:** las policies la llaman como `(select current_tenant_id())` para que se evalúe una vez por consulta (initplan). Toda policy nueva debe usar ese patrón; `rls_bare_current_tenant_policies()` (service_role) lista las que no.
- `ensure_current_tenant()` corrige un negocio activo inválido por la primera membresía activa (lo usa `TenantClaimHealer` al entrar).

## 4. Estructura de tabla operativa

Plantilla obligatoria para toda tabla nueva:

```sql
create table <table_name> (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  
  -- columnas de dominio
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  deleted_at timestamptz
);

create index <table_name>_tenant_idx on <table_name>(tenant_id);
create index <table_name>_tenant_deleted_idx on <table_name>(tenant_id) where deleted_at is null;

create trigger set_updated_at_<table_name>
  before update on <table_name>
  for each row execute function set_updated_at();

alter table <table_name> enable row level security;

create policy <table_name>_tenant_isolation on <table_name>
  for all
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
```

## 5. Tablas globales (sin tenant_id)

Tablas que **no** son de un tenant específico:

| Tabla | Propósito | Policy |
|---|---|---|
| `tenants` | Catálogo de tenants. | Cada usuario ve solo los suyos vía `tenant_users`. |
| `users` | Catálogo de usuarios. | Cada usuario ve solo a sí mismo (salvo internal). |
| `plans` | Planes de suscripción. | Lectura pública. |
| `feature_flags` | Catálogo de flags. | Lectura pública (no expone valores por tenant). |
| `system_settings` | Configuración global. | Solo internal. |
| `audit_logs` | Auditoría. | Filtrada por tenant en la propia policy. |

## 6. Auditoría cross-tenant

`audit_logs` tiene `tenant_id` pero también permite registros con `tenant_id = null` para acciones del sistema (rotación de claves, jobs internos).

- **Lectura:** miembros del negocio (dueño y encargado todo; el resto lo propio, policy RESTRICTIVE de ADR-051) y staff en `internal_scope()`.
- **Insert desde el cliente:** sólo en su negocio validado por membresía, o registros sin negocio si no tiene ninguno. `created_at` lo pone el servidor.
- **Inmutable (ADR-083, H117):** sin UPDATE, DELETE ni TRUNCATE para `anon`, `authenticated` ni `service_role`, y un trigger que los rechaza para cualquier rol salvo el sellado de la cadena (`audit_chain_seal`) y la retención (`audit_retention_run`), funciones internas sin execute para clientes.
- **Hash encadenado por negocio:** `row_hash` al insertar; `chain_seq`, `prev_hash` y `hash` los completa el cron `audit-chain-seal` (cada 5 minutos). `audit_chain_verify(tenant)` la recorre (panel interno o service_role).
- **Retención:** 24 meses por defecto (`audit_retention_policy`), override por plan con `plans.limits.audit_retention_months` (mínimo 12). Cron diario `audit-retention`. Lo que coincide con `audit_fiscal_rules` (ventas, cobros, caja, ARCA, IVA, contabilidad, compras, cuenta corriente) **no se borra**. Lo borrado deja una lápida en `audit_log_tombstones`.

## 7. Edge Functions con service_role

Cuando una Edge Function necesita bypass de RLS (ej. crear el primer usuario de un tenant), usa el cliente con `service_role`:

```typescript
import { createClient } from '@supabase/supabase-js'

const adminClient = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)
```

**Regla absoluta:** después de usar `adminClient`, la función **siempre** valida explícitamente el `tenant_id` del payload contra el JWT del usuario. El service_role es para escribir, no para evitar el check de autorización.

## 8. Onboarding de un nuevo tenant

Flujo del lado servidor (`create_tenant` Edge Function, accesible solo a usuarios internos o vía signup público según plan):

```
1. Crear registro en tenants (status='trial', plan='start')
2. Crear suscripción inicial con trial_ends_at = now() + 14 days
3. Si signup público: crear el primer usuario (owner)
4. Insertar en tenant_users (role='owner')
5. Actualizar app_metadata.current_tenant_id del usuario
6. Sembrar datos mínimos:
   - Sucursal por defecto
   - Caja por defecto
   - Categoría "Sin categoría"
7. Auditar la creación
```

## 9. Eliminación de un tenant

Política: **baja lógica, no física, salvo solicitud explícita.**

- `tenants.deleted_at` se marca.
- Todas las queries de cliente filtran `deleted_at is null`.
- Backup completo del tenant se guarda 90 días.
- Tras 90 días, eliminación física en cascada.

Solicitud de eliminación inmediata (GDPR-like): solo `super_admin` interno, con motivo y registro.

## 10. Tests de aislamiento (obligatorios)

El agente `qa-engineer` mantiene en `tests/multi-tenant.test.ts` un suite que:

1. Crea dos tenants A y B.
2. Crea data en cada uno (productos, ventas, etc.).
3. Loguea como usuario de A y verifica que **nunca** ve datos de B en ninguna query.
4. Intenta INSERT con `tenant_id` de B desde sesión de A — debe fallar.
5. Intenta SELECT directo con UUID conocido de B — debe retornar vacío.
6. Verifica que `audit_logs` filtra correctamente.

Este suite se ejecuta en CI **en cada PR** y bloquea merge si falla.

## 11. Pitfalls comunes

### 11.1 Joins sin filtro de tenant
```sql
-- MAL (RLS lo protege, pero es frágil)
select s.*, p.name 
from sales s join products p on p.id = s.product_id;

-- BIEN (explicito)
select s.*, p.name 
from sales s 
join products p on p.id = s.product_id 
where s.tenant_id = current_tenant_id() 
  and p.tenant_id = current_tenant_id();
```

La RLS lo cubre, pero ser explícito ayuda a:
- Performance (Postgres puede usar índices mejor).
- Lectura del código.
- Detección temprana de bugs si por error se desactiva una policy.

### 11.2 Funciones SECURITY DEFINER
Si una función SQL se marca `SECURITY DEFINER`, **ignora RLS**. Solo usar para casos muy específicos (ej. `switch_tenant`) y nunca para queries normales.

### 11.3 Realtime
Las subscripciones Realtime respetan RLS automáticamente, pero es importante suscribirse con `eq('tenant_id', currentTenantId)` explícito para evitar enviar datos al cliente solo para que RLS los filtre.

## 12. Roadmap multi-tenant

| Fase | Mejora |
|---|---|
| F0 | RLS básica + tests de aislamiento. |
| F1 | Multi-tenant funcional, switch de tenant. |
| F2 | Impersonation con auditoría. |
| F3 | Particionamiento de tablas grandes por `tenant_id` (cuando `sales` supere 50M filas). |
| F4 | Read replicas para tenants Enterprise. |
| F5 | Aislamiento de cómputo Edge Functions por tenant (rate limiting). |
