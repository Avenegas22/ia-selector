// End-to-end tests: spawns the real MCP server over stdio and points it at a
// fake Siigo API that mimics the documented responses.
//   node --test test/

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../server/index.mjs");
const OUT = mkdtempSync(join(tmpdir(), "siigo-test-"));

// ── fake Siigo ───────────────────────────────────────────────────────────
const log = [];
let authCount = 0;
let failNextWith = null; // { status, headers? }
const TODAY = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(TODAY) - n * 86400e3).toISOString().slice(0, 10);

const DB = {
  docTypes: [{ id: 24446, code: "1", name: "Factura electrónica", active: true, electronic_type: "ElectronicInvoice", automatic_number: true, discount_type: "Value" }],
  payTypes: [
    { id: 5636, name: "Crédito", type: "Cartera", active: true, due_date: true },
    { id: 5637, name: "Efectivo", type: "Cartera", active: true, due_date: false },
  ],
  taxes: [
    { id: 13156, name: "IVA 19%", type: "IVA", percentage: 19, active: true },
    { id: 13157, name: "Retefuente 2.5%", type: "Retefuente", percentage: 2.5, active: true },
  ],
  users: [
    { id: 629, username: "ana@x.co", first_name: "Ana", last_name: "Ruiz", active: true },
    { id: 630, username: "leo@x.co", first_name: "Leo", last_name: "Gil", active: true },
  ],
  customers: [{ id: "c-1", identification: "900123456", branch_office: 0, name: ["Acme SAS"], active: true, person_type: "Company" }],
  products: [
    { id: "p-1", code: "SRV-01", name: "Consultoría", active: true, taxes: [{ id: 13156, name: "IVA 19%", type: "IVA", percentage: 19 }] },
    { id: "p-2", code: "RET-01", name: "Con retención", active: true, taxes: [{ id: 13157 }] },
  ],
  invoices: [
    { id: "i-1", name: "FV-1-1", date: daysAgo(100), customer: { identification: "900123456" }, total: 1000, balance: 1000, payments: [{ id: 5636, due_date: daysAgo(70) }] },
    { id: "i-2", name: "FV-1-2", date: daysAgo(10), customer: { identification: "900123456" }, total: 500, balance: 500, payments: [{ id: 5636, due_date: daysAgo(-20) }] },
    { id: "i-3", name: "FV-1-3", date: daysAgo(40), customer: { identification: "800999111" }, total: 300, balance: 0, payments: [] },
  ],
};

const siigo = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : undefined;
  log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: json });
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };

  if (url.pathname === "/auth") {
    authCount++;
    if (json?.access_key !== "good-key") return send(401, { Errors: [{ Code: "unauthorized", Message: "bad creds" }] });
    return send(200, { access_token: `tok${authCount}`, expires_in: 86400, token_type: "Bearer" });
  }
  if (url.pathname === "/files/balance.xlsx") {
    // Real Siigo returns a pre-signed Azure Blob URL: no auth headers.
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end("XLSXDATA");
  }
  if (req.headers.authorization !== `Bearer tok${authCount}`) return send(401, { Errors: [{ Code: "unauthorized" }] });
  if (!req.headers["partner-id"]) return send(400, { Errors: [{ Code: "header_required", Message: "Partner-Id" }] });
  if (failNextWith) {
    const f = failNextWith;
    failNextWith = null;
    return send(f.status, { Errors: [{ Code: "requests_limit", Message: "slow down" }] }, f.headers);
  }

  const page = (rows) => {
    const p = Number(url.searchParams.get("page") || 1);
    const size = Number(url.searchParams.get("page_size") || 25);
    return { pagination: { page: p, page_size: size, total_results: rows.length }, results: rows.slice((p - 1) * size, p * size) };
  };
  const q = (k) => url.searchParams.get(k);

  switch (`${req.method} ${url.pathname}`) {
    case "GET /v1/document-types":
      return q("type") ? send(200, DB.docTypes) : send(400, { Errors: [{ Code: "parameter_required" }] });
    case "GET /v1/payment-types":
      return send(200, DB.payTypes);
    case "GET /v1/taxes":
      return send(200, DB.taxes);
    case "GET /v1/users":
      return send(200, page(DB.users));
    case "GET /v1/customers":
      return send(200, page(DB.customers.filter((c) => !q("identification") || c.identification === q("identification"))));
    case "POST /v1/customers":
      return send(201, { id: "c-new", ...json });
    case "GET /v1/products":
      return send(200, page(DB.products.filter((p) => !q("code") || p.code === q("code"))));
    case "GET /v1/invoices":
      return send(200, page(DB.invoices));
    case "POST /v1/invoices":
      return send(201, { id: "i-new", name: "FV-1-99", total: json.payments[0].value, balance: json.payments[0].value, stamp: { status: "Accepted", cufe: "abc" }, mail: { status: "NotSent" } });
    case "POST /v1/test-balance-report":
      return send(201, { file_id: "f1", file_url: `http://127.0.0.1:${siigo.address().port}/files/balance.xlsx` });
    default:
      return send(404, { Errors: [{ Code: "not_found", Message: `${req.method} ${url.pathname}` }] });
  }
});

