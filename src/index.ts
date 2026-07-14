#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { trackToolCall } from "./analytics.js";
import { deriveDefaults, scanProject } from "./detect.js";

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

/** El snippet canónico — misma forma que buildSnippet() en apps/web. */
function buildSnippet(id: string, accent?: string): string {
  return `<script src="${CDN}/v1/lexvibe-widget.js" data-lexvibe-app="${id}" data-config="${API}/api/widget-config/${id}" data-ingest="${API}/api/consent"${accent ? ` data-accent="${accent}"` : ""} defer></script>`;
}

/** Versión JSX del snippet, para layouts React (Next.js App Router, etc.). */
function buildJsxSnippet(id: string, accent?: string): string {
  return `<script src="${CDN}/v1/lexvibe-widget.js" data-lexvibe-app="${id}" data-config="${API}/api/widget-config/${id}" data-ingest="${API}/api/consent"${accent ? ` data-accent="${accent}"` : ""} defer />`;
}

const server = new McpServer(
  { name: "lexvibe", version: "0.1.3" },
  {
    instructions:
      "LexVibe makes vibe-coded apps (Lovable, Bolt, v0, Next.js, plain HTML) legally compliant: GDPR privacy policy, terms of service, cookie consent banner with real script blocking, and EU AI Act risk classification. When the user asks to make their app legally compliant, GDPR-ready, or to add a privacy policy / terms / cookie banner, call make_compliant first (one step). Use check_compliance for a read-only readiness report, scan_project to detect data processing, generate_policies for documents only, install_snippet to add the cookie banner to a specific file, and check_ai_act to classify EU AI Act risk. If no real LexVibe app id is configured (LEXVIBE_APP_ID missing or a placeholder), call claim_app to get a link the user opens to create a real app in their account, then poll get_claim_status for the real app id and snippet.",
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

server.tool(
  "scan_project",
  "Read-only scan of a local project (dependencies + source code + mobile manifests). Detects data processing relevant to legal compliance — analytics, payments, generative AI, email collection, third-party sharing — and the product platforms (web / iOS / Android). Use it to gather the suggestedAnswers that generate_policies expects, or call make_compliant to do everything in one step.",
  { dir: z.string().describe("Path to the project to analyze (repo root).") },
  { title: "Scan project", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async ({ dir }) => {
    trackToolCall("scan_project");
    try {
      return text(scanProject(dir));
    } catch (err) {
      return text({ error: `Scan failed: ${(err as Error).message}` });
    }
  },
);

server.tool(
  "check_compliance",
  "Read-only compliance readiness check: scans the project, detects platforms and data processing, auto-derives what it can (app name, legal entity, contact email) and reports which human facts are still missing (including target markets). Returns an agentPrompt you (the dev agent) can answer from the repo, so document generation needs no forms. Call it before make_compliant when you want to confirm facts first.",
  {
    dir: z.string().describe("Project root path."),
    appName: z.string().optional().describe("Override the auto-derived app name."),
  },
  {
    title: "Check compliance readiness",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async ({ dir, appName }) => {
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
        agentPrompt: buildAgentPrompt(missing, (answers.appName as string) ?? "this product"),
      });
    } catch (err) {
      return text({ error: `Check failed: ${(err as Error).message}` });
    }
  },
);

server.tool(
  "generate_policies",
  "Generate the legal documents (privacy policy, terms of service and, if applicable, an AI disclosure) localized and tailored to the target markets (GDPR, UK GDPR, CCPA…). Returns Markdown. Pass scan_project's suggestedAnswers as `answers` so the documents disclose the right processing.",
  {
    appName: z.string(),
    entity: z.string().optional().describe("Data controller / legal entity."),
    contactEmail: z.string().optional(),
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
      .min(1),
    locales: z
      .array(z.enum(["es", "en", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "hi", "ar"]))
      .optional(),
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
      const res = await fetch(`${API}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return text({ error: `API ${res.status}` });
      return text(await res.json());
    } catch (err) {
      return text({ error: `Could not generate: ${(err as Error).message}` });
    }
  },
);

server.tool(
  "install_snippet",
  "Insert the LexVibe cookie-banner + hosted-policies snippet into an HTML file, right before </head>. If the file has no literal </head> (e.g. a Next.js App Router layout.tsx), it does NOT modify the file: it returns the snippet plus exact instructions for you (the dev agent) to add it as JSX. Never corrupts user files.",
  {
    file: z.string().describe("File to install into (index.html, app/layout.tsx…)."),
    appId: z.string().optional().describe("App id (defaults to LEXVIBE_APP_ID)."),
    accent: z.string().optional(),
  },
  {
    title: "Install cookie-banner snippet",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async ({ file, appId, accent }) => {
    trackToolCall("install_snippet");
    const id = appId ?? APP_ID;
    const snippet = buildSnippet(id, accent);
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
              : ""),
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
        instructions: [
          "Add the snippet manually. For a Next.js App Router root layout (app/layout.tsx), add a <head> element inside <html> in the returned JSX and place this self-closing script inside it:",
          `<head>\n  ${buildJsxSnippet(id, accent)}\n</head>`,
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
      return text({ error: `Could not install: ${(err as Error).message}` });
    }
  },
);

server.tool(
  "check_ai_act",
  "Classify the system's risk under the EU AI Act and return the applicable obligations with their deadlines.",
  {
    usesAI: z.boolean().default(true),
    interactsWithPeople: z.boolean().default(false),
    generatesContent: z.boolean().default(false),
    automatedDecisions: z.boolean().default(false),
    socialScoring: z.boolean().default(false),
    realtimeBiometricPublic: z.boolean().default(false),
    annexIII: z.array(z.string()).default([]),
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
      const res = await fetch(`${API}/api/ai-act/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(answers),
      });
      if (!res.ok) return text({ error: `API ${res.status}` });
      return text(await res.json());
    } catch (err) {
      return text({ error: `Could not classify: ${(err as Error).message}` });
    }
  },
);

