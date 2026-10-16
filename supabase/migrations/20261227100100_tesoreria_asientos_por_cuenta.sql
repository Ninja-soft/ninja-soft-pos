-- =============================================================================
-- 20261227100100_tesoreria_asientos_por_cuenta  (F23 · H150 y H154, ADR-158)
--
-- La Contabilidad registra la plata en la MISMA cuenta que Tesorería:
--
--   1) Cuenta contable por cuenta de dinero (acc_treasury_account): el mapeo
--      propio 'tesoreria' con calificador '<kind>:<id>' (lo crea
--      treasury_account_ledger_create como subcuenta), y si no hay, el genérico
--      del tipo. Un cobro por transferencia a una cuenta de cobro vinculada a un
--      banco de Tesorería va a la cuenta contable de ese banco
--      (acc_payment_account): el Mayor de "Galicia" coincide con su saldo.
--   2) Saldo inicial con asiento de apertura (T10): cuenta de dinero contra
--      Resultados no asignados, en la fecha de apertura; se rehace si cambia el
--      saldo antes del cierre del mes.
--   3) Señas y medios sin cuenta (T17): seña cobrada (cobro / Señas recibidas),
--      devuelta (al revés) y aplicada en la venta (medio 'sena' contra Señas);
--      Ualá Bis, MODO, Mercado Libre y plataformas con cuenta propia.
--   4) Moneda (T19): movimientos de Tesorería y saldos iniciales en otra moneda
--      se pasan a pesos con la cotización del día (fx_rates del negocio y, para
--      USD, la oficial de la plataforma). Sin cotización el asiento queda en
--      Contabilidad > Resumen (acc_issues) con el motivo, sin frenar nada.
--   5) Regenerar por documento (T20): acc_generate arma primero la lista de
--      documentos del rango y da de baja sólo sus asientos (no los de otros
--      documentos que el cierre corrió a este mes).
--   6) Gastos con cuenta de gasto e IVA crédito fiscal (H154); cheque de
--      terceros recibido con asiento (Valores a depositar contra "Otros medios
--      de cobro a cobrar"), rechazos sin dejar Valores a depositar negativo, y
--      rechazo de cheque propio contra la deuda con el proveedor (T18).
--   7) Fechas argentinas (T22): acc_period_close, acc_entry_reverse y
--      acc_sync_safe.
--   8) Fuente de los asientos de liquidación (preparado para H153):
--      acc_settings.settlement_source ('ninjapos' por defecto | 'nubceo'). Con
--      'nubceo' acc_sync_settlement_line no genera nada. Ninguna RPC la cambia
--      todavía: la elección y la importación de asientos de NubCeo son H153.
--   9) acc_entry_lookup: "Ver asiento" desde cualquier documento o movimiento.
--
-- Redefinidas a partir de su definición VIVA en producción (2026-10-15):
-- acc_install_template, acc_sync, acc_sync_sale, acc_sync_cash_movement,
-- acc_sync_treasury_movement, acc_sync_supplier_payment,
-- acc_sync_settlement_line, acc_generate, acc_period_close, acc_entry_reverse,
-- acc_sync_safe. Todo sigue en triggers diferidos que nunca frenan la venta.
-- En producción no hay negocios con Contabilidad (acc_settings = 0): nada que
-- migrar.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Fuente de los asientos de liquidación (H153 la expone).
-- -----------------------------------------------------------------------------
alter table acc_settings add column if not exists settlement_source text not null default 'ninjapos';
alter table acc_settings drop constraint if exists acc_settings_settlement_source_check;
alter table acc_settings add constraint acc_settings_settlement_source_check
  check (settlement_source in ('ninjapos', 'nubceo'));
comment on column acc_settings.settlement_source is
  'ADR-158 (preparado para H153): quién arma el asiento de cada liquidación de procesador. ninjapos = acc_sync_settlement_line (por defecto); nubceo = los asientos importados de NubCeo (H153). Sin RPC que lo cambie hasta H153.';

create or replace function acc_settlement_source(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select settlement_source from acc_settings where tenant_id = p_tenant), 'ninjapos');
$$;
revoke all on function acc_settlement_source(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1) Cotización para pasar a pesos.
-- -----------------------------------------------------------------------------
create or replace function acc_fx_rate(p_tenant uuid, p_currency text, p_date date)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cur text := upper(coalesce(nullif(btrim(p_currency), ''), 'ARS'));
  v     numeric;
begin
  if v_cur = 'ARS' then
    return 1;
  end if;
  select r.rate into v
    from fx_rates r
   where r.tenant_id = p_tenant and r.currency = v_cur and r.rate_date <= p_date and r.rate > 0
   order by r.rate_date desc, (r.source = 'manual') desc
   limit 1;
  if v is null and v_cur = 'USD' then
    select f.venta into v
      from platform_fx_rates f
     where f.casa = 'oficial' and f.deleted_at is null and f.rate_date <= p_date
     order by f.rate_date desc, (f.source = 'manual') desc
     limit 1;
  end if;
  if v is null or v <= 0 then
    raise exception 'acc_fx_rate_missing: % al %', v_cur, to_char(p_date, 'DD/MM/YYYY');
  end if;
  return v;
