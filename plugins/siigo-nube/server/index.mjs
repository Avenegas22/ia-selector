#!/usr/bin/env node
// Siigo Nube MCP server — entry point.
// Config comes from env vars (set by the Claude Code plugin's userConfig or the
// Claude Desktop extension's user_config):
//   SIIGO_USERNAME, SIIGO_ACCESS_KEY, SIIGO_PARTNER_ID   required
//   SIIGO_READ_ONLY=true                                 hide tools that create records
//   SIIGO_BASE_URL                                       override (tests)
//   SIIGO_OUTPUT_DIR                                     where PDFs/Excel are saved

import { McpServer } from "./lib/mcp.mjs";
import { SiigoClient } from "./lib/siigo-client.mjs";
import { registerReadTools } from "./tools/read.mjs";
import { registerWriteTools } from "./tools/write.mjs";

const VERSION = "0.1.0";

if (Number(process.versions.node.split(".")[0]) < 18) {
  process.stderr.write(`[siigo-mcp] Se requiere Node 18 o superior (actual ${process.version}).\n`);
  process.exit(1);
}

const readOnly = /^(1|true|yes|si|sí)$/i.test(String(process.env.SIIGO_READ_ONLY ?? "").trim());

const siigo = new SiigoClient({
  username: process.env.SIIGO_USERNAME,
  accessKey: process.env.SIIGO_ACCESS_KEY,
  partnerId: process.env.SIIGO_PARTNER_ID,
  baseUrl: process.env.SIIGO_BASE_URL,
});

const server = new McpServer({
  name: "siigo-nube",
  version: VERSION,
  instructions: [
    "Servidor MCP para Siigo Nube (Colombia). Montos en COP.",
    "Identificaciones (NIT/cédula) siempre sin dígito de verificación.",
    "Para facturar: siigo_preview_invoice → mostrar resumen al usuario → solo con aprobación explícita siigo_create_invoice(preview_id).",
    "Antes de crear terceros o productos, confirma los datos con el usuario.",
    "Siigo limita a 100 llamadas por minuto y bloquea usuarios API con muchos errores: prefiere consultas precisas (por identificación o código) a barridos completos.",
    readOnly ? "Modo solo lectura activo: no hay herramientas de creación." : "",
  ]
    .filter(Boolean)
    .join("\n"),
});

const ctx = { version: VERSION, readOnly };
registerReadTools(server, siigo, ctx);
if (!readOnly) registerWriteTools(server, siigo, ctx);

server.start();
