#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Extensión .ts explícita + `rewriteRelativeImportExtensions` en tsconfig: así
// `npm run dev` (node --experimental-strip-types) resuelve el módulo tal cual
// y `tsc` lo reescribe a .js en dist/ (antes el specifier ./detect.js no
// existía en src/ y el modo dev arrancaba roto).
import { deriveDefaults, scanProject } from "./detect.ts";
import { extractTheme } from "./theme.ts";
import { trackToolCall } from "./analytics.ts";
import { readCapped, safeFetch } from "./ssrf.ts";

/** Datos humanos que el código no puede saber con certeza. */
const HUMAN_FACTS: { id: string; hint: string }[] = [
  { id: "appName", hint: "public / commercial name of the product" },
  {
    id: "companyEntity",
    hint: "person or legal entity responsible for the app (GDPR data controller)",
  },
  { id: "contactEmail", hint: "contact email for privacy requests and data-subject rights" },
  {
    id: "markets",
    hint: "regions where the app has users, as an array from [eu, uk, us, ca, ch, latam, apac, india, china, mena, africa, global]",
  },
];

function missingFacts(answers: Record<string, unknown>): { id: string; hint: string }[] {
  return HUMAN_FACTS.filter((f) => {
    const v = answers[f.id];
    if (f.id === "markets") return !Array.isArray(v) || v.length === 0;
    return typeof v !== "string" || v.trim().length === 0;
  });
}

/** Prompt que el agente de desarrollo puede responder leyendo el propio repo. */
function buildAgentPrompt(missing: { id: string; hint: string }[], appName: string): string {
  const fields = missing.length > 0 ? missing : HUMAN_FACTS;
  const example = `{\n${fields
    .map((f) => `  ${JSON.stringify(f.id)}: ${f.id === "markets" ? "[]" : "null"}`)
    .join(",\n")}\n}`;
  return [
    `Preparing legal compliance for "${appName}" with LexVibe. Inspect this project and provide the missing facts:`,
    ...fields.map((f) => `- ${f.id}: ${f.hint}`),
    "If a fact cannot be found in the project, leave it as null — do not invent it. Reply with this JSON only:",
    "```json",
    example,
    "```",
  ].join("\n");
}

/*
 * Servidor MCP de LexVibe. Permite que un agente (Claude, Cursor, Claude Code…)
 * deje una app "legalmente lista" sin que el usuario sepa de leyes:
 *   - make_compliant: todo en un paso (scan + docs + snippet + AI Act).
 *   - scan_project: detecta qué usa el proyecto (analítica, pagos, IA, terceros).
 *   - check_compliance: informe de preparación (solo lectura) + agentPrompt.
 *   - generate_policies: genera privacidad/términos/aviso IA (multi-jurisdicción).
 *   - install_snippet: inserta el snippet del banner en el HTML/layout.
 *   - check_ai_act: clasifica el riesgo según el EU AI Act.
 *   - claim_app / get_claim_status: flujo "device code" — el agente crea un
 *     claim, el humano lo confirma logueado y el agente recibe el appId REAL
 *     (adiós al placeholder YOUR_APP_ID).
 *
 * Configurable por entorno:
 *   LEXVIBE_API_URL   (def. https://golexvibe.com)
 *   LEXVIBE_CDN_URL   (def. https://golexvibe.com; sigue a LEXVIBE_API_URL en self-hosting)
 *   LEXVIBE_APP_ID    (id de la app del usuario para el snippet)
 */

const API = process.env.LEXVIBE_API_URL?.replace(/\/+$/, "") ?? "https://golexvibe.com";
// El script del widget se sirve por CDN (edge caching: se carga en cada página
// vista de cada cliente); data-config/data-ingest siguen apuntando a la API.
// Igual que buildSnippet() en apps/web/src/lib/snippet.ts.
const CDN =
  process.env.LEXVIBE_CDN_URL?.replace(/\/+$/, "") ??
  (process.env.LEXVIBE_API_URL ? API : "https://golexvibe.com");
const APP_ID = process.env.LEXVIBE_APP_ID ?? "YOUR_APP_ID";

/**
 * Nota para el agente cuando los documentos salen de la plantilla estándar
 * (generación anónima sin IA) — mismo mensaje que el MCP remoto, para que el
 * agente pueda avisar al usuario de que aún no están personalizados.
 */
const TEMPLATE_NOTE = `Generated from the standard template — not yet AI-personalized for this app and not reviewed by a human lawyer. For AI-tailored documents that are hosted, versioned and auto-updated when regulations change, create the app at ${API}/dashboard/activate.`;

/**
 * Datos que el código NO puede saber y que el humano debe completar tras crear
 * la app (draft-first). El agente los relee de get_claim_status y se los pide al
 * usuario. En inglés (superficie de descubrimiento del MCP).
 */
const PENDING_LABEL: Record<string, string> = {
  controller_legal_name: "the controller's legal/registered name and address (you or your company)",
  privacy_contact_email: "a privacy contact email",
};

/** ¿Algún documento devuelto por /api/generate salió de la plantilla (no IA)? */
function hasTemplateDocs(documents: { source?: string }[] | undefined): boolean {
  // Sin `source` explícito asumimos plantilla: la generación anónima nunca usa IA.
  return (documents ?? []).some((d) => d.source !== "ai");
}

/** Marcador único que inyecta el snippet — igual que SNIPPET_MARKER en apps/web. */
const SNIPPET_MARKER = "data-lexvibe-app";

interface SnippetOptions {
  accent?: string;
  position?: string;
  lang?: string;
  /** Tokens de aspecto extraídos de la app destino (`c:#6366f1;bg:#fff`). */
  tokens?: string;
  /** Variante de esos tokens para el modo oscuro del anfitrión. */
  tokensDark?: string;
}

/**
 * Atributos del snippet — MISMA forma y MISMO orden que `buildSnippet()` en
 * apps/web/src/lib/snippet.ts. Si divergen, el usuario recibe un snippet
 * distinto según por dónde entre (panel vs agente), que es exactamente el
 * problema que este producto vende resuelto.
 *
 * `data-policy` es obligatorio: sin él el banner solo tiene el enlace a la
 * política si la config remota responde, y una config caída (o una app aún sin
 * reclamar) deja el aviso de cookies sin enlace legal.
 */
/**
 * Escapa un valor que va dentro de un atributo HTML entrecomillado.
 *
 * Segunda barrera: `normalise()` ya solo deja pasar formas exactas, pero este
 * snippet se ESCRIBE en un fichero del usuario, así que un solo `"` que se
 * colase cerraría el atributo y convertiría el resto en marcado ejecutable.
 */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Forma admisible de un id de app. Igual que el MCP remoto
 * (apps/web/src/app/api/mcp/route.ts). El id llega de la API —
 * `get_claim_status` lo devuelve tal cual y el agente lo pasa a
 * `install_snippet`—, así que una API hostil no puede convertirlo en marcado.
 */
