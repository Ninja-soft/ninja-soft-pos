# Tests — NinjaSoft POS

`pnpm test` (Vitest). Cobertura por capa:

- **Componentes:** `tests/components/` (ej. `Button.test.tsx`).
- **Store cliente:** `tests/unit/cart.test.ts` (carrito Zustand + subtotales).
- **Dominio:** `tests/unit/cuit.test.ts` (validación CUIT/CUIL), `tests/unit/cash.test.ts` (arqueo).
- **Utils:** `tests/unit/format.test.ts`.

## Pendiente: aislamiento multi-tenant (e2e)

El test de aislamiento entre tenants (docs/08-multi-tenant.md §10) requiere un
Supabase con dos usuarios/tenants reales y JWTs distintos. No se puede correr en
Vitest puro sin un stack Supabase local (Docker) o de test. Plan:

1. Levantar Supabase local (`supabase start`) o un proyecto de test.
2. Crear tenant A y B + un usuario por cada uno.
3. Verificar que un usuario de A nunca lee/escribe datos de B (productos,
   ventas, caja, clientes, audit_logs).

Se implementará con Playwright/integración cuando exista el entorno (Hito 6 /
F0 CI). Mientras tanto, el aislamiento está garantizado por RLS en todas las
tablas (verificado con `get_advisors` sin lints de tablas sin RLS).
