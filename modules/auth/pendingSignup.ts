import { isVertical, type Vertical } from "@/lib/verticals/config";
import {
  IVA_CONDITIONS,
  type IvaCondition,
} from "@/modules/auth/signup-schemas";

// Alta pendiente: lo que el dueño cargó en el registro y todavía no se pudo
// usar porque la confirmación de email cortó el flujo (signUp sin sesión).
// Viaja en user_metadata.signup del usuario recién creado; al volver de
// confirmar el email el wizard lo lee y no vuelve a pedir nada. create_tenant
// lo usa como respaldo y lo borra al crear el negocio. No guarda secretos: son
// los mismos datos que el usuario escribió (el código de invitación se valida
// recién al canjearlo, del lado del servidor).
export interface PendingSignup {
  businessName: string;
  industry: Vertical | null;
  planKey: string | null;
  addonAi: boolean;
  inviteCode: string | null;
  cuit: string | null;
  legalName: string | null;
  ivaCondition: IvaCondition | null;
}

// Forma en user_metadata (snake_case, como el resto de la metadata).
interface PendingSignupMeta {
  business_name?: unknown;
  industry?: unknown;
  plan_key?: unknown;
  addon_ai?: unknown;
  invite_code?: unknown;
  cuit?: unknown;
  legal_name?: unknown;
  iva_condition?: unknown;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t.length > 0 ? t : null;
}

export function toPendingSignupMeta(
  p: PendingSignup,
): Record<string, string | boolean | null> {
  return {
    business_name: p.businessName.trim().slice(0, 120),
    industry: p.industry,
    plan_key: p.planKey,
    addon_ai: p.addonAi,
    invite_code: p.inviteCode?.trim().toUpperCase().slice(0, 40) || null,
    cuit: p.cuit?.replace(/\D/g, "") || null,
    legal_name: p.legalName?.trim().slice(0, 200) || null,
    iva_condition: p.ivaCondition,
  };
}

/** Lee y valida el alta pendiente de user_metadata.signup (o null). */
export function readPendingSignup(raw: unknown): PendingSignup | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as PendingSignupMeta;
  const businessName = str(m.business_name, 120);
  if (!businessName || businessName.length < 2) return null;
  const industry =
    typeof m.industry === "string" && isVertical(m.industry)
      ? m.industry
      : null;
  const iva = typeof m.iva_condition === "string" ? m.iva_condition : "";
  const cuit = typeof m.cuit === "string" ? m.cuit.replace(/\D/g, "") : "";
  return {
    businessName,
    industry,
    planKey: str(m.plan_key, 40),
    addonAi: m.addon_ai === true,
    inviteCode: str(m.invite_code, 40),
    cuit: cuit.length === 11 ? cuit : null,
    legalName: str(m.legal_name, 200),
    ivaCondition: (IVA_CONDITIONS as readonly string[]).includes(iva)
      ? (iva as IvaCondition)
      : null,
  };
}

/** ¿Alcanza para crear el negocio con un clic (nombre + rubro)? */
export function isPendingSignupComplete(
  p: PendingSignup | null,
): p is PendingSignup & { industry: Vertical } {
  return p !== null && p.businessName.length >= 2 && p.industry !== null;
}
