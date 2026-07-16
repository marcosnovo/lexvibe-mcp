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
    // Import/uso real, NO una mención en un comentario ("RevenueCat data: …").
    code: /import\s+RevenueCat|RevenueCat\.configure|Purchases\.configure|purchases_flutter/i,
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
// OJO: `.md` NO es código — un doc de investigación que menciona "AdMob" o
// "ATTrackingManager" no significa que la app lo integre (falso positivo real
// en Refil). `.mdx` sí (lleva JSX ejecutable).
const TEXT_EXT = /\.(tsx?|jsx?|html?|vue|svelte|astro|mdx)$/;
const MAX_FILES = 400;

/** Manifiestos de apps móviles (iOS / Android / Flutter / Expo) por nombre exacto. */
// `project.pbxproj` es EL manifiesto de dependencias de iOS (paquetes SPM:
// GoogleSignIn, Supabase…) además de declarar knownRegions y entitlements.
const MANIFEST_FILE =
  /^(Info\.plist|GoogleService-Info\.plist|AndroidManifest\.xml|Podfile|project\.pbxproj|pubspec\.yaml|app\.json|app\.config\.(?:js|ts|cjs|mjs)|eas\.json|google-services\.json|capacitor\.config\.(?:json|ts))$/;
/** Manifiestos por extensión (gradle, privacy manifest, entitlements…). */
const MANIFEST_EXT = /\.(plist|gradle|gradle\.kts|xcprivacy|entitlements|podspec)$/;
const MAX_MANIFESTS = 60;

/**
 * Hechos ESTRUCTURADOS del proyecto (mismo shape que `AnalysisFacts` del
 * dashboard): anclan la generación de documentos en evidencia, no en priors.
 * Viajan en el payload del claim y el dashboard los convierte en el manifiesto
 * de tratamientos.
 */
export interface ScanFacts {
  authMethods: ("apple" | "google" | "email" | "other")[];
  payments: "apple_iap" | "google_play" | "stripe" | "other" | "none";
  ai: {
    /** IA generativa DE CARA AL USUARIO (chatbot, contenido generado visible). */
    userFacing: boolean;
    /** IA solo en servidor (p. ej. clasificar contenido público). */
    serverSide: boolean;
    /** ¿Trata datos personales de usuarios? Solo con evidencia. */
    processesPersonalData: boolean;
    providers: string[];
  };
  tracking: { idfa: boolean; att: boolean; adSdks: boolean };
  /** Claves estables: precise_location, background_location, push_notifications… */
  devicePermissions: string[];
}

export interface ProjectScan {
  signals: { signal: SignalKey; vendors: string[] }[];
  packages: string[];
  /** Plataformas detectadas (web / iOS / Android). */
  platforms: Platform[];
  suggestedAnswers: Record<string, boolean>;
  /** Hechos estructurados para el manifiesto de tratamientos del dashboard. */
  facts: ScanFacts;
  /** Idiomas que la app soporta (carpetas lproj/values-xx/locales, xcstrings). */
  locales: string[];
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

/** Carpetas de dependencias/artefactos: sus archivos NO son de la app. */
const VENDOR_DIR_RE =
  /^(node_modules|Pods|Carthage|DerivedData|build|dist|vendor|Vendor|Frameworks|\.build|\.swiftpm)$|\.(xc)?framework$/;

/** Rutas relativas del proyecto (sin dependencias), acotadas. */
function collectPaths(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string, depth: number) => {
    if (depth > 5 || out.length > 4000) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || VENDOR_DIR_RE.test(entry)) continue;
      const full = join(current, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(full, relPath, depth + 1);
      else out.push(relPath);
      if (out.length > 4000) return;
    }
  };
  walk(dir, "", 0);
  return out;
}

const LOCALE_CODES = new Set(["es", "en", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "hi", "ar"]);

function normLocale(code: string): string | null {
  const c = code.toLowerCase().slice(0, 2);
  return LOCALE_CODES.has(c) ? c : null;
}

