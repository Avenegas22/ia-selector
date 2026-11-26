// Read-only tools. None of these create or change anything in Siigo.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGING_BUCKETS, bucketFor, daysBetween, round2, todayBogota } from "../lib/co.mjs";

const READ = { readOnlyHint: true, openWorldHint: true };

const DOC_PATHS = {
  invoices: "/v1/invoices",
  credit_notes: "/v1/credit-notes",
  vouchers: "/v1/vouchers",
  journals: "/v1/journals",
  purchases: "/v1/purchases",
};

const CATALOGS = {
  document_types: { path: "/v1/document-types", needs: "type" },
  taxes: { path: "/v1/taxes" },
  payment_types: { path: "/v1/payment-types", needs: "document_type" },
  sellers: { path: "/v1/users", paginated: true },
  cost_centers: { path: "/v1/cost-centers" },
  account_groups: { path: "/v1/account-groups" },
  warehouses: { path: "/v1/warehouses" },
  price_lists: { path: "/v1/price-lists" },
  fixed_assets: { path: "/v1/fixed-assets" },
  expenses: { path: "/v1/expenses" },
  misc_incomes: { path: "/v1/misc-incomes" },
};

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Fecha AAAA-MM-DD" };
const PAGE = { type: "integer", minimum: 1, description: "Página (inicia en 1)" };
const PAGE_SIZE = { type: "integer", minimum: 10, maximum: 100, description: "Resultados por página (10–100, por defecto 25)" };