// ── MCP client over stdio ───────────────────────────────────────────────
function startMcp(env) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH, SIIGO_BASE_URL: `http://127.0.0.1:${siigo.address().port}`, SIIGO_OUTPUT_DIR: OUT, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: !!r.result.isError, data, text };
  };
  return { child, rpc, call, close: () => child.kill() };
}

const CREDS = { SIIGO_USERNAME: "api@empresa.co", SIIGO_ACCESS_KEY: "good-key", SIIGO_PARTNER_ID: "adaptativeTest" };
let mcp;

before(async () => {
  await new Promise((r) => siigo.listen(0, "127.0.0.1", r));
  mcp = startMcp(CREDS);
  const init = await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "siigo-nube");
});
after(() => {
  mcp?.close();
  siigo.close();
});

// ── tests ────────────────────────────────────────────────────────────────
test("tools/list exposes read + write tools, read-only mode hides writes", async () => {
  const all = (await mcp.rpc("tools/list")).result.tools.map((t) => t.name);
  assert.ok(all.includes("siigo_preview_invoice") && all.includes("siigo_accounts_receivable"));
  const ro = startMcp({ ...CREDS, SIIGO_READ_ONLY: "true" });
  await ro.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const roTools = (await ro.rpc("tools/list")).result.tools.map((t) => t.name);
  ro.close();
  assert.ok(!roTools.some((n) => /create|preview|email/.test(n)), roTools.join(","));
  assert.ok(roTools.includes("siigo_find_customers"));
});

test("status reports bad config without calling Siigo", async () => {
  const bad = startMcp({ SIIGO_USERNAME: "x", SIIGO_ACCESS_KEY: "${user_config.siigo_access_key}", SIIGO_PARTNER_ID: "mi-app" });
  await bad.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const r = await bad.call("siigo_status");
  bad.close();
  assert.equal(r.data.conectado, false);
  assert.match(r.data.problemas_configuracion.join(" "), /SIIGO_ACCESS_KEY/);
  assert.match(r.data.problemas_configuracion.join(" "), /alfanuméricos/);
});

test("status authenticates and sends Partner-Id + Bearer token", async () => {
  const r = await mcp.call("siigo_status");
  assert.equal(r.data.conectado, true);
  assert.equal(r.data.tipos_factura_activos[0].id, 24446);
  const auth = log.find((l) => l.path === "/auth");
  assert.deepEqual(auth.body, { username: "api@empresa.co", access_key: "good-key" });
  const call = log.find((l) => l.path === "/v1/document-types");
  assert.equal(call.headers["partner-id"], "adaptativeTest");
  assert.match(call.headers.authorization, /^Bearer tok\d+$/);
});

test("customer lookup strips DV and punctuation from NIT", async () => {
  const r = await mcp.call("siigo_find_customers", { identification: "900.123.456-7" });
  assert.equal(r.data[0].nombre, "Acme SAS");
  assert.equal(log.at(-1).query.identification, "900123456");
});

test("create customer computes NIT check digit and DANE state code", async () => {
  const r = await mcp.call("siigo_create_customer", {
    person_type: "Company", id_type: "31", identification: "890903938", company_name: "Bancolombia",
    address: "Cra 48 # 26-85", city_code: "05001", email: "a@b.co",
  });
  assert.equal(r.data.creado, true);
  const sent = log.findLast((l) => l.method === "POST" && l.path === "/v1/customers").body;
  assert.equal(sent.check_digit, "8");
  assert.deepEqual(sent.address.city, { country_code: "Co", state_code: "05", city_code: "05001" });
  assert.deepEqual(sent.name, ["Bancolombia"]);
});

test("preview lists options when the seller is ambiguous", async () => {
  const r = await mcp.call("siigo_preview_invoice", { customer_identification: "900123456", items: [{ code: "SRV-01", quantity: 1, price: 100 }], payment_type_id: 5637 });
  assert.equal(r.isError, true);
  assert.match(r.text, /629 = Ana Ruiz; 630 = Leo Gil/);
});