end;
$$;
revoke all on function acc_fx_rate(uuid, text, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2) Plantilla: cuentas y mapeos nuevos (idempotente por system_key).
-- -----------------------------------------------------------------------------
create or replace function acc_template_extend(p_tenant uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r   record;
  v_n int := 0;
begin
  if not exists (select 1 from acc_accounts where tenant_id = p_tenant and deleted_at is null) then
    return 0;
  end if;
  for r in
    select * from (values
      ('1.1.01.07', 'Billeteras virtuales',                          'activo', 'billeteras'),
      ('1.1.02.06', 'Ualá Bis, MODO y otros procesadores a cobrar',  'activo', 'procesadores_a_cobrar'),
      ('1.1.02.07', 'Mercado Libre a cobrar',                        'activo', 'ml_a_cobrar'),
      ('1.1.02.08', 'Plataformas de delivery a cobrar',              'activo', 'plataformas_a_cobrar'),
      ('2.1.03.04', 'Señas recibidas de clientes',                   'pasivo', 'senas')
    ) as t(code, name, kind, skey)
  loop
    if not exists (select 1 from acc_accounts
                    where tenant_id = p_tenant and system_key = r.skey and deleted_at is null) then
      insert into acc_accounts (tenant_id, code, name, kind, imputable, system_key, parent_id)
      select p_tenant, r.code, r.name, r.kind, true, r.skey,
             (select a.id from acc_accounts a
               where a.tenant_id = p_tenant and a.deleted_at is null
                 and a.code = regexp_replace(r.code, '\.[0-9]+$', ''))
       where not exists (select 1 from acc_accounts x
                          where x.tenant_id = p_tenant and x.code = r.code and x.deleted_at is null);
      if found then
        v_n := v_n + 1;
      end if;
    end if;
  end loop;

  insert into acc_mappings (tenant_id, concept, qualifier, account_id)
  select p_tenant, m.concept, m.qualifier, a.id
    from (values
      ('cobro', 'sena',             'senas'),
      ('cobro', 'plataforma',       'plataformas_a_cobrar'),
      ('cobro', 'mercadolibre',     'ml_a_cobrar'),
      ('cobro', 'ualabis',          'procesadores_a_cobrar'),
      ('cobro', '*:ualabis',        'procesadores_a_cobrar'),
      ('cobro', '*:modo',           'procesadores_a_cobrar'),
      ('cobro', '*:naranjax',       'procesadores_a_cobrar'),
      ('senas', '*',                'senas'),
      ('tesoreria_apertura', '*',   'rna'),
      ('tesoreria', 'wallet',       'billeteras'),
      ('tesoreria', 'pos_cash',     'caja'),
      ('acreditacion', 'ualabis',   'billeteras'),
      ('acreditacion', 'modo',      'billeteras'),
      ('acreditacion', 'naranjax',  'billeteras'),
      ('cheque_cartera', '*',       'valores_a_depositar'),
      ('cheque_recibido', '*',      'otros_a_cobrar')
    ) as m(concept, qualifier, skey)
    join acc_accounts a on a.tenant_id = p_tenant and a.system_key = m.skey and a.deleted_at is null
  on conflict do nothing;
  return v_n;
end;
$$;
revoke all on function acc_template_extend(uuid) from public, anon, authenticated;

-- acc_install_template: definición viva + extensión al final.
create or replace function acc_install_template(p_tenant uuid, p_template text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_store record;
begin
  if p_template is distinct from 'comercial_ar' then
    raise exception 'acc_template_unknown';
  end if;
  if exists (select 1 from acc_accounts where tenant_id = p_tenant and deleted_at is null) then
    raise exception 'acc_already_setup';
  end if;

  create temporary table if not exists acc_tpl (code text, name text, kind text, imputable boolean, skey text) on commit drop;
  truncate acc_tpl;
  insert into acc_tpl (code, name, kind, imputable, skey) values
    ('1',             'ACTIVO',                                          'activo', false, null),
    ('1.1',           'Activo corriente',                                'activo', false, null),
    ('1.1.01',        'Caja y bancos',                                   'activo', false, null),
    ('1.1.01.01',     'Caja (cajas del POS)',                            'activo', true,  'caja'),
    ('1.1.01.02',     'Caja general y fondo fijo',                       'activo', true,  'caja_general'),
    ('1.1.01.03',     'Valores a depositar',                             'activo', true,  'valores_a_depositar'),
    ('1.1.01.04',     'Fondos en tránsito',                              'activo', true,  'fondos_transito'),
    ('1.1.01.05',     'Banco cuenta corriente',                          'activo', true,  'banco'),
    ('1.1.01.06',     'Mercado Pago (saldo en cuenta)',                  'activo', true,  'mp_saldo'),
    ('1.1.02',        'Créditos por ventas',                             'activo', false, null),
    ('1.1.02.01',     'Deudores por ventas (cuenta corriente)',          'activo', true,  'deudores'),
    ('1.1.02.02',     'Tarjetas a cobrar',                               'activo', false, null),
    ('1.1.02.02.01',  'Tarjetas a cobrar Payway (Prisma)',               'activo', true,  'tarjetas_payway'),
    ('1.1.02.02.02',  'Tarjetas a cobrar Fiserv (Posnet y Clover)',      'activo', true,  'tarjetas_fiserv'),
    ('1.1.02.02.03',  'Tarjetas a cobrar Getnet',                        'activo', true,  'tarjetas_getnet'),
    ('1.1.02.02.04',  'Tarjetas a cobrar Nave',                          'activo', true,  'tarjetas_nave'),
    ('1.1.02.02.99',  'Tarjetas a cobrar otros adquirentes',             'activo', true,  'tarjetas_otros'),
    ('1.1.02.03',     'Mercado Pago a cobrar (QR, link y Point)',        'activo', true,  'mp_a_cobrar'),
    ('1.1.02.04',     'Otros medios de cobro a cobrar',                  'activo', true,  'otros_a_cobrar'),
    ('1.1.02.05',     'Cheques rechazados a cobrar',                     'activo', true,  'cheques_rechazados'),
    ('1.1.03',        'Créditos fiscales',                               'activo', false, null),
    ('1.1.03.01',     'IVA crédito fiscal',                              'activo', true,  'iva_cf'),
    ('1.1.03.02',     'Percepciones de IVA sufridas',                    'activo', true,  'perc_iva'),
    ('1.1.03.03',     'Percepciones de IIBB sufridas',                   'activo', true,  'perc_iibb'),
    ('1.1.03.04',     'Percepciones de Ganancias sufridas',              'activo', true,  'perc_ganancias'),
    ('1.1.03.05',     'Retenciones e impuestos sufridos en cobros',      'activo', true,  'ret_cobros'),
    ('1.1.04',        'Bienes de cambio',                                'activo', false, null),
    ('1.1.04.01',     'Mercaderías',                                     'activo', true,  'mercaderias'),
    ('1.2',           'Activo no corriente',                             'activo', false, null),
    ('1.2.01',        'Bienes de uso',                                   'activo', false, null),
    ('1.2.01.01',     'Muebles y útiles',                                'activo', true,  'muebles'),
    ('1.2.01.02',     'Instalaciones',                                   'activo', true,  'instalaciones'),
    ('1.2.01.03',     'Equipos de computación',                          'activo', true,  'equipos'),
    ('2',             'PASIVO',                                          'pasivo', false, null),
    ('2.1',           'Pasivo corriente',                                'pasivo', false, null),
    ('2.1.01',        'Deudas comerciales',                              'pasivo', false, null),
    ('2.1.01.01',     'Proveedores',                                     'pasivo', true,  'proveedores'),
    ('2.1.01.02',     'Cheques diferidos a pagar',                       'pasivo', true,  'cheques_diferidos'),
    ('2.1.01.03',     'Tarjeta corporativa a pagar',                     'pasivo', true,  'tarjeta_corporativa'),
    ('2.1.02',        'Deudas fiscales',                                 'pasivo', false, null),
    ('2.1.02.01',     'IVA débito fiscal',                               'pasivo', true,  'iva_df'),
    ('2.1.02.02',     'IVA a pagar',                                     'pasivo', true,  'iva_a_pagar'),
    ('2.1.02.03',     'Ingresos brutos a pagar',                         'pasivo', true,  'iibb_a_pagar'),
    ('2.1.02.04',     'Retenciones de Ganancias a depositar',            'pasivo', true,  'ret_ganancias'),
    ('2.1.02.05',     'Retenciones de IVA a depositar',                  'pasivo', true,  'ret_iva'),
    ('2.1.02.06',     'Retenciones de IIBB a depositar',                 'pasivo', true,  'ret_iibb'),
    ('2.1.02.07',     'Retenciones SUSS a depositar',                    'pasivo', true,  'ret_suss'),
    ('2.1.02.08',     'Otras retenciones a depositar',                   'pasivo', true,  'ret_otras'),
    ('2.1.03',        'Otras deudas',                                    'pasivo', false, null),
    ('2.1.03.01',     'Saldos a favor de clientes',                      'pasivo', true,  'saldos_clientes'),
    ('2.1.03.02',     'Propinas a pagar al personal',                    'pasivo', true,  'propinas'),
    ('2.1.03.03',     'Sueldos y cargas sociales a pagar',               'pasivo', true,  'sueldos_a_pagar'),
    ('3',             'PATRIMONIO NETO',                                 'patrimonio', false, null),
    ('3.1',           'Capital',                                         'patrimonio', true, 'capital'),
    ('3.2',           'Resultados no asignados',                         'patrimonio', true, 'rna'),
    ('3.3',           'Resultado del ejercicio',                         'patrimonio', true, 'resultado_ejercicio'),
    ('4',             'INGRESOS',                                        'ingreso', false, null),
    ('4.1',           'Ventas',                                          'ingreso', false, null),
    ('4.1.01',        'Ventas de mercaderías',                           'ingreso', true,  'ventas'),
    ('4.1.02',        'Devoluciones sobre ventas',                       'ingreso', true,  'devoluciones_ventas'),
    ('4.2',           'Otros ingresos',                                  'ingreso', false, null),
    ('4.2.01',        'Intereses ganados',                               'ingreso', true,  'intereses_ganados'),
    ('4.2.02',        'Sobrantes de caja',                               'ingreso', true,  'sobrante_caja'),
    ('5',             'EGRESOS',                                         'egreso', false, null),
    ('5.1',           'Costo de mercaderías vendidas',                   'egreso', true,  'cmv'),
    ('5.2',           'Gastos de comercialización',                      'egreso', false, null),
    ('5.2.01',        'Comisiones de procesadores de pago',              'egreso', true,  'comisiones_procesadores'),
    ('5.2.02',        'Comisiones y gastos bancarios',                   'egreso', true,  'gastos_bancarios'),
    ('5.2.03',        'Contracargos y devoluciones de procesadores',     'egreso', true,  'contracargos'),
    ('5.2.04',        'Impuesto sobre los ingresos brutos',              'egreso', true,  'iibb'),
    ('5.3',           'Gastos de administración',                        'egreso', false, null),
    ('5.3.01',        'Alquileres',                                      'egreso', true,  'alquileres'),
    ('5.3.02',        'Servicios',                                       'egreso', true,  'servicios'),
    ('5.3.03',        'Sueldos y cargas sociales',                       'egreso', true,  'sueldos'),
    ('5.3.04',        'Honorarios profesionales',                        'egreso', true,  'honorarios'),
    ('5.3.05',        'Gastos varios',                                   'egreso', true,  'gastos_varios'),
    ('5.4',           'Otros egresos',                                   'egreso', false, null),
    ('5.4.01',        'Faltantes de caja',                               'egreso', true,  'faltante_caja'),
    ('5.4.02',        'Ajustes y bonificaciones a clientes',             'egreso', true,  'ajustes_clientes'),
    ('5.4.03',        'Otros tributos',                                  'egreso', true,  'otros_tributos'),
    ('5.4.04',        'Diferencias de redondeo y conciliación',          'egreso', true,  'redondeo');

  for r in select * from acc_tpl order by length(code), code loop
    insert into acc_accounts (tenant_id, code, name, kind, imputable, system_key, parent_id)
    values (p_tenant, r.code, r.name, r.kind, r.imputable, r.skey,
            (select a.id from acc_accounts a
              where a.tenant_id = p_tenant and a.deleted_at is null
                and a.code = regexp_replace(r.code, '\.[0-9]+$', '')
                and r.code like '%.%'));
  end loop;

  create temporary table if not exists acc_tpl_map (concept text, qualifier text, skey text) on commit drop;
  truncate acc_tpl_map;
  insert into acc_tpl_map (concept, qualifier, skey) values
    -- Cobros: medio de pago y, después de ':', el adquirente o proveedor.
    ('cobro', '*',              'otros_a_cobrar'),
    ('cobro', 'cash',           'caja'),
    ('cobro', 'debit',          'tarjetas_otros'),
    ('cobro', 'credit',         'tarjetas_otros'),
    ('cobro', 'qr',             'mp_a_cobrar'),
    ('cobro', 'transfer',       'banco'),
    ('cobro', 'account',        'deudores'),
    ('cobro', 'store_credit',   'saldos_clientes'),
    ('cobro', 'directo',        'otros_a_cobrar'),
    ('cobro', 'other',          'otros_a_cobrar'),
    ('cobro', '*:payway',       'tarjetas_payway'),
    ('cobro', '*:prisma',       'tarjetas_payway'),
    ('cobro', '*:fiserv',       'tarjetas_fiserv'),
    ('cobro', '*:posnet',       'tarjetas_fiserv'),
    ('cobro', '*:getnet',       'tarjetas_getnet'),
    ('cobro', '*:nave',         'tarjetas_nave'),
    ('cobro', '*:mercadopago',  'mp_a_cobrar'),
    -- Ventas
    ('ventas',               '*', 'ventas'),
    ('devoluciones_ventas',  '*', 'devoluciones_ventas'),
    ('iva_df',               '*', 'iva_df'),
    ('propinas',             '*', 'propinas'),
    ('redondeo',             '*', 'redondeo'),
    ('cmv',                  '*', 'cmv'),
    ('mercaderias',          '*', 'mercaderias'),
    -- Cuenta corriente y caja
    ('intereses_cc',         '*', 'intereses_ganados'),
    ('ajustes_cc',           '*', 'ajustes_clientes'),
    ('faltante_caja',        '*', 'faltante_caja'),
    ('sobrante_caja',        '*', 'sobrante_caja'),
    ('caja_movimiento',      '*', 'fondos_transito'),
    -- Compras y pagos
    ('compras',              '*', 'mercaderias'),
    ('iva_cf',               '*', 'iva_cf'),
    ('percepcion', '*',                    'otros_tributos'),
    ('percepcion', 'percepcion_iva',       'perc_iva'),
    ('percepcion', 'percepcion_iibb',      'perc_iibb'),
    ('percepcion', 'percepcion_ganancias', 'perc_ganancias'),
    ('percepcion', 'impuesto_interno',     'mercaderias'),
    ('proveedores',          '*', 'proveedores'),
    ('pago', '*',              'banco'),
    ('pago', 'efectivo',       'caja'),
    ('pago', 'transferencia',  'banco'),
    ('pago', 'deposito',       'banco'),
    ('pago', 'cheque',         'cheques_diferidos'),
    ('pago', 'cheque_propio',  'cheques_diferidos'),
    ('pago', 'echeq',          'cheques_diferidos'),
    ('pago', 'cheque_tercero', 'valores_a_depositar'),
    ('pago', 'tarjeta',        'tarjeta_corporativa'),
    ('retencion_practicada', '*',         'ret_otras'),
    ('retencion_practicada', 'ganancias', 'ret_ganancias'),
    ('retencion_practicada', 'iva',       'ret_iva'),
    ('retencion_practicada', 'iibb',      'ret_iibb'),
    ('retencion_practicada', 'suss',      'ret_suss'),
    -- Tesorería
    ('tesoreria', '*',    'banco'),
    ('tesoreria', 'cash', 'caja_general'),
    ('tesoreria', 'bank', 'banco'),
    ('tesoreria_mov', '*',               'gastos_bancarios'),
    ('tesoreria_mov', 'deposit',         'fondos_transito'),
    ('tesoreria_mov', 'withdrawal',      'fondos_transito'),
    ('tesoreria_mov', 'cheque_deposit',  'valores_a_depositar'),
    ('tesoreria_mov', 'cheque_debit',    'cheques_diferidos'),
    ('tesoreria_mov', 'cheque_rejected', 'cheques_rechazados'),
    -- Procesadores
    ('comision_procesador',   '*', 'comisiones_procesadores'),
    ('impuestos_procesador',  '*', 'ret_cobros'),
    ('acreditacion',          '*', 'banco'),
    ('acreditacion', 'mercadopago', 'mp_saldo'),
    ('diferencia_procesador', '*', 'redondeo'),
    ('contracargos',          '*', 'contracargos');

  insert into acc_mappings (tenant_id, concept, qualifier, account_id)
  select p_tenant, m.concept, m.qualifier, a.id
    from acc_tpl_map m
    join acc_accounts a on a.tenant_id = p_tenant and a.system_key = m.skey and a.deleted_at is null
  on conflict do nothing;

  for v_store in select id from stores where tenant_id = p_tenant and deleted_at is null order by is_default desc, created_at loop
    perform acc_cost_center_for(p_tenant, v_store.id);
  end loop;

  -- ADR-158: billeteras, señas, procesadores sin cuenta, saldo inicial y cheques.
  perform acc_template_extend(p_tenant);
end;
$$;

-- Negocios que ya activaron la Contabilidad (0 en producción).
do $$
declare
  r record;
begin
  for r in select distinct tenant_id from acc_accounts where deleted_at is null loop
    perform acc_template_extend(r.tenant_id);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3) Cuenta contable de cada cuenta de dinero y de cada cobro.
-- -----------------------------------------------------------------------------
create or replace function acc_treasury_account(p_tenant uuid, p_account uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ta treasury_accounts%rowtype;
  v  uuid;
begin
  select * into ta from treasury_accounts where id = p_account and tenant_id = p_tenant;
  if ta.id is null then
    raise exception 'treasury_account_not_found';
  end if;
  -- Mapeo propio de la cuenta (su subcuenta contable).
  select m.account_id into v
    from acc_mappings m
    join acc_accounts a on a.id = m.account_id and a.deleted_at is null
   where m.tenant_id = p_tenant and m.concept = 'tesoreria'
     and m.qualifier = ta.kind || ':' || ta.id::text
     and (m.store_id is null or m.store_id = ta.store_id)
   order by (m.store_id is null)
   limit 1;
  if v is not null then
    if not exists (select 1 from acc_accounts where id = v and imputable and is_active) then
      raise exception 'acc_account_not_imputable: tesoreria[%]', ta.name;
    end if;
    return v;
  end if;
  if ta.kind = 'pos_cash' then
    return acc_account_for(p_tenant, 'cobro', 'cash', ta.store_id);
  end if;
  if ta.kind = 'receivable' then
    return acc_account_for(p_tenant, 'cobro', '*:' || ta.provider_key, ta.store_id);
  end if;
  if ta.kind = 'wallet' and ta.provider_key is not null and exists (
    select 1 from acc_mappings m
     where m.tenant_id = p_tenant and m.concept = 'acreditacion' and m.qualifier = ta.provider_key) then
    return acc_account_for(p_tenant, 'acreditacion', ta.provider_key, ta.store_id);
  end if;
  return acc_account_for(p_tenant, 'tesoreria', ta.kind || ':' || ta.id::text, ta.store_id);
end;
$$;
revoke all on function acc_treasury_account(uuid, uuid) from public, anon, authenticated;

-- Cuenta del cobro: la transferencia a una cuenta de cobro vinculada a
-- Tesorería (desde su fecha de apertura) va a la cuenta contable de esa cuenta;
-- el resto, por el mapeo 'cobro' de siempre.
create or replace function acc_payment_account(p_tenant uuid, p payments, p_store uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ta uuid;
begin
  if p.method = 'transfer' then
    v_ta := treasury_account_of_payment(p_tenant, p.metadata);
    if v_ta is not null and exists (
      select 1 from treasury_accounts ta
       where ta.id = v_ta and acc_ar_date(coalesce(p.created_at, now())) >= ta.opening_date) then
      return acc_treasury_account(p_tenant, v_ta);
    end if;
  end if;
  return acc_account_for(p_tenant, 'cobro', acc_payment_qualifier(p_tenant, p.method, p.reference, p.card_voucher), p_store);
end;
$$;
revoke all on function acc_payment_account(uuid, payments, uuid) from public, anon, authenticated;

-- acc_sync_sale: definición viva; el cobro sale de acc_payment_account.
create or replace function acc_sync_sale(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s sales%rowtype;
  cfg acc_settings%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_paid numeric := 0;
  v_cash_acc uuid;
  v_diff numeric;
  v_cost numeric;
  p payments%rowtype;
  v record;
  v_items jsonb;
begin
  select * into s from sales where id = p_id and tenant_id = p_tenant;
  if not found or s.status = 'suspended' then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if acc_ar_date(s.created_at) < cfg.start_date then
    return;
  end if;

  if acc_entry_of(p_tenant, 'sale', s.id, 'sale') is null then
    for p in select * from payments where sale_id = s.id and tenant_id = p_tenant order by created_at, id loop
      continue when coalesce(p.amount, 0) = 0;
      v_lines := v_lines || acc_line(acc_payment_account(p_tenant, p, s.store_id), p.amount, 'Cobro ' || p.method);
      v_paid := v_paid + p.amount;
      if p.method = 'cash' then
        v_cash_acc := acc_account_for(p_tenant, 'cobro', 'cash', s.store_id);
      end if;
    end loop;

    if coalesce(s.tip_amount, 0) > 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'propinas', '*', s.store_id), -s.tip_amount, 'Propina');
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('amount', si.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
      into v_items
      from sale_items si left join products pr on pr.id = si.product_id
     where si.sale_id = s.id;
    for v in select * from acc_vat_split(s.total, v_items, cfg.vat_mode, cfg.default_vat_rate) loop
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'ventas', '*', s.store_id), -v.net, 'Ventas');
      if v.vat <> 0 then
        v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'iva_df', acc_rate_text(v.rate), s.store_id),
                                       -v.vat, 'IVA ' || acc_rate_text(v.rate) || ' %');
      end if;
    end loop;

    v_diff := round(v_paid - s.total - coalesce(s.tip_amount, 0), 2);
    if v_diff > 0 and v_cash_acc is not null then
      v_lines := v_lines || acc_line(v_cash_acc, -v_diff, 'Vuelto');
    elsif v_diff <> 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'redondeo', '*', s.store_id), -v_diff, 'Diferencia de cobro');
    end if;

    if cfg.cmv_mode = 'perpetual' then
      select round(coalesce(sum(si.quantity * coalesce(pr.cost, 0)), 0), 2) into v_cost
        from sale_items si join products pr on pr.id = si.product_id
       where si.sale_id = s.id;
      if v_cost > 0 then
        v_lines := v_lines
          || acc_line(acc_account_for(p_tenant, 'cmv', '*', s.store_id), v_cost, 'Costo de lo vendido')
          || acc_line(acc_account_for(p_tenant, 'mercaderias', '*', s.store_id), -v_cost, 'Salida de mercadería');
      end if;
    end if;

    perform acc_post(p_tenant, acc_ar_date(s.created_at), 'sale', s.id, 'sale',
                     'Venta #' || s.number, s.store_id, v_lines);
  end if;

  if s.status = 'voided' then
    perform acc_post_reversal(p_tenant, 'sale', s.id, 'sale', 'void',
                              acc_ar_date(coalesce(s.voided_at, now())), 'Anulación de la venta #' || s.number);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4) Movimientos de Tesorería: moneda, gastos y cheque propio rechazado.
