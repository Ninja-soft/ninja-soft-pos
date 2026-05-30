"use client";

// Se re-monta en cada navegación → transición suave entre pantallas.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-fade-in">{children}</div>;
}
