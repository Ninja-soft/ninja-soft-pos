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

## Prueba semestral

- [ ] Restaurar backup en entorno descartable.
- [ ] Ejecutar smoke test POS/caja/reportes.
- [ ] Verificar RLS y aislamiento multi-tenant.
- [ ] Verificar cola fiscal y ventas pendientes si aplica.
- [ ] Registrar resultado en esta carpeta.
