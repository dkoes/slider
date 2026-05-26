import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = resolve(root, "build");
const jsBuildDir = resolve(root, "build/js");

await rm(buildDir, { recursive: true, force: true });
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
  throw new Error("Could not find tsconfig.json");
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  reportDiagnostics([configFile.error]);
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const emitResult = program.emit();
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

if (diagnostics.length > 0) {
  reportDiagnostics(diagnostics);
}

const [template, css, js, agentSource] = await Promise.all([
  readFile(resolve(root, "src/template.html"), "utf8"),
  readFile(resolve(root, "src/styles.css"), "utf8"),
  readFile(resolve(jsBuildDir, "app.js"), "utf8"),
  readFile(resolve(root, "scripts/slider_agent.py"), "utf8")
]);

const html = template
  .replace("__INLINE_CSS__", () => css.trim())
  .replace("__INLINE_JS__", () => js.trim());
const agent = agentSource.replace(
  "EMBEDDED_SLIDER_HTML = None",
  `EMBEDDED_SLIDER_HTML = ${JSON.stringify(html)}`
);

await writeFile(resolve(buildDir, "slider_agent.py"), agent, "utf8");
console.log("Built build/slider_agent.py");

function reportDiagnostics(diagnostics) {
  const message = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n"
  });
  console.error(message);
  process.exit(1);
}
