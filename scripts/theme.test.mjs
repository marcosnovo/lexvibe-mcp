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

test("sigue buscando si el primer CSS no tiene tokens", () => {
  // Repartir el CSS en varios ficheros es lo normal: un Vite típico tiene el
  // reset en src/index.css y la paleta en src/App.css. Al parar en el primero
  // que existía, un proyecto CON paleta acababa con el color por defecto.
  const dir = project({
    "src/index.css": `* { margin: 0; box-sizing: border-box; }`,
    "src/App.css": `:root { --primary: #0ea5e9; --background: #ffffff; }`,
  });
  const t = parse(extractTheme(dir).tokens);
  assert.equal(t.c, "#0ea5e9");
  assert.equal(t.bg, "#ffffff");
});

test("el primer CSS gana si AMBOS tienen tokens", () => {
  // El orden de CSS_CANDIDATES es una preferencia: globals.css de Next manda
  // sobre App.css. Buscar más allá no debe cambiar esa prioridad.
  const dir = project({
    "src/app/globals.css": `:root { --primary: #111111; }`,
    "src/App.css": `:root { --primary: #999999; }`,
  });
  assert.equal(parse(extractTheme(dir).tokens).c, "#111111");
});

test("sin tokens en ninguno, el modo oscuro se sigue detectando", () => {
  // El respaldo al primer CSS existente importa: detectDark lo mira aunque no
  // haya tokens que heredar.
  const dir = project({
    "src/index.css": `.dark { color: white; }`,
    "public/manifest.json": `{"theme_color":"#ff8800"}`,
  });
  const t = extractTheme(dir);
  assert.equal(parse(t.tokens).c, "#ff8800");
  assert.match(t.dark ?? "", /class/);
});

test("el modo oscuro se detecta aunque esté en otro fichero que los tokens", () => {
  // El reparto típico: reset y `.dark` en index.css, paleta en App.css. Mirando
  // solo el fichero que aporta los tokens claros, el host salía como
  // `dark: "none"` y sin tokens oscuros aunque los tuviera declarados.
  const dir = project({
    "src/index.css": `* { margin: 0 }
      .dark { --primary: #eeeeee; --background: #000000; }`,
    "src/App.css": `:root { --primary: #0ea5e9; --background: #ffffff; }`,
  });
  const t = extractTheme(dir);
  assert.equal(parse(t.tokens).c, "#0ea5e9");
  assert.equal(t.dark, "class");
  assert.equal(parse(t.tokensDark ?? "").c, "#eeeeee");
});
