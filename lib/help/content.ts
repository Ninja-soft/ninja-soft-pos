// Base de conocimiento versionada (F15 · H72 · ADR-086).
// Los artículos viven en content/help/articles/*.json, uno por módulo. Cambiar
// un artículo = editar el JSON y subir `version` (el voto de feedback guarda la
// versión que se leyó). El panel de ayuda carga este módulo recién al abrirse.
import { z } from "zod";
import pos from "@/content/help/articles/pos.json";
import caja from "@/content/help/articles/caja.json";
import catalogo from "@/content/help/articles/catalogo.json";
import clientes from "@/content/help/articles/clientes.json";
import configuracion from "@/content/help/articles/configuracion.json";
import facturacion from "@/content/help/articles/facturacion.json";
import rubros from "@/content/help/articles/rubros.json";
import synonymsRaw from "@/content/help/synonyms.json";
import { articleSchema, synonymsSchema, type HelpArticle } from "./types";

export const HELP_ARTICLES: readonly HelpArticle[] = z
  .array(articleSchema)
  .parse([...pos, ...caja, ...catalogo, ...clientes, ...configuracion, ...facturacion, ...rubros]);

export const HELP_SYNONYMS: readonly (readonly string[])[] = synonymsSchema.parse(synonymsRaw);

const BY_ID = new Map(HELP_ARTICLES.map((a) => [a.id, a]));

export function getArticle(id: string | null | undefined): HelpArticle | null {
  return (id && BY_ID.get(id)) || null;
}
