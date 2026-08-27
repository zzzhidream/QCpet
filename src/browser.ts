import { idleDriver, type PetDriver } from "./live2d/PetDriver";
import { Rigged2DView } from "./live2d/psd/Rigged2DView";

interface PsdManifest {
  type?: string;
  file?: string;
  files?: string[];
}

const stage = document.getElementById("browser-stage") as HTMLElement;
const builtinSelect = document.getElementById("builtin-model") as HTMLSelectElement;
const loadBuiltinButton = document.getElementById("load-builtin") as HTMLButtonElement;
const localInput = document.getElementById("local-psd") as HTMLInputElement;
const toggleMotionButton = document.getElementById("toggle-motion") as HTMLButtonElement;
const loading = document.getElementById("loading") as HTMLElement;
const modelName = document.getElementById("model-name") as HTMLElement;
const modelStats = document.getElementById("model-stats") as HTMLElement;
const modelStatus = document.getElementById("model-status") as HTMLElement;
const modelWarnings = document.getElementById("model-warnings") as HTMLUListElement;

let view: Rigged2DView | null = null;
let motionEnabled = true;
let lastFrame = performance.now();
let lastPointer = { x: 0, y: 0, at: performance.now() };
const driver: PetDriver = idleDriver();

function showLoading(message: string) {
  loading.textContent = message;
  loading.classList.remove("hidden");
  modelStatus.textContent = message;
}

function hideLoading() {
  loading.classList.add("hidden");
}

function friendlyName(file: string): string {
  const name = file.replace(/\.psd$/i, "").replace(/[-_]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function showWarnings(warnings: string[]) {
  modelWarnings.replaceChildren();
  for (const warning of warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    modelWarnings.appendChild(item);
  }
}

async function displayPsd(name: string, bytes: Uint8Array) {
  showLoading(`正在解析 ${name}…`);
  view?.unmount();
  view = null;
  const next = await Rigged2DView.create(bytes);
  next.setScale(900);
  next.setSwayEnabled(false);
  next.attachTo(stage, null as never);
  next.update(driver, 1 / 60);

  view = next;

  modelName.textContent = name;
  modelStats.textContent = next.stats;
  modelStatus.textContent = "加载成功；嘴部应保持 PSD 可见图层的静态形状";
  showWarnings(next.warnings);
  hideLoading();
}

async function loadBuiltin(file: string) {
  if (!file) return;
  try {
    showLoading(`正在下载 ${file}…`);
    const response = await fetch(`/models/${encodeURIComponent(file)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await displayPsd(file, new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    hideLoading();
    modelStatus.textContent = `${file} 加载失败：${String(error)}`;
    console.error(error);
  }
}

async function loadManifest() {
  try {
    const response = await fetch("/models/manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json() as PsdManifest;
    const files = manifest.files?.length ? manifest.files : manifest.file ? [manifest.file] : [];
    if (!files.length) throw new Error("清单中没有 PSD 模型");

    builtinSelect.replaceChildren(...files.map((file) => {
      const option = document.createElement("option");
      option.value = file;
      option.textContent = friendlyName(file);
      return option;
    }));
    builtinSelect.value = manifest.file && files.includes(manifest.file) ? manifest.file : files[0];
    await loadBuiltin(builtinSelect.value);
  } catch (error) {
    hideLoading();
    modelStatus.textContent = `模型清单加载失败：${String(error)}`;
    console.error(error);
  }
}

loadBuiltinButton.addEventListener("click", () => void loadBuiltin(builtinSelect.value));
builtinSelect.addEventListener("change", () => void loadBuiltin(builtinSelect.value));

localInput.addEventListener("change", () => {
  const file = localInput.files?.[0];
  if (!file) return;
  void file.arrayBuffer()
    .then((buffer) => displayPsd(file.name, new Uint8Array(buffer)))
    .catch((error) => {
      hideLoading();
      modelStatus.textContent = `${file.name} 加载失败：${String(error)}`;
      console.error(error);
    });
  localInput.value = "";
});

toggleMotionButton.addEventListener("click", () => {
  motionEnabled = !motionEnabled;
  toggleMotionButton.textContent = motionEnabled ? "暂停动作" : "继续动作";
  modelStatus.textContent = motionEnabled
    ? "动作已恢复；观察嘴形是否始终不变"
    : "动作已暂停；可与 PSD 原图逐像素观察";
});

stage.addEventListener("pointermove", (event) => {
  const rect = stage.getBoundingClientRect();
  const now = performance.now();
  const dt = Math.max(1, now - lastPointer.at) / 1000;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  driver.cursorDx = Math.max(-1, Math.min(1, (x / rect.width - 0.5) * 2));
  driver.cursorDy = Math.max(-1, Math.min(1, (y / rect.height - 0.5) * 2));
  driver.cursorSpeed = Math.hypot(x - lastPointer.x, y - lastPointer.y) / dt;
  lastPointer = { x, y, at: now };
});

function animate(now: number) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  if (view && motionEnabled) {
    driver.breathing = (driver.breathing + dt * 1.6) % (Math.PI * 2);
    driver.cursorSpeed *= Math.exp(-dt * 7);
    view.update(driver, dt);
  }
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
void loadManifest();