-- -----------------------------------------------------------------------------
create or replace function acc_sync_treasury_movement(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  mv treasury_movements%rowtype;
  cfg acc_settings%rowtype;
  ta treasury_accounts%rowtype;
  tb treasury_accounts%rowtype;
  ch cheques%rowtype;
  v_a uuid;
  v_b uuid;
  v_desc text;
  v_rate numeric;
  v_amt numeric;
  v_vat numeric;
  v_exp text;
  v_lines jsonb;
begin
  select * into mv from treasury_movements where id = p_id and tenant_id = p_tenant;
  -- Los que nacen de otro documento no contabilizan: el asiento es del documento.
  if not found or not treasury_movement_has_own_entry(mv.type) then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if mv.movement_date < cfg.start_date then
    return;
  end if;
  select * into ta from treasury_accounts where id = mv.account_id;
  if mv.expense_account_id is not null then
    select name into v_exp from acc_accounts where id = mv.expense_account_id;
  end if;
  v_desc := case
              when mv.type = 'withdrawal' and mv.expense_account_id is not null then 'Gasto ' || coalesce(v_exp, '')
              else case mv.type
                     when 'deposit' then 'Depósito o ingreso'
                     when 'withdrawal' then 'Retiro o gasto'
                     when 'transfer_out' then 'Transferencia entre cuentas'
                     when 'cheque_deposit' then 'Depósito de cheque'
                     when 'cheque_debit' then 'Débito de cheque propio'
                     when 'cheque_rejected' then 'Cheque rechazado'
                     when 'adjustment' then 'Ajuste de tesorería'
                     else 'Movimiento de tesorería' end
            end
            || ' · ' || ta.name
            || coalesce(' · comp. ' || nullif(btrim(mv.receipt_number), ''), '')
            || coalesce(' · ' || nullif(btrim(mv.description), ''), '');

  if acc_entry_of(p_tenant, 'treasury_movement', mv.id, 'movement') is null then
    v_rate := acc_fx_rate(p_tenant, ta.currency, mv.movement_date);
    v_amt := round(mv.amount * v_rate, 2);
    v_a := acc_treasury_account(p_tenant, ta.id);
    if mv.type = 'transfer_out' then
      select t.* into tb from treasury_movements c join treasury_accounts t on t.id = c.account_id
       where c.id = mv.counterpart_id;
      if tb.id is null then
        raise exception 'acc_transfer_without_counterpart';
      end if;
      v_lines := jsonb_build_array(acc_line(v_a, v_amt, ta.name),
                                   acc_line(acc_treasury_account(p_tenant, tb.id), -v_amt, tb.name));
    elsif mv.type = 'withdrawal' and mv.expense_account_id is not null then
      if not exists (select 1 from acc_accounts a
                      where a.id = mv.expense_account_id and a.tenant_id = p_tenant
                        and a.imputable and a.is_active and a.deleted_at is null) then
        raise exception 'acc_account_not_imputable: gasto[%]', coalesce(v_exp, '?');
      end if;
      -- IVA del comprobante a crédito fiscal sólo si el negocio discrimina IVA.
      v_vat := case when cfg.vat_mode = 'none' then 0
                    else least(round(coalesce(mv.receipt_vat, 0) * v_rate, 2), -v_amt) end;
      v_lines := jsonb_build_array(acc_line(v_a, v_amt, ta.name),
                                   acc_line(mv.expense_account_id, -v_amt - v_vat, coalesce(v_exp, 'Gasto')));
      if v_vat > 0 then
        v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'iva_cf', '*', ta.store_id), v_vat, 'IVA crédito fiscal');
      end if;
    elsif mv.type = 'cheque_rejected' then
      select * into ch from cheques where id = mv.cheque_id;
      -- Cheque propio rechazado: la plata vuelve al banco y la deuda con el
      -- proveedor reaparece (T18). De terceros: cheques rechazados a cobrar.
      if ch.kind = 'own' and ch.delivered_to_supplier_id is not null then
        v_b := acc_account_for(p_tenant, 'proveedores', ch.delivered_to_supplier_id::text, null);
      else
        v_b := acc_account_for(p_tenant, 'tesoreria_mov', mv.type, ta.store_id);
      end if;
      v_lines := jsonb_build_array(acc_line(v_a, v_amt, ta.name), acc_line(v_b, -v_amt));
    else
      v_b := acc_account_for(p_tenant, 'tesoreria_mov', mv.type, ta.store_id);
      v_lines := jsonb_build_array(acc_line(v_a, v_amt, ta.name), acc_line(v_b, -v_amt));
    end if;
    perform acc_post(p_tenant, mv.movement_date, 'treasury_movement', mv.id, 'movement', v_desc, ta.store_id, v_lines);
  end if;

  if mv.voided_at is not null then
    perform acc_post_reversal(p_tenant, 'treasury_movement', mv.id, 'movement', 'void',
                              acc_ar_date(mv.voided_at), 'Anulación ' || v_desc);
  end if;
