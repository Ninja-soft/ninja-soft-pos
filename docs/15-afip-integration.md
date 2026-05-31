# Integración AFIP — NinjaSoft POS

Diseño y reglas para la facturación electrónica en Argentina. Fase 3 del roadmap. Documento de referencia: no se implementa hasta haber leído y discutido este doc completo.

> **Estado actual:** diseño. No implementado. Esto es la base sobre la que se construirá en F3.

## 1. Alcance

| Comprobantes | MVP de F3 | Posterior |
|---|---|---|
| Factura A | ✅ | |
| Factura B | ✅ | |
| Factura C | ✅ | |
| Nota de Crédito A/B/C | ✅ | |
| Nota de Débito A/B/C | | ✅ |
| Tique fiscal (Controlador Fiscal) | | ❌ (no soportamos hardware fiscal) |
| Factura M | | ✅ |
| Comprobante de Compra | | ❌ |

Webservice: **WSFEv1** (factura electrónica) y **WSAA** (autenticación).

## 2. Modos de operación

| Modo | Cuándo | URL AFIP |
|---|---|---|
| `homologation` | Desarrollo, testing, onboarding de nuevo cliente. | `wswhomo.afip.gov.ar` |
| `production` | Cliente con producción autorizada por AFIP. | `servicios1.afip.gov.ar` |

Switch por tenant en `tenant.afip_environment`. Default `homologation`.

### 2.0 Modalidad de facturación por tenant

Cada tenant elige cómo factura:

| Modalidad | Significado |
|---|---|
| `ninjasoft_afip` | NinjaSoft emite factura electrónica desde el POS. Requiere CUIT, punto de venta, certificado y modo AFIP configurado. |
| `external_manual` | El comercio factura fuera de NinjaSoft (portal AFIP/ARCA u otro sistema). Las ventas quedan como comprobantes internos no fiscales. |

Reglas:

- [ ] La modalidad se configura por tenant y queda auditada.
- [ ] Si está en `external_manual`, el POS nunca intenta emitir CAE automáticamente.
- [ ] Si está en `ninjasoft_afip`, toda venta fiscalizable entra al flujo fiscal/cola fiscal.
- [ ] El ticket debe indicar claramente si es comprobante interno no fiscal o comprobante fiscal autorizado.

### 2.1 Gate de homologación → producción

Un tenant no puede pasar a producción solo por toggle manual. El panel debe exigir:

- [ ] CUIT del tenant validado.
- [ ] Punto de venta configurado.
- [ ] Certificado y clave privada de producción cargados y desencriptables.
- [ ] Certificado de homologación probado.
- [ ] 20 comprobantes consecutivos aprobados en homologación.
- [ ] Numeración sincronizada con `FECompUltimoAutorizado`.
- [ ] Cola fiscal sin comprobantes bloqueados.
- [ ] Usuario interno confirma el cambio con motivo auditado.

La homologación y producción usan certificados, TA cacheado y numeración separados.

### 2.2 Asistente de configuración AFIP/ARCA

El flujo recomendado no debe exigir OpenSSL ni conocimiento técnico al cliente.

- [ ] Wizard paso a paso: CUIT, condición IVA, punto de venta, ambiente, certificado.
- [ ] Modo asistido: NinjaSoft genera CSR/certificado requerido y guía al usuario para pegar/subir lo necesario en AFIP/ARCA.
- [ ] Modo experto: subir `.crt` y `.key` propios.
- [ ] Validación inmediata de certificado/clave.
- [ ] Prueba de conexión WSAA/WSFEv1.
- [ ] Emisión de comprobante de prueba en homologación.
- [ ] Checklist visual para pasar a producción.
- [ ] Errores en lenguaje accionable, no códigos crudos como única respuesta.

## 3. Arquitectura

