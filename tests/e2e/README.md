# E2E — NinjaSoft POS (Playwright)

Suite punta a punta del panel: auth, productos, POS, cuenta corriente, medios
de pago, reportes, Tiendita, asistente IA y chequeo visual.

```bash
pnpm test:e2e                      # todo (o modo smoke si no hay sesión)
pnpm test:e2e tests/e2e/pos.spec.ts --no-deps   # un spec, sin el teardown de logout
pnpm exec playwright show-report   # reporte HTML (playwright-report/)
```

Vitest no levanta estos specs (`tests/e2e/**` está excluido en `vitest.config.ts`).

## Navegador

Usa el Chromium de Playwright si está instalado (`pnpm exec playwright install chromium`).
Si no, el **Chrome del sistema** (`C:/Program Files/Google/Chrome/Application/chrome.exe`).
Otro path: `E2E_CHROME_PATH`.

## Variables de entorno

| Variable | Para qué |
|---|---|
| `BASE_URL` | App a probar. Default `http://localhost:3005` (`PORT=3005 pnpm dev`). |
| `E2E_ACCESS_TOKEN` / `E2E_REFRESH_TOKEN` | Sesión del usuario QA. Las escribe `scripts/e2e-session.mjs`. |
| `E2E_SUPABASE_REF` | Ref del proyecto (nombre de la cookie `sb-<ref>-auth-token`). |
| `E2E_QA_TENANT_ID` | Id del **tenant QA**. Guardarraíl: si el `current_tenant_id` del JWT no coincide, el suite aborta antes de tocar nada. |
| `E2E_CUSTOMER_NAME` | Cliente de prueba del tenant QA para cuenta corriente. Default `E2E Cliente QA`. |
| `E2E_AI=1` | Permite mandar un mensaje al asistente (gasta cuota). Sin esto sólo abre el panel y el historial. |

**Modo smoke:** sin `E2E_ACCESS_TOKEN` / `E2E_REFRESH_TOKEN` / `E2E_SUPABASE_REF` sólo corren
las páginas públicas (`/login`, `/signup`, `/recover`, `/auth/callback`, redirect de
ruta protegida y screenshots públicos); el resto se saltea. En smoke las
llamadas a PostgREST (`/rest/v1`) se responden vacías desde el navegador, así
que se puede correr contra un dev server con un Supabase falso:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy PORT=3005 pnpm dev
pnpm test:e2e
```

## Tenant QA

Los flujos **crean y anulan datos reales** en el tenant de la sesión, por eso
corren sólo contra un **tenant QA dedicado** (nunca contra un negocio de un
cliente):

- Un negocio de prueba con su owner (email propio para QA), plan con
  `cuenta_corriente`, `medidas_bultos` y, si se quiere cubrir, `directo` y el
  add-on `asistente_ia`. Los flujos que dependen de una feature apagada se
  saltean con el motivo.
- Una caja configurada (el suite abre el turno si está cerrado y lo deja abierto).
- Un cliente `E2E Cliente QA` (o `E2E_CUSTOMER_NAME`) con cuenta corriente y algo de saldo.
- Al menos un catálogo de Tiendita comprado o de regalo (si no, se saltea).

## Sesión (sin password)

`scripts/e2e-session.mjs` hace magic link admin (`generate_link`) + `verify` y
escribe los tokens en el directorio temporal del SO. No imprime secretos.

```powershell
$env:E2E_EMAIL = "<owner del tenant QA>"
node --env-file=.env.local scripts/e2e-session.mjs
. "$env:TEMP\ninjapos-e2e-session.ps1"     # carga E2E_* en la sesión
pnpm test:e2e
```

```bash
E2E_EMAIL=... node --env-file=.env.local scripts/e2e-session.mjs
source "${TMPDIR:-/tmp}/ninjapos-e2e-session.env"
```

El global setup (`tests/e2e/global-setup.ts`) arma las cookies de `@supabase/ssr`
(`sb-<ref>-auth-token`, `base64-` + JSON, en chunks de 3180) y las guarda como
`storageState`. Si el access token vence durante la corrida, el middleware lo
refresca; las cookies rotadas se persisten entre tests (corren en serie,
`workers: 1`).

**La sesión se consume:** el último paso (`session-end.spec.ts`, proyecto
teardown) prueba el corte por inactividad, y el middleware hace `signOut()`.
Hay que regenerar los tokens antes de cada corrida completa. Para correr un spec
suelto sin cerrar la sesión: `--no-deps`.

## Datos y limpieza

Todo lo que crea el suite lleva el prefijo `E2E-<timestamp>` (un id por corrida):

- Productos: se dan de **baja lógica** al final (`productos.spec.ts`, `afterAll` de `pos.spec.ts`).
  También quedan rubros/categorías `E2E-… Rubro` / `E2E-… Cat`.
- Ventas del POS: se **anulan** con motivo `E2E-… limpieza e2e` (repone stock, queda auditado).
- Cobro de cuenta corriente: $1 en efectivo con nota `E2E-… cobro` (queda como
  movimiento; anulable desde la ficha si hace falta).
- Configuración de cuenta corriente: se guarda el mismo valor (no cambia nada).
- Medios de pago: el wizard se recorre con valores dummy y se cancela; nunca se guarda.
- Tiendita: se abre el editor de importación y se cancela.
- Diseño del POS: se vuelve al del negocio.
- Compras (`compras.spec.ts`): un proveedor `E2E-… Proveedor` que termina **archivado**
  y una orden de compra en borrador que se **cancela** (motivo `E2E-… limpieza e2e`).
- Cobros en espera, precio validado, conciliación: no escriben nada (ver abajo).
- Terminales, Mis PINes, transferencias, listas de precios, hardware: sólo lectura
  o wizard recorrido y cancelado.

Si una corrida se corta a mitad, buscar por el prefijo `E2E-` en productos,
categorías, ventas y proveedores (con "Ver archivados") del tenant QA.

## Proveedores de pago: nunca reales

Contra producción ninguna Edge Function de cobro llega al servidor:
`support/mocks.ts` (`guardEdgeFunctions`) responde las que el test necesita y
corta el resto en el navegador. Los flujos que dependen de un proveedor
conectado se simulan sin escribir en la base:

- `cobros-en-espera.spec.ts`: Mercado Pago "conectado" sólo en el navegador
  (lecturas reales + parche), link de `mp_create_qr` simulado y
  `park_pending_charge` / `cancel_pending_charge` respondidos (estacionar exige
  un intent real del proveedor).
- `precio-validado.spec.ts`: `create_sale` responde `price_mismatch` y se
  valida el aviso; la venta nunca se registra.

Specs de funciones que todavía pueden no estar desplegadas (balanza y cajón por
caja, aviso de NubCeo, filtro "Con alertas") se saltean con el motivo cuando la
UI no aparece.

## Visual

`visual.spec.ts` saca screenshots de cada página principal a 390 y 1440 px en
`test-results/screenshots/` y falla si hay scroll horizontal a 390. Todos los
specs fallan ante errores de consola o excepciones no capturadas (allowlist de
ruido de terceros en `support/fixtures.ts`).