end;
$$;

-- acc_sync_supplier_payment: definición viva; la cuenta de Tesorería resuelve
-- con acc_treasury_account (billeteras y subcuentas propias).
create or replace function acc_sync_supplier_payment(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sp supplier_payments%rowtype;
  cfg acc_settings%rowtype;
  v_sup text;
  v_lines jsonb := '[]'::jsonb;
  v_credits numeric := 0;
  v_amt numeric;
  v_acc uuid;
  l record;
  e jsonb;
  v_desc text;
  v_has_lines boolean;
begin
  select * into sp from supplier_payments where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if sp.paid_date < cfg.start_date then
    return;
  end if;
  select name into v_sup from suppliers where id = sp.supplier_id;
  v_desc := case when sp.kind = 'order' then 'Orden de pago OP-' || sp.number else 'Pago a proveedor N° ' || sp.number end
            || coalesce(' · ' || v_sup, '');

  if acc_entry_of(p_tenant, 'supplier_payment', sp.id, 'payment') is null then
    v_has_lines := exists (select 1 from supplier_payment_lines where payment_id = sp.id);
    if v_has_lines then
      for l in select * from supplier_payment_lines where payment_id = sp.id order by sort, created_at loop
        v_amt := round(l.amount * sp.fx_rate, 2);
        if l.treasury_account_id is not null and l.method in ('transferencia', 'deposito') then
          v_acc := acc_treasury_account(p_tenant, l.treasury_account_id);
        else
          v_acc := acc_account_for(p_tenant, 'pago', l.method, acc_shift_store(l.cash_shift_id));
        end if;
        v_lines := v_lines || acc_line(v_acc, -v_amt, coalesce(l.reference, l.method));
        v_credits := v_credits + v_amt;
      end loop;
    else
      v_amt := round(sp.net_paid * sp.fx_rate, 2);
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'pago', sp.method, null), -v_amt, coalesce(sp.reference, sp.method));
      v_credits := v_credits + v_amt;
    end if;
    for e in select * from jsonb_array_elements(sp.withholdings) loop
      v_amt := round(coalesce((e ->> 'amount')::numeric, 0) * sp.fx_rate, 2);
      if v_amt <> 0 then
        v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'retencion_practicada', coalesce(e ->> 'kind', 'otro'), null),
                                       -v_amt, 'Retención ' || coalesce(e ->> 'kind', '') || coalesce(' cert. ' || nullif(e ->> 'certificate', ''), ''));
        v_credits := v_credits + v_amt;
      end if;
    end loop;
    v_lines := acc_line(acc_account_for(p_tenant, 'proveedores', sp.supplier_id::text, null), v_credits, v_sup) || v_lines;
    perform acc_post(p_tenant, sp.paid_date, 'supplier_payment', sp.id, 'payment', v_desc, null, v_lines);
  end if;

  if sp.status = 'voided' then
    perform acc_post_reversal(p_tenant, 'supplier_payment', sp.id, 'payment', 'void',
                              acc_ar_date(coalesce(sp.voided_at, now())), 'Anulación ' || v_desc);
  end if;
