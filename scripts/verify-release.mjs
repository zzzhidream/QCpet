import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), "utf8"));
}

function normalizedText(relativePath) {
  return readFileSync(join(projectRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const manifest = readJson("public/models/manifest.json");
const cargoToml = normalizedText("src-tauri/Cargo.toml");
const cargoVersion = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLock = normalizedText("src-tauri/Cargo.lock");
const cargoLockVersion = cargoLock.match(/^name = "qcpet"\nversion = "([^"]+)"/m)?.[1];
const version = packageJson.version;

const versions = new Map([
  ["package-lock.json", packageLock.version],
  ["package-lock.json 根包", packageLock.packages?.[""]?.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoVersion],
  ["src-tauri/Cargo.lock 中的 qcpet", cargoLockVersion],
]);
for (const [source, candidate] of versions) {
  if (candidate !== version) fail(`${source} 的版本 ${candidate ?? "<缺失>"} 与 package.json ${version} 不一致`);
}

if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${version}`) {
  fail(`Git 标签 ${process.env.GITHUB_REF_NAME} 与项目版本 v${version} 不一致`);
}

if (manifest.type !== "psd") fail("模型清单 type 必须为 psd");
if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("模型清单 files 不能为空");

const modelFiles = Array.isArray(manifest.files) ? manifest.files : [];
if (!modelFiles.includes(manifest.file)) fail(`默认模型 ${manifest.file ?? "<缺失>"} 不在 files 中`);
if (new Set(modelFiles).size !== modelFiles.length) fail("模型清单包含重复文件名");

const forbiddenModelPattern = /(chisa|mika)/i;
let trackedFiles = [];
const gitFiles = spawnSync("git", ["ls-files"], { cwd: projectRoot, encoding: "utf8" });
if (gitFiles.status === 0 && gitFiles.stdout) {
  trackedFiles = gitFiles.stdout
    .split(/\r?\n/)
    .filter(Boolean);
} else {
  fail("无法读取 Git 跟踪文件列表");
}
const trackedSet = new Set(trackedFiles);
for (const tracked of trackedFiles) {
  if (/(^|\/)(chisa|qcpet_chisa)(\/|\.|$)/i.test(tracked)) {
    fail(`Git 中不得包含 Chisa 私有文件：${tracked}`);
  }
}
for (const file of modelFiles) {
  if (typeof file !== "string" || basename(file) !== file || !file.toLowerCase().endsWith(".psd")) {
    fail(`模型文件名不安全或不是 PSD：${String(file)}`);
    continue;
  }
  if (forbiddenModelPattern.test(file)) fail(`发行清单不得包含私有或已移除模型：${file}`);
  if (!trackedSet.has(`public/models/${file}`)) fail(`模型尚未加入 Git：${file}`);
  const modelPath = join(projectRoot, "public/models", file);
  try {
    if (statSync(modelPath).size < 1024) fail(`模型文件为空或异常小：${file}`);
  } catch {
    fail(`模型文件不存在：${file}`);
  }
}

const diskModels = readdirSync(join(projectRoot, "public/models"))
  .filter((file) => file.toLowerCase().endsWith(".psd"))
  .sort();
const listedModels = [...modelFiles].sort();
if (JSON.stringify(diskModels) !== JSON.stringify(listedModels)) {
  fail(`public/models 与清单不一致：磁盘=${diskModels.join(", ")}；清单=${listedModels.join(", ")}`);
}

const resources = tauriConfig.bundle?.resources ?? [];
for (const file of ["manifest.json", ...modelFiles]) {
  const expected = `../public/models/${file}`;
  if (!resources.includes(expected)) fail(`Tauri resources 缺少 ${expected}`);
}

if (normalizedText("public/vendor/anime2dr/rigger.js") !== normalizedText("src/vendor/anime2dr/rigger.js")) {
  fail("public 与 src 中的 rigger.js 不一致");
}
if (normalizedText("public/vendor/anime2dr/genericparts.js") !== normalizedText("src/vendor/anime2dr/genericparts.js")) {
  fail("public 与 src 中的 genericparts.js 不一致");
}

for (const required of [
  "README.md",
  "LICENSE",
  "index.html",
  "browser.html",
  "public/vendor/anime2dr/genericparts.js",
  "src/vendor/anime2dr/genericparts.js",
]) {
  try {
    if (!statSync(join(projectRoot, required)).isFile()) fail(`发行所需文件不是普通文件：${required}`);
  } catch {
    fail(`发行所需文件不存在：${required}`);
  }
  if (!trackedSet.has(required)) fail(`发行所需文件尚未加入 Git：${required}`);
}

if (failures.length > 0) {
  console.error("[FAIL] QCpet 发布前检查未通过：");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`[OK] QCpet v${version} 发布前检查通过`);
console.log(`[OK] 内置模型：${modelFiles.join(", ")}`);
