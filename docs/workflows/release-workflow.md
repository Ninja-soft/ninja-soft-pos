# Release Workflow

Cómo publicamos versiones de NinjaSoft. Pensado para ritmo continuo: pocos cambios a la vez, deploys frecuentes, rollback rápido.

---

## Filosofía

- Releases chicos y frecuentes son más seguros que releases grandes y espaciados.
- Cada merge a `main` puede ir a producción si pasa el checklist.
- `main` siempre está desplegable. Si rompe, se arregla o se revierte, no se queda roto.
- El número de versión es para humanos: para entender qué hay en producción y comunicarlo al cliente.

---

## Versionado

Semver adaptado a SaaS interno:

```
MAJOR.MINOR.PATCH
```

- **MAJOR** — cambios incompatibles que requieren coordinación con clientes (migración manual, cambio de URL, cambio de modelo de plan).
- **MINOR** — funcionalidad nueva sin romper nada.
- **PATCH** — fixes y mejoras menores.

Hasta llegar a `1.0.0` (lanzamiento público), arrancamos en `0.1.0` e incrementamos `MINOR` a cada hito relevante del MVP.

**Una versión por deploy (OPS-53 · ADR-193).** Desde `0.2.0` (deploy de `tanda/2026-11-18-1`, 2026-11-18) cada deploy de una tanda a producción corta una versión **PATCH** (`0.2.1`, `0.2.2`…). `MINOR` sube cuando se cierra un hito o el dueño lo decide. La versión desplegada se ve en `GET /api/health` (`version`, sale de `package.json` en el build) junto con el `commit`. Lo que aplicó cada versión queda en `docs/releases/vX.Y.Z.md`.

---

## Ramas y entornos

| Ambiente | Rama | URL | Datos |
|---|---|---|---|
| Local | cualquier rama | `localhost:3000` | Supabase CLI local |
| Preview | rama de PR | `pr-N.ninjasoft.vercel.app` | Supabase preview branch |
| Staging | `staging` | `staging.ninjasoft.app` | Supabase staging |
| Producción | `main` | `app.ninjasoft.app` | Supabase producción |

Ver `13-deployment.md` para detalle.

---

## Flujo de release

### Cambios del día a día

Para casi todos los cambios (`feat`, `fix`, `chore`):

1. PR aprobada contra la tanda abierta (`tanda/AAAA-MM-DD-N`), con su entrada en `[Unreleased]` del CHANGELOG.
2. CI verde.
3. Checklist de `18-qa-checklist.md` cumplido.
4. Squash a la tanda.
5. La tanda sale a producción entera en el próximo deploy (abajo).
6. Smoke test post-deploy (5 minutos).

### Deploy de una tanda = una versión (flujo vigente)

Los cambios se juntan en una rama `tanda/AAAA-MM-DD-N` (PRs squash). El deploy a producción es el merge de esa tanda a `main`. Cada deploy se versiona así:

1. **Preparar la versión, en un PR a la tanda** (rama `chore/release-vX.Y.Z` desde la tanda):
   ```bash
   pnpm release:prepare --version X.Y.Z --date AAAA-MM-DD --tanda tanda/AAAA-MM-DD-N
   # opcional, sólo lectura contra prod (SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF):
   node --env-file=.env.local scripts/release.mjs prepare --version X.Y.Z --remote
   ```
   - Sube `package.json` (tiene que ser semver y mayor que la actual).
   - Corta `[Unreleased]` del CHANGELOG en `## [X.Y.Z] - fecha` (la nota `> …` del tope se queda en Unreleased).
   - Escribe `docs/releases/vX.Y.Z.md`: rango de commits, PRs (número, tarea, título), migraciones nuevas con *aplicada en prod*, Edge Functions a desplegar con *desplegada* (carpeta propia cambiada o que importa un `_shared/` cambiado, resuelto por imports) y flags/features sembrados. Agrupa por deploy: cada merge `tanda/*` del first-parent es un bloque y lo no mergeado es el bloque "este deploy".
   - `--from` por defecto es el último tag `v*`; si no hay, el último merge de tanda en `origin/main`. `--to` por defecto es `HEAD`.
   - Sin `--remote`, lo que ya está en `origin/main` figura `sí (en main)` y el resto `pendiente de verificar`. También acepta `--applied <archivo>` (texto o JSON de `list_migrations` del MCP) y `--deployed <archivo>` (JSON de `list_edge_functions`).
   - Revisar el registro: cada Edge con `pendiente`/`no` se despliega con el deploy (o se anota por qué no hace falta). Ajustar a mano la nota de estado de la sección del CHANGELOG si corresponde.
2. **PR de deploy tanda → `main`**, mergeado con **merge commit** (no squash): ese commit es el que se taggea.
3. Aplicar migraciones y desplegar las Edges del registro (`docs/13-deployment.md`). Vercel despliega `main`.
4. **Después de que Vercel termina bien** (y `/api/health` muestra `X.Y.Z`):
   ```bash
   git fetch origin
   git tag -a vX.Y.Z <merge commit> -m "vX.Y.Z"
   git push origin vX.Y.Z
   pnpm release:notes --version X.Y.Z > notas.md
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file notas.md --verify-tag
   ```
   `release:notes` imprime la sección del CHANGELOG con el link al registro; si no entra en el límite de GitHub queda la versión compacta (títulos de cada entrada y link al CHANGELOG).
