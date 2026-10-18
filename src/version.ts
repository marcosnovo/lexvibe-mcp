import { readFileSync } from "node:fs";

/**
 * Versión del paquete, leída de package.json en tiempo de ejecución.
 *
 * Antes estaba copiada a mano en index.ts (serverInfo) y en analytics.ts
 * (telemetría), y la de analytics se quedó en "1.0.0" durante tres versiones:
 * los eventos de la 1.0.3 se atribuían a la 1.0.0. package.json viaja siempre
 * en el tarball de npm y está un nivel por encima tanto de src/ (modo dev)
 * como de dist/ (publicado), así que la misma ruta sirve en ambos casos.
 */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
