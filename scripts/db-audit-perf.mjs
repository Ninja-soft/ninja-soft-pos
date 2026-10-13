#!/usr/bin/env node
// =============================================================================
// scripts/db-audit-perf.mjs  (F4 · ADR-090)
//
// Auditoría de rendimiento de la base de NinjaSoft POS.
//
// Dos modos:
//
//   1) Estático (default): reconstruye el esquema final leyendo TODAS las
//      migraciones de supabase/migrations en orden (tablas, columnas, FKs,
//      índices, policies, funciones, triggers, defaults) y reporta:
//        P1  policies que llaman funciones de contexto (current_tenant_id(),
//            auth.uid(), auth.jwt(), internal_scope(), is_internal() y
//            helpers sin argumentos) sin envolver en "(select ...)": se
//            evalúan una vez por fila en vez de una vez por consulta.
//        P2  funciones SQL (no SECURITY DEFINER, inlineables) que llaman
//            funciones de contexto sin "(select ...)" y se usan en policies:
//            al inlinearse, la llamada queda suelta en el plan.
//        P3  defaults de columnas y triggers FOR EACH ROW que llaman
//            current_tenant_id() (un lookup en tenant_users por fila, ADR-083).
//        P4  policies con EXISTS / IN correlacionado contra otra tabla sin un
//            índice que empiece por la columna del join.
//        P5  FKs sin índice que las cubra (columnas iniciales de algún índice)
//            en las tablas operativas grandes.
//        P6  tablas operativas grandes sin índice compuesto para las listas
//            (tenant_id + created_at, tenant_id + store_id, tenant_id + status).
//        P7  índices redundantes (prefijo de otro con el mismo predicado).
//
//   2) Catálogo (--catalog): consultas de sólo lectura a pg_catalog de una
//      base real (FKs sin índice, policies sin initplan, tamaños y scans).
//      Usa la Management API de Supabase (SUPABASE_ACCESS_TOKEN +
//      SUPABASE_PROJECT_REF) o psql (DATABASE_URL). Nunca escribe.
//
// Uso:
//   node scripts/db-audit-perf.mjs                 # estático, texto
//   node scripts/db-audit-perf.mjs --json          # estático, JSON
//   node scripts/db-audit-perf.mjs --all-tables    # P5/P6 sobre todas las tablas con tenant_id
//   node scripts/db-audit-perf.mjs --catalog       # contra una base (sólo lectura)
//   node scripts/db-audit-perf.mjs --before=20261108500000  # estado anterior a una migración
//   node scripts/db-audit-perf.mjs --strict        # exit 1 si hay hallazgos P1, P2, P5 o P6
//
// La lógica estática se exporta (auditMigrations) para los tests unitarios.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const LARGE_TABLES = [
  "sales",
  "sale_items",
  "payments",
  "stock_movements",
  "cash_movements",
  "audit_logs",
  "fiscal_documents",
  "table_order_items",
];

// Tablas hijas: se listan por su padre (sale_id, order_id), no por negocio y
// fecha. P6 no aplica (un índice más en la tabla con más inserts no paga).
export const CHILD_TABLES = ["sale_items", "table_order_items"];

// Funciones cuyo resultado no depende de la fila: se pueden (y deben) evaluar
// una vez por consulta con "(select fn())".
export const CONTEXT_FUNCS = [
  "current_tenant_id",
  "auth.uid",
  "auth.jwt",
  "auth.role",
  "internal_scope",
  "is_internal",
];

// ---------------------------------------------------------------------------
// Lexer: parte el SQL en sentencias respetando comentarios, strings,
// identificadores entre comillas y dollar quotes.
// ---------------------------------------------------------------------------
export function splitStatements(sql) {
  const out = [];
  let buf = "";
  let line = 1;
  let startLine = 1;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-") {
      const j = sql.indexOf("\n", i);
      const end = j === -1 ? n : j;
      i = end;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const j = sql.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      line += countNl(sql.slice(i, end));
      i = end;
      buf += " ";
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      const s = sql.slice(i, j + 1);
      line += countNl(s);
      buf += s;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = sql.indexOf('"', i + 1);
      const s = sql.slice(i, j + 1);
      buf += s;
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        const end = j === -1 ? n : j + tag.length;
        const s = sql.slice(i, end);
        line += countNl(s);
        buf += s;
        i = end;
        continue;
      }
    }
    if (c === ";") {
      if (buf.trim()) out.push({ sql: buf.trim(), line: startLine });
      buf = "";
      i++;
      continue;
    }
    if (c === "\n") line++;
    if (!buf.trim()) startLine = line;
    buf += c;
    i++;
  }
  if (buf.trim()) out.push({ sql: buf.trim(), line: startLine });
  return out;
}

function countNl(s) {
  let k = 0;
  for (const ch of s) if (ch === "\n") k++;
  return k;
}

// Devuelve el contenido del paréntesis balanceado que abre en `start`
// (sql[start] === "(") y el índice de cierre.
export function balanced(sql, start) {
  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      i = skipString(sql, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { inner: sql.slice(start + 1, i), end: i };
    }
  }
  return { inner: sql.slice(start + 1), end: sql.length };
}

