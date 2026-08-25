import type { Container } from "pixi.js";
import type { PetDriver, PetView } from "../PetDriver";
import { PsdRuntime, type RigParams } from "./PsdRuntime";
import { findAction, sampleAction, pickPoolAction, type ActionDef } from "../actions";
import { clamp } from "../../utils/math";
import { getActivityFactor, getActivityLevel } from "../../utils/settings";

function smoothStep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

/** 表情目标参数（在音乐驱动基础上叠加偏移） */
interface Expression {
  brow: number; // -1..1 眉毛
  mouthOpen: number; // 0..1 嘴开
  mouthForm: number; // -1..1 嘴形（+笑 -撇嘴）
  eyeX: number; // 视线横
  eyeY: number; // 视线纵
  closeL: number; // 0..1 左眼闭合
  closeR: number; // 0..1 右眼闭合
  irisScale: number; // 瞳缩放偏移
  tilt: number; // 歪头
}

const EXPRESSIONS: Expression[] = [
  { brow: 0.35, mouthOpen: 0.18, mouthForm: 0.9, eyeX: 0, eyeY: 0, closeL: 0.05, closeR: 0.05, irisScale: 0, tilt: 0 }, // 微笑
  { brow: 1, mouthOpen: 0.65, mouthForm: -0.1, eyeX: 0, eyeY: 0.1, closeL: 0, closeR: 0, irisScale: -0.2, tilt: 0 }, // 惊讶
  { brow: 0.3, mouthOpen: 0, mouthForm: 0.45, eyeX: 0, eyeY: 0, closeL: 0.62, closeR: 0.62, irisScale: 0, tilt: 0 }, // 眯眯眼
  { brow: -0.45, mouthOpen: 0.15, mouthForm: -0.3, eyeX: 0, eyeY: -0.25, closeL: 0.15, closeR: 0.15, irisScale: 0, tilt: 0.06 }, // 委屈
  { brow: -0.8, mouthOpen: 0.05, mouthForm: -0.55, eyeX: 0, eyeY: 0, closeL: 0.08, closeR: 0.08, irisScale: 0, tilt: -0.05 }, // 生气
  { brow: 0.55, mouthOpen: 0.12, mouthForm: 0.6, eyeX: 0.35, eyeY: -0.15, closeL: 0.45, closeR: 0.45, irisScale: 0, tilt: 0.1 }, // 害羞
  { brow: 0.25, mouthOpen: 0.35, mouthForm: 0.7, eyeX: 0, eyeY: 0, closeL: 1, closeR: 0, irisScale: 0, tilt: 0.04 }, // 左眨眼
  { brow: 0.25, mouthOpen: 0.35, mouthForm: 0.7, eyeX: 0, eyeY: 0, closeL: 0, closeR: 1, irisScale: 0, tilt: -0.04 }, // 右眨眼
  { brow: 0.2, mouthOpen: 0.85, mouthForm: -0.35, eyeX: 0, eyeY: 0.15, closeL: 0.12, closeR: 0.12, irisScale: 0.05, tilt: 0.03 }, // 吐舌/哈欠
  { brow: 0.6, mouthOpen: 0.5, mouthForm: -0.15, eyeX: -0.3, eyeY: 0, closeL: 0, closeR: 0, irisScale: 0, tilt: 0.08 }, // 好奇
];

function pickExpression(rng: () => number): Expression {
  return EXPRESSIONS[Math.floor(rng() * EXPRESSIONS.length)];
}

/**
 * 2.5D PSD 渲染后端（Anime2.5DRig 技术本地化）。
 * 独立 canvas + WebGL1，与 pixi 层共存；PSD → 自动 rig → 即时驱动。
 */
export class Rigged2DView implements PetView {
  readonly canvas: HTMLCanvasElement;
  private runtime: PsdRuntime;
  private gobblePulse = 0;
  private clickPulse = 0;
  private scalePulse = 0;
  private swayEnabled = true;
  private displayW = 300; // 当前显示边长（窗口跟随缩放，setScale 更新）

  // 随机表情状态机
  private exprT = 0;
  private exprDur = 1.6;
  private exprNext = 0;
  private expr: Expression = EXPRESSIONS[0];

