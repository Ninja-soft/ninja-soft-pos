# Arquitectura — NinjaSoft POS

Documento de referencia técnica. Define el modelo de capas, decisiones de stack, contratos entre componentes y reglas de evolución.

## 1. Vista de alto nivel

```
                            ┌────────────────────────────┐
                            │   Vercel Edge Network      │
                            │   (CDN + SSR + Functions)  │
                            └─────────────┬──────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
       ┌──────▼──────┐            ┌───────▼────────┐          ┌──────▼──────┐
       │  POS App    │            │  Admin Panel   │          │   Landing   │
       │ (Next.js)   │            │   (Next.js)    │          │  (Next.js)  │
       │             │            │                │          │             │
       │ /pos/*      │            │ /admin/*       │          │   /        │
       │ /clientes/* │            │ /internal/*    │          │  /pricing  │
       └──────┬──────┘            └───────┬────────┘          └─────────────┘
              │                           │
              └─────────────┬─────────────┘
                            │
                  ┌─────────▼──────────┐
                  │   Supabase Cloud   │
                  │                    │
                  │  • PostgreSQL 15   │
                  │  • Auth (GoTrue)   │
                  │  • Storage (S3)    │
                  │  • Edge Functions  │
                  │  • Realtime        │
                  └─────────┬──────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
        ┌─────▼────┐  ┌─────▼────┐  ┌────▼─────┐
        │   AFIP   │  │ Mercado  │  │  Email   │
        │ (Fase 3) │  │   Pago   │  │ (Resend) │
        └──────────┘  └──────────┘  └──────────┘
```

## 2. Stack y justificaciones

| Capa | Tecnología | Por qué |
|---|---|---|
| Frontend framework | Next.js 14 (App Router) | SSR + edge runtime + buen DX, alineado con Vercel. |
| Lenguaje | TypeScript estricto | Tipado obligatorio en multi-tenant para evitar bugs de aislamiento. |
| Styling | Tailwind CSS 3 | Coincide con UI-Brand, sin CSS-in-JS runtime. |
| Componentes base | Radix UI primitives + cva | Accesibilidad asegurada, variantes tipadas. |
| Estado servidor | TanStack Query | Cache, invalidación, retries declarativos. |
| Estado cliente | Zustand | Liviano, sin boilerplate, perfecto para el carrito del POS. |
| Validación | Zod | Mismo schema en front y back. |
| Forms | React Hook Form + Zod resolver | Performance + tipado. |
| Backend | Supabase | Postgres + Auth + Storage + Edge Functions en un solo proveedor. |
| Base de datos | PostgreSQL 15 | Madurez, RLS, JSONB, extensiones. |
| Edge Functions | Deno (runtime de Supabase) | Lógica de negocio sensible fuera del frontend. |
| Hosting | Vercel | Previews por rama, edge, integración nativa con Next.js. |
| Testing | Vitest + Playwright | Unit + e2e con misma sintaxis. |
| Observabilidad | Sentry (Fase 4) + Supabase logs | Errores + métricas + audit_logs propio. |

## 3. Capas de la aplicación

### 3.1 Capa de presentación (`app/`, `components/`)

Rutas Next.js y componentes React puros. **No accede directamente a Supabase salvo para queries de lectura simples con RLS aplicada.** Toda mutación pasa por la capa de servicios o Edge Functions.

```
app/
├── (public)/              # Landing, pricing, legal
├── (auth)/                # Login, signup, recovery
├── (pos)/                 # POS principal
│   ├── pos/
│   ├── caja/
│   └── productos/
├── (admin)/               # Panel del cliente
│   ├── dashboard/
│   ├── productos/
│   ├── reportes/
│   ├── usuarios/
│   └── configuracion/
├── (internal)/            # Panel interno NinjaSoft
│   ├── tenants/
│   ├── planes/
│   └── feature-flags/
└── api/                   # Solo handlers que no caben en Edge Functions
```

### 3.2 Capa de dominio (`modules/`)

Lógica de negocio por dominio. Cada módulo expone hooks, schemas Zod, tipos TS y funciones puras.

```
modules/
├── pos/
│   ├── cart/              # useCart, applyDiscount, calculateTotal
│   ├── search/            # useProductSearch
│   └── shortcuts/         # useKeyboardShortcuts
├── products/
├── inventory/
├── cash-shifts/
├── customers/
├── reporting/
├── subscriptions/
└── tenants/
```

**Regla:** los módulos no se importan entre sí salvo a través de tipos. La composición ocurre en `app/`.

### 3.3 Capa de infraestructura (`lib/`)

Adapters y utilidades.

```
lib/
├── supabase/
│   ├── client.ts          # Cliente para Browser (anon key)
│   ├── server.ts          # Cliente para Server Components (anon key + cookies)
│   ├── admin.ts           # Cliente con service_role (SOLO Edge Functions)
│   └── types.ts           # Tipos generados con supabase gen types
├── permissions/
│   ├── roles.ts           # Definición de roles y permisos
│   ├── can.ts             # Helper can(user, action, resource)
│   └── PermissionGate.tsx
├── audit/
│   └── log.ts             # Helper para escribir en audit_logs
├── feature-flags/
│   └── useFeatureFlag.ts
└── utils/
```