```
[POS Frontend]
     │ POST /functions/v1/submit_invoice_afip
     ▼
[Edge Function submit_invoice_afip]
     │
     ├─→ Lee certificado y clave privada del tenant (Vault)
     ├─→ Solicita TA (Ticket de Acceso) a WSAA si caducó
     ├─→ Construye request CAE para WSFEv1
     ├─→ Llama a AFIP (con timeout y reintentos)
     ├─→ Persiste request/response/CAE en BD
     ├─→ Actualiza venta con número fiscal
     └─→ Notifica al frontend
```

## 4. Almacenamiento de credenciales

Cada tenant que facture electrónicamente carga:

| Dato | Almacenamiento |
|---|---|
| CUIT | `tenants.tax_id` (plano) |
| Punto de venta (PV) | `tenants.afip_pos_number` |
| Certificado X.509 | `tenant_afip_credentials.cert_pem` (cifrado pgcrypto) |
| Clave privada | `tenant_afip_credentials.private_key_pem` (cifrado pgcrypto) |
| Token de Acceso (TA) en caché | `tenant_afip_credentials.ta_xml`, `ta_expires_at` |

```sql
create table tenant_afip_credentials (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  cert_pem bytea not null,           -- cifrado
  private_key_pem bytea not null,    -- cifrado
  ta_xml text,                       -- en claro, expira en 12hs
  ta_expires_at timestamptz,
  environment text not null check (environment in ('homologation', 'production')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

Cifrado se hace en Edge Function de alta de credenciales, usando una master key en Vault de Supabase.

## 5. Flujo de TA (WSAA)

```
1. Tenant llama a submit_invoice_afip.
2. Edge Function lee tenant_afip_credentials.
3. Si ta_expires_at > now() + 1h margen: usa el TA en caché.
4. Si no: genera TRA (Ticket de Requerimiento de Acceso) XML,
   firma con clave privada (CMS), llama a WSAA.
5. AFIP retorna TA (token + sign).
6. Persiste TA en BD con expires_at = now() + 12h.
```

## 6. Flujo de CAE (WSFEv1)

```
1. Frontend confirma venta con datos fiscales.
2. Edge Function valida payload (Zod).
3. Edge Function llama a FECompUltimoAutorizado para conocer último número.
4. Construye request FECAESolicitar con:
   - Tipo de comprobante (1=A, 6=B, 11=C, ...)
   - PV
   - Número (último + 1)
   - Fecha
   - CUIT receptor
   - Importes (neto, IVA discriminado, total)
   - Items (opcional pero recomendado)
5. Llama a AFIP con timeout 10s.
6. AFIP retorna:
   - CAE
   - Vencimiento CAE
   - Resultado (A=Aprobado, R=Rechazado, P=Parcial)