function skipString(sql, i) {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
    else if (sql[j] === "'") return j;
    else j++;
  }
  return j;
}

// Parte por comas de primer nivel.
export function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const j = skipString(s, i);
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`(?:${IDENT}\.)?${IDENT}`;

export function unq(name) {
  if (!name) return name;
  const last = name.split(".").pop();
  return last.replace(/"/g, "").toLowerCase();
}

function schemaOf(name) {
  const parts = name.replace(/"/g, "").split(".");
  return parts.length > 1 ? parts[0].toLowerCase() : "public";
}

// Columnas "de cabeza" de una lista de índice: sólo nombres simples; una
// expresión corta la lista (deja de servir como prefijo).
function indexColumns(list) {
  const cols = [];
  for (const part of splitTopLevel(list)) {
    const m = new RegExp(`^(${IDENT})(?:\\s+(?:asc|desc|nulls\\s+(?:first|last)|${IDENT}_ops))*\\s*$`, "i").exec(part.trim());
    if (!m) {
      cols.push(`expr:${part.trim()}`);
      continue;
    }
    cols.push(unq(m[1]));
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Modelo del esquema
// ---------------------------------------------------------------------------
function newModel() {
  return {
    tables: new Map(), // name -> { columns: Map(col -> {default}), fks: [], file }
    indexes: new Map(), // name -> { table, cols, where, unique, method, file }
    policies: new Map(), // `${table}.${name}` -> { table, name, permissive, cmd, using, check, file, line }
    functions: new Map(), // name -> { name, language, secdef, volatility, body, file, line, args }
    triggers: new Map(), // `${table}.${name}` -> { table, name, func, forEachRow, file }
  };
}

function ensureTable(model, name, file) {
  let t = model.tables.get(name);
  if (!t) {
    t = { name, columns: new Map(), fks: [], file, pk: [] };
    model.tables.set(name, t);
  }
  return t;
}

function addImplicitIndex(model, table, cols, kind, file) {
  const name = `${table}__${kind}__${cols.join("_")}`;
  model.indexes.set(name, { table, cols, unique: true, method: "btree", where: null, file, implicit: true });
}

function parseColumnDef(model, t, def, file) {
  const m = new RegExp(`^(${IDENT})\\s+(.*)$`, "is").exec(def.trim());
  if (!m) return;
  const col = unq(m[1]);
  const rest = m[2];
  const prev = t.columns.get(col) || {};
  const info = { ...prev, def: rest };
  const dm = /\bdefault\s+(.+?)(?=\s+(?:not\s+null|null|references|check|unique|primary|constraint|generated)\b|$)/is.exec(rest);
  if (dm) info.default = dm[1].trim();
  t.columns.set(col, info);
  const rm = new RegExp(`\\breferences\\s+(${QNAME})\\s*(?:\\(([^)]*)\\))?`, "i").exec(rest);
  if (rm) t.fks.push({ cols: [col], ref: unq(rm[1]), refSchema: schemaOf(rm[1]), file, name: `${t.name}_${col}_fkey` });
  if (/\bprimary\s+key\b/i.test(rest)) {
    t.pk = [col];
    addImplicitIndex(model, t.name, [col], "pkey", file);
  } else if (/\bunique\b/i.test(rest)) {
    addImplicitIndex(model, t.name, [col], "key", file);
  }
}

function parseTableConstraint(model, t, def, file) {
  const s = def.trim().replace(new RegExp(`^constraint\\s+${IDENT}\\s+`, "i"), "");
  let m = /^primary\s+key\s*\(([^)]*)\)/i.exec(s);
  if (m) {
    const cols = indexColumns(m[1]);
    t.pk = cols;
    addImplicitIndex(model, t.name, cols, "pkey", file);
    return true;
  }
  m = /^unique\s*(?:nulls\s+(?:not\s+)?distinct\s*)?\(([^)]*)\)/i.exec(s);
  if (m) {
    addImplicitIndex(model, t.name, indexColumns(m[1]), "key", file);
    return true;
  }
  m = new RegExp(`^foreign\\s+key\\s*\\(([^)]*)\\)\\s*references\\s+(${QNAME})`, "i").exec(s);
  if (m) {
    const cname = new RegExp(`^constraint\\s+(${IDENT})`, "i").exec(def.trim());
    t.fks.push({
      cols: m[1].split(",").map((x) => unq(x.trim())),
      ref: unq(m[2]),
      refSchema: schemaOf(m[2]),
      file,
      name: cname ? unq(cname[1]) : `${t.name}_fkey`,
    });
    return true;
  }
  m = /^exclude\s+using\s+(\w+)\s*\(([^)]*(?:\([^)]*\))?[^)]*)\)/i.exec(s);
  if (m) {
    const cols = splitTopLevel(m[2]).map((p) => unq(p.trim().split(/\s+/)[0]));
    model.indexes.set(`${t.name}__excl__${cols.join("_")}`, { table: t.name, cols, method: m[1].toLowerCase(), file, implicit: true });
    return true;
  }
  return /^(check|constraint)\b/i.test(s);
}

