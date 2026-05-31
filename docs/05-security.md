# Seguridad — NinjaSoft POS

Política de seguridad operativa. Aplica a código, infraestructura, datos y procesos. Toda violación bloquea merge.

## 1. Principios

1. **Defensa en profundidad.** No confiar en una sola capa. RLS + validación en Edge Functions + validación en frontend.
2. **Mínimo privilegio.** Cada rol, clave y conexión tiene el alcance estrictamente necesario.
3. **Aislamiento multi-tenant absoluto.** Un tenant no puede leer ni escribir datos de otro bajo ninguna condición.
4. **Auditoría obligatoria.** Toda acción sensible deja registro inmutable en `audit_logs`.
5. **Secretos fuera del código.** Cero credenciales en Git. Cero excepciones.

## 2. Gestión de secretos

### 2.1 Variables de entorno

| Variable | Sensibilidad | Dónde vive |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Baja (pública) | `.env.local`, Vercel env, repo (`.env.example` con placeholder) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Baja (pública, RLS la protege) | Igual |
| `SUPABASE_SERVICE_ROLE_KEY` | **Crítica** | **Solo** Vercel server-side env + Supabase Edge Functions. **Nunca** en `.env.local` salvo desarrollo aislado. |
| `AFIP_CERT_PRIVATE_KEY` | **Crítica** | Supabase Vault o secret manager. Cifrada en reposo. |
| `RESEND_API_KEY`, `MP_ACCESS_TOKEN`, etc. | Alta | Solo Edge Functions. |

### 2.2 Reglas
- ❌ Cualquier secreto con prefijo distinto a `NEXT_PUBLIC_` **NO** puede aparecer en código que se envíe al browser.
- ❌ No usar `service_role` en componentes React, ni siquiera en Server Components.
- ✅ Para operaciones que requieran bypass de RLS, usar siempre Edge Functions.
- ✅ Rotación de claves cada 90 días en producción.
- ✅ Si una clave se filtra accidentalmente: rotar **inmediatamente**, no después de evaluar.

### 2.3 Detección
- Pre-commit hook con `gitleaks` para detectar claves.
- CI corre `gitleaks` y bloquea PR si encuentra patrones sospechosos.

## 3. Autenticación

- Provider: Supabase Auth (GoTrue).
- Métodos habilitados en MVP: email + password con verificación.
- Métodos futuros: Google OAuth, Magic Link.
- Política de contraseñas:
  - Mínimo 10 caracteres.
  - Al menos 1 mayúscula, 1 minúscula, 1 número.
  - No coincidir con email.
- Bloqueo tras 5 intentos fallidos en 15 minutos.
- Sesión JWT con duración de 1 hora, refresh token 30 días.
- Logout invalida refresh token.

## 4. Autorización (RLS + permisos)

### 4.1 Capa 1: Row Level Security (Postgres)

Toda tabla operativa tiene RLS habilitada. La policy estándar:

```sql
alter table products enable row level security;

create policy products_tenant_isolation on products
  for all
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
```

**Tablas que NO tienen RLS por tenant (son globales):**
- `tenants` (cada usuario solo ve los suyos vía `tenant_users`).
- `plans` (lectura pública).
- `feature_flags` (lectura pública, escritura solo internal).
- `system_settings` (acceso solo internal).

Estas tablas usan policies basadas en `is_internal` o membership.

### 4.2 Capa 2: Permisos por rol (aplicación)

Definidos en `lib/permissions/roles.ts`. Ver [`06-permissions-roles.md`](./06-permissions-roles.md).

```typescript
// Ejemplo conceptual
can(user, 'sales:void')      // ¿puede anular ventas?
can(user, 'products:delete') // ¿puede borrar productos?
```

La RLS protege a nivel fila. Los permisos protegen acciones específicas (botón de anulación oculto si no tiene permiso).

### 4.3 Capa 3: Validación en Edge Functions

Toda Edge Function valida:
1. Que el usuario esté autenticado.
2. Que el `tenant_id` del payload coincida con el del JWT.
3. Que el usuario tenga el permiso requerido para la acción.
4. Schema Zod del payload.

```typescript
// Patrón estándar
const { user } = await getUser(req)
if (!user) return unauthorized()

const body = SaleSchema.parse(await req.json())

if (body.tenant_id !== user.app_metadata.current_tenant_id) {
  return forbidden('tenant mismatch')
}

if (!can(user, 'sales:create')) {
  return forbidden('insufficient permissions')
}
```

## 5. Validación de input

- **Todo input externo se valida con Zod.** Sin excepciones.
- Schemas viven en `modules/<dominio>/schemas.ts` y se usan tanto en front como en back.
- Validar tipos, rangos, longitudes y formatos (UUID, email, ISO date).
- Sanitizar HTML solo si se permite renderizado (por ahora, no se permite).

## 6. Protección contra ataques comunes

