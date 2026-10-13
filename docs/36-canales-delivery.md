# Canales de delivery: PedidosYa, Rappi, Uber Eats y Mercado Pago Delivery

Pedidos de las apps de delivery que entran solos al tablero de Delivery, crean solos la comanda, se facturan y muestran el seguimiento del repartidor. F13 · H49 (integraciones), ADR-102. Feature `canales_delivery` (OPTIONAL, Pro, Business y Enterprise).

Estado: **núcleo genérico y simulador listos**. Los adaptadores reales esperan el alta comercial con cada plataforma (ver §5). Investigación de base: `research-delivery-apps.md` (13/10/2026), resumida acá.

## 1. Cómo funciona

```
App (PedidosYa / Rappi / Uber Eats / simulador)
  --webhook firmado--> Edge delivery_channel_webhook?c=<conexión>   (pública, 64 KB, firma por adaptador)
     -> delivery_channel_ingest_event: guarda el evento crudo (único por conexión + id del evento)
        y lo procesa en una subtransacción (si falla queda "error" y el cron lo reintenta)
          pedido nuevo      -> delivery_orders (canal 'app') + líneas + pedido externo
                               comanda a cocina al instante (auto-aceptar o flujo indirecto)
                               o en espera hasta "Aceptar" con el tiempo de preparación
          estado            -> aceptado / listo / retirado / entregado (sin retroceder)
          cancelación       -> anula la comanda (aviso en el KDS con motivo) y, si estaba
                               facturado, anula la venta: la cola fiscal emite la nota de crédito
          repartidor        -> nombre, teléfono, posición, ETA y link de seguimiento
Local (tablero de Delivery)
  Aceptar / Rechazar / Listo / Retirado / Entregado / Facturar
     -> delivery_channel_outbox (reintentos con espera creciente: 15 s, 30 s, 1 min ... 15 min)
     -> Edge delivery_channel_worker (al toque y por cron cada minuto) -> adaptador de la app
Cron (delivery_channel_worker)
  cola saliente + eventos con error + reconciliación (pide a la app los pedidos recientes:
  recupera un webhook perdido sin duplicar nada)
```

- **Idempotencia doble:** el mismo evento no entra dos veces (`unique (conexión, id del evento)`) y el mismo pedido no se crea dos veces aunque llegue por otro evento o por la reconciliación (`unique (conexión, id del pedido)`). Nunca dos comandas ni dos ventas.
- **Cocina:** la comanda usa el KDS de siempre. Cuando todas las líneas quedan listas en el KDS, el pedido pasa a "listo" y se le avisa a la app.
- **Precio:** se cobra el que informa la app (puede ser distinto del de tu lista). Lo que la app manda sin mapear se cocina igual (línea libre) y el pedido queda marcado "Revisar ítems".
- **Modificadores:** los mapeados viajan como modificadores del POS; el resto va como nota de la línea para la cocina.

## 2. Facturación

- **Medio de pago `plataforma`** ("App de delivery"): la app cobró por cuenta del local. **No genera movimiento de caja** (no entra plata al cajón ni a la cuenta del turno). Si el pedido es con reparto propio y cobro en efectivo, se factura con efectivo y entra a la caja.
- Se usa el cobro de siempre de los pedidos de delivery (`create_sale` con el pedido): la venta queda en el **turno de quien factura**, en la sucursal de la conexión (si la caja es de otra sucursal, avisa).
- **Automática** (por conexión): al marcar Retirado o Entregado desde el tablero se factura en el turno de quien lo marca. Lo que la app marca sola (sin sesión) queda "a facturar" y se factura apenas el tablero está abierto en una caja de esa sucursal.
- **Manual:** botón Facturar en la tarjeta. El dueño o encargado puede **Cerrar sin factura** con motivo (queda auditado), por ejemplo si la app emite el comprobante.
- Con la facturación electrónica activa (ADR-072) la factura va a la cola fiscal como cualquier venta. **Cancelación después de facturar:** la venta se anula y sale la nota de crédito por la cola.
- A confirmar con el contador: quién emite el comprobante al consumidor según la app, cómo tratar los descuentos que financia la app y las retenciones que aplica en la liquidación.

## 3. Configurar (Configuración > Canales de delivery)

Requiere Delivery activado (Configuración > Operación) y la feature en el plan. Sólo dueño o encargado.

1. **Conectar canal:** app, sucursal, nombre, id del local en la app (el simulador lo genera), aceptar solos, facturación y tiempo de preparación por defecto.
2. **Configuración:** pausar o activar, aceptar solos, sucursal, cómo se aceptan (desde NinjaSoft o desde la tablet de la app), facturación, tiempo de preparación, comisión estimada, URL del webhook (para pasarle a la app) y credenciales (sólo escritura: no se vuelven a mostrar).
3. **Productos:** id de cada producto en la app, con **Sugerir por nombre y SKU** (cruza con lo que la app ya mandó). Los productos con variantes todavía no se mapean.
4. **Actividad:** avisos a la app (con Reintentar) y lo que mandó la app.