function handleCreateTable(model, stmt, file) {
  const m = new RegExp(`^create\\s+(?:unlogged\\s+|temp(?:orary)?\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(${QNAME})\\s*\\(`, "i").exec(stmt);
  if (!m) return;
  if (schemaOf(m[1]) !== "public") return;
  const name = unq(m[1]);
  const t = ensureTable(model, name, file);
  const open = stmt.indexOf("(", m.index + m[0].length - 1);
  const { inner } = balanced(stmt, open);
  for (const def of splitTopLevel(inner)) {
    if (/^(constraint|primary\s+key|unique|foreign\s+key|check|exclude)\b/i.test(def)) parseTableConstraint(model, t, def, file);
    else if (/^like\s/i.test(def)) continue;
    else parseColumnDef(model, t, def, file);
  }
}

function handleAlterTable(model, stmt, file) {
  const m = new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QNAME})\\s+(.*)$`, "is").exec(stmt);
  if (!m) return;
  if (schemaOf(m[1]) !== "public") return;
  const name = unq(m[1]);
  const t = ensureTable(model, name, file);
  for (const action of splitTopLevel(m[2])) {
    let a;
    if ((a = new RegExp(`^add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?(.*)$`, "is").exec(action))) {
      parseColumnDef(model, t, a[1], file);
    } else if ((a = /^add\s+(constraint\s+.*|primary\s+key.*|unique.*|foreign\s+key.*|exclude.*|check.*)$/is.exec(action))) {
      parseTableConstraint(model, t, a[1], file);
    } else if ((a = new RegExp(`^drop\\s+column\\s+(?:if\\s+exists\\s+)?(${IDENT})`, "i").exec(action))) {
      const col = unq(a[1]);
      t.columns.delete(col);
      t.fks = t.fks.filter((fk) => !fk.cols.includes(col));
      for (const [iname, idx] of model.indexes) if (idx.table === name && idx.cols.includes(col)) model.indexes.delete(iname);
    } else if ((a = new RegExp(`^drop\\s+constraint\\s+(?:if\\s+exists\\s+)?(${IDENT})`, "i").exec(action))) {
      const cname = unq(a[1]);
      t.fks = t.fks.filter((fk) => fk.name !== cname);
    } else if ((a = new RegExp(`^alter\\s+(?:column\\s+)?(${IDENT})\\s+set\\s+default\\s+(.*)$`, "is").exec(action))) {
      const col = unq(a[1]);
      const info = t.columns.get(col) || {};
      info.default = a[2].trim();
      info.defaultFile = file;
      t.columns.set(col, info);
    } else if ((a = new RegExp(`^alter\\s+(?:column\\s+)?(${IDENT})\\s+drop\\s+default`, "i").exec(action))) {
      const info = t.columns.get(unq(a[1]));
      if (info) delete info.default;
    } else if ((a = new RegExp(`^rename\\s+to\\s+(${IDENT})`, "i").exec(action))) {
      const to = unq(a[1]);
      model.tables.delete(name);
      t.name = to;
      model.tables.set(to, t);
      for (const idx of model.indexes.values()) if (idx.table === name) idx.table = to;
    }
  }
}

function handleCreateIndex(model, stmt, file) {
  const m = new RegExp(
    `^create\\s+(unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?(${QNAME})?\\s*on\\s+(?:only\\s+)?(${QNAME})\\s*(?:using\\s+(\\w+)\\s*)?\\(`,
    "i",
  ).exec(stmt);
  if (!m) return;
  if (schemaOf(m[3]) !== "public") return;
  const table = unq(m[3]);
  const open = m.index + m[0].length - 1;
  const { inner, end } = balanced(stmt, open);
  const rest = stmt.slice(end + 1);
  const wm = /\bwhere\s+(.*)$/is.exec(rest);
  const name = m[2] ? unq(m[2]) : `${table}_${Math.random().toString(36).slice(2)}_idx`;
  if (/if\s+not\s+exists/i.test(stmt) && model.indexes.has(name)) return;
  model.indexes.set(name, {
    table,
    cols: indexColumns(inner),
    unique: Boolean(m[1]),
    method: (m[4] || "btree").toLowerCase(),
    where: wm ? wm[1].trim() : null,
    file,
  });
}

function handleDropIndex(model, stmt) {
  const m = /^drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?(.*)$/is.exec(stmt);
  if (!m) return;
  for (const n of m[1].split(",")) model.indexes.delete(unq(n.trim().split(/\s+/)[0]));
}

// Extrae la cláusula USING / WITH CHECK de un create/alter policy.
function policyClauses(stmt) {
  const out = { using: null, check: null };
  const lower = stmt.toLowerCase();
  const findClause = (re) => {
    re.lastIndex = 0;
    let mm;
    while ((mm = re.exec(lower))) {
      const open = lower.indexOf("(", mm.index + mm[0].length - 1);
      if (open !== -1) return balanced(stmt, open).inner;
    }
    return null;
  };
  out.using = findClause(/\busing\s*\(/g);
  out.check = findClause(/\bwith\s+check\s*\(/g);
  return out;
}

function handleCreatePolicy(model, stmt, file, line) {
  const m = new RegExp(`^create\\s+policy\\s+(${IDENT})\\s+on\\s+(${QNAME})(.*)$`, "is").exec(stmt);
  if (!m) return;
  if (schemaOf(m[2]) !== "public") return;
  const table = unq(m[2]);
  const name = unq(m[1]);
  const rest = m[3];
  const head = rest.split(/\busing\b|\bwith\s+check\b/i)[0];
  const permissive = !/\bas\s+restrictive\b/i.test(head);
  const cm = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(head);
  const { using, check } = policyClauses(rest);
  model.policies.set(`${table}.${name}`, {
    table,
    name,
    permissive,
    cmd: cm ? cm[1].toLowerCase() : "all",
    using,
    check,
    file,
    line,
  });
}

function handleAlterPolicy(model, stmt, file, line) {
  const m = new RegExp(`^alter\\s+policy\\s+(${IDENT})\\s+on\\s+(${QNAME})(.*)$`, "is").exec(stmt);
  if (!m) return;
  const key = `${unq(m[2])}.${unq(m[1])}`;
  const p = model.policies.get(key);
  if (!p) return;
  const { using, check } = policyClauses(m[3]);
  if (using != null) p.using = using;
  if (check != null) p.check = check;
  p.file = file;
  p.line = line;
}

function handleDropPolicy(model, stmt) {
  const m = new RegExp(`^drop\\s+policy\\s+(?:if\\s+exists\\s+)?(${IDENT})\\s+on\\s+(${QNAME})`, "i").exec(stmt);
  if (!m) return;
  model.policies.delete(`${unq(m[2])}.${unq(m[1])}`);
}

function handleCreateFunction(model, stmt, file, line) {
  const m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?function\\s+(${QNAME})\\s*\\(`, "i").exec(stmt);
  if (!m) return;
  if (schemaOf(m[1]) !== "public") return;
  const name = unq(m[1]);
  const open = m.index + m[0].length - 1;
  const { inner: args, end } = balanced(stmt, open);
  const tail = stmt.slice(end + 1);
  const bm = /(\$[A-Za-z_0-9]*\$)([\s\S]*?)\1/.exec(tail);
  const body = bm ? bm[2] : "";
  const attrs = bm ? tail.slice(0, bm.index) + tail.slice(bm.index + bm[0].length) : tail;
  const lang = /\blanguage\s+'?(\w+)'?/i.exec(attrs);
  const argCount = args.trim() ? splitTopLevel(args).length : 0;
  model.functions.set(`${name}/${argCount}`, {
    name,
    argCount,
    args: args.trim(),
    language: lang ? lang[1].toLowerCase() : "sql",
    secdef: /\bsecurity\s+definer\b/i.test(attrs),
    volatility: /\bimmutable\b/i.test(attrs) ? "immutable" : /\bstable\b/i.test(attrs) ? "stable" : "volatile",
    body,
    file,
    line,
    sql: stmt,
  });
}

