import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Señales de cumplimiento detectables en un proyecto. */
export type SignalKey =
  | "usesAnalytics"
  | "processesPayments"
  | "usesGenerativeAI"
  | "collectsEmails"
  | "sharesWithThirdParties";

/** Plataforma del producto. LexVibe es plug & play: no solo web. */
export type Platform = "web" | "ios" | "android";

interface Rule {
  signal: SignalKey;
  vendor: string;
  /** Dependencias de package.json que delatan la señal. */
  deps?: RegExp;
  /** Patrón en el código fuente. */
  code?: RegExp;
}

const RULES: Rule[] = [
  {
    signal: "usesAnalytics",
    vendor: "Google Analytics",
    deps: /gtag|react-ga|@next\/third-parties/,
    code: /gtag\(|googletagmanager|google-analytics/i,
  },
  { signal: "usesAnalytics", vendor: "PostHog", deps: /posthog/, code: /posthog/i },
  { signal: "usesAnalytics", vendor: "Plausible", deps: /plausible/, code: /plausible/i },
  { signal: "usesAnalytics", vendor: "Vercel Analytics", deps: /@vercel\/analytics/ },
  {
    signal: "processesPayments",
    vendor: "Stripe",
    deps: /stripe/,
    code: /js\.stripe\.com|new Stripe\(/i,
  },
  { signal: "processesPayments", vendor: "Paddle", deps: /paddle/, code: /paddle/i },
  { signal: "processesPayments", vendor: "Lemon Squeezy", deps: /lemonsqueezy/ },
  { signal: "usesGenerativeAI", vendor: "OpenAI", deps: /openai/, code: /api\.openai\.com/i },
  {
    signal: "usesGenerativeAI",
    vendor: "Anthropic",
    deps: /@anthropic-ai\/sdk|anthropic/,
    code: /api\.anthropic\.com/i,
  },
  { signal: "usesGenerativeAI", vendor: "Google Gemini", deps: /@google\/generative-ai/ },
  { signal: "usesGenerativeAI", vendor: "AI SDK", deps: /(^|")ai("|@)/ },
  { signal: "collectsEmails", vendor: "Mailchimp", deps: /mailchimp/, code: /list-manage\.com/i },
  { signal: "collectsEmails", vendor: "Resend", deps: /resend/ },
  {
    signal: "sharesWithThirdParties",
    vendor: "Supabase",
    deps: /@supabase/,
    code: /supabase\.co/i,
  },
  {
    signal: "sharesWithThirdParties",
    vendor: "Firebase",
    deps: /firebase|firebase_core/,
    code: /GoogleService-Info\.plist|google-services\.json|FirebaseApp/i,
  },
  { signal: "sharesWithThirdParties", vendor: "Auth0", deps: /auth0/ },
  { signal: "sharesWithThirdParties", vendor: "Clerk", deps: /@clerk/ },
  { signal: "sharesWithThirdParties", vendor: "NextAuth", deps: /next-auth|@auth\/core/ },
  // --- Señales propias de apps móviles (iOS / Android) ---
  {
    signal: "usesAnalytics",
    vendor: "Google AdMob",
    deps: /google_mobile_ads|react-native-google-mobile-ads/,
    code: /com\.google\.android\.gms\.ads|GADApplicationIdentifier/i,
  },
  { signal: "usesAnalytics", vendor: "Amplitude", deps: /amplitude/ },
  {
    signal: "processesPayments",
    vendor: "RevenueCat",
    deps: /react-native-purchases|purchases_flutter/,
    code: /RevenueCat|purchases_flutter/i,
  },
  {
    signal: "processesPayments",
    vendor: "App Store / Google Play Billing",
    deps: /in_app_purchase|expo-in-app-purchases|react-native-iap/,
    code: /com\.android\.vending\.BILLING|StoreKit|SKPayment/i,
  },
  {
    signal: "sharesWithThirdParties",
    vendor: "App Tracking / IDFA",
    code: /NSUserTrackingUsageDescription|AppTrackingTransparency|AdSupport\.framework/i,
  },
];

const SCAN_DIRS = ["src", "app", "pages", "components", "public", "lib"];
const TEXT_EXT = /\.(tsx?|jsx?|html?|vue|svelte|astro|mdx?)$/;
const MAX_FILES = 400;

/** Manifiestos de apps móviles (iOS / Android / Flutter / Expo) por nombre exacto. */
const MANIFEST_FILE =
  /^(Info\.plist|GoogleService-Info\.plist|AndroidManifest\.xml|Podfile|pubspec\.yaml|app\.json|app\.config\.(?:js|ts|cjs|mjs)|eas\.json|google-services\.json|capacitor\.config\.(?:json|ts))$/;
/** Manifiestos por extensión (gradle, privacy manifest, entitlements…). */
const MANIFEST_EXT = /\.(plist|gradle|gradle\.kts|xcprivacy|entitlements|podspec)$/;
const MAX_MANIFESTS = 60;

export interface ProjectScan {
  signals: { signal: SignalKey; vendors: string[] }[];
  packages: string[];
  /** Plataformas detectadas (web / iOS / Android). */
  platforms: Platform[];
  suggestedAnswers: Record<string, boolean>;
}

/** Datos humanos que LexVibe necesita y que intentamos deducir del repo. */
export interface DerivedDefaults {
  appName?: string;
  companyEntity?: string;
  contactEmail?: string;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** "my-cool-app" → "My Cool App"; capitaliza respetando acentos (Unicode). */
function humanizeName(slug: string): string {
  return slug
    .replace(/^@[^/]+\//, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toLocaleUpperCase("es") + w.slice(1) : w))
    .join(" ");
}

/**
 * Limpia un candidato a responsable legal. Descarta vacíos, emails y los
 * marcadores de plantilla (p. ej. el "Copyright (c) <year> <holder>" de una
 * LICENSE MIT sin editar), que no deben acabar como responsable en un documento.
 */
function cleanEntity(raw: string): string | undefined {
  const hadTemplate = /[<>]/.test(raw); // venía con <…> → placeholder
  const name = raw
    .replace(EMAIL_RE, "")
    .replace(/\s*\([^)]*\)\s*$/, "") // url final entre paréntesis (convención npm)
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,]$/, "");
  if (!name || hadTemplate || EMAIL_RE.test(name)) return undefined;
  if (/^(your name|company( name)?|copyright holder|holder|year|name|author)$/i.test(name)) {
    return undefined;
  }
  return name;
}

function firstEmail(value: string | undefined): string | undefined {
  return value?.match(EMAIL_RE)?.[0];
}

/**
 * Deduce, de forma conservadora, los datos humanos a partir de package.json y
 * LICENSE. No inventa nada: si no hay señal clara, deja el campo vacío para que
 * el wizard (o el agente de desarrollo) lo pida.
 */
export function deriveDefaults(dir: string): DerivedDefaults {
  const out: DerivedDefaults = {};

  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: string;
      author?: string | { name?: string; email?: string };
      bugs?: { email?: string };
    };
    if (typeof pkg.name === "string" && pkg.name.length > 0) {
      out.appName = humanizeName(pkg.name);
    }
    if (typeof pkg.author === "string") {
      const entity = cleanEntity(pkg.author);
      if (entity) out.companyEntity = entity;
      out.contactEmail = firstEmail(pkg.author);
    } else if (pkg.author && typeof pkg.author === "object") {
      if (pkg.author.name) {
        const entity = cleanEntity(pkg.author.name);
        if (entity) out.companyEntity = entity;
      }
      out.contactEmail = firstEmail(pkg.author.email);
    }
    if (!out.contactEmail) out.contactEmail = firstEmail(pkg.bugs?.email);
  } catch {
    /* sin package.json */
  }

  if (!out.companyEntity) {
    for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
      try {
        const text = readFileSync(join(dir, name), "utf8");
        const m = text.match(/copyright\s+(?:\(c\)|©)?\s*\d{0,4}[,\s]*([^\n]+)/i);
        const entity = m?.[1] ? cleanEntity(m[1]) : undefined;
        if (entity) {
          out.companyEntity = entity;
          break;
        }
      } catch {
        /* siguiente candidato */
      }
    }
  }

  return out;
}

