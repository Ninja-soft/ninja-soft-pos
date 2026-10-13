// =============================================================================
// Respuestas SOAP de ARCA para los tests (ADR-072). Armadas con la estructura
// del WSDL de WSFEv1 (https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL,
// descargado el 2026-10-13: FEHeaderInfo, FEDetResponse, FECAEAGet,
// FECAEASinMovResponse, etc.) y la especificación de WSAA. FEDUMMY_OK es la
// respuesta real de homologación del 2026-10-13. Nunca se llama a ARCA desde
// los tests.
// =============================================================================

const env = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Header><FEHeaderInfo xmlns="http://ar.gov.afip.dif.FEV1/"><ambiente>HomologacionExterno - srt</ambiente><fecha>2026-10-13T10:15:01.1234567-03:00</fecha><id>7.0.0.53</id></FEHeaderInfo></soap:Header><soap:Body>${body}</soap:Body></soap:Envelope>`;

export const FEDUMMY_OK =
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Header><FEHeaderInfo xmlns="http://ar.gov.afip.dif.FEV1/"><ambiente>HomologacionExterno - srt</ambiente><fecha>2026-10-13T00:25:17.2069772-03:00</fecha><id>7.0.0.53</id></FEHeaderInfo></soap:Header><soap:Body><FEDummyResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEDummyResult><AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer></FEDummyResult></FEDummyResponse></soap:Body></soap:Envelope>`;