end;
$$;

-- acc_sync_settlement_line: definición viva + fuente única (H153).
create or replace function acc_sync_settlement_line(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sl settlement_lines%rowtype;
  cfg acc_settings%rowtype;
  p payments%rowtype;
  s sales%rowtype;
  v_store uuid;
  v_prov text;
  v_eff numeric;
  v_fee numeric;
  v_tax numeric;
  v_net numeric;
  v_diff numeric;
  v_date date;
  v_lines jsonb;
begin
  -- Con NubCeo como fuente de los asientos de liquidación (H153) no se genera
  -- nada desde la conciliación propia: evita contar dos veces (T3).
  if acc_settlement_source(p_tenant) <> 'ninjapos' then
    return;
  end if;
  select * into sl from settlement_lines where id = p_id and tenant_id = p_tenant;
  if not found or sl.kind <> 'payment' or not sl.released or sl.payment_id is null then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  v_date := acc_ar_date(coalesce(sl.release_date, sl.operation_at));
  if v_date < cfg.start_date or acc_entry_of(p_tenant, 'settlement_line', sl.id, 'release') is not null then
    return;
  end if;
  select * into p from payments where id = sl.payment_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into s from sales where id = p.sale_id;
  v_store := coalesce(sl.scope_store_id, s.store_id);
  v_prov := regexp_replace(lower(sl.provider_key), '_point$', '');
  v_eff := round(sl.gross - coalesce(sl.refunded, 0), 2);
  if v_eff <= 0 then
    return;
  end if;
  v_fee := round(abs(coalesce(sl.fee, 0)), 2);
  v_tax := round(abs(coalesce(sl.taxes, 0)), 2);
  v_net := round(coalesce(sl.net, 0), 2);
  v_diff := v_eff - v_fee - v_tax - v_net;
  v_lines := jsonb_build_array(
    acc_line(acc_account_for(p_tenant, 'acreditacion', v_prov, v_store), v_net, 'Neto acreditado'),
    acc_line(acc_account_for(p_tenant, 'comision_procesador', v_prov, v_store), v_fee, 'Comisión'),
    acc_line(acc_account_for(p_tenant, 'impuestos_procesador', v_prov, v_store), v_tax, 'Impuestos y retenciones'),
    acc_line(acc_account_for(p_tenant, 'diferencia_procesador', v_prov, v_store), v_diff, 'Diferencia'),
    acc_line(acc_account_for(p_tenant, 'cobro', acc_payment_qualifier(p_tenant, p.method, p.reference, p.card_voucher), v_store),
             -v_eff, 'Cobro liquidado'));
  perform acc_post(p_tenant, v_date, 'settlement_line', sl.id, 'release',
                   'Acreditación ' || sl.provider_key || coalesce(' · venta #' || s.number, ''), v_store, v_lines);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5) Saldo inicial (T10) y cheques (H154).
