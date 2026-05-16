# Supabase

Carpeta con todo lo relacionado a la base de datos y las Edge Functions de NinjaSoft.

---

## Estructura

```
supabase/
├── migrations/         # Migraciones SQL versionadas (orden cronológico)
├── functions/          # Edge Functions (Deno + TypeScript)
├── policies/           # Referencia de políticas RLS (no aplicadas directo)
└── seed.sql.example    # Datos de ejemplo para dev
```

---

## Convenciones

### Migraciones

- Naming: `YYYYMMDDHHMMSS_verbo_descripcion.sql`.
- Ejemplo: `20260120143022_create_products_table.sql`.
- El timestamp garantiza orden y evita colisiones entre ramas.
- Si la rama A crea una migración con timestamp `T1` y la rama B con `T2 > T1`, pero A se mergea después, la rama A tiene que **renombrar** su migración con un nuevo timestamp posterior.
- **RLS se habilita en la misma migración que crea la tabla.** No después.
- Cuando es posible, las migraciones son idempotentes: `if not exists`, `create or replace`.
- Comentar en SQL qué hace y por qué (sobre todo cuando hay triggers o funciones).

### Edge Functions

- Una carpeta por función dentro de `functions/`.
- `index.ts` con el handler.
- Validación de entrada con Zod.
- Manejo de errores estructurado (ver `docs/09-api-conventions.md`).
- Toda función que opere sobre datos de tenant **valida explícitamente `tenant_id`** antes de ejecutar la operación.
- Logs estructurados (JSON) cuando corresponde a `audit_logs`.

### Policies de referencia

`policies/` es **documentación**, no se aplica automáticamente. Sirve para que un agente o dev pueda consultar el patrón estándar antes de escribir una política nueva en una migración.

---

## Acceso a la DB por entorno

Ver ADR-007 (`docs/17-decision-log.md`) para el detalle. Resumen:

| Entorno | Acceso libre | Service role | Cambios |
|---|---|---|---|
| Local | Sí, total | En `.env.local` | SQL libre + migraciones |
| Preview | No | Restringido | Migraciones aplicadas por CI |
| Staging | No | Restringido | Migraciones aplicadas por CI |
| Producción | No | Solo emergencia | PR + migración + review + deploy |

**`service_role` jamás en el frontend, en ningún entorno.**

---

## Workflow para crear una migración

```bash
# 1. Crear migración con timestamp automático
supabase migration new create_my_table

# 2. Editar el archivo generado en supabase/migrations/
#    - Crear tabla con tenant_id + RLS
#    - Definir políticas
#    - Agregar índices

# 3. Aplicar en local
supabase db reset
# o, si no querés perder datos locales:
supabase migration up

# 4. Probar en local

# 5. Commit + PR
git add supabase/migrations/*.sql
git commit -m "feat(db): agregar tabla my_table"
```

---

## Seed de datos para desarrollo

`seed.sql.example` tiene datos mínimos para arrancar a probar en local:

- 1 tenant de ejemplo.
- 1 usuario owner.
- Algunos productos, categorías, una caja, un cliente.

Para usarlo:

```bash
cp supabase/seed.sql.example supabase/seed.sql
# Editar si querés ajustar valores

# Aplicar
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" -f supabase/seed.sql
```

`seed.sql` está en `.gitignore` para que cada dev pueda tener el suyo.

---

## Edge Functions: lista MVP

Ver `docs/15-afip-integration.md` y `docs/03-architecture.md` para detalle. Las que se esperan para el MVP:

- `create_sale` — confirma una venta de forma atómica (sale + items + payments + stock_movements + audit_log).
- `close_cash_shift` — cierra un turno, genera arqueo.
- `apply_discount` — valida permisos según rol antes de aplicar descuento.
- `invite_user` — invita un usuario a un tenant, crea el registro en `tenant_users`.
- `change_plan` — cambia el plan de un tenant (solo staff NinjaSoft).
- `set_feature_flag` — activa/desactiva una flag para un tenant.

Cada una en su carpeta dentro de `functions/`.

---

## Reset total en local

Si querés empezar de cero en local:

```bash
supabase db reset
# Reaplica todas las migraciones desde cero
# Si tenés seed.sql, lo aplica al final
```

Esto **no afecta** preview, staging ni producción.