test("preview refuses retention taxes it can't compute", async () => {
  const r = await mcp.call("siigo_preview_invoice", { customer_identification: "900123456", seller_id: 629, payment_type_id: 5637, items: [{ code: "RET-01", quantity: 1, price: 100 }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /Retefuente/);
});

test("credit payment requires due_date", async () => {
  const r = await mcp.call("siigo_preview_invoice", { customer_identification: "900123456", seller_id: 629, payment_type_id: 5636, items: [{ code: "SRV-01", quantity: 1, price: 100 }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /due_date/);
});

test("preview → create sends exactly the previewed payload with Idempotency-Key", async () => {
  const due = new Date(Date.parse(TODAY) + 30 * 86400e3).toISOString().slice(0, 10);
  const posts = () => log.filter((l) => l.method === "POST" && l.path === "/v1/invoices").length;
  const before = posts();
  const p = await mcp.call("siigo_preview_invoice", {
    customer_identification: "900123456", seller_id: 629, payment_type_id: 5636, due_date: due,
    items: [{ code: "SRV-01", quantity: 2, price: 1069.77 }, { code: "SRV-01", quantity: 3, price: 333.33, discount: 9.99 }],
  });
  assert.equal(p.isError, false, p.text);
  assert.equal(posts(), before, "preview must not create anything");
  // line1: base 2139.54, IVA round2(406.5126)=406.51 → 2546.05
  // line2: 3×333.33−9.99 = 990.00, IVA 188.10 → 1178.10
  assert.equal(p.data.resumen.subtotal, 3129.54);
  assert.equal(p.data.resumen.total, 3724.15);

  const c = await mcp.call("siigo_create_invoice", { preview_id: p.data.preview_id });
  assert.equal(c.data.numero, "FV-1-99");
  const sent = log.findLast((l) => l.method === "POST" && l.path === "/v1/invoices");
  assert.equal(sent.headers["idempotency-key"], p.data.preview_id);
  assert.deepEqual(sent.body.payments, [{ id: 5636, value: 3724.15, due_date: due }]);
  assert.deepEqual(sent.body.items[0].taxes, [{ id: 13156 }]);
  assert.equal(sent.body.stamp.send, true);

  const again = await mcp.call("siigo_create_invoice", { preview_id: p.data.preview_id });
  assert.equal(again.isError, true, "a consumed preview cannot be reused");
  assert.equal(posts(), before + 1);
});

test("accounts receivable ages open invoices by due date", async () => {
  const r = await mcp.call("siigo_accounts_receivable", {});
  assert.equal(r.data.total_cartera, 1500);
  assert.equal(r.data.por_edad["61–90 días"], 1000);
  assert.equal(r.data.por_edad["Por vencer"], 500);
  assert.equal(r.data.clientes_con_saldo, 1);
  assert.equal(r.data.detalle[0].nombre, "Acme SAS");
  assert.equal(r.data.detalle[0].facturas[0].dias_vencida, 70);
});

test("re-authenticates once on 401 and backs off on 429", async () => {
  const authsBefore = authCount;
  authCount += 1; // invalidates the cached token server-side
  failNextWith = null;
  const r1 = await mcp.call("siigo_catalog", { catalog: "taxes" });
  assert.equal(r1.isError, false, r1.text);
  assert.equal(authCount, authsBefore + 2);

  failNextWith = { status: 429, headers: { "retry-after": "1" } };
  const t0 = Date.now();
  const r2 = await mcp.call("siigo_catalog", { catalog: "taxes" });
  assert.equal(r2.isError, false, r2.text);
  assert.ok(Date.now() - t0 >= 900);
});

test("trial balance downloads the Excel Siigo links to", async () => {
  const r = await mcp.call("siigo_trial_balance", { year: 2026, month_start: 1, month_end: 10 });
  assert.ok(r.data.archivo, r.text);
  assert.equal(readFileSync(r.data.archivo, "utf8"), "XLSXDATA");
  const sent = log.findLast((l) => l.path === "/v1/test-balance-report").body;
  assert.deepEqual(sent, { year: 2026, month_start: 1, month_end: 10, includes_tax_difference: false });
});

test("generic GET is confined to /v1/", async () => {
  const r = await mcp.call("siigo_api_get", { path: "/v1/../auth" });
  assert.equal(r.isError, true);
});

test("Siigo error envelope is surfaced to the model", async () => {
  const r = await mcp.call("siigo_catalog", { catalog: "document_types" });
  assert.equal(r.isError, true);
  assert.match(r.text, /document_type/);
});
