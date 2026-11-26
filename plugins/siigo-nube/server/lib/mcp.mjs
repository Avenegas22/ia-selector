// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Zero dependencies on purpose: the plugin runs with whatever Node >= 18 the
// user already has, without an `npm install` step.

import { createInterface } from "node:readline";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export class McpServer {
  /**
   * @param {{name: string, version: string, instructions?: string}} info
   */
  constructor(info) {
    this.info = info;
    /** @type {Map<string, {def: object, handler: (args: object) => Promise<any>}>} */
    this.tools = new Map();
  }

  /**
   * @param {{name: string, description: string, inputSchema: object, annotations?: object}} def
   * @param {(args: object) => Promise<any>} handler returns a string or a JSON-serialisable value
   */
  tool(def, handler) {
    this.tools.set(def.name, { def, handler });
  }

  start(input = process.stdin, output = process.stdout) {
    this.output = output;
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.#send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      this.#dispatch(msg).catch((err) => log("dispatch failure:", err?.stack || err));
    });
    rl.on("close", () => process.exit(0));
  }

  async #dispatch(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    if (!method) return; // a response to something we never send; ignore

    try {
      let result;
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          result = {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.info.name, version: this.info.version },
            ...(this.info.instructions ? { instructions: this.info.instructions } : {}),
          };
          break;
        }
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: [...this.tools.values()].map((t) => t.def) };
          break;
        case "tools/call":
          result = await this.#callTool(params?.name, params?.arguments ?? {});
          break;
        default:
          if (method.startsWith("notifications/")) return; // initialized, cancelled, ...
          if (isRequest) {
            this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
          }
          return;
      }
      if (isRequest) this.#send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      if (isRequest) {
        this.#send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message || err) } });
      }
    }
  }

  async #callTool(name, args) {
    const tool = this.tools.get(name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `Herramienta desconocida: ${name}` }] };
    }
    try {
      const value = await tool.handler(args);
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      // Tool failures go back to the model as isError results (not protocol
      // errors) so it can read Siigo's message and correct the call.
      return { isError: true, content: [{ type: "text", text: formatError(err) }] };
    }
  }

  #send(obj) {
    this.output.write(JSON.stringify(obj) + "\n");
  }
}

export function log(...parts) {
  process.stderr.write(`[siigo-mcp] ${parts.join(" ")}\n`);
}

function formatError(err) {
  if (err && err.siigo) {
    return JSON.stringify(
      { error: err.message, status: err.status, siigo: err.siigo },
      null,
      2,
    );
  }
  return String(err?.message || err);
}
