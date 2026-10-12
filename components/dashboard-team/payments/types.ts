// Tipos compartidos de la configuración de medios de pago.

// Caja QR de Mercado Pago (Orders API) guardada por ambiente en config.mp_qr.
export type MpQrPos = {
  store_name?: string;
  address?: string;
  external_pos_id?: string;
  store_id?: string;
  pos_id?: string;
  user_id?: string;
  created_at?: string;
};

export type MethodConfig = {
  connected?: boolean;
  test_connected?: boolean;
  mp_qr?: { prod?: MpQrPos; test?: MpQrPos };
};

export type Method = {
  provider_key: string;
  enabled: boolean;
  sandbox: boolean;
  surcharge_pct: number;
  config: MethodConfig | null;
};

export type Env = "prod" | "test";

// Ambiente efectivo de MP: prueba sólo con el switch + token de prueba cargado.
export const mpEnvOf = (m: Method | undefined): Env =>
  m?.sandbox && m.config?.test_connected ? "test" : "prod";

export type MpEnvChange = { env: Env; testToken?: string; clearTest?: boolean };