### 3.4 Capa de backend (`supabase/`)

```
supabase/
├── migrations/            # SQL versionado, append-only
├── functions/             # Edge Functions (lógica sensible)
│   ├── create_sale/
│   ├── close_cash_shift/
│   ├── submit_invoice_afip/
│   └── ...
├── policies/              # Documentación de RLS (no SQL)
└── seed.sql               # Datos de desarrollo
```

## 4. Modelo multi-tenant

**Principio fundamental:** toda tabla operativa tiene `tenant_id NOT NULL` y RLS habilitada desde la primera migración.

### 4.1 Resolución de tenant

El `tenant_id` del usuario actual se determina así:

1. JWT de Supabase contiene `app_metadata.current_tenant_id`.
2. Función SQL `current_tenant_id()` lee el JWT y retorna el UUID.
3. Todas las policies de RLS usan `tenant_id = current_tenant_id()`.

```sql
create or replace function current_tenant_id()
returns uuid
language sql stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'current_tenant_id')::uuid,
    null
  );
$$;
```

### 4.2 Cambio de tenant

Un usuario puede pertenecer a varios tenants (tabla `tenant_users`). El cambio de tenant activo se hace via Edge Function que actualiza `app_metadata` y refresca el JWT. Ver [`08-multi-tenant.md`](./08-multi-tenant.md).

## 5. Flujo de una venta (ejemplo end-to-end)

```
1. [Browser]     Cashier escanea producto
2. [Browser]     Hook useProductSearch → SELECT con RLS
3. [Browser]     Producto agregado al carrito (Zustand, local)
4. [Browser]     Cashier presiona F12 (cobrar)
5. [Browser]     Modal de pago → método seleccionado
6. [Browser]     Llamada a Edge Function `create_sale` (POST)
7. [Edge Fn]     Validación Zod del payload
8. [Edge Fn]     Verificación de turno de caja abierto
9. [Edge Fn]     INSERT en `sales` + `sale_items` + `payments` (transacción)
10.[Edge Fn]     INSERT en `stock_movements` (descontar stock)
11.[Edge Fn]     INSERT en `audit_logs`
12.[Edge Fn]     Retorna { sale_id, sale_number, total }
13.[Browser]     Imprime ticket o muestra confirmación
14.[Browser]     Carrito se vacía, foco vuelve a búsqueda
```

**Observaciones:**
- La venta se materializa en una sola transacción SQL. No hay estados intermedios.
- El número correlativo se asigna dentro de la transacción usando un `SELECT ... FOR UPDATE` sobre la tabla `cash_registers`.
- Si la Edge Function falla, **nada queda escrito**.
- El ticket se imprime después de confirmar, no antes.

## 6. Reglas de evolución

### 6.1 Cambios de schema
- Toda modificación va por migración nueva (`YYYYMMDDHHMMSS_<verb>_<description>.sql`).
- No se editan migraciones existentes una vez aplicadas en staging.
- Cambios destructivos (DROP, ALTER que rompe tipos) requieren plan de rollback en el PR.

### 6.2 Cambios de API
- Edge Functions versionadas en path (`/functions/v1/create_sale`).
- Breaking changes implican nueva versión, no edición en sitio.
- Período de deprecación: 60 días mínimo antes de eliminar una versión.

### 6.3 Cambios de UI
- Componentes en `components/ui/` no se modifican sin actualizar `11-ui-brand.md`.
- Cambios visuales pasan por el agente `ui-designer` antes de mergear.

## 7. Anti-patrones prohibidos

❌ `service_role` en código que llega al navegador.
❌ Queries que no filtren por `tenant_id` (la RLS las bloquea, pero igual está prohibido).
❌ Lógica de negocio en componentes React (debe estar en `modules/`).
❌ Llamadas directas a la BD desde `app/` salvo lecturas simples.
❌ Migraciones que no incluyan RLS.
❌ Componentes que importen de otro módulo (`modules/pos` no puede importar de `modules/products`; usa tipos o lo eleva a `lib/`).
❌ Estado compartido entre tenants (cada query empieza desde cero).

## 8. Decisiones registradas

Las decisiones arquitectónicas importantes quedan en [`17-decision-log.md`](./17-decision-log.md). Consultar antes de proponer cambios estructurales.

## 9. Referencias cruzadas

- Esquema completo de BD: [`04-database.md`](./04-database.md)
- Seguridad y RLS: [`05-security.md`](./05-security.md)
- Multi-tenant en profundidad: [`08-multi-tenant.md`](./08-multi-tenant.md)
- Convenciones de API: [`09-api-conventions.md`](./09-api-conventions.md)
