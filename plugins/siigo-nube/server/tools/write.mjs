// Tools that create records in Siigo. Not registered when SIIGO_READ_ONLY=true.
//
// Invoices go through two steps on purpose:
//   1. siigo_preview_invoice validates every reference against Siigo, computes
//      totals with Siigo's rounding rule and stores the exact payload under a
//      preview_id. Nothing is created.
//   2. siigo_create_invoice takes only that preview_id and sends the stored
//      payload, using the preview_id as Siigo's Idempotency-Key. What the user
//      approved is byte-for-byte what is sent, and a retry can't duplicate it.

import { randomUUID } from "node:crypto";
import { nitCheckDigit, round2, todayBogota } from "../lib/co.mjs";
import { asArray, customerName, digitsOr } from "./read.mjs";

const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const IRREVERSIBLE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const ADDITIVE_TAXES = new Set(["IVA", "Impoconsumo"]);

const ID_TYPES = {
  13: "Cédula de ciudadanía",
  31: "NIT",
  22: "Cédula de extranjería",
  41: "Pasaporte",
  42: "Documento de identificación extranjero",
  12: "Tarjeta de identidad",
  11: "Registro civil",
  47: "PEP",
  48: "PPT",
  50: "NIT de otro país",
  21: "Tarjeta de extranjería",
};

