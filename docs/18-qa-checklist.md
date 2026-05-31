# 18 · QA Checklist

Checklist operativo. Lo que hay que verificar **antes de mergear a `main`**, antes de un release y después de un deploy a producción.

Esta lista la usa el agente `qa-engineer` y la ejecutan los devs antes de aprobar una PR.

---

## 1 · Checklist universal de PR

Toda PR, antes de pedir review, tiene que pasar este checklist. Sin excepciones.

### Código

- [ ] Compila sin errores (`pnpm build`).
- [ ] Linter pasa sin warnings nuevos (`pnpm lint`).
- [ ] Type-check pasa (`pnpm typecheck`).
- [ ] Tests unitarios pasan (`pnpm test`).
- [ ] Si la PR toca código crítico (POS, caja, pagos, RLS), tiene tests nuevos o ajustados.
- [ ] No quedó código comentado, `console.log` ni `TODO` sin issue asociado.

### Multi-tenant

- [ ] Toda tabla nueva tiene `tenant_id` y RLS habilitada.
- [ ] Toda query desde el frontend usa el cliente con anon key, no service_role.
- [ ] Si se agregó una Edge Function, valida `tenant_id` explícitamente antes de operar.

### Seguridad

- [ ] No hay secretos hardcodeados (claves, tokens, URLs privadas).
- [ ] No se loggea información sensible (passwords, tokens, datos fiscales completos).
- [ ] Inputs externos validados con Zod o equivalente.

### Documentación

- [ ] Si el cambio es estructural, hay una ADR nueva en `docs/17-decision-log.md`.
- [ ] Si cambió el comportamiento visible al usuario, está reflejado en `CHANGELOG.md`.
- [ ] Si se agregó una variable de entorno, está en `.env.example`.
- [ ] Si se agregó una migración, sigue el naming `YYYYMMDDHHMMSS_verbo_descripcion.sql`.

### UI

- [ ] La pantalla funciona en mobile (375px), tablet (768px) y desktop (1280px+).
- [ ] Theme oscuro y claro se ven bien.
- [ ] Estados de carga, vacío y error están implementados.
- [ ] El foco visible y la navegación por teclado funcionan.

---

## 2 · Checklist por módulo

### POS (Punto de Venta)

- [ ] Buscar producto por nombre, SKU y código de barras funciona.
- [ ] Agregar/quitar ítems del carrito actualiza el total en tiempo real.
- [ ] Descuentos por ítem y por venta total se calculan bien.
- [ ] Atajos de teclado `F2` a `F12` funcionan en desktop.
- [ ] Suspender una venta y retomarla mantiene el estado.
- [ ] Cobrar con efectivo, tarjeta y mixto funciona.
- [ ] El ticket se genera con todos los campos requeridos.
- [ ] La venta queda registrada con `tenant_id`, `cash_shift_id`, `cashier_id`, items, pagos.
- [ ] Si hay impresora, imprime; si no, muestra ticket en pantalla.
- [ ] Anular una venta requiere permiso y queda en `audit_logs`.

### Productos y stock

- [ ] Alta de producto con SKU, nombre, precio y stock inicial funciona.
- [ ] Edición de producto registra el cambio en `audit_logs`.
- [ ] Cambios de precio quedan trazados.
- [ ] Baja lógica (`deleted_at`) no elimina, solo marca.
- [ ] El stock se descuenta automáticamente al confirmar una venta.
- [ ] El stock se restituye al anular una venta.
- [ ] Ajustes manuales de stock requieren motivo y quedan en `stock_movements`.

### Caja y turnos

- [ ] Apertura de caja registra usuario, fecha, hora y monto inicial.
- [ ] Movimientos de caja (ingreso/egreso) registran motivo y autor.
- [ ] Cierre de caja muestra arqueo: total esperado vs declarado.
- [ ] Diferencias quedan registradas y requieren motivo.
- [ ] No se puede vender sin una caja abierta.
- [ ] Solo un turno abierto por caja a la vez.

### Clientes

- [ ] Alta de cliente con datos mínimos funciona.
- [ ] Asociar cliente a una venta queda registrado.
- [ ] CUIT/DNI se valida con formato argentino.

### Usuarios, roles y permisos

