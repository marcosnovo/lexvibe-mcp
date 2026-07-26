/*
 * Pruebas de los detectores contra el BUILD (`dist/detect.js`), que es lo que
 * se publica. Cubren los tres casos donde una heurística demasiado suelta
 * producía documentos legales equivocados; los tres se corrigieron a la vez y
 * los tres son fáciles de reintroducir.
 *
 * Requiere `npm run build` antes (lo hace el CI de los dos repos).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { detectLocales, detectPlatforms, classifyAiUsage } = await import(
  join(ROOT, "dist", "detect.js")
);

/** Crea un proyecto de mentira con los ficheros dados (ruta → contenido). */
function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "lexvibe-detect-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("un paquete SwiftPM sin marcadores de iOS no es una app iOS", () => {
  // Un servidor Vapor es un paquete SwiftPM y nada más. Clasificarlo como iOS
  // hacía que make_compliant se saltara el banner de cookies y devolviera
  // instrucciones de la App Store para un servicio que no está en ninguna.
  const found = new Set(["Package.swift"]);
  assert.ok(!detectPlatforms("", found, [], "").includes("ios"));
});

test("un proyecto Xcode moderno sigue detectándose como iOS", () => {
  const found = new Set(["project.pbxproj"]);
  assert.ok(detectPlatforms("", found, [], "").includes("ios"));
});

test("los cualificadores BCP-47 de Android resuelven el idioma", () => {
  // "values-b+es+419" (español de Latinoamérica) no casaba con el extractor y,
  // si hubiera casado, el separador daba "b": la app no reportaba español y se
  // quedaba sin sus documentos en español.
  assert.deepEqual(detectLocales("", ["app/src/main/res/values-b+es+419/strings.xml"]), ["es"]);
  assert.deepEqual(detectLocales("", ["app/src/main/res/values-fr/strings.xml"]), ["fr"]);
});

test("no se trunca un código de 3 letras a otro idioma", () => {
  // "fil" (filipino) truncado a dos daba "fi" (finés): documentos en el idioma
  // equivocado. No está entre los soportados, así que lo correcto es no
  // devolver nada, nunca finés.
  assert.deepEqual(detectLocales("", ["app/src/main/res/values-fil/strings.xml"]), []);
});

test("IA en un servidor Swift no se cuenta como de cara al usuario", () => {
  const dir = project({
    "Package.swift": "// swift-tools-version:5.9",
    "Sources/App/OpenAIService.swift": 'let key = ProcessInfo.processInfo.environment["OPENAI_API_KEY"]',
  });
  const { mode } = classifyAiUsage(
    dir,
    ["Package.swift", "Sources/App/OpenAIService.swift"],
    true,
  );
  assert.equal(mode, "backend");
});

test("IA en la fuente de una app nativa SÍ es de cara al usuario", () => {
  // El caso frecuente y el que más importa: una app Flutter que llama a la IA
  // desde su propio código. Perder esto quita el aviso obligatorio del art. 50.
  const dir = project({
    "pubspec.yaml": "name: myapp",
    "lib/services/assistant_backend.dart": 'const url = "https://api.openai.com/v1";',
  });
  const { mode } = classifyAiUsage(
    dir,
    ["pubspec.yaml", "lib/services/assistant_backend.dart"],
    true,
  );
  assert.equal(mode, "user");
});

test("un handler de API que implementa el chat es de cara al usuario", () => {
  // app/api/chat/route.ts vive bajo api/ pero ES el chatbot: con la regla
  // anterior (backend gana) cualquier chatbot de Next.js perdía el art. 50.
  const dir = project({
    "app/api/chat/route.ts": 'import OpenAI from "openai";',
  });
  const { mode } = classifyAiUsage(dir, ["app/api/chat/route.ts"], true);
  assert.equal(mode, "user");
});

test("IA solo en una ruta de backend genérica se queda en servidor", () => {
  const dir = project({
    "app/api/moderate/route.ts": 'import OpenAI from "openai";',
  });
  const { mode } = classifyAiUsage(dir, ["app/api/moderate/route.ts"], true);
  assert.equal(mode, "backend");
});
