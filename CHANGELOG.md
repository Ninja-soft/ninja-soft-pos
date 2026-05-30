# Changelog

Todos los cambios relevantes de NinjaSoft POS quedan registrados acá.

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado: [Semver](https://semver.org/lang/es/).

---

## [Unreleased]

### Added

- **Esquema base de BD (Hito 0)** aplicado al proyecto Supabase dev/staging y versionado en `supabase/migrations/`:
  - Tablas: `tenants`, `users` (espejo de `auth.users`), `tenant_users`, `plans`, `subscriptions`, `feature_flags`, `tenant_feature_flags`, `system_settings`, `audit_logs`.
  - Funciones helper: `current_tenant_id()`, `is_internal()`, `set_updated_at()`, `write_audit_log()`, `handle_new_user()`.
  - RLS habilitada en las 9 tablas + 11 policies (aislamiento por tenant, lectura pública de planes/flags, `audit_logs` append-only).
  - Triggers de auditoría en `tenant_users`, `subscriptions`, `tenant_feature_flags`; `updated_at` automático.
  - Seed idempotente (`supabase/seed.sql`): 4 planes + catálogo de 14 feature flags. Precios en 0 (placeholder, definir antes de producción).
  - Hardening: `search_path` fijo en helpers, `handle_new_user` sin EXECUTE público. Linter de seguridad sin findings.
  - `types/database.ts` generado desde el esquema.
- ADR-009: resolución de `current_tenant_id()` vía `app_metadata.current_tenant_id`.
- Estructura inicial del proyecto: `docs/`, `.claude/agents/`, `supabase/`.
- Documentación del MVP, arquitectura, base de datos, multi-tenant, seguridad, AFIP, planes y feature flags.
- Sistema de subagentes para Claude Code: Project Manager + 11 especialistas.
- ADRs iniciales (ADR-001 a ADR-008).
- Workflows documentados: Git, agentes, releases.
- `CLAUDE.md` con contexto maestro para Claude Code.

---

## [0.1.0] - 2026-01-15

Primer commit del repo. Setup de documentación, agentes y convenciones. Sin código de aplicación todavía.

### Added

- Repositorio inicializado.
- Documentación base.
- Estructura de agentes.

---

## Plantilla para próximas versiones

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- Funcionalidad nueva.

### Changed
- Cambios en funcionalidad existente.

### Deprecated
- Lo que se va a remover en próximas versiones.

### Removed
- Lo que se removió en esta versión.

### Fixed
- Bugs corregidos.

### Security
- Fixes o mejoras de seguridad.
```