const APP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Los 12 idiomas del producto — la MISMA lista que el enum de
 * `generate_policies` más abajo, que `LANGS` en el widget
 * (packages/cookie-widget/src/i18n.ts) y que el enum `app_locale` en SQL.
 * `data-lang` no admite nada más: el widget rechaza lo que no reconoce.
 */
const LANGS = ["es", "en", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "hi", "ar"] as const;

/** Posiciones que entiende el widget. */
const POSITIONS = ["bottom", "bottom-left", "bottom-right"] as const;

/**
 * Formas admisibles de los nombres de fichero que la API nos dice que
 * escribamos en el proyecto del usuario. Ver el filtro en `make_compliant`.
 */
const DOC_TYPE_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;

/**
 * `fetch` contra NUESTRA API con presupuesto de tiempo y tope de cuerpo.
 *
 * No usa `safeFetch`: `API` la elige el propio usuario por entorno, y el
 * self-hosting legítimo apunta a localhost, que `assertPublicUrl` rechazaría.
 * Lo que sí hace falta es que este proceso —que corre en la máquina del
 * usuario, dentro de su sesión de agente— no se quede colgado para siempre ni
 * se coma la RAM si al otro lado hay un servidor lento u hostil.
 */
async function apiFetch(url: string, init?: RequestInit, timeoutMs = 20_000): Promise<Response> {
  // AbortSignal.timeout no existe en Node <17.3 ni Safari <15.4.
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  return fetch(url, { ...init, signal });
}

/** `res.json()` con tope de bytes — mismo motivo que `apiFetch`. */
async function apiJson<T>(res: Response, maxBytes = 2_000_000): Promise<T> {
  return JSON.parse(await readCapped(res, maxBytes)) as T;
}

/**
 * Id de app utilizable, o el placeholder si no tiene la forma esperada.
 *
 * Se normaliza UNA vez, al entrar en el handler, y no dentro del emisor del
 * snippet: si el emisor cayera al placeholder por su cuenta, el handler seguiría
 * creyendo que instaló el id bueno y NO emitiría el aviso de "estás con
 * YOUR_APP_ID" — le diría al agente que las políticas hospedadas y la prueba de
 * consentimiento quedaron enlazadas cuando no lo están.
 */
function resolveAppId(appId: string | undefined): string {
  const id = appId ?? APP_ID;
  return APP_ID_RE.test(id) ? id : "YOUR_APP_ID";
}

function snippetAttrs(id: string, opts: SnippetOptions): string {
  // Segunda barrera: los handlers ya normalizan con `resolveAppId`, pero este
  // emisor escribe en ficheros del usuario y no debe fiarse del llamante.
  const safeId = APP_ID_RE.test(id) ? id : "YOUR_APP_ID";
  const lang = opts.lang && (LANGS as readonly string[]).includes(opts.lang) ? opts.lang : null;
  const position =
    opts.position && (POSITIONS as readonly string[]).includes(opts.position)
      ? opts.position
      : null;
  return [
    `src="${CDN}/v1/lexvibe-widget.js"`,
    `${SNIPPET_MARKER}="${safeId}"`,
    `data-config="${API}/api/widget-config/${safeId}"`,
    `data-ingest="${API}/api/consent"`,
    `data-policy="${API}/p/${safeId}/privacy"`,
    opts.accent ? `data-accent="${attr(opts.accent)}"` : null,
    opts.tokens ? `data-tokens="${attr(opts.tokens)}"` : null,
    opts.tokensDark ? `data-tokens-dark="${attr(opts.tokensDark)}"` : null,
    position ? `data-position="${position}"` : null,
    lang ? `data-lang="${lang}"` : null,
    "defer",
  ]
    .filter(Boolean)
    .join(" ");
}

/** El snippet canónico — misma forma que buildSnippet() en apps/web. */
function buildSnippet(id: string, opts: SnippetOptions = {}): string {
  return `<script ${snippetAttrs(id, opts)}></script>`;
}

/** Versión JSX del snippet, para layouts React (Next.js App Router, etc.). */
function buildJsxSnippet(id: string, opts: SnippetOptions = {}): string {
  return `<script ${snippetAttrs(id, opts)} />`;
}

/**
 * Raíz del proyecto para la extracción de tema: sube desde el fichero de
 * instalación hasta encontrar un `package.json`, con el directorio del propio
 * fichero de respaldo si no hay ninguno (sitio estático suelto).
 */
function projectRoot(file: string): string {
  const own = dirname(resolve(file));
  let dir = own;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Sin `package.json` (sitio estático suelto) el respaldo es el directorio
  // del propio fichero, NO `process.cwd()`: si el MCP se lanzó desde otro
  // sitio, el cwd no tiene nada que ver con la web que se está instalando y
  // perderíamos su index.html, su manifest y su CSS.
  return own;
}