export function registerReadTools(server, siigo, ctx) {
  server.tool(
    {
      name: "siigo_status",
      title: "Estado de la conexión",
      description:
        "Verifica la configuración y la conexión con Siigo Nube: credenciales, formato del Partner-Id, autenticación y modo solo lectura. Úsala primero si algo falla o al configurar.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: READ,
    },
    async () => {
      const problems = siigo.configProblems();
      const out = {
        version: ctx.version,
        modo_solo_lectura: ctx.readOnly,
        usuario_api: siigo.username ?? null,
        partner_id: siigo.partnerId ?? null,
        problemas_configuracion: problems,
      };
      if (problems.length) return { ...out, conectado: false };
      const types = await siigo.get("/v1/document-types", { type: "FV" });
      return {
        ...out,
        conectado: true,
        tipos_factura_activos: asArray(types)
          .filter((t) => t.active !== false)
          .map((t) => ({ id: t.id, codigo: t.code, nombre: t.name, electronica: t.electronic_type })),
      };
    },
  );

  server.tool(
    {
      name: "siigo_find_customers",
      title: "Buscar clientes / terceros",
      description:
        "Busca terceros (clientes, proveedores) en Siigo. Por número de identificación hace una consulta directa; por texto recorre el directorio y filtra por nombre (más lento, máx. 2000 terceros).",
      inputSchema: {
        type: "object",
        properties: {
          identification: { type: "string", description: "NIT o cédula sin dígito de verificación" },
          text: { type: "string", description: "Parte del nombre o razón social" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        additionalProperties: false,
      },
      annotations: READ,
    },
    async ({ identification, text, limit = 10 }) => {
      if (!identification && !text) throw new Error("Indica identification o text.");
      if (identification) {
        const body = await siigo.get("/v1/customers", { identification: digitsOr(identification) });
        return asArray(body).slice(0, limit).map(compactCustomer);
      }
      const needle = norm(text);
      const all = await siigo.getAll("/v1/customers", {}, 2000);
      const hits = all.results.filter((c) => norm(customerName(c)).includes(needle) || norm(c.commercial_name).includes(needle));
      return { coincidencias: hits.slice(0, limit).map(compactCustomer), revisados: all.results.length, truncado: all.truncated };
    },
  );

  server.tool(
    {
      name: "siigo_get_customer",
      title: "Detalle de tercero",
      description: "Trae el registro completo de un tercero por su id (GUID de Siigo).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      annotations: READ,
    },
    async ({ id }) => siigo.get(`/v1/customers/${encodeURIComponent(id)}`),
  );

  server.tool(
    {
      name: "siigo_find_products",
      title: "Buscar productos",
      description:
        "Busca productos y servicios. Por código hace consulta directa; por texto recorre el catálogo y filtra por nombre/referencia. Devuelve precios, impuestos y existencias.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Código exacto del producto" },
          text: { type: "string", description: "Parte del nombre, referencia o descripción" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        additionalProperties: false,
      },
      annotations: READ,
    },
    async ({ code, text, limit = 10 }) => {
      if (code) return asArray(await siigo.get("/v1/products", { code })).slice(0, limit).map(compactProduct);
      const all = await siigo.getAll("/v1/products", {}, 2000);
      const needle = norm(text ?? "");
      const hits = all.results.filter((p) => [p.name, p.reference, p.description, p.code].some((v) => norm(v).includes(needle)));
      return { coincidencias: hits.slice(0, limit).map(compactProduct), revisados: all.results.length, truncado: all.truncated };
    },
  );

  server.tool(
    {
      name: "siigo_list_documents",
      title: "Listar documentos",
      description:
        "Lista documentos contables: facturas de venta, notas crédito, recibos de caja, comprobantes contables o facturas de compra, con filtros por fecha, número o cliente. Devuelve un resumen por documento (total, saldo, estado DIAN).",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: Object.keys(DOC_PATHS) },
          date_start: DATE,
          date_end: DATE,
          created_start: DATE,
          created_end: DATE,
          name: { type: "string", description: "Número completo del documento, p. ej. FV-1-457" },
          customer_identification: { type: "string", description: "Solo facturas: identificación del cliente" },
          only_open: { type: "boolean", description: "Solo facturas/compras con saldo pendiente (> 0)" },
          page: PAGE,
          page_size: PAGE_SIZE,
        },
        required: ["type"],
        additionalProperties: false,
      },
      annotations: READ,
    },
    async ({ type, page = 1, page_size = 25, only_open, ...filters }) => {
      const body = await siigo.get(DOC_PATHS[type], { ...filters, page, page_size });
      let rows = asArray(body).map(compactDocument);
      if (only_open) rows = rows.filter((r) => Number(r.saldo) > 0);
      return { paginacion: body?.pagination ?? null, documentos: rows };
    },
  );

  server.tool(
    {
      name: "siigo_get_document",
      title: "Detalle de documento",
      description: "Trae el documento completo (ítems, impuestos, pagos, estado DIAN, CUFE, enlace público) por su id.",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string", enum: Object.keys(DOC_PATHS) }, id: { type: "string" } },
        required: ["type", "id"],
        additionalProperties: false,
      },
      annotations: READ,
    },
    async ({ type, id }) => siigo.get(`${DOC_PATHS[type]}/${encodeURIComponent(id)}`),
  );

  server.tool(
    {
      name: "siigo_download_pdf",
      title: "Descargar PDF",
      description:
        "Descarga el PDF de una factura de venta o nota crédito y lo guarda en disco (por defecto en la carpeta Descargas). Devuelve la ruta del archivo.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["invoices", "credit_notes"], default: "invoices" },
          id: { type: "string" },
          output_dir: { type: "string", description: "Carpeta destino (opcional)" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: READ,
    },
    async ({ type = "invoices", id, output_dir }) => {
      const doc = await siigo.get(`${DOC_PATHS[type]}/${encodeURIComponent(id)}`);
      const pdf = await siigo.get(`${DOC_PATHS[type]}/${encodeURIComponent(id)}/pdf`);
      if (!pdf?.base64) throw new Error("Siigo no devolvió el PDF.");
      const dir = outputDir(output_dir);
      const file = join(dir, `${safeName(doc?.name || id)}.pdf`);
      writeFileSync(file, Buffer.from(pdf.base64, "base64"));
      return { archivo: file, documento: doc?.name, cufe: pdf.cufe ?? doc?.stamp?.cufe ?? null };
    },
  );

  server.tool(
    {
      name: "siigo_catalog",
      title: "Catálogos de configuración",
      description:
        "Consulta los catálogos de la empresa que se necesitan para crear documentos: tipos de documento (requiere document_type: FV, NC, RC, FC, CC…), impuestos, formas de pago (requiere document_type), vendedores, centros de costo, grupos de inventario, bodegas, listas de precios, activos fijos, gastos e ingresos varios.",
      inputSchema: {
        type: "object",
        properties: {
          catalog: { type: "string", enum: Object.keys(CATALOGS) },
          document_type: { type: "string", description: "Para document_types y payment_types: FV, NC, RC, FC, CC, DS…" },
          only_active: { type: "boolean", default: true },
        },
        required: ["catalog"],
        additionalProperties: false,
      },
      annotations: READ,
    },
    async ({ catalog, document_type, only_active = true }) => {
      const cfg = CATALOGS[catalog];
      const query = {};
      if (cfg.needs) {
        if (!document_type) throw new Error(`El catálogo ${catalog} requiere document_type (FV, NC, RC, FC, CC…).`);
        query[cfg.needs] = document_type;
      }
      const rows = cfg.paginated ? (await siigo.getAll(cfg.path, query, 500)).results : asArray(await siigo.get(cfg.path, query));
      return only_active ? rows.filter((r) => r.active !== false) : rows;
    },
  );

  server.tool(
    {
      name: "siigo_accounts_receivable",
      title: "Cartera por edades",
      description:
        "Arma la cartera (cuentas por cobrar) por edades a una fecha de corte: recorre las facturas de venta con saldo pendiente y las agrupa por cliente y por días de vencimiento (por vencer, 1–30, 31–60, 61–90, +90). Siigo no tiene un endpoint de cartera; esto se calcula a partir de las facturas.",
      inputSchema: {
        type: "object",
        properties: {
          as_of: { ...DATE, description: "Fecha de corte (por defecto hoy, hora Colombia)" },
          date_start: { ...DATE, description: "Desde qué fecha de factura buscar (por defecto 2 años antes del corte)" },
          customer_identification: { type: "string" },
          top: { type: "integer", minimum: 1, maximum: 200, default: 30, description: "Cuántos clientes detallar" },
        },
        additionalProperties: false,
      },
      annotations: READ,
    },
    async ({ as_of, date_start, customer_identification, top = 30 }) => {
      const cut = as_of || todayBogota();
      const from = date_start || shiftYears(cut, -2);
      const all = await siigo.getAll("/v1/invoices", { date_start: from, date_end: cut, customer_identification }, 5000);
      const open = all.results.filter((inv) => Number(inv.balance) > 0);

      const byCustomer = new Map();
      const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0]));
      for (const inv of open) {
        const due = dueDate(inv);
        const overdue = daysBetween(due, cut);
        const bucket = bucketFor(overdue);
        const bal = Number(inv.balance);
        totals[bucket] += bal;
        const id = inv.customer?.identification ?? "¿?";
        if (!byCustomer.has(id)) {
          byCustomer.set(id, { identificacion: id, saldo: 0, ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])), facturas: [] });
        }
        const row = byCustomer.get(id);
        row.saldo += bal;
        row[bucket] += bal;
        row.facturas.push({ id: inv.id, numero: inv.name, fecha: inv.date, vence: due, dias_vencida: Math.max(0, overdue), saldo: round2(bal) });
      }

      const ranked = [...byCustomer.values()].sort((a, b) => b.saldo - a.saldo);
      // Name lookups cost one request each (100 req/min limit), so only for the top rows.
      for (const row of ranked.slice(0, top)) {
        try {
          const c = asArray(await siigo.get("/v1/customers", { identification: row.identificacion }))[0];
          row.nombre = c ? customerName(c) : null;
        } catch {
          row.nombre = null;
        }
      }
      const fix = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? round2(v) : v]));
      return {
        fecha_corte: cut,
        facturas_revisadas_desde: from,
        facturas_revisadas: all.results.length,
        busqueda_truncada: all.truncated,
        total_cartera: round2(open.reduce((s, i) => s + Number(i.balance), 0)),
        por_edad: Object.fromEntries(AGING_BUCKETS.map((b) => [b.label, round2(totals[b.key])])),
        clientes_con_saldo: ranked.length,
        detalle: ranked.slice(0, top).map((r) => ({ ...fix(r), facturas: r.facturas.sort((a, b) => b.dias_vencida - a.dias_vencida) })),
      };
    },
  );

  server.tool(
    {
      name: "siigo_accounts_payable",
      title: "Cuentas por pagar",
      description:
        "Cuentas por pagar a proveedores (endpoint oficial de Siigo), agrupadas por proveedor y por edad de vencimiento a una fecha de corte.",
      inputSchema: {
        type: "object",
        properties: {
          as_of: { ...DATE, description: "Fecha de corte (por defecto hoy)" },
          due_date_start: DATE,
          due_date_end: DATE,
          provider_identification: { type: "string" },
        },
        additionalProperties: false,
      },
      annotations: READ,
    },
    async ({ as_of, ...filters }) => {
      const cut = as_of || todayBogota();
      const all = await siigo.getAll("/v1/accounts-payable", filters, 5000);
      const byProvider = new Map();
      const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0]));
      for (const r of all.results) {
        const bal = Number(r.due?.balance ?? r.currency?.balance ?? 0);
        if (!(bal > 0)) continue;
        const overdue = r.due?.date ? daysBetween(r.due.date, cut) : 0;
        const bucket = bucketFor(overdue);
        totals[bucket] += bal;
        const key = r.provider?.identification ?? "¿?";
        if (!byProvider.has(key)) byProvider.set(key, { identificacion: key, nombre: r.provider?.name ?? null, saldo: 0, documentos: [] });
        const p = byProvider.get(key);
        p.saldo += bal;
        p.documentos.push({
          documento: [r.due?.prefix, r.due?.consecutive].filter(Boolean).join("-"),
          cuota: r.due?.quote,
          vence: r.due?.date,
          dias_vencido: Math.max(0, overdue),
          saldo: round2(bal),
        });
      }
      const ranked = [...byProvider.values()].sort((a, b) => b.saldo - a.saldo).map((p) => ({ ...p, saldo: round2(p.saldo) }));
      return {
        fecha_corte: cut,
        total_por_pagar: round2(ranked.reduce((s, p) => s + p.saldo, 0)),
        por_edad: Object.fromEntries(AGING_BUCKETS.map((b) => [b.label, round2(totals[b.key])])),
        proveedores: ranked,
        busqueda_truncada: all.truncated,
      };
    },
  );

  server.tool(
    {
      name: "siigo_trial_balance",
      title: "Balance de prueba",
      description:
        "Genera el balance de prueba (general o por tercero) de un año y rango de meses. Siigo lo entrega como archivo Excel: devuelve el enlace y, si se pide, lo descarga a disco. Mes 13 = cierre.",
      inputSchema: {
        type: "object",
        properties: {
          year: { type: "integer", minimum: 2000, maximum: 2100 },
          month_start: { type: "integer", minimum: 1, maximum: 13 },
          month_end: { type: "integer", minimum: 1, maximum: 13 },
          by_third_party: { type: "boolean", default: false },
          customer_identification: { type: "string", description: "Solo por tercero: limitar a un tercero (sin DV)" },
          account_start: { type: "string", description: "Cuenta PUC inicial (opcional)" },
          account_end: { type: "string", description: "Cuenta PUC final (opcional)" },
          includes_tax_difference: { type: "boolean", default: false },
          download: { type: "boolean", default: true },
          output_dir: { type: "string" },
        },
        required: ["year", "month_start", "month_end"],
        additionalProperties: false,
      },
      annotations: READ,
    },
    async (a) => {
      if (a.month_start > a.month_end) throw new Error("month_start no puede ser mayor que month_end.");
      const body = {
        year: a.year,
        month_start: a.month_start,
        month_end: a.month_end,
        includes_tax_difference: a.includes_tax_difference ?? false,
        ...(a.account_start ? { account_start: a.account_start } : {}),
        ...(a.account_end ? { account_end: a.account_end } : {}),
      };
      let path = "/v1/test-balance-report";
      if (a.by_third_party) {
        path = "/v1/test-balance-report-by-thirdparty";
        if (a.customer_identification) body.customer = { identification: digitsOr(a.customer_identification), branch_office: 0 };
      }
      const res = await siigo.post(path, body);
      const out = { archivo_url: res?.file_url, file_id: res?.file_id };
      if (a.download !== false && res?.file_url) {
        const r = await fetch(res.file_url);
        if (r.ok) {
          const name = `Balance de prueba ${a.by_third_party ? "por tercero " : ""}${a.year} ${a.month_start}-${a.month_end}.xlsx`;
          const file = join(outputDir(a.output_dir), name);
          writeFileSync(file, Buffer.from(await r.arrayBuffer()));
          out.archivo = file;
        } else {
          out.aviso = `No se pudo descargar el Excel (HTTP ${r.status}); usa el enlace.`;
        }
      }
      return out;
    },
  );

  server.tool(
    {
      name: "siigo_api_get",
      title: "Consulta GET genérica",
      description:
        "Consulta de solo lectura a cualquier ruta /v1/ de la API de Siigo que no cubran las demás herramientas (GET con parámetros).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta que empieza por /v1/, p. ej. /v1/payment-receipts" },
          query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: READ,
    },
    async ({ path, query }) => {
      if (!/^\/v1\/[A-Za-z0-9\-_/]+$/.test(path) || path.includes("..")) {
        throw new Error("La ruta debe empezar por /v1/ y contener solo letras, números, guiones y barras.");
      }
      return siigo.get(path, query);
    },
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