5. **Cerrar el registro** si quedó algo `pendiente`: `node --env-file=.env.local scripts/release.mjs record --version X.Y.Z --to vX.Y.Z --remote` (regenera sólo `docs/releases/vX.Y.Z.md`) o editar las columnas a mano, en un PR a la tanda siguiente.

El PR de release no aparece en su propio registro (se genera antes de mergearlo).

### Release fuera de una tanda

Un hotfix directo a `main` también es un deploy: después del merge, `pnpm release:prepare --version X.Y.(Z+1)` en un PR y el tag sobre el commit desplegado.

### Hotfix urgente

Cuando algo está roto en producción y no se puede esperar:

1. Rama desde `main`: `fix/descripcion-corta`.
2. Cambio mínimo, foco solo en el bug.
3. PR con label `hotfix`.
4. Review acelerado (un humano, lo más rápido posible, sin saltear lectura).
5. Merge a `main` → deploy automático.
6. Verificar el fix en producción.
7. Si era grave, comunicar al equipo y, si afectó a clientes, comunicar a clientes.

---

## Checklist pre-release (cada deploy)

Para cada versión (`vX.Y.Z`):

- [ ] `pnpm release:prepare` corrido en un PR a la tanda: `CHANGELOG.md` con la sección, `package.json` y `docs/releases/vX.Y.Z.md`.
- [ ] Cada migración y Edge del registro aplicada / desplegada (o con la razón anotada).
- [ ] Todas las migraciones aplicadas en staging y verificadas.
- [ ] `security-auditor` corrió el checklist de `18-qa-checklist.md` sección 3.
- [ ] Smoke test manual en staging.
- [ ] Documentación de cambios visibles al usuario lista (release notes para el cliente, si aplica).
- [ ] Equipo avisado de la ventana de deploy.

---

## CHANGELOG

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

Categorías:

- **Added** — funcionalidad nueva.
- **Changed** — cambios en funcionalidad existente.
- **Deprecated** — funciones que se van a remover.
- **Removed** — funciones removidas.
- **Fixed** — bugs corregidos.
- **Security** — fixes de seguridad.

Sección `[Unreleased]` siempre al tope. En cada deploy `pnpm release:prepare` la mueve a `[X.Y.Z] - YYYY-MM-DD`.

---

## Comunicación

### Interna

Cada release tagueado se anuncia en el canal del equipo con:

- Versión.
- Resumen de qué cambia.
- Link al CHANGELOG.
- Riesgos conocidos.

### A clientes

Para releases con impacto visible:

- Email o aviso in-app con lenguaje no técnico.
- Si el cambio es incompatible (MAJOR), aviso con anticipación y, si aplica, ventana de migración asistida.

---

## Rollback

### Cuándo rollback

- Error rate sube significativamente después del deploy.
- Un módulo crítico (POS, cobro, cierre de caja) se rompe.
- Pérdida o corrupción de datos.

### Cómo

1. **Frontend / Vercel:** botón "Rollback" al deploy anterior desde el panel de Vercel. Aplica en segundos.
2. **Migración de DB:** las migraciones no se "deshacen" en producción. Si la migración rompió algo, se prepara una **migración correctiva** (forward fix), no se intenta `down`.
3. **Edge Function:** redeploy de la versión anterior de la function desde el panel de Supabase.

### Después del rollback

- Comunicar al equipo.
- Issue con post-mortem: qué pasó, por qué no lo agarró el CI, qué cambia para que no pase de nuevo.
- Si afectó a clientes, comunicar y, si corresponde, compensar.

---

## Post-mortems

Cuando algo serio pasa en producción, se escribe un post-mortem corto en `docs/post-mortems/YYYY-MM-DD-titulo.md` usando [`docs/templates/post-mortem.md`](../templates/post-mortem.md). Contiene:

- Qué pasó (resumen).
- Línea de tiempo.
- Causa raíz.
- Impacto (clientes afectados, duración).
- Qué hicimos para resolverlo.
- Qué cambiamos para que no pase de nuevo.

Los post-mortems no buscan culpables. Buscan que el sistema mejore.

---

## Calendario sugerido

Esta no es una regla, es una guía para arrancar:

- **Cada deploy de tanda:** versión PATCH, tag y release de GitHub.
- **Semanal:** revisión de incidentes (si los hubo), revisión del CHANGELOG.
- **Cada hito MVP (H0–H6):** versión MINOR.
- **Mensual:** review de ADRs nuevas, revisión de feature flags acumuladas, revisión de deuda técnica.

Cuando el producto esté en clientes pagos, se ajusta: probablemente ventanas de deploy planificadas para evitar horas pico de venta (medianoche en lugar de mediodía).
