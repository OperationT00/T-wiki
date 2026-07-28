import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2] ?? "development";
const production = mode === "production" || mode === "install";
const outDir = mode === "production"
  ? path.resolve("dist")
  : path.resolve(process.env.T_WIKI_DEV_PLUGIN_DIR ?? "../.obsidian/plugins/llm-wiki");
await mkdir(outDir, { recursive: true });

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`)
  ],
  platform: "node",
  target: "es2022",
  format: "cjs",
  define: {
    "import.meta.url": "__filename"
  },
  sourcemap: production ? false : "inline",
  minify: production,
  legalComments: "eof",
  treeShaking: true,
  outfile: path.join(outDir, "main.js"),
  logLevel: "info"
});

await Promise.all([
  copyFile("manifest.json", path.join(outDir, "manifest.json")),
  copyFile("styles.css", path.join(outDir, "styles.css")),
  copyFile("THIRD_PARTY_NOTICES.md", path.join(outDir, "THIRD_PARTY_NOTICES.md")),
  copyFile("LICENSE", path.join(outDir, "LICENSE"))
]);

if (mode !== "development") {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
