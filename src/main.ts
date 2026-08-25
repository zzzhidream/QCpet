import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { AudioAnalyzer } from "./audio/AudioAnalyzer";
import { BehaviorEngine } from "./autonomous/BehaviorEngine";
import { idleDriver, type PetDriver, type PetView } from "./live2d/PetDriver";
import { Rigged2DView } from "./live2d/psd/Rigged2DView";
import { setupTrashDrop } from "./features/trash/TrashHandler";
import { setupContextMenu } from "./ui/ContextMenu";
import { toast } from "./ui/Toast";
import { clamp } from "./utils/math";
import { loadSettings, saveSettings, type Settings, type AssistantProvider } from "./utils/settings";
import { astrobotOn } from "./bridges/astrobot";
import { openAssistant, setAssistantEmotionListener } from "./assistant/AssistantPanel";
import { setLifecycle, triggerProactive, closeAssistant, clearBubbles, clearApiKeyCache, clearHistory, isAssistantOpen } from "./assistant/AssistantPanel";
import { listModels } from "./assistant/AssistantClient";
import { EMOTION_DURATIONS_MS, type PetEmotion } from "./live2d/emotions";
import { setupReminder } from "./ui/ReminderPanel";
import {
  logicalRectToPhysicalRegion,
  regionFingerprint,
  type LogicalRect,
  type PhysicalInteractiveRegion,
} from "./input/regions";


// ---------- 性能优化工具函数 ----------
/** 防抖函数：在指定时间内多次调用只执行最后一次 */
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: number | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      func(...args);
      timeout = null;
    }, wait);
  };
}

/** 节流函数：在指定时间内最多执行一次 */
function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => { inThrottle = false; }, limit);
    }
  };
}

// 优化后的IPC调用
const setInteractingDebounced = debounce((active: boolean) => {
  invoke("set_interacting", { active }).catch(() => {});
}, 50);

const setModelBoundsThrottled = throttle((bounds: {
  left: number; top: number; right: number; bottom: number;
}) => {
  invoke("set_model_bounds", bounds).catch(() => {});
}, 100);// 禁用页面滚动（桌宠窗口内容不应滚动）
document.documentElement.style.overflow = "hidden";
document.body.style.overflow = "hidden";

const WIN = 700;


// ---------- 待办提醒：模型头顶大气泡 + 提示音 ----------
/** 播放提示音（两个短哔声，Web Audio 生成） */
function playReminderSound() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = i === 0 ? 880 : 660;
      const gain = ctx.createGain();
      const start = t + i * 0.25;
      gain.gain.setValueAtTime(0.35, start);
      gain.gain.exponentialRampToValueAtTime(0.01, start + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    }
    setTimeout(() => ctx.close(), 1500);
  } catch { /* 忽略 */ }
}

/** 模型头顶大 toast（2 秒消失） */
function showBigReminder(text: string) {
  const el = document.createElement("div");
  el.className = "big-toast";
  el.textContent = text;
  document.body.appendChild(el);
  // 定位：模型顶部上方居中
  const mr = getModelRect();
  el.style.left = `${Math.round(mr.left + mr.width / 2)}px`;
  el.style.bottom = `${Math.round(window.innerHeight - mr.top + 14)}px`;
  el.style.transform = "translateX(-50%)";
  // 2 秒消失
  setTimeout(() => {
    el.classList.add("bye");
    setTimeout(() => el.remove(), 300);
  }, 2000);
  playReminderSound();
}

// 待办到期 → 大气泡 + 提示音
document.addEventListener("reminder-due", ((e: CustomEvent) => {
  showBigReminder((e.detail as any).text ?? "提醒时间到！");
}) as EventListener);

// 交互时间常量（ms）
const DRAG_SUSPEND_MS = 30000; // 拖拽暂停自主漫游时长
const IDLE_AFTER_DRAG_MS = 1500; // 拖拽后恢复漫游的休息时长
const FIRST_ROAM_DELAY = 5000; // 首次漫游延迟
const PSD_KEY = "live2d-pet-psd";
const BUILTIN_KEY = "live2d-pet-builtin-model"; // 当前选中的内置模型（manifest files 内）

import * as PIXI from "pixi.js";

class PIXIApp {
  readonly app: PIXI.Application;
  constructor() {
    this.app = new PIXI.Application({
      width: WIN,
      height: WIN,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      powerPreference: "high-performance",
    });
    document.getElementById("stage")!.appendChild(this.app.view as unknown as Node);
  }
}

const app = new PIXIApp();
let view!: PetView;
let settings: Settings = loadSettings();
let engine!: BehaviorEngine;
let activeAssistantEmotion: PetEmotion = "neutral";
let assistantEmotionUntil = 0;
let scaleFactor = 1; // 物理↔逻辑坐标转换（系统缩放）
let winSize = WIN; // 当前窗口边长（模型缩放时跟随，默认 300）
// 交互模式：左键摸头后进入"不穿透"，再次摸头恢复自动穿透
// 当前实际模型来源（面板高亮用）
let currentModel: { type: "import" | "manifest" | "live2d"; name?: string } = {
  type: "manifest",
  name: "",
};

function activateAssistantEmotion(emotion: PetEmotion) {
  activeAssistantEmotion = emotion;
  assistantEmotionUntil = emotion === "neutral"
    ? 0
    : performance.now() + EMOTION_DURATIONS_MS[emotion];
}

setAssistantEmotionListener(activateAssistantEmotion);
function attachView(v: PetView) {
  const stage = document.getElementById("stage")!;
  v.attachTo(stage, app.app.stage);
}

/** 应用模型缩放：窗口固定 700x700，模型显示大小按基准 300px 缩放 */
async function applyModelScale(s: number, record = false) {
  const clamped = clamp(s, 0.2, 2.0);
  settings.modelScale = clamped;
  // 用户调整时按模型记录（切换模型时恢复各自大小）
  if (record) {
    const key = currentModel.name ?? "";
    if (key) settings.modelScales[key] = clamped;
  }
  saveSettings(settings);
  const modelW = Math.round(300 * clamped); // 模型视觉大小以 300 为基准
  winSize = WIN; // 窗口始终 700x700
  engine.setWindowSize(WIN);
  view.setScale(modelW);
}

/** 检查鼠标事件是否在模型区域内，不是则忽略 */
function isInsideModel(e: { clientX: number; clientY: number }): boolean {
  const r = getModelRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

/** 获取模型在窗口中的矩形（不依赖 DOM，始终可用） */
function getModelRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const cb = view.getCharacterBounds?.();
  if (!cb) return { left: 200, top: 200, right: 500, bottom: 500, width: 300, height: 300 };
  const ox = engine.modelOffset.x;
  const oy = engine.modelOffset.y;
  return {
    left: ox + cb.left,
    top: oy + cb.top,
    right: ox + cb.right,
    bottom: oy + cb.bottom,
    width: cb.right - cb.left,
    height: cb.bottom - cb.top,
  };
}