| Vector | Mitigación |
|---|---|
| SQL injection | Parametrización vía Supabase client + queries tipadas. No concatenar SQL. |
| XSS | React escapa por defecto. No usar `dangerouslySetInnerHTML`. |
| CSRF | Tokens Supabase en headers, no en cookies de envío automático. Same-site cookies. |
| Tenant leak | RLS + validación en Edge Functions. Tests dedicados. |
| Privilege escalation | Roles inmutables vía API; cambios solo desde panel admin con auditoría. |
| Brute force login | Rate limit de Supabase Auth + bloqueo por intentos. |
| Replay attacks | JWT con expiración corta + refresh token rotatorio. |
| Mass assignment | Schemas Zod con `.strict()` para rechazar campos no esperados. |

## 7. Almacenamiento de datos sensibles

| Tipo de dato | Tratamiento |
|---|---|
| Contraseñas | Bcrypt vía Supabase Auth (no las manejamos directamente). |
| Tokens AFIP | Cifrados con `pgcrypto` antes de guardar. Clave maestra en Vault. |
| CUIT de clientes | Plano (no es secreto, pero requiere consentimiento de uso). |
| Datos de tarjeta | **Nunca se almacenan.** Tokenización vía pasarela. |
| Tickets/Comprobantes | Plano en Storage, acceso controlado por RLS de paths. |

## 8. Auditoría

Ver tabla `audit_logs` en [`04-database.md`](./04-database.md).

### 8.1 Eventos auditados obligatoriamente
- Login y logout.
- Cambio de contraseña.
- Cambio de plan o estado de suscripción.
- Alta, modificación, baja de usuarios.
- Cambio de rol o permisos.
- Activación/desactivación de feature flags.
- Apertura y cierre de caja.
- Anulación de ventas.
- Cambio de precio (no incremental por ajustes de inflación masivos, sí cambios manuales).
- Movimientos manuales de stock.
- Acciones del panel interno NinjaSoft.
- Acceso a datos de un tenant desde el panel interno (con motivo registrado).

### 8.2 Inmutabilidad
- `audit_logs` no tiene `UPDATE` ni `DELETE` autorizados a nadie.
- Solo `INSERT` desde triggers y Edge Functions.
- Backup diario externo (Fase 3+).

## 9. Backups

| Tipo | Frecuencia | Retención | Quién |
|---|---|---|---|
| Snapshot completo PostgreSQL | Diario | 30 días | Supabase nativo |
| Snapshot semanal externo | Semanal | 12 semanas | Supabase + S3 propio (Fase 3) |
| Export de `audit_logs` | Diario | 7 años | S3 propio cifrado |
| Storage (tickets, certificados) | Replicado | Indefinido | Supabase Storage |

Test de restore obligatorio cada 90 días.

## 10. Acceso de NinjaSoft a datos de tenants

**Política:** el staff de NinjaSoft puede acceder a datos de un tenant **solo** desde el panel interno y **siempre** con motivo registrado.

```typescript
// Patrón: "impersonation" controlada
await openTenantContext(tenantId, {
  reason: 'Soporte: cliente reporta error al cobrar',
  ticket_id: 'TICK-1234'
})
// → escribe en audit_logs antes de ejecutar la consulta
```

El cliente puede ver en su panel un log de accesos de NinjaSoft a sus datos (Fase 2+).

## 11. Reporte de vulnerabilidades

- Canal: `security@ninjasoft.com.ar`.
- Respuesta en 48hs hábiles.
- Programa de disclosure responsable (sin recompensas monetarias en MVP, pero sí reconocimiento público con consentimiento).

## 12. Checklist de seguridad para PRs

El agente `security-auditor` debe verificar antes de aprobar cualquier PR con cambios sensibles:

- [ ] ¿Hay nuevos endpoints/Edge Functions? Tienen validación de auth, tenant y Zod.
- [ ] ¿Hay nuevas tablas? Tienen RLS habilitada con policy correcta.
- [ ] ¿Se introducen nuevas variables de entorno? Las sensibles no son `NEXT_PUBLIC_`.
- [ ] ¿Hay nuevos secretos? Documentados en `.env.example` con placeholder, no valor real.
- [ ] ¿Se modifican policies de RLS? Hay test que verifica aislamiento entre tenants.
- [ ] ¿Hay nuevas acciones que ameriten auditoría? Se escriben en `audit_logs`.
- [ ] ¿Se introducen permisos nuevos? Documentados en `06-permissions-roles.md`.

## 13. Incidentes

En caso de incidente confirmado:
1. **Contener:** rotar claves comprometidas, deshabilitar accesos sospechosos.
2. **Evaluar:** revisar logs, determinar alcance.
3. **Notificar:** clientes afectados en 72hs si hay exposición de datos.
4. **Documentar:** post-mortem en [`docs/security-reviews/`](./security-reviews/README.md) con timeline, causa, remediación.
5. **Prevenir:** acción concreta para que no vuelva a ocurrir.
