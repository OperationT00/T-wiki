import { readFile } from "node:fs/promises";

const [manifest, packageJson, versions] = await Promise.all([
  readJson("manifest.json"),
  readJson("package.json"),
  readJson("versions.json")
]);

const errors = [];
if (manifest.version !== packageJson.version) {
  errors.push(`manifest.json (${manifest.version}) 与 package.json (${packageJson.version}) 版本不一致`);
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  errors.push(`versions.json 缺少 ${manifest.version} → ${manifest.minAppVersion}`);
}
if (manifest.author !== "T00") errors.push("manifest.json author 必须为 T00");
if (manifest.id !== "llm-wiki") errors.push("manifest.json id 必须为 llm-wiki");

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : process.argv[2];
if (tag && tag !== manifest.version) {
  errors.push(`Release Tag (${tag}) 必须与 manifest version (${manifest.version}) 完全一致`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Release metadata valid: T-Wiki ${manifest.version}`);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