export function scanProject(dir: string): ProjectScan {
  let pkgText = "";
  const deps: string[] = [];
  try {
    pkgText = readFileSync(join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgText) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    deps.push(...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}));
  } catch {
    /* sin package.json: seguimos con el código */
  }

  const manifests = readManifests(dir);
  const code = readSource(dir) + "\n" + manifests.text;
  // Los manifiestos móviles (pubspec.yaml, Gradle, Podfile, app.json…) son TAMBIÉN
  // declaraciones de dependencias: van a depBlob para que las reglas `deps`
  // (google_mobile_ads, in_app_purchase, firebase_core, amplitude…) acierten en
  // apps Flutter/nativas que no tienen package.json.
  const depBlob = deps.join("\n") + "\n" + pkgText + "\n" + manifests.text;

  const byKey = new Map<SignalKey, Set<string>>();
  for (const rule of RULES) {
    const hit = (rule.deps && rule.deps.test(depBlob)) || (rule.code && rule.code.test(code));
    if (!hit) continue;
    if (!byKey.has(rule.signal)) byKey.set(rule.signal, new Set());
    byKey.get(rule.signal)!.add(rule.vendor);
  }

  const signals = [...byKey.entries()].map(([signal, vendors]) => ({
    signal,
    vendors: [...vendors],
  }));

  const suggestedAnswers: Record<string, boolean> = {};
  for (const s of signals) suggestedAnswers[s.signal] = true;
  if (suggestedAnswers.usesAnalytics || suggestedAnswers.processesPayments) {
    suggestedAnswers.sharesWithThirdParties = true;
  }

  const platforms = detectPlatforms(dir, manifests.found, deps, manifests.text);

  return { signals, packages: deps, platforms, suggestedAnswers };
}