/** Idiomas de la app: carpetas de localización + String Catalogs (.xcstrings). */
export function detectLocales(dir: string, paths: string[]): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    const lproj = p.match(/(?:^|\/)([A-Za-z-]+)\.lproj(?:\/|$)/);
    if (lproj?.[1] && lproj[1].toLowerCase() !== "base") {
      const l = normLocale(lproj[1]);
      if (l) set.add(l);
    }
    const android = p.match(/(?:^|\/)values-([a-z]{2})(?:[-/]|$)/i);
    if (android?.[1]) {
      const l = normLocale(android[1]);
      if (l) set.add(l);
    }
    const web = p.match(/(?:^|\/)(?:locales|messages|i18n|lang|translations|intl)\/([a-z]{2})(?:[-_/.]|$)/i);
    if (web?.[1]) {
      const l = normLocale(web[1]);
      if (l) set.add(l);
    }
  }
  // String Catalogs de Xcode: las localizaciones viven DENTRO del JSON.
  for (const p of paths.filter((x) => x.endsWith(".xcstrings")).slice(0, 4)) {
    try {
      const json = JSON.parse(readFileSync(join(dir, p), "utf8")) as {
        strings?: Record<string, { localizations?: Record<string, unknown> }>;
      };
      for (const entry of Object.values(json.strings ?? {})) {
        for (const code of Object.keys(entry.localizations ?? {})) {
          const l = normLocale(code);
          if (l) set.add(l);
        }
      }
    } catch {
      /* xcstrings no parseable */
    }
  }
  return [...set];
}