/** Normaliza un dominio/URL a URL absoluta https — igual que /api/check y /api/verify. */
function normalizeUrl(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const server = new McpServer(
  { name: "lexvibe", version: "1.0.0" },
  {
    instructions:
      "LexVibe makes vibe-coded apps (Lovable, Bolt, v0, Next.js, plain HTML) legally compliant: GDPR privacy policy, terms of service, cookie consent banner with real script blocking, and EU AI Act risk classification. When the user asks to make their app legally compliant, GDPR-ready, or to add a privacy policy / terms / cookie banner, call make_compliant first (one step). Use check_compliance for a read-only readiness report, scan_project to detect data processing, generate_policies for documents only, install_snippet to add the cookie banner to a specific file, and check_ai_act to classify EU AI Act risk. If no real LexVibe app id is configured (LEXVIBE_APP_ID missing or a placeholder), call claim_app to get a link the user opens to create a real app in their account, then poll get_claim_status for the real app id and snippet. Legal documents describe the app as it was when they were generated: after adding any SDK, analytics, payments, auth or AI integration, run check_compliance again and regenerate the documents if it reports processing they don't cover yet.",
  },
);

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/** Fallo de herramienta con `isError` (igual que el MCP remoto): sin él, el agente ve el error como un resultado normal. */
function toolError(message: string) {
  return { ...text({ error: message }), isError: true as const };
}

server.tool(
  "scan_project",
  "Read-only scan of a local project (dependencies + source code + mobile manifests). Detects data processing relevant to legal compliance — analytics, payments, generative AI (distinguishing user-facing AI from server-side-only AI), email collection, third-party sharing — and returns {signals, suggestedAnswers, facts, locales, platforms}: per-vendor `signals`, compliance flags in `suggestedAnswers`, structured `facts` (auth methods, payments channel, AI flags, tracking/IDFA, device permissions), the `locales` the app supports and the product platforms (web / iOS / Android). Run it first: pass suggestedAnswers to generate_policies, and `facts`, `locales` and `signals` to claim_app so the generated documents are anchored in evidence. Never modifies files; errors if `dir` does not exist or is not a project root. For a deployed site whose code you don't have, use check_website instead.",
  {
    dir: z.string().describe("Path of the project root to analyze (absolute paths are safest)."),
  },
  { title: "Scan project", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async ({ dir }) => {
    trackToolCall("scan_project");
    try {
      return text(scanProject(dir));
    } catch (err) {
      return toolError(`Scan failed: ${(err as Error).message}`);
    }
  },
);

server.tool(
  "check_compliance",
  "Read-only compliance readiness check. Run this after adding any SDK, analytics, payment, auth or AI integration — it detects processing activities your legal documents don't cover yet. It scans the project, detects platforms and data processing, auto-derives what it can (app name, legal entity, contact email) and reports which human facts are still missing (including target markets). Returns {platforms, detected, derived, provided, missing, ready, agentPrompt}: `ready` is true only when no human fact is missing, and `agentPrompt` is a prompt you (the dev agent) can answer from the repo, so document generation needs no forms. Never modifies files; errors if `dir` does not exist or is not a project root. Call it before make_compliant when you want to confirm facts first; re-run it with the answers as arguments until `ready` is true.",
  {
    dir: z.string().describe("Path of the project root to analyze (absolute paths are safest)."),
    appName: z.string().optional().describe("Override the auto-derived app name."),
    entity: z
      .string()
      .optional()
      .describe("Data controller / legal entity, if already known (overrides the derived one)."),
    contactEmail: z
      .string()
      .optional()
      .describe("Privacy contact email, if already known (overrides the derived one)."),
    markets: z
      .array(
        z.enum([
          "eu",
          "uk",
          "ch",
          "us",
          "ca",
          "latam",
          "apac",
          "india",
          "china",
          "mena",
          "africa",
          "global",
        ]),
      )
      .optional()
      .describe(
        "Regions where the app has users. Without them `ready` can never be true (markets are a required human fact).",
      ),
  },
  {
    title: "Check compliance readiness",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async ({ dir, appName, entity, contactEmail, markets }) => {
    trackToolCall("check_compliance");
    try {
      const scan = scanProject(dir);
      const derived = deriveDefaults(dir);
      const answers: Record<string, unknown> = {
        ...scan.suggestedAnswers,
        platformType: scan.platforms,
        ...(derived.appName ? { appName: derived.appName } : {}),
        ...(derived.companyEntity ? { companyEntity: derived.companyEntity } : {}),
        ...(derived.contactEmail ? { contactEmail: derived.contactEmail } : {}),
        ...(appName ? { appName } : {}),
        ...(entity ? { companyEntity: entity } : {}),
        ...(contactEmail ? { contactEmail } : {}),
        ...(markets && markets.length > 0 ? { markets } : {}),
      };
      const missing = missingFacts(answers);
      return text({
        platforms: scan.platforms,
        detected: scan.signals.map((s) => s.signal),
        derived,
        provided: HUMAN_FACTS.filter((f) => !missing.some((m) => m.id === f.id)).map((f) => f.id),
        missing: missing.map((m) => m.id),
        // ready exige TODOS los datos humanos, markets incluido: los mercados
        // determinan qué jurisdicciones cubren los documentos.
        ready: missing.length === 0,
        ...(missing.some((m) => m.id === "markets")
          ? {
              note: 'Target markets are missing. If you proceed to make_compliant without them, markets default to ["eu"] — confirm with the user before accepting that default.',
            }
          : {}),
        // Recordatorio de deriva: este servidor es local/anónimo y no tiene
        // acceso a la foto `signals_snapshot` de una app reclamada, así que no
        // puede hacer el diff él mismo; se lo encarga al agente que lee el
        // informe (que sí sabe qué integraciones acaba de añadir).
        driftNote:
          "Legal documents only cover the processing that existed when they were generated. If any detected activity above (analytics, payments, generative AI, email collection, third-party sharing) was added AFTER the documents were generated, they are out of date: re-run generate_policies (or make_compliant) with the current answers so they disclose the new processing.",
        agentPrompt: buildAgentPrompt(missing, (answers.appName as string) ?? "this product"),
      });
    } catch (err) {
      return toolError(`Check failed: ${(err as Error).message}`);
    }
  },
);

server.tool(
  "generate_policies",
  "Generate the legal documents (privacy policy, terms of service and, if applicable, an AI disclosure) localized and tailored to the target markets' frameworks (GDPR, UK GDPR, CCPA/CPRA, PIPEDA, LGPD…). Returns {documents: [{docType, locale, content, source}]} where content is Markdown and source is 'ai' or 'template' (template ⇒ not yet personalized — tell the user). Documents are returned only, never written to disk (make_compliant writes them to /legal) and nothing is persisted server-side. Run scan_project first and pass its suggestedAnswers as `answers` so the documents disclose the right processing; requires network access to the LexVibe API.",
  {
    appName: z.string().describe("App / business name shown in the documents, e.g. 'Acme Notes'."),
    entity: z
      .string()
      .optional()
      .describe(
        "Data controller / legal entity (person or company legally responsible), e.g. 'Acme Labs S.L.'. If omitted, the documents keep a [to complete] placeholder.",
      ),
    contactEmail: z
      .string()
      .optional()
      .describe(
        "Privacy contact email published in the documents. If omitted, a [to complete] placeholder is left.",
      ),
    markets: z
      .array(
        z.enum([
          "eu",
          "uk",
          "ch",
          "us",
          "ca",
          "latam",
          "apac",
          "india",
          "china",
          "mena",
          "africa",
          "global",
        ]),
      )
      .min(1)
      .describe(
        "Regions where the app has users (at least one). Each market pack cites its frameworks: eu → GDPR/ePrivacy, uk → UK GDPR/PECR, us → CCPA/CPRA, ca → PIPEDA, latam → LGPD…; 'global' covers all of them at the highest common bar.",
      ),
    locales: z
      .array(z.enum(["es", "en", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "hi", "ar"]))
      .optional()
      .describe(
        "Languages to generate the documents in (ISO 639-1). Defaults to the markets' main languages; anonymous calls are capped at 3 locales. Pass scan_project's `locales` to match the languages the app actually ships.",
      ),
    answers: z
      .record(z.union([z.string(), z.boolean(), z.array(z.string())]))
      .default({})
      .describe(
        "Compliance flags; pass scan_project's suggestedAnswers. Recognized keys: usesAnalytics, processesPayments, usesGenerativeAI, collectsEmails, sharesWithThirdParties, platformType.",
      ),
  },
  {
    title: "Generate legal documents",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ appName, entity, contactEmail, markets, locales, answers }) => {
    trackToolCall("generate_policies");
    const body = {
      answers: {
        appName,
        companyEntity: entity ?? "",
        contactEmail: contactEmail ?? "",
        ...answers,
      },
      markets,
      locales,
    };
    try {
      const res = await apiFetch(`${API}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return toolError(`API ${res.status}`);
      const data = await apiJson<{
        documents?: { docType: string; locale: string; content: string; source?: string }[];
      }>(res);
      // Expone el origen real (ai/plantilla): el agente debe poder avisar de
      // que un documento de plantilla aún no está personalizado para la app.
      return text({
        ...data,
        ...(hasTemplateDocs(data.documents) ? { note: TEMPLATE_NOTE } : {}),
      });
    } catch (err) {
      return toolError(`Could not generate: ${(err as Error).message}`);
    }
  },
);

server.tool(
  "install_snippet",
  "Insert the LexVibe cookie-banner + hosted-policies snippet into an HTML file, right before </head>. By default the banner is themed to match the app's own colors, fonts and radius (detected from its stylesheets). Idempotent: if the snippet is already in the file, nothing changes. If the file has no literal </head> (e.g. a Next.js App Router layout.tsx), it does NOT modify the file: it returns the snippet plus exact instructions for you (the dev agent) to add it as JSX — it never corrupts user files. After deploying, confirm with verify_snippet that the snippet is live.",
  {
    file: z.string().describe("Path of the file to install into (index.html, app/layout.tsx…)."),
    appId: z
      .string()
      .regex(APP_ID_RE)
      .optional()
      .describe(
        "LexVibe app id, e.g. from claim_app/get_claim_status (defaults to the LEXVIBE_APP_ID env var; without either, the YOUR_APP_ID placeholder is used and flagged).",
      ),
    accent: z
      .string()
      .optional()
      .describe(
        "Banner accent color as a CSS hex value, e.g. #4f46e5. Defaults to the color detected from the app's own styles (see `theme`).",
      ),
    position: z
      .enum(["bottom", "bottom-left", "bottom-right"])
      .optional()
      .describe(
        "Where the banner sits on screen: bottom (full-width bar), bottom-left or bottom-right (floating card in that corner). Defaults to bottom.",
      ),
    lang: z
      .string()
      .optional()
      .describe(
        "Force the banner's language as an ISO 639-1 code, e.g. 'en' or 'es' (one of the 12 LexVibe locales). Defaults to the page's own language.",
      ),
    theme: z
      .enum(["auto", "off"])
      .optional()
      .describe(
        "auto (default): match the banner to this app's colors, fonts and radius. off: LexVibe default look.",
      ),
  },
  {
    title: "Install cookie-banner snippet",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async ({ file, appId, accent, position, lang, theme }) => {
    trackToolCall("install_snippet");
    const id = resolveAppId(appId);
    // El banner sale con el aspecto de la app destino salvo que se pida lo
    // contrario. Es la diferencia entre pegar el snippet y que quede como si
    // lo hubieras diseñado tú, o tener que pedirle luego a tu IA que lo
    // adapte a mano. Un acento explícito manda sobre lo detectado.
    // La raíz del proyecto, NO el directorio del fichero: CSS_CANDIDATES son
    // rutas relativas a la raíz (`src/app/globals.css`…). Con
    // `dirname(app/layout.tsx)` se buscaba `src/app/src/app/globals.css`, así
    // que la detección devolvía null SIEMPRE en Next.js — justo la ruta que el
    // propio tool documenta en su fallback JSX.
    const detected = theme === "off" ? null : extractTheme(projectRoot(file));
    const opts = {
      accent,
      position,
      lang,
      tokens: detected?.tokens,
      tokensDark: detected?.tokensDark,
    };
    const snippet = buildSnippet(id, opts);
    const themeNote = detected
      ? `\n\nBanner matched to your app (from ${detected.source}):\n` +
        `  ${detected.tokens.replace(/--lv-/g, "").split(";").join("\n  ")}\n` +
        (detected.font ? `  font: ${detected.font} (inherited)\n` : "") +
        (detected.dark === "class" ? "  dark mode: follows your .dark class automatically\n" : "") +
        "Override any of it at " +
        `${API}/dashboard/cookies`
      : "\n\nNo design tokens found, so the banner uses the LexVibe default. " +
        `Style it at ${API}/dashboard/cookies`;
    try {
      let content = readFileSync(file, "utf8");
      if (content.includes("lexvibe-widget.js")) {
        return text("The LexVibe snippet is already installed in this file. No changes made.");
      }
      if (/<\/head>/i.test(content)) {
        content = content.replace(/<\/head>/i, `  ${snippet}\n</head>`);
        writeFileSync(file, content, "utf8");
        return text(
          `Snippet installed in ${file} (inserted before </head>).` +
            (id === "YOUR_APP_ID"
              ? " Warning: the placeholder app id YOUR_APP_ID was used — call claim_app to create a real app in the user's LexVibe account, then re-run install_snippet with the real appId (or set LEXVIBE_APP_ID)."
              : "") +
            themeNote,
        );
      }
      // Sin </head> literal: escribir HTML crudo corrompería un módulo JSX/TSX
      // (p. ej. el layout.tsx del App Router de Next). No tocamos el fichero;
      // devolvemos instrucciones exactas para que el agente lo añada como JSX.
      return text({
        installed: false,
        file,
        reason:
          "No literal </head> tag found in this file, so it was NOT modified (prepending raw HTML would break a JS/TS module).",
        snippet,
        theme: themeNote.trim(),
        instructions: [
          "Add the snippet manually. For a Next.js App Router root layout (app/layout.tsx), add a <head> element inside <html> in the returned JSX and place this self-closing script inside it:",
          `<head>\n  ${buildJsxSnippet(id, opts)}\n</head>`,
          'Alternatively, use Next\'s <Script> component (import Script from "next/script") in the layout body with the same src and data-* attributes and strategy="afterInteractive".',
          "For plain HTML files, paste the snippet right before </head>:",
          snippet,
        ],
        ...(id === "YOUR_APP_ID"
          ? {
              warning:
                "The placeholder app id YOUR_APP_ID is in use — call claim_app to create a real app in the user's LexVibe account, then use the real appId here (or set LEXVIBE_APP_ID).",
            }
          : {}),
      });
    } catch (err) {
      return toolError(`Could not install: ${(err as Error).message}`);
    }
  },
);

server.tool(
  "check_ai_act",
  "Classify a product's risk level under the EU AI Act — minimal, limited, high or prohibited — and return the applicable obligations, each with its compliance deadline (limited-risk transparency duties apply from Aug 2, 2026; Annex III high risk from Dec 2, 2027). The boolean parameters fall into three groups, all optional and defaulting to the safest 'not applicable' value: (1) transparency triggers — usesAI, interactsWithPeople, generatesContent, automatedDecisions; (2) the eight prohibited practices of art. 5 — socialScoring, realtimeBiometricPublic + realtimeBiometricLawEnforcement, emotionRecognitionWorkEducation, biometricCategorisationSensitive, untargetedFaceScraping, manipulativeOrExploitative, individualPredictivePolicing; (3) high-risk triggers — embeddedInRegulatedProduct, annexIII domains. Answer from what you know about the product (scan_project's suggestedAnswers.usesGenerativeAI maps to usesAI + generatesContent); leave unknowns at their defaults, which never over-report risk. Returns {level, headline, explanation, obligations: [{title, description, deadline}]}. Read-only, no signup; requires network access to the LexVibe API (errors return {error} with isError). Use it when the user asks whether the EU AI Act applies to them or after adding an AI feature; make_compliant already includes a basic version of this check.",
  {
    usesAI: z
      .boolean()
      .default(true)
      .describe(
        "Does the product use AI at all (LLM calls, recommendations, computer vision…)? false ⇒ minimal risk, the AI Act does not apply.",
      ),
    interactsWithPeople: z
      .boolean()
      .default(false)
      .describe(
        "Do people interact directly with the AI (chatbot, voice assistant…)? Triggers the art. 50 duty to disclose they are talking to an AI.",
      ),
    generatesContent: z
      .boolean()
      .default(false)
      .describe(
        "Does it generate text, images, audio or video shown to users? Triggers the art. 50 duty to label AI-generated content.",
      ),
    automatedDecisions: z
      .boolean()
      .default(false)
      .describe(
        "Does it make automated decisions with legal or similarly significant effects on people (credit, hiring, admissions…)? Adds GDPR art. 22 duties; high risk only if an Annex III domain applies.",
      ),
    socialScoring: z
      .boolean()
      .default(false)
      .describe(
        "Does it score people's social behavior or traits causing detrimental treatment in unrelated contexts, or disproportionate to the behavior (art. 5.1.c)? Prohibited. A seller rating or fitness points app is NOT this.",
      ),
    realtimeBiometricPublic: z
      .boolean()
      .default(false)
      .describe(
        "Real-time remote biometric identification in publicly accessible spaces (e.g. live face recognition)? High risk (Annex III biometrics) — prohibited only when combined with realtimeBiometricLawEnforcement.",
      ),
    // Cualificador del art. 5.1.h: sin él la prohibición era inalcanzable y un
    // sistema policial de biometría en tiempo real salía "alto riesgo, 2027"
    // en vez de "prohibido, ya en vigor".
    realtimeBiometricLawEnforcement: z
      .boolean()
      .default(false)
      .describe(
        "Only if realtimeBiometricPublic: is it used for LAW ENFORCEMENT purposes? That combination is prohibited (art. 5.1.h) and already in force.",
      ),
    emotionRecognitionWorkEducation: z
      .boolean()
      .default(false)
      .describe(
        "Does it infer emotions (frustration, attention, mood…) from employees at work or students in education, e.g. to flag disengaged staff or bored students (art. 5.1.f)? Prohibited. Emotion inference on end users of a public consumer product (not their employees/students) is NOT this.",
      ),
    biometricCategorisationSensitive: z
      .boolean()
      .default(false)
      .describe(
        "Does it use biometric data (face, voice, gait…) to infer sensitive attributes — race, political opinion, religion, trade-union membership, sexual orientation (art. 5.1.g)? Prohibited. Ordinary face-unlock or liveness checks that don't infer these attributes are NOT this.",
      ),
    untargetedFaceScraping: z
      .boolean()
      .default(false)
      .describe(
        "Does it untargetedly scrape facial images from the internet or CCTV footage to build or expand a face-recognition database (art. 5.1.e)? Prohibited. Matching a user's own consented selfie against their own ID photo is NOT this.",
      ),
    manipulativeOrExploitative: z
      .boolean()
      .default(false)
      .describe(
        "Does it use subliminal techniques beyond a person's consciousness, or exploit a known vulnerability (age, disability, specific social or economic situation) to materially distort behavior and cause harm — e.g. dark patterns targeting a diagnosed gambling addiction (art. 5.1.a-b)? Prohibited. Ordinary persuasive marketing or UX nudges aimed at the general population are NOT this.",
      ),
    individualPredictivePolicing: z
      .boolean()
      .default(false)
      .describe(
        "Predicting an individual's criminal risk based solely on profiling or personality traits (art. 5.1.d)? Prohibited.",
      ),
    embeddedInRegulatedProduct: z
      .boolean()
      .default(false)
      .describe(
        "Is the AI a safety component embedded in an Annex I regulated product (toys, machinery, medical devices…)? High risk via art. 6.1, deadline Aug 2, 2028.",
      ),
    annexIII: z
      .array(
        z.enum([
          "biometrics",
          "critical",
          "education",
          "employment",
          "essential",
          "law",
          "migration",
          "justice",
        ]),
      )
      .default([])
      .describe(
        "Annex III high-risk domains the system operates in: biometrics, critical (infrastructure), education, employment (HR/hiring), essential (credit, insurance, benefits), law (enforcement), migration, justice. Empty if none apply.",
      ),
  },
  {
    title: "Classify EU AI Act risk",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async (answers) => {
    trackToolCall("check_ai_act");
    try {
      const res = await apiFetch(`${API}/api/ai-act/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(answers),
      });
      if (!res.ok) return toolError(`API ${res.status}`);
      return text(await apiJson(res));
    } catch (err) {
      return toolError(`Could not classify: ${(err as Error).message}`);
    }
  },
);

server.tool(
  "check_website",
  "Free, no-signup compliance check of a DEPLOYED website by URL (the same public checker as the LexVibe /check page). Fetches the live page server-side and detects tracking/processing that actually ships to visitors — analytics, marketing pixels, payments, generative AI, email capture, third parties. Returns {url, signals: [{signal, vendors}], recommendations: [{id, title, reason}], aiAct} — which documents/banner the site needs and whether the EU AI Act applies. Read-only and rate-limited (a burst of calls returns an error asking to wait a minute). Complements scan_project (which reads the local source): use check_website after deploying, or for a site whose code you don't have.",
  {
    url: z
      .string()
      .describe(
        "Public URL (or bare domain) of the deployed site, e.g. https://myapp.com or myapp.com. Must be publicly reachable.",
      ),
  },
  {
    title: "Check a deployed website",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ url }) => {
    trackToolCall("check_website");
    try {
      const res = await apiFetch(`${API}/api/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (res.status === 429) {
        return toolError("Rate limited — wait a minute and try again.");
      }
      if (!res.ok) return toolError(`API ${res.status}`);
      const data = await apiJson<{
        url: string;
        signals: { signal: string; vendors: string[] }[];
        recommendations: { id: string; title: string; reason: string }[];
        aiAct: boolean;
      }>(res);
      return text({
        ...data,
        // Mismo aviso de deriva que check_compliance: lo detectado en el sitio
        // vivo debe estar cubierto por los documentos generados.
        driftNote:
          "If any signal above (analytics, marketing pixels, payments, generative AI, email capture, third parties) is not disclosed by the site's current legal documents, they are out of date: re-run generate_policies (or make_compliant) so they cover it.",
      });
    } catch (err) {
      return toolError(`Could not check the website: ${(err as Error).message}`);
    }
  },
);

server.tool(
  "verify_snippet",
  "Verify that the LexVibe cookie-banner snippet is actually LIVE on a deployed site: fetches the public URL and looks for the widget marker in the served HTML. Run it after deploying (install_snippet edits local files — this confirms the change reached production). Only public http(s) hosts are allowed — localhost, private-network and reserved addresses are rejected. Returns {status: 'ok' | 'missing' | 'unknown'}. If 'missing', the snippet was not found: check that the deploy included the change, or re-run install_snippet and deploy again.",
  {
    url: z
      .string()
      .describe(
        "Public URL (or bare domain) of the deployed site to verify, e.g. https://myapp.com or myapp.com. Must be publicly reachable.",
      ),
  },
  {
    title: "Verify the snippet is live",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ url }) => {
    trackToolCall("verify_snippet");
    const target = normalizeUrl(url);
    // Mismo criterio que /api/verify en la plataforma: marcador del snippet o
    // nombre del script del widget presentes en el HTML servido. safeFetch
    // aplica la misma defensa anti-SSRF que la plataforma: solo destinos
    // http(s) públicos, revalidando cada redirección — esta herramienta corre
    // en la máquina del usuario y no debe poder sondear su red interna.
    try {
      const res = await safeFetch(target, {
        headers: { "User-Agent": "LexVibe-Verifier/1.0 (mcp-stdio)" },
      });
      if (!res.ok) {
        return text({
          status: "unknown",
          checkedUrl: target,
          error: `The site responded ${res.status}.`,
        });
      }
      const html = await readCapped(res);
      const found = html.includes(SNIPPET_MARKER) || html.includes("lexvibe-widget.js");
      return text({
        status: found ? "ok" : "missing",
        checkedUrl: target,
        ...(found
          ? { detail: "The LexVibe snippet is live on this page." }
          : {
              detail:
                "The LexVibe snippet was NOT found in the served HTML. If you just installed it, make sure the change was deployed; note this check reads the initial HTML only, so a snippet injected client-side after load won't be detected.",
            }),
      });
    } catch (err) {
      return text({
        status: "unknown",
        checkedUrl: target,
        error: `Could not reach the site: ${(err as Error).message}`,
      });
    }
  },
);

server.tool(
  "make_compliant",
  "One-step legal compliance: scan the project, generate privacy policy / terms / cookie & AI disclosures (written as Markdown to <dir>/legal), install the cookie-banner snippet before </head> (web only; skipped for native apps, and JSX layouts get manual instructions instead of being modified), and classify EU AI Act risk. Use this first when the user asks to make their app legally compliant, GDPR-ready, or to add a privacy policy or cookie banner; use check_compliance instead for a read-only report. Returns {done, filesWritten, documents, source, snippet, aiAct, missingFacts, agentPrompt, nextSteps} — if source is 'template' or missingFacts is non-empty, answer the agentPrompt and re-run with appName/entity/contactEmail/markets for complete documents. Aborts without writing anything if `dir` does not exist or is not a project root.",
  {
    dir: z.string().describe("Path of the project root to analyze (absolute paths are safest)."),
    appName: z
      .string()
      .optional()
      .describe(
        "App / business name. If omitted, it's derived from the repo (package.json / LICENSE).",
      ),
    entity: z
      .string()
      .optional()
      .describe("Data controller / legal entity, if already known (overrides the derived one)."),
    contactEmail: z
      .string()
      .optional()
      .describe("Privacy contact email, if already known (overrides the derived one)."),
    appId: z
      .string()
      .regex(APP_ID_RE)
      .optional()
      .describe(
        "LexVibe app id (defaults to the LEXVIBE_APP_ID env var). Without a real id the snippet uses the YOUR_APP_ID placeholder and the result tells you to call claim_app.",
      ),
    markets: z
      .array(
        z.enum([
          "eu",
          "uk",
          "ch",
          "us",
          "ca",
          "latam",
          "apac",
          "india",
          "china",
          "mena",
          "africa",
          "global",
        ]),
      )
      .default(["eu"])
      .describe(
        'Regions where the app has users; they decide which frameworks the documents cover (eu → GDPR, uk → UK GDPR, us → CCPA/CPRA…). Defaults to ["eu"] — confirm with the user before accepting that default.',
      ),
    accent: z
      .string()
      .optional()
      .describe(
        "Banner accent color as a CSS hex value, e.g. #4f46e5. Defaults to the LexVibe accent.",
      ),
    position: z
      .enum(["bottom", "bottom-left", "bottom-right"])
      .optional()
      .describe(
        "Where the banner sits on screen: bottom (full-width bar), bottom-left or bottom-right (floating card in that corner). Defaults to bottom.",
      ),
    lang: z
      .string()
      .optional()
      .describe(
        "Force the banner's language as an ISO 639-1 code, e.g. 'en' or 'es' (one of the 12 LexVibe locales). Defaults to the page's own language.",
      ),
  },
  {
    title: "Make app compliant (one step)",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ dir, appName, entity, contactEmail, appId, markets, accent, position, lang }) => {
    trackToolCall("make_compliant");
    const id = resolveAppId(appId);
    const opts = { accent, position, lang };
    const steps: string[] = [];
    const written: string[] = [];
    // Origen real por documento (ai/plantilla), para que el agente sepa si los
    // ficheros de /legal son genéricos y pueda decírselo al usuario.
    const docsWritten: { path: string; docType: string; locale: string; source: string }[] = [];

    // 1) Escanear el proyecto y deducir lo que se pueda (cero formularios).
    let answers: Record<string, unknown> = {};
    let platforms: string[] = ["web"];
    try {
      const scan = scanProject(dir);
      const derived = deriveDefaults(dir);
      platforms = scan.platforms;
      // La plataforma orienta qué documentos y obligaciones aplican (móvil ≠ web).
      answers = {
        ...scan.suggestedAnswers,
        platformType: platforms,
        // Defaults deducidos del repo; el valor explícito del usuario manda (abajo).
        ...(derived.appName ? { appName: derived.appName } : {}),
        ...(derived.companyEntity ? { companyEntity: derived.companyEntity } : {}),
        ...(derived.contactEmail ? { contactEmail: derived.contactEmail } : {}),
      };
      steps.push(`Scan: ${scan.signals.map((s) => s.signal).join(", ") || "no clear signals"}.`);
      steps.push(`Platform: ${platforms.join(", ")}.`);
      const derivedKeys = Object.keys(derived).filter((k) => derived[k as keyof typeof derived]);
      if (derivedKeys.length > 0) steps.push(`Derived from repo: ${derivedKeys.join(", ")}.`);
    } catch (err) {
      // Dir inexistente o que no parece un proyecto (assertProjectDir): abortar
      // ANTES de escribir nada. Seguir adelante creaba la ruta fantasma con
      // mkdirSync recursive, escribía los docs allí y reportaba éxito.
      return toolError(
        `Scan failed: ${(err as Error).message}. Pass the ABSOLUTE path of the project root as \`dir\` and re-run. No files or directories were created.`,
      );
    }
    // El appName explícito manda; si no, se queda el deducido del repo (o falta).
    if (appName) answers.appName = appName;
    // entity/contactEmail explícitos (mismo patrón que check_compliance): sin
    // ellos, el bucle "responde el agentPrompt y re-ejecuta" no tenía por dónde
    // entregar companyEntity/contactEmail y era un callejón sin salida.
    if (entity) answers.companyEntity = entity;
    if (contactEmail) answers.contactEmail = contactEmail;
    // markets llega como argumento (con default), así que ya está provisto.
    answers.markets = markets;
    const resolvedName = (answers.appName as string | undefined) ?? "this product";
    const isMobile = platforms.includes("ios") || platforms.includes("android");
    const isWeb = platforms.includes("web");
    const missing = missingFacts(answers);

    // 2) Generar documentos (sin sesión: hasta 3 idiomas, sin persistir).
    try {
      const res = await apiFetch(`${API}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, markets }),
      });
      if (res.ok) {
        const data = await apiJson<{
          documents?: { docType: string; locale: string; content: string; source?: string }[];
        }>(res);
        const legalDir = join(dir, "legal");
        mkdirSync(legalDir, { recursive: true });
        for (const doc of data.documents ?? []) {
          // `docType` y `locale` vienen de la RESPUESTA de la API, no del
          // usuario: un servidor hostil (LEXVIBE_API_URL apuntado a otro host,
          // API comprometida) metía `../../` y escribía donde quisiera en el
          // disco. Se escribe solo si ambos tienen la forma esperada, y aun así
          // se comprueba que la ruta final no se sale de /legal.
          if (!DOC_TYPE_RE.test(doc.docType) || !LOCALE_RE.test(doc.locale)) continue;
          const path = join(legalDir, `${doc.docType}.${doc.locale}.md`);
          if (path !== join(legalDir, basename(path))) continue;
          writeFileSync(path, doc.content, "utf8");
          written.push(path);
          // Sin `source` explícito asumimos plantilla (la generación anónima nunca usa IA).
          docsWritten.push({
            path,
            docType: doc.docType,
            locale: doc.locale,
            source: doc.source === "ai" ? "ai" : "template",
          });
        }
        steps.push(
          `Documents generated: ${written.length} files in /legal` +
            (hasTemplateDocs(data.documents) ? " (template-based, not AI-personalized)." : "."),
        );
      } else {
        steps.push(`Generation: API responded ${res.status}.`);
      }
    } catch (err) {
      steps.push(`Generation failed: ${(err as Error).message}`);
    }

    // 3) Instalar el snippet del banner de cookies. Solo aplica a web: una app
    // nativa no tiene <head> ni cookies del navegador (su consentimiento se
    // gestiona con manifiestos de la tienda y, si acaso, un SDK de consentimiento).
    const snippet = buildSnippet(id, opts);
    if (isWeb) {
      const candidates = [
        "app/layout.tsx",
        "src/app/layout.tsx",
        "index.html",
        "public/index.html",
        "src/index.html",
      ];
      let installedIn: string | null = null;
      for (const rel of candidates) {
        const file = join(dir, rel);
        if (!existsSync(file)) continue;
        try {
          let content = readFileSync(file, "utf8");
          if (content.includes("lexvibe-widget.js")) {
            installedIn = `${rel} (already present)`;
            break;
          }
          if (/<\/head>/i.test(content)) {
            content = content.replace(/<\/head>/i, `  ${snippet}\n</head>`);
            writeFileSync(file, content, "utf8");
            installedIn = rel;
            break;
          }
        } catch {
          /* prueba el siguiente candidato */
        }
      }
      steps.push(
        installedIn
          ? `Snippet installed in ${installedIn}.`
          : `No file with a literal </head> was found, so nothing was modified (writing raw HTML into a JSX/TSX layout would break it). Add the snippet manually — plain HTML, before </head>:\n${snippet}\nOr, in a Next.js App Router layout (app/layout.tsx), add a <head> element inside <html> containing:\n${buildJsxSnippet(id, opts)}`,
      );
    } else {
      steps.push(
        "Cookie banner skipped: this is a native app (no browser cookies). Use the hosted policy URLs in the App Store / Google Play listing instead.",
      );
    }

    // 4) Clasificar EU AI Act.
    let aiAct: unknown = null;
    try {
      const res = await apiFetch(`${API}/api/ai-act/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usesAI: answers.usesGenerativeAI === true,
          generatesContent: answers.usesGenerativeAI === true,
        }),
      });
      if (res.ok) aiAct = await apiJson(res);
    } catch {
      /* opcional */
    }

    const anyTemplate = docsWritten.some((d) => d.source === "template");
    return text({
      done: steps,
      filesWritten: written,
      // Origen por documento; `source` global resume el conjunto.
      documents: docsWritten,
      ...(docsWritten.length > 0
        ? { source: docsWritten.every((d) => d.source === "ai") ? "ai" : "template" }
        : {}),
      ...(anyTemplate ? { note: TEMPLATE_NOTE } : {}),
      snippet,
      aiAct,
      // Datos humanos que el código no pudo deducir. Como agente con acceso al
      // repo, puedes responderlos y volver a generar para documentos completos.
      missingFacts: missing.map((m) => m.id),
      agentPrompt: missing.length > 0 ? buildAgentPrompt(missing, resolvedName) : undefined,
      nextSteps: [
        ...(missing.length > 0
          ? [
              `Missing human facts the code can't know: ${missing.map((m) => m.id).join(", ")}. Answer them (see agentPrompt) and re-run make_compliant passing appName / entity / contactEmail / markets for complete documents.`,
            ]
          : []),
        `Publish and auto-update your documents (and persist them) at ${API}/dashboard/activate.`,
        ...(id === "YOUR_APP_ID"
          ? [
              "The snippet uses the placeholder app id YOUR_APP_ID — call claim_app now: it returns a link the user opens to create a real app in their LexVibe account; then get_claim_status gives you the real app id and snippet to replace the placeholder. Without it, hosted policies and consent proof won't be linked to their account.",
            ]
          : []),
        "Review the drafts in /legal and fill in any bracketed placeholder fields (e.g. [complete: …]).",
        ...(isMobile
          ? [
              "Add the hosted Privacy Policy URL to the App Store Connect / Google Play Console listing.",
              "Fill in Apple App Privacy (and PrivacyInfo.xcprivacy) and the Google Play Data Safety form using the data categories in your privacy policy.",
            ]
          : []),
      ],
    });
  },
);

