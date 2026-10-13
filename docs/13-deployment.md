# Deployment — NinjaSoft POS

Cómo se despliega el sistema, qué entornos existen, cómo se promociona código a producción y cómo se hace rollback.

> **Estado real (2026-10-13, ADR-098).** Hoy no hay staging: hay local, previews de Vercel y producción. Las migraciones se aplican a mano (MCP de Supabase o CLI) y las Edge Functions con la CLI. Lo que sigue describe ese flujo y el checklist verificable que lo protege (§11). El staging de §1 queda como objetivo (depende de contratar un segundo proyecto Supabase).

## 1. Entornos

| Entorno | URL | Branch | Supabase | Datos |
|---|---|---|---|---|
| **Local** | `localhost:3000` | feature/* | Local (Docker, `pnpm db:start`) | Seed dev. |
| **Preview** | URL de Vercel por rama | cualquier rama (auto) | **Producción** (no hay staging) | Reales: probar sólo en el tenant QA. |
| **Production** | `https://pos.soft.ninja` | `main` (auto) | Proyecto `hrkditzrsavehnhngakb` | Datos reales de clientes. |
| **Staging** *(objetivo)* | `staging.*` | `develop` | Proyecto staging | Datos anonimizados. |

**Regla mientras no haya staging:** un preview pega contra la base de producción. Todo lo que se pruebe a mano o con E2E va en el **tenant QA** (el suite E2E aborta si la sesión es de otro negocio). Una migración nunca se prueba "en el preview": se valida con la suite RLS de CI (Supabase local con todas las migraciones) antes de aplicarla.

## 2. Pipeline

```
rama → PR
   │
   ▼
[CI] quality: lint + typecheck + deploy-check + test + build
[CI] rls: Supabase local con TODAS las migraciones + suite de aislamiento
   │  ✅
   ▼
[Vercel] preview por PR (contra producción: sólo tenant QA)
   │
   ▼
[Review] aprobación
   │
   ▼
Merge a main
   │
   ▼
Deploy de BASE (manual, §4): migraciones en orden → Edge Functions
   │
   ▼
[Vercel] deploy del front a producción (automático al mergear)
   │
   ▼
Post-deploy (§11.2): healthcheck profundo + smoke de piloto en el tenant QA
```

**Orden obligatorio:** migraciones → Edge Functions → front. Cada ADR dice si el front tolera la base vieja; si no la tolera, la migración se aplica **antes** del merge.

## 3. Vercel: configuración

### 3.1 Project settings
- Framework: Next.js.
- Node version: 20.x.
- Install command: `pnpm install --frozen-lockfile`.
- Build command: `pnpm build`.
- Output directory: `.next`.
- Root directory: `/`.

### 3.2 Branches
- Production branch: `main`.
- Auto-deploy preview: enabled.
- Deploy hooks: disabled (todo va por git).

### 3.3 Environment variables

| Variable | Production | Preview |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | prod URL | prod URL (no hay staging) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | prod anon | prod anon |
| `SUPABASE_SERVICE_ROLE_KEY` | prod (server only) | prod (server only) |
| `APP_ENV` | `production` | `preview` |
| `RESEND_API_KEY` | prod | prod |

`VERCEL_ENV` y `VERCEL_GIT_COMMIT_SHA` los pone Vercel: `/api/health` los informa (env y commit corto) para saber qué versión está viva.

### 3.4 Domains
- `pos.soft.ninja` → production (canónico; el alias `ninja-soft-pos.vercel.app` redirige con 308).
- `hooks.soft.ninja` → proxy de webhooks a las Edge Functions (`lib/hooks.ts`).

## 4. Supabase: base y Edge Functions

### 4.1 Proyectos

| Entorno | Proyecto Supabase |
|---|---|
| Local | Docker (`supabase start`) |
| Production | `hrkditzrsavehnhngakb` |

### 4.2 Migraciones

- Viven en `supabase/migrations/`, nombre `<14 dígitos>_<snake_case>.sql`. **Son inmutables una vez aplicadas:** un error se corrige con una migración nueva.
- Se aplican **en orden de timestamp**, no en orden de merge. Ramas paralelas generan migraciones con timestamp menor que otras ya mergeadas (CI lo avisa como `M5`): se aplican igual en orden de timestamp, después de verificar que no dependen de algo más nuevo.
- Se aplican a mano con el MCP de Supabase (`apply_migration`, nombre = nombre del archivo sin `.sql`) o con `supabase db push --linked` (si hay huecos, `--include-all`). El MCP guarda la hora de aplicación como versión: `deploy-check` empareja por versión **o por nombre**.
- Antes de aplicar: `node --env-file=.env.local scripts/deploy-check.mjs --remote` (o `--applied=<archivo>` con la salida de `list_migrations`) imprime **la última aplicada y todas las pendientes en orden**, marca huecos (`M3`) y sentencias destructivas (`W1`). Ver §11.

### 4.3 Edge Functions

```bash
# Una función (el verify_jwt sale de supabase/config.toml)
npx supabase functions deploy <nombre> --project-ref hrkditzrsavehnhngakb
```

- **Públicas (`verify_jwt = false`)**: exactamente las 16 de `[functions.*]` en `supabase/config.toml` (webhooks de procesadores, checkouts propios, `mp_oauth_callback`, `send_password_recovery`). `supabase functions deploy` lee esa sección, así que **no hace falta `--no-verify-jwt`** y un deploy de todas no deja un webhook pidiendo JWT. CI valida que la lista del config, la de `scripts/deploy-check.mjs` y el encabezado de cada función coincidan; `--remote` compara además con lo desplegado (`R1`, `R2`).
- Las públicas leen el cuerpo con `readJsonLimited` (64 KB) de `_shared/requestGuard.ts`; los checkouts y el recupero de contraseña tienen además un tope por IP (best-effort por isolate).
- Una función que cambia `_shared/` obliga a redesplegar todas las que lo importan (cada ADR lo lista).

## 5. Scripts en `package.json`

| Script | Qué hace |
|---|---|
| `pnpm lint` / `typecheck` / `test` / `build` | Gate automático (CI `quality`). |
| `pnpm test:rls` | Suite de aislamiento multi-tenant (CI `rls`, Supabase local). |
| `pnpm test:e2e` | Playwright completo (ver `tests/e2e/README.md`). |
| `pnpm test:smoke` | Smoke de piloto: sesión, caja, venta en efectivo, ticket, anulación, cierre y reporte (§11.2). |
| `pnpm deploy:check` | Chequeo estático de migraciones y Edge públicas (§11.1). |
| `pnpm db:start` / `db:reset` / `db:types` | Supabase local y tipos. |

## 6. CI/CD: GitHub Actions

`.github/workflows/ci.yml`, en cada PR y push a `main`:

- **quality:** install → lint → typecheck → **deploy check** (`scripts/deploy-check.mjs --base=origin/<rama base>`: nombres y timestamps de migraciones, migraciones existentes sin tocar, lista exacta de Edge públicas) → test → build.
- **rls:** `supabase start` aplica todas las migraciones en orden y corre `pnpm test:rls`. Si falla, hay fuga entre tenants, una policy rota o una migración que no aplica desde cero: no mergear.

No hay deploy automático de base ni de Edge Functions: se hace a mano (§4) con el checklist de §11.

## 7. Rollback

### 7.1 Frontend (Vercel)
- Cada deploy queda guardado.
- Rollback: `Vercel dashboard → Deployments → <deploy anterior> → Promote to Production` (o `vercel rollback`).
- Tiempo: < 30 segundos.
- **Verificar:** `curl https://pos.soft.ninja/api/health` devuelve el `commit` del deploy promovido.

### 7.2 Edge Functions
- No tienen rollback automático.
- Patrón: `git checkout <sha anterior> -- supabase/functions/<fn> supabase/functions/_shared` y redeploy de esa función (el `verify_jwt` sale del config, no hay que recordarlo).
- **Verificar:** `deploy-check --remote` sin `R1`/`R2`, y el flujo afectado en el tenant QA.
- Tiempo: 2-5 minutos.

### 7.3 Migraciones de BD
- **Nunca rollback automático.** Las migraciones son append-only.
- Si una migración rompe algo:
  - Si es aditiva (tabla, columna, función nueva): el front anterior la ignora; se hace rollback del front y se corrige con una migración nueva.
  - Si recrea una función: migración de compensación que copia la definición **anterior** (la del archivo previo que la definía) y se aplica.
  - Si es destructiva: necesita plan de datos escrito en el ADR **antes** de aplicarla (`deploy-check` la marca `W1`).
- **Verificar:** `deploy-check --remote` sin `M3` y `pnpm test:smoke` en el tenant QA.

### 7.4 Datos
- Restore desde backup: ver [`security-reviews/disaster-recovery.md`](./security-reviews/disaster-recovery.md) §Backup y restore.
- **No es trivial.** Implica downtime y pérdida de lo escrito después del backup.
- Solo en caso de corrupción de datos confirmada.

## 8. Releases y versionado

- Versionamos siguiendo [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`.
- `MAJOR`: breaking change para clientes (cambio de API pública).
- `MINOR`: nuevas features.
- `PATCH`: fixes.
- Tag git por release: `v1.2.3`.
- `CHANGELOG.md` se actualiza en cada PR a `main`.

## 9. Monitoreo post-deploy

Ver [`14-observability.md`](./14-observability.md) §Checklist de monitoreo del piloto. Resumen: `/api/health?deep=1` en un monitor de uptime, errores del front en los logs de Vercel (`event: "client_error"`), logs de Edge Functions en Supabase y una venta de prueba en el tenant QA.

## 10. Maintenance windows

- Planificadas: domingos 04:00-06:00 ART. Comunicar a clientes 7 días antes.
- Emergencia: lo más rápido posible. Comunicar inmediatamente.

## 11. Checklist de deploy (verificable)

Copiar en el PR o en el hilo del deploy y tildar con la salida de cada comando.

### 11.1 Antes de aplicar

- [ ] CI verde en el PR (`quality` y `rls`).
- [ ] `node scripts/deploy-check.mjs --base=origin/main` sin errores; los `M5` revisados (no dependen de algo más nuevo).
- [ ] `node --env-file=.env.local scripts/deploy-check.mjs --remote` (necesita `SUPABASE_ACCESS_TOKEN` y `SUPABASE_PROJECT_REF`): sin `M3`, `R1` ni `R2`. Pegar la lista de **pendientes en orden**: es exactamente lo que se aplica.
- [ ] Cada `W1` (destructiva) tiene su plan de datos en el ADR.
- [ ] Backup reciente visible en el dashboard de Supabase (Database → Backups) o dump lógico del día si la migración toca datos (§Backup y restore del DR).
- [ ] Variables de entorno y secrets nuevos cargados (Vercel y `supabase secrets`), según el ADR.
- [ ] `CHANGELOG.md` actualizado.

### 11.2 Aplicar y verificar

- [ ] Migraciones pendientes aplicadas **en el orden impreso**. Repetir `deploy-check --remote`: 0 pendientes.
- [ ] Edge Functions del ADR desplegadas. `deploy-check --remote` sin `R1`/`R2`.
- [ ] Front en producción: `curl https://pos.soft.ninja/api/health` muestra el `commit` del merge.
- [ ] `curl https://pos.soft.ninja/api/health?deep=1` → `200` y `"status":"ok"` (Auth y base responden).
- [ ] Smoke de piloto en el tenant QA (sesión QA, ver `tests/e2e/README.md`):
  ```bash
  E2E_EMAIL=<owner QA> node --env-file=.env.local scripts/e2e-session.mjs
  source "${TMPDIR:-/tmp}/ninjapos-e2e-session.env"
  BASE_URL=https://pos.soft.ninja pnpm test:smoke
  ```
  Cubre: sesión → abrir caja → venta en efectivo → ticket → anulación → cierre con arqueo → reporte.
- [ ] 30 minutos después: sin `client_error` nuevos en los logs de Vercel ni 5xx nuevos en las Edge del ADR.

### 11.3 Si algo falla

- Front: §7.1 (promote del deploy anterior) y avisar.
- Edge: §7.2.
- Base: §7.3. Nunca editar una migración aplicada.

## 12. Disaster recovery

- **RTO** (Recovery Time Objective): 4 horas.
- **RPO** (Recovery Point Objective): 1 hora con PITR; **24 horas** si el proyecto sólo tiene backups diarios (verificar el plan contratado).
- Plan y procedimiento de backup/restore en [`docs/security-reviews/disaster-recovery.md`](./security-reviews/disaster-recovery.md).
- Test de restore cada 6 meses (y antes de salir a piloto).