const AI_RE =
  /@anthropic-ai|anthropic|claude-[a-z0-9.-]+|ANTHROPIC_API_KEY|api\.openai\.com|OPENAI_API_KEY|from\s+['"]openai['"]|import\s+OpenAI\b|GoogleGenerativeAI|generativelanguage\.googleapis/i;
const BACKEND_PATH_RE =
  /(?:^|\/)(?:api|server|backend|backend-workers|worker|workers|functions|mcp-server)\//i;
const CLIENT_AI_PATH_RE = /(chat|assistant|copilot|conversation|prompt|generat)/i;
const CODE_FILE_RE = /\.(swift|kt|m|mm|tsx?|jsx?|py|rb|go)$/i;

/**
 * Clasifica el uso de IA leyendo DÓNDE vive la evidencia (mismo criterio que el
 * dashboard): en fuente de cliente o ruta de chat/asistente ⇒ de cara al
 * usuario (aplica art. 50); solo en rutas de backend ⇒ solo servidor (no se
 * inventa un asistente); sin evidencia en archivos ⇒ conservador: solo servidor.
 * Una dependencia npm suelta NUNCA implica un chatbot.
 */
/**
 * Fuente NATIVA de alta señal (Swift/Kotlin): `readSource` solo lee código web
 * (TEXT_EXT), así que StoreKit, CoreLocation o TelemetryService serían
 * invisibles. Se leen los archivos nativos cuyo NOMBRE delata una categoría de
 * cumplimiento (cobertura por categoría, como la vía GitHub), acotado.
 */
function readNativeSignalFiles(dir: string, paths: string[]): string {
  const NATIVE_RE = /\.(swift|kt|m|mm)$/i;
  const KEYWORD_RE =
    /(auth|login|signin|account|paywall|purchase|subscription|storekit|entitlement|billing|telemetry|analytic|consent|track|location|notification|push|sync|email|profile)/i;
  let out = "";
  let count = 0;
  for (const p of paths) {
    if (count >= 40) break;
    if (!NATIVE_RE.test(p) || !KEYWORD_RE.test(p)) continue;
    try {
      const full = join(dir, p);
      if (statSync(full).size > 200_000) continue;
      out += readFileSync(full, "utf8") + "\n";
      count++;
    } catch {
      /* ignore */
    }
  }
  return out;
}

const AI_PROVIDER_RES: [RegExp, string][] = [
  [/@anthropic-ai|anthropic|claude-[a-z0-9.-]+|ANTHROPIC_API_KEY/i, "Anthropic (Claude)"],
  [/api\.openai\.com|OPENAI_API_KEY|from\s+['"]openai['"]|import\s+OpenAI\b/i, "OpenAI"],
  [/GoogleGenerativeAI|generativelanguage\.googleapis/i, "Google Gemini"],
];

export function classifyAiUsage(
  dir: string,
  paths: string[],
  hasAiDependency: boolean,
): { mode: "none" | "backend" | "user"; providers: string[] } {
  // PRIORIDAD: primero los archivos de backend y los de nombre chat/asistente
  // (donde vive la evidencia decisiva) y DESPUÉS el resto de fuente nativa. Sin
  // este orden, una app iOS con cientos de .swift llenaba el cupo antes de
  // llegar a `backend-workers/` y la IA del servidor quedaba invisible.
  const code = paths.filter((p) => CODE_FILE_RE.test(p));
  const primary = code.filter((p) => BACKEND_PATH_RE.test(p) || CLIENT_AI_PATH_RE.test(p));
  const rest = code.filter((p) => !primary.includes(p) && /\.(swift|kt|m|mm)$/i.test(p));
  const candidates = [...primary.slice(0, 80), ...rest.slice(0, 40)];

  const providers = new Set<string>();
  let backendHit = false;
  let userHit = false;
  for (const p of candidates) {
    let content = "";
    try {
      const full = join(dir, p);
      if (statSync(full).size > 200_000) continue;
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!AI_RE.test(content)) continue;
    for (const [re, name] of AI_PROVIDER_RES) if (re.test(content)) providers.add(name);
    if (BACKEND_PATH_RE.test(p)) backendHit = true;
    else userHit = true; // evidencia en cliente
  }
  const mode = userHit ? "user" : backendHit ? "backend" : hasAiDependency ? "backend" : "none";
  return { mode, providers: [...providers] };
}

/** Hechos estructurados a partir de los blobs + clasificación de IA por rutas. */
export function collectFacts(
  dir: string,
  paths: string[],
  depBlob: string,
  code: string,
  aiVendors: string[],
): ScanFacts {
  const blob = depBlob + "\n" + code;

  const authMethods: ScanFacts["authMethods"] = [];
  if (/AuthenticationServices|ASAuthorizationAppleID|SignInWithApple|applesignin|sign_in_with_apple/i.test(blob))
    authMethods.push("apple");
  if (/GoogleSignIn|GIDSignIn|google_sign_in|@react-oauth\/google/i.test(blob)) authMethods.push("google");
  if (/signInWithPassword|signInWithOtp|createUserWithEmail|next-auth|magic[ -]?link|EmailAuth/i.test(blob))
    authMethods.push("email");

  const payments: ScanFacts["payments"] = /import\s+StoreKit|StoreKit2|SKPayment|in_app_purchase|react-native-iap|expo-in-app-purchases/i.test(
    blob,
  )
    ? "apple_iap"
    : /BillingClient|com\.android\.billingclient|com\.android\.vending\.BILLING/i.test(blob)
      ? "google_play"
      : /js\.stripe\.com|new Stripe\(|@stripe\//i.test(blob)
        ? "stripe"
        : /paddle|lemonsqueezy|braintree|paypal/i.test(blob)
          ? "other"
          : "none";

  const att = /NSUserTrackingUsageDescription|ATTrackingManager|AppTrackingTransparency/i.test(blob);
  const adSdks =
    /GoogleMobileAds|GADApplication|google_mobile_ads|react-native-google-mobile-ads|FBAudienceNetwork|AppLovin|ironSource/i.test(
      blob,
    );

  const devicePermissions: string[] = [];
  if (/NSLocation\w*UsageDescription|CLLocationManager|ACCESS_FINE_LOCATION/i.test(blob)) {
    devicePermissions.push("precise_location");
    if (/NSLocationAlways|allowsBackgroundLocationUpdates|ACCESS_BACKGROUND_LOCATION/i.test(blob))
      devicePermissions.push("background_location");
  }
  if (/aps-environment|registerForRemoteNotifications|firebase_messaging|expo-notifications/i.test(blob))
    devicePermissions.push("push_notifications");
  if (/NSCameraUsageDescription|android\.permission\.CAMERA/i.test(blob)) devicePermissions.push("camera");
  if (/NSPhotoLibrary\w*UsageDescription/i.test(blob)) devicePermissions.push("photos");
  if (/NSContactsUsageDescription|READ_CONTACTS/i.test(blob)) devicePermissions.push("contacts");
  if (/NSMicrophoneUsageDescription|RECORD_AUDIO/i.test(blob)) devicePermissions.push("microphone");
  if (/HealthKit|NSHealth\w*UsageDescription/i.test(blob)) devicePermissions.push("health");

  const ai = classifyAiUsage(dir, paths, aiVendors.length > 0);
  // Colapsa nombres subsumidos ("Anthropic" ⊂ "Anthropic (Claude)").
  const merged = [...new Set([...aiVendors, ...ai.providers])];
  const providers = merged.filter(
    (v) => !merged.some((o) => o !== v && o.toLowerCase().startsWith(v.toLowerCase())),
  );
  return {
    authMethods,
    payments,
    ai: {
      userFacing: ai.mode === "user",
      serverSide: ai.mode !== "none",
      // Solo afirmamos tratamiento de datos personales por IA si es de cara al
      // usuario (sus entradas viajan al proveedor).
      processesPersonalData: ai.mode === "user",
      providers,
    },
    tracking: { idfa: att || adSdks, att, adSdks },
    devicePermissions,
  };
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
  // Rutas del proyecto (sin dependencias): para idiomas, clasificación de IA
  // por ubicación del archivo, fuente nativa y package.json ANIDADOS.
  const paths = collectPaths(dir);
  const code = readSource(dir) + "\n" + manifests.text + "\n" + readNativeSignalFiles(dir, paths);
  // Los manifiestos móviles (pubspec.yaml, Gradle, Podfile, app.json…) son TAMBIÉN
  // declaraciones de dependencias: van a depBlob para que las reglas `deps`
  // (google_mobile_ads, in_app_purchase, firebase_core, amplitude…) acierten en
  // apps Flutter/nativas que no tienen package.json. Los package.json anidados
  // (backend-workers/, functions/…) delatan los vendors de SERVIDOR (Resend,
  // Anthropic) que el package.json raíz no lista.
  let nestedPkgs = "";
  for (const p of paths.filter((x) => x !== "package.json" && x.endsWith("/package.json")).slice(0, 6)) {
    try {
      nestedPkgs += readFileSync(join(dir, p), "utf8") + "\n";
    } catch {
      /* ignore */
    }
  }
  const depBlob = deps.join("\n") + "\n" + pkgText + "\n" + manifests.text + "\n" + nestedPkgs;

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

  // Hechos estructurados + idiomas: la MISMA inteligencia que la vía GitHub del
  // dashboard, pero con acceso total al filesystem (aún más fiable). Viajan en
  // el claim y anclan la generación en evidencia.
  const aiVendors = (byKey.get("usesGenerativeAI") && [...byKey.get("usesGenerativeAI")!]) || [];
  const facts = collectFacts(dir, paths, depBlob, code, aiVendors);
  const locales = detectLocales(dir, paths);

  // IA solo de servidor: NO es un sistema de IA para el usuario → no
  // pre-marcamos usesGenerativeAI (evita el aviso art. 50 inventado). El
  // proveedor sigue listado como tercero.
  if (suggestedAnswers.usesGenerativeAI && !facts.ai.userFacing) {
    delete suggestedAnswers.usesGenerativeAI;
    suggestedAnswers.sharesWithThirdParties = true;
  }

  return { signals, packages: deps, platforms, suggestedAnswers, facts, locales };
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