export function asArray(body) {
  if (Array.isArray(body)) return body;
  return body?.results ?? [];
}

export function customerName(c) {
  if (!c) return "";
  const n = Array.isArray(c.name) ? c.name.filter(Boolean).join(" ") : c.name;
  return n || c.commercial_name || "";
}

function compactCustomer(c) {
  return {
    id: c.id,
    tipo: c.type,
    persona: c.person_type,
    tipo_id: c.id_type?.code ?? c.id_type,
    identificacion: c.identification,
    dv: c.check_digit,
    sucursal: c.branch_office,
    nombre: customerName(c),
    nombre_comercial: c.commercial_name,
    activo: c.active,
    ciudad: c.address?.city?.city_name ?? c.address?.city?.city_code,
    email: c.contacts?.[0]?.email,
    telefono: c.phones?.[0]?.number,
  };
}

function compactProduct(p) {
  return {
    id: p.id,
    codigo: p.code,
    nombre: p.name,
    tipo: p.type,
    activo: p.active,
    referencia: p.reference,
    impuestos: (p.taxes || []).map((t) => ({ id: t.id, nombre: t.name, tipo: t.type, porcentaje: t.percentage })),
    impuesto_incluido: p.tax_included,
    precios: (p.prices?.[0]?.price_list || []).map((pl) => ({ lista: pl.position, nombre: pl.name, valor: pl.value })),
    existencias: p.available_quantity,
    unidad: p.unit_label ?? p.unit?.name ?? p.unit,
  };
}

