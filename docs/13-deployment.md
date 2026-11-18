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
- Build command: `pnpm build` (= `next build && node scripts/build-check.mjs`, ver §3.1.1).
- Output directory: `.next`.
- Root directory: `/`.

### 3.1.1 Memoria del build y chequeo de `BUILD_ID` (OPS-55)

- **El problema.** El chequeo de tipos de `next build` corre en un proceso hijo (jest-worker de Next 14.2). Con el heap por defecto de Node 20 (~2 GB en una máquina de 7-8 GB) el proyecto entero no entra y ese hijo muere por OOM. En Linux V8 aborta con `SIGABRT`, el hijo sale con código `null`, y el jest-worker que trae Next lo trata como cierre normal: no rechaza la llamada pendiente, el proceso padre se queda sin nada que hacer y **`next build` termina con código 0 sin haber escrito el build**. En Windows el hijo sale con 134 y ahí sí falla. Reproducido con el jest-worker de Next en Node 20 Linux (WSL): el padre sale 0 después del `FATAL ERROR ... heap out of memory`.
- **La defensa.** El script `build` de `package.json` encadena `node scripts/build-check.mjs`, que sale 1 si no existe `.next/BUILD_ID` (o está vacío). Va en el propio script y no en un `postbuild` porque pnpm 9 no corre `pre`/`post` scripts salvo con `enable-pre-post-scripts`; con `&&` corre igual en CI, en Vercel (Build command `pnpm build`) y en local. No se usa `typescript.ignoreBuildErrors`.
- **Heap explícito.** En CI los jobs `quality` y `e2e-smoke` corren el build con `NODE_OPTIONS=--max-old-space-size=6144` (igual que el typecheck). Local: si `pnpm build` falla por memoria, `NODE_OPTIONS=--max-old-space-size=8192 pnpm build`.
- **Vercel.** La máquina de build estándar de Vercel tiene 8 GB de RAM (4 vCPU); el heap que le queda a Node depende de cómo Vercel arme el entorno y no se ve desde el repo. Al 2026-11-17 los últimos 40 deploys de producción figuran `success` en GitHub, así que hoy entra; desde OPS-55, si el chequeo de tipos se queda sin memoria el deploy falla con `build-check: next build terminó sin generar el build` en lugar de salir verde. **Si eso pasa** (paso manual de Lucas, no está aplicado): Vercel → Project → Settings → Environment Variables → `NODE_OPTIONS` = `--max-old-space-size=6144` en Production y Preview, y redeploy. No subirlo a más de ~6 GB: el resto de la memoria la usan webpack y los workers de páginas.

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

### 4.2.1 Historial de migraciones

**Estado (2026-11-17, SEC-02 · ADR-183): el historial de prod es igual al repo.** `schema_migrations` tiene una fila por archivo de `supabase/migrations/` con la versión del archivo (466 al hacer el repair) y `deploy-check --applied` da 0 pendientes. El historial viejo (200 filas con la hora de aplicación del MCP y su `statements`) quedó en `supabase_migrations.schema_migrations_bak_20261117`; no se borra.

**Regla desde el repair:** el MCP `apply_migration` registra la hora de aplicación como versión. Después de aplicar una migración con él, en el mismo paso, se renombra esa fila a la versión del archivo:

```sql
update supabase_migrations.schema_migrations
   set version = '<versión del archivo>'
 where version = '<versión que dejó el MCP>' and name = '<nombre del archivo>';
```

Así el historial sigue igual al repo y `supabase db push` / `deploy-check --applied` no ven pendientes falsos. Antes del repair el historial se llenó sólo con el MCP, así que ninguna versión coincidía con un archivo y las migraciones aplicadas por SQL directo después del 14-06-2026 no tenían fila.

`scripts/migration-repair-plan.mjs` arma el plan para dejar el historial igual al repo (el repo es la fuente de verdad: toda fila remota sin archivo queda `reverted` y todo archivo con evidencia en el historial queda `applied`). Los archivos **sin ninguna fila remota** quedan fuera del plan salvo con `--include-unverified`: marcarlos `applied` sin que estén en la base haría que `db push` los saltee para siempre, así que antes se verifica su contenido en la base (SEC-02). No toca la base:

```bash
# applied.json = salida de list_migrations (MCP) o "version nombre" por línea
node scripts/migration-repair-plan.mjs --applied=applied.json --out=repair/
# después de verificar los archivos de repair/repair-unverified.txt contra la base:
node scripts/migration-repair-plan.mjs --applied=applied.json --include-unverified --backup=schema_migrations_bak_AAAAMMDD --out=repair/
```

