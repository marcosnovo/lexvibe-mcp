/*
 * La telemetría stdio debe anunciar la versión REAL del paquete, contra el
 * BUILD (`dist/analytics.js`).
 *
 * Existe porque `analytics.ts` llevaba la versión escrita a mano ("1.0.0") y
 * cada llamada a una herramienta, en cualquier release, se registraba como
 * 1.0.0: el README promete que el evento lleva «la versión del paquete» y los
 * datos de uso se atribuían a la versión equivocada. El smoke vigila el
 * `serverInfo` y `server.json`, pero no ve lo que se manda por red.
 *
 * Requiere `npm run build` antes (lo hace el CI).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

test("trackToolCall envía la versión de package.json, no una escrita a mano", async () => {
  // La telemetría tiene que estar activa y no salir a la red de verdad.
  delete process.env.LEXVIBE_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  process.env.LEXVIBE_EVENTS_URL = "http://127.0.0.1:9/events";

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response("{}");
  };
  try {
    const { trackToolCall } = await import(pathToFileURL(join(ROOT, "dist", "analytics.js")).href);
    trackToolCall("scan_project");
    // El POST es fire-and-forget: dejamos correr la cola antes de mirar.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(sent.length, 1, "debe enviarse exactamente un evento");
  assert.equal(sent[0].body.event, "mcp_tool_call");
  assert.equal(sent[0].body.props.tool, "scan_project");
  assert.equal(
    sent[0].body.props.version,
    pkgVersion,
    `la telemetría anuncia ${sent[0].body.props.version} y el paquete es ${pkgVersion}`,
  );
});
