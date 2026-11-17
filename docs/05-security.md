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

**Membresía del negocio de la sesión (SEC-27).** Las Edges que corren con `service_role` y toman el negocio de `app_metadata.current_tenant_id` no confían en el claim: validan que el usuario sea miembro activo de ese negocio (`tenant_users.status = 'active'`) y que su cuenta no esté baneada en Auth (`banned_until` futuro en el `User` de `getUser`) ni suspendida (`users.suspended_at`). Para eso está `requireTenantMember` (`supabase/functions/_shared/tenantAuth.ts`): devuelve `{ user, tenantId, role, admin, userClient }` o la `Response` lista (401 `unauthorized`, 400 `no_tenant`, 403 `forbidden`, con el `json`/CORS de la Edge vía `respond`). Opción `roles` (p. ej. sólo dueño y encargado). No tiene bypass de staff: un acceso de staff a otro negocio se diseña aparte, con `internal_scope()` y el MFA de SEC-23. Si la Edge valida el body antes que la membresía, se usa en dos pasos (`authenticateTenantUser` y después `requireTenantMember(session)`) para no cambiar el orden de los errores. Las alternativas aceptadas son un RPC guard (`*_edge_guard`, `*_access_check`, `_mp_refund_claim`, `is_tenant_manager`) o la consulta a `tenant_users`; `tests/unit/edgeMembership.test.ts` lo vigila, con allowlist motivada (`geo_guard`, `routing_guard`, `arca_padron_guard`, `internal_create_tenant`); el test analiza el AST de TypeScript, así que strings y comentarios no cuentan como guard.

Deuda para SEC-27b:
- `mp_create_qr` lanza la lectura de la credencial de Mercado Pago (con refresh OAuth) y del plan en el mismo `Promise.all` que la membresía (latencia, ADR-048): un no-miembro recibe 403 igual, pero esas lecturas con service_role ya corrieron. Se deja así a propósito; revisar si conviene validar antes sin perder la ronda única.
- `catalog_purchase_checkout` toma el negocio del body (`b.tenant_id ?? meta.current_tenant_id`) en la rama de staff y opera con service_role: verificar que su guard (staff con MFA, o dueño activo) cubra todos los caminos.
- Detección automática de Edges que usan service_role con un `tenant_id` del body (hoy el test sólo mira el claim `current_tenant_id`).

### 4.4 Firma de los webhooks de Mercado Pago (SEC-60)

Los webhooks públicos de cobros de Mercado Pago no confían en el cuerpo: `mp_webhook` y `mp_orders_webhook` vuelven a leer el pago / la order en MP con el token del negocio y exigen `external_reference` = intent y monto exacto. Desde SEC-60 (ADR-189) además verifican `x-signature` (`_shared/mpWebhookSignature.ts` sobre `verifyMpSignature`, el mismo HMAC de `mp_billing_webhook`) según un modo global:

| `system_settings.mp_webhook_signature_mode` | Firma válida | Firma inválida / sin `ts` / sin header / vencida (> 10 min) | Sin secreto para ese aviso |
|---|---|---|---|
| `off` | procesa | procesa (no se mira) | procesa |
| `report` (inicial; también sin fila, valor desconocido o lectura fallida) | procesa | procesa + nota `signature_*` en `webhook_events.error` | procesa + `signature_missing_secret` |
| `enforce` | procesa | **401** `invalid_signature`, sin leer MP ni escribir | procesa + `signature_missing_secret` |

- **Secreto:** la clave secreta de webhooks de la app de NinjaSoft (`platform_secrets.mercadopago.webhook_secret`, la de `mp_billing_webhook`). Se usa cuando la credencial del cobro es OAuth (app de plataforma) y para los avisos de contracargos / reclamos de la app. Un negocio con Access Token manual usa su propia app y no guardamos su secreto: nunca se le corta.
- La nota (`wh.note`) no cambia el estado de la fila (`ok` / `ignored` / `error`) ni guarda datos sensibles. El modo y el secreto se cachean 60 s en el isolate; una excepción de la verificación sigue de largo (`signature_check_failed`).
- La firma se verifica después de leer el intent y la credencial (para saber si es OAuth) y antes de leer MP o escribir el estado. La única escritura posible antes es el refresh OAuth del token del negocio cuando está por vencer (no depende del contenido del aviso).
- Pasar a `enforce` es una decisión humana después de revisar `webhook_events` (ver ADR-189).

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