  // 动作播放器
  private action: ActionDef | null = null;
  private actionT = 0;
  private actionLoop = false;
  private winkRight = false; // wink 动作随机闭右眼

  // 动作池：空闲随机抽取播放（启动 8s 后才开始）
  private actionPoolNext = performance.now() + 8000;

  // 跟随音乐仅保留随机 wink，不再驱动身体律动。
  private musicWinkT = 0;
  private musicWinkNext = 2 + Math.random() * 4;
  private musicWinkSide: "L" | "R" = "L";

  private dragSquint = 0; // 拖拽眯眼（0=睁眼，1=眯眼）

  private fastCursorHairGuard = 0;
  private userGazeWeight = 0;
  private emotionWeights = { shy: 0, disgust: 0, surprised: 0 };
  private shyGaze = { x: 0, y: 0.35 };
  private shyGazeTarget = { x: 0, y: 0.35 };
  private shyGazeNext = 0;
  private shyGazeSide = -1;
  private disgustStartedAt = 0;
  private previousEmotion: PetDriver["emotion"] = "neutral";

  private static rand() {
    return Math.random();
  }

  private constructor(canvas: HTMLCanvasElement, runtime: PsdRuntime) {
    this.canvas = canvas;
    this.runtime = runtime;
    canvas.className = "rig";
  }

  static async create(bytes: Uint8Array): Promise<Rigged2DView> {
    const canvas = document.createElement("canvas");
    canvas.id = "rig-canvas";
    const runtime = new PsdRuntime(canvas);
    await runtime.load(bytes);
    const view = new Rigged2DView(canvas, runtime);
    view.setSwayEnabled(true);
    return view;
  }

  attachTo(stage: HTMLElement, _pixiStage: Container) {
    stage.appendChild(this.canvas);
  }

  unmount() {
    this.canvas.remove();
    this.runtime.destroy();
  }

  /** rigger warnings（缺 face / 闭眼自动合成等） */
  get warnings(): string[] {
    return this.runtime.warnings;
  }

  get stats(): string {
    return `已自动装配 ${this.runtime.partsCount} 部件 / 发丝 ${this.runtime.strandCount} 束`;
  }

