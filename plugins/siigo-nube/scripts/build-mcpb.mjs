#!/usr/bin/env node
// Builds dist/siigo-nube-<version>.mcpb — the one-file Claude Desktop extension.
//
//   node scripts/build-mcpb.mjs
//
// Version comes from .claude-plugin/plugin.json so the Claude Code plugin and
// the Desktop extension never drift. The manifest's `tools` list is generated
// by asking the real server for tools/list.

import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb/manifest.json"), "utf8"));

const stage = join(root, "dist", "mcpb-stage");
const out = join(root, "dist", `siigo-nube-${plugin.version}.mcpb`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(root, "server"), join(stage, "server"), { recursive: true });
cpSync(join(root, "mcpb/icon.png"), join(stage, "icon.png"));
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));

manifest.version = plugin.version;
manifest.tools = await listTools(join(stage, "server/index.mjs"));
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const mcpb = process.env.MCPB_BIN ? [process.env.MCPB_BIN] : ["npx", "-y", "@anthropic-ai/mcpb@2.1.2"];
execFileSync(mcpb[0], [...mcpb.slice(1), "validate", join(stage, "manifest.json")], { stdio: "inherit" });
execFileSync(mcpb[0], [...mcpb.slice(1), "pack", stage, out], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
console.log(`\n✔ ${out}`);

/** Starts the server (write tools enabled, no credentials needed) and reads tools/list. */
function listTools(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, SIIGO_READ_ONLY: "false" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      for (const line of buf.split("\n").slice(0, -1)) {
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          child.kill();
          resolve(
            msg.result.tools.map((t) => ({
              name: t.name,
              // Desktop shows this list before install: first sentence is enough.
              description: t.description.split(/(?<=\.)\s/)[0],
            })),
          );
        }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
    child.on("error", reject);
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}
