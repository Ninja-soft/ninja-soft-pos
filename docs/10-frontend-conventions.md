# Convenciones de Frontend — NinjaSoft POS

Reglas para estructurar código React/Next.js. Lo que aquí está prohibido, está prohibido sin discusión en el PR.

## 1. Estructura de carpetas

```
app/
├── (public)/                # rutas sin auth: landing, pricing
├── (auth)/                  # login, signup, recovery
├── (pos)/                   # POS operativo
├── (admin)/                 # panel del cliente (dueño/manager)
├── (internal)/              # panel interno NinjaSoft
└── api/                     # raras veces; preferir Edge Functions

components/
├── ui/                      # primitives (Button, Input, Card, Dialog, ...)
├── layout/                  # Sidebar, Topbar, AppShell
├── pos/                     # específico del POS
├── admin/                   # específico del admin
└── shared/                  # cross-context (DataTable, EmptyState, ErrorBoundary)

modules/
├── <dominio>/
│   ├── schemas.ts           # Zod schemas
│   ├── types.ts             # tipos derivados
│   ├── api.ts               # llamadas a Supabase / Edge Functions
│   ├── hooks/               # custom hooks
│   ├── components/          # componentes específicos del dominio
│   └── index.ts             # public API del módulo

lib/
├── supabase/
├── permissions/
├── feature-flags/
├── audit/
├── utils/                   # helpers puros
└── theme/                   # tokens, dark/light
```

## 2. Componentes

### 2.1 Reglas
- Un componente por archivo. Nombre del archivo = nombre del componente (`UserCard.tsx`).
- Functional components con TypeScript. Sin class components.
- Props tipadas con interface, no type alias salvo unions.
- Default export prohibido salvo en `page.tsx` y `layout.tsx` de Next.js.

```tsx
// components/ui/UserCard.tsx
interface UserCardProps {
  user: User
  onEdit?: (user: User) => void
  variant?: 'default' | 'compact'
}

export function UserCard({ user, onEdit, variant = 'default' }: UserCardProps) {
  // ...
}
```

### 2.2 Tamaño máximo
- Un componente >300 líneas se refactoriza obligatoriamente.
- Si tiene >5 hooks de estado, considerar `useReducer` o un hook custom.

### 2.3 Server Components vs Client Components

| Caso | Server | Client |
|---|---|---|
| Fetch inicial de datos | ✅ | ❌ |
| Renderizado estático | ✅ | ❌ |
| Manejo de eventos (`onClick`) | ❌ | ✅ |
| Hooks (`useState`, `useEffect`, etc.) | ❌ | ✅ |
| Acceso a `localStorage` o `window` | ❌ | ✅ |

`'use client'` solo donde sea necesario. Por defecto, todo es server.

## 3. Estado

### 3.1 Estado del servidor: TanStack Query
- Toda data que viene de Supabase o Edge Functions se maneja con `useQuery` o `useMutation`.
- Key convention: `[<dominio>, <acción>, <filtros>]`. Ej: `['products', 'list', { storeId, search }]`.
- Stale time por defecto: 30 segundos. Override por caso.
- Invalidación: después de mutación, invalidar las keys afectadas.

### 3.2 Estado del cliente: Zustand
- Para estado que vive solo en el cliente (ej. carrito del POS, filtros de búsqueda en sesión).
- Un store por feature. No un mega-store global.
- Selectores tipados: `const total = useCartStore(state => state.total)`.

### 3.3 Estado local: useState / useReducer
- Para estado de un único componente o subárbol pequeño.
- Si el estado se pasa por props a más de 2 niveles, mover a Zustand.

### 3.4 URL como estado
- Filtros de listados van en query params, no en state.
- `?store_id=...&date_from=...` permite compartir links y volver atrás con el navegador.

## 4. Formularios

- React Hook Form + Zod resolver. Sin excepciones.
- Schemas en `modules/<dominio>/schemas.ts`, compartidos con Edge Functions.
- Errores inline debajo del input, con `aria-describedby`.
- Botón submit con estado disabled + spinner durante mutación.

```tsx
const ProductSchema = z.object({
  name: z.string().min(1, 'Requerido').max(120),
  price: z.number().nonnegative('Debe ser positivo'),
  category_id: z.string().uuid(),
})

type ProductFormData = z.infer<typeof ProductSchema>

function ProductForm() {
  const form = useForm<ProductFormData>({
    resolver: zodResolver(ProductSchema),
    defaultValues: { name: '', price: 0 },
  })
  
  const mutation = useMutation({ mutationFn: createProduct })
  
  return (
    <form onSubmit={form.handleSubmit(data => mutation.mutate(data))}>
      {/* ... */}
    </form>
  )
}
```

## 5. Llamadas a Supabase

### 5.1 Reads simples (lista, get por ID)
Directo desde componente o hook, con TanStack Query:

```tsx
function useProducts(filters: ProductFilters) {
  return useQuery({
    queryKey: ['products', 'list', filters],
    queryFn: () => productsApi.list(filters),
  })
}

// en modules/products/api.ts
export const productsApi = {
  list: async (filters: ProductFilters) => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('store_id', filters.storeId)
      .ilike('name', `%${filters.search}%`)
      .is('deleted_at', null)
      .order('name')
      .limit(100)
    if (error) throw error
    return data
  }
}
```

### 5.2 Mutaciones
**Siempre via Edge Functions.** No `supabase.from().insert()` desde el frontend para crear ventas, cerrar caja, ajustar stock.

