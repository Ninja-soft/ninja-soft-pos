// Ayuda contextual y Escuela (F15 · H72, H69 · ADR-086).
// Esquema del contenido versionado en content/help/*.json. Se valida con Zod en
// los tests para que un artículo mal cargado no llegue a producción.
import { z } from "zod";

export const HELP_ROLES = ["owner", "manager", "cashier", "viewer"] as const;
export type HelpRole = (typeof HELP_ROLES)[number];

export const HELP_MODULES = [
  "pos",
  "caja",
  "catalogo",
  "stock",
  "precios",
  "clientes",
  "sucursales",
  "equipo",
  "facturacion",
  "gastronomia",
  "agenda",
  "reportes",
  "escuela",
] as const;
export type HelpModule = (typeof HELP_MODULES)[number];

export const MODULE_LABELS: Record<HelpModule, string> = {
  pos: "Punto de venta",
  caja: "Caja",
  catalogo: "Productos",
  stock: "Stock",
  precios: "Precios y promociones",
  clientes: "Clientes",
  sucursales: "Sucursales",
  equipo: "Equipo y permisos",
  facturacion: "Facturación ARCA",
  gastronomia: "Gastronomía",
  agenda: "Agenda",
  reportes: "Reportes",
  escuela: "Escuela",
};

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
// Brand: sin em dash en el contenido (CLAUDE.md, brand book).
const EM_DASH = String.fromCharCode(0x2014);
const text = z
  .string()
  .min(1)
  .refine((s) => !s.includes(EM_DASH), "sin em dash");

export const articleSchema = z.object({
  id: slug,
  version: z.number().int().min(1),
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: text,
  summary: text,
  module: z.enum(HELP_MODULES),
  // Rutas de la app donde el artículo aplica (prefijo, sin query).
  routes: z.array(z.string().regex(/^\/[a-z0-9\-/]*$/)).min(1),
  roles: z.array(z.enum(HELP_ROLES)).min(1),
  // Frases con las que la gente lo busca ("anular venta", "cancelar ticket").
  keywords: z.array(text).min(1),
  tags: z.array(text).default([]),
  steps: z.array(text).min(1),
  // Lo que cambia según el rol de quien lee.
  roleNotes: z.record(z.enum(HELP_ROLES), text).default({}),
  errors: z.array(z.object({ problem: text, fix: text })).default([]),
  tips: z.array(text).default([]),
  feature: z.string().optional(),
  related: z.array(slug).default([]),
});
export type HelpArticle = z.infer<typeof articleSchema>;

export const synonymsSchema = z.array(z.array(z.string().min(2)).min(2));

export const quizQuestionSchema = z.object({
  id: z.string().regex(/^q\d+$/),
  question: text,
  options: z.array(text).min(2).max(5),
  answer: z.number().int().min(0),
  explain: text,
});
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

export const courseSchema = z.object({
  key: slug,
  version: z.number().int().min(1),
  title: text,
  summary: text,
  roles: z.array(z.enum(HELP_ROLES)).min(1),
  minutes: z.number().int().min(1),
  lessons: z.array(slug).min(1),
  checklist: z.array(text).min(1),
  passPct: z.number().int().min(50).max(100),
  certificate: text.nullable(),
  quiz: z.array(quizQuestionSchema).min(3).max(5),
});
export type Course = z.infer<typeof courseSchema>;

/** Pregunta sin la respuesta correcta: lo único que viaja al navegador. */
export type PublicQuizQuestion = Omit<QuizQuestion, "answer" | "explain">;
export type PublicCourse = Omit<Course, "quiz"> & { quiz: PublicQuizQuestion[] };
