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

### Release continuo (default)

Para casi todos los cambios (`feat`, `fix`, `chore`):

1. PR aprobada.
2. CI verde.
3. Checklist de `18-qa-checklist.md` cumplido.
4. Merge a `main`.
5. Vercel despliega automáticamente.
6. Smoke test post-deploy (5 minutos).
7. Si todo ok, `docs-writer` actualiza `CHANGELOG.md` (o ya estaba actualizado en la PR).

Esto pasa varias veces por semana.

### Release con tag (versionado)

Cuando se cierra un hito o se quiere marcar un punto de referencia:

1. Verificar que `CHANGELOG.md` está al día con todos los cambios desde el último tag.
2. Bumpear versión en `package.json`.
3. Commit `release: vX.Y.Z`.
4. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
5. Push del tag: `git push origin vX.Y.Z`.
6. Crear release en GitHub con el contenido del `CHANGELOG.md` para esa versión.

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

## Checklist pre-release (cuando se taggea)

Para releases tagueados (`vX.Y.Z`):

- [ ] `CHANGELOG.md` con sección completa de la nueva versión.
- [ ] `package.json` actualizado.
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

Sección `[Unreleased]` siempre al tope. Cuando se hace release, se mueve a `[X.Y.Z] - YYYY-MM-DD`.

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

- **Diario:** merges a `main`, deploys automáticos.
- **Semanal:** revisión de incidentes (si los hubo), revisión del CHANGELOG.
- **Cada hito MVP (H0–H6):** tag versionado.
- **Mensual:** review de ADRs nuevas, revisión de feature flags acumuladas, revisión de deuda técnica.

Cuando el producto esté en clientes pagos, se ajusta: probablemente ventanas de deploy planificadas para evitar horas pico de venta (medianoche en lugar de mediodía).