  update(d: PetDriver, dt: number) {
    const sway = this.swayEnabled && !this.action ? 1 : 0;
    this.gobblePulse = Math.max(0, this.gobblePulse - dt * 2.2);
    this.clickPulse = Math.max(0, this.clickPulse - dt * 6);
    this.scalePulse = Math.max(0, this.scalePulse - dt * 5);

    // ---- 表情节奏：间隔随活动因子拉长，播放 1.6~2.4 秒（正弦包络淡入淡出）。
    //      待机时安静：不触发新表情，回到中性。
    const nowMs = performance.now();
    this.exprT += dt;
    if (d.idle) {
      if (this.exprT > this.exprDur || this.exprT === 0) {
        this.expr = EXPRESSIONS[0];
        this.exprT = 0;
      }
      this.exprNext = nowMs + 60000;
    } else if (!this.action && nowMs > this.exprNext) {
      this.expr = pickExpression(Rigged2DView.rand);
      this.exprT = 0;
      this.exprDur = 1.6 + Rigged2DView.rand() * 0.8;
      this.exprNext = nowMs + (6000 + Rigged2DView.rand() * 8000) * getActivityFactor();
    }
    const eProg = Math.min(1, this.exprT / this.exprDur);
    const ew = Math.sin(Math.PI * eProg); // 0→1→0
    const e = this.expr;

    // ---- 动作池：空闲随机抽取播放（频率随活动因子拉长，low 最稀疏） ----
    if (!this.action && d.emotion === "neutral" && !d.idle && !d.dragging && nowMs > this.actionPoolNext) {
      const def = pickPoolAction(getActivityLevel());
      if (def) this.playAction(def.id, false);
      this.actionPoolNext = nowMs + (15 + Math.random() * 15) * 1000 * getActivityFactor();
    }

    const exc = d.excited ?? 0; // 逗猫棒兴奋度：眼神更跟手、微前倾、瞳孔聚焦
    // 顶部待机倒挂（旋转 180°）→ 视线横纵都镜像
    const flip = d.idleTop ? -1 : 1;
    const cdx = d.cursorDx * flip;
    const cdy = d.cursorDy * flip;
    // 只让视线渐进聚焦：进入约 1.5~2 秒，退出稍快恢复鼠标跟随。
    const gazeRate = d.facingUser ? 1.8 : 3;
    const gazeTarget = d.facingUser ? 1 : 0;
    this.userGazeWeight += (gazeTarget - this.userGazeWeight) * (1 - Math.exp(-dt * gazeRate));

    // AI 情绪状态使用独立权重交叉淡化，退出状态后自然回到对话视线而非跳变。
    for (const emotion of ["shy", "disgust", "surprised"] as const) {
      const target = d.emotion === emotion ? 1 : 0;
      const current = this.emotionWeights[emotion];
      const rate = target > current ? 1.55 : 1.1;
      this.emotionWeights[emotion] += (target - current) * (1 - Math.exp(-dt * rate));
    }
    if (d.emotion === "disgust" && this.previousEmotion !== "disgust") {
      this.disgustStartedAt = nowMs;
    }
    this.previousEmotion = d.emotion;

    if (this.emotionWeights.shy > 0.015 && nowMs >= this.shyGazeNext) {
      // 以快速但不等间隔的扫视躲开镜头，并避开模型自动计算出的对视点。
      let candidate: { x: number; y: number };
      const dwell = 380 + Math.random() * 760;
      if (Math.random() < 0.72) this.shyGazeSide *= -1;
      const contact = this.runtime.eyeContactOffset;
      candidate = { x: -0.9, y: 0.65 };
      for (let attempt = 0; attempt < 6; attempt++) {
        candidate = {
          x: this.shyGazeSide * (0.68 + Math.random() * 0.32),
          y: -0.58 + Math.random() * 1.48,
        };
        const dx = candidate.x - contact.x;
        const dy = candidate.y - contact.y;
        if (dx * dx + dy * dy > 0.72) break;
        this.shyGazeSide *= -1;
      }
      this.shyGazeTarget = candidate;
      this.shyGazeNext = nowMs + dwell;
    }
    const shyGazeEase = 1 - Math.exp(-dt * (this.emotionWeights.shy > 0.18 ? 12 : 4));
    this.shyGaze.x += (this.shyGazeTarget.x - this.shyGaze.x) * shyGazeEase;
    this.shyGaze.y += (this.shyGazeTarget.y - this.shyGaze.y) * shyGazeEase;
    // 约 1400 px/s 以下不改变现有手感；高速穿过桌宠时立即抑制，随后约 0.3 秒平滑恢复。
    const speedT = clamp((d.cursorSpeed - 1400) / 1800, 0, 1);
    const fastNow = d.pressed || d.dragging ? 0 : speedT * speedT * (3 - 2 * speedT);
    this.fastCursorHairGuard = d.pressed || d.dragging
      ? 0
      : Math.max(fastNow, this.fastCursorHairGuard * Math.exp(-dt * 5));

    // ---- 跟随音乐仅保留面部 wink ----
    let winkClose = 0;
    if (sway && Math.max(
      this.emotionWeights.shy,
      this.emotionWeights.disgust,
      this.emotionWeights.surprised,
    ) < 0.18) {
      if (this.musicWinkT > 0) {
        this.musicWinkT -= dt;
        if (this.musicWinkT <= 0) this.musicWinkNext = 2 + Math.random() * 6;
      } else if (this.musicWinkNext > 0) {
        this.musicWinkNext -= dt;
        if (this.musicWinkNext <= 0) {
          this.musicWinkT = 0.35;
          this.musicWinkSide = Math.random() < 0.5 ? "L" : "R";
        }
      } else {
        this.musicWinkNext = 2 + Math.random() * 6;
      }
      winkClose = this.musicWinkT > 0 ? 1 : 0;
    }

    // 按住只保留面部反馈：眯眼平滑（全闭）。
    this.dragSquint += ((d.pressed ? 1 : 0) - this.dragSquint) * Math.min(1, dt * 6);

    const baseEyeX = clamp(cdx * (1.8 + exc * 0.6) + e.eyeX * ew, -1, 1);
    const baseEyeY = clamp(cdy * (1.2 + exc * 0.5) + e.eyeY * ew, -1, 1);
    const eyeContact = this.runtime.eyeContactOffset;
    const contactEyeX = clamp(eyeContact.x, -1, 1);
    const contactEyeY = clamp(eyeContact.y - 0.06, -1, 1);
    const gazeW = this.userGazeWeight;
    const pointerHeadW = 1 - gazeW;
    const baseEyeOpenL = clamp((1 - d.mid * 0.06 * sway) * (1 - e.closeL * ew) + exc * 0.05, 0, 1.08);
    const baseEyeOpenR = clamp((1 - d.mid * 0.06 * sway) * (1 - e.closeR * ew) + exc * 0.05, 0, 1.08);
    const baseIrisScale = clamp(1 + e.irisScale * ew - exc * 0.06, 0.5, 1.3);
    const neutralEyeX = baseEyeX * (1 - gazeW) + contactEyeX * gazeW;
    const neutralEyeY = baseEyeY * (1 - gazeW) + contactEyeY * gazeW;
    const shyW = this.emotionWeights.shy;
    const disgustW = this.emotionWeights.disgust;
    const surprisedW = this.emotionWeights.surprised;
    const emotionSum = shyW + disgustW + surprisedW;
    const emotionBlendW = clamp(emotionSum, 0, 1);
    const blendEmotion = (base: number, shy: number, disgust: number, surprised: number) => {
      if (emotionSum < 0.0001) return base;
      const target = (shy * shyW + disgust * disgustW + surprised * surprisedW) / emotionSum;
      return base + (target - base) * emotionBlendW;
    };
    const avoidGazeSum = shyW + disgustW;
    const avoidGazeW = clamp(avoidGazeSum, 0, 1);
    const rollCycle = Math.max(0, nowMs - this.disgustStartedAt) % 3600;
    let disgustEyeX = 0.78;
    let disgustEyeY = 0.08;
    let disgustRollAmount = 0;
    if (rollCycle >= 400 && rollCycle < 1900) {
      if (rollCycle < 760) {
        const u = smoothStep((rollCycle - 400) / 360);
        disgustRollAmount = u;
        disgustEyeX = 0.78 + (0.08 - 0.78) * u;
        disgustEyeY = 0.08 + (-2.1 - 0.08) * u;
      } else if (rollCycle < 1140) {
        const u = smoothStep((rollCycle - 760) / 380);
        disgustRollAmount = 1;
        disgustEyeX = 0.08 + (-1.56 - 0.08) * u;
        disgustEyeY = -2.1 + (-1.9 + 2.1) * u;
      } else if (rollCycle < 1480) {
        disgustRollAmount = 1;
        disgustEyeX = -1.56;
        disgustEyeY = -1.9;
      } else {
        const u = smoothStep((rollCycle - 1480) / 420);
        disgustRollAmount = 1 - u;
        disgustEyeX = -1.56 + (0.78 + 1.56) * u;
        disgustEyeY = -1.9 + (0.08 + 1.9) * u;
      }
    }
    const emotionEyeX = avoidGazeSum > 0.0001
      ? (this.shyGaze.x * shyW + disgustEyeX * disgustW) / avoidGazeSum
      : neutralEyeX;
    const emotionEyeY = avoidGazeSum > 0.0001
      ? (this.shyGaze.y * shyW + disgustEyeY * disgustW) / avoidGazeSum
      : neutralEyeY;
    const neutralMouthOpen = clamp(d.mid * 0.9 * sway + d.beat * 0.5 * sway + this.gobblePulse + this.clickPulse * 0.5 + e.mouthOpen * ew + exc * 0.12, 0, 1.3);
    const neutralMouthForm = clamp(d.mid * 0.4 * sway + e.mouthForm * ew, -1, 1);
    const neutralBrow = clamp(d.treble * 0.5 * sway - d.bass * 0.3 + e.brow * ew, -1, 1);
    const neutralAngleZ = clamp(Math.sin(d.breathing) * 0.02 + e.tilt * ew, -0.2, 0.2);

    const o: Partial<RigParams> = {
      // 头部轻微跟随（眼神为主）：头微动、眼明显；兴奋时微前倾
      angleX: clamp(
        cdx * 0.25 * pointerHeadW + d.vx * 0.25 + exc * 0.12
          + this.shyGaze.x * shyW * 0.23 - disgustW * 0.1,
        -1,
        1,
      ),
      angleY: clamp(-cdy * 0.15 * pointerHeadW + exc * 0.06, -1, 1),
      eyeX: neutralEyeX * (1 - avoidGazeW) + emotionEyeX * avoidGazeW,
      eyeY: neutralEyeY * (1 - avoidGazeW) + emotionEyeY * avoidGazeW,
      // 仅保留移动时必要的轻微身体晃动，不再驱动四肢或整身舞蹈。
      body: clamp(d.vx * 0.12, -0.2, 0.2),
      angleZ: blendEmotion(neutralAngleZ, 0.07, -0.05, 0),
      // 音乐 → 嘴型（中频 + 节拍 + 吞咽/点击脉冲），表情叠加，兴奋时微张嘴
      mouthOpen: blendEmotion(neutralMouthOpen, 0.05, 0.02, 0.78),
      mouthForm: blendEmotion(neutralMouthForm, 0.35, -0.8, -0.1),
      // 眉毛：音乐驱动 + 表情偏移
      brow: blendEmotion(neutralBrow, 0.45, -0.92, 1),
      browAngSym: blendEmotion(0, -0.08, 0.44, 0),
      eyeCAng: blendEmotion(0, 0, 0.34, 0),
      eyeOpenL: blendEmotion(baseEyeOpenL, 1.04, 0.44 + disgustRollAmount * 0.21, 1.08),
      eyeOpenR: blendEmotion(baseEyeOpenR, 1.04, 0.44 + disgustRollAmount * 0.21, 1.08),
      irisScale: blendEmotion(baseIrisScale, 0.96, 0.92 - disgustRollAmount * 0.12, 0.7),
      blush: blendEmotion(0, 1, 0.16, 0.04),
      blushX: 0,
      blushY: 0,
      blushScaleX: 1,
      blushScaleY: blendEmotion(1, 1, 1.05, 1),
      // 发丝物理加成
      fhAmp: 2 + d.mid * 2.5 * sway,
      physAmp: 2 + d.bass * 2 * sway,
      hairMotionScale: 1 - this.fastCursorHairGuard * 0.58,
      // 明确固定肢体通道，防止不同 PSD 图层结构产生手臂/下半身拉伸。
      armY: 0,
      armPos: 0,
      bodySwing: 0,
    };

    // 音乐节拍 wink：闭对应单眼
    if (winkClose) {
      if (this.musicWinkSide === "L") o.eyeOpenL = Math.min(o.eyeOpenL ?? 1, 0.12);
      else o.eyeOpenR = Math.min(o.eyeOpenR ?? 1, 0.12);
    }

    // 按住眯眼：全闭
    if (this.dragSquint > 0.01) {
      const sq = 1 - 0.95 * this.dragSquint;
      o.eyeOpenL = Math.min(o.eyeOpenL ?? 1, sq);
      o.eyeOpenR = Math.min(o.eyeOpenR ?? 1, sq);
    }

    // ---- 动作层：覆盖对应通道（播放完自动回落待机 / 循环） ----
    if (this.action) {
      this.actionT += dt;
      const progress = Math.min(1, this.actionT / this.action.duration);
      const ap = sampleAction(this.action, progress);
      if (this.action.randomEye && this.winkRight) {
        // 显式交换声明过的眼睛通道（缺失通道不写入 undefined）
        const l = ap.eyeOpenL;
        const r = ap.eyeOpenR;
        if (r !== undefined) ap.eyeOpenL = r;
        if (l !== undefined) ap.eyeOpenR = l;
      }
      // 平滑混合：动作参数与基线 lerp，渐入渐出消除硬覆盖跳变
      const FADE = 0.2; // 秒
      let w = 1;
      if (!this.actionLoop) {
        w = Math.min(1, this.actionT / FADE, Math.max(0, (this.action.duration - this.actionT) / FADE));
      }
      for (const k in ap) {
        const av = (ap as unknown as Record<string, number>)[k];
        if (typeof av === "number") {
          const base = (o as unknown as Record<string, number>)[k] ?? 0;
          (o as unknown as Record<string, number>)[k] = base * (1 - w) + av * w;
        }
      }
      if (this.actionT >= this.action.duration) {
        if (this.actionLoop) {
          this.actionT = 0;
          if (this.action.randomEye) this.winkRight = Math.random() < 0.5;
        } else {
          this.action = null;
          this.setAuto(true);
        }
      }
    }

    if (!this.action) {
      // 惊讶时保持睁眼；进入状态还会取消正在进行的眨眼，避免表情被随机眨眼遮住。
      this.runtime.autoBlinkOn = surprisedW < 0.25 && disgustRollAmount < 0.12;
      this.runtime.autoRandOn = true;
      this.runtime.autoIdleOn = true;
      this.runtime.randomGazeWeight = 1 - clamp(Math.max(gazeW, avoidGazeW), 0, 1);
    }
    this.runtime.update(dt, o);

    // 待机顶部 → 整体旋转 180°（露出头顶+眼睛）
    const rot = d.idleTop ? " rotate(180deg)" : "";
    // 模型边缘露出偏移（窗口探出屏幕时模型自动跟随）
    const ox = Math.round(d.modelOffsetX || 0);
    const oy = Math.round(d.modelOffsetY || 0);
    const shift = ox !== 0 || oy !== 0 ? ` translate(${ox}px, ${oy}px)` : "";

    // 吞咽/点击时 canvas 缩放脉冲
    if (this.scalePulse > 0) {
      const s = 1 + this.scalePulse * 0.15 * (this.gobblePulse > 0 ? 1.2 : 0.6);
      this.canvas.style.transform = `translate(-50%, -50%)${shift}${rot} scale(${s})`;
    } else {
      this.canvas.style.transform = `translate(-50%, -50%)${shift}${rot}`;
    }
  }

