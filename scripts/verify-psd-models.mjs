import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { initializeCanvas, readPsd } from "ag-psd";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(projectRoot, "public/models/manifest.json"), "utf8"));
const riggerSource = readFileSync(join(projectRoot, "public/vendor/anime2dr/rigger.js"), "utf8");
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(riggerSource, sandbox, { filename: "rigger.js" });
const Rigger = sandbox.module.exports;

initializeCanvas(
  () => { throw new Error("PSD 校验不应创建 Canvas"); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
);

function makeClosedEye() {
  const width = 128;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    const u = x / (width - 1);
    const y = Math.round(7.2 + 1.6 * Math.pow((u - 0.5) * 2, 2));
    const alpha = Math.round(255 * Math.min(1, u / 0.09, (1 - u) / 0.09));
    for (let offset = -1; offset <= 1; offset++) {
      const index = ((y + offset) * width + x) * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = alpha;
    }
  }
  return { width, height, data };
}

const genericEye = makeClosedEye();
let failed = false;

for (const file of manifest.files) {
  try {
    const bytes = readFileSync(join(projectRoot, "public/models", file));
    let psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
    Rigger.cleanPsdLayers(psd);
    let rig = Rigger.buildRig(psd, { generic: { eyeL: genericEye, eyeR: genericEye } });

    if (!rig.layers?.length) throw new Error("没有生成渲染部件");
    if (!rig.anchors?.face || !rig.anchors?.eyeL || !rig.anchors?.eyeR) {
      throw new Error("脸部或左右眼锚点不完整");
    }
    const mouthLayers = rig.layers.filter((layer) => Rigger.baseName(layer.name) === "mouth");
    if (mouthLayers.length !== 1) throw new Error(`可见静态嘴图层应为 1 个，实际为 ${mouthLayers.length}`);
    if (!rig.layers.some((layer) => layer.name.startsWith("eye_close_l")) ||
        !rig.layers.some((layer) => layer.name.startsWith("eye_close_r"))) {
      throw new Error("闭眼素材或通用闭眼回退不完整");
    }
    const seriousWarnings = (rig.warnings ?? []).filter((warning) =>
      warning.includes("未知图层名") || warning.includes("锚点不完整") || warning.includes("拆分失败"));
    if (seriousWarnings.length) throw new Error(seriousWarnings.join("；"));

    console.log(`[OK] ${file}: ${rig.layers.length} 部件，${mouthLayers.length} 个静态嘴图层`);
    for (const warning of rig.warnings ?? []) console.log(`     提示：${warning}`);
    psd = null;
    rig = null;
    global.gc?.();
  } catch (error) {
    failed = true;
    console.error(`[FAIL] ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) process.exit(1);