## 14. Superficie anónima (SEC-13)

Las únicas funciones SECURITY DEFINER que `anon` puede ejecutar son las de `supabase/security/anon-allowlist.json` (19). `tests/unit/anonAllowlist.test.ts` exige que coincidan con `grants.expected.json`, y la paridad estricta de CI exige que la base coincida con el esperado: una función nueva expuesta a anon sin pasar por la allowlist rompe CI. Relevamiento del 2026-11-17 leyendo cada cuerpo en producción.

**API pública (`_api_auth(token, scope)`)**: token `nsat_(test_)?` + 64 hex (`gen_random_bytes(32)`, 256 bits, 1 h de vida), buscado por `sha256` (equivalente a tiempo constante), cliente y token no revocados ni vencidos, rate limit por cliente (ventana deslizante, 600/min por defecto) **después** de resolver el token, negocio no suspendido ni dado de baja, feature `api_publica` y scope.

| Función | Qué valida | Token / comparación | Qué devuelve | Rate limit | Huecos (tarjeta) |
|---|---|---|---|---|---|
| `ai_public_config()` | nada | — | campos de `platform_secrets.ai_config` en lista blanca (imagen, proveedor, texto, precio del complemento) | no | — |
| `api_token_issue` | client_id, secret (`sha256`), estado del negocio, feature, scope | secret 256 bits; hash | access token, scope, entorno; audita | por cliente (cuenta secretos malos) | client_id conocido vs desconocido distinguible por el 429 (SEC-57) |
| `api_v1_customers_list` | `_api_auth` `customers:read` | hash | **PII completa** (nombre, email, teléfono, documento, dirección) | por cliente | credencial de sandbox lee datos reales (SEC-56) |
| `api_v1_customers_upsert` / `prices_update` / `products_upsert` / `stock_adjust` | `_api_auth` + scope de escritura; sandbox revierte | hash | resultado de la escritura | por cliente | eco de hasta 200 caracteres del error SQL (SEC-57) |
| `api_v1_products_list` | `products:read` | hash | productos con **costo**, precio, stock | por cliente | sandbox lee datos reales (SEC-56) |
| `api_v1_sales_list` | `sales:read`, rango ≤ 93 días | hash | ventas, ítems, pagos con `reference` libre | por cliente | sandbox lee datos reales (SEC-56) |
| `api_v1_stock_list` / `stores_list` | `stock:read`, sucursal del negocio | hash | stock / sucursales | por cliente | — |
| `current_tenant_id()` | claim + membresía activa | — | `null` para anon | — | — |
| `public_catalog(slug)` | negocio activo o en prueba, feature `catalogo_publico` | slug público | marca, teléfono y dirección del negocio, productos con precio (sin costo, sin insumos) | no (SEC-34) | — |
| `public_catalog_order_create` | honeypot, negocio y features, token del cliente ≥ 32 chars, validación de datos | token generado por el cliente (256 bits en el real), se guarda `sha256` | número de pedido, total, código de retiro; reserva stock y **manda email** a la dirección cargada | 5 por IP y negocio cada 10 min, 60 por negocio por hora | IP falsificable por `x-forwarded-for` (SEC-51); relay de emails (SEC-52) |
| `public_catalog_order_status(token)` | token, `sha256`, origen catálogo | hash | estado, líneas, **nombre y dirección del cliente**, seguimiento | no (SEC-34) | sin chequeo de estado del negocio (SEC-54) |
| `public_plans()` | nada | — | planes activos con precio y límites | no | — |
| `public_product_sheet(slug, product)` | negocio activo, feature `etiquetas_pro`, producto del negocio | uuid del producto | ficha con precio, medios y cuotas | no (SEC-34) | no excluye insumos ni exige `catalogo_publico` (SEC-57) |
| `quote_public_get(token)` | token 32–80 chars | **texto plano**, igualdad | cliente con **documento y dirección**, ítems, totales, datos del emisor | no (SEC-34) | token sin hash (SEC-53); sin estado del negocio ni vencimiento del link (SEC-54) |
| `quote_public_respond` | mismo token, `FOR UPDATE`, borrador o enviado, no vencido | texto plano | `{status}`; audita | no (SEC-34) | acepta borradores (SEC-55); token sin hash (SEC-53) |
