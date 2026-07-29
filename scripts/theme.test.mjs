/*
 * Extracción del aspecto de la app destino, contra el BUILD (`dist/theme.js`).
 *
 * Lo que se protege aquí es sobre todo lo que NO se debe emitir: un valor que
 * el navegador no sepa parsear dentro de un `var()` invalida la declaración
 * que lo consume, y eso en el banner significa un botón "Aceptar" transparente
 * en la web del cliente. Es preferible no heredar nada a heredar algo roto.
 *
 * Requiere `npm run build` antes (lo hace el CI).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { extractTheme } = await import(join(ROOT, "dist", "theme.js"));

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "lexvibe-theme-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/** Convierte `--lv-c:#fff;--lv-bg:#000` en un objeto para aserciones legibles. */
const parse = (tokens) =>
  Object.fromEntries(
    tokens.split(";").map((p) => {
      const i = p.indexOf(":");
      return [p.slice(0, i).replace("--lv-", ""), p.slice(i + 1)];
    }),
  );

test("Next + shadcn: el triplete HSL suelto se envuelve en hsl()", () => {
  const dir = project({
    "src/app/globals.css": `:root {
      --background: 0 0% 100%;
      --card: 0 0% 100%;
      --primary: 243 75% 59%;
      --primary-foreground: 0 0% 100%;
      --border: 220 16% 90%;
      --radius: 0.75rem;
    }
    .dark { --background: 224 26% 8%; --primary: 243 80% 70%; }`,
    "tailwind.config.ts": `export default { darkMode: ["class"] }`,
  });
  const theme = extractTheme(dir);
  const t = parse(theme.tokens);
  // Un triplete suelto NO es un color por sí mismo: sin hsl() no pinta nada.
  assert.equal(t.c, "hsl(243 75% 59%)");
  assert.equal(t.cf, "hsl(0 0% 100%)");
  assert.equal(theme.dark, "class");
  // La paleta oscura del anfitrión también se extrae: así el banner cambia
  // con su tema por CSS, sin que el widget tenga que observar nada.
  assert.equal(parse(theme.tokensDark).bg, "hsl(224 26% 8%)");
});

test("Tailwind v4 con oklch: no se emite (Safari antiguo no lo parsea)", () => {
  const dir = project({
    "src/index.css": `@theme {
      --color-primary: oklch(0.62 0.19 260);
      --color-background: #ffffff;
    }`,
  });
  const theme = extractTheme(dir);
  const t = parse(theme.tokens);
  // Clave: un oklch enlazado con var() invalida la declaración que lo usa y
  // el botón sale transparente. Mejor no heredar el acento que romperlo.
  assert.equal(t.c, undefined);
  assert.equal(t.bg, "#ffffff");
});

test("CSS plano con hex: se toma tal cual", () => {
  const dir = project({
    "src/index.css": `:root { --primary: #ff6600; --border: #eee; }`,
  });
  assert.equal(parse(extractTheme(dir).tokens).c, "#ff6600");
});

test("sin tokens: se cae al theme_color del manifest", () => {
  const dir = project({
    "public/manifest.json": `{"name":"x","theme_color":"#0d9488"}`,
  });
  const theme = extractTheme(dir);
  assert.equal(parse(theme.tokens).c, "#0d9488");
  assert.match(theme.source, /manifest/);
});

test("sin nada que detectar: null, nunca un color inventado", () => {
  // Inventar un acento sería peor que no heredar: el usuario vería un color
  // que no es el suyo y no sabría de dónde ha salido.
  assert.equal(extractTheme(project({ "package.json": "{}" })), null);
});

test("valores con sintaxis peligrosa se descartan", () => {
  const dir = project({
    "src/index.css": `:root { --primary: url(javascript:alert(1)); --card: #fff; }`,
  });
  const t = parse(extractTheme(dir).tokens);
  assert.equal(t.c, undefined);
  assert.equal(t.bg, "#fff");
});

test("detecta la fuente de next/font para poder anunciarla", () => {
  const dir = project({
    "src/index.css": `:root { --primary: #123456; }`,
    "src/app/layout.tsx": `import { Inter } from "next/font/google";
      const inter = Inter({ subsets: ["latin"] });`,
  });
  assert.equal(extractTheme(dir).font, "Inter");
});
