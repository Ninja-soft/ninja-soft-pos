#!/usr/bin/env node
// Puente local NinjaPOS: implementación de referencia (ADR-053).
//
// Expone un WebSocket SÓLO en 127.0.0.1 para que el POS web (navegador) hable
// con una terminal de tarjeta conectada a esta PC, por puerto serie (COM) o
// por red (TCP). El puente no entiende el protocolo de la terminal: sólo
// pasa bytes. Protocolo en tools/bridge/README.md.
//
// Uso:
//   node tools/bridge/bridge.mjs --origin https://app.ninjasoft.com.ar [--port 47800]
//   node tools/bridge/bridge.mjs --list          (lista los puertos serie)
//   node tools/bridge/bridge.mjs --new-token     (rota el token)
//
// Puerto serie: requiere el paquete opcional `serialport`
// (npm i serialport en esta carpeta). TCP funciona sin dependencias.
// Sin dependencias para el WebSocket: implementación mínima de RFC 6455.

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = 1;
const BRIDGE = "ninjapos-bridge/0.1.0";
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(name);

const PORT = Number(arg("--port", "47800"));
const ORIGINS = args.flatMap((a, i) => (a === "--origin" && args[i + 1] ? [args[i + 1].replace(/\/$/, "")] : []));
const CONFIG = path.join(os.homedir(), ".ninjapos-bridge.json");

// ── Token de emparejamiento ─────────────────────────────────────────────────

function loadToken(rotate) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    /* primera vez */
  }
  if (rotate || typeof cfg.token !== "string" || cfg.token.length < 32) {
    cfg.token = crypto.randomBytes(24).toString("base64url");
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
  return cfg.token;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function originAllowed(origin) {
  if (!origin) return false;
  const o = origin.replace(/\/$/, "");
  if (ORIGINS.includes(o)) return true;
  // Sin --origin sólo se aceptan páginas servidas desde esta PC (desarrollo).
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}

// ── WebSocket mínimo (texto, sin extensiones) ───────────────────────────────

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function encodeWsFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536
    ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(BigInt(len));
        return b;
      })()]);
  return Buffer.concat([head, payload]);
}

/** Decodifica frames del cliente (enmascarados). Devuelve [frames, resto]. */
export function decodeWsFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p);
      if (big > 1_000_000n) throw new Error("frame_too_big");
      len = Number(big);
      p += 8;
    }
    if (len > 1_000_000) throw new Error("frame_too_big");
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    p += maskLen;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode, data });
    off = p + len;
  }
  return [frames, buf.subarray(off)];
}

// ── Destinos (serie / TCP) ──────────────────────────────────────────────────

async function openSerial(t, onData, onClose) {
  let SerialPort;
  try {
    ({ SerialPort } = await import("serialport"));
  } catch {
    throw Object.assign(new Error("Falta el paquete serialport (npm i serialport en tools/bridge)"), { code: "serial_unavailable" });
  }
  const port = new SerialPort({
    path: t.path,
    baudRate: Number(t.baudRate) || 9600,
    dataBits: t.dataBits === 7 ? 7 : 8,
    stopBits: t.stopBits === 2 ? 2 : 1,
    parity: ["even", "odd"].includes(t.parity) ? t.parity : "none",
    rtscts: t.flowControl === "hardware",
    autoOpen: false,
  });
  await new Promise((res, rej) => port.open((e) => (e ? rej(Object.assign(e, { code: "open_failed" })) : res())));
  port.on("data", onData);
  port.on("close", onClose);
  return { write: (b) => port.write(b), close: () => port.isOpen && port.close() };
}

function openTcp(t, onData, onClose) {
  return new Promise((res, rej) => {
    const s = net.connect({ host: t.host, port: Number(t.port) });
    s.setNoDelay(true);
    s.once("error", (e) => rej(Object.assign(e, { code: "open_failed" })));
    s.once("connect", () => {
      s.removeAllListeners("error");
      s.on("error", () => s.destroy());
      s.on("data", onData);
      s.on("close", onClose);
      res({ write: (b) => s.write(b), close: () => s.destroy() });
    });
  });
}

