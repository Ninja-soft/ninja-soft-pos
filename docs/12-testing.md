# Testing — NinjaSoft POS

Estrategia de tests, herramientas, qué se testea y qué no, y cuándo se bloquea un PR por falta de cobertura.

## 1. Pirámide

```
            ┌──────────────┐
            │     E2E      │   ← Playwright. Pocos, críticos. Flujos vendibles.
            └──────────────┘
        ┌──────────────────────┐
        │    Integration       │   ← Vitest + supabase local. RLS, Edge Functions.
        └──────────────────────┘
   ┌────────────────────────────────┐
   │            Unit                │   ← Vitest. Lógica pura, hooks, schemas.
   └────────────────────────────────┘
```

**Objetivo:** muchos unit, suficientes integration, pocos E2E pero esenciales.

## 2. Herramientas

| Tipo | Herramienta | Para qué |
|---|---|---|
| Unit | Vitest | Funciones puras, schemas Zod, helpers. |
| Componentes | Vitest + React Testing Library | Componentes React. |
| Integration | Vitest + Supabase local | Edge Functions, RLS, queries. |
| E2E | Playwright | Flujos completos en navegador real. |
| Visual regression | (Fase 4) Chromatic / Playwright snapshots | Cambios no intencionales en UI. |
| Load | (Fase 4) k6 | Performance bajo carga. |

## 3. Qué se testea (mandatory)

### 3.1 Schemas Zod
Cada schema tiene test que verifica:
- Caso válido pasa.
- 3-5 casos inválidos fallan con el mensaje esperado.

### 3.2 Lógica de negocio (módulos)
- Funciones puras: `calculateTotal`, `applyDiscount`, `validateStock`.
- Hooks con lógica no trivial: `useCart`, `useCashShift`.

### 3.3 Edge Functions
Cada función tiene tests que cubren:
- Happy path.
- Validación de auth (rechaza sin sesión).
- Validación de tenant (rechaza payload con tenant_id ajeno).
- Validación de permisos.
- Validación de schema (3-5 inputs inválidos).
- Idempotencia (si aplica).
- Audit log se escribió.

### 3.4 Multi-tenant (CRÍTICO)
Suite `tests/multi-tenant.test.ts` que verifica aislamiento entre tenants.
**Falla = bloquea merge sin excepción.**

### 3.5 Permisos
Por cada rol del sistema, verificar:
- Lo que puede hacer, lo hace.
- Lo que no puede hacer, falla con `forbidden`.

### 3.6 Flujos E2E críticos
Lista mínima:
1. Login → selección de tenant → POS.
2. Venta completa (búsqueda → carrito → cobrar → ticket).
3. Apertura y cierre de caja con arqueo.
4. Anulación de venta del día.
5. Alta de producto con stock inicial.
6. Cambio de plan desde panel interno.

## 4. Qué NO se testea (a propósito)

- Estilos visuales (salvo visual regression en Fase 4).
- Comportamiento de Supabase, Postgres, React (los probaron ellos).
- Configuración de Vercel, Next.js.
- Código generado (tipos auto-generados de Supabase).

## 5. Convenciones

### 5.1 Ubicación
- Tests unit/componentes: junto al archivo testeado (`Button.tsx` + `Button.test.tsx`).
- Tests de Edge Functions: dentro de la carpeta de la función.
- Tests E2E: `tests/e2e/`.
- Tests cross-cutting (multi-tenant, permisos): `tests/`.

### 5.2 Naming
- Archivos: `<archivo>.test.ts` o `<archivo>.test.tsx`.
- Describe blocks: nombran la unidad ("UserCard", "createSale Edge Function").
- It blocks: comportamiento esperado ("muestra el nombre del usuario", "rechaza payload sin tenant_id").

```typescript
describe('UserCard', () => {
  it('muestra el nombre y el email del usuario', () => { ... })
  it('llama a onEdit cuando se hace click en el botón editar', () => { ... })
  it('oculta el botón editar si no hay onEdit', () => { ... })
})
```

### 5.3 Estructura AAA

