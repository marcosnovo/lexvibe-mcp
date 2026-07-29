import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Extracts the destination app's look so the cookie banner ships already
 * matching it, instead of arriving in LexVibe's default purple and making the
 * user ask their AI to "adapt this to my UI".
 *
 * Everything here is regex-based on purpose. `tailwind.config.ts` is arbitrary
 * user code and importing it would execute it; a wrong colour is a cosmetic
 * bug, running a stranger's config is not.
 */

export interface ExtractedTheme {
  /**
   * Ready-to-paste CSS declarations for the widget: `--lv-c:#6366f1;--lv-r:12px`.
   * Fully resolved here so the widget needs no parsing and no colour logic.
   */
  tokens: string;
  /** Same, for the host's dark palette (`.dark{…}`), when it has one. */
  tokensDark?: string;
  /** Human-readable provenance, for the install message. */
  source: string;
  /** Detected font family name, if any (applied via inherited typography). */
  font?: string;
  /** Dark mode strategy the host uses. */
  dark?: "class" | "media" | "none";
}

/** Widget suffix → CSS custom property names, most specific first. */
const VAR_MAP: [string, string[]][] = [
  ["c", ["primary", "brand", "color-primary"]],
  ["cf", ["primary-foreground", "color-primary-foreground"]],
  ["bg", ["card", "background", "color-background"]],
  ["fg", ["card-foreground", "foreground"]],
  ["m", ["muted-foreground"]],
  ["bd", ["border", "color-border"]],
  ["sf", ["muted", "secondary"]],
  ["r", ["radius-lg", "radius"]],
];

const CSS_CANDIDATES = [
  "src/app/globals.css",
  "app/globals.css",
  "src/index.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/App.css",
];