## 4. Probar con el simulador

Conectá el **Simulador** a una sucursal (queda activo al instante) y en la pestaña **Simular**:

- **PedidosYa / Rappi / Uber Eats:** arma un pedido con tus productos y lo manda como un webhook firmado real. Opciones: un ítem sin mapear, reparto propio con envío, retira el cliente.
- **Pedido con webhook perdido:** queda sólo en la "app"; la reconciliación del cron lo recupera en 1 o 2 minutos.
- **La app no responde:** las llamadas salientes fallan para ver los reintentos y el aviso en la tarjeta.
- Sobre cada pedido: **Repartidor** (se acerca y baja el ETA, con link al mapa), **Retiró**, **Entregó** y **Cancelar en la app**.

## 5. Qué tiene que tramitar el dueño con cada plataforma

Ninguna es self-service: todas piden contacto comercial antes de dar credenciales de producción. Conviene empezar ya (es el camino crítico) y llevar clientes gastronómicos que lo pidan.

### PedidosYa (Delivery Hero): primer adaptador recomendado, flujo indirecto

1. Formulario de alta en integrar.pedidosya.com y **NDA**.
2. Generar un par de claves **PGP** y mandar la pública por el formulario; la credencial llega cifrada por email.
3. Pedir el **ambiente de staging** y un vendor de prueba al contacto (no hay sandbox self-service).
4. Confirmar con Delivery Hero: **whitelist de IPs** (entregan sólo a IPs habilitadas) y si aceptan el dominio de las Edge de NinjaSoft o hace falta un dominio propio; SSL obligatorio.
5. Datos que entregan al activar: nombre y código de integración, base URL del plugin, usuario, chains, vendors (código, país, Remote ID) y tipo de flujo. Cargá el **Remote ID** como "Id del local en la app".
6. Prueba de punta a punta con el contacto, piloto con 1 a 3 locales y escalado.
7. Operación: avisar mantenimientos con 24 h a log_vendor_pos_integrations@deliveryhero.com.
- A confirmar: campo del tiempo de preparación, estados de disponibilidad del local, tracking del repartidor, API de liquidaciones (hoy por export del portal).

### Rappi: la API más completa

1. Conseguir un **TAM** (Technical Account Manager) de Rappi, idealmente vía el contacto comercial de un cliente que ya venda en Rappi.
2. El TAM crea la integración y el **clientId** (Auth0); el local autoriza a NinjaSoft desde Portal Partners (OAuth) y se provisionan las tiendas.
3. Ambiente dev para desarrollar y **homologación** (incluye el test de la firma HMAC del webhook, ya implementada).
4. Configurar el webhook con la URL de la conexión y el **secreto de firma** (se carga en Credenciales).
5. Tener en cuenta: sin aceptar en **6 minutos** el pedido pasa a TIMEOUT (conviene "Aceptar solos"), PING cada 3 minutos, tasa de éxito >= 98 %.
- A confirmar: costo para el integrador, política de reintentos de webhooks, campos del payload.

### Uber Eats

1. Hablar con el partner manager: **NDA + API licensing agreement** (puede requerir aprobación escrita).
2. App de TESTING y sandbox; certificación exigente (99,9 % de pedidos inyectados).
3. Confirmar cobertura actual en tu ciudad (relanzado en Argentina en 2026).

### Mercado Pago Delivery

1. Pedir la habilitación al contacto comercial de Mercado Pago (sólo se integra si te habilitan).
2. A confirmar: documentación técnica completa, logística y cobertura.

### Con el contador

Tratamiento fiscal de los pedidos cobrados por la app, descuentos financiados por la app y retenciones en la liquidación.

## 6. Seguridad y límites

- Secretos y credenciales en `delivery_channel_secrets`, sin policies ni grants (sólo service_role); nunca vuelven al navegador.
- El webhook sólo procesa con la firma válida del adaptador (el simulador y Rappi: HMAC-SHA256 con tolerancia de 5 minutos). PedidosYa, Uber Eats y MP Delivery rechazan todo hasta tener su adaptador.
- Sin la feature en el plan, el webhook responde 200 sin procesar y las RPC rechazan.
- Todo queda en `audit_logs`: conexión, cambios, credenciales (sólo las claves), mapeo, aceptar, rechazar, listo, retirado, entregado, facturar, cerrar sin factura, cancelación, simulaciones.

## 7. Pendiente

- Adaptadores reales (PedidosYa indirecto, Rappi completo, Uber Eats, MP Delivery) con sus payloads de staging.
- Sync de menú y disponibilidad por ítem, pausar el local desde NinjaSoft.
- Liquidaciones reales (API financiera de Rappi, import del portal de PedidosYa) y reporte de comisión efectiva.
- Etiqueta del canal en el KDS ("PEDIDOSYA #A1B2"): hoy el KDS muestra "DELIVERY #XXXX"; la marca se ve en el tablero.
- Realtime: el tablero se refresca cada 5 s.
