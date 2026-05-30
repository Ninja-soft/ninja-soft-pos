import Link from "next/link";
import { ShieldCheck, Zap, Database } from "lucide-react";
import { buttonVariants } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Isotype, WordmarkPos } from "@/components/brand/Logo";
import { Display, Accent, Eyebrow } from "@/components/ui/Typography";

const features = [
  {
    icon: ShieldCheck,
    title: "Seguro",
    desc: "Multi-tenant con aislamiento a nivel de base de datos y auditoría completa.",
  },
  {
    icon: Zap,
    title: "Ágil",
    desc: "POS sin fricción: vendé rápido, controlá stock y cerrá caja en segundos.",
  },
  {
    icon: Database,
    title: "Conectado",
    desc: "Datos reales de negocio, reportes claros y trazabilidad de cada operación.",
  },
];

export default function LandingPage() {
  return (
    <main className="ninja-dark-bg relative min-h-screen overflow-hidden text-ninja-softWhite">
      <div className="ninja-grid pointer-events-none absolute inset-0 opacity-20" />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex items-center gap-3">
          <Isotype className="h-12 w-auto" priority />
          <WordmarkPos className="h-9 w-auto" priority />
        </div>

        <div className="mt-10">
          <Eyebrow>Punto de venta SaaS</Eyebrow>
        </div>

        <Display className="mt-5 max-w-3xl text-balance">
          Software <Accent tone="gradient">seguro</Accent> para negocios{" "}
          <Accent tone="gradient">inteligentes</Accent>.
        </Display>

        <p className="mt-6 max-w-2xl text-base text-ninja-lavender md:text-lg">
          Punto de venta SaaS para kioscos, retail, textiles y pymes. Automatizá
          procesos, protegé operaciones y conectá datos reales de negocio.
        </p>

        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link href="/signup" className={buttonVariants()}>
            Empezar ahora
          </Link>
          <Link
            href="/login"
            className={buttonVariants({ variant: "secondary" })}
          >
            Iniciar sesión
          </Link>
        </div>

        <div className="mt-16 grid w-full gap-4 sm:grid-cols-3">
          {features.map((f) => (
            <Card key={f.title} className="text-left">
              <CardContent className="p-6">
                <f.icon className="text-ninja-flameSoft" size={22} />
                <h3 className="mt-4 font-display text-lg font-bold">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm text-ninja-lavender">{f.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </main>
  );
}
