// Thin HTTP client for the Siigo Nube public API (https://api.siigo.com).
// Handles token acquisition/caching, the Partner-Id header, 429 back-off and
// Siigo's error envelope.

import { log } from "./mcp.mjs";

export class SiigoError extends Error {
  constructor(message, status, siigo) {
    super(message);
    this.status = status;
    this.siigo = siigo;
  }
}

export class SiigoClient {
  /**
   * @param {{username?: string, accessKey?: string, partnerId?: string, baseUrl?: string, fetchImpl?: typeof fetch}} cfg
   */
  constructor(cfg) {
    this.username = clean(cfg.username);
    this.accessKey = clean(cfg.accessKey);
    this.partnerId = clean(cfg.partnerId);
    this.baseUrl = (cfg.baseUrl || "https://api.siigo.com").replace(/\/+$/, "");
    this.fetch = cfg.fetchImpl || globalThis.fetch;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  missingConfig() {
    const missing = [];
    if (!this.username) missing.push("SIIGO_USERNAME");
    if (!this.accessKey) missing.push("SIIGO_ACCESS_KEY");
    if (!this.partnerId) missing.push("SIIGO_PARTNER_ID");
    return missing;
  }

  configProblems() {
    const problems = this.missingConfig().map((k) => `Falta ${k}`);
    // Siigo rejects anything but plain alphanumerics (even a hyphen) with invalid_partner_id.
    if (this.partnerId && !/^[A-Za-z0-9]{3,100}$/.test(this.partnerId)) {
      problems.push("El Partner-Id debe tener 3–100 caracteres alfanuméricos, sin espacios, guiones ni tildes");
    }
    return problems;
  }

  async #authenticate() {
    const problems = this.configProblems();
    if (problems.length) {
      throw new SiigoError(
        `Configuración de Siigo incompleta: ${problems.join("; ")}. Revisa la configuración de la extensión/plugin (usuario API, access key y Partner-Id).`,
        0,
      );
    }
    const res = await this.fetch(`${this.baseUrl}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Partner-Id": this.partnerId },
      body: JSON.stringify({ username: this.username, access_key: this.accessKey }),
    });
    const body = await readBody(res);
    if (!res.ok || !body?.access_token) {
      throw new SiigoError(
        `Autenticación con Siigo falló (HTTP ${res.status}). Verifica usuario API, access key y Partner-Id.`,
        res.status,
        body,
      );
    }
    this.token = body.access_token;
    const ttl = Number(body.expires_in) || 86400;
    // Refresh 5 minutes before Siigo says the token expires.
    this.tokenExpiresAt = Date.now() + Math.max(60, ttl - 300) * 1000;
    return this.token;
  }

  async #getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    return this.#authenticate();
  }

  /**
   * @param {"GET"|"POST"|"PUT"|"DELETE"} method
   * @param {string} path e.g. "/v1/invoices"
   * @param {{query?: Record<string, any>, body?: any, headers?: Record<string, string>}} [opts]
   */
  async request(method, path, opts = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query || {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    let retriedAuth = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.#getToken();
      const res = await this.fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Partner-Id": this.partnerId,
          ...(opts.headers || {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });

      if (res.status === 401 && !retriedAuth) {
        // Token revoked or expired early: re-authenticate once.
        retriedAuth = true;
        this.token = null;
        continue;
      }
      if (res.status === 429 && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
        log(`429 de Siigo; reintentando en ${waitMs} ms`);
        await sleep(waitMs);
        continue;
      }

      const body = await readBody(res);
      if (!res.ok) {
        throw new SiigoError(summariseErrors(body) || `Siigo respondió HTTP ${res.status}`, res.status, body);
      }
      return body;
    }
  }

  get(path, query) {
    return this.request("GET", path, { query });
  }

  post(path, body, headers) {
    return this.request("POST", path, { body, headers });
  }

  /**
   * Walks Siigo's page-based pagination and returns all results (bounded).
   * @param {string} path
   * @param {Record<string, any>} query
   * @param {number} maxItems hard ceiling so a broad query can't run away
   */
  async getAll(path, query = {}, maxItems = 2000) {
    const pageSize = 100;
    const results = [];
    let total = undefined;
    for (let page = 1; ; page++) {
      const body = await this.get(path, { ...query, page, page_size: pageSize });
      const items = body?.results ?? [];
      total = body?.pagination?.total_results ?? total;
      results.push(...items);
      if (items.length < pageSize || results.length >= maxItems) break;
      if (total !== undefined && results.length >= total) break;
    }
    return { results: results.slice(0, maxItems), total: total ?? results.length, truncated: results.length >= maxItems && (total ?? 0) > maxItems };
  }
}

// Unset user_config values can arrive as an empty string or as the literal
// placeholder, depending on the host. Treat both as missing.
function clean(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (!s || /^\$\{.*\}$/.test(s)) return undefined;
  return s;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Siigo documents PascalCase keys (Errors/Code/Message) but some responses
// use lowercase, so read both.
function summariseErrors(body) {
  const errors = body?.Errors || body?.errors || body?.error?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors
    .map((e) => [e.Code || e.code, e.Message || e.message].filter(Boolean).join(": "))
    .join(" | ");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