```tsx
// modules/sales/api.ts
export const salesApi = {
  create: async (payload: CreateSaleInput) => {
    const { data, error } = await supabase.functions.invoke('create_sale', { body: payload })
    if (error) throw error
    return data
  }
}
```

## 6. Estilos

### 6.1 Tailwind first
- Usar utility classes para 90% del styling.
- Sin CSS modules salvo casos excepcionales (animaciones complejas, integraciones de terceros).

### 6.2 Variantes con cva
- Componentes con múltiples variantes usan `class-variance-authority`.

```tsx
const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-flame text-white hover:bg-flame/90',
        secondary: 'bg-midViolet text-white hover:bg-midViolet/80',
        ghost: 'hover:bg-shadow',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-lg',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
)
```

### 6.3 Colores
- **Siempre** referenciar tokens, no valores hex sueltos. `bg-flame` ✅, `bg-[#FF4B22]` ❌.
- Tokens definidos en `tailwind.config.ts` siguiendo `UI-Brand`.

### 6.4 Espaciado
- Sistema de 4px. Usar valores Tailwind (`p-2` = 8px, `p-4` = 16px).
- No usar valores arbitrarios salvo casos justificados.

## 7. Accesibilidad

- Todo input tiene `<label>` asociado.
- Botones tienen texto visible o `aria-label`.
- Imágenes informativas tienen `alt` descriptivo. Decorativas: `alt=""`.
- Estados focusables (`:focus-visible`) con ring claro.
- Color no es el único indicador de estado (errores tienen ícono + texto).
- Modales con `aria-modal`, trap focus, cierre con Esc.
- Tablas con `<th>` y `scope`.

## 8. Performance

- Imágenes con `next/image`.
- Listas largas con virtualización (`@tanstack/react-virtual` cuando >100 items).
- `React.memo` solo cuando se mide impacto, no por defecto.
- Code splitting por ruta (Next.js lo hace).
- Lazy loading para modales pesados (`React.lazy + Suspense`).

### 8.1 Métricas objetivo (POS)
- LCP < 1.5s en red 3G simulada.
- FID < 100ms.
- Tiempo entre "Cobrar" y confirmación < 500ms (sin contar AFIP).

## 8.2 Gate de estructura frontend

Toda PR que agregue o modifique UI debe pasar [`26-design-structure-control.md`](./26-design-structure-control.md).

Reglas adicionales:

- [ ] La ruta vive en el grupo correcto: `(auth)`, `(app)`, `(public)`, `internal`.
- [ ] La lógica de dominio vive en `modules/<dominio>`.
- [ ] Componentes de pantalla no acumulan lógica de API, permisos, formateo y layout a la vez.
- [ ] Formularios complejos se separan en schema, hook/mutation y componente visual.
- [ ] Tablas/listas reutilizan patrón común antes de crear markup propio.
- [ ] Si aparece un patrón repetido 2 veces, se promueve a componente compartido.
- [ ] Si una pantalla supera 300 líneas, se justifica o se divide.

## 9. Naming

| Cosa | Convención | Ejemplo |
|---|---|---|
| Componente | PascalCase | `ProductCard.tsx` |
| Hook | `use` + PascalCase | `useCart.ts` |
| Helper | camelCase | `formatCurrency.ts` |
| Constante | UPPER_SNAKE | `MAX_DISCOUNT_PCT` |
| Tipo / Interface | PascalCase | `Product`, `ProductFormData` |
| Schema Zod | PascalCase + `Schema` | `ProductSchema` |
| Carpeta | kebab-case | `cash-shifts/` |

## 10. Imports

Orden y separación:

```tsx
// 1. React / Next
import { useState } from 'react'
import { useRouter } from 'next/navigation'

// 2. Librerías externas
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

// 3. Imports absolutos del proyecto (@/)
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'

// 4. Imports relativos
import { ProductCard } from './ProductCard'
import type { Product } from './types'
```

ESLint enforce el orden vía `eslint-plugin-import`.

## 11. Errores y estados de carga

Todo componente que fetch debe manejar:
- **Loading:** Skeleton o spinner consistente con la marca.
- **Empty:** Mensaje claro + acción siguiente.
- **Error:** Mensaje útil + botón retry.

Componente `<DataState>` estándar:

```tsx
<DataState
  query={productsQuery}
  loading={<ProductGridSkeleton />}
  empty={<EmptyState title="Sin productos" cta={<NewProductButton />} />}
  error={(err, retry) => <ErrorState error={err} onRetry={retry} />}
>
  {data => <ProductGrid products={data} />}
</DataState>
```

## 12. Tests de componentes

- Vitest + React Testing Library.
- Un test por componente "no trivial" (más que renderizar texto).
- Test del happy path + casos borde (loading, error, empty).
- No testear implementación (no chequear que se llamó tal función) — testear comportamiento desde la perspectiva del usuario.

## 13. Anti-patrones

❌ `any` o `as any`. Usar `unknown` y narrow correctamente.
❌ `useEffect` para sincronizar estado (98% de las veces es código mal pensado).
❌ Mutar props.
❌ Side effects en render.
❌ Componente con >10 props. Considerar componer.
❌ Llamar a Edge Functions con fetch crudo en lugar de `supabase.functions.invoke`.
❌ Estilos inline (`style={{...}}`) salvo valores dinámicos calculados.
❌ Importar de `../../../../components`. Usar paths absolutos (`@/components`).