- Cruza cada fila remota con un archivo **por nombre** (sacando el prefijo `\d{14}_` que tienen algunos nombres), con una tabla de fusiones conocidas (`delivery_orders` ⇐ `delivery_orders_p1..p4`, `service_packs` ⇐ `service_packs_*`, segundas partes como `product_modifiers_create_sale`) y las huérfanas `verify_*_file(s)_parse`. Sale con código 1 si queda alguna fila remota desconocida: hay que mirarla antes del repair.
- Escribe `repair-reverted.txt`, `repair-applied.txt`, `repair-unverified.txt`, `repair-commands.sh` (`supabase migration repair` en tandas de 50, con `set -euo pipefail`) y `repair.sql`: una transacción que primero copia la tabla a `--backup` (la columna `statements` de las filas viejas es la única copia de algunas migraciones que nunca se commitearon, ADR-098), borra, inserta con un insert común (una colisión aborta todo) y controla el conteo final.
- Lista también 3 filas remotas extra sin archivo propio (`onboarding_status_v2`, `owner_subscription`, `gate_payment_methods`): no bloquean, pero hay que mirar su `statements` en el backup.

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
| `pnpm lint` / `typecheck` / `test` / `build` | Gate automático (CI `quality`). `build` falla si no quedó `.next/BUILD_ID` (§3.1.1). |
| `pnpm test:rls` | Suite de aislamiento multi-tenant (CI `rls`, Supabase local). |
| `pnpm test:e2e` | Playwright completo (ver `tests/e2e/README.md`). |
| `pnpm test:smoke` | Smoke de piloto: sesión, caja, venta en efectivo, ticket, anulación, cierre y reporte (§11.2). |
| `pnpm deploy:check` | Chequeo estático de migraciones y Edge públicas (§11.1). |
| `pnpm release:prepare` / `release:notes` | Versión del deploy: `package.json`, corte del CHANGELOG y registro `docs/releases/vX.Y.Z.md` con PRs, migraciones y Edges a aplicar; notas para el release de GitHub (§8). |
| `pnpm db:start` / `db:reset` / `db:types` | Supabase local y tipos. |

## 6. CI/CD: GitHub Actions

`.github/workflows/ci.yml`, en cada PR y push a `main`:

- **quality:** install → lint → typecheck → **deploy check** (`scripts/deploy-check.mjs --base=origin/<rama base>`: nombres y timestamps de migraciones, migraciones existentes sin tocar, lista exacta de Edge públicas) → test → build (heap de 6 GB + chequeo de `BUILD_ID`, §3.1.1).
- **rls:** `supabase start` aplica todas las migraciones en orden y corre `pnpm test:rls`. Si falla, hay fuga entre tenants, una policy rota o una migración que no aplica desde cero: no mergear.

No hay deploy automático de base ni de Edge Functions: se hace a mano (§4) con el checklist de §11.

### 6.1 Drift nocturno prod/repo (SEC-04)

`.github/workflows/drift.yml` corre todos los días a las 09:00 UTC (y a mano con *Run workflow*) `node scripts/deploy-check.mjs --remote --advisors` contra producción, sólo lectura:

- **Falla** ante errores: `M3` (migración del repo sin aplicar y más vieja que la última aplicada), `R1`/`R2` (Edge desplegada con un `verify_jwt` distinto de la lista pública), `A1` (un advisor de seguridad supera su umbral de `scripts/security-baseline.json`) o `A2` (SECURITY DEFINER ejecutable por anon fuera de `supabase/security/anon-allowlist.json`). Los avisos (`M4`, `W1`, `R3`, `A3`) quedan en el resumen sin cortar.
- Si falla, abre un issue con label `drift` o, si ya hay uno abierto, le agrega un comentario con el resumen (sin secretos; el ref del proyecto se reemplaza por `<ref>`). Cerrar el issue al corregir.
- `--advisors` lee `GET /v1/projects/{ref}/advisors/security` (lints de Splinter: `name`, `title`, `level`, `metadata`) y cuenta por `name`. Umbrales hoy: `anon_security_definer_function_executable` ≤ 19 (la allowlist) y `function_search_path_mutable` = 0 como error; `rls_disabled_in_public`, `policy_exists_rls_disabled` y `security_definer_view` = 0 como aviso hasta confirmar el valor de prod. Bajar un umbral al corregir; subirlo se justifica en el PR.

**Secrets (los carga un admin del repo, SEC-05):** GitHub → *Settings → Secrets and variables → Actions → New repository secret*:

| Secret | Valor |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Token personal de [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) de una cuenta con acceso al proyecto de prod (idealmente una cuenta de servicio). |
| `SUPABASE_PROJECT_REF` | Ref del proyecto de producción (el subdominio de `<ref>.supabase.co`). |

Con `gh`: `gh secret set SUPABASE_ACCESS_TOKEN` y `gh secret set SUPABASE_PROJECT_REF` (piden el valor por stdin). **Sin los secrets el job termina en verde con un `::warning::`** y no consulta nada. Para probarlo: *Actions → Drift prod/repo → Run workflow*.

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
- **Una versión PATCH por cada deploy de tanda** desde `0.2.0` (OPS-53 · ADR-193): `pnpm release:prepare --version X.Y.Z` en un PR a la tanda, tag anotado `vX.Y.Z` sobre el merge commit después de que Vercel despliega bien y release de GitHub con `pnpm release:notes`. Flujo completo en [`workflows/release-workflow.md`](./workflows/release-workflow.md).
- `docs/releases/vX.Y.Z.md` es el registro de lo que aplicó cada deploy: PRs, migraciones (*aplicada en prod*) y Edge Functions (*desplegada*, incluidas las que cambian sólo por un `_shared/`).
- `CHANGELOG.md` se actualiza en cada PR (en `[Unreleased]`).

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
- [ ] `CHANGELOG.md` actualizado y `pnpm release:prepare --version X.Y.Z` mergeado en la tanda: `docs/releases/vX.Y.Z.md` lista las migraciones y Edges de este deploy.

### 11.2 Aplicar y verificar

- [ ] Migraciones pendientes aplicadas **en el orden impreso**. Repetir `deploy-check --remote`: 0 pendientes.
- [ ] Edge Functions del ADR y del registro `docs/releases/vX.Y.Z.md` desplegadas. `deploy-check --remote` sin `R1`/`R2`.
- [ ] Front en producción: `curl https://pos.soft.ninja/api/health` muestra el `commit` del merge y `"version":"X.Y.Z"`.
- [ ] Tag `vX.Y.Z` sobre el merge commit y release de GitHub (`release-workflow.md`).
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
