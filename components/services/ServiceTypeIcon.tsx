import {
  BriefcaseBusiness,
  CalendarRange,
  FileText,
  FlaskConical,
  Hammer,
  MapPin,
  MessagesSquare,
  Wrench,
  type LucideIcon,
} from "lucide-react";

// Ícono de un tipo de servicio (service_types.icon, ADR-122). Un ícono
// desconocido cae al maletín genérico.
const ICONS: Record<string, LucideIcon> = {
  "calendar-range": CalendarRange,
  "map-pin": MapPin,
  hammer: Hammer,
  "file-text": FileText,
  "flask-conical": FlaskConical,
  "messages-square": MessagesSquare,
  wrench: Wrench,
};

export function ServiceTypeIcon({ icon, size = 16, className }: { icon: string | null | undefined; size?: number; className?: string }) {
  const Icon = (icon && ICONS[icon]) || BriefcaseBusiness;
  return <Icon size={size} className={className} aria-hidden />;
}