```typescript
it('aplica descuento del 10%', () => {
  // Arrange
  const cart = createCart([{ price: 100, qty: 2 }])
  
  // Act
  const result = applyDiscount(cart, 10)
  
  // Assert
  expect(result.total).toBe(180)
})
```

## 6. Mocks

- **Supabase:** mock parcial con `@supabase/supabase-js` y un helper en `tests/helpers/supabase.ts`.
- **Fechas:** `vi.useFakeTimers()` con `setSystemTime` para tests reproducibles.
- **APIs externas (AFIP, MP):** mock con MSW (Mock Service Worker).
- **No mockear el módulo testeado.** Si necesitás eso, está mal diseñado.

## 7. Setup de testing local

```bash
# 1. Levantar Supabase local
supabase start

# 2. Aplicar migraciones
supabase db reset

# 3. Sembrar datos de test
psql "$DATABASE_URL" -f tests/fixtures/seed.sql

# 4. Correr tests
pnpm test            # Vitest watch
pnpm test:run        # Vitest single run
pnpm test:e2e        # Playwright
pnpm test:coverage   # con cobertura
```

## 8. CI

GitHub Actions corre en cada PR:

```yaml
jobs:
  test:
    - pnpm install
    - pnpm lint
    - pnpm typecheck
    - supabase db start
    - supabase db reset
    - pnpm test:run
    - pnpm test:e2e
  
  coverage:
    - pnpm test:coverage
    - report a Codecov o similar
```

**Bloqueos automáticos:**
- Cualquier test falla → bloquea merge.
- Cobertura en `lib/` y `modules/` < 70% → warning, no bloqueo.
- Cobertura en Edge Functions < 80% → bloqueo.
- Tests de aislamiento multi-tenant fallan → bloqueo absoluto.

## 9. Tests E2E con Playwright

```typescript
// tests/e2e/sale-flow.spec.ts
import { test, expect } from '@playwright/test'
import { loginAs } from './helpers/auth'

test('cashier completa venta con descuento', async ({ page }) => {
  await loginAs(page, 'cashier@tenant-a.test')
  await page.goto('/pos')
  
  await page.fill('[data-testid="product-search"]', 'café latte')
  await page.click('[data-testid="product-result-0"]')
  
  await page.click('[data-testid="discount-button"]')
  await page.fill('[data-testid="discount-pct"]', '10')
  await page.click('[data-testid="discount-apply"]')
  
  await page.click('[data-testid="checkout-button"]')
  await page.click('[data-testid="payment-cash"]')
  await page.click('[data-testid="confirm-payment"]')
  
  await expect(page.locator('[data-testid="sale-success"]')).toBeVisible()
  await expect(page.locator('[data-testid="sale-number"]')).toContainText(/^\d+$/)
})
```

**Convenciones E2E:**
- Cada test corre en su propio tenant aislado (creado en `beforeEach`).
- Usar `data-testid` para selectores, no clases CSS.
- Tests deben poder correr en paralelo.
- Cleanup: tenant de test se elimina en `afterEach`.

## 10. Performance budget

A partir de Fase 2:
- Tests de performance corren semanalmente.
- Si LCP del POS sube > 200ms vs baseline → warning.
- Si Edge Function `create_sale` p95 sube > 100ms vs baseline → bloqueo.

## 11. Anti-patrones

❌ Tests que solo verifican que algo no crashea. Verificar comportamiento concreto.
❌ Tests que dependen de orden de ejecución.
❌ Tests con `sleep`/`wait` fijos. Usar `waitFor` con condición.
❌ Mocks tan complejos que el test ya no testea nada real.
❌ Skipear tests con `.skip` sin comentario que explique por qué y hasta cuándo.
❌ Tests que testean implementación (chequear que se llamó una función interna).

## 12. Bug reports → test regression

Cuando se reporta un bug:
1. Reproducirlo en un test que falle.
2. Arreglar el bug.
3. Verificar que el test ahora pasa.
4. Mergear ambos cambios juntos.

Esto garantiza que un bug arreglado no vuelve.