- [ ] Owner puede invitar usuarios y asignar roles.
- [ ] Manager no puede modificar plan ni borrar tenant.
- [ ] Cashier solo puede operar el POS, no ver reportes globales.
- [ ] Viewer solo lee, no modifica nada.
- [ ] Cambios de rol quedan en `audit_logs`.

### Suscripciones y planes (panel interno NinjaSoft)

- [ ] Solo staff de NinjaSoft accede al panel interno.
- [ ] Crear un tenant lo deja en estado `trial`.
- [ ] Cambiar de plan registra el cambio con autor, fecha y motivo.
- [ ] Suspender un tenant bloquea login pero no borra datos.
- [ ] Reactivar un tenant restaura el acceso.

### Feature flags

- [ ] Activar/desactivar una flag para un tenant se refleja en la sesión siguiente del usuario.
- [ ] Una flag con `default_enabled: true` aplica salvo override explícito por tenant.
- [ ] Cambios de flags quedan en `audit_logs`.

---

## 3 · Checklist de seguridad (pre-release)

Antes de un release a producción, el agente `security-auditor` corre esta lista.

- [ ] Toda tabla operativa tiene RLS habilitada (`select tablename from pg_tables where schemaname='public'` cruzado con `pg_class.relrowsecurity`).
- [ ] Ninguna política RLS usa `using (true)` sin justificación documentada.
- [ ] `service_role` no aparece en código del frontend (`grep -r "service_role" app/ components/ lib/`).
- [ ] Variables `NEXT_PUBLIC_*` no contienen secretos.
- [ ] Edge Functions validan el JWT y el `tenant_id` antes de operar.
- [ ] Endpoints públicos tienen rate limit.
- [ ] Inputs validados con Zod en server-side, no solo en cliente.
- [ ] Logs no exponen datos sensibles (tokens, passwords, CBU, etc.).
- [ ] Backups de Supabase activos y verificados.
- [ ] Plan de rollback documentado.

---

## 4 · Checklist post-deploy

Después de mergear a `main` y de que Vercel publique:

- [ ] La URL de producción carga sin errores.
- [ ] Login funciona con una cuenta de prueba.
- [ ] El POS abre, busca producto, agrega al carrito y cobra.
- [ ] Una venta de prueba queda registrada en la DB.
- [ ] Sentry (o el observador configurado) no muestra errores nuevos en las primeras 2 horas.
- [ ] Logs de Edge Functions limpios.
- [ ] Métricas básicas (latencia, error rate) dentro de umbral.

Si algo falla en este checklist, **rollback inmediato** (Vercel: rollback al deploy anterior) y diagnóstico antes de reintentar.

---

## 5 · Smoke test manual diario

Durante la Fase 1 y 2, el equipo corre un smoke test diario en el ambiente de preview. Toma 10 minutos.

1. Login como cashier.
2. Abrir caja con $1.000 inicial.
3. Buscar un producto, agregarlo al carrito.
4. Aplicar un descuento del 10%.
5. Cobrar en efectivo.
6. Verificar que el ticket se generó.
7. Anular la venta (con permiso de manager).
8. Cerrar caja, verificar arqueo.
9. Logout, login como manager, ver el reporte del día.
10. Logout, login como staff NinjaSoft, ver el tenant en el panel interno.

Si algún paso falla, se abre issue y se prioriza para el día siguiente.

---

## 6 · Convenciones de testing

Ver `12-testing.md` para detalle. Resumen:

- **Unit:** Vitest. Funciones puras, helpers, validadores.
- **Integration:** Vitest con DB de prueba (Supabase CLI local).
- **E2E:** Playwright. Flujos críticos: login, venta completa, cierre de caja, alta de tenant.
- **Coverage objetivo:** 70% en lógica de negocio (módulos), 90% en helpers de seguridad y RLS.

---

## 7 · Cuándo NO mergear

Esta lista es corta y no negociable.

- Tests rojos.
- Build roto.
- RLS faltante en una tabla nueva.
- `service_role` en frontend.
- Migración sin nombre versionado.
- PR sin descripción que explique qué cambia y por qué.
- Cambio estructural sin ADR.

Cuando algo de esta lista aparece, la PR vuelve al autor.