7. Si A: guarda CAE en sales.cae, sales.cae_due, sales.fiscal_number.
8. Si R: marca venta como fiscal_pending, encola reintento.
9. Notifica al frontend con estado fiscal.
```

## 7. Reintentos

| Error | Acción |
|---|---|
| Timeout (network) | Reintento inmediato (max 3). Backoff: 1s, 2s, 4s. |
| AFIP 5xx | Reintento en cola (5 min, 15 min, 1h, 4h). |
| AFIP 4xx (problema de payload) | No reintento. Marca como `fiscal_error`. Requiere intervención. |
| Falta de campos opcionales | Reintento removiendo opcionales. |

Cola de reintentos: tabla `afip_retry_queue` procesada por cron Edge Function cada 5 minutos.

### 7.1 Cola fiscal robusta

La cola fiscal es el centro operativo de AFIP. No es solo retry técnico: también es la bandeja de trabajo para soporte y owner/manager cuando un comprobante requiere corrección.

| Estado | Significado | Acción |
|---|---|---|
| `pending` | Comprobante creado, todavía no enviado. | Procesar por worker. |
| `processing` | Worker lo tomó. | Lock temporal con timeout. |
| `retrying` | Falló por error transitorio. | Reintentar con backoff. |
| `approved` | AFIP devolvió CAE. | Actualizar venta/comprobante. |
| `rejected` | AFIP rechazó por payload/regla fiscal. | Requiere acción humana. |
| `blocked` | Falta dato/configuración/certificado. | Resolver configuración. |
| `dead_letter` | Superó reintentos máximos o error persistente. | Soporte revisa manualmente. |

Reglas:

- [ ] Cada item de cola guarda `tenant_id`, `sale_id`, `voucher_type`, `point_of_sale`, `environment`, `attempt_count`, `next_attempt_at`, `last_error_code`, `last_error_message`.
- [ ] Cada pedido fiscal usa idempotencia por `sale_id + voucher_type + point_of_sale + environment`.
- [ ] El worker usa locks para evitar doble emisión.
- [ ] Antes de pedir CAE se verifica numeración contra `FECompUltimoAutorizado` si hay drift o cambio de día.
- [ ] Los XML request/response se conservan aunque la emisión falle.
- [ ] El panel permite reintentar, bloquear, marcar como requiere datos o escalar a soporte.
- [ ] Toda acción manual queda en `audit_logs`.

## 8. Numeración

- Por punto de venta + tipo de comprobante.
- `cash_registers.pos_number` define el PV.
- Función SQL `next_fiscal_number(tenant_id, pos_number, voucher_type)` con lock para garantizar unicidad.
- Verificación contra AFIP (FECompUltimoAutorizado) antes de pedir CAE para detectar drift.

## 9. UX en el POS

### 9.1 Venta sin requerimiento fiscal (consumidor final, monto bajo)
- Comprobante interno con número correlativo no fiscal.
- Frase: "Comprobante no fiscal" en el ticket.
- No se envía a AFIP.

### 9.2 Venta con factura
- El cashier selecciona "Facturar A/B/C" y carga CUIT del cliente (autocompletado desde catálogo si ya existe).
- Al cobrar, la venta se confirma en BD inmediatamente (estado `completed`).
- Estado fiscal: `pending`. El ticket se imprime sin CAE pero con número provisorio.
- Edge Function llama a AFIP en background (cola asíncrona).
- Cuando llega el CAE, el ticket se reemprime (o se marca el comprobante como completo si fue digital).

**Razón:** la venta no espera por AFIP. El cliente paga y se va. Si AFIP falla, lo resolvemos sin bloquear operación.

### 9.2.1 Venta offline / AFIP offline

El POS diferencia dos casos:

| Caso | Qué pasa |
|---|---|
| Sin internet en el local | La venta se guarda localmente como pendiente de sincronización. No se intenta AFIP. |
| Internet disponible pero AFIP falla | La venta se guarda en DB y el comprobante entra a cola fiscal. |

Reglas:

- [ ] La venta offline usa número interno/provisorio, nunca número fiscal definitivo.
- [ ] Al reconectar, se sincroniza la venta, se asigna correlativo real si corresponde y se encola AFIP.
- [ ] El ticket offline dice claramente "Comprobante interno pendiente de autorización fiscal".
- [ ] El owner/manager ve un panel de ventas pendientes de sincronizar/fiscalizar.
- [ ] Si la fecha fiscal queda fuera de rango por demora, el comprobante pasa a `blocked` con acción sugerida.
- [ ] No se pierde el pago ni el stock: el sync debe ser idempotente.
- [ ] El cashier puede seguir vendiendo si el negocio acepta operar offline, controlado por feature flag/configuración.

### 9.2.2 Contingencia AFIP/ARCA

La contingencia es un modo explícito para seguir vendiendo cuando AFIP/ARCA no responde.

- [ ] Solo owner/manager o staff autorizado puede activar contingencia.
- [ ] Activar contingencia exige motivo y queda en `audit_logs`.
- [ ] Mientras está activa, los comprobantes fiscalizables se emiten como internos/provisorios y entran a cola fiscal.
- [ ] El POS muestra banner persistente "Contingencia fiscal activa".
- [ ] Al desactivar contingencia, el sistema procesa la cola fiscal por orden y muestra aprobados/rechazados/bloqueados.
- [ ] Si AFIP vuelve pero hay drift de numeración, la cola pasa a `blocked` hasta conciliar.
- [ ] La contingencia no debe confundirse con modalidad `external_manual`: en contingencia sí se emitirá AFIP al normalizar.

### 9.3 Si AFIP rechaza definitivamente
- Notificación al owner/manager: "Comprobante X rechazado, motivo Y."
- Posibilidad de:
  - Reemitir con corrección.
  - Anular la venta y generar nota de crédito.
  - Convertir a no fiscal (con motivo).

## 10. Panel de control de facturación

Dentro del admin del cliente:
- Comprobantes emitidos (filtros: fecha, tipo, estado).
- Comprobantes pendientes (cola de reintentos).
- Comprobantes rechazados (con acción de remediación).
- Último ping a AFIP (status).
- Próximo CAE a vencer.

## 11. Notas técnicas

### 11.1 Librería
- Edge Function en Deno: usar `node-soap` polyfill o llamar al XML directamente con `fetch`.
- Firma CMS para WSAA: usar `pkijs` o equivalente.
- Mantener una librería interna `lib/afip/` para abstraer detalles.

### 11.2 Timezone
- AFIP usa hora Argentina (UTC-3).
- Fechas en formato `YYYYMMDD` para AFIP, `YYYY-MM-DD` internamente.
- Tener cuidado con verano/invierno (Argentina no tiene DST, pero verificar al desarrollar).

### 11.3 Importes
- AFIP usa decimal con punto: `1234.56`.
- IVA discriminado por alícuota: 0%, 10.5%, 21%, 27%.
- Sumas redondeadas a 2 decimales con banker's rounding.

## 12. Compliance

- Conservar XML de request/response **10 años** (AFIP RG).
- Storage en `supabase/storage/afip-receipts/<tenant_id>/<YYYY>/<MM>/<sale_id>.xml`.
- Cifrado en reposo (Supabase Storage).
- Acceso con RLS por tenant.

## 13. Testing

### 13.1 Homologación
- Cada tenant nuevo arranca en `homologation`.
- Suite de tests E2E corre 20 comprobantes consecutivos sin error.
- Validación cruzada con afip.gob.ar consultando CAE.

### 13.2 Mock para tests unitarios
- Mock del WSFEv1 con respuestas determinísticas.
- No llamamos a AFIP en CI.

## 14. Migración a producción

Proceso por cliente:
1. Cliente solicita pasaje a producción.
2. NinjaSoft valida que homologación corrió OK 20+ comprobantes.
3. Cliente sube certificado de producción (distinto del de homologación).
4. Usuario interno ejecuta el cambio desde el panel; el sistema valida el gate de homologación → producción.
5. Próximo comprobante usa producción.

## 15. Errores frecuentes de AFIP (referencia rápida)

| Código | Significado | Acción |
|---|---|---|
| 600 | Token o sign inválido | Refrescar TA. |
| 1001 | CUIT inhabilitado | Avisar al cliente, contactar AFIP. |
| 10015 | Fecha del comprobante fuera de rango | Verificar fecha local. |
| 10016 | Número no correlativo | Sincronizar con FECompUltimoAutorizado. |
| 10018 | CAE ya solicitado | Idempotencia rota; revisar. |

Lista completa: documentación oficial AFIP WSFEv1.

## 16. Riesgos

| Riesgo | Mitigación |
|---|---|
| AFIP caído por horas | Cola de reintentos. UX no bloquea ventas. |
| Drift de numeración | Verificar con FECompUltimoAutorizado al inicio del día. |
| Certificado expira | Alerta 30 días antes. Recordatorio al owner. |
| Master key comprometida | Rotación + re-cifrado de todos los certificados. Plan documentado. |
| Cambio regulatorio AFIP | Versionado de Edge Function permite implementar v2 sin romper v1. |
