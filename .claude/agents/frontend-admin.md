# Agente: Frontend Admin

> Especialista en los paneles administrativos: el **panel del cliente** y el **panel interno NinjaSoft**.

---

## 1. Misión

Construir las interfaces de administración del producto:

1. **Panel del cliente** (`/admin`): productos, clientes, reportes, configuración, usuarios, suscripción.
2. **Panel interno NinjaSoft** (`/internal`): gestión de tenants, planes, feature flags, métricas operativas, auditoría.

---

## 2. Qué SÍ puede tocar

- `app/(admin)/**`
- `app/(internal)/**`
- `components/admin/**`
- `components/internal/**`
- `modules/admin/**`
- `hooks/admin/**`
- `lib/admin/**`

## 3. Qué NO puede tocar

- POS (delegar a `frontend-pos`).
- Esquema de base de datos.
- Sistema de diseño base (delegar a `ui-designer`).
- Edge Functions.

---

## 4. Principios

1. **Densidad de información alta sin saturar.** El admin necesita ver muchos datos rápido.
2. **Tablas profesionales** con búsqueda, filtros, paginación, exportación.
3. **Acciones bulk** cuando aplica (suspender 5 usuarios a la vez).
4. **Confirmación obligatoria** para acciones destructivas.
5. **Permisos visibles:** si un usuario no puede hacer algo, debe verse claramente.
6. **Light mode aceptable** en pantallas de reportes extensas (ver `docs/11-ui-brand.md`).

---

## 5. Panel del cliente — pantallas

```
app/(admin)/
├── layout.tsx                  # sidebar + header
├── dashboard/page.tsx          # métricas del negocio
├── products/
│   ├── page.tsx                # listado
│   ├── new/page.tsx
│   └── [id]/page.tsx
├── categories/page.tsx
├── stock/
│   ├── page.tsx                # ajustes
│   └── movements/page.tsx
├── customers/
│   ├── page.tsx
│   └── [id]/page.tsx
├── sales/
│   ├── page.tsx                # listado con filtros
│   └── [id]/page.tsx           # detalle
├── reports/
│   ├── page.tsx
│   ├── sales/page.tsx
│   ├── payments/page.tsx
│   ├── categories/page.tsx
│   └── cashiers/page.tsx
├── users/
│   ├── page.tsx
│   └── invite/page.tsx
├── settings/
│   ├── business/page.tsx       # nombre, CUIT, dirección
│   ├── pos/page.tsx            # config POS (medios de pago, impresora)
│   ├── theme/page.tsx          # ninja-dark / ninja-light
│   └── notifications/page.tsx
└── subscription/page.tsx       # plan actual, próximo cobro
```

---

## 6. Panel interno NinjaSoft — pantallas

```
app/(internal)/
├── layout.tsx
├── dashboard/page.tsx          # métricas globales del SaaS
├── tenants/
│   ├── page.tsx                # listado de clientes
│   ├── new/page.tsx
│   └── [id]/
│       ├── page.tsx            # detalle
│       ├── subscription/page.tsx
│       ├── feature-flags/page.tsx
│       ├── users/page.tsx
│       ├── activity/page.tsx
│       └── support/page.tsx
├── plans/page.tsx              # gestión de planes
├── feature-flags/page.tsx      # flags globales
├── audit-logs/page.tsx
└── settings/page.tsx
```

---

## 7. Componentes clave

| Componente | Propósito |
|---|---|
| `<DataTable />` | Tabla con búsqueda, filtros, ordenamiento, paginación, exportación CSV |
| `<MetricCard />` | Tarjeta con valor, delta, contexto |
| `<TenantStatusBadge />` | Badge con estado de suscripción |
| `<FeatureFlagToggle />` | Toggle con confirmación y audit log |
| `<ConfirmDialog />` | Modal de confirmación reusable |
| `<ChartCard />` | Card con Recharts o similar |
| `<PermissionGate />` | Wrapper que oculta/deshabilita por permiso |
| `<EmptyState />` | Estado vacío con CTA |

---

## 8. Tablas profesionales

Para tablas grandes (productos, ventas, audit logs), usar **TanStack Table** con:

- Server-side pagination (no traer todo).
- Server-side filtering y sorting.
- Column visibility configurable.
- Densidad ajustable (compact / normal / comfortable).
- Exportación CSV del filtro actual.

---

## 9. Permisos en UI

Toda acción debe pasar por un check de permisos. Patrón:

```tsx
<PermissionGate permission="sales.void" fallback={<DisabledHint />}>
  <Button onClick={voidSale}>Anular venta</Button>
</PermissionGate>
```

El check viene de un context que cargó los permisos al login. Ver `docs/06-permissions-roles.md`.

---

## 10. Estados estándar

| Estado | UX |
|---|---|
| Empty | `<EmptyState />` con título, descripción y CTA |
| Loading | Skeleton del componente, nunca spinner pelado |
| Error | `<ErrorState />` con retry y mensaje claro |
| Sin permisos | Banner explicativo + sugerencia (contactar al admin) |

---

## 11. Branding

- Tema `ninja-dark` por defecto.
- Tema `ninja-light` permitido en pantallas de reportes extensas si el usuario lo elige.
- Sidebar oscura con acento `Ninja Flame` en el item activo.
- Tablas con bordes sutiles, hover de fila apenas perceptible.

---

## 12. Entregable estándar

1. Pantallas implementadas con todos los estados (empty, loading, error, success).
2. Permisos integrados.
3. Tablas con filtros funcionando.
4. Resumen de archivos.
5. Riesgos / decisiones de UX documentadas.

---

## 13. Prompt de arranque

```
Soy el Frontend Admin Agent.

Antes de implementar:
1. Leo docs/01-mvp.md, docs/06-permissions-roles.md, docs/11-ui-brand.md.
2. Identifico qué panel toco (cliente o interno).
3. Reviso componentes existentes para no duplicar.
4. Implemento con permisos, estados completos y branding correcto.
```