server.tool(
  "claim_app",
  "Create a REAL LexVibe app in the user's account (replaces the YOUR_APP_ID placeholder). Returns {claimUrl, code, expiresAt}: show claimUrl to the user so they can sign in and confirm — the link expires in 30 minutes. After they confirm, call get_claim_status with `code` to retrieve the real app id and install snippet. Requires `url` or `appName` (errors otherwise). Use this whenever no real LEXVIBE_APP_ID is configured, so hosted policies, consent proof and auto-updates get linked to the user's account; creates nothing until the user confirms the link.",
  {
    url: z
      .string()
      .optional()
      .describe(
        "Public URL of the app (website or App Store / Google Play listing). LexVibe scans it on confirmation.",
      ),
    appName: z
      .string()
      .optional()
      .describe("App / business name (required if no url is provided)."),
    markets: z
      .array(
        z.enum([
          "eu",
          "uk",
          "ch",
          "us",
          "ca",
          "latam",
          "apac",
          "india",
          "china",
          "mena",
          "africa",
          "global",
        ]),
      )
      .optional()
      .describe(
        "Regions where the app has users; each market pack cites its frameworks: eu → GDPR/ePrivacy, uk → UK GDPR/PECR, us → CCPA/CPRA, ca → PIPEDA, latam → LGPD…; 'global' covers all of them at the highest common bar. Defaults to [eu].",
      ),
    answers: z
      .record(z.union([z.string(), z.boolean(), z.array(z.string())]))
      .optional()
      .describe(
        "Compliance flags you already know (pass scan_project's suggestedAnswers): usesAnalytics, processesPayments, usesGenerativeAI, collectsEmails, sharesWithThirdParties, platformType, companyEntity, contactEmail…",
      ),
    facts: z
      .record(z.unknown())
      .optional()
      .describe(
        "scan_project's `facts` object as-is: { authMethods: (apple/google/email/other)[], payments: apple_iap/google_play/stripe/other/none, ai: { userFacing, serverSide, processesPersonalData, providers }, tracking: { idfa, att, adSdks }, devicePermissions: string[] }. Pass it through unchanged — it anchors the generated documents in evidence.",
      ),
    locales: z
      .array(z.string())
      .optional()
      .describe(
        "scan_project's `locales` — ISO 639-1 language codes the app actually supports, e.g. ['en', 'es'].",
      ),
    signals: z
      .array(z.object({ signal: z.string(), vendors: z.array(z.string()) }))
      .optional()
      .describe("scan_project's `signals` — detected processing with vendor names."),
  },
  {
    title: "Claim a real LexVibe app",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ url, appName, markets, answers, facts, locales, signals }) => {
    trackToolCall("claim_app");
    if (!url && !appName) {
      return toolError("Provide at least `url` or `appName` to create the claim.");
    }
    // Preserve the platform for mobile-only apps (no store URL yet): without
    // it the claim would be treated as web and deliver a cookie-banner
    // snippet instead of the hosted policy URL the stores require.
    const platformType = answers?.["platformType"];
    const platforms = Array.isArray(platformType) ? platformType : [];
    const mobileOnly =
      (platforms.includes("ios") || platforms.includes("android")) && !platforms.includes("web");
    const platform = mobileOnly ? (platforms.includes("ios") ? "ios" : "android") : undefined;
    try {
      const res = await apiFetch(`${API}/api/claim/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, appName, markets, answers, platform, facts, locales, signals }),
      });
      if (!res.ok) {
        const err = await apiJson<{ error?: string } | null>(res).catch(() => null);
        return toolError(err?.error ?? `API ${res.status}`);
      }
      const data = await apiJson<{
        claimUrl: string;
        code: string;
        expiresAt: string;
      }>(res);
      return text({
        ...data,
        instructions:
          "Show this link to the user and ask them to open it, sign in and confirm — that creates the app in THEIR LexVibe account. After they confirm, call get_claim_status with this code to retrieve the real app id and snippet, then replace any placeholder (YOUR_APP_ID) snippet you installed.",
      });
    } catch (err) {
      return toolError(`Could not create the claim: ${(err as Error).message}`);
    }
  },
);

server.tool(
  "get_claim_status",
  "Check whether the user has confirmed a claim created with claim_app. Returns {status: 'pending' | 'expired' | 'claimed', …}. While 'pending', wait a few seconds and call again (the link expires in 30 minutes; 'expired' ⇒ create a new claim). Once 'claimed' it adds the REAL appId, the install snippet, the hosted policyUrl, `published` (if false, do NOT install the snippet yet — the policy page would be a dead link until the user publishes from their dashboard) and a `pending` list of details the code can't know (e.g. the controller's legal name): replace any YOUR_APP_ID placeholder snippet with the real one and ask the user for the pending items. Errors on an unknown code.",
  {
    code: z
      .string()
      .describe("The claim code returned by claim_app (not the URL — the `code` field)."),
  },
  {
    title: "Get claim status",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ code }) => {
    trackToolCall("get_claim_status");
    try {
      const res = await apiFetch(`${API}/api/claim/${encodeURIComponent(code)}`);
      if (res.status === 404) {
        return toolError("Unknown claim code. Create a new claim with claim_app.");
      }
      if (!res.ok) {
        const err = await apiJson<{ error?: string } | null>(res).catch(() => null);
        return toolError(err?.error ?? `API ${res.status}`);
      }
      const data = await apiJson<{
        status: "pending" | "expired" | "claimed";
        appId?: string;
        snippet?: string | null;
        policyUrl?: string;
        pending?: string[];
        /**
         * ¿Sirve ya `policyUrl` los documentos? Con el muro de pago pueden
         * quedarse en borrador, y entonces la página pública responde "aún no
         * disponible". Ausente ⇒ API antigua: se asume publicado, que es el
         * comportamiento de siempre y nunca inventa un muro que no existe.
         */
        published?: boolean;
      }>(res);
      if (data.status === "claimed") {
        // Datos que el humano debe COMPLETAR (draft-first): el código no puede
        // saberlos, así que el agente se los pide al usuario en vez de dejar
        // placeholders silenciosos en los documentos.
        const reviewItems = (data.pending ?? [])
          .map((k) => PENDING_LABEL[k])
          .filter((v): v is string => Boolean(v));
        const reviewNote =
          reviewItems.length > 0
            ? ` Before the documents can be published, the user still needs to provide: ${reviewItems.join("; ")}. Ask them for these and complete them in the LexVibe document editor (they are marked as [to complete] in the documents).`
            : "";
        // Instalar el snippet de una app cuyos documentos siguen en borrador
        // deja el sitio del usuario enlazando una política que no carga: peor
        // que no haber instalado nada, y lo descubre un visitante (o el
        // revisor de una tienda), no él. Mientras no esté publicado, el agente
        // NO debe instalar ni decir que ya cumple.
        const live = data.published !== false;
        return text({
          ...data,
          instructions: live
            ? "The app is claimed and its documents are live. Use this real app id from now on: replace any placeholder (YOUR_APP_ID) snippet with the snippet above (install_snippet accepts an appId argument), and use policyUrl as the privacy-policy link. Suggest the user sets LEXVIBE_APP_ID to this id in their MCP config." +
              reviewNote
            : "The app is claimed BUT its documents are NOT published yet: policyUrl will not serve them until the owner activates hosting from the LexVibe dashboard. Do NOT install the snippet yet and do NOT tell the user they are compliant — installing now would leave a dead legal link on their site. Tell them to publish from their dashboard, then call get_claim_status again." +
              reviewNote,
        });
      }
      if (data.status === "expired") {
        return text({
          status: "expired",
          instructions: "The claim expired (30 min). Create a new one with claim_app.",
        });
      }
      return text({
        status: "pending",
        instructions:
          "The user hasn't confirmed yet. Remind them to open the claim link, then call get_claim_status again in a few seconds.",
      });
    } catch (err) {
      return toolError(`Could not check the claim: ${(err as Error).message}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