async function listSerial() {
  try {
    const { SerialPort } = await import("serialport");
    return (await SerialPort.list()).map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      vendorId: p.vendorId,
      productId: p.productId,
    }));
  } catch {
    return [];
  }
}

// ── Servidor ────────────────────────────────────────────────────────────────

export function startBridge({ port = PORT, token, log = console.log } = {}) {
  let busy = false;
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("NinjaPOS bridge: usar WebSocket\n");
  });

  server.on("upgrade", (req, socket) => {
    const origin = req.headers.origin;
    const key = req.headers["sec-websocket-key"];
    if (!key || req.headers.upgrade?.toLowerCase() !== "websocket") return socket.destroy();
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (m) => socket.writable && socket.write(encodeWsFrame(JSON.stringify(m)));
    const fail = (code, message) => {
      send({ type: "error", code, message });
      socket.end(encodeWsFrame("", 0x8));
    };
    if (!originAllowed(origin)) return fail("origin_not_allowed", `Origen no permitido: ${origin ?? "(sin origen)"}`);
    if (busy) return fail("busy", "El puente ya está en uso por otra pestaña");
    busy = true;

    let authed = false;
    let target = null;
    let rest = Buffer.alloc(0);
    const cleanup = () => {
      target?.close();
      target = null;
      if (busy) busy = false;
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    socket.on("data", async (chunk) => {
      let frames;
      try {
        [frames, rest] = decodeWsFrames(Buffer.concat([rest, chunk]));
      } catch {
        return fail("protocol", "Frame inválido");
      }
      for (const f of frames) {
        if (f.opcode === 0x8) return socket.end(encodeWsFrame("", 0x8));
        if (f.opcode === 0x9) {
          socket.write(encodeWsFrame(f.data.toString(), 0xa));
          continue;
        }
        if (f.opcode !== 0x1) continue;
        let m;
        try {
          m = JSON.parse(f.data.toString("utf8"));
        } catch {
          continue;
        }
        if (!authed) {
          if (m.type !== "hello" || !safeEqual(m.token, token)) return fail("bad_token", "Token inválido");
          authed = true;
          send({ type: "welcome", version: VERSION, bridge: BRIDGE });
          log(`[bridge] conectado ${origin}`);
          continue;
        }
        try {
          if (m.type === "list") send({ type: "devices", serial: await listSerial() });
          else if (m.type === "open") {
            target?.close();
            const t = m.target ?? {};
            const onData = (b) => send({ type: "data", b64: Buffer.from(b).toString("base64") });
            const onClose = () => send({ type: "closed", reason: "target_closed" });
            if (t.kind === "serial" && typeof t.path === "string") target = await openSerial(t, onData, onClose);
            else if (t.kind === "tcp" && typeof t.host === "string" && Number(t.port) > 0) target = await openTcp(t, onData, onClose);
            else throw Object.assign(new Error("Destino inválido"), { code: "bad_target" });
            send({ type: "opened" });
            log(`[bridge] abierto ${t.kind === "tcp" ? `${t.host}:${t.port}` : t.path}`);
          } else if (m.type === "data" && typeof m.b64 === "string") {
            if (!target) send({ type: "error", code: "not_open", message: "No hay destino abierto" });
            else target.write(Buffer.from(m.b64, "base64"));
          } else if (m.type === "close") {
            target?.close();
            target = null;
            send({ type: "closed", reason: "client" });
          }
        } catch (e) {
          send({ type: "error", code: e.code ?? "error", message: e.message });
        }
      }
    });
  });

  server.listen(port, "127.0.0.1", () => log(`[bridge] escuchando en ws://127.0.0.1:${port}`));
  return server;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  if (flag("--list")) {
    console.log(JSON.stringify(await listSerial(), null, 2));
    process.exit(0);
  }
  const token = loadToken(flag("--new-token"));
  console.log("Puente local NinjaPOS");
  console.log(`Token para Configuración, Terminales, Conectar: ${token}`);
  if (ORIGINS.length === 0) console.log("Aviso: sin --origin sólo acepta páginas de localhost.");
  else console.log(`Orígenes permitidos: ${ORIGINS.join(", ")}`);
  startBridge({ token });
}
