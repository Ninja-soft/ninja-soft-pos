import { NextResponse } from "next/server";

// Health check básico (roadmap H0): liveness para monitoreo/CI. No toca DB ni
// expone secretos; solo confirma que el server responde y qué env está activo.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "ninja-soft-pos",
    version: process.env.npm_package_version ?? "0.1.0",
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    time: new Date().toISOString(),
  });
}