  playGobble() {
    this.gobblePulse = 1;
    this.scalePulse = 1;
  }

  playClick() {
    this.clickPulse = 1;
    this.scalePulse = 1;
  }

  playAction(id: string, loop = false) {
    const def = findAction(id);
    if (def) {
      this.action = def;
      this.actionT = 0;
      this.actionLoop = loop;
      if (def.randomEye) this.winkRight = Math.random() < 0.5;
      // 动作独占：关闭自动眨眼/随机晃头/待机微动，避免干扰动作
      this.setAuto(false);
    }
  }

  stopAction() {
    this.action = null;
    this.actionT = 0;
    this.actionLoop = false;
    this.setAuto(true);
  }

  /** 动作独占开关：统一管理自动眨眼/随机微动/待机晃动 */
  private setAuto(on: boolean) {
    this.runtime.autoBlinkOn = on;
    this.runtime.autoRandOn = on;
    this.runtime.autoIdleOn = on;
    this.runtime.randomGazeWeight = on ? 1 : 0;
  }

  setSwayEnabled(on: boolean) {
    this.swayEnabled = on;
  }

  /** 模型显示尺寸：窗口跟随缩放时，canvas 显示尺寸同步为窗口边长 */
  setScale(displayW: number) {
    this.displayW = displayW;
    const px = `${Math.round(displayW)}px`;
    this.canvas.style.maxWidth = px;
    this.canvas.style.maxHeight = px;
  }

  /** 角色在窗口内的边界（相对窗口左上，逻辑 px，含缩放），供模型边缘补偿 */
  getCharacterBounds(): { left: number; top: number; right: number; bottom: number } | null {
    const cb = this.runtime.characterBounds;
    if (!cb) return null;
    const s = this.displayW / this.runtime.canvasWidth;
    const offsetX = (700 - this.displayW) / 2;
    const offsetY = (700 - this.displayW) / 2;
    // 用户自定义边界微调（正 = 放大框，负 = 收紧框）
    const pad = this.boundsPad;
    return {
      left: offsetX + cb.left * s - pad.left,
      top: offsetY + cb.top * s - pad.top,
      right: offsetX + cb.right * s + pad.right,
      bottom: offsetY + cb.bottom * s + pad.bottom,
    };
  }

  private boundsPad = { left: 0, right: 0, top: 0, bottom: 0 };
  setBoundsPadding(p: { left: number; right: number; top: number; bottom: number }) {
    this.boundsPad = p;
  }
}