server.tool(
  "make_compliant",
  "One-step legal compliance: scan the project, generate privacy policy / terms / cookie & AI disclosures (written to /legal), install the cookie-banner snippet into the HTML head, and classify EU AI Act risk. Use this first when the user asks to make their app legally compliant, GDPR-ready, or to add a privacy policy or cookie banner. Returns a summary, any missing human facts, and next steps.",
  {
    dir: z.string().describe("Project root path."),
    appName: z
      .string()
      .optional()
      .describe(
        "App / business name. If omitted, it's derived from the repo (package.json / LICENSE).",
      ),
    appId: z.string().optional().describe("LexVibe app id (defaults to LEXVIBE_APP_ID)."),
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
      .default(["eu"]),
    accent: z.string().optional(),
  },
  {
    title: "Make app compliant (one step)",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ dir, appName, appId, markets, accent }) => {
    trackToolCall("make_compliant");
    const id = appId ?? APP_ID;
    const steps: string[] = [];
    const written: string[] = [];

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
      steps.push(`Scan failed: ${(err as Error).message}`);
    }
    // El appName explícito manda; si no, se queda el deducido del repo (o falta).
    if (appName) answers.appName = appName;
    // markets llega como argumento (con default), así que ya está provisto.
    answers.markets = markets;
    const resolvedName = (answers.appName as string | undefined) ?? "this product";
    const isMobile = platforms.includes("ios") || platforms.includes("android");
    const isWeb = platforms.includes("web");
    const missing = missingFacts(answers);

    // 2) Generar documentos (sin sesión: hasta 3 idiomas, sin persistir).
    try {
      const res = await fetch(`${API}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, markets }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          documents?: { docType: string; locale: string; content: string }[];
        };
        const legalDir = join(dir, "legal");
        mkdirSync(legalDir, { recursive: true });
        for (const doc of data.documents ?? []) {
          const path = join(legalDir, `${doc.docType}.${doc.locale}.md`);
          writeFileSync(path, doc.content, "utf8");
          written.push(path);
        }
        steps.push(`Documents generated: ${written.length} files in /legal.`);
      } else {
        steps.push(`Generation: API responded ${res.status}.`);
      }
    } catch (err) {
      steps.push(`Generation failed: ${(err as Error).message}`);
    }

    // 3) Instalar el snippet del banner de cookies. Solo aplica a web: una app
    // nativa no tiene <head> ni cookies del navegador (su consentimiento se
    // gestiona con manifiestos de la tienda y, si acaso, un SDK de consentimiento).
    const snippet = buildSnippet(id, accent);
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
          : `No file with a literal </head> was found, so nothing was modified (writing raw HTML into a JSX/TSX layout would break it). Add the snippet manually — plain HTML, before </head>:\n${snippet}\nOr, in a Next.js App Router layout (app/layout.tsx), add a <head> element inside <html> containing:\n${buildJsxSnippet(id, accent)}`,
      );
    } else {
      steps.push(
        "Cookie banner skipped: this is a native app (no browser cookies). Use the hosted policy URLs in the App Store / Google Play listing instead.",
      );
    }

    // 4) Clasificar EU AI Act.
    let aiAct: unknown = null;
    try {
      const res = await fetch(`${API}/api/ai-act/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usesAI: answers.usesGenerativeAI === true,
          generatesContent: answers.usesGenerativeAI === true,
        }),
      });
      if (res.ok) aiAct = await res.json();
    } catch {
      /* opcional */
    }

    return text({
      done: steps,
      filesWritten: written,
      snippet,
      aiAct,
      // Datos humanos que el código no pudo deducir. Como agente con acceso al
      // repo, puedes responderlos y volver a generar para documentos completos.
      missingFacts: missing.map((m) => m.id),
      agentPrompt: missing.length > 0 ? buildAgentPrompt(missing, resolvedName) : undefined,
      nextSteps: [
        ...(missing.length > 0
          ? [
              `Missing human facts the code can't know: ${missing.map((m) => m.id).join(", ")}. Answer them (see agentPrompt) and re-run for complete documents.`,
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
  "Create a REAL LexVibe app in the user's account (replaces the YOUR_APP_ID placeholder). Returns a claim link: show it to the user so they can sign in and confirm — the link expires in 30 minutes. After they confirm, call get_claim_status with the returned code to retrieve the real app id and install snippet. Use this whenever no real LEXVIBE_APP_ID is configured, so hosted policies, consent proof and auto-updates get linked to the user's account.",
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
      .describe("Regions where the app has users. Defaults to [eu]."),
    answers: z
      .record(z.union([z.string(), z.boolean(), z.array(z.string())]))
      .optional()
      .describe(
        "Compliance flags you already know (pass scan_project's suggestedAnswers): usesAnalytics, processesPayments, usesGenerativeAI, collectsEmails, sharesWithThirdParties, platformType, companyEntity, contactEmail…",
      ),
  },
  {
    title: "Claim a real LexVibe app",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ url, appName, markets, answers }) => {
    trackToolCall("claim_app");
    if (!url && !appName) {
      return text({ error: "Provide at least `url` or `appName` to create the claim." });
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
      const res = await fetch(`${API}/api/claim/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, appName, markets, answers, platform }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        return text({ error: err?.error ?? `API ${res.status}` });
      }
      const data = (await res.json()) as {
        claimUrl: string;
        code: string;
        expiresAt: string;
      };
      return text({
        ...data,
        instructions:
          "Show this link to the user and ask them to open it, sign in and confirm — that creates the app in THEIR LexVibe account. After they confirm, call get_claim_status with this code to retrieve the real app id and snippet, then replace any placeholder (YOUR_APP_ID) snippet you installed.",
      });
    } catch (err) {
      return text({ error: `Could not create the claim: ${(err as Error).message}` });
    }
  },
);

server.tool(
  "get_claim_status",
  "Check whether the user has confirmed a claim created with claim_app. While the user hasn't confirmed yet it returns {status: 'pending'} — wait a few seconds and call again (the link expires in 30 minutes). Once claimed it returns the REAL app id, the install snippet and the hosted privacy-policy URL: replace any placeholder (YOUR_APP_ID) snippet with the real one.",
  { code: z.string().describe("The claim code returned by claim_app.") },
  {
    title: "Get claim status",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ code }) => {
    trackToolCall("get_claim_status");
    try {
      const res = await fetch(`${API}/api/claim/${encodeURIComponent(code)}`);
      if (res.status === 404) {
        return text({ error: "Unknown claim code. Create a new claim with claim_app." });
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        return text({ error: err?.error ?? `API ${res.status}` });
      }
      const data = (await res.json()) as {
        status: "pending" | "expired" | "claimed";
        appId?: string;
        snippet?: string | null;
        policyUrl?: string;
      };
      if (data.status === "claimed") {
        return text({
          ...data,
          instructions:
            "The app is claimed. Use this real app id from now on: replace any placeholder (YOUR_APP_ID) snippet with the snippet above (install_snippet accepts an appId argument), and use policyUrl as the privacy-policy link. Suggest the user sets LEXVIBE_APP_ID to this id in their MCP config.",
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
      return text({ error: `Could not check the claim: ${(err as Error).message}` });
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