function handleCreateTrigger(model, stmt, file) {
  const m = new RegExp(
    `^create\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+(${IDENT})\\s+(.*?)\\s+on\\s+(${QNAME})\\s+(.*?)execute\\s+(?:function|procedure)\\s+(${QNAME})`,
    "is",
  ).exec(stmt);
  if (!m) return;
  if (schemaOf(m[3]) !== "public") return;
  const table = unq(m[3]);
  model.triggers.set(`${table}.${unq(m[1])}`, {
    table,
    name: unq(m[1]),
    timing: m[2].trim().toLowerCase(),
    forEachRow: /for\s+each\s+row/i.test(m[4]),
    func: unq(m[5]),
    file,
  });
}

function handleDropTrigger(model, stmt) {
  const m = new RegExp(`^drop\\s+trigger\\s+(?:if\\s+exists\\s+)?(${IDENT})\\s+on\\s+(${QNAME})`, "i").exec(stmt);
  if (m) model.triggers.delete(`${unq(m[2])}.${unq(m[1])}`);
}

// DO blocks conocidos que reescriben policies en lote (emulados).
function handleDoBlock(model, stmt, file, line) {
  const body = stmt;
  if (/pg_policies/i.test(body) && /perf_initplan_wrap\(/i.test(body)) {
    // ADR-090: todas las llamadas sin dependencia de la fila -> (select ...).
    const ip = initplanFuncs(model);
    for (const p of model.policies.values()) {
      p.using = wrapInitplan(p.using, ip);
      p.check = wrapInitplan(p.check, ip);
    }
    return;
  }
  if (/pg_policies/i.test(body) && /replace\(\s*r\.qual\s*,\s*'is_internal\(\)'\s*,\s*'internal_scope\(\)'\s*\)/i.test(body)) {
    // ADR-052: is_internal() -> internal_scope() en policies PERMISSIVE con tenant_id.
    for (const p of model.policies.values()) {
      const txt = `${p.using || ""}${p.check || ""}`;
      if (!p.permissive || !/is_internal\(\)/i.test(txt) || !/tenant_id/i.test(txt)) continue;
      if (p.using) p.using = p.using.replace(/is_internal\(\)/gi, "internal_scope()");
      if (p.check) p.check = p.check.replace(/is_internal\(\)/gi, "internal_scope()");
    }
    return;
  }
  if (/pg_policies/i.test(body) && /'\(select current_tenant_id\(\)\)'/i.test(body)) {
    // ADR-083: current_tenant_id() -> (select current_tenant_id()) en todas.
    for (const p of model.policies.values()) {
      if (p.using) p.using = wrapCall(p.using, "current_tenant_id");
      if (p.check) p.check = wrapCall(p.check, "current_tenant_id");
    }
    return;
  }
  // foreach t in array array['a','b'] loop execute format('create policy %I on %I ...', t || '_x', t) ...
  const fm = /foreach\s+(\w+)\s+in\s+array\s+array\s*\[([^\]]*)\]/i.exec(body);
  if (fm) {
    const v = fm[1];
    const items = [...fm[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const execs = [...body.matchAll(/execute\s+format\(\s*'((?:[^']|'')*)'\s*,([^;]*?)\)\s*;/gi)];
    for (const item of items) {
      for (const ex of execs) {
        const tmpl = ex[1].replace(/''/g, "'");
        const args = splitTopLevel(ex[2]).map((a) => {
          const am = new RegExp(`^${v}(?:\\s*\\|\\|\\s*'([^']*)')?$`).exec(a.trim());
          return am ? item + (am[1] || "") : a.trim().replace(/^'|'$/g, "");
        });
        let k = 0;
        const sql = tmpl.replace(/%[IsL]/g, () => args[k++] ?? "");
        dispatch(model, sql, file, line);
      }
    }
  }
}

function dispatch(model, s, file, line) {
  const head = s.slice(0, 80).toLowerCase().replace(/\s+/g, " ");
  if (/^create (unlogged |temp |temporary )?table/.test(head)) handleCreateTable(model, s, file);
  else if (head.startsWith("alter table")) handleAlterTable(model, s, file);
  else if (/^create (unique )?index/.test(head)) handleCreateIndex(model, s, file);
  else if (head.startsWith("drop index")) handleDropIndex(model, s);
  else if (head.startsWith("create policy")) handleCreatePolicy(model, s, file, line);
  else if (head.startsWith("alter policy")) handleAlterPolicy(model, s, file, line);
  else if (head.startsWith("drop policy")) handleDropPolicy(model, s);
  else if (/^create (or replace )?function/.test(head)) handleCreateFunction(model, s, file, line);
  else if (/^create (or replace )?(constraint )?trigger/.test(head)) handleCreateTrigger(model, s, file);
  else if (head.startsWith("drop trigger")) handleDropTrigger(model, s);
  else if (/^drop table/.test(head)) {
    const m = new RegExp(`^drop\\s+table\\s+(?:if\\s+exists\\s+)?(${QNAME})`, "i").exec(s);
    if (m) model.tables.delete(unq(m[1]));
  } else if (/^drop function/.test(head)) {
    const m = new RegExp(`^drop\\s+function\\s+(?:if\\s+exists\\s+)?(${QNAME})\\s*(\\(([^)]*)\\))?`, "i").exec(s);
    if (m) {
      const argc = m[3] && m[3].trim() ? splitTopLevel(m[3]).length : 0;
      model.functions.delete(`${unq(m[1])}/${argc}`);
    }
  } else if (head.startsWith("do ")) handleDoBlock(model, s, file, line);
}

// ---------------------------------------------------------------------------
// Utilidades de análisis
// ---------------------------------------------------------------------------

// Envuelve fn() suelto en (select fn()).
export function wrapCall(expr, fn) {
  const re = new RegExp(`(?<![\\w.])(?:public\\.)?${fn.replace(".", "\\.")}\\(\\)`, "gi");
  return expr.replace(re, (match, offset) => (isWrapped(expr, offset) ? match : `(select ${fn}())`));
}

// ¿La llamada en `offset` está dentro de "(select fn() ...)" escalar?
export function isWrapped(expr, offset) {
  const before = expr.slice(0, offset).replace(/\s+/g, " ").toLowerCase();
  return /\(\s*select\s*$/.test(before);
}

// Llamadas sueltas (sin "(select ...)") a funciones sin argumentos.
export function bareCalls(expr, funcs, litFuncs = []) {
  if (!expr) return [];
  const found = [];
  const scan = (fn, argsRe) => {
    const re = new RegExp(String.raw`(?<![\w.])(?:public\.)?${fn.replace(".", "\.")}\s*\(\s*${argsRe}\s*\)`, "gi");
    let m;
    while ((m = re.exec(expr))) {
      if (!isWrapped(expr, m.index)) found.push(fn);
    }
  };
  for (const fn of funcs) scan(fn, "");
  for (const fn of litFuncs) scan(fn, String.raw`'[^']*'(?:::\w+)?`);
  return [...new Set(found)];
}

// Funciones que pueden ir como initplan: sin argumentos, o con un argumento
// que en la policy es un literal. Sólo STABLE / IMMUTABLE (mismo criterio que
// perf_initplan_wrap() en la base).
export function initplanFuncs(model) {
  const fns = [...model.functions.values()].filter((f) => f.volatility !== "volatile" && !/returns\s+setof/i.test(f.sql));
  const zero = [...new Set([...CONTEXT_FUNCS, ...fns.filter((f) => f.argCount === 0).map((f) => f.name)])];
  const lit = [...new Set(fns.filter((f) => f.argCount === 1).map((f) => f.name))];
  return { zero, lit };
}

// Envuelve todas las llamadas elegibles (emula perf_initplan_wrap()).
export function wrapInitplan(expr, { zero, lit }) {
  if (!expr) return expr;
  let out = expr;
  for (const fn of zero) out = wrapCall(out, fn);
  for (const fn of lit) {
    const re = new RegExp(String.raw`(?<![\w.])(?:public\.)?${fn}\s*\(\s*('[^']*'(?:::\w+)?)\s*\)`, "gi");
    out = out.replace(re, (match, arg, offset) => (isWrapped(out, offset) ? match : `(select ${fn}(${arg}))`));
  }
  return out;
}

// Un índice parcial "WHERE col IS NOT NULL" sirve igual para "col = $1"
// (FK, joins, filtros por igualdad): Postgres deduce el predicado.
function partialOk(idx, col) {
  if (!idx.where) return true;
  return new RegExp(String.raw`^\(?\s*${col}\s+is\s+not\s+null\s*\)?$`, "i").test(idx.where.trim());
}

function hasCoveringIndex(model, table, cols) {
  for (const idx of model.indexes.values()) {
    if (idx.table !== table) continue;
    if (idx.method !== "btree" && idx.method !== "gist") continue;
    if (!cols.some((c) => partialOk(idx, c))) continue;
    const lead = idx.cols.slice(0, cols.length);
    if (cols.every((c) => lead.includes(c))) return idx;
  }
  return null;
}

function hasIndexStartingWith(model, table, cols) {
  for (const idx of model.indexes.values()) {
    if (idx.table !== table) continue;
    if (idx.method !== "btree") continue;
    if (!cols.some((c) => partialOk(idx, c))) continue;
    const lead = idx.cols.slice(0, cols.length);
    if (cols.every((c, i) => lead[i] === c)) return idx;
  }
  return null;
}

// Tablas referenciadas en EXISTS / IN (subconsultas) de una expresión de policy,
// con la columna que las une a la fila de afuera (si se puede inferir).
function correlatedSubqueries(expr, outerTable) {
  const out = [];
  if (!expr) return out;
  const re = new RegExp(`\\bfrom\\s+(${QNAME})(?:\\s+(?:as\\s+)?(${IDENT}))?`, "gi");
  let m;
  while ((m = re.exec(expr))) {
    const table = unq(m[1]);
    const alias = m[2] && !/^(where|join|left|inner|on|limit|order|group)$/i.test(m[2]) ? unq(m[2]) : table;
    const tail = expr.slice(m.index, m.index + 600);
    const wm = /\bwhere\b([\s\S]*)/i.exec(tail);
    if (!wm) continue;
    const cond = wm[1];
    // alias.col = <lo que sea>: columnas con igualdad dentro de la subconsulta.
    const eq = new RegExp(String.raw`\b${alias}\.(\w+)\s*(?:=|in\b)`, "gi");
    let e;
    const joinCols = [];
    while ((e = eq.exec(cond))) joinCols.push(e[1].toLowerCase());
    out.push({ table, alias, joinCols });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auditoría estática
// ---------------------------------------------------------------------------
export function buildModel(migrationsDir, opts = {}) {
  const model = newModel();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !opts.before || f < opts.before)
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const { sql: s, line } of splitStatements(sql)) dispatch(model, s, file, line);
  }
  return { model, files };
}

export function auditMigrations(migrationsDir, opts = {}) {
  const { model, files } = buildModel(migrationsDir, opts);
  const findings = [];
  const add = (f) => findings.push(f);

  // Helpers sin argumentos (o con un literal) usados en policies.
  const ip = initplanFuncs(model);

  // P1: policies con llamadas sueltas.
  for (const p of model.policies.values()) {
    const calls = [...new Set([...bareCalls(p.using, ip.zero, ip.lit), ...bareCalls(p.check, ip.zero, ip.lit)])];
    if (calls.length)
      add({
        code: "P1",
        severity: calls.some((c) => c === "current_tenant_id" || c.startsWith("auth.")) ? "high" : "medium",
        table: p.table,
        object: p.name,
        detail: `policy llama ${calls.map((c) => `${c}()`).join(", ")} sin (select ...)`,
        file: p.file,
      });
  }

  // P2: funciones SQL inlineables (no SECURITY DEFINER, no volátiles) que
  // llaman funciones de contexto sin "(select ...)" y que se usan en policies
  // de forma que no quedan como initplan: con argumentos (dependen de la fila)
  // o sin argumentos pero llamadas sueltas. Al inlinearse, la llamada interna
  // se evalúa por fila. Envuelta en "(select f())" no importa.
  const perRowUse = new Map(); // name -> [policy]
  for (const p of model.policies.values()) {
    const txt = `${p.using || ""} ${p.check || ""}`;
    for (const f of model.functions.values()) {
      if (f.language !== "sql" || f.secdef || f.volatility === "volatile") continue;
      const used =
        f.argCount === 0
          ? bareCalls(txt, [f.name]).length > 0
          : new RegExp(String.raw`(?<![\w.])(?:public\.)?${f.name}\s*\(\s*[^)\s]`, "i").test(txt);
      if (used) perRowUse.set(f.name, [...(perRowUse.get(f.name) || []), `${p.table}.${p.name}`]);
    }
  }
  for (const f of model.functions.values()) {
    if (f.language !== "sql" || f.secdef || f.volatility === "volatile" || !perRowUse.has(f.name)) continue;
    const calls = bareCalls(f.body, CONTEXT_FUNCS);
    if (calls.length)
      add({
        code: "P2",
        severity: "medium",
        table: null,
        object: `${f.name}(${f.args})`,
        detail: `función SQL inlineable llama ${calls.map((c) => `${c}()`).join(", ")} sin (select ...) y se usa por fila en ${perRowUse.get(f.name).slice(0, 3).join(", ")}`,
        file: f.file,
      });
  }

  // P3: defaults y triggers por fila que llaman current_tenant_id().
  for (const t of model.tables.values()) {
    for (const [col, info] of t.columns) {
      if (info.default && /current_tenant_id\s*\(\s*\)/i.test(info.default))
        add({
          code: "P3",
          severity: LARGE_TABLES.includes(t.name) ? "medium" : "low",
          table: t.name,
          object: `${t.name}.${col} default`,
          detail: "DEFAULT current_tenant_id(): un lookup en tenant_users por fila insertada",
          file: info.defaultFile || t.file,
        });
    }
  }
  for (const tr of model.triggers.values()) {
    if (!tr.forEachRow) continue;
    const fns = [...model.functions.values()].filter((f) => f.name === tr.func);
    for (const f of fns) {
      if (/current_tenant_id\s*\(\s*\)/i.test(f.body))
        add({
          code: "P3",
          severity: LARGE_TABLES.includes(tr.table) ? "medium" : "low",
          table: tr.table,
          object: `trigger ${tr.name} -> ${f.name}()`,
          detail: "trigger FOR EACH ROW llama current_tenant_id() (lookup en tenant_users por fila)",
          file: f.file,
        });
    }
  }

  // P4: EXISTS / IN correlacionados donde ninguna columna con igualdad de la
  // subconsulta tiene un índice que empiece por ella.
  for (const p of model.policies.values()) {
    for (const expr of [p.using, p.check]) {
      for (const sub of correlatedSubqueries(expr, p.table)) {
        if (!model.tables.has(sub.table) || !sub.joinCols.length) continue;
        if (sub.joinCols.some((c) => hasIndexStartingWith(model, sub.table, [c]))) continue;
        add({
          code: "P4",
          severity: LARGE_TABLES.includes(sub.table) || LARGE_TABLES.includes(p.table) ? "high" : "medium",
          table: p.table,
          object: p.name,
          detail: `subconsulta sobre ${sub.table} (${sub.joinCols.join(", ")}) sin índice que empiece por esas columnas`,
          file: p.file,
        });
      }
    }
  }

  // P5: FKs sin índice en tablas operativas grandes.
  const scope = opts.allTables
    ? [...model.tables.values()].filter((t) => t.columns.has("tenant_id")).map((t) => t.name)
    : LARGE_TABLES;
  for (const tname of scope) {
    const t = model.tables.get(tname);
    if (!t) continue;
    for (const fk of t.fks) {
      if (!hasCoveringIndex(model, tname, fk.cols))
        add({
          code: "P5",
          severity: LARGE_TABLES.includes(tname) ? "high" : "low",
          table: tname,
          object: `${tname}(${fk.cols.join(", ")}) -> ${fk.ref}`,
          detail: "FK sin índice que la cubra (borrados/updates del padre y joins hacen seq scan)",
          file: fk.file,
        });
    }
  }

  // P6: listas sin índice compuesto.
  for (const tname of scope) {
    const t = model.tables.get(tname);
    if (!t || !t.columns.has("tenant_id")) continue;
    const wants = [["tenant_id", "created_at"]];
    if (t.columns.has("store_id")) wants.push(["tenant_id", "store_id"]);
    if (t.columns.has("status")) wants.push(["tenant_id", "status"]);
    if (CHILD_TABLES.includes(tname)) continue;
    for (const cols of wants) {
      if (!t.columns.has(cols[1])) continue;
      // store_id pertenece a un solo negocio: (store_id, ...) sirve igual.
      if (cols[1] === "store_id" && hasIndexStartingWith(model, tname, ["store_id"])) continue;
      if (!hasIndexStartingWith(model, tname, cols))
        add({
          code: "P6",
          severity: LARGE_TABLES.includes(tname) ? "high" : "low",
          table: tname,
          object: `${tname}(${cols.join(", ")})`,
          detail: "lista filtrada por negocio sin índice compuesto que empiece por esas columnas",
          file: t.file,
        });
    }
  }

  // P7: índices redundantes (prefijo de otro índice btree de la misma tabla,
  // mismo predicado, no únicos): cuestan en cada escritura y no suman lecturas.
  for (const tname of scope) {
    const idxs = [...model.indexes.entries()].filter(([, i]) => i.table === tname && i.method === "btree");
    for (const [an, a] of idxs) {
      if (a.unique || a.implicit) continue;
      const cover = idxs.find(
        ([bn, b]) =>
          bn !== an &&
          (b.where || null) === (a.where || null) &&
          b.cols.length >= a.cols.length &&
          a.cols.every((c, i) => b.cols[i] === c) &&
          (b.cols.length > a.cols.length || an > bn),
      );
      if (cover)
        add({
          code: "P7",
          severity: "low",
          table: tname,
          object: an,
          detail: `redundante con ${cover[0]} (${cover[1].cols.join(", ")})`,
          file: a.file,
        });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code) || String(a.table).localeCompare(String(b.table)));
  return {
    files: files.length,
    stats: {
      tables: model.tables.size,
      indexes: model.indexes.size,
      policies: model.policies.size,
      functions: model.functions.size,
      triggers: model.triggers.size,
    },
    findings,
    model,
  };
}

// ---------------------------------------------------------------------------
// Modo catálogo (sólo lectura)
// ---------------------------------------------------------------------------
export const CATALOG_QUERIES = {
  sizes: `select c.relname as table, c.reltuples::bigint as est_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total, s.seq_scan, s.idx_scan
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_tables s on s.relid = c.oid
 where n.nspname = 'public' and c.relkind = 'r'
 order by pg_total_relation_size(c.oid) desc limit 30`,
  fk_without_index: `select c.conrelid::regclass::text as table, c.conname,
       (select string_agg(a.attname, ', ' order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace
 where c.contype = 'f' and n.nspname = 'public'
   and not exists (
     select 1 from pg_index i
      where i.indrelid = c.conrelid and i.indpred is null
        and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
        and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)
 order by 1, 2`,
  bare_policies: `select tablename, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
  from pg_policies where schemaname = 'public'
   and (regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
        '\\( SELECT [a-z_.]+\\(\\) AS [a-z_]+\\)', '', 'g') ~ '(current_tenant_id|auth\\.uid|auth\\.jwt|internal_scope|is_internal)\\(\\)')
 order by 1, 2`,
  hot_seq_scans: `select relname as table, seq_scan, idx_scan, n_live_tup
  from pg_stat_user_tables where schemaname = 'public' and seq_scan > coalesce(idx_scan, 0) and seq_scan > 1000
 order by seq_scan desc limit 15`,
};

async function runCatalog() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.SUPABASE_PROJECT_REF;
  const dbUrl = process.env.DATABASE_URL;
  const run = async (sql) => {
    if (token && ref) {
      const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
      if (!r.ok) throw new Error(`Management API ${r.status}: ${await r.text()}`);
      return r.json();
    }
    if (dbUrl) {
      const out = execFileSync("psql", [dbUrl, "-X", "-A", "-t", "-c", `select coalesce(json_agg(q), '[]') from (${sql}) q`], {
        encoding: "utf8",
        env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" },
      });
      return JSON.parse(out.trim() || "[]");
    }
    throw new Error("--catalog necesita SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF, o DATABASE_URL con psql");
  };
  const result = {};
  for (const [k, sql] of Object.entries(CATALOG_QUERIES)) result[k] = await run(sql);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function printStatic(res) {
  console.log(`Migraciones: ${res.files} · tablas ${res.stats.tables} · índices ${res.stats.indexes} · policies ${res.stats.policies} · funciones ${res.stats.functions} · triggers ${res.stats.triggers}`);
  const by = {};
  for (const f of res.findings) by[f.code] = (by[f.code] || 0) + 1;
  console.log(`Hallazgos: ${res.findings.length} ${JSON.stringify(by)}`);
  for (const f of res.findings) console.log(`[${f.severity}] ${f.code} ${f.object}: ${f.detail} (${f.file})`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (args.has("--catalog")) {
    const res = await runCatalog();
    if (args.has("--json")) console.log(JSON.stringify(res, null, 2));
    else
      for (const [k, rows] of Object.entries(res)) {
        console.log(`\n## ${k} (${rows.length})`);
        for (const r of rows) console.log(Object.values(r).join(" | "));
      }
  } else {
    const beforeArg = process.argv.slice(2).find((a) => a.startsWith("--before="));
    const res = auditMigrations(path.join(root, "supabase", "migrations"), {
      allTables: args.has("--all-tables"),
      before: beforeArg ? beforeArg.slice("--before=".length) : undefined,
    });
    if (args.has("--json")) console.log(JSON.stringify({ ...res, model: undefined }, null, 2));
    else printStatic(res);
    if (args.has("--strict") && res.findings.some((f) => ["P1", "P2", "P5", "P6"].includes(f.code) && f.severity === "high")) process.exit(1);
  }
}