-- -----------------------------------------------------------------------------
create or replace function acc_sync_treasury_opening(p_tenant uuid, p_id uuid, p_refresh boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ta    treasury_accounts%rowtype;
  cfg   acc_settings%rowtype;
  v_amt numeric := 0;
begin
  select * into ta from treasury_accounts where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if p_refresh then
    perform acc_unpost(p_tenant, 'treasury_account', ta.id, 'opening', 'Saldo inicial actualizado');
  end if;
  if ta.deleted_at is not null or ta.kind not in ('cash', 'bank', 'wallet') or coalesce(ta.opening_balance, 0) = 0
     or ta.opening_date < cfg.start_date then
    return;
  end if;
  if acc_entry_of(p_tenant, 'treasury_account', ta.id, 'opening') is not null then
    return;
  end if;
  v_amt := round(ta.opening_balance * acc_fx_rate(p_tenant, ta.currency, ta.opening_date), 2);
  perform acc_post(p_tenant, ta.opening_date, 'treasury_account', ta.id, 'opening',
                   'Saldo inicial · ' || ta.name, ta.store_id,
                   jsonb_build_array(acc_line(acc_treasury_account(p_tenant, ta.id), v_amt, ta.name),
                                     acc_line(acc_account_for(p_tenant, 'tesoreria_apertura', '*', ta.store_id), -v_amt,
                                              'Saldo inicial')));
end;
$$;

-- Cheques. De terceros: al recibirlo, Valores a depositar contra "Otros medios
-- de cobro a cobrar" (el cobro con medio Otro de la venta o de la cuenta
-- corriente queda cancelado); rechazado sin depositar, Cheques rechazados a
-- cobrar contra Valores a depositar (o contra el proveedor si se había
-- endosado). Propio rechazado antes del débito: la deuda con el proveedor
-- vuelve (Cheques diferidos contra Proveedores).
create or replace function acc_sync_cheque(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c      cheques%rowtype;
  cfg    acc_settings%rowtype;
  v_amt  numeric;
  v_lbl  text;
  v_date date;
  v_meth text;
  v_cr   uuid;
begin
  select * into c from cheques where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  v_lbl := case when c.is_echeq then 'E-cheq ' else 'Cheque ' end || c.number || coalesce(' ' || c.bank_name, '');

  if c.kind = 'third_party' then
    v_date := acc_ar_date(c.created_at);
    if v_date >= cfg.start_date and c.status <> 'anulado'
       and acc_entry_of(p_tenant, 'cheque', c.id, 'receive') is null then
      v_amt := round(c.amount * acc_fx_rate(p_tenant, c.currency, v_date), 2);
      perform acc_post(p_tenant, v_date, 'cheque', c.id, 'receive',
                       'Cheque recibido · ' || v_lbl || coalesce(' · ' || coalesce(c.drawer_name, c.received_from), ''),
                       null,
                       jsonb_build_array(
                         acc_line(acc_account_for(p_tenant, 'cheque_cartera', '*', null), v_amt, v_lbl),
                         acc_line(acc_account_for(p_tenant, 'cheque_recibido',
                                                  case when c.received_from_customer_id is not null then 'customer' else '*' end,
                                                  null), -v_amt)));
    end if;
    if c.status = 'rechazado' and c.deposit_movement_id is null
       and acc_entry_of(p_tenant, 'cheque', c.id, 'receive') is not null
       and acc_entry_of(p_tenant, 'cheque', c.id, 'reject') is null then
      v_date := coalesce(c.rejected_at, acc_ar_date(now()));
      v_amt := round(c.amount * acc_fx_rate(p_tenant, c.currency, v_date), 2);
      v_cr := case when c.delivered_to_supplier_id is not null
                   then acc_account_for(p_tenant, 'proveedores', c.delivered_to_supplier_id::text, null)
                   else acc_account_for(p_tenant, 'cheque_cartera', '*', null) end;
      perform acc_post(p_tenant, v_date, 'cheque', c.id, 'reject', 'Cheque rechazado · ' || v_lbl, null,
                       jsonb_build_array(
                         acc_line(acc_account_for(p_tenant, 'tesoreria_mov', 'cheque_rejected', null), v_amt, v_lbl),
                         acc_line(v_cr, -v_amt)));
    end if;
  elsif c.status = 'rechazado' and c.deposit_movement_id is null and c.delivered_to_supplier_id is not null
        and c.payment_id is not null
        and acc_entry_of(p_tenant, 'supplier_payment', c.payment_id, 'payment') is not null
        and acc_entry_of(p_tenant, 'cheque', c.id, 'reject') is null then
    select l.method into v_meth from supplier_payment_lines l where l.cheque_id = c.id limit 1;
    v_date := coalesce(c.rejected_at, acc_ar_date(now()));
    v_amt := round(c.amount * acc_fx_rate(p_tenant, c.currency, v_date), 2);
    perform acc_post(p_tenant, v_date, 'cheque', c.id, 'reject', 'Cheque propio rechazado · ' || v_lbl, null,
                     jsonb_build_array(
                       acc_line(acc_account_for(p_tenant, 'pago', coalesce(v_meth, 'cheque_propio'), null), v_amt, v_lbl),
                       acc_line(acc_account_for(p_tenant, 'proveedores', c.delivered_to_supplier_id::text, null), -v_amt)));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6) Señas (T17): acc_sync_cash_movement (definición viva + señas).
-- -----------------------------------------------------------------------------
create or replace function acc_sync_cash_movement(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cm cash_movements%rowtype;
  cfg acc_settings%rowtype;
  d appointment_deposits%rowtype;
  v_store uuid;
  v_caja uuid;
  v_other uuid;
  v_amt numeric;
  v_in boolean;
begin
  select * into cm from cash_movements where id = p_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if acc_ar_date(cm.created_at) < cfg.start_date then
    return;
  end if;
  v_amt := abs(coalesce(cm.amount, 0));
  if v_amt = 0 then
    return;
  end if;
  v_store := acc_shift_store(cm.cash_shift_id);

  -- Ingreso o retiro manual del cajón (como siempre).
  if cm.type in ('income', 'expense') and cm.reference_id is null then
    v_caja := acc_account_for(p_tenant, 'cobro', 'cash', v_store);
    v_other := acc_account_for(p_tenant, 'caja_movimiento', cm.type, v_store);
    perform acc_post(p_tenant, acc_ar_date(cm.created_at), 'cash_movement', cm.id, 'main',
      coalesce(nullif(btrim(cm.reason), ''), case cm.type when 'income' then 'Ingreso de caja' else 'Retiro de caja' end),
      v_store,
      case cm.type when 'income' then
        jsonb_build_array(acc_line(v_caja, v_amt), acc_line(v_other, -v_amt))
      else
        jsonb_build_array(acc_line(v_other, v_amt), acc_line(v_caja, -v_amt))
      end);
    return;
  end if;

  -- Seña de un turno (ADR-082/088): cobrada o devuelta, con el medio de la seña.
  if cm.type not in ('income', 'expense', 'deposit_in', 'deposit_out') or cm.reference_id is null then
    return;
  end if;
  select * into d from appointment_deposits where id = cm.reference_id and tenant_id = p_tenant;
  if not found then
    return;
  end if;
  v_store := coalesce(v_store, d.store_id);
  v_in := cm.type in ('income', 'deposit_in');
  v_caja := acc_account_for(p_tenant, 'cobro', acc_payment_qualifier(p_tenant, d.method, d.reference, null), v_store);
  v_other := acc_account_for(p_tenant, 'senas', '*', v_store);
  perform acc_post(p_tenant, acc_ar_date(cm.created_at), 'cash_movement', cm.id, 'main',
    case when v_in then 'Seña de turno' else 'Devolución de seña' end
      || coalesce(' · ' || nullif(btrim(cm.reason), ''), ''),
    v_store,
    case when v_in then
      jsonb_build_array(acc_line(v_caja, v_amt, 'Cobro ' || d.method), acc_line(v_other, -v_amt, 'Seña'))
    else
      jsonb_build_array(acc_line(v_other, v_amt, 'Seña'), acc_line(v_caja, -v_amt, 'Devolución ' || d.method))
    end);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7) Despachador, regeneración por documento y fechas argentinas.
