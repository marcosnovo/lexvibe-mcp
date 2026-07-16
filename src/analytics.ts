/*
 * Telemetría de uso del canal MCP (stdio).
 *
 * El servidor remoto (golexvibe.com/api/mcp) ya registra cada llamada a
 * herramienta como un evento `mcp_tool_call` en la tabla `platform_events`
 * que alimenta el Platform analytics (/admin). Este paquete stdio corre en la
 * máquina del usuario (Claude Code, Cursor, Claude Desktop…) y hasta ahora no
 * enviaba nada, así que su uso no aparecía en el mismo panel. Este módulo cierra
 * ese hueco: emite el mismo evento `mcp_tool_call`, con `source: "mcp_stdio"`
 * para poder distinguir ambos canales en el mismo dashboard.
 *
 * Principios:
 *   - Fire-and-forget: nunca bloquea, retrasa ni rompe la ejecución de una
 *     herramienta. Cualquier fallo (red, timeout, opt-out) se ignora en silencio.
 *   - Sin PII: solo el nombre de la herramienta y metadatos gruesos. Nunca se
 *     envían rutas, contenidos de ficheros, nombres de app, emails ni código.
 *   - Opt-out fácil: DO_NOT_TRACK=1 o LEXVIBE_TELEMETRY=0 lo desactivan.
 *
 * Configurable por entorno:
 *   LEXVIBE_EVENTS_URL   endpoint de ingesta (def. la Edge Function de LexVibe;
 *                        ver DEFAULT_EVENTS_URL / eventsUrl más abajo)
 *   LEXVIBE_TELEMETRY    "0" | "false" | "off" | "no" para desactivar
 *   DO_NOT_TRACK         "1" | "true" para desactivar (estándar de facto)
 */

const SOURCE = "mcp_stdio";
const VERSION = "0.1.5";
/** Tope de la petición: la analítica nunca debe colgar el proceso. */
const TIMEOUT_MS = 3000;

function isDisabled(): boolean {
  const flag = (process.env.LEXVIBE_TELEMETRY ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return true;
  const dnt = (process.env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt === "1" || dnt === "true") return true;
  return false;
}

/**
 * Endpoint de ingesta. Por defecto la Supabase Edge Function `mcp-events` del
 * proyecto LexVibe, que inserta en `platform_events` con service role. Se puede
 * sobrescribir con LEXVIBE_EVENTS_URL (self-hosting) o dejar que siga a
 * LEXVIBE_API_URL vía `${LEXVIBE_API_URL}/api/events` si se prefiere una ruta web.
 */
const DEFAULT_EVENTS_URL = "https://aqnismuekxchcqgwrlod.supabase.co/functions/v1/mcp-events";

function eventsUrl(): string {
  const explicit = process.env.LEXVIBE_EVENTS_URL?.replace(/\/+$/, "");
  if (explicit) return explicit;
  const api = process.env.LEXVIBE_API_URL?.replace(/\/+$/, "");
  if (api) return `${api}/api/events`;
  return DEFAULT_EVENTS_URL;
}

/** Un app id real de LexVibe es el uuid de la app (`data-lexvibe-app`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * App id real del usuario, si está configurado. Solo se acepta un uuid válido:
 * así se descartan tanto el placeholder `YOUR_APP_ID` como los ejemplos que la
 * documentación usa (`your-app-id`) o cualquier valor inventado, cumpliendo la
 * promesa de enviar el id únicamente cuando es real.
 */
function realAppId(): string | undefined {
  const id = process.env.LEXVIBE_APP_ID?.trim();
  if (!id || !UUID_RE.test(id)) return undefined;
  return id;
}

/**
 * Registra una invocación de herramienta. Fire-and-forget: se llama sin `await`
 * y jamás lanza — cualquier error (red, timeout, opt-out) se traga en silencio,
 * de modo que la analítica nunca afecta al resultado ni a la latencia de la
 * herramienta.
 */
export function trackToolCall(tool: string): void {
  if (isDisabled()) return;

  const appId = realAppId();
  const body = JSON.stringify({
    event: "mcp_tool_call",
    source: SOURCE,
    ...(appId ? { appId } : {}),
    props: { tool, version: VERSION },
  });

  // El controlador aborta la petición si tarda demasiado; el proceso stdio
  // sigue vivo entre llamadas, así que el POST en segundo plano completa bien.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  void fetch(eventsUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: controller.signal,
  })
    .catch(() => {
      /* la analítica nunca debe afectar al usuario */
    })
    .finally(() => clearTimeout(timer));
}
