#!/usr/bin/env node
/*
 * Prueba de humo del servidor MCP compilado, por stdio y en JSON-RPC real:
 * `initialize` → `tools/list` y comprobación de que están las 10 herramientas
 * con sus parámetros clave.
 *
 * Existe porque hasta ahora NADA ejecutaba el binario que se publica a npm. El
 * paquete llegó a shippear con un `import "./detect.js"` que no resolvía en
 * modo dev y con dos herramientas de menos que el otro repo, sin que nada
 * fallara. Esto no sustituye a los tests unitarios: verifica lo mínimo
 * imprescindible — que arranca y anuncia su contrato.
 *
 * Uso: node scripts/smoke.mjs [ruta/al/dist/index.js]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.argv[2] ?? join(ROOT, "dist", "index.js");

if (!existsSync(entry)) {
  console.error(`No existe ${entry}. Ejecuta primero: npm run build`);
  process.exit(2);
}

/** Contrato mínimo: herramienta → parámetros que DEBEN existir en su schema. */
const EXPECTED = {
  scan_project: ["dir"],
  check_compliance: ["dir", "entity", "contactEmail", "markets"],
  generate_policies: ["appName", "markets", "locales"],
  install_snippet: ["file", "appId", "accent", "position", "lang"],
  check_ai_act: ["usesAI"],
  check_website: ["url"],
  verify_snippet: ["url"],
  make_compliant: ["dir", "appId", "markets"],
  claim_app: ["url", "facts", "signals"],
  get_claim_status: ["code"],
};

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "inherit"],
  // La telemetría es fire-and-forget, pero en CI no tiene sentido emitirla.
  env: { ...process.env, LEXVIBE_TELEMETRY: "0" },
});

const timer = setTimeout(() => {
  console.error("Timeout: el servidor no respondió a tools/list en 20s.");
  child.kill("SIGKILL");
  process.exit(1);
}, 20_000);

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === 2) finish(message);
  }
});

function finish(message) {
  clearTimeout(timer);
  child.kill();
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) {
    console.error("tools/list no devolvió una lista:", JSON.stringify(message).slice(0, 400));
    process.exit(1);
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  const problems = [];
  for (const [name, params] of Object.entries(EXPECTED)) {
    const tool = byName.get(name);
    if (!tool) {
      problems.push(`falta la herramienta ${name}`);
      continue;
    }
    const props = Object.keys(tool.inputSchema?.properties ?? {});
    for (const param of params) {
      if (!props.includes(param)) problems.push(`${name}: falta el parámetro "${param}"`);
    }
  }
  const extra = tools.map((t) => t.name).filter((n) => !(n in EXPECTED));
  if (extra.length > 0) {
    // No es un fallo: una herramienta nueva es legítima. Pero que se vea.
    console.log(`Herramientas nuevas (no cubiertas por el smoke): ${extra.join(", ")}`);
  }
  if (problems.length > 0) {
    console.error("Contrato del servidor MCP roto:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`OK — ${tools.length} herramientas anunciadas, contrato mínimo cumplido.`);
  process.exit(0);
}

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
