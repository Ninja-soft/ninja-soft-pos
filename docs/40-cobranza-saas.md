# Cobranza SaaS: cómo NinjaSoft cobra, factura y gestiona la deuda de sus clientes

> **Estado:** diseño (2026-10-13). Ningún punto de este documento está construido salvo lo que figura en "Qué existe hoy". Decisión de arquitectura: [ADR-110](./17-decision-log.md). Hitos: F20 en [`02-roadmap.md`](./02-roadmap.md).
>
> **Alcance.** Es la cobranza de la **plataforma**: NinjaSoft le cobra la suscripción a cada negocio (tenant). No hay que confundirla con la cuenta corriente que un negocio le da a **sus** clientes (ADR-037, `customer_account_*`) ni con la facturación ARCA de las ventas del negocio (ADR-072, `fiscal_documents`). Este diseño reutiliza patrones y código de las dos, pero sus tablas son otras.
>
> **Notas normativas.** Las referencias a ARCA son orientativas. Antes de la fase F20-4 hay que validarlas con el contador de NinjaSoft (ver §16).

---

## Índice

1. [Qué pidió el dueño](#1-qué-pidió-el-dueño)
2. [Qué existe hoy (inventario)](#2-qué-existe-hoy-inventario)
3. [Principios de diseño](#3-principios-de-diseño)
4. [Mapa del dominio](#4-mapa-del-dominio)
5. [Ciclo de vida de la suscripción y del período](#5-ciclo-de-vida-de-la-suscripción-y-del-período)
6. [Modelo de datos](#6-modelo-de-datos)
7. [Comprobantes y facturación automática](#7-comprobantes-y-facturación-automática)
8. [Datos fiscales del cliente y verificación con ARCA](#8-datos-fiscales-del-cliente-y-verificación-con-arca)
9. [Medios de cobro y conciliación](#9-medios-de-cobro-y-conciliación)
10. [Cuenta corriente, punitorios, bonificaciones y promesas](#10-cuenta-corriente-punitorios-bonificaciones-y-promesas)
11. [Recordatorios, mora y suspensión](#11-recordatorios-mora-y-suspensión)
12. [Plantillas de factura y de email](#12-plantillas-de-factura-y-de-email)
13. [Edge Functions y crons](#13-edge-functions-y-crons)
14. [Pantallas](#14-pantallas)
15. [Dashboard interno: KPIs con definición exacta](#15-dashboard-interno-kpis-con-definición-exacta)
16. [Cumplimiento ARCA](#16-cumplimiento-arca)
17. [Casos borde](#17-casos-borde)
18. [Permisos del staff y auditoría](#18-permisos-del-staff-y-auditoría)
19. [Plan de entrega por fases](#19-plan-de-entrega-por-fases)
20. [Participación del staff y gastos (futuro, no construir aún)](#20-participación-del-staff-y-gastos-futuro-no-construir-aún)
21. [Preguntas abiertas para el dueño](#21-preguntas-abiertas-para-el-dueño)

---

## 1. Qué pidió el dueño

1. **Facturación automática del servicio**, que se pueda prender y apagar. Se factura cuando se cobra o se renueva la suscripción, en el momento o a los X días de recibido el pago. En su panel, el cliente elige a nombre de quién recibe la factura; la letra (A, B o C) sale de su condición fiscal. Si no completa nada, se usan los datos de la empresa. El CUIT se verifica contra el padrón de ARCA, que devuelve la razón social, la condición y el domicilio. El cliente recibe un email con plantilla y el PDF adjunto. La plantilla de la factura se configura desde el panel interno.
2. **Cobro por Mercado Pago bien configurado** y una pantalla "Pagos de plataforma" muy bien diseñada, con el logo oficial de Mercado Pago. Hoy son cinco campos de credenciales sueltos.
3. **Notas de crédito, notas de débito y suscripciones por cuenta corriente.** Hay que poder configurar:
   - cada cuánto se envía la factura para pagar;
   - a qué dirección se manda el comprobante de pago;
   - una plantilla con los datos bancarios para transferir.

   Sobre la deuda:
   - calcular y cobrar punitorios;
   - bonificar o saldar punitorios;
   - bonificar otros conceptos;
   - ver la historia del cliente.

   El pedido textual: "Mapeá todo lo que se pueda hacer y armalo con una robustez profunda".
4. **Participación del staff y gastos**: porcentaje de la facturación por persona y gastos recurrentes que se descuentan en proporción. **Va al roadmap como futuro y no se construye ahora** (§20).
5. **Dashboard interno**: hoy no se entiende, los KPI no se explican y tiene roturas. Esta spec define qué KPI mostrar y cómo calcularlos (§15).

---

## 2. Qué existe hoy (inventario)

Relevado en `main` (`884c1392`) el 2026-10-13.

### 2.1 Datos

| Pieza | Dónde | Qué hace | Limitación para este diseño |
|---|---|---|---|
| `subscriptions` (una por tenant) | `20260530120200_saas_catalog.sql` y siguientes | `plan_id`, `status` (`trial`, `active`, `past_due`, `suspended`, `cancelled`), `billing_cycle` mensual o anual, `current_period_start/end`, `cancel_at_period_end`, `mp_preapproval_id`, `limit_overrides`, `is_lifetime`, `past_due_since` | El estado está **duplicado** en `tenants.status` y el dunning tiene que mantener los dos |
| `plans` | `saas_catalog`, `custom_plans_overrides_discounts`, `plans_overhaul` | Precio mensual y anual en ARS (el anual vale `0` cuando no está cargado), límites, planes custom por tenant | No hay moneda ni historia de precios |
| `plan_addons` / `subscription_addons` | `20260608110000`, `20260608150000` | Addon `ai_assistant`, que puede ser comprado o regalado, con período propio | — |
| `billing_records` | `20260604200000_billing_records.sql` | Registro de pagos append-only: monto, medio (`mp`, `bank_transfer`, `cash`, `other`), período y `receipt_ref` | No es comprobante fiscal, no imputa contra una deuda y no guarda saldo |
| `tenant_discounts` | `20260607150000` | Descuento por porcentaje o fijo, con vigencia | **`subscription_billing_total` no lo aplica**: se guarda y no descuenta nada |
| `subscription_billing_total()` | `20260608700000_billing_math_fixes.sql` | Calcula el monto del preapproval: plan y addons; si el ciclo es anual usa `yearly` o, si no está cargado, `monthly × 12` | Ignora los descuentos |
| `platform_settings` | `20260608130000_saas_dunning.sql` | `grace_days` = 3 y `reminder_days` | No hay escalera configurable |
| `dunning_events` | ídem | Hace idempotentes los avisos, con la clave `(tenant, kind, period_key)` | — |
| `run_saas_dunning()` | `20260608420000_email_autosend.sql` (cron `saas-dunning` diario) | Pasa `active` vencida a `past_due`; `past_due` con más de 3 días a `suspended`; trial vencido a `cancelled`. Además manda los avisos | Escalera fija, sin promesas de pago y sin punitorios |
| `mp_webhook_events` | `20260608660000` | Deduplica los webhooks de billing | — |
| `platform_secrets` | `20260531120100` | Guarda `mercadopago` (client_id, client_secret, access_token, public_key, redirect_uri), `ai_config` e `internal_cron`. Sólo `service_role` | **No hay `webhook_secret` ni ambiente** |
| `arca_platform` / `arca_platform_tickets` | `20261101100100_arca_facturacion.sql` | CUIT y certificado de NinjaSoft por ambiente, pensados para el modo "delegado" del tenant | Vacío: **NinjaSoft todavía no tiene CUIT cargada** (ADR-072) |
| `fiscal_documents` | ídem | Cola fiscal de ventas del tenant | Exige `sale_id NOT NULL` y `origin` igual a `sale`, `return` o `void`: **no sirve para comprobantes de plataforma** |
| `system_email_templates`, `system_emails`, `email_providers` | `20260531040000`, `20260607200000`, `20260608150000` | Plantillas globales, cola con reintentos, Resend con un proveedor de respaldo | No hay adjuntos generados en el servidor |
| `audit_logs` | `20260530120300`, `20261106200000` (ADR-083) | Inmutable, con hash encadenado | — |

### 2.2 Edge Functions

- `mp_subscription_checkout`: crea el **preapproval** de Mercado Pago con la cuenta de NinjaSoft. Lo pueden llamar el staff o el dueño.
- `mp_billing_webhook`: público.
  - **No valida `x-signature`**. En cambio, vuelve a leer el recurso en Mercado Pago.
  - Según lo que lee, pasa la suscripción a `active`, `past_due` o `cancelled`, reancla el período, inserta en `billing_records`, audita y encola el email.
- `mp_subscription_manage`, `mp_subscription_pause`, `mp_update_subscription_amount`: completan el ciclo del preapproval (gestionar, pausar, actualizar el monto).
- `set_platform_secret`: guarda las credenciales de Mercado Pago de la plataforma.
- `arca_wsfe`: incluye `platform_set_cuit`, `platform_generar_csr` y `platform_subir_certificado`. La lógica de ARCA es reutilizable y vive en `_shared/arca/*`.
- **No hay** Edge de padrón ARCA (A5 o constancia de inscripción). `lib/tax/padron.ts` sólo lee archivos de padrones de IIBB.
- **No hay** generación de PDF en el servidor. Hoy los PDF se arman con jsPDF en el navegador.

### 2.3 Pantallas

- **Dueño:** `app/(app)/dashboard-team/page.tsx`, con `SubscriptionCard.tsx` (1087 líneas) y `PaymentHistory.tsx`. Los banners son `PastDueBanner` y `SuspendedGate`.
- **Interno** (está en `app/internal/*`, no en `app/(internal)`):
  - `/internal` es el dashboard.
  - `/internal/pagos` usa `PlatformMpCard`.
  - `/internal/arca` usa `ArcaPlatformCard`.
  - En el detalle del tenant están `BillingCard` (pagos manuales, trial y descuentos) y `PlanCard`.

### 2.4 Roturas observadas

**Dashboard** (captura del 2026-10-13, código en `app/internal/page.tsx`):

1. **Mezcla de fuentes.** Los conteos salen de `tenants.status`, pero el MRR y el churn salen de `subscriptions.status`.
2. **MRR mal calculado:**
   - es la suma de `plans.monthly_price_ars` de las suscripciones `active` o `past_due`;
   - si el ciclo es anual usa `mensual × 0,9` en lugar de `anual / 12`;
   - ignora los addons y los descuentos;
   - **cuenta las cuentas `is_lifetime`** y los negocios internos o de demo.

   En la captura, $ 880.000 de MRR corresponden a 4 negocios Enterprise que probablemente no pagan.
3. **"Conversión trial→paid"** se calcula como `activos / (activos + cancelados)`. Es una foto del estado actual, no una conversión, y por eso marca 100 % con 4 activos y 0 cancelados.
4. **"Churn 30d"** usa `updated_at` de las canceladas: cualquier UPDATE posterior mueve la fecha.
5. **"Con problemas: 0"** contradice el bloque "Negocios en riesgo", que muestra a Olimarket. Son dos definiciones distintas de "riesgo" sin explicar.
6. **Formato:** "ARR estimado $ 10.560.000,00" se sale de la tarjeta.
7. Ningún KPI explica qué mide ni contra qué período se compara.

**"Pagos de plataforma"** (captura del 2026-10-13):

1. El campo **Client ID tiene cargado un email** (`lucasponzoni@gmail.com`). El Client ID de Mercado Pago es numérico, así que el OAuth de los clientes no puede funcionar. Falta validar el formato.
2. Mezcla en una sola tarjeta dos cosas distintas:
   - la app OAuth, para que los negocios conecten **su** Mercado Pago;
   - la cuenta que **cobra** las suscripciones.
3. Faltan: el secreto del webhook, la URL del webhook para copiar, el ambiente (prueba o producción), "Probar credenciales", el estado de la conexión y los últimos eventos.
4. Hay un placeholder `https://tu-dominio/...` en lugar de la URL real calculada.

---

## 3. Principios de diseño

1. **El ledger es económico y los comprobantes son la capa fiscal.**
   - La cuenta corriente de cada negocio registra hechos económicos: cargo del período, punitorio, pago, bonificación, reintegro y contracargo.
   - Las facturas, notas de crédito y notas de débito **documentan** esos hechos ante ARCA, pero no los crean.
   - Así una factura atrasada o rechazada por ARCA nunca cambia lo que el cliente debe, y un pago nunca depende de que exista el CAE.
2. **Nada se edita, todo se revierte.** Un comprobante con CAE no se toca nunca; se corrige con una nota de crédito o de débito. Los movimientos se anulan con un movimiento inverso y `voided_at`; los datos de negocio usan baja lógica (CLAUDE.md §3.6).
3. **Idempotencia en cada borde.**
   - Un cargo por `(suscripción, período, tipo)`.
   - Un pago por `(proveedor, id externo)`.
   - Un comprobante por `(evento económico, tipo)`.
   - Un punitorio por `(deuda, mes)`.
   - Un aviso por `(negocio, paso de la escalera, deuda)`.
4. **La plata no espera a ARCA y ARCA no espera a la plata.** Facturar va siempre a una cola con reintentos y dead-letter, con el mismo patrón que ADR-072. Si ARCA está caído, se cobra igual.
5. **Plataforma ≠ negocio.**
   - Todas las tablas nuevas son de plataforma. El staff las lee y escribe con `(select internal_scope())`, nunca con `OR is_internal()` (ADR-052).
   - El negocio sólo ve lo suyo con `tenant_id = (select current_tenant_id())` y el rol de dueño o encargado. Escribe **sólo** por RPC `security definer`.
   - `service_role` sólo en Edge Functions.
6. **Todo lo configurable tiene default de plataforma y override por negocio.** La configuración efectiva es `negocio ?? plataforma`, igual que en ADR-037 y ADR-049.
7. **Auditoría antes de responder.** Toda acción de staff que mueve plata o emite un comprobante pide motivo y escribe en `audit_logs` (CLAUDE.md §3.3).
8. **No es una feature de plan.** La cobranza de la plataforma no entra en `features` ni en `plans.limits.modules`: es operación de NinjaSoft. Lo que ve el cliente (sus comprobantes, su estado de cuenta, pagar) es **BASE** de cualquier plan. La modalidad de cobro de cada negocio la decide el staff (§10.1), no el plan.
9. **Moneda ARS** en esta versión. Igual, cada tabla guarda `currency` para no cerrar la puerta.
10. **Importes en centavos** (`bigint`) en el ledger y en los comprobantes. Se acaban los redondeos de `numeric` con decimales libres, y ARCA recibe dos decimales exactos.

---

## 4. Mapa del dominio

```
                     ┌────────────────────────────── CONFIGURACIÓN ──────────────────────────────┐
                     │ Emisor (NinjaSoft: CUIT, condición, PV, certificado)  · Plantillas factura │
                     │ Política de punitorios · Escalera de mora · Cuentas bancarias · Emails     │
                     └────────────────────────────────────────────────────────────────────────────┘
                                                   │ defaults
          ┌─────────────────────────────── POR NEGOCIO ───────────────────────────────┐
          │ Suscripción (plan, addons, ciclo)   Condiciones de cobro (modalidad,       │
          │ Datos fiscales del receptor          vencimiento, envío, punitorios, etc.) │
          └───────────────────────────────────────────────────────────────────────────┘
                     │ cron de facturación (por período)
                     ▼
   ┌──────────┐  genera   ┌────────────────┐  documenta  ┌─────────────────────────────┐
   │ Período  │ ────────▶ │ CARGO (debe)    │ ──────────▶ │ FACTURA (cola ARCA → CAE)    │──▶ PDF ──▶ Email
   └──────────┘           └────────────────┘             └─────────────────────────────┘
                              ▲     ▲   ▲                       ▲            ▲
          punitorio diario ───┘     │   └─── ajuste / ND ───────┘            │
                                    │                                        │
   PAGO (haber) ── imputación ──────┘  MP preapproval · MP checkout · transferencia informada · manual
        │                                                                     │
        └──▶ RECIBO (no fiscal)                  BONIFICACIÓN / CONDONACIÓN ──┴──▶ NOTA DE CRÉDITO si lo bonificado ya estaba facturado
                                                                                   
   SALDO = Σ debe − Σ haber  →  aging  →  escalera de mora (aviso → banner → restricción → suspensión)
                                          ▲ pausada por PROMESA DE PAGO vigente
   TIMELINE del negocio = cargos + comprobantes + pagos + bonificaciones + promesas + avisos + notas + auditoría
```

### 4.1 Glosario del dominio

| Término | Definición |
|---|---|
| **Período** | El intervalo que paga una cuota: `[period_start, period_end)`. Mensual o anual. |
| **Cargo** (`platform_charges`) | Lo que se le pide pagar al negocio por un período, un prorrateo, un addon o algo puntual. Tiene líneas, vencimiento y estado de pago. Genera un movimiento al **debe**. |
| **Movimiento** (`platform_ledger`) | Una fila de la cuenta corriente: debe o haber, con tipo. El saldo es su suma. |
| **Imputación** (`platform_allocations`) | Cuánto de un pago (o bonificación) cancela qué deuda. |
| **Comprobante** (`platform_documents`) | Factura, NC o ND (fiscales, con CAE); recibo y aviso de cobro (no fiscales). |
| **Punitorio** | Interés por mora sobre la deuda vencida, según la política configurada. Se devenga en el ledger y se factura con ND al cobrarlo o al cierre del mes (§10.3). |
| **Bonificación** | Crédito que NinjaSoft da por decisión comercial: descuento en el próximo cargo, crédito a cuenta, meses sin cargo o condonación de un punitorio. |
| **Promesa de pago** | Compromiso del cliente de pagar un monto en una fecha. Mientras está vigente frena la escalera de mora. |
| **Modalidad de cobro** | Cómo paga el negocio: débito automático con Mercado Pago, cuenta corriente con aviso de cobro, manual o exento. |

---

## 5. Ciclo de vida de la suscripción y del período

### 5.1 Estados de la suscripción

Se mantienen los estados actuales y se agrega un subestado de cobranza, para no tocar el gating existente (`subscription_blocked`, `SuspendedGate`, `assert_account_active`).

| `subscriptions.status` | Significado | Acceso al POS |
|---|---|---|
| `trial` | Prueba sin cargo | Total |
| `active` | Al día o dentro del plazo de pago | Total |
| `past_due` | Tiene deuda vencida y está dentro de la escalera de mora | Total, con banner. Puede tener **restricción blanda** (§11) |
| `suspended` | Suspendida por mora o a mano | Sólo lectura (gate existente) |
| `cancelled` | Dada de baja | Sólo lectura por 90 días (doc 16 §9) |

Hay dos agregados nuevos.

`subscriptions.collection_state` es un derivado mantenido por el motor de mora:
- `al_dia`
- `por_vencer`
- `vencida`
- `en_promesa`
- `en_gestion` (se le asignó a una persona del staff)
- `incobrable`

**Deuda técnica a resolver en F20-2:** `tenants.status` pasa a ser un **espejo** escrito sólo por un trigger desde `subscriptions.status`. Hoy lo actualizan el dunning y las RPC por separado. Así el dashboard lee una sola fuente.

### 5.2 Ciclo de un período (cualquier modalidad)

```
 T-N días            T = period_start            T + plazo        T + plazo + gracia       ...
   │                     │                          │                    │
   ├─ cron genera CARGO ─┤                          │                    │
   │  (estado open)      │                          │                    │
   │                     ├─ MP: débito automático ──┤                    │
   │  CC: emite FACTURA  │  o el cliente paga       │                    │
   │  o AVISO DE COBRO   │                          │                    │
   │  con datos bancarios│                          ├─ vencido: escalera ┤─ punitorio diario
   │                     │                          │  de mora (§11)     │
   │                  PAGO ─▶ imputación ─▶ cargo paid ─▶ (MP) FACTURA programada (inmediata o +X días)
```

- **Modalidad Mercado Pago:**
  - El cargo se genera **cuando llega el pago** del preapproval: el webhook crea el cargo del período y el pago, los imputa y programa la factura.
  - Si el pago no llega en `period_start + 1 día`, el cron genera el cargo igual, con vencimiento `period_start`, para que la deuda exista y el motor de mora la vea.
  - Idempotencia: un cargo por `(suscripción, period_start, 'subscription_period')`. Gana quien llega primero (webhook o cron) y el otro lo reutiliza.
- **Modalidad cuenta corriente:**
  - El cron genera el cargo `lead_days` antes del inicio del período (config por negocio).
  - Según `invoice_timing`:
    - `on_charge`: emite la **factura con vencimiento de pago**;
    - `on_payment`: emite un **aviso de cobro** no fiscal con los datos bancarios.
  - Envía el email.
- **Manual:** igual que cuenta corriente, pero sin envío automático; el staff decide.
- **Exento** (lifetime, cortesía, negocios internos o de demo):
  - no se generan cargos;
  - no cuenta para el MRR (§15);
  - la cuenta se marca con `billing_mode = 'exempt'` y un motivo auditado. Las `is_lifetime` actuales migran a `exempt`.

### 5.3 Reanclaje del período

Se mantiene la regla vigente (`reanchor_subscription_period`): al pagar tarde, el período nuevo empieza en el **vencimiento anterior**, no en la fecha del pago. No se regalan días por pagar tarde. El cargo y la factura usan ese período como `FchServDesde` y `FchServHasta`.

---

## 6. Modelo de datos

Todo vive en `public`, con el prefijo `platform_` (de plataforma) o `tenant_billing_` (dato de plataforma sobre un negocio).

Convenciones de todas las tablas:
- PK `uuid`;
- `created_at` y `updated_at`;
- importes `bigint` en centavos;
- `currency text default 'ARS'`;
- baja lógica donde aplica;
- RLS activa y **sin políticas `FOR ALL`** (ADR-022).

### 6.1 Configuración de plataforma

**`platform_billing_settings`** (una sola fila, `id = true`). Absorbe y reemplaza a `platform_settings`, que queda como vista de compatibilidad.

| Columna | Tipo | Nota |
|---|---|---|
| `auto_invoice_enabled` | bool, default `false` | Interruptor general de la facturación automática |
| `invoice_timing_default` | `on_payment` \| `on_charge` | — |
| `invoice_delay_days_default` | int 0 a 10 | Factura a X días de recibido el pago (límite en §16.4) |
| `due_days_default` | int | Plazo de pago de la cuenta corriente |
| `charge_lead_days_default` | int | Días antes del período en que se genera el cargo y sale el aviso |
| `default_interest_policy_id` | uuid | — |
| `default_dunning_ladder_id` | uuid | — |
| `default_invoice_template_id` | uuid | — |
| `payment_proof_email` | text | Dirección a la que el cliente manda los comprobantes; además se pueden subir en el panel |
| `billing_reply_to` | text | — |
| `environment` | `homologacion` \| `produccion` | Ambiente ARCA de la plataforma |
| `issuer_pos_number` | int | Punto de venta exclusivo para facturar la suscripción (§16.1) |

**`platform_issuer_profile`** (una fila por ambiente). Los datos del emisor que salen en la factura:

| Columna | Nota |
|---|---|
| `cuit` | Debe coincidir con `arca_platform.cuit` del mismo ambiente |
| `razon_social`, `nombre_fantasia` | — |
| `condicion_iva_id` | 1 = RI, 6 = monotributo, 4 = exento. Define las letras posibles (§7.2) |
| `domicilio_comercial` | — |
| `iibb` | — |
| `inicio_actividades` | — |
| `logo_path` | — |

El certificado y la clave siguen en `arca_platform`, donde ya están modelados y cifrados (ADR-072). **Una diferencia importante:** hoy ese certificado está pensado para el modo "delegado", es decir, para que un negocio facture con la CUIT de NinjaSoft como representada. Acá NinjaSoft factura **por sí misma**. El certificado es el mismo y las autorizaciones de servicio son las suyas: `wsfe` y `ws_sr_constancia_inscripcion` (§8.2).

**`platform_bank_accounts`**: cuentas en las que NinjaSoft recibe transferencias.
- Columnas: `titular`, `cuit`, `banco`, `tipo` (`cbu` o `cvu`), `cbu_cvu`, `alias`, `moneda`, `is_default`, `is_active`, `deleted_at`.
- Si una cuenta tiene avisos emitidos, nunca se borra: se desactiva.
- **Validación del CBU:** 22 dígitos con los dos dígitos verificadores. El algoritmo va en `lib/billing/cbu.ts` y se testea.

**`platform_interest_policies`**:

| Columna | Nota |
|---|---|
| `name` | — |
| `monthly_rate_bp` | Tasa mensual en puntos básicos; 300 = 3 % |
| `grace_days` | Días desde el vencimiento antes de devengar |
| `method` | `daily_prorata` (tasa mensual / 30 por día) o `per_month_started` (mes empezado = mes entero) |
| `compounding` | bool, default `false`: interés simple sobre el capital vencido |
| `cap_bp` | Tope total sobre el capital original, por ejemplo 5000 = 50 % |
| `min_amount_cents` | Debajo de este monto no se liquida el mes |
| `bill_mode` | `on_collection` (ND al cobrar) o `monthly` (ND al cierre del mes) |
| `is_active` | — |

**`platform_dunning_ladders`** y **`platform_dunning_steps`**: la escalera de mora configurable (§11).
- Cada paso tiene: `offset_days` (relativo al vencimiento, puede ser negativo), `action`, `template_key`, `channel` (`email`, `in_app`, `whatsapp_link`, `staff_task`), `requires_no_promise` y `min_debt_cents`.
- Los valores de `action` son: `notify`, `banner`, `soft_restrict`, `suspend`, `assign_staff`, `mark_uncollectible`.

**`platform_invoice_templates`**: plantillas de factura versionadas (§12).

### 6.2 Por negocio

**`tenant_billing_terms`** (una fila por tenant; si no existe, se aplican los defaults):

| Columna | Nota |
|---|---|
| `billing_mode` | `mp_subscription` \| `account` (cuenta corriente) \| `manual` \| `exempt` |
| `exempt_reason` | Obligatorio si es `exempt` |
| `invoice_timing` | Override |
| `invoice_delay_days` | Override |
| `auto_invoice` | `inherit` \| `on` \| `off` |
| `due_days` | Override |
| `charge_lead_days` | Override |
| `statement_frequency` | `per_period` \| `monthly_day` \| `every_n_days`, con `statement_day` o `statement_every_days`. Define cada cuánto se envía el resumen o la factura para pagar |
| `send_to` | Array de emails (por defecto, el email del dueño) |
| `cc` | Array de emails |
| `interest_policy_id` | Override (o `null` = default) |
| `interest_enabled` | bool |
| `dunning_ladder_id` | Override |
| `credit_limit_cents` | Opcional; superarlo adelanta la escalera |
| `assigned_staff_id` | Cobrador responsable |
| `proration_policy` | `next_charge` (default) \| `immediate_checkout` (§17.4) |
| `invoice_partial` | bool, default `false` (§17.1) |
| `self_promise_enabled` | bool: el cliente puede cargar su promesa de pago (§10.5) |
| `notes` | — |

**`tenant_billing_profiles`**: a nombre de quién se factura. Lleva historia: se cierra la fila vieja con `valid_to` y se abre una nueva.

| Columna | Nota |
|---|---|
| `use_company_data` | bool. Si es `true` se toman los datos fiscales del negocio (`tenants`, configuración fiscal de ADR-068) |
| `doc_tipo` | 80 = CUIT, 86 = CUIL, 96 = DNI, 99 = consumidor final sin identificar |
| `doc_nro` | — |
| `razon_social` | — |
| `condicion_iva_id` | ID de ARCA (RG 5616) |
| `domicilio` | — |
| `email_facturacion` | — |
| `verification` | `padron` \| `manual` \| `none` |
| `verified_at` | — |
| `padron_snapshot` | jsonb: lo que devolvió ARCA |
| `padron_checked_at` | — |
| `valid_from`, `valid_to` | Un índice único parcial garantiza una sola fila abierta por tenant |
| `created_by` | — |

**`platform_fiscal_lookups`**: cache del padrón por CUIT (§8.2).
- Columnas: `cuit`, `environment`, `result`, `status` (`ok`, `no_encontrado`, `error`), `fetched_at`.
- Dura 30 días.
- Sólo `service_role` y staff.

### 6.3 Económico

**`platform_charges`**:

| Columna | Nota |
|---|---|
| `tenant_id`, `subscription_id` | — |
| `kind` | `subscription_period` \| `proration` \| `addon` \| `one_off` \| `interest` \| `adjustment` |
| `period_start`, `period_end` | — |
| `due_date` | — |
| `subtotal_cents`, `discount_cents`, `tax_cents`, `total_cents` | — |
| `status` | `open` \| `partially_paid` \| `paid` \| `voided` \| `written_off` |
| `idempotency_key` | Único. Por ejemplo `sub:{sub_id}:{period_start}:subscription_period` |
| `created_by` | `null` = sistema |
| `voided_at`, `void_reason` | — |

**`platform_charge_lines`**:
- Columnas: `charge_id`, `source` (`plan`, `addon`, `discount`, `bonus`, `proration_credit`, `proration_debit`, `interest`, `manual`), `description`, `qty`, `unit_cents`, `amount_cents`, `iva_rate_id` y `ref_id` (plan, addon o descuento).
- **El precio se congela en la línea.** Un cambio de precio posterior no reescribe cargos viejos.

**`platform_ledger`**: la cuenta corriente del negocio con NinjaSoft.

| Columna | Nota |
|---|---|
| `tenant_id` | — |
| `kind` | Debe: `charge`, `interest`, `adjustment_debit`, `refund`, `payment_reversal`. Haber: `payment`, `bonus_credit`, `interest_waiver`, `adjustment_credit`, `charge_void`. Además `opening_balance`, que puede ir al debe o al haber |
| `amount_cents` | CHECK de signo por `kind`: positivo = debe |
| `effective_date` | — |
| `charge_id`, `payment_id`, `document_id` | Opcionales |
| `parent_id` | Movimiento que revierte o al que se asocia |
| `reason` | Obligatorio en todos los manuales |
| `created_by` | — |
| `idempotency_key` | Único |
| `voided_at`, `voided_by` | — |

**`platform_allocations`** (mismo patrón que ADR-037):
- Columnas: `credit_movement_id` (pago o bonificación), `debit_movement_id` (cargo o punitorio), `amount_cents` y `released_at` (nunca DELETE).
- **Orden por defecto:** primero el punitorio más viejo, después los cargos por vencimiento (FIFO).
- El excedente queda como **saldo a favor** y se imputa solo al próximo cargo.

**`platform_payments`**: reemplaza a `billing_records`, que se migra con backfill y queda como vista de solo lectura.

| Columna | Nota |
|---|---|
| `tenant_id` | — |
| `method` | `mp_preapproval` \| `mp_checkout` \| `transfer` \| `cash` \| `other` |
| `status` | `pending_verification` \| `approved` \| `rejected` \| `refunded` \| `partially_refunded` \| `charged_back` \| `in_dispute` |
| `amount_cents` | — |
| `fee_cents`, `net_cents` | Comisión e importe neto de Mercado Pago, para conciliar |
| `paid_at` | — |
| `provider`, `external_id` | Único `(provider, external_id)` cuando no es null |
| `bank_account_id` | Destino de la transferencia |
| `payer_reference` | — |
| `proof_path` | Comprobante subido a Storage |
| `reported_by` | Usuario del tenant que informó el pago |
| `verified_by`, `verified_at`, `reject_reason` | — |
| `raw` | jsonb mínimo, sin datos de tarjeta |
| `idempotency_key` | — |

**`platform_promises`**:
- Columnas: `tenant_id`, `amount_cents`, `promised_date`, `status` (`open`, `kept`, `broken`, `cancelled`), `channel`, `note`, `created_by`, `resolved_at`.
- Una sola abierta por tenant.

**`platform_bonuses`**: bonificaciones por única vez sobre el próximo cargo (§10.4).
- Columnas: `tenant_id`, `kind` (`percent` o `fixed`), `value`, `applies_to` (`next_charge` o un `charge_id`), `status` (`pending_approval`, `pending`, `applied`, `cancelled`), `reason`, `created_by`, `approved_by` y `applied_charge_id`.

**`platform_holidays`**: feriados nacionales para correr vencimientos (§11.2). Columnas: `day` y `name`.

**`platform_collection_notes`**: gestiones de cobranza (llamada, WhatsApp, email manual).
- Columnas: `tenant_id`, `kind`, `body`, `next_action_at` y `created_by`.

### 6.4 Fiscal

**`platform_documents`**:

| Columna | Nota |
|---|---|
| `tenant_id` | — |
| `kind` | `invoice` \| `credit_note` \| `debit_note` \| `receipt` \| `payment_notice` |
| `fiscal` | bool: `true` para factura, NC y ND |
| `letter` | `A`, `B` o `C`. Para recibo y aviso queda `X` |
| `cbte_tipo` | 1/2/3, 6/7/8, 11/12/13 |
| `pto_vta`, `cbte_nro` | — |
| `environment` | — |
| `issue_date` | — |
| `service_from`, `service_to`, `payment_due` | Obligatorios con concepto 2 (servicios) |
| `concepto` | 2 |
| `receptor` | jsonb: snapshot congelado del perfil al emitir (doc, nombre, condición, domicilio) |
| `issuer` | jsonb: snapshot del emisor |
| `net_cents`, `iva_cents`, `exempt_cents`, `total_cents` | — |
| `iva_lines` | jsonb |
| `charge_id` | — |
| `ledger_movement_ids` | uuid[]: los hechos económicos que documenta |
| `assoc_document_id` | NC y ND: la factura asociada (`CbtesAsoc`) |
| `reason` | — |
| `status` | `draft` \| `scheduled` \| `pending` \| `sending` \| `approved` \| `rejected` \| `requires_action` \| `cancelled` |
| `scheduled_for` | Factura a los X días |
| `cae`, `cae_vto`, `qr_url` | — |
| `attempts`, `next_attempt_at`, `dead_letter_at`, `last_error` | — |
| `template_id`, `template_version` | — |
| `pdf_path`, `pdf_sha256` | — |
| `email_status` | `not_sent` \| `queued` \| `sent` \| `failed` |
| `emailed_at` | — |
| `idempotency_key` | Único |

Índices únicos:
- **Número autorizado:** `(environment, pto_vta, cbte_tipo, cbte_nro)` cuando el número no es null.
- **Un comprobante por evento:** `(idempotency_key)`.

Las claves de idempotencia son:
- `inv:{charge_id}`
- `nc:{movement_id}`
- `nd:{movement_id}`
- `rcp:{payment_id}`

Los recibos y avisos usan su propia numeración interna por tenant (`X-0001-00000001`), con advisory lock como el recibo de ADR-037.

**`platform_document_lines`**: copia de las líneas del cargo al emitir, congeladas.

**`platform_document_events`** (append-only): cada intento contra ARCA, con el request y el response **sin Token ni Sign**, el código y el mensaje. Es el mismo patrón que `fiscal_document_events`.

### 6.5 Métricas

**`platform_mrr_snapshots`**: una fila por día y suscripción.
- Columnas: `day`, `tenant_id`, `plan_key`, `status`, `billing_mode`, `mrr_cents`, `is_paying` y `exempt`.
- La escribe un cron diario. Las métricas de movimiento de MRR (nuevo, expansión, contracción, churn) salen de comparar dos días; sin esta tabla no hay forma honesta de calcularlas (§15).

### 6.6 RLS

| Tabla | Staff (`(select internal_scope())`) | Negocio (`tenant_id = (select current_tenant_id())`) | Escritura |
|---|---|---|---|
| `platform_billing_settings`, `platform_issuer_profile`, `platform_interest_policies`, `platform_dunning_*`, `platform_invoice_templates` | SELECT | — | RPC `internal_billing_*` (nivel según §18) |
| `platform_bank_accounts` | SELECT | Sólo las activas, por RPC `my_billing_bank_accounts()` (no hay SELECT directo) | RPC staff |
| `tenant_billing_terms` | SELECT | SELECT de su fila: dueño o encargado | RPC staff. El negocio sólo cambia `send_to` y `cc` con `owner_set_billing_contacts` |
| `tenant_billing_profiles` | SELECT | SELECT de sus filas: dueño o encargado | RPC `owner_set_billing_profile` (dueño) y `internal_set_billing_profile` |
| `platform_charges`, `_lines` | SELECT | SELECT: dueño o encargado | Sólo RPC o `service_role` |
| `platform_ledger`, `platform_allocations` | SELECT | Sin SELECT directo: `my_billing_statement()` arma el estado de cuenta | Sólo RPC o `service_role` |
| `platform_payments` | SELECT | SELECT de las propias, sin `raw` (vista `my_platform_payments`) | `owner_report_transfer` (sólo `pending_verification`) y webhook (`service_role`) |
| `platform_documents`, `_lines` | SELECT | SELECT de `approved`, `receipt` y `payment_notice`. Nunca los borradores | Sólo RPC o `service_role` |
| `platform_document_events`, `platform_fiscal_lookups`, `platform_mrr_snapshots` | SELECT | — | `service_role` |
| `platform_promises`, `platform_collection_notes` | SELECT | Promesas: sólo la abierta, por `my_billing_summary()`. Notas: nunca | RPC staff |

Además:
- Grants explícitos para el Data API: `revoke all` a `anon` y `grant select` a `authenticated` donde hay política (ver PR #311).
- `rls_internal_scope_leaks()` tiene que seguir dando 0 filas.

### 6.7 Storage

Dos buckets privados:
- `platform-documents`: los PDF de los comprobantes, con la ruta `{tenant_id}/{yyyy}/{document_id}.pdf`.
- `platform-payment-proofs`: los comprobantes de transferencia que sube el cliente. Límite de 10 MB y tipos `pdf`, `jpg`, `png` y `webp`.

Las políticas del bucket usan el primer segmento de la ruta como `tenant_id`. El negocio descarga con una URL firmada de 10 minutos que genera una RPC; el staff, con `internal_scope()`.

---

## 7. Comprobantes y facturación automática

### 7.1 Tipos de comprobante

| Comprobante | Fiscal | Cuándo se emite | Asociación |
|---|---|---|---|
| **Factura** | Sí (CAE) | Al cobrar (`on_payment`) o al generar el cargo (`on_charge`) | Cargo |
| **Nota de crédito** | Sí | Hay que reducir lo facturado: bonificación sobre algo facturado, condonación de un punitorio facturado, reintegro, baja con devolución, refacturación, corrección de importe | `CbtesAsoc` → factura o ND original |
| **Nota de débito** | Sí | Aumenta lo debido sin una factura que lo cubra: punitorios, ajuste de precio retroactivo acordado, gasto de gestión si se decide cobrarlo | `CbtesAsoc` → factura del cargo vencido |
| **Recibo** | No (X) | Cada pago aprobado o verificado | Pago e imputaciones |
| **Aviso de cobro** | No (X) | Cuenta corriente con `on_payment`: pide el pago con los datos bancarios antes de facturar | Cargo |

### 7.2 Letra del comprobante

La letra no la "elige" el cliente: sale de la condición del **emisor** y del **receptor**. En su panel, el cliente elige **a nombre de quién** se factura y ve qué letra le va a corresponder antes de guardar.

| Emisor (NinjaSoft) | Receptor | Letra |
|---|---|---|
| Responsable inscripto | Responsable inscripto | A |
| Responsable inscripto | Monotributista | A (RG 5003) |
| Responsable inscripto | Exento, consumidor final, no categorizado | B |
| Monotributista o exento | Cualquiera | C |

La lógica va en una función pura, `lib/billing/letter.ts`, testeada, con un espejo SQL `platform_cbte_letter(issuer_cond, receptor_cond)`. Es la misma idea que `arca_cbte_tipo` y `cbte_letter_infer`, y se reutiliza esa tabla de IDs.

**Pregunta abierta al dueño:** ¿cuál es la condición fiscal de NinjaSoft? Ver §21. Si es monotributo, todo sale C y la mitad de este punto no aplica hasta que cambie la condición.

### 7.3 Facturación automática

El interruptor tiene tres niveles: `platform_billing_settings.auto_invoice_enabled`, luego `tenant_billing_terms.auto_invoice` (`inherit`, `on` u `off`) y, por último, si la cuenta está exenta no se factura.

1. **Disparo.**
   - En `on_payment`, un trigger after insert/update en `platform_allocations` se dispara cuando un cargo queda `paid`.
   - En `on_charge`, se dispara al crear el cargo.
   - En los dos casos se llama a `platform_enqueue_invoice(charge_id)`, que es idempotente por `inv:{charge_id}`.
2. **Cuándo.** `scheduled_for = paid_at + invoice_delay_days`. Con 0 es inmediato. Mientras tanto, el comprobante queda `scheduled`.
   - **Para qué sirve el delay:** deja pasar la ventana en la que un pago de tarjeta puede revertirse en Mercado Pago antes de facturarlo.
   - **El límite:** el delay no puede llevar la fecha del comprobante fuera de la ventana de ARCA. Ver §16.4.
3. **Snapshot.**
   - Al pasar a `pending` se congelan el receptor (el perfil vigente en ese momento), el emisor, las líneas y la plantilla.
   - Si el cliente cambia sus datos **antes** de ese paso, la factura sale con los nuevos.
   - Si los cambia **después**, sale con los viejos y la corrección es por refacturación (§17.8).
4. **Worker.** Edge `platform_invoicing`, que reutiliza `_shared/arca/*` con el certificado de `arca_platform` y la CUIT de NinjaSoft como emisora (no delegada):
   - lease y un solo comprobante en vuelo por serie;
   - número guardado antes de mandar;
   - recuperación con `FECompUltimoAutorizado` y `FECompConsultar`;
   - backoff de 1 a 60 minutos;
   - dead-letter a los 10 intentos;
   - el error 10016 se reintenta a los 10 s.

   Todo sale de ADR-072 §1 a §4. **Sin CAEA en la plataforma:** facturar la suscripción no es urgente; si ARCA está caído, se espera.
5. **Bloqueos antes de mandar.** Pasan a `requires_action` con un mensaje claro:
   - no hay emisor configurado o el certificado está vencido;
   - falta el punto de venta;
   - es una factura A sin CUIT verificado;
   - la condición del receptor está vacía (RG 5616);
   - los importes no cierran;
   - la FCE MiPyME sería obligatoria (§16.6).
6. **Al aprobarse:** se renderiza el PDF (§12.1), se sube a Storage, se encola el email con el adjunto (§12.3) y se marca `email_status`.
7. **Reproceso.** `internal_platform_document_retry(id, reason)`. Si el comprobante todavía no tiene número, refresca el receptor desde el perfil actual. Queda auditado.
8. **Emisión manual.** El staff puede emitir sin esperar (`internal_issue_invoice_now`) o forzar la factura de un cargo de una cuenta con la automática apagada.

### 7.4 Montos e IVA

- Si NinjaSoft es RI, los precios de lista de `plans` **se interpretan con IVA incluido** (es lo que el cliente ve y paga hoy). La factura A discrimina `neto = total / 1,21` y el IVA se redondea por resto mayor para que cierre exacto. La B y la C llevan el total.
- **Pregunta abierta al dueño (§21):** ¿los precios publicados son finales (IVA incluido) o más IVA?
- Alícuota por defecto 21 % (servicio de software). Va configurable en el plan y el addon con `iva_rate_id`, por si el contador indica otra.

---

## 8. Datos fiscales del cliente y verificación con ARCA

### 8.1 Flujo en el panel del cliente

1. **"¿A nombre de quién querés tu factura?"**
   - Opción 1: **Los datos de mi negocio** (por defecto). Muestra lo que ya está cargado.
   - Opción 2: **Otro CUIT**: por ejemplo, la sociedad del dueño o un estudio contable.
   - Opción 3: **Consumidor final**. Sólo se ofrece si NinjaSoft es RI. Si NinjaSoft es monotributista sale C igual.
2. El cliente escribe el CUIT. Antes de llamar a nadie, se valida el dígito verificador con `isValidCuit` (`lib/tax/catalog.ts`).
3. Botón **"Buscar en ARCA"**. La Edge `platform_billing` (acción `padron_lookup`) consulta el padrón y devuelve la razón social, la condición frente al IVA, el domicilio fiscal y el estado de la CUIT (activa o no).
4. Se muestra lo que trajo ARCA, sin editar, y la **letra que le va a corresponder** ("Vas a recibir Factura A").
5. El cliente confirma.
   - El email de facturación se puede cambiar.
   - Si no hay respuesta de ARCA o la CUIT no figura, puede **cargar los datos a mano**. Quedan `verification = manual` y una marca visible para el staff.
   - **No se emite factura A con datos manuales:** queda `requires_action` hasta que el staff verifique.
6. Si el cliente no completa nada, se usan los datos de la empresa (el perfil fiscal del negocio de ADR-068). Si tampoco hay CUIT ahí, se factura a **consumidor final** (letra B o C, doc 99) y el panel muestra el aviso "Completá tus datos para recibir factura a nombre de tu empresa".

### 8.2 Servicio de padrón

- **Servicio:** `ws_sr_constancia_inscripcion`, que es el "padrón A5" (`getPersona_v2`). Es el que devuelve la condición frente al IVA y el monotributo (a través de `datosRegimenGeneral` y `datosMonotributo`) junto con el domicilio fiscal.
  - Alternativa evaluada: `ws_sr_padron_a13`. Da los datos de la persona, pero **no** la condición de IVA.
- **Autenticación:** el WSAA de siempre (`_shared/arca/wsaa`) con el certificado de NinjaSoft y `service = ws_sr_constancia_inscripcion`, con su propio ticket cacheado 12 h (`arca_platform_tickets` lleva una columna `service`). La CUIT de NinjaSoft tiene que tener **autorizado ese servicio** en el Administrador de Relaciones. Es un paso del checklist (§16.1).
- **Mapeo a `condicion_iva_id` (RG 5616):**
  - IVA activo (impuesto 30) → 1 (RI);
  - monotributo → 6;
  - IVA exento (impuesto 32) → 4;
  - sin IVA ni monotributo → 5 (consumidor final). En este último caso se avisa al cliente.

  Va en la función pura `lib/billing/padron.ts`, testeada con fixtures XML.
- **Cache:** 30 días en `platform_fiscal_lookups`. El staff tiene "Volver a consultar".
- **Rate limit:** 10 consultas por hora por tenant y 300 por hora en toda la plataforma (contador en `platform_fiscal_lookups` y `request_guard`).
- **Revalidación:** un cron mensual revisa los perfiles verificados con `padron_checked_at` de más de 180 días. Si la condición cambió (por ejemplo, de monotributo a RI), avisa al cliente y al staff. **No cambia la letra de facturas ya emitidas.**
- **Sin CUIT de NinjaSoft** (la situación de hoy):
  - la Edge responde `platform_not_configured`;
  - la UI ofrece la carga manual con el aviso "La verificación automática estará disponible pronto";
  - el staff ve la lista de perfiles sin verificar.

---

## 9. Medios de cobro y conciliación

### 9.1 Mercado Pago: débito automático (preapproval)

Es lo que existe hoy y se robustece en cinco puntos.

1. **Firma del webhook.**
   - Se valida `x-signature` (HMAC-SHA256 de `id:{data.id};request-id:{x-request-id};ts:{ts};` con el secreto de la app). Si no coincide, se descarta.
   - Hay que **seguir** releyendo el recurso con la API, como hoy.
   - El secreto va en `platform_secrets.mercadopago.webhook_secret`.
2. **Topic `payment`.**
   - Cada cobro del preapproval (`subscription_authorized_payment`) deriva en un `payment_id`. Se lee `/v1/payments/{id}` y de ahí salen `status`, `transaction_amount`, `fee_details` y `net_received_amount`.
   - Se upsertea `platform_payments` por `(mercadopago, payment_id)`, se crea o reutiliza el cargo del período y se imputa.
3. **Contracargos y devoluciones.** Los estados `refunded`, `charged_back` e `in_mediation` de un pago aprobado generan un movimiento `payment_reversal` y liberan las imputaciones (§17.3).
4. **Monto del preapproval** = `subscription_billing_total()` **con descuentos y bonificaciones vigentes**. El fix es que hoy ignora `tenant_discounts`.
   - Cuando cambia, `mp_update_subscription_amount` lo actualiza.
   - **Restricción de Mercado Pago:** el preapproval cobra un monto fijo por ciclo. Los prorrateos, punitorios y ajustes puntuales **no** van al preapproval: se cobran con un checkout único (§9.2) o se suman como línea al próximo cargo si el negocio lo permite (`proration_policy = next_charge`).
5. **Tarjeta rechazada.** El preapproval reintenta solo según la política de Mercado Pago. El motor de mora corre igual sobre el cargo `open` y el email "pago fallido" incluye el link para cambiar la tarjeta (`mp_subscription_manage`).

### 9.2 Mercado Pago: pago único (checkout)

La Edge nueva `platform_checkout` crea una preferencia de Checkout Pro por **el saldo vencido** o por un cargo puntual.
- `external_reference = pay:{tenant}:{nonce}`.
- Notificación a `mp_billing_webhook`.
- Expira a las 48 h.

Sirve para cuatro casos:
- cuentas corrientes que prefieren pagar con Mercado Pago;
- saldos de punitorios;
- prorrateos;
- reactivar una cuenta suspendida.

El botón **"Pagar ahora"** del panel del cliente usa esto.

### 9.3 Transferencia bancaria

1. El aviso de cobro y la factura `on_charge` llevan el bloque de datos bancarios (cuenta por defecto, o la asignada al negocio): titular, CUIT, banco, CBU o CVU, alias, monto y referencia sugerida `NS-{slug}-{nro}`.
2. El cliente **informa el pago** de dos maneras:
   - en el panel: "Ya transferí" → monto, fecha, cuenta de destino y archivo del comprobante. Se crea `platform_payments` en `pending_verification`;
   - o mandándolo a `payment_proof_email`. En ese caso el staff lo carga a mano.
3. **Verificación del staff** en `/internal/cobranza/pagos-a-verificar`. Hay dos acciones:
   - **Aprobar:** imputa y emite el recibo y, según la configuración, la factura.
   - **Rechazar:** pide un motivo y se le avisa al cliente.

   Mientras esté pendiente, el pago **no** frena la escalera, salvo que el staff lo marque como "promesa".
4. **Fase futura:** si la cuenta de cobro es un CVU de Mercado Pago, se puede reutilizar la detección automática de transferencias de ADR-061 y ADR-099, adaptada a la cuenta de la plataforma.

### 9.4 Manual

El staff registra efectivo, cheque u otro medio. Es la evolución del "Registrar pago" actual de `BillingCard`. Pide fecha, medio, monto, referencia e imputación (automática o elegida), y emite el recibo.

### 9.5 Conciliación

- **Mercado Pago** (cron diario `platform-mp-reconcile`). Busca en `/v1/payments/search` los pagos de las últimas 72 h de la cuenta de NinjaSoft y los cruza con `platform_payments`. Detecta cuatro casos:
  - **pagado en MP y ausente acá:** un webhook perdido. Lo crea con la misma lógica idempotente;
  - **aprobado acá y con otro estado en MP:** registra la reversa;
  - **montos distintos:** alerta;
  - **pagos duplicados del mismo período** (§17.2).
- **Bandeja de conciliación interna:** lista las diferencias con una acción por fila (aceptar o ignorar con motivo).
- **Comisiones:** `fee_cents` y `net_cents` muestran el ingreso neto por mes. Lo usan los KPI y, a futuro, la participación del staff (§20).

---

## 10. Cuenta corriente, punitorios, bonificaciones y promesas

### 10.1 Modalidades por negocio

| Modalidad | Para quién | Cómo se cobra | Factura |
|---|---|---|---|
| `mp_subscription` | Default de los altas self-serve | Débito automático con preapproval | Al cobrar (+X días) |
| `account` | Empresas, cadenas, clientes que pagan por transferencia o con orden de pago | Aviso o factura cada `statement_frequency`, con vencimiento a `due_days`; paga por transferencia o checkout | `on_charge` (factura con vencimiento) o `on_payment` (aviso de cobro y luego factura) |
| `manual` | Casos especiales | El staff genera y envía | A elección |
| `exempt` | Lifetime, cortesía, internos, demo | No hay cargos | No hay |

**Cambiar de modalidad** pide nivel admin y motivo, y queda auditado. Al pasar de `mp_subscription` a otra modalidad se **pausa el preapproval** para que no cobre doble.

### 10.2 Estado de cuenta

`my_billing_statement(from, to)` para el negocio e `internal_billing_statement(tenant, from, to)` para el staff devuelven:

- **saldo inicial**, **movimientos** (fecha, concepto, debe, haber, saldo, comprobante asociado con link al PDF) y **saldo final**;
- **saldo vencido**, **saldo a vencer**, **saldo a favor** y **punitorios devengados no facturados**;
- **aging**: 0 a 30, 31 a 60, 61 a 90 y más de 90 días.

El PDF del estado de cuenta usa la misma plantilla (§12) y se manda con `statement_frequency` si el negocio lo pide.

### 10.3 Punitorios

**Cálculo.** El cron `platform-interest` corre a diario a las 06:30 ART. Para cada movimiento al debe vencido con saldo:

```
dias_mora    = hoy − (due_date + grace_days)            (si ≤ 0, nada)
capital      = saldo pendiente del cargo (sin punitorios) al cierre del día
tasa_diaria  = monthly_rate_bp / 10000 / 30
daily_prorata:       interés_día = capital × tasa_diaria
per_month_started:   interés_mes = capital × monthly_rate_bp / 10000 por cada mes empezado
tope         = capital_original × cap_bp / 10000 − punitorios ya devengados del cargo
```

**Registro.**
- Se lleva **un movimiento `interest` por cargo y por mes calendario**, actualizado con un upsert idempotente por `(parent_id, period)` y `accrued_through`, igual que el addendum de ADR-037.
- Las corridas atrasadas se ponen al día sin duplicar.
- Debajo de `min_amount_cents`, el mes no se liquida y el importe pasa al siguiente.

**Aclaración:** a diferencia de ADR-037, acá el capital se recalcula **por día** con el saldo de ese día. Así un pago parcial a mitad de mes baja el interés de los días que siguen. La función pura `lib/billing/interest.ts` se escribe con TDD.

**Facturación del punitorio** (`bill_mode`):
- `on_collection` (recomendado): cuando un pago se imputa a un movimiento `interest`, se encola una **ND** por lo imputado, asociada a la factura del cargo que generó la mora. Así nunca se factura un interés que después se condona.
- `monthly`: al cierre del mes, una ND por todos los punitorios devengados en el mes. Si después se condona, va NC.

**Condonar o bonificar punitorios** (`internal_waive_interest(tenant, movement_ids | 'all', amount_cents | null, reason)`):
- La condonación puede ser **total o parcial**.
- Crea un `interest_waiver` (haber) imputado al punitorio.
- Si ese punitorio ya tenía ND aprobada, encola la **NC** asociada a la ND.
- Pide motivo. Hay un tope por nivel (§18). Queda auditado con antes y después.
- **"Saldar punitorios"** = condonar todo lo devengado de un negocio en una acción, con vista previa del monto.

**Suspender el devengamiento** de un negocio (por ejemplo, por un reclamo en curso): `tenant_billing_terms.interest_enabled = false`, con motivo y fecha. Sólo corta hacia adelante.

### 10.4 Bonificaciones y descuentos

| Tipo | Cómo se aplica | Comprobante |
|---|---|---|
| **Descuento recurrente** (el `tenant_discounts` actual, % o fijo, con vigencia) | Línea `discount` negativa en cada cargo del período vigente; baja el monto del preapproval | Va dentro de la misma factura (neto reducido). Sin NC |
| **Bonificación sobre el próximo cargo** (una vez) | `platform_bonuses` (nuevo, `pending` → `applied`): se aplica como línea en el próximo cargo | Dentro de la factura |
| **Crédito a cuenta** (bonificar algo ya cobrado o facturado) | `bonus_credit` en el ledger, imputado o como saldo a favor | **NC** asociada a la factura bonificada, por el monto |
| **Meses sin cargo** | El cargo se genera con línea `bonus` del 100 % (total 0), para que quede la historia | No se factura un total 0. Se registra un aviso interno |
| **Condonación de deuda** (incobrable o acuerdo) | `adjustment_credit` con motivo; cargo `written_off` | NC si estaba facturado |

Todas piden **motivo** y respetan los **topes por nivel** del staff. Las que superan el tope quedan en `pending_approval` hasta que las aprueba un super_admin. Todas quedan en el timeline.

### 10.5 Promesas de pago

- Las cargan el staff (o el cliente desde el panel, con "Voy a pagar el día…", si se habilita). Llevan monto y fecha, con un máximo de 15 días.
- Mientras la promesa está `open`, la escalera **no avanza** a los pasos marcados `requires_no_promise` (restricción y suspensión). Los avisos siguen saliendo con un tono distinto.
- Si al día siguiente de `promised_date` lo imputado desde la creación es ≥ el monto, la promesa queda `kept`. Si no, queda `broken`: la escalera retoma desde donde estaba (no reinicia) y se le avisa al cobrador asignado.
- Si un negocio rompe 2 promesas en 90 días, ya no puede cargar promesas por su cuenta.

### 10.6 Historia del cliente (timeline)

La RPC `internal_billing_timeline(tenant, filtros)` une en orden cronológico:
- cargos;
- comprobantes (con estado fiscal y de email);
- pagos (con su verificación);
- imputaciones;
- punitorios y condonaciones;
- bonificaciones;
- promesas;
- pasos de la escalera ejecutados;
- notas de gestión;
- cambios de plan y de modalidad;
- eventos de `audit_logs` de las categorías "Plan y facturación" y "Ciclo de vida".

Cada fila muestra el ícono, el texto en lenguaje humano, el actor ("Sistema" o la persona), el monto y un link.

El negocio ve una versión reducida (cargos, comprobantes, pagos y bonificaciones) en "Historial de pagos", que reemplaza a `my_payment_history`.

---

## 11. Recordatorios, mora y suspensión

### 11.1 Escalera por defecto (configurable)

Es la que reemplaza al dunning fijo de 3 días. Los días se cuentan desde el **vencimiento del cargo**.

| Día | Acción | Canal | Frena con promesa |
|---|---|---|---|
| −5 | Aviso "tu cuota vence el …" (sólo cuenta corriente; en MP sólo si la tarjeta vence antes) | email + in-app | — |
| 0 | Vencimiento: "vence hoy", con link de pago y datos bancarios | email | — |
| +1 | `active` → `past_due`; banner en el POS; email "pago pendiente" | email + in-app + banner | — |
| +3 | Recordatorio con el monto actualizado (con punitorios si hay) | email + link de WhatsApp para el staff | — |
| +7 | **Restricción blanda**: el POS vende, pero el panel del dueño muestra un bloqueo parcial (reportes y configuración con overlay "regularizá tu cuenta"); tarea al cobrador | in-app + tarea | Sí |
| +10 | **Suspensión** (`suspended`, `SuspendedGate`), con aviso 48 h antes | email + in-app | Sí |
| +30 | Email "tu cuenta será dada de baja"; tarea de gestión final | email + tarea | Sí |
| +60 | Marcar `incobrable` (no da de baja sola; la baja la confirma el staff, doc 16 §8) | tarea | Sí |

**Nota:** hoy un negocio queda suspendido a los 3 días de mora, sin pasos intermedios. La propuesta suaviza la suspensión a +10. Es decisión del dueño (§21).

### 11.2 Reglas

- La escalera se evalúa **por negocio con la deuda vencida más vieja**, no por cargo. Así un negocio con tres cargos vencidos no recibe tres emails.
- **Idempotencia** por `(tenant, step_id, oldest_due_charge_id)` en `dunning_events`, que ya existe y se extiende con `step_id`.
- Si el saldo vencido es menor a `min_debt_cents` (por ejemplo, centavos de redondeo), no se avanza.
- **Al pagar todo lo vencido:** `suspended` o `past_due` → `active`, con reanclaje del período (§5.3), email "pago recibido" y fin de la restricción. Hoy esto ya ocurre en el webhook; acá se generaliza a cualquier pago imputado.
- **Pago parcial:** baja el saldo pero no levanta la suspensión mientras quede algo vencido. Hay una excepción: el staff puede **reactivar con motivo** (una "reactivación de confianza", válida por N días).
- **Feriados y fines de semana:** si el vencimiento cae en un día no hábil, el vencimiento efectivo es el próximo hábil. Se usa `platform_holidays`, una tabla simple editable desde internal.

---

## 12. Plantillas de factura y de email

### 12.1 Plantilla de factura (PDF)

**Decisión: el PDF se genera en el servidor**, con `pdf-lib` en Deno (Edge `platform_billing`, acción `render_pdf`), a partir de una **plantilla estructurada**. No se usa HTML libre.

Por qué:
- HTML a PDF necesita un Chrome headless, que no corre en Edge Functions.
- El PDF tiene que poder rearmarse idéntico desde el comprobante, que es inmutable.
- jsPDF en el navegador no sirve para el envío automático.

`platform_invoice_templates`:
- Columnas: `name`, `kind` (`invoice_family`, `receipt`, `payment_notice`, `statement`), `version`, `config` (jsonb validado con Zod y con un CHECK de claves), `is_default`, `published_at` y `created_by`.
- **Cada versión publicada es inmutable.** Editar crea una versión nueva y cada comprobante guarda `template_id` y `template_version`.

Lo que se configura en `config`:
- **Marca:** logo (Storage), color de acento, tipografía (Inter o la de sistema) y tamaño de página A4.
- **Encabezado:**
  - los datos del emisor salen de `platform_issuer_profile` y no se editan acá;
  - se puede mostrar u ocultar el nombre de fantasía;
  - se puede sumar un texto extra.
- **Bloques visibles** y su orden:
  - período de servicio;
  - detalle de líneas (descripción, cantidad, precio, subtotal);
  - desglose de IVA (sólo en la A);
  - leyendas;
  - datos bancarios: una cuenta específica o la de por defecto, sólo en facturas `on_charge` y avisos;
  - QR fiscal (siempre en los fiscales);
  - CAE y vencimiento (siempre);
  - "Cómo pagar" con link al checkout.
- **Leyendas legales y comerciales** con variables:
  - `{{periodo}}`
  - `{{vencimiento}}`
  - `{{negocio}}`
  - `{{saldo_anterior}}`
  - `{{link_pago}}`
- **Pie:** web, email de soporte y teléfono.

**Bloques obligatorios.** Lo fiscal obligatorio no se puede ocultar: letra con su código, número, fecha, CUIT de las partes, condiciones, CAE, vencimiento del CAE y QR (RG 4892). La validación está en el server y en el editor.

**Editor en `/internal/facturacion/plantillas`:**
- formulario a la izquierda y **vista previa en vivo** a la derecha, con un comprobante de ejemplo o uno real elegido;
- "Descargar PDF de prueba";
- "Publicar versión";
- historial de versiones con diff de config.

### 12.2 Formato del PDF (contenido mínimo de la factura)

```
┌─────────────────────────────────────────────────────────────────────┐
│ [LOGO NinjaSoft]            ┌───┐            FACTURA                 │
│ Razón social emisor         │ A │ Cód. 01    N° 00005-00000123       │
│ Domicilio · CUIT · IIBB     └───┘            Fecha: 13/10/2026       │
│ Cond. IVA · Inicio act.                       Pto. venta 00005       │
├─────────────────────────────────────────────────────────────────────┤
│ Cliente: Razón social · CUIT · Cond. IVA · Domicilio                 │
│ Período: 01/10/2026 al 31/10/2026 · Vto. pago: 10/10/2026            │
├─────────────────────────────────────────────────────────────────────┤
│ Descripción                        Cant.   P. unit.     Subtotal     │
│ Plan Pro · mensual (oct 2026)      1       $ 45.000     $ 45.000     │
│ Asistente IA · mensual             1       $ 15.000     $ 15.000     │
│ Bonificación comercial 10 %                            −$ 6.000      │
├─────────────────────────────────────────────────────────────────────┤
│ Neto gravado $ 44.628,10 · IVA 21 % $ 9.371,90 · TOTAL $ 54.000,00   │
├─────────────────────────────────────────────────────────────────────┤
│ [QR]  CAE 7xxxxxxxxxxxxx · Vto. CAE 23/10/2026                       │
│ Datos para transferir (si aplica) · Leyendas · Pie                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 12.3 Emails

Hay plantillas nuevas en `system_email_templates`, con el diseño de NinjaSoft de la migración `emails_diseno_ninja_soft`, editables en `/internal/emails` con vista previa:

| Clave | Cuándo | Adjunto |
|---|---|---|
| `platform_invoice_issued` | Factura aprobada | PDF |
| `platform_credit_note_issued` | NC aprobada | PDF |
| `platform_debit_note_issued` | ND aprobada | PDF |
| `platform_payment_receipt` | Pago aprobado o verificado | PDF del recibo (y de la factura si salió junta) |
| `platform_payment_notice` | Aviso de cobro (cuenta corriente) | PDF con datos bancarios |
| `platform_statement` | Resumen periódico | PDF del estado de cuenta |
| `platform_transfer_received` | El cliente informó una transferencia | — |
| `platform_transfer_rejected` | El staff rechazó el comprobante | — |
| `platform_dunning_step_{n}` | Cada paso de la escalera (reemplaza `payment_reminder` / `payment_failed`) | — |
| `platform_promise_confirmed` / `platform_promise_broken` | Promesas | — |
| `platform_interest_waived` | Condonación | NC si hubo |

**Adjuntos.**
- `system_emails` suma `attachments jsonb`: una lista de `{storage_path, filename}`.
- `process_pending_emails` los baja de Storage con `service_role` y los manda por Resend (campo `attachments` en base64) o por SMTP.
- Límite de 5 MB por email. Si se pasa, va un link firmado de 7 días en lugar del adjunto.

**Destinatarios:** `tenant_billing_terms.send_to` y `cc`. Si no hay, el email del dueño. El `reply_to` es `platform_billing_settings.billing_reply_to`.

---

## 13. Edge Functions y crons

### 13.1 Edge Functions

| Edge | verify_jwt | Acciones | Quién |
|---|---|---|---|
| `platform_billing` | true | `padron_lookup`, `render_pdf`, `document_url`, `report_transfer` (sube el comprobante y crea el pago pendiente), `issue_now`, `retry`, `preview_template` | Dueño (lookup, report, url) y staff (el resto). Valida el rol en cada acción |
| `platform_invoicing` | false (cron con `X-Cron-Secret`) y true (staff) | Worker de la cola fiscal de plataforma: `claim` → WSFE → `apply_result` → PDF → email | Cron cada minuto, sólo si `platform_invoicing_due()` |
| `platform_checkout` | true | Crea la preferencia de pago único por saldo o cargo | Dueño y staff |
| `mp_billing_webhook` (existente) | false | + `x-signature`, topic `payment`, reversas, `platform_payments` e imputación | Mercado Pago |
| `mp_subscription_checkout` (existente) | true | Usa el total con descuentos; no crea un preapproval si la modalidad no es `mp_subscription` | Dueño y staff |
| `set_platform_secret` (existente) | true | + `webhook_secret`, `environment` (`sandbox` o `produccion`), acción `test` (llama a `/users/me` con el token y devuelve nickname, id y si es cuenta de prueba) | super_admin |

### 13.2 Crons (pg_cron + pg_net, con `X-Cron-Secret`)

| Job | Frecuencia | Qué hace |
|---|---|---|
| `platform-billing-run` | cada hora | Genera los cargos de los períodos que entran en `charge_lead_days` y los avisos de cuenta corriente. Pasa a `pending` los comprobantes `scheduled` vencidos. Idempotente |
| `platform-invoicing` | cada minuto (sólo si hay algo para hacer) | Worker fiscal |
| `platform-interest` | diario, 06:30 ART | Devenga los punitorios |
| `platform-dunning` | diario, 09:00 ART | Escalera de mora y promesas vencidas. **Reemplaza a `saas-dunning`**, que se desprograma en la misma migración |
| `platform-mp-reconcile` | diario, 04:00 ART | Conciliación con Mercado Pago |
| `platform-mrr-snapshot` | diario, 00:10 ART | Foto del MRR por suscripción |
| `platform-padron-refresh` | mensual | Revalidación de perfiles verificados |
| `dispatch-system-emails` (existente) | 5 min | Ahora con adjuntos |

---

## 14. Pantallas

Hay que cumplir el gate de diseño (`26-design-structure-control.md`) y el tema `ninja-dark`. Los logos de Mercado Pago son los **oficiales** que ya están en el repo: `lib/payments/logos.ts` y `public/images/payments/mercado-pago-wordmark-on-dark.webp`, más el ícono.

### 14.1 Navegación interna nueva

Se agrega el grupo **Cobranza** a la barra del panel interno:

```
Cobranza
├── Resumen            /internal/cobranza                 (KPIs de cobro, deuda, aging, cola fiscal)
├── Clientes           /internal/cobranza/clientes        (lista con saldo, vencido, modalidad, próximo paso)
├── Pagos a verificar  /internal/cobranza/pagos           (transferencias informadas; badge con cantidad)
├── Comprobantes       /internal/cobranza/comprobantes    (todas las facturas/NC/ND con estado fiscal y email)
├── Conciliación       /internal/cobranza/conciliacion
└── Configuración      /internal/cobranza/configuracion   (emisor, ARCA, facturación automática, punitorios,
                                                            escalera, cuentas bancarias, plantillas)
Pagos de plataforma    /internal/pagos                    (rediseño §14.2)
```

### 14.2 "Pagos de plataforma" rediseñada

```
┌─ COBROS ─────────────────────────────────────────────────────────────────────────┐
│ [logo MP oficial]  Cobro de suscripciones con Mercado Pago                        │
│ Así cobra NinjaSoft a sus clientes. Dos piezas: tu cuenta que cobra y la app       │
│ que permite a los negocios conectar su propio Mercado Pago.                       │
├──────────────────────────────────────────────────────────────────────────────────┤
│ ESTADO                                                                            │
│ ● Conectado en PRODUCCIÓN · Cuenta: NINJASOFT (id 123456789) · probado hace 2 h   │
│ ● Webhook: último evento hace 14 min · 0 fallidos (24 h) · [Ver eventos]          │
│ ● 37 suscripciones activas en MP · próximo débito: 15/10 (12 negocios)            │
│ [Probar conexión]                                       Ambiente: (Producción ▾)  │
├───────────────────────────────┬──────────────────────────────────────────────────┤
│ 1 · CUENTA QUE COBRA           │ 2 · APP PARA CONECTAR NEGOCIOS (OAuth)           │
│ Access Token   APP_USR-…a91f ✓ │ Client ID     6150…  (sólo números) ✓            │
│ Public Key     APP_USR-…77c2 ✓ │ Client Secret ••••••••  [Reemplazar]             │
│ [Reemplazar]                   │ Redirect URI  https://app.ninjasoft…/callback    │
│ Se usa para: débitos           │               [Copiar] (se calcula, no se tipea) │
│ automáticos, pagos únicos y    │ Se usa para: botón "Conectar con Mercado Pago"   │
│ conciliación.                  │ de cada negocio.                                 │
├───────────────────────────────┴──────────────────────────────────────────────────┤
│ 3 · NOTIFICACIONES (webhook)                                                      │
│ URL para pegar en Mercado Pago › Tus integraciones › Webhooks:                    │
│ https://<proyecto>.supabase.co/functions/v1/mp_billing_webhook   [Copiar]         │
│ Eventos a marcar: Pagos · Planes y suscripciones · Contracargos                   │
│ Clave secreta de firma  ••••••••  [Reemplazar]   ✓ firma verificada en el último  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 4 · CHECKLIST    ✓ token válido  ✓ client id numérico  ✓ webhook con firma         │
│                  ✗ cuenta en modo prueba  → [Cómo pasar a producción]              │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Reglas:
- Los secretos nunca vuelven al navegador: se muestran los últimos 4 caracteres y "Reemplazar" abre un modal.
- Se validan los formatos:
  - el Access Token empieza con `APP_USR-` o `TEST-` y tiene que coincidir con el ambiente;
  - el Client ID es numérico.
- "Probar conexión" llama a `/users/me` y muestra el nickname, si es cuenta de prueba y el país.
- Todo cambio queda auditado (`platform_secret_set`, sin el valor).

### 14.3 Cobranza › Clientes (lista)

```
Buscar…  [Modalidad ▾] [Estado cobro ▾] [Cobrador ▾] [Con promesa] [Sin datos fiscales]   [Exportar XLSX]
┌──────────────┬───────────┬──────────┬──────────┬──────────┬────────────┬─────────────────┐
│ Negocio      │ Modalidad │ Saldo    │ Vencido  │ Días mora│ Próx. paso │ Cobrador        │
│ Olimarket    │ CC        │ $ 98.000 │ $ 54.000 │ 12       │ Suspender 14/10 │ Ana        │
│ Kiosco Sol   │ MP        │ $ 0      │ —        │ —        │ Débito 15/10    │ —          │
└──────────────┴───────────┴──────────┴──────────┴──────────┴────────────┴─────────────────┘
Orden por defecto: días de mora desc. Totales al pie.
```

### 14.4 Ficha de cobranza del negocio (pestaña "Cobranza" del detalle del tenant)

Reemplaza a `BillingCard`.

```
┌ Resumen ────────────────────────────────────────────────────────────────────────┐
│ Saldo $ 98.000 · Vencido $ 54.000 (12 días) · A favor $ 0 · Punitorios $ 2.160    │
│ Modalidad: Cuenta corriente · vence a 10 días · resumen el día 1 · Cobrador: Ana  │
│ Factura a: ACME SRL · CUIT 30-… · RI · ✓ verificado ARCA 02/10 → Factura A        │
│ [Registrar pago] [Bonificar] [Condonar punitorios] [Promesa de pago] [Nota]       │
│ [Emitir NC] [Emitir ND] [Enviar estado de cuenta] [Cambiar condiciones]           │
├ Estado de cuenta (movimientos con saldo corrido y links a PDF) ──────────────────┤
├ Comprobantes (estado fiscal · email · reintentar · descargar) ────────────────────┤
├ Timeline (filtros: todo / plata / comprobantes / gestiones / sistema) ────────────┤
└──────────────────────────────────────────────────────────────────────────────────┘
```

Cada acción abre un modal con:
- vista previa del efecto: "Saldo pasa de $ 98.000 a $ 96.000 · Se emitirá NC B por $ 2.000 asociada a FC B 0005-00000120";
- motivo obligatorio;
- confirmación.

### 14.5 Panel del cliente: "Facturación y pagos" (`/dashboard-team`, pestaña nueva)

Se divide el `SubscriptionCard` actual: el plan sigue en "Plan" y la plata pasa acá.

```
┌ Tu cuenta con NinjaSoft ─────────────────────────────────────────────────────────┐
│ Estás al día ✓   (o)   Tenés $ 54.000 vencidos desde el 01/10  [Pagar ahora]       │
│ Próximo cobro: $ 54.000 el 01/11 · Débito automático con Visa ••4242 [Cambiar]     │
├ Datos de facturación ────────────────────────────────────────────────────────────┤
│ Recibís Factura A a nombre de ACME SRL (CUIT 30-…) ✓ verificado en ARCA [Cambiar]  │
│ Enviar a: admin@acme.com, contador@acme.com  [Editar]                              │
├ Comprobantes ────────────────────────────────────────────────────────────────────┤
│ FC A 0005-00000123 · 13/10 · $ 54.000 · Pagada            [PDF]                    │
│ NC A 0005-00000007 · 02/10 · −$ 2.000 · Bonificación       [PDF]                    │
├ Pagar por transferencia ─────────────────────────────────────────────────────────┤
│ Banco Galicia · CBU 0070… [Copiar] · Alias NINJASOFT.COBROS [Copiar]               │
│ Referencia: NS-acme-0123  [Ya transferí → subir comprobante]                       │
├ Historial ───────────────────────────────────────────────────────────────────────┤
└──────────────────────────────────────────────────────────────────────────────────┘
```

Permisos: dueño, todo; encargado, ver y descargar; el resto no ve la pestaña.

### 14.6 Configuración de cobranza (interna)

Hay seis secciones con guardado independiente y auditoría:

1. **Emisor y ARCA:** CUIT, condición, punto de venta, ambiente y checklist de producción (§16.1). Reutiliza `ArcaPlatformCard`.
2. **Facturación automática:** interruptor general, cuándo facturar (al cobrar o al generar el cargo), demora en días con advertencia del límite y vista previa ("Un pago del 13/10 se factura el 16/10").
3. **Punitorios:** políticas, con un simulador ("Deuda de $ 50.000 vencida hace 45 días → $ 3.750").
4. **Escalera de mora:** editor de pasos con línea de tiempo visual.
5. **Cuentas bancarias.**
6. **Plantillas:** factura, recibo, aviso y estado de cuenta (§12.1).

---

## 15. Dashboard interno: KPIs con definición exacta

### 15.1 Reglas generales

1. **Una sola fuente:** `subscriptions` (con `tenants.status` como espejo) y las tablas de cobranza.
2. **Base excluida de todo KPI comercial:**
   - `billing_mode = 'exempt'` (incluye las lifetime);
   - tenants marcados como internos o de demo (`tenants.is_test = true`, columna nueva, editable por super_admin);
   - tenants con `deleted_at`.

   El dashboard muestra la leyenda "Excluye N cuentas exentas o de prueba".
3. **Importes sin IVA** (neto) si NinjaSoft es RI; si es monotributo, neto = total.
4. **Cada tarjeta** tiene título, valor, comparación contra el período anterior (▲/▼ y %), un ⓘ con la definición de esta sección y un link al listado que la explica. Un clic en "MRR" lleva a la lista de suscripciones que lo componen.
5. **Formato compacto** en las tarjetas (`$ 10,56 M`, `$ 880 k`) con el valor exacto en el tooltip. Nada se sale de la tarjeta: `tabular-nums`, `truncate` y tamaño de fuente responsivo.
6. **Selector de período** (mes actual, mes anterior, últimos 12 meses). Las métricas de stock (MRR y deuda) toman el valor **al cierre** del período; las de flujo (cobrado, nuevos, churn) toman la **suma del período**.
7. **Muestras chicas:** si el denominador es menor a 5, se muestra "n/d (muestra chica)" junto con el `x de y`. Nunca un "100 %" engañoso.

### 15.2 Definiciones

Sea **cuenta paga** una suscripción con `status in ('active','past_due')`, sin exclusiones y con MRR > 0.

| KPI | Definición exacta | Fuente |
|---|---|---|
| **MRR** | Σ sobre las cuentas pagas del **monto recurrente mensual normalizado**: precio del plan del ciclo (mensual; anual / 12) + addons comprados activos (mensualizados) − descuentos recurrentes vigentes. **No** incluye punitorios, prorrateos, cargos únicos, trials, `suspended` ni `cancelled`. Es la misma fórmula que `subscription_billing_total()` corregida, dividida por la cantidad de meses del ciclo | `platform_mrr_snapshots` del último día del período |
| **ARR (run-rate)** | MRR × 12. Se rotula "ARR (MRR × 12)", nunca "ARR estimado" sin explicar | ídem |
| **Cuentas pagas** | Cantidad de cuentas pagas al cierre | ídem |
| **ARPA** | MRR / cuentas pagas | ídem |
| **MRR en riesgo** | Σ MRR de las cuentas pagas con `past_due`, con promesa abierta o con el último débito de MP rechazado | snapshots + cobranza |
| **Movimiento de MRR** (barra apilada del período) | **Nuevo**: MRR de cuentas que no eran pagas al inicio y nunca lo fueron. **Expansión**: aumento de MRR de cuentas pagas al inicio y al cierre. **Contracción**: la baja equivalente. **Churn**: MRR al inicio de cuentas pagas al inicio que al cierre ya no lo son (`cancelled` o `suspended` más de 30 días). **Reactivación**: MRR de cuentas que fueron pagas antes, no lo eran al inicio y sí al cierre. **Neto** = nuevo + expansión + reactivación − contracción − churn | Comparación de snapshots |
| **Churn de clientes (logo churn)** | Cuentas pagas al inicio del mes que al cierre son `cancelled` o están `suspended` hace más de 30 días, sobre las cuentas pagas al inicio del mes. Se muestra "x de y" | snapshots |
| **Churn de ingresos bruto** | (MRR churn + contracción) / MRR al inicio | snapshots |
| **NRR (retención neta)** | (MRR al inicio + expansión + reactivación − contracción − churn) / MRR al inicio, sólo sobre la cohorte paga al inicio | snapshots |
| **Conversión trial → pago** (cohorte) | Trials cuyo `trial_ends_at` cayó en el período **y** recibieron su primer pago aprobado antes de `trial_ends_at + 7 días`, sobre los trials cuyo `trial_ends_at` cayó en el período. Mostrar "x de y" | `subscriptions`, `platform_payments` |
| **Trials activos** / **por vencer en 7 días** | `status = 'trial'` / con `trial_ends_at` dentro de los próximos 7 días | `subscriptions` |
| **Nuevos negocios** | Tenants creados en el período (sin exclusiones de prueba) | `tenants.created_at` |
| **Cobrado** | Σ de los pagos `approved` con `paid_at` en el período, menos las reversas del período. Se ve **bruto y neto de comisiones** de MP | `platform_payments` |
| **Facturado** | Σ de facturas y ND aprobadas menos NC aprobadas, por `issue_date` en el período | `platform_documents` |
| **Deuda vencida** | Σ del saldo de los movimientos al debe con `due_date < hoy` (con punitorios), más aging 0–30 / 31–60 / 61–90 / +90 | ledger + allocations |
| **Efectividad de cobranza** | Cobrado en el período imputado a cargos que vencían en el período, sobre el total de esos cargos | allocations |
| **DSO** | Deuda total a la fecha / facturado de los últimos 90 días × 90 | ídem |
| **Cola fiscal de plataforma** | Comprobantes `pending` + `sending` / `requires_action` / `rejected` | `platform_documents` |
| **Pagos a verificar** | `pending_verification` (con la antigüedad del más viejo) | `platform_payments` |

### 15.3 "En riesgo": una sola definición, dos ejes

Se reemplazan "Con problemas" y "Negocios en riesgo" por **dos listas** con criterio explícito.

- **Riesgo de cobro.** El negocio entra si cumple al menos una:
  - `past_due`;
  - último débito rechazado;
  - promesa abierta o rota en los últimos 30 días;
  - tarjeta que vence antes del próximo débito;
  - saldo vencido mayor a 0.

  Se ordena por días de mora y monto.
- **Riesgo de uso.** El puntaje de salud de `lib/internal/tenantHealth.ts` (ADR-084) es menor a 60 en una cuenta paga o un trial.
  - Las razones se muestran tal cual: "sin ventas hace 121 días", "sin ingresos hace 122 días".
  - Un trial sin ventas a los 7 días entra en "Riesgo de conversión".

La tarjeta del dashboard muestra los dos conteos, y cada uno lleva a su lista.

### 15.4 Disposición del dashboard

```
Fila 1 (plata):      MRR · ARR (MRR×12) · Cobrado del mes (neto) · Deuda vencida · MRR en riesgo
Fila 2 (clientes):   Cuentas pagas · ARPA · Trials activos (por vencer 7d) · Conversión trial→pago (x de y) · Churn clientes (x de y)
Fila 3 (operación):  Pagos a verificar · Cola fiscal · Riesgo de cobro (n) · Riesgo de uso (n)
Gráfico:             Movimiento de MRR por mes (12 meses, barras apiladas + línea de MRR)
Tablas:              Riesgo de cobro (top 10) · Riesgo de uso (top 10) · Breakdown por plan (cuentas y MRR)
```

**El fix del dashboard actual no necesita esperar todo el modelo.** La fase F20-0 (§19) corrige las fórmulas con los datos de hoy:
- ignorar lifetime y `is_test`;
- anual = `yearly_price_ars / 12`, o mensual si el anual vale 0;
- sumar addons y descuentos;
- conversión por cohorte con `trial_ends_at` y `billing_records`;
- churn con `audit_logs` del cambio de estado en lugar de `updated_at`;
- formato compacto y tooltips.

La versión basada en snapshots llega con F20-2.

---

## 16. Cumplimiento ARCA

Es orientativo: hay que validarlo con el contador antes de F20-4.

### 16.1 Requisitos para emitir

Checklist en "Configuración › Emisor y ARCA", exigido antes de prender la facturación automática en producción:

1. **CUIT de NinjaSoft** con el alta en el impuesto que corresponda (IVA o monotributo) y con la actividad de servicios informáticos.
2. **Punto de venta exclusivo** para "RECE - Factura electrónica - Web Services", dado de alta en ARCA, distinto de cualquier otro uso. Sale en `FEParamGetPtosVenta` de producción.
3. **Certificado de producción** de la CUIT de NinjaSoft en `arca_platform` (lo genera el asistente existente) y vigente, con aviso a 30 días del vencimiento.
4. **Servicios autorizados** a ese certificado en el Administrador de Relaciones: `wsfe` y `ws_sr_constancia_inscripcion`.
5. **Prueba en homologación:** al menos 3 facturas, 1 NC y 1 ND aprobadas, con el mismo criterio que `homo_min_approved` de ADR-072.
6. **Prueba de producción** en los últimos 7 días: WSAA, FEDummy y `FECompUltimoAutorizado` del punto de venta.

### 16.2 Datos obligatorios por comprobante

- **Concepto 2** (servicios), con `FchServDesde`, `FchServHasta` (el período) y `FchVtoPago`.
  - En `on_payment`: la fecha del pago, o la fecha del comprobante si es posterior.
  - En `on_charge`: el vencimiento.
- **`CondicionIVAReceptorId`** (RG 5616): obligatorio. Sin él, `requires_action`.
- **Receptor:**
  - en la A, CUIT (`DocTipo` 80);
  - en la B a consumidor final, `DocTipo` 99 y `DocNro` 0 si el total está por debajo del tope de identificación vigente; si lo supera, hay que identificarlo (DNI o CUIT). El tope se lee de la configuración fiscal y no se hardcodea;
  - en la C, igual que en la B.
- **Moneda** `PES`, cotización 1.
- **QR** según RG 4892.

### 16.3 Notas de crédito y débito

- Siempre con **`CbtesAsoc`** a la factura (o ND) que corrigen: mismo punto de venta del emisor, tipo, número, CUIT y fecha. No se usa `PeriodoAsoc` salvo en ajustes globales, que esta versión no hace.
- **Misma letra que el comprobante asociado.** Una NC A corrige una FC A. Si el receptor cambió de condición, la NC va igual con la letra original.
- Una NC por un monto mayor al saldo no acreditado de la factura asociada se bloquea en el servidor: Σ NC de una factura ≤ total de la factura + Σ ND asociadas.
- **Plazo:** no hay un plazo general para emitir NC sobre una factura común. Sí hay plazo para la FCE MiPyME (§16.6). Igual, la regla de producto es no emitir NC sobre facturas de más de 12 meses sin un super_admin.

### 16.4 Fecha del comprobante y demora configurable

- ARCA acepta, para servicios, una fecha de comprobante hasta **10 días antes o después** de la fecha de envío, y nunca anterior a la del último autorizado de la serie.
- La demora de X días (§7.3) se cuenta desde el pago y la fecha del comprobante es **la fecha de emisión**. Con X entre 0 y 10 no hay conflicto con la ventana.
- **Riesgo para el contador:** en servicios, la factura se emite al terminar la prestación o al percibir el pago, lo que ocurra primero. Una demora larga después de cobrar puede ser objetable. Por eso se limita X a 10 días y se pide la validación del contador (§21).

### 16.5 Numeración y concurrencia

Es la misma garantía que ADR-072:
- un comprobante en vuelo por serie;
- número reservado antes de enviar;
- recuperación con `FECompConsultar`.

**La serie de plataforma** (`environment, issuer_pos_number, cbte_tipo`) **nunca se comparte** con los negocios: usa otro punto de venta y otra CUIT. No hay riesgo de colisión.

### 16.6 Casos especiales

- **FCE MiPyME** (Ley 27.440). Si NinjaSoft es MiPyME y el receptor es una "gran empresa" (padrón de FCE) y el monto supera el mínimo vigente, la factura debe ser de crédito electrónica (tipos 201/206/211), con otro flujo de aceptación.
  - Esta versión no la emite: detecta el caso (consulta del padrón FCE en una fase posterior, o una marca manual en el perfil) y deja `requires_action` con el mensaje "Corresponde FCE MiPyME".
  - Es deuda documentada. Lo normal es que esto no ocurra con montos de suscripción, pero hay que confirmarlo con el contador.
- **Exterior** (factura E). Fuera de alcance; requiere WSFEX.
- **Percepciones de IIBB** que NinjaSoft tuviera que practicar como agente. Si aplica, `Tributos` reutiliza el motor de ADR-068. Hoy se asume que no aplica (pregunta para el contador).

---

## 17. Casos borde

### 17.1 Pago parcial

- Se imputa con el orden por defecto: primero el punitorio más viejo, después el cargo más viejo.
- El cargo queda `partially_paid`.
- **No se factura un cargo parcialmente pagado** en `on_payment`. Se emite el recibo por lo cobrado y la factura sale cuando el cargo queda `paid`.
  - Excepción configurable: `invoice_partial = true` factura lo cobrado y el resto en otra factura. No se recomienda.
- La escalera sigue con el saldo restante.

### 17.2 Pago duplicado

Hay dos casos:
- **El mismo pago dos veces** (el webhook llega repetido): la idempotencia por `(provider, external_id)` y `mp_webhook_events` lo resuelven y no pasa nada.
- **Dos pagos reales del mismo período:** por ejemplo, el débito automático más un checkout manual, o dos transferencias. El segundo queda como **saldo a favor** y la conciliación lo marca "posible duplicado". El staff tiene tres opciones:
  - dejarlo a cuenta del próximo período (opción por defecto);
  - **reintegrarlo** (refund por API de MP para pagos de MP, o transferencia manual). Esto registra un `refund` al debe y no lleva comprobante fiscal, porque el pago no estaba facturado;
  - si ya estaba facturado (`on_charge` facturó y los dos pagos se imputaron a la misma factura, cosa que no debería pasar), el saldo a favor no se factura. No hay NC porque la factura es por el servicio, no por el pago.

### 17.3 Contracargo o devolución de Mercado Pago

1. El webhook o la conciliación detectan `charged_back`, `refunded` o `in_mediation`.
2. El sistema registra un `payment_reversal` (debe) por el monto, libera las imputaciones y pone el pago `charged_back`. El cargo vuelve a `open` o a `partially_paid`.
3. **La factura no se anula sola.** El servicio se prestó y la deuda vuelve a existir. La escalera corre otra vez desde el vencimiento original. Se avisa al staff con prioridad alta.
4. Si NinjaSoft **gana** la disputa, se reimputa el pago. Si la **pierde** y decide perdonar la deuda, va una NC con motivo "contracargo perdido, se condona" y un `adjustment_credit`.
5. Si la factura todavía estaba `scheduled` (dentro de la demora), se **cancela** antes de emitirse. Para esto existe la demora.

### 17.4 Cambio de plan a mitad de ciclo (prorrateo)

**Upgrade inmediato.** Ejemplo: de Pro a Business el día 10 de un mes de 30 días.
- Crédito por los días no usados del plan viejo: `precio_viejo × días_restantes / días_del_período`.
- Débito por esos mismos días del plan nuevo: `precio_nuevo × días_restantes / días_del_período`.
- Se genera un **cargo `proration`** con las dos líneas (neto positivo).
- **Se cobra:**
  - en `mp_subscription`, con un checkout único o sumado al próximo cargo según `proration_policy` (por defecto **sumado al próximo cargo**, para no pedirle otra tarjeta al cliente);
  - en cuenta corriente, va al próximo aviso.
- **Se factura** como cualquier cargo (una factura por el neto, con las dos líneas detalladas).
- El preapproval se actualiza al nuevo monto para los períodos siguientes.
- El acceso a las features nuevas es inmediato.

**Downgrade.** Se aplica **al fin del período** (por defecto): no hay crédito ni NC y se actualiza el preapproval.
- El downgrade inmediato sólo lo hace el staff con motivo. Genera un crédito proporcional como `bonus_credit` y la NC asociada a la factura del período.

**Cambio de ciclo** (de mensual a anual): se trata como un upgrade. Se acredita lo no usado del mensual, se debita el anual completo y el nuevo período empieza el día del cambio.

**Addons a mitad de ciclo:**
- Al **alta**, prorrateo hasta el fin del período del plan, para alinear las fechas. Es un cambio contra hoy, donde el addon tiene un período propio.
- A la **baja**, al fin del período.

Los días se cuentan en días calendario de la zona `America/Argentina/Buenos_Aires`. La función pura es `lib/billing/proration.ts` (TDD) y redondea al centavo por resto mayor.

### 17.5 Nota de crédito por baja

- **Baja voluntaria** con `cancel_at_period_end`: no hay NC; el período pagado se usa hasta el final.
- **Baja con devolución** (decisión comercial del staff, o arrepentimiento):
  - se calcula el proporcional no usado;
  - se emite la **NC asociada a la factura del período**;
  - se registra un `refund` (con el refund por API de MP si el pago fue por MP, o con una transferencia registrada por el staff);
  - el saldo queda en 0.
- **Botón de arrepentimiento** (Ley 24.240 y Res. 424/2020 para contratos a distancia con consumidores): 10 días corridos desde la contratación o la disponibilidad del servicio. El panel del cliente ya tiene una baja sutil; hay que sumarle el **botón de arrepentimiento visible** con la devolución total. Aplica cuando el cliente es consumidor final. Confirmar con el abogado o contador (§21).

### 17.6 Refacturación

Es el caso de una factura con importe, período o receptor equivocado.
1. NC total asociada a la factura original, con motivo "refacturación".
2. Nueva factura por el mismo cargo con los datos corregidos, con la clave de idempotencia `inv:{charge_id}:r{n}`.
3. Las dos salen en el mismo email ("Anulamos la factura X y te enviamos la correcta").
4. El ledger **no cambia**: el cargo y los pagos son los mismos, sólo cambia la capa fiscal. Ese es el beneficio del principio 3.1.

### 17.7 Letra equivocada

El caso típico: se facturó B a alguien que era RI y quería A.
- **No se puede convertir.** Va una NC B total asociada a la FC B y una FC A nueva (refacturación, §17.6).
- **Prevención:**
  - mostrar la letra antes de confirmar los datos;
  - verificar con el padrón;
  - el cron de revalidación avisa si cambió la condición.
- Si el cliente cambia los datos después de recibir la factura, el panel le ofrece "Pedir refacturación". Esto crea una tarea para el staff; no es automático para evitar abusos, y tiene un límite de 1 por factura y de 60 días.

### 17.8 Otros

| Caso | Tratamiento |
|---|---|
| ARCA rechaza la factura (`Resultado R`) | `rejected` con las observaciones. Si el error es del receptor, el cliente recibe "Revisá tus datos de facturación". El reproceso refresca el receptor |
| ARCA caído varios días | La cola reintenta hasta el dead-letter. Si la fecha del cargo sale de la ventana de 10 días, se emite con la fecha de hoy (sigue siendo válida para servicios; el período va en `FchServ*`) |
| Certificado vencido | `requires_action` en toda la cola. Banner en internal desde 30 días antes |
| Pago sin cargo (el cliente pagó antes del cron) | El webhook crea el cargo del período (§5.2) |
| Pago de un negocio dado de baja | Queda como saldo a favor. Alerta para reintegrar |
| Trial que paga antes de terminar | El período pago empieza al terminar el trial (no se pierden días de prueba) y la factura sale al cobrar. **A decidir: ¿o el período empieza el día del pago?** (§21) |
| Precio del plan cambiado con cargos ya generados | Los cargos generados mantienen su precio (líneas congeladas). El aumento rige desde el próximo período, con el aviso de doc 16 §10.3 (60 días) |
| Bonificación mayor al cargo | El excedente queda como saldo a favor y nunca como total negativo |
| Cliente cambia de RI a monotributista entre factura y NC | La NC mantiene la letra de la factura (§16.3) |
| Moneda | Sólo ARS. Un plan en otra moneda queda bloqueado al guardar hasta que exista multimoneda |
| Redondeo | Centavos `bigint` y resto mayor. Un test de propiedad asegura que Σ líneas = total y neto + IVA = total |
| Doble ejecución de un cron | Las claves de idempotencia hacen cada paso no-op |
| Staff carga pago manual y llega el webhook del mismo pago | El pago manual pide la referencia de MP si el medio es MP. Si coincide con un `external_id` existente, se rechaza el alta |
| El cliente sube el mismo comprobante dos veces | Hash SHA-256 del archivo: si se repite, se avisa que ya fue informado |

---

## 18. Permisos del staff y auditoría

### 18.1 Matriz

Se agrega a `06-permissions-roles.md`. Los niveles son los existentes: `support`, `admin`, `super_admin`.

| Acción | support | admin | super_admin |
|---|---|---|---|
| Ver cobranza, estados de cuenta y comprobantes | ✓ | ✓ | ✓ |
| Notas de gestión, cargar promesa (hasta 15 días) | ✓ | ✓ | ✓ |
| Verificar o rechazar transferencias, registrar pago manual | — | ✓ | ✓ |
| Reintentar comprobante, reenviar email | ✓ | ✓ | ✓ |
| Bonificar o condonar hasta el tope del nivel (default: admin $ 50.000 por operación y $ 150.000 por mes por negocio) | — | ✓ | ✓ (sin tope) |
| Emitir NC o ND manual, refacturar | — | ✓ (NC hasta el tope) | ✓ |
| Cambiar modalidad o condiciones de un negocio, marcar exento | — | ✓ (exento: no) | ✓ |
| Configuración de plataforma (emisor, ARCA, punitorios, escalera, plantillas, cuentas bancarias, MP) | — | — | ✓ |
| Marcar incobrable / dar de baja por mora | — | — | ✓ |
| Aprobar operaciones `pending_approval` | — | — | ✓ |

**Pregunta para el dueño:** ¿hace falta un nivel o permiso específico de "cobranzas" (una persona que cobra pero no administra negocios)? Ver §21. El diseño lo deja preparado para un permiso `billing` sumable a cualquier nivel.

### 18.2 Auditoría

Toda RPC de escritura escribe en `audit_logs` con `entity_type` en `platform_charge`, `platform_payment`, `platform_document`, `platform_ledger`, `tenant_billing_terms`, `tenant_billing_profile`, `platform_billing_settings` u otras de la familia, y con:
- `before_data` y `after_data`;
- `reason`;
- `tenant_id` del negocio afectado.

Las acciones del sistema van con `actor_user_id = null` y la etiqueta "Sistema" en el timeline (ADR-073). `audit_logs` ya es inmutable con cadena de hash (ADR-083).

### 18.3 Gating del lado del servidor

Todo se valida en la RPC o la Edge con `internal_level()` y el tope. La UI sólo esconde botones.

---

## 19. Plan de entrega por fases

Cada fase es un PR chico y testeable por su cuenta. Las migraciones van **antes** que el front.

| Fase | PR | Contenido | Depende de | Bloqueo externo |
|---|---|---|---|---|
| **F20-0a** | `fix/dashboard-kpis` | Dashboard con las fórmulas corregidas sobre los datos actuales (§15.4): exclusiones, `tenants.is_test`, anual / 12, addons y descuentos, conversión por cohorte, churn por auditoría, formato compacto, tooltips con definición, "Riesgo de cobro / Riesgo de uso". Funciones puras en `lib/internal/saasKpis.ts` con tests | — | — |
| **F20-0b** | `feat/pagos-plataforma-mp` | Rediseño de "Pagos de plataforma" (§14.2): logos oficiales, dos bloques, validaciones de formato, `webhook_secret`, ambiente, "Probar conexión", URL del webhook para copiar, últimos eventos. Validación de `x-signature` en `mp_billing_webhook` | — | Cargar el Client ID correcto (hoy tiene un email) |
| **F20-1** | `feat/cobranza-ledger` | Migraciones: `tenant_billing_terms`, `platform_charges/_lines`, `platform_ledger`, `platform_allocations`, `platform_payments` (backfill desde `billing_records` y vista de compatibilidad), `platform_promises`, `platform_collection_notes`. `subscription_billing_total()` con descuentos. Webhook de MP → cargo + pago + imputación. Espejo `tenants.status` por trigger. Estado de cuenta interno y del cliente. Modalidad `exempt` (migra las lifetime). RLS y tests de RLS | — | — |
| **F20-2** | `feat/cobranza-kpis-snapshots` | `platform_mrr_snapshots`, cron y dashboard con movimiento de MRR, NRR, cobrado y deuda (§15) | F20-1 | — |
| **F20-3** | `feat/datos-fiscales-cliente` | `tenant_billing_profiles`, `platform_fiscal_lookups`, Edge `platform_billing.padron_lookup` (constancia de inscripción), panel del cliente "Datos de facturación" con la letra prevista, carga manual de respaldo, lista de "sin verificar" para el staff | F20-1 (no estrictamente) | CUIT de NinjaSoft + certificado con `ws_sr_constancia_inscripcion` (sin eso funciona en modo manual) |
| **F20-4** | `feat/factura-plataforma` | `platform_issuer_profile`, `platform_documents/_lines/_events`, Edge `platform_invoicing` (worker sobre `_shared/arca`), emisión **manual** de factura desde el cargo, PDF en el servidor con `pdf-lib` y plantilla por defecto, Storage, descarga en internal y en el panel. Checklist de homologación (§16.1) | F20-1, F20-3 | **CUIT, condición fiscal, punto de venta y certificado de NinjaSoft**; validación del contador |
| **F20-5** | `feat/factura-automatica` | Interruptor y config (inmediato o +X días, `on_payment` / `on_charge`), trigger de encolado, cron `platform-billing-run`, adjuntos en `system_emails` y `process_pending_emails`, emails `platform_invoice_issued` y `platform_payment_receipt`, recibos | F20-4 | — |
| **F20-6** | `feat/plantillas-factura` | Editor de plantillas versionadas con vista previa en vivo (§12.1), plantillas de recibo, aviso y estado de cuenta | F20-4 | — |
| **F20-7** | `feat/nc-nd-plataforma` | NC y ND manuales con `CbtesAsoc` y validación de montos, refacturación (§17.6), bonificaciones (§10.4) con topes y aprobación, baja con devolución, botón de arrepentimiento | F20-4 | — |
| **F20-8** | `feat/cuenta-corriente-plataforma` | Modalidad `account`: avisos de cobro periódicos (`statement_frequency`), cuentas bancarias, "Ya transferí" con comprobante, bandeja de verificación, `platform_checkout` (pagar saldo con MP) | F20-1 (F20-5 para facturar `on_charge`) | Datos bancarios de NinjaSoft |
| **F20-9** | `feat/punitorios-mora` | Políticas de punitorios, devengamiento diario, ND `on_collection`, condonar o saldar, escalera configurable que reemplaza a `saas-dunning`, restricción blanda, promesas, feriados | F20-1; ND con F20-7 | Decisión de tasa y escalera (§21) |
| **F20-10** | `feat/conciliacion-plataforma` | Conciliación diaria con MP, contracargos y reversas, duplicados, prorrateo de cambios de plan y addons (§17.4) | F20-1; NC con F20-7 | — |
| **F20-11** | `feat/cobranza-360` | Timeline unificado, lista de clientes de cobranza, cobrador asignado, permisos finos y topes (§18), export XLSX, revalidación mensual del padrón | F20-1 a F20-9 | — |

### 19.1 Orden recomendado

1. **F20-0a y F20-0b ya, en paralelo.** No dependen de nada, arreglan las dos quejas visibles y la 0b corrige el Client ID mal cargado, que hoy rompe el OAuth de los clientes.
2. **F20-1**, la base económica. Sin ella todo lo demás es pegar parches sobre `billing_records`.
3. **F20-2 y F20-3 en paralelo.** La 2 da KPIs reales; la 3 empieza a juntar los datos fiscales de los clientes aunque todavía no se facture (en modo manual hasta tener la CUIT).
4. **F20-8 y F20-9** si hay clientes en cuenta corriente antes de tener la CUIT de NinjaSoft: se puede cobrar con avisos de cobro no fiscales, punitorios y escalera sin facturar.
5. **F20-4 → F20-5 → F20-6 → F20-7**, apenas exista la CUIT de NinjaSoft con certificado y punto de venta.
6. **F20-10 y F20-11** al final.

### 19.2 Criterios de aceptación globales

- Un pago de Mercado Pago real genera el cargo, el pago, la imputación, la factura con CAE (en homologación), el PDF y un email con el adjunto, sin intervención. Si el webhook se repite 5 veces, no se duplica nada.
- Una cuenta corriente con deuda vencida a 45 días muestra los punitorios correctos según la política, el staff condona la mitad con motivo, sale la NC asociada y todo aparece en el timeline y en `audit_logs`.
- Un contracargo reabre la deuda sin tocar la factura.
- El dashboard muestra MRR, churn y conversión iguales a una planilla calculada a mano sobre los mismos datos (test con fixture).
- `rls_internal_scope_leaks()` = 0. Un dueño no puede ver el ledger ni los comprobantes de otro negocio (test de integración RLS).

---

## 20. Participación del staff y gastos (futuro, no construir aún)

> **ROADMAP · NO CONSTRUIR TODAVÍA.** Esta sección deja el diseño para que no se pierda. Depende de que la cobranza (F20-1, F20-2 y F20-10) dé números confiables de lo cobrado neto por mes. Hito F21 en el roadmap.

### 20.1 Qué se quiere

- Configurar qué **porcentaje** de la facturación mensual le corresponde a cada persona del staff.
- Que cada persona vea **su porcentaje** y **cuánto va a recibir el mes próximo**.
- Cargar **gastos** (servidores, dominio, herramientas, etc.) con **recurrencia** (mensual, anual, cada X fecha) que se **descuentan** de lo que reciben las personas **en proporción a su participación**, con la posibilidad de **eximir** a ciertas personas de ciertos gastos.

### 20.2 Base de cálculo (a decidir con el dueño)

Primero hay que definir la base, porque cambia todo. Opción recomendada en negrita:

| Base | Ventaja | Problema |
|---|---|---|
| Facturado (comprobantes) | Coincide con lo fiscal | Se reparte plata que puede no haber entrado |
| **Cobrado neto** (pagos aprobados − reversas − comisiones de MP, sin IVA) | Se reparte lo que realmente entró | Un contracargo de un mes ya repartido obliga a ajustar el siguiente |
| MRR | Predecible | No es plata real |

### 20.3 Modelo propuesto

- **`staff_shares`**:
  - columnas: `user_id`, `share_bp` (puntos básicos sobre 10.000), `valid_from`, `valid_to`, `created_by` y `reason`;
  - historia por vigencia;
  - una restricción garantiza que en cada día la suma de `share_bp` vigentes sea ≤ 10.000. El resto queda como "retenido por NinjaSoft".
- **`platform_expenses`**:
  - columnas: `name`, `category` (infraestructura, dominio, software, impuestos, otros), `amount_cents`, `currency`, `recurrence` (`once`, `monthly`, `yearly`, `every_n_days`, `custom_dates`), `recurrence_config`, `start_date`, `end_date`, `prorate_mode` (`by_month_incurred` o `amortize_yearly`: un gasto anual se reparte en 12 o se imputa entero en el mes) y `active`;
  - los gastos en USD (servidores) necesitan una cotización por mes: tabla `fx_rates` o carga manual.
- **`platform_expense_exemptions`**: `expense_id`, `user_id`, `valid_from` y `valid_to`. La persona eximida no absorbe ese gasto; los demás lo absorben en proporción a sus participaciones **renormalizadas** sin ella.
- **`payout_runs`** y **`payout_lines`**: una liquidación por mes.
  - Estados: `draft`, `approved`, `paid`.
  - Cada línea guarda base, participación, ingreso bruto de la persona, gastos absorbidos, ajustes de meses anteriores y neto.
  - **Inmutable una vez aprobada.** Las correcciones van como ajuste en la siguiente.

### 20.4 Fórmula

Para el mes *m* y la persona *i*:

```
B_m          = base del mes (p. ej. cobrado neto)
s_i          = share_bp_i / 10000 (vigente en el mes; si cambió a mitad de mes, prorrata por días)
bruto_i      = B_m × s_i
para cada gasto g del mes con monto G_g:
   P_g       = personas no eximidas de g
   gasto_i,g = G_g × s_i / Σ_{j∈P_g} s_j      si i ∈ P_g, si no 0
   (la parte de NinjaSoft, 1 − Σ s, también absorbe gastos en proporción, salvo que se decida otra cosa)
neto_i       = bruto_i − Σ_g gasto_i,g + ajustes_i
```

**Proyección "cuánto vas a recibir el mes próximo":**
- MRR al día de hoy de las cuentas pagas × tasa histórica de cobranza (efectividad de los últimos 3 meses) × s_i;
- menos los gastos recurrentes que caen el mes próximo.

Se muestra como **estimado** con su rango y nunca como monto garantizado.

### 20.5 Pantallas futuras

- `/internal/participacion` (sólo super_admin): participaciones con vigencia, gastos con recurrencia y exenciones, liquidación mensual (borrador → aprobar → marcar pagada) y export.
- `/internal/mi-participacion` (cada persona del staff, **sólo lo suyo**):
  - su porcentaje;
  - lo liquidado en meses anteriores;
  - el estimado del mes próximo con el detalle de gastos;
  - cuánto se descontó y por qué.

  RLS: `user_id = auth.uid()` más `internal_scope()`.

### 20.6 Preguntas que hay que responder antes de construirlo

1. ¿La base es el cobrado neto, el facturado o el MRR? ¿Con IVA o sin IVA?
2. ¿La parte no asignada (la de NinjaSoft) absorbe gastos?
3. ¿Los gastos anuales se imputan enteros en el mes del pago o se amortizan en 12?
4. ¿Qué pasa con un contracargo de un mes ya liquidado: ajuste negativo en el siguiente?
5. ¿Hay un mínimo garantizado o un tope por persona?
6. ¿Cómo se paga (fuera del sistema)? ¿Hace falta comprobante (factura del staff a NinjaSoft)?
7. Implicancias impositivas y contractuales de repartir ingresos: lo valida el contador.

---

## 21. Preguntas abiertas para el dueño

Las que bloquean están marcadas con **(bloquea Fxx)**.

1. **(bloquea F20-4)** ¿NinjaSoft ya tiene CUIT? ¿Es **monotributo** o **responsable inscripto**? Define si todo sale C o hay A y B. ¿Tiene un punto de venta web service dado de alta?
2. **(bloquea F20-4)** ¿Los precios de los planes son **finales** (IVA incluido) o **más IVA**?
3. **(bloquea F20-5)** Para la demora de facturación, ¿está bien un **máximo de 10 días** desde el pago? ¿El contador está de acuerdo con facturar al cobrar (y no al inicio del período) en el débito automático?
4. **(bloquea F20-9)** **Punitorios:** ¿qué tasa mensual (por ejemplo, 3 %)? ¿Cuántos días de gracia? ¿Diario prorrateado o por mes empezado? ¿Tiene tope? ¿Se cobran también a los clientes con débito automático o sólo a los de cuenta corriente?
5. **(bloquea F20-9)** **Escalera de mora:** hoy se suspende a los 3 días. ¿Se mantiene, o se pasa a la propuesta (past_due +1, restricción +7, suspensión +10)?
6. **(bloquea F20-0a)** ¿Qué negocios son **internos o de prueba** y no tienen que contar en los KPI? Los 4 Enterprise de la captura, ¿pagan?
7. ¿Hace falta un permiso específico de **"cobranzas"** para staff que cobra pero no administra? ¿Los topes de bonificación propuestos ($ 50.000 por operación y $ 150.000 por mes para admin) están bien?
8. ¿El cliente puede cargar **su propia promesa de pago** desde el panel o sólo el staff?
9. Un **trial que paga antes de terminar**: ¿el período pago empieza al terminar el trial (recomendado) o el día del pago?
10. **Prorrateo de upgrade:** ¿se cobra en el momento (checkout aparte) o se suma al próximo débito (recomendado)?
11. ¿Qué cuentas bancarias se muestran para transferir? ¿A qué email se mandan los comprobantes de pago?
12. **Botón de arrepentimiento:** ¿se considera que los clientes pueden ser consumidores finales? Si sí, hay obligación legal; confirmar con el abogado.
13. **Participación del staff (§20.6):** responder antes de planificar F21.

---

*Referencias internas:*
- [`16-subscription-model.md`](./16-subscription-model.md)
- [`24-internal-ops-panel.md`](./24-internal-ops-panel.md)
- [`33-facturacion-arca.md`](./33-facturacion-arca.md)
- [`specs/cuenta-corriente-v2.md`](./specs/cuenta-corriente-v2.md)
- ADR-016, ADR-037, ADR-052, ADR-072, ADR-073, ADR-083, ADR-084 y ADR-110.
