# Deployment — NinjaSoft POS

Cómo se despliega el sistema, qué entornos existen, cómo se promociona código a producción y cómo se hace rollback.

## 1. Entornos

| Entorno | URL | Branch | Supabase | Datos |
|---|---|---|---|---|
| **Local** | `localhost:3000` | feature/* | Local (Docker) | Seed dev. |
| **Preview** | `https://<branch>.ninjasoft-pos.vercel.app` | feature/* (auto) | Staging compartido | Datos de testing aislados. |
| **Staging** | `https://staging.ninjasoft.com.ar` | `develop` (auto) | Proyecto staging | Datos reales anonimizados (Fase 2+). |
| **Production** | `https://app.ninjasoft.com.ar` | `main` (auto) | Proyecto production | Datos reales de clientes. |

## 2. Pipeline

```
feature/* push
   │
   ▼
[CI] lint + typecheck + tests
   │  ✅
   ▼
[Vercel] crea preview deploy → URL única por PR
   │
   ▼
[Code review] aprobación + smoke test manual en preview
   │  ✅
   ▼
Merge a develop
   │
   ▼
[Vercel] deploy a staging automático
   │
   ▼
[QA] testing manual + automated en staging
   │  ✅
   ▼
Merge a main (PR develop → main)
   │
   ▼
[Vercel] deploy a production automático
   │
   ▼
[Monitor] alertas activas primeras 2hs
```

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

| Variable | Production | Staging | Preview |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | prod URL | staging URL | staging URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | prod anon | staging anon | staging anon |
| `SUPABASE_SERVICE_ROLE_KEY` | prod (server only) | staging (server only) | staging (server only) |
| `APP_ENV` | `production` | `staging` | `preview` |
| `SENTRY_DSN` | prod project | staging project | staging project |
| `RESEND_API_KEY` | prod | staging | staging |
| `AFIP_ENVIRONMENT` | `production` | `homologation` | `homologation` |

**Regla:** previews y staging **nunca** apuntan a Supabase production. Bug de un preview no puede afectar datos reales.

### 3.4 Domains
- `app.ninjasoft.com.ar` → production.
- `staging.ninjasoft.com.ar` → staging.
- `ninjasoft.com.ar` → landing.

## 4. Supabase: gestión de entornos

### 4.1 Proyectos

| Entorno | Proyecto Supabase |
|---|---|
| Local | Docker (`supabase start`) |
| Staging | `ninjasoft-pos-staging` |
| Production | `ninjasoft-pos-prod` |

No usamos branches de Supabase para preview (cada PR no necesita BD propia). Si una feature necesita schema nuevo, se aplica primero a staging y se valida ahí.

### 4.2 Migraciones

Flujo:

```bash
# 1. Crear migración local
supabase migration new add_loyalty_table

# 2. Editar el SQL generado
# (archivo en supabase/migrations/)

# 3. Aplicar localmente
supabase db reset

# 4. Test local
pnpm test

# 5. Commit + PR
git add supabase/migrations/
git commit -m "feat(db): add loyalty table"

# 6. Después de merge a develop:
#    CI aplica a staging automáticamente
supabase db push --linked  # staging

# 7. Después de merge a main:
#    Manual o CI con aprobación
supabase db push --linked  # production
```

**Regla:** migraciones en `main` **solo** después de validar en staging.

### 4.3 Edge Functions

```bash
# Deploy de una función
supabase functions deploy create_sale --project-ref <ref>

# Deploy de todas
supabase functions deploy --project-ref <ref>
```

CI hace esto automáticamente en cada deploy.

## 5. Scripts en `package.json`

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "test:run": "vitest run",
    "test:e2e": "playwright test",
    "test:coverage": "vitest run --coverage",
    
    "db:reset": "supabase db reset",
    "db:diff": "supabase db diff",
    "db:push:staging": "supabase db push --project-ref $STAGING_REF",
    "db:push:prod": "supabase db push --project-ref $PROD_REF",
    
    "fn:serve": "supabase functions serve",
    "fn:deploy:staging": "supabase functions deploy --project-ref $STAGING_REF",
    "fn:deploy:prod": "supabase functions deploy --project-ref $PROD_REF",
    
    "types:gen": "supabase gen types typescript --project-ref $STAGING_REF > lib/supabase/types.ts"
  }
}
```

## 6. CI/CD: GitHub Actions

### 6.1 `.github/workflows/ci.yml`
Corre en cada PR.

```yaml
name: CI
on: [pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - uses: supabase/setup-cli@v1
      - run: supabase start
      - run: supabase db reset
      - run: pnpm test:run
      - run: pnpm test:e2e
```

### 6.2 `.github/workflows/deploy-staging.yml`
Corre al mergear a `develop`.

```yaml
name: Deploy Staging
on:
  push:
    branches: [develop]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase db push --project-ref ${{ secrets.STAGING_REF }}
      - run: supabase functions deploy --project-ref ${{ secrets.STAGING_REF }}
      # Vercel deploy ocurre automáticamente por integración git
```

### 6.3 `.github/workflows/deploy-prod.yml`
Corre al mergear a `main`. **Requiere aprobación manual.**

```yaml
name: Deploy Production
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production  # requiere approval
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase db push --project-ref ${{ secrets.PROD_REF }}
      - run: supabase functions deploy --project-ref ${{ secrets.PROD_REF }}
```

## 7. Rollback

### 7.1 Frontend (Vercel)
- Cada deploy queda guardado.
- Rollback: `Vercel dashboard → Deployments → <deploy anterior> → Promote to Production`.
- Tiempo: < 30 segundos.

### 7.2 Edge Functions
- Funciones no tienen rollback automático.
- Patrón: cherry-pick del commit anterior + redeploy.
- Tiempo: 2-5 minutos.

### 7.3 Migraciones de BD
- **Nunca rollback automático.** Las migraciones son append-only.
- Si una migración rompe algo:
  - Si es aditiva (nueva columna): hotfix que la haga opcional.
  - Si es destructiva: nueva migración de "compensación".
- Por eso las migraciones destructivas requieren plan documentado.

### 7.4 Datos
- Restore desde snapshot: solo desde Supabase dashboard.
- **No es trivial.** Implica downtime potencial.
- Solo en caso de corrupción de datos confirmada.

## 8. Releases y versionado

- Versionamos siguiendo [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`.
- `MAJOR`: breaking change para clientes (cambio de API pública).
- `MINOR`: nuevas features.
- `PATCH`: fixes.
- Tag git por release: `v1.2.3`.
- `CHANGELOG.md` se actualiza en cada PR a `main`.

## 9. Monitoreo post-deploy

Ver [`14-observability.md`](./14-observability.md). Resumen:

Después de cada deploy a producción:
- Sentry: alerta si rate de errores sube > 50% vs baseline en 30 min.
- Vercel Analytics: monitorear Core Web Vitals.
- Logs de Supabase: revisar errores en Edge Functions.
- Manual: hacer una venta de prueba en producción.

## 10. Maintenance windows

- Planificadas: domingos 04:00-06:00 ART. Comunicar a clientes 7 días antes.
- Emergencia: lo más rápido posible. Comunicar inmediatamente.

## 11. Checklist pre-deploy a producción

- [ ] Todos los tests pasan en CI.
- [ ] Cambio validado en staging por al menos 24hs sin issues.
- [ ] Migraciones revisadas (sin DROP, sin ALTER destructivo sin plan).
- [ ] Variables de entorno nuevas configuradas en Vercel.
- [ ] Edge Functions nuevas deployed.
- [ ] `CHANGELOG.md` actualizado.
- [ ] PM informado del deploy.
- [ ] Smoke test plan listo.

## 12. Disaster recovery

- **RTO** (Recovery Time Objective): 4 horas.
- **RPO** (Recovery Point Objective): 1 hora (max data loss).
- Plan documentado en `docs/security-reviews/disaster-recovery.md` (Fase 3).
- Test de DR cada 6 meses.
