import { lookup } from "node:dns/promises";
import net from "node:net";

/*
 * Defensa anti-SSRF — port de apps/web/src/lib/security/ssrf.ts del monorepo.
 *
 * verify_snippet hace fetch desde la máquina del usuario a una URL que puede
 * venir inducida por el propio contexto del agente. Antes de conectar,
 * verificamos que el host resuelve a una IP pública y seguimos las
 * redirecciones a mano, revalidando cada salto. Evita que la herramienta se
 * use para sondear http://169.254.169.254 (metadatos cloud), localhost o
 * rangos internos de la red del usuario.
 */

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 12_000;

/** ¿La IP cae en un rango privado/reservado/no enrutable? */
export function isPrivateIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateIpv4(ip);
  if (type === 6) return isPrivateIpv6(ip);
  return true; // si no es una IP válida, trátala como insegura
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast / reservado
  return false;
}

/** Expande un IPv6 (con `::`, zona, o IPv4 embebida) a sus 16 bytes. */
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // descarta zona (%eth0)

  // IPv4 embebida en notación con puntos al final (::ffff:1.2.3.4).
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = tail.split(".").map(Number);
    if (v4.length !== 4 || v4.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = v4 as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let hextets: string[];
  if (back === null) {
    hextets = head;
    if (hextets.length !== 8) return null;
  } else {
    const missing = 8 - head.length - back.length;
    if (missing < 0) return null;
    hextets = [...head, ...Array(missing).fill("0"), ...back];
  }

  const bytes: number[] = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    const v = parseInt(h, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function isPrivateIpv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // ante la duda, inseguro
  const first = b[0]!;
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if ((first & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (first === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
  // IPv4-mapeada ::ffff:0:0/96 → valida la IPv4 embebida (¡también en hex!)
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  // NAT64 64:ff9b::/96
  if (
    first === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  ) {
    return isPrivateIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  return false;
}

interface Validated {
  url: URL;
  /** Primera IPv4 pública resuelta, para "fijar" la conexión HTTP (anti-rebinding). */
  ipv4: string | null;
}

/** Lanza si la URL no es http(s) pública. Devuelve la URL + IPv4 validada. */
async function assertPublicUrl(rawUrl: string): Promise<Validated> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  // WHATWG URL conserva los corchetes de una IPv6 literal ([::1]) — quítalos
  // para que net.isIP la reconozca y se valide como IP, no como nombre DNS.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Si ya es una IP literal, valídala directamente.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Target not allowed (private or reserved address)");
    return { url, ipv4: net.isIP(host) === 4 ? host : null };
  }
  // Resuelve TODAS las direcciones del host y exige que todas sean públicas.
  const addrs = await lookup(host, { all: true });
  if (addrs.length === 0) throw new Error("Could not resolve the host");
  for (const a of addrs) {
    if (isPrivateIp(a.address))
      throw new Error("Target not allowed (private or reserved address)");
  }
  const ipv4 = addrs.find((a) => a.family === 4)?.address ?? null;
  return { url, ipv4 };
}

/**
 * `fetch` endurecido: valida la URL y cada redirección contra rangos privados.
 * Para HTTP fija la conexión a la IPv4 ya validada (cierra el DNS-rebinding:
 * el host no puede "cambiar" a una IP interna entre validar y conectar). Para
 * HTTPS no hace falta: el rebinding a una IP interna fallaría la validación TLS
 * del certificado del dominio original.
 */
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Response> {
  let current = await assertPublicUrl(rawUrl);

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let fetchUrl = current.url;
    let headers = init?.headers;
    if (current.url.protocol === "http:" && current.ipv4 && !net.isIP(current.url.hostname)) {
      const pinned = new URL(current.url);
      pinned.hostname = current.ipv4; // conecta a la IP validada
      fetchUrl = pinned;
      headers = { ...((init?.headers as Record<string, string>) ?? {}), host: current.url.host };
    }

    const res = await fetch(fetchUrl, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return res;

    const location = res.headers.get("location")!;
    const next = new URL(location, current.url); // resuelve relativas
    current = await assertPublicUrl(next.toString()); // revalida el salto
  }
  throw new Error("Too many redirects");
}

/**
 * Lee el cuerpo como texto con un tope de bytes. Evita agotar memoria con
 * páginas enormes servidas por un destino que no controlamos.
 */
export async function readCapped(res: Response, maxBytes = 3_000_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}