function compactDocument(d) {
  return {
    id: d.id,
    numero: d.name,
    fecha: d.date,
    tercero: d.customer?.identification ?? d.supplier?.identification,
    total: d.total,
    saldo: d.balance,
    vence: d.payments?.find((p) => p.due_date)?.due_date,
    estado_dian: d.stamp?.status,
    tipo: d.type,
    observaciones: d.observations ? String(d.observations).slice(0, 120) : undefined,
  };
}

function dueDate(inv) {
  return inv.payments?.find((p) => p.due_date)?.due_date || inv.date;
}

function shiftYears(date, years) {
  const [y, m, d] = date.split("-");
  return `${Number(y) + years}-${m}-${d}`;
}

const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

// "900.123.456-7" → "900123456": Siigo wants the identification without DV.
// Alphanumeric ids (passports, foreign ids) pass through untouched.
export const digitsOr = (s) => {
  const t = String(s).trim();
  if (!/^[\d.\-\s]+$/.test(t)) return t;
  return t.replace(/-\s*\d$/, "").replace(/\D/g, "");
};

const safeName = (s) => String(s).replace(/[^\w\-. ]+/g, "_");

export function outputDir(requested) {
  const candidates = [requested, process.env.SIIGO_OUTPUT_DIR, join(homedir(), "Downloads"), join(homedir(), "Descargas")];
  for (const c of candidates) {
    if (!c) continue;
    const dir = resolve(c);
    if (c === requested || c === process.env.SIIGO_OUTPUT_DIR) {
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    if (existsSync(dir)) return dir;
  }
  return tmpdir();
}
