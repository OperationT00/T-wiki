import { readFile } from "node:fs/promises";

const [manifest, packageJson, versions] = await Promise.all([
  readJson("manifest.json"),
  readJson("package.json"),
  readJson("versions.json")
]);

const errors = [];
if (manifest.version !== packageJson.version) {
  errors.push(`manifest.json (${manifest.version}) and package.json (${packageJson.version}) versions differ`);
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  errors.push(`versions.json is missing ${manifest.version} -> ${manifest.minAppVersion}`);
}
if (manifest.author !== "T00") errors.push("manifest.json author must be T00");
if (manifest.id !== "t-wiki") errors.push("manifest.json id must be t-wiki");

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : process.argv[2];
if (tag && tag !== manifest.version) {
  errors.push(`Release tag (${tag}) must exactly match manifest version (${manifest.version})`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Release metadata valid: T-Wiki ${manifest.version}`);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