export function registerWriteTools(server, siigo, ctx) {
  const previews = new Map();

  server.tool(
    {
      name: "siigo_create_customer",
      title: "Crear tercero",
      description:
        "Crea un cliente/proveedor en Siigo. Calcula el dígito de verificación del NIT si no se indica y deriva el departamento del código DANE de la ciudad. Confirma los datos con el usuario antes de llamarla.",
      inputSchema: {
        type: "object",
        properties: {
          person_type: { type: "string", enum: ["Person", "Company"], description: "Person = persona natural, Company = persona jurídica" },
          id_type: { type: "string", enum: Object.keys(ID_TYPES), description: Object.entries(ID_TYPES).map(([k, v]) => `${k}=${v}`).join(", ") },
          identification: { type: "string", description: "Sin dígito de verificación" },
          check_digit: { type: "string", description: "DV del NIT (se calcula si se omite)" },
          first_name: { type: "string", description: "Persona natural: nombres" },
          last_name: { type: "string", description: "Persona natural: apellidos" },
          company_name: { type: "string", description: "Persona jurídica: razón social" },
          commercial_name: { type: "string" },
          type: { type: "string", enum: ["Customer", "Supplier", "Other"], default: "Customer" },
          branch_office: { type: "integer", minimum: 0, maximum: 999, default: 0 },
          address: { type: "string" },
          city_code: { type: "string", pattern: "^\\d{5}$", description: "Código DANE de 5 dígitos (Bogotá 11001, Medellín 05001, Cali 76001, Barranquilla 08001)" },
          phone: { type: "string" },
          email: { type: "string" },
          contact_first_name: { type: "string" },
          contact_last_name: { type: "string" },
          fiscal_responsibilities: { type: "array", items: { type: "string", enum: ["R-99-PN", "O-13", "O-15", "O-23", "O-47"] }, default: ["R-99-PN"] },
          vat_responsible: { type: "boolean", default: false, description: "¿Es responsable de IVA?" },
        },
        required: ["person_type", "id_type", "identification", "address", "city_code"],
        additionalProperties: false,
      },
      annotations: CREATE,
    },
    async (a) => {
      const identification = digitsOr(a.identification);
      const branch = a.branch_office ?? 0;
      const names = a.person_type === "Person" ? [a.first_name, a.last_name] : [a.company_name];
      if (names.some((n) => !n || !String(n).trim())) {
        throw new Error(a.person_type === "Person" ? "Persona natural: indica first_name y last_name." : "Persona jurídica: indica company_name.");
      }
      const existing = asArray(await siigo.get("/v1/customers", { identification })).find((c) => Number(c.branch_office ?? 0) === branch);
      if (existing) {
        return { ya_existia: true, id: existing.id, nombre: customerName(existing), mensaje: "El tercero ya existe en Siigo; no se creó de nuevo." };
      }
      let checkDigit = a.check_digit;
      if (a.id_type === "31" && !checkDigit) checkDigit = String(nitCheckDigit(identification));

      const body = {
        type: a.type ?? "Customer",
        person_type: a.person_type,
        id_type: a.id_type,
        identification,
        ...(checkDigit ? { check_digit: checkDigit } : {}),
        name: names.map((n) => String(n).trim()),
        ...(a.commercial_name ? { commercial_name: a.commercial_name } : {}),
        branch_office: branch,
        active: true,
        vat_responsible: a.vat_responsible ?? false,
        fiscal_responsibilities: (a.fiscal_responsibilities?.length ? a.fiscal_responsibilities : ["R-99-PN"]).map((code) => ({ code })),
        address: {
          address: a.address,
          city: { country_code: "Co", state_code: a.city_code.slice(0, 2), city_code: a.city_code },
        },
        phones: a.phone ? [{ number: String(a.phone).replace(/\D/g, "") }] : [],
        contacts: [
          {
            first_name: a.contact_first_name || names[0],
            last_name: a.contact_last_name || (a.person_type === "Person" ? names[1] : ""),
            ...(a.email ? { email: a.email } : {}),
            ...(a.phone ? { phone: { number: String(a.phone).replace(/\D/g, "") } } : {}),
          },
        ],
      };
      const created = await siigo.post("/v1/customers", body);
      return { creado: true, id: created?.id, identificacion: identification, dv: checkDigit ?? null, nombre: names.join(" ") };
    },
  );

  server.tool(
    {
      name: "siigo_create_product",
      title: "Crear producto o servicio",
      description:
        "Crea un producto o servicio en Siigo. Requiere el grupo de inventario (siigo_catalog account_groups) y opcionalmente impuestos (siigo_catalog taxes). Confirma los datos con el usuario antes de llamarla.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", pattern: "^\\S{1,30}$", description: "Código único, sin espacios, máx. 30" },
          name: { type: "string", maxLength: 100 },
          account_group_id: { type: "integer", description: "Id del grupo de inventario" },
          type: { type: "string", enum: ["Product", "Service"], default: "Product" },
          price: { type: "number", minimum: 0, description: "Precio de la lista 1, en COP" },
          tax_ids: { type: "array", items: { type: "integer" } },
          tax_included: { type: "boolean", default: false, description: "¿El precio ya incluye IVA?" },
          unit: { type: "string", default: "94", description: "Código DIAN de unidad (94 = unidad)" },
          stock_control: { type: "boolean" },
          reference: { type: "string" },
          description: { type: "string" },
        },
        required: ["code", "name", "account_group_id"],
        additionalProperties: false,
      },
      annotations: CREATE,
    },
    async (a) => {
      const existing = asArray(await siigo.get("/v1/products", { code: a.code }))[0];
      if (existing) return { ya_existia: true, id: existing.id, nombre: existing.name, mensaje: "Ya existe un producto con ese código; no se creó." };
      const body = {
        code: a.code,
        name: a.name,
        account_group: a.account_group_id,
        type: a.type ?? "Product",
        stock_control: a.stock_control ?? (a.type ?? "Product") === "Product",
        active: true,
        tax_included: a.tax_included ?? false,
        unit: a.unit ?? "94",
        ...(a.tax_ids?.length ? { taxes: a.tax_ids.map((id) => ({ id })) } : {}),
        ...(a.price !== undefined ? { prices: [{ currency_code: "COP", price_list: [{ position: 1, value: a.price }] }] } : {}),
        ...(a.reference ? { reference: a.reference } : {}),
        ...(a.description ? { description: a.description } : {}),
      };
      const created = await siigo.post("/v1/products", body);
      return { creado: true, id: created?.id, codigo: a.code, nombre: a.name };
    },
  );

  server.tool(
    {
      name: "siigo_preview_invoice",
      title: "Vista previa de factura",
      description:
        "Calcula y valida una factura de venta sin crearla (paso 1 de 2). Valida cliente, productos, tipo de documento, vendedor, forma de pago e impuestos contra Siigo, calcula subtotal/IVA/total con la regla de redondeo de Siigo y devuelve un preview_id. NO crea nada. Muestra el resumen al usuario y solo si lo aprueba explícitamente llama siigo_create_invoice con ese preview_id. Si falta un dato (tipo de documento, vendedor, forma de pago), el error lista las opciones válidas.",
      inputSchema: {
        type: "object",
        properties: {
          customer_identification: { type: "string", description: "NIT/cédula del cliente, sin DV" },
          branch_office: { type: "integer", minimum: 0, default: 0 },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                code: { type: "string", description: "Código del producto en Siigo" },
                quantity: { type: "number", exclusiveMinimum: 0 },
                price: { type: "number", minimum: 0, description: "Precio unitario ANTES de IVA, en COP" },
                discount: { type: "number", minimum: 0, description: "Descuento: valor o porcentaje según el tipo de documento (ver advertencias)" },
                description: { type: "string" },
                tax_ids: { type: "array", items: { type: "integer" }, description: "Si se omite, usa los impuestos del producto" },
              },
              required: ["code", "quantity", "price"],
              additionalProperties: false,
            },
          },
          document_id: { type: "integer", description: "Tipo de documento FV (si hay uno solo activo se usa ese)" },
          seller_id: { type: "integer", description: "Vendedor (si hay uno solo activo se usa ese)" },
          payment_type_id: { type: "integer", description: "Forma de pago (si hay una sola activa se usa esa)" },
          due_date: { ...DATE, description: "Vencimiento, obligatorio si la forma de pago es a crédito" },
          date: { ...DATE, description: "Fecha de la factura (por defecto hoy). Una factura electrónica no puede tener fecha anterior a hoy." },
          number: { type: "integer", description: "Solo si el tipo de documento tiene numeración manual" },
          cost_center_id: { type: "integer" },
          observations: { type: "string", maxLength: 4000 },
          send_to_dian: { type: "boolean", default: true, description: "Enviar a la DIAN al crear (factura electrónica)" },
          email_customer: { type: "boolean", default: false, description: "Enviar por correo al cliente" },
        },
        required: ["customer_identification", "items"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      const today = todayBogota();
      const date = a.date || today;
      const identification = digitsOr(a.customer_identification);
      const branch = a.branch_office ?? 0;
      const warnings = [];

      const [docTypes, payTypes, taxes, customers, sellers] = await Promise.all([
        siigo.get("/v1/document-types", { type: "FV" }).then(asArray),
        siigo.get("/v1/payment-types", { document_type: "FV" }).then(asArray),
        siigo.get("/v1/taxes").then(asArray),
        siigo.get("/v1/customers", { identification }).then(asArray),
        siigo.getAll("/v1/users", {}, 500).then((r) => r.results),
      ]);

      const docType = pick(docTypes, a.document_id, "tipo de documento de factura (document_id)", (t) => `${t.id} = ${t.name}${t.electronic_type ? ` [${t.electronic_type}]` : ""}`);
      const electronic = docType.electronic_type && !/^No/i.test(String(docType.electronic_type));
      if (electronic && date < today) throw new Error(`Una factura electrónica no puede tener fecha anterior a hoy (${today}).`);
      if (docType.cost_center_mandatory && !a.cost_center_id) throw new Error("Este tipo de documento exige centro de costo: indica cost_center_id (siigo_catalog cost_centers).");
      if (docType.automatic_number === false && !a.number) throw new Error("Este tipo de documento tiene numeración manual: indica number.");

      const customer = customers.find((c) => Number(c.branch_office ?? 0) === branch);
      if (!customer) throw new Error(`El cliente ${identification} (sucursal ${branch}) no existe en Siigo. Créalo primero con siigo_create_customer.`);
      if (customer.active === false) throw new Error(`El cliente ${identification} está inactivo en Siigo.`);

      const seller = pick(sellers, a.seller_id, "vendedor (seller_id)", (u) => `${u.id} = ${[u.first_name, u.last_name].filter(Boolean).join(" ") || u.username}`);
      const payType = pick(payTypes, a.payment_type_id, "forma de pago (payment_type_id)", (p) => `${p.id} = ${p.name}${p.due_date ? " (crédito, requiere due_date)" : ""}`);
      if (payType.due_date && !a.due_date) throw new Error(`La forma de pago "${payType.name}" es a crédito: indica due_date (AAAA-MM-DD).`);
      if (payType.due_date && a.due_date < date) throw new Error("due_date no puede ser anterior a la fecha de la factura.");

      const taxById = new Map(taxes.map((t) => [Number(t.id), t]));
      const percentDiscount = String(docType.discount_type || "").toLowerCase() === "percentage";
      const lines = [];
      for (const it of a.items) {
        const product = asArray(await siigo.get("/v1/products", { code: it.code }))[0];
        if (!product) throw new Error(`El producto con código "${it.code}" no existe en Siigo.`);
        if (product.active === false) throw new Error(`El producto "${it.code}" está inactivo.`);
        const taxIds = it.tax_ids ?? (product.taxes || []).map((t) => Number(t.id));
        const itemTaxes = taxIds.map((id) => {
          const t = taxById.get(Number(id));
          if (!t) throw new Error(`El impuesto ${id} no existe en Siigo (producto ${it.code}).`);
          if (!ADDITIVE_TAXES.has(t.type)) {
            throw new Error(
              `El producto ${it.code} lleva "${t.name}" (${t.type}). Esta versión solo calcula IVA e Impoconsumo; las retenciones regístralas en el recibo de caja o crea esta factura directamente en Siigo.`,
            );
          }
          return t;
        });

        const gross = it.quantity * it.price;
        const discountAmount = it.discount ? (percentDiscount ? gross * (it.discount / 100) : it.discount) : 0;
        const base = round2(gross - discountAmount);
        const taxLines = itemTaxes.map((t) => ({ id: Number(t.id), nombre: t.name, porcentaje: Number(t.percentage), valor: round2((base * Number(t.percentage)) / 100) }));
        const total = round2(base + taxLines.reduce((s, t) => s + t.valor, 0));
        lines.push({ it, product, base, taxLines, total });
      }
      if (a.items.some((i) => i.discount)) {
        warnings.push(`El tipo de documento maneja descuentos por ${percentDiscount ? "PORCENTAJE" : "VALOR"}; el campo discount se interpretó así.`);
      }

      const subtotal = round2(lines.reduce((s, l) => s + l.base, 0));
      const taxTotals = {};
      for (const l of lines) for (const t of l.taxLines) taxTotals[t.nombre] = round2((taxTotals[t.nombre] || 0) + t.valor);
      const total = round2(lines.reduce((s, l) => s + l.total, 0));

      const payload = {
        document: { id: Number(docType.id) },
        date,
        ...(a.number ? { number: a.number } : {}),
        customer: { identification, branch_office: branch },
        seller: Number(seller.id),
        ...(a.cost_center_id ? { cost_center: a.cost_center_id } : {}),
        ...(a.observations ? { observations: a.observations } : {}),
        stamp: { send: a.send_to_dian ?? true },
        mail: { send: a.email_customer ?? false },
        items: lines.map(({ it, taxLines }) => ({
          code: it.code,
          ...(it.description ? { description: it.description } : {}),
          quantity: it.quantity,
          price: it.price,
          ...(it.discount ? { discount: it.discount } : {}),
          taxes: taxLines.map((t) => ({ id: t.id })),
        })),
        payments: [{ id: Number(payType.id), value: total, ...(payType.due_date ? { due_date: a.due_date } : {}) }],
      };

      const preview_id = randomUUID().replace(/-/g, "").slice(0, 30); // Siigo Idempotency-Key: alphanumeric, ≤30
      const expires = Date.now() + PREVIEW_TTL_MS;
      prune(previews);
      previews.set(preview_id, { payload, expires });

      return {
        preview_id,
        vence_vista_previa: new Date(expires).toISOString(),
        resumen: {
          documento: `${docType.name} (id ${docType.id})${electronic ? " — electrónica" : ""}`,
          fecha: date,
          cliente: `${customerName(customer)} — ${identification}${branch ? ` suc. ${branch}` : ""}`,
          vendedor: [seller.first_name, seller.last_name].filter(Boolean).join(" ") || seller.username,
          forma_de_pago: payType.name,
          vence: payType.due_date ? a.due_date : "contado",
          items: lines.map(({ it, product, base, taxLines, total: t }) => ({
            codigo: it.code,
            producto: it.description || product.name,
            cantidad: it.quantity,
            precio_unitario: it.price,
            descuento: it.discount || 0,
            base,
            impuestos: taxLines.map((x) => `${x.nombre} ${x.porcentaje}%: ${x.valor}`),
            total: t,
          })),
          subtotal,
          impuestos: taxTotals,
          total,
          enviar_a_dian: payload.stamp.send,
          enviar_por_correo: payload.mail.send,
        },
        advertencias: warnings,
        siguiente_paso: "Muestra este resumen al usuario. Solo con su aprobación explícita llama siigo_create_invoice con este preview_id.",
      };
    },
  );

  server.tool(
    {
      name: "siigo_create_invoice",
      title: "Crear factura (confirmada)",
      description:
        "Crea en Siigo la factura aprobada en una vista previa y la envía a la DIAN (paso 2 de 2). Usa exactamente el payload de siigo_preview_invoice. Irreversible: una factura aceptada por la DIAN solo se corrige con nota crédito. Llámala únicamente después de que el usuario apruebe explícitamente el resumen. Reintentar con el mismo preview_id no duplica la factura.",
      inputSchema: {
        type: "object",
        properties: { preview_id: { type: "string", pattern: "^[A-Za-z0-9]{1,30}$" } },
        required: ["preview_id"],
        additionalProperties: false,
      },
      annotations: IRREVERSIBLE,
    },
    async ({ preview_id }) => {
      const p = previews.get(preview_id);
      if (!p || p.expires < Date.now()) {
        previews.delete(preview_id);
        throw new Error("La vista previa no existe o expiró (60 min). Genera una nueva con siigo_preview_invoice.");
      }
      const inv = await siigo.post("/v1/invoices", p.payload, { "Idempotency-Key": preview_id });
      previews.delete(preview_id);
      const out = {
        creada: true,
        id: inv?.id,
        numero: inv?.name,
        total: inv?.total,
        estado_dian: inv?.stamp?.status ?? null,
        cufe: inv?.stamp?.cufe ?? null,
        errores_dian: inv?.stamp?.errors ?? null,
        correo: inv?.mail?.status ?? null,
        enlace_publico: inv?.public_url ?? null,
      };
      if (out.estado_dian === "Rejected") {
        out.aviso = "La DIAN rechazó la factura. Consulta el detalle con siigo_api_get en /v1/invoices/{id}/stamp/errors y corrígela en Siigo.";
      }
      return out;
    },
  );

  server.tool(
    {
      name: "siigo_email_invoice",
      title: "Enviar factura por correo",
      description:
        "Envía por correo una factura de venta ya creada (PDF y XML) al cliente y hasta 4 copias. Confirma destinatarios con el usuario antes de llamarla.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "id (GUID) de la factura" },
          mail_to: { type: "string", format: "email" },
          copy_to: { type: "array", items: { type: "string", format: "email" }, maxItems: 4 },
        },
        required: ["id", "mail_to"],
        additionalProperties: false,
      },
      annotations: CREATE,
    },
    async ({ id, mail_to, copy_to }) => {
      const body = { mail_to, ...(copy_to?.length ? { copy_to: copy_to.join(";") } : {}) };
      const res = await siigo.post(`/v1/invoices/${encodeURIComponent(id)}/mail`, body);
      return { enviado: true, respuesta: res };
    },
  );
}

/** Picks a record by id, or the only active one; otherwise lists the valid options. */
function pick(rows, id, label, fmt) {
  const active = rows.filter((r) => r.active !== false);
  if (id !== undefined) {
    const hit = active.find((r) => Number(r.id) === Number(id));
    if (hit) return hit;
    throw new Error(`No hay ${label} activo con id ${id}. Opciones: ${active.map(fmt).join("; ") || "ninguna"}`);
  }
  if (active.length === 1) return active[0];
  if (active.length === 0) throw new Error(`La empresa no tiene ${label} activo en Siigo.`);
  throw new Error(`Hay varias opciones de ${label}; pregunta al usuario cuál usar: ${active.map(fmt).join("; ")}`);
}

function prune(map) {
  const now = Date.now();
  for (const [k, v] of map) if (v.expires < now) map.delete(k);
}