/** 窗口在屏幕工作区内的可见区域（窗口本地坐标），供菜单/面板往屏幕内侧定位 */
function getWindowVisibleRect(): { left: number; top: number; right: number; bottom: number } {
  const a = engine.workArea;
  const wx = engine.windowScreenPos.x;
  const wy = engine.windowScreenPos.y;
  if (!a) return { left: 0, top: 0, right: winSize, bottom: winSize };
  return {
    left: Math.max(0, a.left - wx),
    top: Math.max(0, a.top - wy),
    right: Math.min(winSize, a.left + a.width - wx),
    bottom: Math.min(winSize, a.top + a.height - wy),
  };
}

/** 将面板定位到模型旁边：往屏幕内侧（空间大的方向），不挡住模型、不出屏 */
function positionPanelNearModel(panel: HTMLElement) {
  panel.style.position = "fixed"; // 确保 fixed 定位
  const mr = getModelRect();
  const vr = getWindowVisibleRect();
  // 先让面板按自身内容撑开
  panel.style.maxWidth = `${vr.right - vr.left - 40}px`;
  panel.style.maxHeight = `${vr.bottom - vr.top - 40}px`;
  let pw = panel.offsetWidth || 230;
  let ph = panel.offsetHeight || 200;
  // 面板比可见区大则缩小
  const maxW = vr.right - vr.left - 40;
  const maxH = vr.bottom - vr.top - 40;
  if (pw > maxW || ph > maxH) {
    panel.style.maxWidth = `${maxW}px`;
    panel.style.maxHeight = `${maxH}px`;
    pw = Math.min(pw, maxW);
    ph = Math.min(ph, maxH);
  }

  // 屏幕中心（逻辑坐标）
  const a = engine.workArea;
  const screenCx = a ? a.left + a.width / 2 : window.innerWidth / 2;
  const screenCy = a ? a.top + a.height / 2 : window.innerHeight / 2;
  // 窗口中心（屏幕坐标）
  const winCx = engine.windowScreenPos.x + winSize / 2;
  const winCy = engine.windowScreenPos.y + winSize / 2;
  // 屏幕内侧：窗口在左半 → 往右；右半 → 往左；上半 → 往下；下半 → 往上
  const preferRight = winCx <= screenCx;
  const preferBottom = winCy <= screenCy;

  // 候选位置按屏幕内侧优先排序
  const candidates: { left: number; top: number }[] = [];
  const hor = preferRight
    ? [
        { left: mr.right + 10, top: mr.top },
        { left: mr.left - pw - 10, top: mr.top },
      ]
    : [
        { left: mr.left - pw - 10, top: mr.top },
        { left: mr.right + 10, top: mr.top },
      ];
  const ver = preferBottom
    ? [
        { left: mr.left + (mr.width - pw) / 2, top: mr.bottom + 10 },
        { left: mr.left + (mr.width - pw) / 2, top: mr.top - ph - 10 },
      ]
    : [
        { left: mr.left + (mr.width - pw) / 2, top: mr.top - ph - 10 },
        { left: mr.left + (mr.width - pw) / 2, top: mr.bottom + 10 },
      ];
  candidates.push(...hor, ...ver);

  // 选第一个完整落在可见区内的位置
  for (const c of candidates) {
    const l = Math.round(c.left);
    const t = Math.round(c.top);
    if (l >= vr.left && l + pw <= vr.right && t >= vr.top && t + ph <= vr.bottom) {
      panel.style.left = `${l}px`;
      panel.style.top = `${t}px`;
      panel.style.bottom = "auto";
      panel.style.transform = "none";
      return;
    }
  }

  // 兜底：clamp 到可见区
  const left = Math.max(vr.left, Math.min(preferRight ? mr.right + 10 : mr.left - pw - 10, vr.right - pw));
  const top = Math.max(vr.top, Math.min(preferBottom ? mr.bottom + 10 : mr.top - ph - 10, vr.bottom - ph));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.bottom = "auto";
  panel.style.transform = "none";
}

/** 将通知定位到模型头顶（不挡住模型） */
function positionAboveModel(el: HTMLElement) {
  const mr = getModelRect();
  el.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
  el.style.bottom = `${Math.round(window.innerHeight - mr.top + 10)}px`;
  el.style.top = "auto";
  el.style.transform = "translateX(-50%)";
}

/** 换模型后重置边界到默认（view 可能还没初始化，安全检查） */
function resetBoundsOnModelSwitch() {
  settings.boundsPadding = { left: 0, right: 0, top: 0, bottom: 0 };
  saveSettings(settings);
  if (view) (view as any).setBoundsPadding?.(settings.boundsPadding);
}

async function makePsdView(bytes: Uint8Array, _name: string): Promise<Rigged2DView> {
  const v = await Rigged2DView.create(bytes);
  if (v.warnings.length > 0) console.warn("[PSD 自动装配提示]", ...v.warnings);
  return v;
}

function asUint8Array(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value);
}

