# Suite SaaS — Registro, Onboarding, Planes, Gating, Cobros y Asistente IA

> Spec aprobada con el usuario (2026-06-07). Decisiones: Google SSO con guía (botón listo, credenciales las carga Lucas), cobros solo Mercado Pago, notificaciones in-app + email (web push → roadmap), IA Gemini+Claude en beta solo para el usuario Lucas y luego addon de pago.
> Referencias visuales: `img/Registro/*.png` (estructura del wizard/checklist de un competidor) adaptadas a la identidad NinjaPos (ninja-dark, flame, glassmorphism iOS, alto contraste).

## Qué ya existe (no se reconstruye)

- Auth email+password, onboarding self-service (`create_tenant`), login interno separado.
- `plans` (globales + custom por tenant, H12b), `subscriptions`, trial lifecycle completo, billing manual, descuentos, `limit_overrides`.
- MP: `mp_subscription_checkout` (preapproval) + `mp_billing_webhook`.
- `tenant_feature_flags` + `internal_set_flag` (flags por tenant = "features exclusivas por cliente" ✓).
- Notificaciones in-app (H13b) + plantillas de email del sistema + SMTP propio.

## Fase A — Registro + Google SSO

- `/signup` rediseñado: **wizard 2 pasos** (Tu cuenta → Tu negocio).
  - Desktop: tarjeta ancha side-by-side — izquierda propuesta de valor (logo, "14 días de prueba gratis. Sin tarjeta.", 3 bullets), derecha formulario. Mobile: vertical.
  - Glass iOS: panel `backdrop-blur`, bordes suaves, fondo con gradientes ninja (void→deepViolet con glow flame sutil).
  - Paso 1: Google SSO arriba + divisor "o con email" + negocio/sucursal/nombre/email/contraseña + **Datos fiscales (opcional)** colapsable (CUIT 11 dígitos, razón social, condición IVA) → persisten en `tenant_branding`.
  - Paso 2: tipo de negocio (cards con ícono: Kiosco/Comercio simple, Retail, …rubros existentes de RubroCard) → setea industry.
- **Google SSO**: `supabase.auth.signInWithOAuth({ provider: "google" })`. Usuario nuevo vía SSO sin tenant → cae al paso "Tu negocio" para completar alta. Guía paso a paso para Lucas (Google Cloud Console → OAuth client → Supabase Auth providers) en `docs/16-google-sso.md`.
- `condicion IVA` requiere columna `tenant_branding.iva_condition text` (pendiente de H8 — se agrega acá).

## Fase B — Onboarding checklist (dashboard)

- **Sin estado duplicado (antifallas)**: cada paso se deriva de datos reales:
  1. Datos fiscales → `tenant_branding.cuit` not null.
  2. Mercado Pago conectado → `tenant_payment_methods` mp habilitado o secret presente (RPC liviano `onboarding_status()` SECURITY INVOKER que devuelve booleans).
  3. Primer producto → exists products.
  4. Primera venta → exists sales.
  5. Diseño de ticket → exists ticket_templates print_active.
- Widget en dashboard: "Configurá tu negocio en 5 pasos", barra de progreso, check animado (scale+fade) al completarse, CTA por paso (link directo), **Saltar por ahora** (colapsa) y **X cerrar para siempre** → `pos_settings.onboarding_dismissed bool`.
- AFIP queda como banner futuro (F3), no en el checklist.

## Fase C — Creador dinámico de planes (/internal/planes)

### DB
- `features` (catálogo): `key text pk, label, description, grupo text, is_basic bool, sort int`. Seed con las funcionalidades reales del sistema (pos, caja, productos, stock, clientes, reportes, catálogo público, tickets PRO, email comprobantes, variantes, listas de precios, devoluciones, garantías, cuenta corriente, multi-sucursal*, api*, asistente IA…).
- `plans` ya tiene `limits jsonb` con `{limits:{max_*}, modules:{}, support:{}}` → la UI escribe `modules` como mapa `feature_key: bool`. Se agregan columnas: `icon text` (lucide key o emoji), `trial_days int not null default 14`, `sort int`.
- `plan_addons`: `id, plan_id null (null = todos), key text ('ai_assistant'), label, monthly_price_ars, is_active` — addons contratables.
- `subscription_addons`: `tenant_id, addon_key, status (active|cancelled), source (purchased|granted), provider_ref, created_at` — webhook MP materializa (patrón Food).

### UI `/internal/planes` (nav + página)
- Lista de planes globales (icono, nombre, precio, trial, activo, nº suscriptos) + **Nuevo plan**.
- Editor: ícono (picker lucide curado), nombre, descripción, precio mensual, **features con checkboxes agrupadas** (básicas preseleccionadas al crear), límites numéricos (sucursales, usuarios, productos, ventas/mes), **toggle trial + días**, addons disponibles.
- Editar precio de plan con suscriptos → dispara Fase E (aviso de aumento).
- Los planes custom por tenant (H12b) siguen gestionándose desde la ficha del tenant.
- Nombres default de los 3 niveles: a elección del usuario entre los sets propuestos (renombrables siempre).

## Fase D — Gating server-side + UX