-- -----------------------------------------------------------------------------
create or replace function acc_sync(p_tenant uuid, p_type text, p_id uuid, p_refresh boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  case p_type
    when 'sale' then perform acc_sync_sale(p_tenant, p_id);
    when 'sale_return' then perform acc_sync_sale_return(p_tenant, p_id);
    when 'cc_movement' then perform acc_sync_cc_movement(p_tenant, p_id, p_refresh);
    when 'cash_shift' then perform acc_sync_cash_shift(p_tenant, p_id);
    when 'cash_movement' then perform acc_sync_cash_movement(p_tenant, p_id);
    when 'supplier_invoice' then perform acc_sync_supplier_invoice(p_tenant, p_id, p_refresh);
    when 'supplier_payment' then perform acc_sync_supplier_payment(p_tenant, p_id);
    when 'treasury_movement' then perform acc_sync_treasury_movement(p_tenant, p_id);
    when 'treasury_account' then perform acc_sync_treasury_opening(p_tenant, p_id, p_refresh);
    when 'cheque' then perform acc_sync_cheque(p_tenant, p_id);
    when 'settlement_line' then perform acc_sync_settlement_line(p_tenant, p_id);
    when 'payment_dispute' then perform acc_sync_payment_dispute(p_tenant, p_id);
    when 'tax_suffered' then perform acc_sync_tax_suffered(p_tenant, p_id, p_refresh);
    when 'iibb_liquidation' then perform acc_sync_iibb_liquidation(p_tenant, p_id);
    else raise exception 'acc_source_unknown: %', p_type;
  end case;
end;
$$;

-- acc_sync_safe: definición viva; el problema con la fecha de Argentina.
create or replace function acc_sync_safe(p_tenant uuid, p_type text, p_id uuid, p_refresh boolean default false)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_msg text;
begin
  begin
    perform acc_sync(p_tenant, p_type, p_id, p_refresh);
  exception when others then
    v_msg := left(sqlerrm, 500);
    insert into acc_issues (tenant_id, source_type, source_id, message, event_date)
    values (p_tenant, p_type, p_id, v_msg, acc_ar_date(now()))
    on conflict (tenant_id, source_type, source_id) do update
       set message = excluded.message, attempts = acc_issues.attempts + 1, updated_at = now(),
           resolved_at = null, dismissed_at = null, dismissed_by = null;
    return false;
  end;
  update acc_issues set resolved_at = now(), updated_at = now()
   where tenant_id = p_tenant and source_type = p_type and source_id = p_id and resolved_at is null;
  return true;
end;
$$;

-- acc_generate: definición viva reordenada. Primero la lista de documentos del
-- rango (por la fecha de cada documento) y, al regenerar, se dan de baja sólo
-- los asientos automáticos de ESOS documentos en meses abiertos (T20).
create or replace function acc_generate(p_from date, p_to date, p_regenerate boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  cfg acc_settings%rowtype;
  v_from timestamptz;
  v_to timestamptz;
  v_deleted int := 0;
  v_before int;
  v_after int;
  v_failed int := 0;
  r record;
begin
  select * into cfg from acc_settings where tenant_id = v_tenant;
  if not found then
    raise exception 'acc_not_setup';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'acc_range_invalid';
  end if;
  v_from := acc_ar_start(p_from);
  v_to := acc_ar_start(p_to + 1);

  create temporary table if not exists acc_gen_docs (ord int, t text, id uuid) on commit drop;
  truncate acc_gen_docs;
  insert into acc_gen_docs (ord, t, id)
    select 1, 'sale', id from sales
     where tenant_id = v_tenant and status <> 'suspended'
       and ((created_at >= v_from and created_at < v_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 2, 'sale_return', id from sale_returns
     where tenant_id = v_tenant and created_at >= v_from and created_at < v_to
    union all
    select 3, 'cc_movement', id from customer_account_movements
     where tenant_id = v_tenant
       and (kind in ('payment', 'interest', 'interest_waiver', 'adjust_debit', 'adjust_credit')
            or (kind = 'charge' and sale_id is null))
       and ((created_at >= v_from and created_at < v_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 4, 'cash_shift', id from cash_shifts
     where tenant_id = v_tenant and status = 'closed' and closed_at >= v_from and closed_at < v_to
    union all
    select 5, 'cash_movement', cm.id from cash_movements cm
     where cm.tenant_id = v_tenant and cm.created_at >= v_from and cm.created_at < v_to
       and ((cm.type in ('income', 'expense') and cm.reference_id is null)
            or (cm.type in ('income', 'expense', 'deposit_in', 'deposit_out')
                and exists (select 1 from appointment_deposits d where d.id = cm.reference_id and d.tenant_id = v_tenant)))
    union all
    select 6, 'supplier_invoice', id from supplier_invoices
     where tenant_id = v_tenant
       and ((issue_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 7, 'supplier_payment', id from supplier_payments
     where tenant_id = v_tenant
       and ((paid_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 8, 'treasury_account', id from treasury_accounts
     where tenant_id = v_tenant and kind in ('cash', 'bank', 'wallet') and opening_balance <> 0
       and opening_date between p_from and p_to
    union all
    select 9, 'cheque', id from cheques
     where tenant_id = v_tenant
       and ((created_at >= v_from and created_at < v_to) or (rejected_at between p_from and p_to))
    union all
    select 10, 'treasury_movement', id from treasury_movements
     where tenant_id = v_tenant and treasury_movement_has_own_entry(type)
       and ((movement_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 11, 'settlement_line', id from settlement_lines
     where tenant_id = v_tenant and kind = 'payment' and released and payment_id is not null
       and coalesce(release_date, operation_at) >= v_from and coalesce(release_date, operation_at) < v_to
    union all
    select 12, 'payment_dispute', id from payment_disputes
     where tenant_id = v_tenant and origin = 'provider'
       and coalesce(resolved_at, last_seen_at, occurred_at) >= v_from
       and coalesce(resolved_at, last_seen_at, occurred_at) < v_to
    -- Después de sus documentos (la reclasificación necesita el asiento del
    -- documento vinculado).
    union all
    select 13, 'tax_suffered', id from tax_suffered_entries
     where tenant_id = v_tenant
       and ((operation_date between p_from and p_to) or (voided_at >= v_from and voided_at < v_to))
    union all
    select 14, 'iibb_liquidation', id from iibb_liquidations
     where tenant_id = v_tenant
       and (((period + interval '1 month' - interval '1 day')::date between p_from and p_to)
            or (voided_at >= v_from and voided_at < v_to));

  if p_regenerate then
    with del as (
      update acc_entries e
         set deleted_at = now(), deleted_by = auth.uid(), delete_reason = 'Regeneración del período'
        from acc_gen_docs d
       where e.tenant_id = v_tenant and e.kind = 'auto' and e.deleted_at is null
         and e.source_type = d.t and e.source_id = d.id
         and not acc_period_is_closed(v_tenant, e.entry_date)
      returning 1
    )
    select count(*) into v_deleted from del;
  end if;

  select count(*) into v_before from acc_entries where tenant_id = v_tenant and deleted_at is null;

  for r in select t, id from acc_gen_docs order by ord loop
    if not acc_sync_safe(v_tenant, r.t, r.id) then
      v_failed := v_failed + 1;
    end if;
  end loop;

  select count(*) into v_after from acc_entries where tenant_id = v_tenant and deleted_at is null;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'acc_entries', null, case when p_regenerate then 'acc_regenerate' else 'acc_generate' end,
          jsonb_build_object('from', p_from, 'to', p_to, 'deleted', v_deleted,
                             'created', v_after - v_before, 'failed', v_failed));
  return jsonb_build_object('deleted', v_deleted, 'created', v_after - v_before, 'failed', v_failed);
end;
$$;

-- acc_period_close: definición viva; "mes terminado" según el día de Argentina.
create or replace function acc_period_close(p_period date, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  cfg acc_settings%rowtype;
  v_p date := (date_trunc('month', p_period::timestamp))::date;
  v_fy date;
  v_base bigint;
  v_count int;
  v_total numeric;
  v_issues int;
begin
  select * into cfg from acc_settings where tenant_id = v_tenant;
  if not found then
    raise exception 'acc_not_setup';
  end if;
  if v_p >= (date_trunc('month', acc_ar_date(now())::timestamp))::date then
    raise exception 'acc_period_not_ended';
  end if;
  if acc_period_is_closed(v_tenant, v_p) then
    raise exception 'acc_period_already_closed';
  end if;
  if exists (select 1 from acc_entries e
              where e.tenant_id = v_tenant and e.deleted_at is null and e.period < v_p
                and not acc_period_is_closed(v_tenant, e.period)) then
    raise exception 'acc_previous_period_open';
  end if;

  v_fy := make_date(case when extract(month from v_p) >= cfg.fiscal_year_start_month
                         then extract(year from v_p)::int else extract(year from v_p)::int - 1 end,
                    cfg.fiscal_year_start_month, 1);
  select coalesce(max(official_number), 0) into v_base
    from acc_entries
   where tenant_id = v_tenant and deleted_at is null and period >= v_fy and period < v_p;

  with numbered as (
    select id, row_number() over (order by entry_date, number) + v_base as n
      from acc_entries
     where tenant_id = v_tenant and period = v_p and deleted_at is null
  )
  update acc_entries e set official_number = numbered.n
    from numbered where e.id = numbered.id;

  select count(*), coalesce(sum(total), 0) into v_count, v_total
    from acc_entries where tenant_id = v_tenant and period = v_p and deleted_at is null;
  select count(*) into v_issues
    from acc_issues where tenant_id = v_tenant and resolved_at is null and dismissed_at is null;

  insert into acc_periods (tenant_id, period, status, closed_at, closed_by, notes)
  values (v_tenant, v_p, 'closed', now(), auth.uid(), nullif(btrim(coalesce(p_notes, '')), ''))
  on conflict (tenant_id, period) do update
     set status = 'closed', closed_at = now(), closed_by = auth.uid(),
         notes = coalesce(excluded.notes, acc_periods.notes), updated_at = now();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'acc_periods', null, 'acc_period_closed',
          jsonb_build_object('period', v_p, 'entries', v_count, 'total', v_total, 'open_issues', v_issues));
  return jsonb_build_object('entries', v_count, 'total', v_total, 'open_issues', v_issues);
end;
$$;

-- acc_entry_reverse: definición viva; sin fecha, el día de Argentina.
create or replace function acc_entry_reverse(p_id uuid, p_reason text, p_date date default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  e acc_entries%rowtype;
  v_rev uuid;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'reason_required';
  end if;
  select * into e from acc_entries where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'acc_entry_not_found';
  end if;
  if e.kind not in ('manual', 'opening') then
    raise exception 'acc_entry_auto_reverse';
  end if;
  if e.reversed_by is not null then
    raise exception 'acc_entry_already_reversed';
  end if;
  v_rev := acc_post(v_tenant, coalesce(p_date, acc_ar_date(now())), 'acc_entry', e.id, 'reverse',
                    'Reversión del asiento N° ' || e.number || ': ' || btrim(p_reason), e.store_id,
                    acc_reverse_lines(e.id), 'reversal', e.id);
  update acc_entries set reversed_by = v_rev where id = e.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'acc_entries', e.id, 'acc_entry_reversed', p_reason,
          jsonb_build_object('reversal_id', v_rev));
  return v_rev;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8) Triggers diferidos (nunca frenan la operación).
-- -----------------------------------------------------------------------------
drop trigger if exists acc_treasury_movements_ins on treasury_movements;
create constraint trigger acc_treasury_movements_ins
  after insert on treasury_movements
  deferrable initially deferred
  for each row when (new.type <> all (array['supplier_payment', 'supplier_payment_void', 'transfer_in',
                                            'sale_collection', 'sale_collection_void']))
  execute function acc_source_trg('treasury_movement');

drop trigger if exists acc_treasury_movements_void on treasury_movements;
create constraint trigger acc_treasury_movements_void
  after update on treasury_movements
  deferrable initially deferred
  for each row when (old.voided_at is distinct from new.voided_at
                     and new.type <> all (array['supplier_payment', 'supplier_payment_void', 'transfer_in',
                                               'sale_collection', 'sale_collection_void']))
  execute function acc_source_trg('treasury_movement');

drop trigger if exists acc_cash_movements_ins on cash_movements;
create constraint trigger acc_cash_movements_ins
  after insert on cash_movements
  deferrable initially deferred
  for each row when ((new.type in ('income', 'expense') and new.reference_id is null)
                     or (new.type in ('income', 'expense', 'deposit_in', 'deposit_out') and new.reference_id is not null))
  execute function acc_source_trg('cash_movement');

drop trigger if exists acc_treasury_accounts_opening on treasury_accounts;
create constraint trigger acc_treasury_accounts_opening
  after insert or update of opening_balance, opening_date, currency, deleted_at on treasury_accounts
  deferrable initially deferred
  for each row when (new.kind in ('cash', 'bank', 'wallet'))
  execute function acc_source_trg('treasury_account', 'refresh');

drop trigger if exists acc_cheques_sync on cheques;
create constraint trigger acc_cheques_sync
  after insert or update of status on cheques
  deferrable initially deferred
  for each row
  execute function acc_source_trg('cheque');

-- -----------------------------------------------------------------------------
-- 9) "Ver asiento" y subcuenta contable de una cuenta de Tesorería.
-- -----------------------------------------------------------------------------
-- Asientos de un documento. Para un movimiento de Tesorería resuelve el
-- documento que lo generó (la venta de un cobro por transferencia, la orden de
-- pago, la pata que sale de una transferencia); para un cheque suma los
-- asientos de sus movimientos (depósito, débito, rechazo).
create or replace function acc_entry_lookup(p_source_type text, p_source_id uuid)
returns table (id uuid, number bigint, entry_date date, description text, source_type text, source_id uuid,
               source_event text, total numeric, kind text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_type   text := p_source_type;
  v_id     uuid := p_source_id;
  mv       treasury_movements%rowtype;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if not acc_can_read() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_source_type = 'treasury_movement' then
    select * into mv from treasury_movements m where m.id = p_source_id and m.tenant_id = v_tenant;
    if mv.type in ('sale_collection', 'sale_collection_void') then
      v_type := 'sale';
      v_id := mv.sale_id;
    elsif mv.type in ('supplier_payment', 'supplier_payment_void') then
      v_type := 'supplier_payment';
      v_id := mv.reference_id;
    elsif mv.type = 'transfer_in' then
      v_id := mv.counterpart_id;
    end if;
  end if;
  return query
    select e.id, e.number, e.entry_date, e.description, e.source_type, e.source_id, e.source_event, e.total, e.kind
      from acc_entries e
     where e.tenant_id = v_tenant and e.deleted_at is null
       and ((e.source_type = v_type and e.source_id = v_id)
            or (p_source_type = 'cheque' and e.source_type = 'treasury_movement'
                and e.source_id in (select m.id from treasury_movements m
                                     where m.tenant_id = v_tenant and m.cheque_id = p_source_id)))
     order by e.entry_date, e.number;
end;
$$;
revoke all on function acc_entry_lookup(text, uuid) from public, anon;
grant execute on function acc_entry_lookup(text, uuid) to authenticated;

-- Subcuenta contable propia de una cuenta de Tesorería (al lado de "Banco
-- cuenta corriente", en Caja y bancos) y su mapeo. Idempotente.
create or replace function treasury_account_ledger_create(p_account uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  ta       treasury_accounts%rowtype;
  v_q      text;
  v_acc    uuid;
  v_parent acc_accounts%rowtype;
  v_next   int;
  v_code   text;
  v_name   text;
begin
  if not exists (select 1 from acc_settings where tenant_id = v_tenant) then
    raise exception 'acc_not_setup';
  end if;
  select * into ta from treasury_accounts
   where id = p_account and tenant_id = v_tenant and deleted_at is null;
  if ta.id is null then
    raise exception 'treasury_account_not_found';
  end if;
  if ta.kind not in ('cash', 'bank', 'wallet') then
    raise exception 'treasury_system_account';
  end if;
  v_q := ta.kind || ':' || ta.id::text;
  select m.account_id into v_acc from acc_mappings m
   where m.tenant_id = v_tenant and m.concept = 'tesoreria' and m.qualifier = v_q and m.store_id is null;
  if v_acc is not null then
    return v_acc;
  end if;

  select p.* into v_parent
    from acc_accounts a join acc_accounts p on p.id = a.parent_id
   where a.tenant_id = v_tenant and a.system_key = 'banco' and a.deleted_at is null;
  if v_parent.id is null then
    raise exception 'acc_account_parent_missing';
  end if;
  select coalesce(max(nullif(regexp_replace(c.code, '^.*\.', ''), '')::int), 0) + 1 into v_next
    from acc_accounts c
   where c.tenant_id = v_tenant and c.parent_id = v_parent.id and c.code ~ ('^' || replace(v_parent.code, '.', '\.') || '\.[0-9]+$');
  v_code := v_parent.code || '.' || lpad(v_next::text, 2, '0');
  while exists (select 1 from acc_accounts where tenant_id = v_tenant and code = v_code and deleted_at is null) loop
    v_next := v_next + 1;
    v_code := v_parent.code || '.' || lpad(v_next::text, 2, '0');
  end loop;
  v_name := left(case ta.kind
                   when 'bank' then 'Banco ' || ta.name
                   when 'wallet' then 'Billetera ' || ta.name
                   else 'Caja ' || ta.name end
                 || case when ta.currency <> 'ARS' then ' (' || ta.currency || ')' else '' end, 120);

  insert into acc_accounts (tenant_id, code, name, kind, imputable, parent_id, notes)
  values (v_tenant, v_code, v_name, 'activo', true, v_parent.id, 'Cuenta de Tesorería: ' || ta.name)
  returning id into v_acc;
  insert into acc_mappings (tenant_id, concept, qualifier, store_id, account_id, updated_by)
  values (v_tenant, 'tesoreria', v_q, null, v_acc, auth.uid());

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'acc_accounts', v_acc, 'treasury_ledger_account_created',
          jsonb_build_object('treasury_account_id', ta.id, 'code', v_code, 'name', v_name));
  return v_acc;
end;
$$;
revoke all on function treasury_account_ledger_create(uuid) from public, anon;
grant execute on function treasury_account_ledger_create(uuid) to authenticated;