async function createView(): Promise<PetView> {
  // 1) 已导入的 PSD（数据目录）
  const imported = localStorage.getItem(PSD_KEY);
  if (imported) {
    try {
      const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>("read_psd", { name: imported });
      currentModel = { type: "import", name: imported };
      return await makePsdView(asUint8Array(bytes), imported);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[模型切换] 导入 PSD "${imported}" 加载失败：`, err);
      toast(`模型 "${imported}" 加载失败，已回退内置：${msg}`, "warn");
      localStorage.removeItem(PSD_KEY);
    }
  }
  // 2) 打包的 PSD 模型（public/models/<file>）
  try {
    const m = await invoke<string>("read_model_manifest")
      .then((s) => JSON.parse(s as string))
      .catch(() => null);
    if (m?.type === "psd" && m.file) {
      // 默认模型：优先用用户上次选择的内置模型（须在 files 列表内）
      const saved = localStorage.getItem(BUILTIN_KEY);
      const file = saved && Array.isArray(m.files) && m.files.includes(saved) ? saved : m.file;
      try {
        // 统一走 Rust 命令读取（dev/release 都通过 exe/resource 目录找文件）
        const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>("read_builtin_psd", { name: file });
        currentModel = { type: "manifest", name: file };
        resetBoundsOnModelSwitch();
        return await makePsdView(asUint8Array(bytes), file);
      } catch (err) {
        console.error(`内置模型 ${file} 加载失败:`, err);
      }
    }
    if (m?.active) {
      // 动态 import：pixi-live2d-display 有模块级 runtime 检查，隔离避免拖垮主链
      const { Live2DController } = await import("./live2d/Live2DController");
      const v = await Live2DController.create();
      if (v) {
        currentModel = { type: "live2d", name: m.active };
        return v;
      }
    }
  } catch {
    /* 无 manifest 或不是 PSD 模式 */
  }
  // 3) 标准 Live2D（model3.json）
  try {
    const { Live2DController } = await import("./live2d/Live2DController");
    const l2d = await Live2DController.create();
    if (l2d) {
      currentModel = { type: "live2d", name: "model3" };
      return l2d;
    }
  } catch (err) {
    console.error(`live2d 加载失败: ${err}`);
  }
  // 默认模型（deepseek.psd）加载失败：不允许回退占位，直接抛错
  throw new Error("模型加载失败（manifest 未配置或 deepseek.psd 缺失）");
}

async function importPsdBytes(name: string, bytes: Uint8Array) {
  try {
    const saved = await invoke<string>("save_psd", { name, bytes });
    localStorage.setItem(PSD_KEY, saved);
    resetBoundsOnModelSwitch();
    await reloadView();
  } catch (err) {
    toast(`导入失败：${err}`, "warn");
  }
}

async function importPsdFromPath(path: string) {
  try {
    const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>("read_file_bytes", { path });
    const name = path.split(/[\\/]/).pop() ?? "model.psd";
    await importPsdBytes(name, asUint8Array(bytes));
  } catch (err) {
    toast(`读取失败：${err}`, "warn");
  }
}

async function mountView() {
  view = await createView();
  view.setSwayEnabled(settings.audioEnabled);
  (view as any).setBoundsPadding?.(settings.boundsPadding);
  attachView(view);
}

async function reloadView() {
  view.unmount();
  await mountView();
  // 切换模型：恢复该模型自己的大小（无记录用默认 100%）
  const key = currentModel.name ?? "";
  const scale = settings.modelScales[key] ?? 1;
  void applyModelScale(scale, false);
}

async function boot() {
  try {
    await mountView();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast(`模型加载失败：${msg}`, "warn");
    return;
  }

  // 同步 Rust 侧音频开关到持久化设置
  void invoke("set_audio_enabled", { enabled: settings.audioEnabled });

  const win = getCurrentWindow();
  scaleFactor = await win.scaleFactor().catch(() => 1);
  void win.onScaleChanged(({ payload }) => {
    scaleFactor = payload.scaleFactor;
    engine?.setScale(scaleFactor);
    requestInteractionRegionSync(true);
  });
  window.addEventListener("resize", () => requestInteractionRegionSync(true));
  const pos = await currentLogicalPos(win);

  engine = new BehaviorEngine(pos);
  engine.setScale(scaleFactor);
  engine.setActivityLevel(settings.activity);
  // 精简版不再提供逗猫棒/待机入口，清理旧版本遗留的开启状态。
  if (settings.mouseTrack || settings.idleMode) {
    settings.mouseTrack = false;
    settings.idleMode = false;
    saveSettings(settings);
  }
  engine.setTracking(false);
  // 应用持久化模型缩放（窗口尺寸 + canvas + 引擎窗口边长）
  void applyModelScale(settings.modelScale);
  // 小助手对话期间桌宠静止，关闭后恢复漫游
  setLifecycle(
    () => engine.suspend(Number.POSITIVE_INFINITY),
    () => engine.suspend(IDLE_AFTER_DRAG_MS),
  );
  // 延迟首次漫游（low 档完全静止，不触发首次移动）
  if (settings.activity !== "low") {
    setTimeout(() => void engine.teleportRandom(), FIRST_ROAM_DELAY);
  }

  // 小助手主动问候：每 20 分钟，若开启且空闲则智能打招呼（识别当前窗口）
  // 主动问候：场景触发（替代固定 20 分钟）
  let lastGreetAt = 0;
  let activeStartAt = Date.now();   // 当前连续活跃段的起始时间
  let lastActiveAt = Date.now();    // 最近一次检测到用户活跃的时间
  let wasIdle = false;              // 上次检查时是否处于空闲

  // 每 5 分钟检查一次场景
  setInterval(async () => {
    if (!settings.assistant.enabled) return;
    let idleSec = 0;
    try { idleSec = await invoke<number>("get_idle_seconds"); } catch {}

    const now = Date.now();
    const isIdle = idleSec > 3600; // 空闲超过 5 分钟才算"离开"

    if (isIdle) {
      // 用户离开了
      if (!wasIdle) {
        // 刚离开，记录
        wasIdle = true;
      }
    } else {
      // 用户活跃
      if (wasIdle) {
        // 从离开状态回来 → 重置活跃段
        activeStartAt = now;
        wasIdle = false;
        // 回归问候：离开超过 15 分钟才触发
        const awayMs = now - lastActiveAt;
        if (awayMs > 15 * 60 * 1000 && now - lastGreetAt > 15 * 60 * 1000) {
          lastGreetAt = now;
          void triggerProactive();
          return;
        }
      }
      lastActiveAt = now;
    }

    const sinceGreet = now - lastGreetAt;
    const activeMs = now - activeStartAt; // 连续活跃时长
    const hour = new Date().getHours();

    // 久坐提醒：连续活跃超过 90 分钟且没离开过
    if (activeMs > 90 * 60 * 1000 && sinceGreet > 60 * 60 * 1000 && !wasIdle) {
      lastGreetAt = now;
      void triggerProactive();
      return;
    }

    // 深夜关怀
    if ((hour >= 23 || hour < 2) && sinceGreet > 30 * 60 * 1000) {
      lastGreetAt = now;
      void triggerProactive();
      return;
    }

    // 早晨首次
    if (hour >= 6 && hour < 10 && lastGreetAt === 0) {
      lastGreetAt = now;
      void triggerProactive();
      return;
    }

    // 兜底
    if (sinceGreet > 60 * 60 * 1000) {
      lastGreetAt = now;
      void triggerProactive();
    }
  }, 5 * 60 * 1000);

  // 光标/工作区轮询：独立定时器，避免渲染热路径 await IPC
  setInterval(() => void engine.pollCursor(), 60);
  setInterval(() => void engine.pollArea(), 2500);

  // ---------- 音频 ----------
  const analyzer = new AudioAnalyzer();
  const startAudio = async () => {
    if (!settings.audioEnabled) return;
    try {
      await analyzer.start();
    } catch (err) {
      /* 忽略 */
    }
    await analyzer.ctx.resume().catch(() => {});
  };
  listen<string | object>("audio:error", (e) => {
    toast(`音频走丢了：${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}`, "warn");
    toggleAudio(false);
  });
  void startAudio();

  // ---------- 交互 ----------
  setupTrashDrop(() => view, win, (path) => void importPsdFromPath(path));
  setupReminder();

  setupContextMenu(
    () => buildMenu(),
    () => requestInteractionRegionSync(true),
    () => getWindowVisibleRect(),
    (x: number, y: number) => isInsideModel({ clientX: x, clientY: y }),
    () => getModelRect(),
  );
  startInteractionRegionSync();

  // 左键：按住可拖动桌宠；轻点（<6px 未拖）算"摸头"反应或打开小助手。
  // 非待机：拖动走 Rust 原生跟随线程（GetCursorPos → SetWindowPos，8ms，零每帧 IPC）。
  // 待机中：拖动沿边缘水平滑动（Rust 锁 y 跟随，只移动待机位置，不退出；退出仅靠右键菜单）。
  let drag: { sx: number; sy: number; wx: number; wy: number; moved: boolean; mode: "idleSlide" | "free" } | null = null;
  let nativeDragStart: Promise<unknown> | null = null;
  let uiPointerLocked = false;
  let dragLastMove = 0;
  document.addEventListener("pointerdown", (e) => {
    void analyzer.ctx.resume();
    if (e.button !== 0) return;
    // UI 按压期间也临时锁定，保证 slider/scroll/pointer capture 越出 rect 后不中断。
    if ((e.target as HTMLElement).closest?.("#menu, .model-panel, #info-panel, #update-bubble, #as-inputbar, #as-bubbles, .rm-modal-box, [data-qcpet-interactive]")) {
      uiPointerLocked = true;
      setInteractingDebounced(true);
      return;
    }
    // 绿框外区域不响应（穿透到下层）
    if (!isInsideModel(e)) return;
    // 按下宠物后锁住输入，直到 pointerup/cancel/blur；拖出原 petRect 也不会中断。
    setInteractingDebounced(true);
    const p = engine.position;
      drag = { sx: e.clientX, sy: e.clientY, wx: p.x, wy: p.y, moved: false, mode: "free" };
    engine.suspend(DRAG_SUSPEND_MS);
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      if (settings.idleMode) {
        // 待机中：直接定位窗口（不用 Rust drag follower，避免边界夹紧干扰待机位置）
        drag.mode = "idleSlide";
      } else {
        drag.mode = "free";
        // 一次性启动 Rust 原生拖动（此后窗口由 8ms 线程直接跟随鼠标）
        nativeDragStart = invoke("drag_start", {}).catch(() => {});
      }
    }
    const now = performance.now();
    if (now - dragLastMove < 16) return;
    dragLastMove = now;
    if (drag.mode === "idleSlide") {
      // 待机滑动：只允许水平移动，Y 锁死在待机边缘，直接设置窗口位置
      const edgePhys = Math.round(engine.idleTarget.y * scaleFactor);
      const nx = Math.max(4, Math.min(screen.availWidth - winSize - 4, Math.round(drag.wx + dx)));
      void invoke("set_window_pos_size", { label: "main", x: Math.round(nx * scaleFactor), y: edgePhys, width: winSize * scaleFactor, height: winSize * scaleFactor });
      engine.setPos(nx, engine.idleTarget.y);
    } else {
      let nx = Math.round(drag.wx + dx);
      let ny = Math.round(drag.wy + dy);
      // 先设位置，再算 offset，再约束（同一帧内完成，不留时序差）
      engine.setPos(nx, ny);
      const cb = view.getCharacterBounds?.() ?? null;
      engine.syncModelOffset(cb ?? undefined);
      engine.constrainPosition();
      // 实时发送模型边界（含 offset）给 Rust drag_follow，8ms 原生夹紧
      {
        const ox = engine.rawOffset.x;
        const oy = engine.rawOffset.y;
        const fallback = { left: 200, top: 200, right: 500, bottom: 500 };
        const b = cb ?? fallback;
        const s = scaleFactor || 1;
        void invoke("set_model_bounds", {
          left: Math.round((ox + b.left) * s),
          top: Math.round((oy + b.top) * s),
          right: Math.round((ox + b.right) * s),
          bottom: Math.round((oy + b.bottom) * s),
        });
      }
    }
  });
  const endDrag = (cancelled = false) => {
    if (!drag) return;
    const clicked = !cancelled && !drag.moved;
    if (drag.moved && drag.mode !== "idleSlide") {
      const start = nativeDragStart ?? Promise.resolve();
      void start.finally(() => invoke("drag_end").catch(() => {}));
    }
    nativeDragStart = null;
    drag = null;
    if (clicked) {
      if (settings.assistant.enabled) {
        openAssistant(getModelRect());
      } else {
        engine.suspend(IDLE_AFTER_DRAG_MS);
      }
    } else {
      engine.suspend(IDLE_AFTER_DRAG_MS);
    }
    setInteractingDebounced(false);
    requestInteractionRegionSync(true);
  };
  const releasePointerInteraction = (cancelled: boolean) => {
    if (uiPointerLocked) {
      uiPointerLocked = false;
      setInteractingDebounced(false);
      requestInteractionRegionSync(true);
    }
    endDrag(cancelled);
  };
  document.addEventListener("pointerup", () => releasePointerInteraction(false));
  document.addEventListener("pointercancel", () => releasePointerInteraction(true));
  window.addEventListener("blur", () => releasePointerInteraction(true));

  // ---------- Astrobot 预留钩子 ----------
  astrobotOn((msg) => {
    if (msg.type === "emote" || msg.type === "gesture") view.playClick();
    if (msg.type === "speak") view.playGobble();
    if (msg.type === "move") {
      void engine.teleportRandom();
    }
  });

  // ---------- 主循环 ----------
  const driver: PetDriver = idleDriver();
  let lastNow = performance.now();
  app.app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;

    analyzer.tick();

    // syncModelOffset 先于 update（constrainPosition 在 update 内，需要最新 offset）
    const cb = view.getCharacterBounds?.() ?? null;
    engine.syncModelOffset(cb ?? undefined);
    engine.update(now, dt);
    // 仅拖拽期间同步给 Rust drag follower；穿透判定使用独立 regions。
    if (drag?.moved && drag.mode !== "idleSlide") {
      const ox = engine.rawOffset.x;
      const oy = engine.rawOffset.y;
      // 有 characterBounds → 精确边界；无 → 窗口中心 300x300 作为 fallback
      const fallback = { left: 200, top: 200, right: 500, bottom: 500 };
      const b = cb ?? fallback;
      const s = scaleFactor || 1;
      void invoke("set_model_bounds", {
        left: Math.round((ox + b.left) * s),
        top: Math.round((oy + b.top) * s),
        right: Math.round((ox + b.right) * s),
        bottom: Math.round((oy + b.bottom) * s),
      });
    }
    driver.bass = analyzer.bass;
    driver.mid = analyzer.mid;
    driver.treble = analyzer.treble;
    driver.beat = analyzer.beat;
    driver.bpm = analyzer.bpm;
    driver.bob = engine.bob;
    driver.vx = engine.vx;
    driver.facingUser = isAssistantOpen();
    if (activeAssistantEmotion !== "neutral" && now >= assistantEmotionUntil) {
      activeAssistantEmotion = "neutral";
      assistantEmotionUntil = 0;
    }
    driver.emotion = activeAssistantEmotion;
    driver.cursorDx = engine.cursorDx;
    driver.cursorDy = engine.cursorDy;
    driver.cursorSpeed = engine.cursorSpeedValue;
    // 待机时呼吸放缓
    driver.breathing = (now / 1000) * Math.PI * 2 * (engine.isIdle ? 0.18 : 0.42);
    driver.excited = engine.excitementValue;
    driver.idleTop = engine.isIdleTop;
    driver.idle = engine.isIdle;
    driver.dragging = !!drag && drag.moved;
    driver.dragVelX = clamp(engine.cursorVx / 800, -1, 1);
    driver.pressed = !!drag;
    driver.modelOffsetX = engine.modelOffset.x;
    driver.modelOffsetY = engine.modelOffset.y;
    // 通知区域跟随模型位置（绿框下方）
    const mr = getModelRect();
    const toasts = document.getElementById("toasts");
    if (toasts && toasts.children.length > 0) {
      if (!drag || !drag.moved) {
        toasts.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
        toasts.style.bottom = `${Math.max(8, window.innerHeight - mr.bottom - 10)}px`;
        toasts.style.transform = "translateX(-50%)";
      }
    }
    const bubbles = document.getElementById("as-bubbles");
    if (bubbles && bubbles.children.length > 0 && (!drag || !drag.moved)) {
      bubbles.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
      bubbles.style.top = `${Math.round(mr.top - bubbles.offsetHeight - 12)}px`;
      bubbles.style.bottom = "auto";
      bubbles.style.transform = "translateX(-50%)";
    }
    // 拖拽中所有打开的面板跟随模型位置
    if (drag && drag.moved) {
      // 输入框
      const ib = document.getElementById("as-inputbar");
      if (ib && !ib.classList.contains("hidden")) {
        ib.style.left = `${Math.round(mr.left)}px`;
        ib.style.top = `${Math.min(mr.bottom + 10, window.innerHeight - 60)}px`;
        ib.style.bottom = "auto";
      }
      // 气泡
      if (bubbles && bubbles.children.length > 0) {
        bubbles.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
        bubbles.style.top = `${Math.round(mr.top - bubbles.offsetHeight - 12)}px`;
        bubbles.style.bottom = "auto";
        bubbles.style.transform = "translateX(-50%)";
      }
      // 通知
      if (toasts && toasts.children.length > 0) {
        toasts.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
        toasts.style.bottom = `${Math.max(8, window.innerHeight - mr.bottom - 10)}px`;
        toasts.style.transform = "translateX(-50%)";
      }
      // 其他面板（model-panel、chat-history 等）
      document.querySelectorAll(".model-panel:not(.hidden), #chat-history-panel").forEach(el => {
        positionPanelNearModel(el as HTMLElement);
      });
    }

    view.update(driver, dt);
  });
}

async function currentLogicalPos(win: Awaited<ReturnType<typeof getCurrentWindow>>) {
  try {
    const scale = await win.scaleFactor();
    const p = await win.outerPosition();
    // outerPosition 返回物理像素 → 转逻辑（引擎内部全逻辑坐标）
    return { x: p.x / scale, y: p.y / scale };
  } catch {
    return { x: 100, y: 100 };
  }
}


/** 清空元素内容（安全方式） */
function clearElement(el: HTMLElement) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

// ---------- 右键菜单 ----------

const INTERACTION_UI_SELECTORS: ReadonlyArray<readonly [string, string]> = [
  ["menu", "#menu"],
  ["model-panel", ".model-panel"],
  ["info-add", ".info-rm-add"],
  ["info-delete", ".info-rm-del"],
  ["reminder-dialog", ".rm-modal-box"],
  ["assistant-input", "#as-inputbar"],
  ["assistant-bubble", "#as-bubbles > .as-bubble"],
  ["update", "#update-bubble"],
  ["custom", "[data-qcpet-interactive]"],
];

let interactionSyncRunning = false;
let interactionSyncPending = false;
let interactionSyncForce = false;
let lastInteractionFingerprint = "";
let lastInteractionSyncAt = 0;
let interactionSyncStarted = false;

function visibleElementRect(element: Element): LogicalRect | null {
  const el = element as HTMLElement;
  if (!el.isConnected || el.hidden || el.classList.contains("hidden")) return null;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none" || style.opacity === "0") return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function collectInteractionRegions(): PhysicalInteractiveRegion[] {
  const scale = scaleFactor || window.devicePixelRatio || 1;
  const clientPhysicalWidth = Math.round(window.innerWidth * scale);
  const clientPhysicalHeight = Math.round(window.innerHeight * scale);
  const regions: PhysicalInteractiveRegion[] = [];

  const pet = getModelRect();
  const petRegion = logicalRectToPhysicalRegion(
    "pet",
    pet,
    scale,
    clientPhysicalWidth,
    clientPhysicalHeight,
  );
  if (petRegion) regions.push(petRegion);

  const seen = new Set<Element>();
  for (const [kind, selector] of INTERACTION_UI_SELECTORS) {
    document.querySelectorAll(selector).forEach((element, index) => {
      if (seen.has(element)) return;
      const rect = visibleElementRect(element);
      if (!rect) return;
      seen.add(element);
      const el = element as HTMLElement;
      const customId = el.dataset.qcpetInteractive;
      const id = `ui:${customId || el.id || `${kind}-${index}`}`;
      const region = logicalRectToPhysicalRegion(
        id,
        rect,
        scale,
        clientPhysicalWidth,
        clientPhysicalHeight,
        2,
      );
      if (region) regions.push(region);
    });
  }
  return regions;
}

function requestInteractionRegionSync(force = false) {
  interactionSyncPending = true;
  interactionSyncForce ||= force;
  if (interactionSyncRunning) return;
  void flushInteractionRegions();
}

async function flushInteractionRegions() {
  interactionSyncRunning = true;
  try {
    while (interactionSyncPending) {
      interactionSyncPending = false;
      const force = interactionSyncForce;
      interactionSyncForce = false;
      const regions = collectInteractionRegions();
      const fingerprint = regionFingerprint(regions);
      const now = performance.now();
      if (!force && fingerprint === lastInteractionFingerprint && now - lastInteractionSyncAt < 1000) {
        continue;
      }
      await invoke("sync_interaction_regions", { regions });
      lastInteractionFingerprint = fingerprint;
      lastInteractionSyncAt = now;
    }
  } catch (err) {
    if (import.meta.env.DEV) console.warn("interaction region sync failed", err);
  } finally {
    interactionSyncRunning = false;
    if (interactionSyncPending) requestInteractionRegionSync();
  }
}

function startInteractionRegionSync() {
  if (interactionSyncStarted) return;
  interactionSyncStarted = true;
  new MutationObserver(() => requestInteractionRegionSync()).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "data-qcpet-interactive"],
  });
  window.setInterval(() => requestInteractionRegionSync(), 33);
  requestInteractionRegionSync(true);
}

document.addEventListener("menu-closed", () => requestInteractionRegionSync(true));

function hiddenPsdInput(): HTMLInputElement {
  let input = document.getElementById("psd-input") as HTMLInputElement | null;
  if (!input) {
    input = document.createElement("input");
    input.id = "psd-input";
    input.type = "file";
    input.accept = ".psd";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const f = input!.files?.[0];
      if (f) void f.arrayBuffer().then((buf) => importPsdBytes(f.name, new Uint8Array(buf)));
      input!.value = "";
    });
    document.body.appendChild(input);
  }
  return input;
}

// ---------- 模型设置面板 ----------
async function toggleModelPanel() {
  const panel = document.getElementById("model-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  let models: string[] = [];
  try {
    models = await invoke<string[]>("list_models");
  } catch {
    /* 忽略 */
  }
  // 内置模型列表（manifest 配置：files 列表，兼容单 file）
  let builtinNames: string[] = [];
  try {
    const m = await invoke<string>("read_model_manifest")
      .then((s) => JSON.parse(s as string))
      .catch(() => null);
    if (m?.type === "psd" && Array.isArray(m.files) && m.files.length) builtinNames = m.files;
    else if (m?.type === "psd" && m.file) builtinNames = [m.file];
    else if (m?.active) builtinNames = [m.active];
  } catch {
    /* 无 manifest */
  }

  // 动作库仅 PSD 角色支持，标准 Live2D 模型提示
  if (currentModel.type === "live2d") {
    toast("动作库暂仅支持 PSD 角色（当前为标准 Live2D 模型）", "warn");
  }

  const render = (host: HTMLElement) => {
    clearElement(host);
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "模型设置";
    host.appendChild(title);

    const mk = (label: string, apply: () => void, active: boolean) => {
      const row = document.createElement("div");
      row.className = `mp-item${active ? " active" : ""}`;
      const span = document.createElement("span");
      span.textContent = label;
      row.appendChild(span);
      if (active) {
        const tag = document.createElement("b");
        tag.textContent = "使用中";
        row.appendChild(tag);
      }
      row.addEventListener("click", async () => {
        apply();
        host.classList.add("hidden");
        await reloadView();
      });
      host.appendChild(row);
    };

    // 内置模型（manifest / 打包）：多个内置模型可切换
    for (const f of builtinNames) {
      const label = f.replace(/\.psd$/i, "");
      mk(`内置 · ${label}`, () => {
        localStorage.setItem(BUILTIN_KEY, f);
        localStorage.removeItem(PSD_KEY);
      }, currentModel.type === "manifest" && currentModel.name === f);
    }
    // 已导入 PSD——带删除按钮（内置模型不可删）
    for (const m of models) {
      const label = m.replace(/\.psd$/i, "");
      const active = currentModel.type === "import" && currentModel.name === m;
      const row = document.createElement("div");
      row.className = `mp-item${active ? " active" : ""}`;
      const span = document.createElement("span");
      span.textContent = `已导入 · ${label}`;
      row.appendChild(span);
      if (active) {
        const tag = document.createElement("b");
        tag.textContent = "使用中";
        row.appendChild(tag);
      }
      // 删除按钮：点击只触发删除，不切换模型
      const del = document.createElement("button");
      del.className = "mp-del";
      del.textContent = "删除";
      del.title = "删除该模型（删除后需重新导入才能恢复）";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        showDeleteConfirm(host, m, label, active);
      });
      row.appendChild(del);
      row.addEventListener("click", async () => {
        localStorage.setItem(PSD_KEY, m);
        host.classList.add("hidden");
        await reloadView();
      });
      host.appendChild(row);
    }
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = "（无已导入模型）";
      host.appendChild(empty);
    }
    // 导入入口
    const importRow = document.createElement("div");
    importRow.className = "mp-item";
    const imp = document.createElement("span");
    imp.textContent = "＋ 导入 PSD 模型";
    importRow.appendChild(imp);
    importRow.addEventListener("click", () => {
      host.classList.add("hidden");
      hiddenPsdInput().click();
    });
    host.appendChild(importRow);

    // 返回按钮
    const backRow = document.createElement("div");
    backRow.className = "as-set-btns";
    const backBtn = document.createElement("button");
    backBtn.className = "as-btn";
    backBtn.textContent = "返回";
    backBtn.addEventListener("click", () => {
      host.classList.add("hidden");
    });
    backRow.appendChild(backBtn);
    host.appendChild(backRow);
  };

  // 删除确认面板：二次确认后才真正删除，杜绝误触
  const showDeleteConfirm = (
    host: HTMLElement,
    file: string,
    label: string,
    isCurrent: boolean,
  ) => {
    document.getElementById("del-confirm")?.remove();
    const panel = document.createElement("div");
    panel.id = "del-confirm";
    panel.className = "model-panel";
    panel.style.zIndex = "160"; // 高于模型面板(150)，避免被盖住
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "删除模型？";
    panel.appendChild(title);
    const hint = document.createElement("div");
    hint.className = "mp-hint";
    hint.textContent = `确定删除「${label}」吗？删除后需要重新导入 PSD 才能恢复。`;
    panel.appendChild(hint);
    const btns = document.createElement("div");
    btns.className = "as-set-btns";
    const cancel = document.createElement("button");
    cancel.className = "as-btn";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => panel.remove());
    const ok = document.createElement("button");
    ok.className = "as-btn as-btn-danger";
    ok.textContent = "删除";
    ok.addEventListener("click", async () => {
      panel.remove();
      await deleteModel(host, file, label, isCurrent);
    });
    btns.append(cancel, ok);
    panel.appendChild(btns);
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.appendChild(panel);
  };

  // 删除后重新拉取列表并重渲染
  const refreshModels = async (host: HTMLElement) => {
    try {
      models = await invoke<string[]>("list_models");
    } catch {
      models = [];
    }
    render(host);
  };

  // 核心删除逻辑：
  // 1) 删除当前使用模型时，先切回内置模型并确认加载成功，再删文件
  // 2) 删除失败时回滚持久化状态并保留原条目
  // 3) 成功后刷新列表
  const deleteModel = async (
    host: HTMLElement,
    file: string,
    label: string,
    isCurrent: boolean,
  ) => {
    const wasCurrent = isCurrent || localStorage.getItem(PSD_KEY) === file;
    // 若删除的是当前使用模型：先切回内置（清空 PSD_KEY），并确认内置加载成功
    if (wasCurrent) {
      localStorage.removeItem(PSD_KEY);
      try {
        await reloadView();
      } catch (err) {
        // 内置模型加载失败：回滚，保留原模型与条目
        localStorage.setItem(PSD_KEY, file);
        console.error("删除时切回内置模型失败:", err);
        await reloadView().catch(() => {});
        toast("内置模型加载失败，删除已取消", "warn");
        return;
      }
    }
    // 真正删除文件（后端已做路径安全校验）
    try {
      await invoke("delete_imported_model", { name: file });
    } catch (err) {
      // 删除失败：恢复原模型（若刚才已切回），保留条目
      if (wasCurrent) {
        localStorage.setItem(PSD_KEY, file);
        await reloadView().catch(() => {});
      }
      console.error("delete_imported_model 失败:", err);
      toast("删除模型失败，请重试", "warn");
      return;
    }
    // 成功：刷新列表
    await refreshModels(host);
    toast(`已删除 ${label}`);
  };

  if (panel) {
    render(panel);
    panel.classList.remove("hidden");
  } else {
    const p = document.createElement("div");
    p.id = "model-panel";
    p.className = "model-panel hidden";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    render(p);
    document.body.appendChild(p);
    p.classList.remove("hidden");
    positionPanelNearModel(p);
    // 强制完整显示：底部超出可见区则翻到模型上方
    const pr = p.getBoundingClientRect();
    const vr2 = getWindowVisibleRect();
    if (pr.bottom > vr2.bottom || pr.top < vr2.top) {
      const mr2 = getModelRect();
      // 优先模型上方
      let nt = mr2.top - pr.height - 10;
      if (nt < vr2.top) nt = mr2.bottom + 10;
      nt = Math.max(vr2.top + 4, Math.min(nt, vr2.bottom - pr.height - 4));
      p.style.top = `${Math.round(nt)}px`;
      p.style.left = `${Math.round(mr2.left + (mr2.width - pr.width) / 2)}px`;
    }
  }
}

function buildMenu() {
  return [
    {
      id: "model",
      label: "模型",
      submenu: [
        {
          id: "models",
          label: "模型设置",
          onPick: () => void toggleModelPanel(),
        },
        {
          id: "size",
          label: "模型大小",
          onPick: () => void toggleSizePanel(),
        },
      ],
    },
    {
      id: "assistant-settings",
      label: "对话设置",
      onPick: () => void toggleAssistantSettings(),
    },
    {
      id: "assistant",
      label: "对话开关",
      state: settings.assistant.enabled ? "开" : "关",
      onPick: () => {
        settings.assistant.enabled = !settings.assistant.enabled;
        saveSettings(settings);
        if (!settings.assistant.enabled) {
          closeAssistant();
          clearBubbles();
        }
        toast(settings.assistant.enabled ? "对话已开启" : "对话已关闭");
      },
    },
    {
      id: "chat-history",
      label: "对话记录",
      onPick: () => toggleChatHistory(),
    },
    {
      id: "quit",
      label: "退出",
      onPick: () => void invoke("quit_app"),
    },
  ];
}


/** 模型大小滑动条面板（20%~200%，拖动实时应用） */
function toggleSizePanel() {
  const panel = document.getElementById("size-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }

  const render = (host: HTMLElement) => {
    clearElement(host);

    const head = document.createElement("div");
    head.className = "size-head";
    const title = document.createElement("span");
    title.className = "size-title";
    title.textContent = "模型大小";
    const val = document.createElement("span");
    val.className = "size-val";
    val.textContent = `${Math.round(settings.modelScale * 100)}%`;
    const backBtn = document.createElement("button");
    backBtn.className = "as-btn";
    backBtn.textContent = "返回";
    backBtn.addEventListener("click", () => {
      host.classList.add("hidden");
    });
    head.append(title, val, backBtn);
    host.appendChild(head);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "20";
    slider.max = "200";
    slider.step = "1";
    slider.value = String(Math.round(settings.modelScale * 100));
    slider.className = "size-slider";
    let lastApply = 0;
    slider.addEventListener("input", () => {
      val.textContent = `${slider.value}%`;
      const now = performance.now();
      if (now - lastApply < 80) return; // 节流，避免高频窗口 resize 抖动
      lastApply = now;
      void applyModelScale(Number(slider.value) / 100);
    });
    slider.addEventListener("change", () => {
      void applyModelScale(Number(slider.value) / 100, true);
    });
    host.appendChild(slider);
  };

  if (panel) {
    render(panel);
    panel.classList.remove("hidden");
  } else {
    const p = document.createElement("div");
    p.id = "size-panel";
    p.className = "model-panel size-panel hidden";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    render(p);
    document.body.appendChild(p);
    p.classList.remove("hidden");
    positionPanelNearModel(p);
  }
}

// ---------- 对话记录面板 ----------
function toggleChatHistory() {
  const existing = document.getElementById("chat-history-panel");
  if (existing) { existing.remove(); return; }

  const panel = document.createElement("div");
  panel.id = "chat-history-panel";
  panel.className = "model-panel";
  panel.style.zIndex = "170";
  panel.style.cssText = "display:flex;flex-direction:column;overflow:hidden;width:auto;max-width:360px;";

  const title = document.createElement("div");
  title.className = "mp-title";
  title.textContent = "对话记录";
  panel.appendChild(title);

  // 从 localStorage 读取历史，过滤主动问候和工具消息
  let msgs: {role: string; content: string}[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem("live2d-pet-assistant-history") || "[]");
    msgs = raw
      .filter((m: any) => {
        if (m.role !== "user" && m.role !== "assistant") return false;
        if (!m.content) return false;
        const c = String(m.content);
        if (c.startsWith("[主动问候]")) return false;
        if (c.startsWith("[主动学习]")) return false;
        return true;
      })
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 500) }));
  } catch {}

  if (msgs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mp-hint";
    empty.textContent = "暂无对话记录";
    panel.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.style.cssText = "flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:4px 0;scrollbar-width:thin;";
    for (const m of msgs) {
      const row = document.createElement("div");
      row.style.cssText = "font-size:12px;line-height:1.5;padding:6px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-word;";
      if (m.role === "user") {
        row.style.background = "rgba(100,140,255,0.12)";
        row.textContent = "👤 " + m.content;
      } else {
        row.style.background = "rgba(255,255,255,0.6)";
        row.textContent = "🐾 " + m.content;
      }
      list.appendChild(row);
    }
    panel.appendChild(list);
  }

  // 关闭按钮
  const btns = document.createElement("div");
  btns.className = "as-set-btns";
  const closeBtn = document.createElement("button");
  closeBtn.className = "as-btn";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => panel.remove());
  btns.appendChild(closeBtn);
  panel.appendChild(btns);

  document.body.appendChild(panel);
  positionPanelNearModel(panel);

  // 点击外部关闭（延迟注册避免当前点击触发）
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!panel.contains(e.target as Node)) {
        panel.remove();
        document.removeEventListener("pointerdown", close);
      }
    };
    document.addEventListener("pointerdown", close);
  }, 50);
}


// ---------- 对话设置面板 ----------
async function toggleAssistantSettings() {
  const panel = document.getElementById("assistant-settings") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  const render = (host: HTMLElement) => {
    clearElement(host);
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "对话设置";
    host.appendChild(title);

    const mkRow = (label: string, el: HTMLElement) => {
      const row = document.createElement("div");
      row.className = "as-set-row";
      const l = document.createElement("span");
      l.className = "as-set-label";
      l.textContent = label;
      row.append(l, el);
      host.appendChild(row);
      return row;
    };

    const provider = document.createElement("select");
    provider.className = "as-input as-select";
    provider.innerHTML = `<option value="deepseek">DeepSeek（内置）</option><option value="custom">自定义 OpenAI 兼容</option>`;
    provider.value = settings.assistant.provider;
    mkRow("提供商", provider);

    const baseUrl = document.createElement("input");
    baseUrl.className = "as-input";
    baseUrl.placeholder = "如 https://api.openai.com/v1";
    baseUrl.value = settings.assistant.customBaseUrl;
    const baseUrlRow = mkRow("API 端点", baseUrl);
    const toggleBaseUrl = () => {
      baseUrlRow.style.display = provider.value === "custom" ? "flex" : "none";
    };
    provider.addEventListener("change", toggleBaseUrl);
    toggleBaseUrl();

    const key = document.createElement("input");
    key.className = "as-input";
    key.type = "password";
    key.placeholder = "API Key";
    key.value = "";
    mkRow("API Key", key);
    // API Key 存 Rust 侧（DPAPI 加密），打开面板时回填
    void invoke<string>("get_api_key")
      .then((k) => {
        key.value = k;
      })
      .catch(() => {
        /* 未设置 */
      });

    const modelSelect = document.createElement("select");
    modelSelect.className = "as-input as-select";
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "（点下方「自动获取模型」）";
    modelSelect.appendChild(emptyOpt);
    mkRow("模型列表", modelSelect);

    const model = document.createElement("input");
    model.className = "as-input";
    model.placeholder = "模型名（留空用默认）";
    model.value = settings.assistant.model;
    mkRow("模型名", model);
    modelSelect.addEventListener("change", () => {
      if (modelSelect.value) model.value = modelSelect.value;
    });

    const persona = document.createElement("textarea");
    persona.className = "as-input as-persona";
    persona.rows = 3;
    persona.value = settings.assistant.persona;
    mkRow("人格设定", persona);

    const fetchBtn = document.createElement("button");
    fetchBtn.className = "as-btn";
    fetchBtn.textContent = "自动获取模型";
    fetchBtn.addEventListener("click", async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = "获取中…";
      let models: string[] = [];
      try {
        models = await listModels(
          provider.value as AssistantProvider,
          key.value.trim(),
          baseUrl.value.trim(),
        );
      } catch {
        models = [];
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = "自动获取模型";
      }
      if (models.length) {
        // 填充下拉列表
        modelSelect.innerHTML = "";
        for (const m of models) {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          modelSelect.appendChild(opt);
        }
        // 自动选中：优先保留用户之前填的模型名，否则选第一个
        const current = model.value.trim();
        if (current && models.includes(current)) {
          modelSelect.value = current;
        } else {
          model.value = models[0];
          modelSelect.value = models[0];
        }
        toast(`获取到 ${models.length} 个模型，已自动选择：${model.value}`);
      } else {
        toast("未获取到模型列表（可能接口不支持），请在「模型名」手填", "warn");
      }
    });
    mkRow("", fetchBtn);

    const btns = document.createElement("div");
    btns.className = "as-set-btns";

    const clearHistBtn = document.createElement("button");
    clearHistBtn.className = "as-btn";
    clearHistBtn.textContent = "清空对话历史";
    clearHistBtn.addEventListener("click", () => {
      clearHistory();
      toast("对话历史已清空（长期记忆保留）");
    });

    host.appendChild(clearHistBtn);

    const back = document.createElement("button");
    back.className = "as-btn";
    back.textContent = "返回";
    back.addEventListener("click", () => {
      host.classList.add("hidden");
    });

    const save = document.createElement("button");
    save.className = "as-btn as-btn-primary";
    save.textContent = "保存";
    save.addEventListener("click", async () => {
      settings.assistant.provider = provider.value as AssistantProvider;
      settings.assistant.customBaseUrl = baseUrl.value.trim();
      settings.assistant.model = model.value.trim();
      settings.assistant.persona = persona.value.trim();
      saveSettings(settings);
      // API Key 存 Rust 侧（DPAPI 加密）
      try {
        await invoke("set_api_key", { apiKey: key.value.trim() });
        clearApiKeyCache();
      } catch (e) {
        toast(`API Key 保存失败：${e}`, "warn");
      }
      host.classList.add("hidden");
      toast("对话设置已保存");
    });
    btns.append(back, save);
    host.appendChild(btns);
  };

  if (panel) {
    render(panel);
    panel.classList.remove("hidden");
  } else {
    const p = document.createElement("div");
    p.id = "assistant-settings";
    p.className = "model-panel hidden";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    render(p);
    document.body.appendChild(p);
    p.classList.remove("hidden");
    positionPanelNearModel(p);
  }
}

function toggleAudio(on: boolean) {
  settings.audioEnabled = on;
  saveSettings(settings);
  view.setSwayEnabled(on);
  void invoke("set_audio_enabled", { enabled: on });
  toast(on ? "耳朵竖起来啦～" : "暂时不想听音乐了");
}

void boot();