- SQL: `tenant_has_feature(p_key text) returns boolean` (SECURITY INVOKER, usa current_tenant_id): orden de resolución → override en `tenant_feature_flags` → addon activo en `subscription_addons` → `plans.limits->modules->>key` del plan de la suscripción → `features.is_basic`. Y `tenant_limit(p_key)` → `limit_overrides ->> key` ?? `plans.limits->limits->>key`.
- Enforcement server-side en los RPCs/Edge Functions sensibles (create con límites: p.ej. alta de usuario miembro valida max_users; ticket_templates html/canvas si se gatean; asistente IA).
- Client: hook `useFeature(key)` + `useLimit(key)`; componente `<FeatureGate feature="x">` que renderiza children `disabled` + overlay sutil; al hover/tap → `UpgradeModal` glass: "Para usar esta función necesitás el plan {primer plan que la incluye}" + botón **Hacer upgrade** (link a checkout MP del plan).

## Fase E — Motor de cobros (dunning) y emails transaccionales

- **MP preapproval cobra solo**; nuestro motor CONCILIA y comunica (antifallas: idempotente, derivado de datos):
- `pg_cron` diario (`saas-dunning`, 05:23 UTC) → función `run_saas_dunning()`:
  - `current_period_end < now()` sin pago registrado → `past_due` + email "problema con tu cobro" + notificación in-app crítica.
  - `past_due` por más de `grace_days` (config en `platform_settings`, default 7) → `suspended` + email + notificación blocking.
  - Pago confirmado (webhook MP `authorized/approved`) → email "cobro exitoso + período renovado" (se agrega al webhook existente) + estado `active`.
  - Trial: faltan 3 días → email + in-app. Trial vencido sin conversión → según política actual (cancelled) + email.
  - Vencimiento en 3 días sin preapproval activo (sin medio de pago) → email urgente + in-app warning.
  - Cada envío queda en `system_emails` (bitácora) y cada transición en `audit_logs`. Idempotencia: tabla `dunning_events (tenant_id, kind, period_key unique)` para no repetir avisos.
- **Aumento de precio** (editar plan con suscriptos): al guardar → email a los owners afectados "tu tarifa pasa a $X desde el próximo ciclo" + notificación in-app `requires_ack` (ya existe la pieza para custom plans; se generaliza a planes globales).
- Plantillas nuevas en el catálogo de emails del sistema (editables en /internal/emails): `payment_ok`, `payment_failed`, `payment_reminder_3d`, `no_payment_method`, `trial_ending_3d`, `price_increase`.

## Fase F — Asistente IA (addon, beta)

- Config en `/internal/configuracion` (nueva página POS, paridad Food): card IA → proveedor (Gemini | Claude), API key (write-only, en `platform_secrets`), modelo, botón test. 
- Edge Function `ai_assistant`: POST {messages[]} →
  - Guard: usuario autenticado + (`subscription_addons.ai_assistant active` || `tenant_feature_flags.ai_assistant` || `user_id = <Lucas>` beta) — server-side estricto.
  - Contexto cerrado al POS: system prompt fijo (solo temas del sistema) + herramientas READ-ONLY scoped por tenant: ventas de hoy/semana, top productos, stock bajo, estado de config (ticket activo, MP, email), guía de pantallas (texto embebido). Nunca SQL libre; funciones predefinidas.
  - Límite de uso: `ai_usage (tenant_id, user_id, tokens, created_at)` + tope mensual por plan/addon.
- UI: burbuja flotante (abajo derecha, glass) visible solo si el guard pasa; chat con streaming simple (sin streaming v1: respuesta completa), historial en memoria de sesión.
- Addon vendible: entrada en `plan_addons` (`ai_assistant`, precio configurable) — checkout MP preapproval separado (patrón Food `addon:ai:<tenant>`) queda para una iteración 2; v1: activación manual desde internal (grant) + beta Lucas.

## Antifallas (principios transversales)

- Estados derivados de datos (onboarding, dunning) — nada que pueda desincronizarse.
- Webhook MP = fuente de verdad de pagos; el cron solo concilia y comunica; idempotencia por `dunning_events` y `provider_event_id`.
- Gating SIEMPRE server-side (SQL/Edge) + UI como cortesía.
- Todo evento crítico → `audit_logs`; todo email → `system_emails`.

## Estructura de componentes (resumen)

```
app/(auth)/signup/page.tsx          → SignupWizard (paso 1/2, glass)
components/auth/{ValuePanel,SignupStepAccount,SignupStepBusiness,GoogleButton}.tsx
components/dashboard/OnboardingChecklist.tsx (+ RPC onboarding_status)
app/internal/planes/page.tsx        → PlansManager + PlanEditorModal + FeatureMatrix
lib/saas/{features.ts,limits.ts}    → catálogos cliente
components/saas/{FeatureGate,UpgradeModal}.tsx + hooks useFeature/useLimit
supabase/functions/ai_assistant     + components/ai/AssistantBubble.tsx
migrations: features, plan columns, plan_addons, subscription_addons,
            dunning (fn + pg_cron + dunning_events), iva_condition, ai_usage
```
