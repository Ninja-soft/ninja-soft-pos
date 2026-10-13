# Disaster recovery

Plan base de recuperacion ante incidentes mayores. Se completa y prueba formalmente en Fase 3, antes de operar AFIP en produccion.

## Objetivos

- RTO: 4 horas.
- RPO: 1 hora.
- Prioridad 1: mantener integridad de ventas, caja, stock y comprobantes fiscales.
- Prioridad 2: recuperar acceso operativo para tenants afectados.

## Escenarios cubiertos

- [ ] Caida de frontend/Vercel.
- [ ] Caida o degradacion de Supabase.
- [ ] Migracion defectuosa.
- [ ] Edge Function critica rota.
- [ ] Perdida o corrupcion parcial de datos.
- [ ] Incidente de credenciales o secretos.
- [ ] AFIP/ARCA no disponible o con respuestas inconsistentes.

## Runbook minimo

1. Declarar severidad y responsable de incidente.
2. Congelar deploys no relacionados.
3. Confirmar alcance: tenants, ventas, comprobantes, caja, stock.
4. Aplicar mitigacion: rollback, feature flag off, forward fix o contingencia.
5. Validar recuperacion con smoke test operativo.
6. Comunicar estado a soporte/clientes afectados.
7. Completar post-mortem usando [`../templates/post-mortem.md`](../templates/post-mortem.md).

## Evidencia requerida

- Logs relevantes.
- Capturas de metricas.
- IDs de deploy/migracion.
- Tenants afectados.
- Ventas/comprobantes involucrados.
- Acciones manuales ejecutadas.

## Backup y restore (F1.5, ADR-098)

Procedimiento escrito para el piloto. **Todavía no se ejecutó**: la primera prueba en un entorno descartable es requisito para cerrar F1.5 (roadmap). Registrar cada prueba en `docs/security-reviews/restore-AAAA-MM-DD.md` con tiempos, conteos y problemas.

### Qué backups hay

1. **Nativos de Supabase** (Dashboard → Database → Backups): diarios, con la retención del plan. Con **PITR** (add-on) se puede volver a cualquier minuto y el RPO es el de §Objetivos; sin PITR el RPO real es de hasta 24 horas. Antes del piloto: confirmar plan, retención y si hay PITR, y anotarlo acá.
2. **Dump lógico propio** (independiente de Supabase, para el restore de prueba y antes de migraciones que tocan datos). Con la CLI (necesita Docker) o con `pg_dump` y la cadena de conexión del **session pooler** (Dashboard → Connect), nunca commiteada:

   ```bash
   # CLI (Docker)
   supabase db dump --linked -f roles.sql --role-only
   supabase db dump --linked -f schema.sql
   supabase db dump --linked -f data.sql --use-copy --data-only
   # o pg_dump directo (sin Docker)
   pg_dump "$DATABASE_URL" --no-owner --no-privileges -Fc -f ninjasoft-$(date +%F).dump
   ```

   Guardar cifrado fuera del repo (contiene datos de clientes). Storage (fotos, certificados) no entra en el dump: se respalda aparte si hace falta.

### Restore de prueba (entorno descartable)

1. Crear un proyecto Supabase nuevo y vacío (o `supabase start` local).
2. Restaurar en orden, con los triggers apagados durante la carga de datos:

   ```bash
   psql "$RESTORE_URL" -f roles.sql
   psql "$RESTORE_URL" -f schema.sql
   psql "$RESTORE_URL" -c "set session_replication_role = replica" -f data.sql
   ```

   (Con el `.dump` de `pg_dump`: `pg_restore --no-owner --no-privileges -d "$RESTORE_URL" ninjasoft-AAAA-MM-DD.dump`.)
3. **Verificar estructura:** `SUPABASE_PROJECT_REF=<ref restaurado> node --env-file=.env.local scripts/deploy-check.mjs --remote` muestra la misma última migración que producción y 0 pendientes (las Edge saldrán como `R3` no desplegadas: es esperable).
4. **Verificar datos:** los mismos conteos en origen y restaurado.

   ```sql
   select 'tenants' t, count(*) n, max(created_at) from tenants
   union all select 'sales', count(*), max(created_at) from sales
   union all select 'payments', count(*), max(created_at) from payments
   union all select 'cash_shifts', count(*), max(opened_at) from cash_shifts
   union all select 'stock_movements', count(*), max(created_at) from stock_movements
   union all select 'audit_logs', count(*), max(created_at) from audit_logs;
   ```

   Y la cadena de auditoría de un negocio con `audit_chain_verify('<tenant>')` (ADR-083), llamada por REST con la service_role del restaurado (desde `psql` como `postgres` responde `forbidden`).
5. **Verificar RLS:** `pnpm test:rls` con `SUPABASE_TEST_URL` / `SUPABASE_TEST_ANON_KEY` / `SUPABASE_TEST_SERVICE_KEY` del restaurado (crea sus propios tenants).
6. **Verificar operación:** levantar el front contra el restaurado (`NEXT_PUBLIC_SUPABASE_*` del restaurado) y correr `pnpm test:smoke` con una sesión del tenant QA de ese proyecto.
7. Borrar el proyecto descartable y el dump de la máquina.

### Restore real (incidente)

Sólo con corrupción confirmada y decisión del responsable del incidente. Preferir PITR al minuto anterior al problema. Antes de restaurar: congelar deploys, sacar un dump del estado actual (para recuperar lo escrito después del punto de restore) y avisar a los negocios afectados. Después: §Runbook mínimo, pasos 5 a 7.

## Prueba semestral

- [ ] Restaurar backup en entorno descartable.
- [ ] Ejecutar smoke test POS/caja/reportes.
- [ ] Verificar RLS y aislamiento multi-tenant.
- [ ] Verificar cola fiscal y ventas pendientes si aplica.
- [ ] Registrar resultado en esta carpeta.