// --- WSAA -----------------------------------------------------------------------
const loginTicket = (exp: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<loginTicketResponse version="1.0">
    <header>
        <source>CN=wsaahomo, O=AFIP, C=AR, SERIALNUMBER=CUIT 33693450239</source>
        <destination>SERIALNUMBER=CUIT 20378923450, CN=ninjaposhomo</destination>
        <uniqueId>2918234411</uniqueId>
        <generationTime>2026-10-13T12:05:12.345-03:00</generationTime>
        <expirationTime>${exp}</expirationTime>
    </header>
    <credentials>
        <token>PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pgo8c3NvIHZlcnNpb249IjIuMCI+</token>
        <sign>bWkgZmlybWEgZGUgcHJ1ZWJh+/=</sign>
    </credentials>
</loginTicketResponse>`;

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const WSAA_LOGIN_OK = (exp = "2026-10-14T00:05:12.345-03:00") =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body><loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>${xmlEscape(loginTicket(exp))}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`;

const wsaaFault = (code: string, msg: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body><soapenv:Fault><faultcode xmlns:ns1="http://xml.apache.org/axis/">ns1:${code}</faultcode><faultstring>${msg}</faultstring><detail><ns2:exceptionName xmlns:ns2="http://xml.apache.org/axis/">gov.afip.desein.dvadac.sua.view.wsaa.LoginFault</ns2:exceptionName><ns3:hostname xmlns:ns3="http://xml.apache.org/axis/">wsaaext1.homo.afip.gov.ar</ns3:hostname></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>`;

export const WSAA_FAULT_ALREADY = wsaaFault("coe.alreadyAuthenticated", "El CEE ya posee un TA valido para el acceso al WSN solicitado");
export const WSAA_FAULT_EXPIRED = wsaaFault("cms.cert.expired", "Certificado expirado");
export const WSAA_FAULT_NOT_AUTHORIZED = wsaaFault("coe.notAuthorized", "Computador no autorizado a acceder al servicio");

// --- WSFE -----------------------------------------------------------------------
export const ULTIMO = (nro: number, pv = 3, tipo = 6) =>
  env(`<FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompUltimoAutorizadoResult><PtoVta>${pv}</PtoVta><CbteTipo>${tipo}</CbteTipo><CbteNro>${nro}</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>`);

export const ULTIMO_ERR = (code: string, msg: string) =>
  env(`<FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompUltimoAutorizadoResult><PtoVta>0</PtoVta><CbteTipo>0</CbteTipo><CbteNro>0</CbteNro><Errors><Err><Code>${code}</Code><Msg>${msg}</Msg></Err></Errors></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>`);

export const CAE_APROBADO = (nro: number, cae = "76412345678901", vto = "20261023", fch = "20261013") =>
  env(`<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>30500000003</Cuit><PtoVta>3</PtoVta><CbteTipo>6</CbteTipo><FchProceso>20261013101501</FchProceso><CantReg>1</CantReg><Resultado>A</Resultado><Reproceso>N</Reproceso></FeCabResp><FeDetResp><FECAEDetResponse><Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro><CbteDesde>${nro}</CbteDesde><CbteHasta>${nro}</CbteHasta><CbteFch>${fch}</CbteFch><Resultado>A</Resultado><CAE>${cae}</CAE><CAEFchVto>${vto}</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`);

export const CAE_RECHAZADO_OBS = (nro: number) =>
  env(`<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>30500000003</Cuit><PtoVta>3</PtoVta><CbteTipo>1</CbteTipo><FchProceso>20261013101501</FchProceso><CantReg>1</CantReg><Resultado>R</Resultado><Reproceso>N</Reproceso></FeCabResp><FeDetResp><FECAEDetResponse><Concepto>1</Concepto><DocTipo>80</DocTipo><DocNro>30712345671</DocNro><CbteDesde>${nro}</CbteDesde><CbteHasta>${nro}</CbteHasta><CbteFch>20261013</CbteFch><Resultado>R</Resultado><Observaciones><Obs><Code>10013</Code><Msg>Para comprobantes clase A, M o B, si se informa DocTipo 80 (CUIT), DocNro debe ser una CUIT valida.</Msg></Obs><Obs><Code>10242</Code><Msg>El campo Condicion Frente al IVA del receptor no es valido para el comprobante clase A informado.</Msg></Obs></Observaciones><CAE></CAE><CAEFchVto></CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`);

export const CAE_ERR = (code: string, msg: string) =>
  env(`<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>30500000003</Cuit><PtoVta>3</PtoVta><CbteTipo>6</CbteTipo><FchProceso>20261013101501</FchProceso><CantReg>1</CantReg><Resultado>R</Resultado><Reproceso>N</Reproceso></FeCabResp><Errors><Err><Code>${code}</Code><Msg>${msg}</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse>`);

export const CAE_NUMERACION = CAE_ERR(
  "10016",
  "El numero o fecha del comprobante no se corresponde con el proximo a autorizar. Consultar metodo FECompUltimoAutorizado.",
);
export const CAE_TRANSITORIO = CAE_ERR("501", "Error interno de base de datos");

export const CONSULTA = (nro: number, cae: string, total: string, docNro = "0") =>
  env(`<FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>${docNro}</DocNro><CbteDesde>${nro}</CbteDesde><CbteHasta>${nro}</CbteHasta><CbteFch>20261013</CbteFch><ImpTotal>${total}</ImpTotal><ImpTotConc>0</ImpTotConc><ImpNeto>100</ImpNeto><ImpOpEx>0</ImpOpEx><ImpTrib>0</ImpTrib><ImpIVA>21</ImpIVA><FchServDesde /><FchServHasta /><FchVtoPago /><MonId>PES</MonId><MonCotiz>1</MonCotiz><Iva><AlicIva><Id>5</Id><BaseImp>100</BaseImp><Importe>21</Importe></AlicIva></Iva><Resultado>A</Resultado><CodAutorizacion>${cae}</CodAutorizacion><EmisionTipo>CAE</EmisionTipo><FchVto>20261023</FchVto><FchProceso>20261013101501</FchProceso><PtoVta>3</PtoVta><CbteTipo>6</CbteTipo></ResultGet></FECompConsultarResult></FECompConsultarResponse>`);

export const PTOS_VENTA = env(
  `<FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEParamGetPtosVentaResult><ResultGet><PtoVenta><Nro>3</Nro><EmisionTipo>CAE - RECE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta><PtoVenta><Nro>4</Nro><EmisionTipo>CAE - RECE</EmisionTipo><Bloqueado>S</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta><PtoVenta><Nro>90</Nro><EmisionTipo>CAEA - RECE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta></ResultGet></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse>`,
);

export const PTOS_VENTA_VACIO = env(
  `<FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEParamGetPtosVentaResult><Errors><Err><Code>602</Code><Msg>Sin Resultados: - Metodo FEParamGetPtosVenta</Msg></Err></Errors></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse>`,
);

export const TIPOS_IVA = env(
  `<FEParamGetTiposIvaResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEParamGetTiposIvaResult><ResultGet><IvaTipo><Id>3</Id><Desc>0%</Desc><FchDesde>20090220</FchDesde><FchHasta>NULL</FchHasta></IvaTipo><IvaTipo><Id>4</Id><Desc>10.5%</Desc><FchDesde>20090220</FchDesde><FchHasta>NULL</FchHasta></IvaTipo><IvaTipo><Id>5</Id><Desc>21%</Desc><FchDesde>20090220</FchDesde><FchHasta>NULL</FchHasta></IvaTipo></ResultGet></FEParamGetTiposIvaResult></FEParamGetTiposIvaResponse>`,
);

// --- CAEA -----------------------------------------------------------------------
export const CAEA_OTORGADO = (periodo = 202610, orden = 2, caea = "31423456789012") =>
  env(`<FECAEASolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAEASolicitarResult><ResultGet><CAEA>${caea}</CAEA><Periodo>${periodo}</Periodo><Orden>${orden}</Orden><FchVigDesde>20261016</FchVigDesde><FchVigHasta>20261031</FchVigHasta><FchTopeInf>20261108</FchTopeInf><FchProceso>20261011093000</FchProceso></ResultGet></FECAEASolicitarResult></FECAEASolicitarResponse>`);

export const CAEA_YA_SOLICITADO = env(
  `<FECAEASolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAEASolicitarResult><Errors><Err><Code>15008</Code><Msg>Existe un CAEA otorgado para el periodo y orden solicitado</Msg></Err></Errors></FECAEASolicitarResult></FECAEASolicitarResponse>`,
);

export const CAEA_CONSULTA = (periodo = 202610, orden = 2, caea = "31423456789012") =>
  env(`<FECAEAConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAEAConsultarResult><ResultGet><CAEA>${caea}</CAEA><Periodo>${periodo}</Periodo><Orden>${orden}</Orden><FchVigDesde>20261016</FchVigDesde><FchVigHasta>20261031</FchVigHasta><FchTopeInf>20261108</FchTopeInf><FchProceso>20261011093000</FchProceso></ResultGet></FECAEAConsultarResult></FECAEAConsultarResponse>`);

export const CAEA_INFORMADO = (nro: number, caea = "31423456789012") =>
  env(`<FECAEARegInformativoResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAEARegInformativoResult><FeCabResp><Cuit>30500000003</Cuit><PtoVta>90</PtoVta><CbteTipo>6</CbteTipo><FchProceso>20261020101501</FchProceso><CantReg>1</CantReg><Resultado>A</Resultado><Reproceso>N</Reproceso></FeCabResp><FeDetResp><FECAEADetResponse><Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro><CbteDesde>${nro}</CbteDesde><CbteHasta>${nro}</CbteHasta><CbteFch>20261018</CbteFch><Resultado>A</Resultado><CAEA>${caea}</CAEA></FECAEADetResponse></FeDetResp></FECAEARegInformativoResult></FECAEARegInformativoResponse>`);

export const CAEA_INFORME_RECHAZADO = (nro: number) =>
  env(`<FECAEARegInformativoResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAEARegInformativoResult><FeCabResp><Cuit>30500000003</Cuit><PtoVta>90</PtoVta><CbteTipo>6</CbteTipo><FchProceso>20261020101501</FchProceso><CantReg>1</CantReg><Resultado>R</Resultado><Reproceso>N</Reproceso></FeCabResp><FeDetResp><FECAEADetResponse><Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro><CbteDesde>${nro}</CbteDesde><CbteHasta>${nro}</CbteHasta><CbteFch>20261018</CbteFch><Resultado>R</Resultado><Observaciones><Obs><Code>1504</Code><Msg>El CAEA informado no corresponde al punto de venta.</Msg></Obs></Observaciones><CAEA>31423456789012</CAEA></FECAEADetResponse></FeDetResp></FECAEARegInformativoResult></FECAEARegInformativoResponse>`);

export const CAEA_SIN_MOV_OK = env(
  `<FECAEASinMovimientoInformarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAEASinMovimientoInformarResult><CAEA>31423456789012</CAEA><FchProceso>20261101090000</FchProceso><PtoVta>90</PtoVta><Resultado>A</Resultado></FECAEASinMovimientoInformarResult></FECAEASinMovimientoInformarResponse>`,
);