function read(dir: string, rel: string): string | null {
  try {
    return readFileSync(join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

/** Body of the first `:root{…}` / `@theme{…}` block (where shadcn puts tokens). */
function rootBlock(css: string): string {
  const m = /(?::root|@theme[^{]*)\s*\{([\s\S]*?)\}/.exec(css);
  return m?.[1] ?? "";
}

/** Body of the host's dark palette — `.dark{…}` or a prefers-color-scheme block. */
function darkBlock(css: string): string {
  const cls = /\.dark\s*(?:,[^{]*)?\{([\s\S]*?)\}/.exec(css);
  if (cls?.[1]) return cls[1];
  const media = /@media[^{]*prefers-color-scheme:\s*dark[^{]*\{[\s\S]*?:root\s*\{([\s\S]*?)\}/.exec(
    css,
  );
  return media?.[1] ?? "";
}

/** Turns a CSS block into `--lv-c:…;--lv-bg:…` declarations for the widget. */
function declarations(block: string): string {
  const vars = readVars(block);
  const out: string[] = [];
  for (const [suffix, names] of VAR_MAP) {
    for (const name of names) {
      const raw = vars.get(name);
      if (raw === undefined) continue;
      const value = normalise(raw);
      if (!value) continue;
      out.push(`--lv-${suffix}:${value}`);
      break;
    }
  }
  return out.join(";");
}

const TRIPLET = /^-?[\d.]+\s+[\d.]+%\s+[\d.]+%$/;
/**
 * Whitelist of the ONLY shapes we ever emit. This is a security boundary, not
 * a formatting nicety: the value ends up inside `data-tokens="…"` in an HTML
 * file we WRITE INTO THE USER'S PROJECT. A value containing a double quote
 * closes the attribute and everything after it becomes markup — i.e. script
 * injection performed by the compliance tool itself.
 *
 * So: exact hex, exact rgb()/hsl() with only digits/commas/percent/spaces, a
 * bare CSS keyword, or a length. Anything else is dropped.
 */
const HEX = /^#[0-9a-f]{3,8}$/i;
const FUNC = /^(?:rgb|hsl)a?\([\d.,%\s/]+\)$/i;
const KEYWORD = /^[a-z]+$/i;
const LENGTH = /^-?[\d.]+(?:px|rem|em|%)?$/i;

/**
 * Normalises a raw custom-property value to something safe to emit.
 *
 * The important case is the bare HSL triplet shadcn writes (`222 47% 11%`):
 * on its own it is not a colour, it only becomes one inside `hsl()`. The other
 * is `oklch`, which older Safari cannot parse — and an unparseable value makes
 * the whole declaration invalid, i.e. a transparent Accept button. Those get
 * dropped here rather than shipped as a live link.
 */
function normalise(raw: string): string | null {
  const v = raw.trim().replace(/;$/, "");
  if (!v) return null;
  // El triplete suelto de shadcn no es un color hasta envolverlo.
  if (TRIPLET.test(v)) return `hsl(${v})`;
  // oklch/lab/color(): un navegador que no los parsea invalida la declaración
  // que los consume — en el banner, un botón "Aceptar" transparente.
  if (/^(?:oklch|lab|lch|color)\(/i.test(v)) return null;
  // Whitelist estricta. Todo lo que no encaje EXACTAMENTE se descarta: es
  // preferible no heredar un token a escribir algo peligroso en el HTML ajeno.
  if (HEX.test(v) || FUNC.test(v) || KEYWORD.test(v) || LENGTH.test(v)) return v;
  return null;
}

/** `--primary: 243 75% 59%;` pairs from a CSS block. */
function readVars(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(name!.trim(), value!.trim());
  }
  return out;
}

function detectFont(dir: string): string | undefined {
  for (const rel of ["src/app/layout.tsx", "app/layout.tsx", "index.html", "src/main.tsx"]) {
    const src = read(dir, rel);
    if (!src) continue;
    const nextFont = /from\s+["']next\/font\/google["']|(\w+)\s*\(\s*\{[^}]*subsets/.exec(src);
    if (nextFont) {
      const named = /import\s*\{\s*([A-Z]\w+)/.exec(src);
      if (named?.[1]) return named[1].replace(/_/g, " ");
    }
    const google = /fonts\.googleapis\.com\/css2?\?family=([^&"'&]+)/.exec(src);
    if (google?.[1]) return decodeURIComponent(google[1].replace(/\+/g, " ")).split(":")[0];
  }
  return undefined;
}

function detectDark(dir: string, css: string): "class" | "media" | "none" {
  for (const rel of ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.cjs"]) {
    const cfg = read(dir, rel);
    if (cfg && /darkMode\s*:\s*\[?\s*["']class["']/.test(cfg)) return "class";
  }
  if (/\.dark\s*[,{]/.test(css)) return "class";
  if (/prefers-color-scheme\s*:\s*dark/.test(css)) return "media";
  return "none";
}

export function extractTheme(dir: string): ExtractedTheme | null {
  let css = "";
  let cssPath = "";
  for (const rel of CSS_CANDIDATES) {
    const found = read(dir, rel);
    if (found) {
      css = found;
      cssPath = rel;
      break;
    }
  }

  const tokens = css ? declarations(rootBlock(css)) : "";

  // Fallbacks for apps with no design-token layer at all: a theme colour is
  // still far better than shipping our purple.
  if (!tokens) {
    const manifest = read(dir, "public/manifest.json") ?? read(dir, "public/site.webmanifest");
    const themeColor = manifest
      ? (/"theme_color"\s*:\s*"([^"]+)"/.exec(manifest)?.[1] ?? null)
      : null;
    const meta = read(dir, "index.html");
    const metaColor = meta
      ? (/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i.exec(meta)?.[1] ?? null)
      : null;
    const accent = normalise(themeColor ?? metaColor ?? "");
    // Never invent a brand colour: with nothing found we return null and the
    // caller says so honestly instead of pretending it matched something.
    if (!accent) return null;
    return {
      tokens: `--lv-c:${accent}`,
      source: themeColor ? "manifest theme_color" : "meta theme-color",
      font: detectFont(dir),
      dark: detectDark(dir, css),
    };
  }

  const darkTokens = declarations(darkBlock(css));
  return {
    tokens,
    ...(darkTokens ? { tokensDark: darkTokens } : {}),
    source: cssPath,
    font: detectFont(dir),
    dark: detectDark(dir, css),
  };
}
