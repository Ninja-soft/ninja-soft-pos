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
4. Toggle `tenant.afip_environment = 'production'`.
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