interface ManifestScan {
  /** Contenido concatenado de los manifiestos (para las reglas `code`). */
  text: string;
  /** Nombres de fichero de manifiesto encontrados (basename, y banderas por extensión). */
  found: Set<string>;
}

/** Lee manifiestos de apps móviles allá donde estén (root, ios/, android/…). */
function readManifests(dir: string): ManifestScan {
  let text = "";
  let count = 0;
  const found = new Set<string>();

  const walk = (current: string, depth: number) => {
    if (depth > 4 || count > MAX_MANIFESTS) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(current, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const isNamed = MANIFEST_FILE.test(entry);
      const isExt = MANIFEST_EXT.test(entry);
      if (!isNamed && !isExt) continue;
      if (isNamed) found.add(entry);
      if (entry.endsWith(".gradle") || entry.endsWith(".gradle.kts")) found.add("*.gradle");
      if (entry.endsWith(".podspec")) found.add("*.podspec");
      if (s.size < 200_000) {
        try {
          text += readFileSync(full, "utf8") + "\n";
          count++;
        } catch {
          /* ignore */
        }
      }
      if (count > MAX_MANIFESTS) return;
    }
  };

  walk(dir, 0);
  return { text, found };
}

/** Deduce las plataformas a partir de los manifiestos y dependencias. */
function detectPlatforms(
  dir: string,
  found: Set<string>,
  deps: string[],
  manifestText: string,
): Platform[] {
  const set = new Set<Platform>();

  // Coincidencia EXACTA de dependencias (no subcadena): `expo-server-sdk` en un
  // backend web no debe clasificarlo como móvil; solo el paquete del framework.
  const hasDep = (test: (d: string) => boolean) => deps.some(test);
  const isCrossPlatformDep = (d: string) =>
    d === "expo" ||
    d === "react-native" ||
    d === "cordova" ||
    d === "@capacitor/core" ||
    d.startsWith("@capacitor/");

  // Frameworks cross-platform → iOS + Android.
  // OJO: no usamos la mera presencia de `app.json` como señal (Heroku y otros
  // proyectos web también tienen un app.json en la raíz). Los apps Expo se
  // detectan por la dependencia `expo` o por `eas.json`, que sí es exclusivo de Expo.
  const crossPlatform =
    hasDep(isCrossPlatformDep) ||
    found.has("eas.json") ||
    found.has("capacitor.config.json") ||
    found.has("capacitor.config.ts") ||
    found.has("pubspec.yaml") ||
    /sdk:\s*flutter/.test(manifestText);
  if (crossPlatform) {
    set.add("ios");
    set.add("android");
  }

  // Señales nativas concretas.
  if (
    found.has("Info.plist") ||
    found.has("Podfile") ||
    found.has("GoogleService-Info.plist") ||
    found.has("*.podspec")
  ) {
    set.add("ios");
  }
  if (
    found.has("AndroidManifest.xml") ||
    found.has("google-services.json") ||
    found.has("*.gradle")
  ) {
    set.add("android");
  }

  // Web: se detecta POSITIVAMENTE, no solo como fallback. Un híbrido
  // Capacitor/Ionic o un monorepo Next+Expo es web ADEMÁS de iOS/Android:
  // si perdiéramos "web", make_compliant se saltaría el banner de cookies.
  const isWebDep = (d: string) =>
    d === "next" ||
    d === "react-dom" ||
    d === "vue" ||
    d === "svelte" ||
    d === "astro" ||
    d === "nuxt" ||
    d === "vite" ||
    d.startsWith("@sveltejs/") ||
    d.startsWith("@remix-run/");
  const isWebviewWrapperDep = (d: string) =>
    d === "cordova" || d === "@capacitor/core" || d.startsWith("@ionic/");
  const hasWebEntry =
    existsSync(join(dir, "index.html")) ||
    existsSync(join(dir, "public", "index.html")) ||
    existsSync(join(dir, "src", "index.html")) ||
    existsSync(join(dir, "app", "layout.tsx")) ||
    existsSync(join(dir, "src", "app", "layout.tsx")) ||
    existsSync(join(dir, "pages", "index.tsx")) ||
    existsSync(join(dir, "pages", "index.jsx"));
  const isCapacitorProject = found.has("capacitor.config.json") || found.has("capacitor.config.ts");
  if (hasDep(isWebDep) || hasDep(isWebviewWrapperDep) || isCapacitorProject || hasWebEntry) {
    set.add("web");
  }
  // Sin ninguna señal, asumimos web (el caso más común en vibe coding).
  if (set.size === 0) set.add("web");

  return [...set];
}

function readSource(dir: string): string {
  let out = "";
  let count = 0;

  const walk = (current: string, depth: number) => {
    if (depth > 4 || count > MAX_FILES) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(current, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(full, depth + 1);
      } else if (TEXT_EXT.test(entry) && s.size < 200_000) {
        try {
          out += readFileSync(full, "utf8") + "\n";
          count++;
        } catch {
          /* ignore */
        }
      }
      if (count > MAX_FILES) return;
    }
  };

  for (const sub of SCAN_DIRS) walk(join(dir, sub), 0);
  // Los exports de Vite (Lovable, Bolt…) llevan index.html en la RAÍZ del repo,
  // que es justo donde el usuario pega el snippet de Google Analytics. Léelo
  // SIEMPRE (junto a cualquier *.html raíz), no solo cuando SCAN_DIRS quedó vacío.
  try {
    for (const entry of readdirSync(dir)) {
      if (!/\.html?$/i.test(entry)) continue;
      const full = join(dir, entry);
      try {
        const s = statSync(full);
        if (s.isFile() && s.size < 200_000) out += readFileSync(full, "utf8") + "\n";
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  if (out.length === 0) walk(dir, 0);
  return out;
}
