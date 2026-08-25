import type { RigParams } from "./psd/PsdRuntime";

/**
 * PSD 通用动作只使用基础面部参数，避免依赖特定模型的身体图层。
 */
export interface ActionKeyframe {
  t: number;
  params: Partial<RigParams>;
}

export interface ActionDef {
  id: string;
  label: string;
  duration: number;
  randomEye?: boolean;
  pool?: "low" | "mid";
  keys: ActionKeyframe[];
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export const ACTIONS: ActionDef[] = [
  {
    id: "nod",
    label: "点头",
    duration: 1.2,
    pool: "low",
    keys: [
      { t: 0, params: { angleY: 0 } },
      { t: 0.5, params: { angleY: -1 } },
      { t: 1, params: { angleY: 0 } },
    ],
  },
];

export function findAction(id: string): ActionDef | undefined {
  return ACTIONS.find((action) => action.id === id);
}

export function pickPoolAction(_level: "low" | "mid" | "high"): ActionDef | null {
  return ACTIONS[0] ?? null;
}

/** 按进度采样动作参数，关键帧之间使用 smoothstep 插值。 */
export function sampleAction(action: ActionDef, progress: number): Partial<RigParams> {
  const keys = action.keys;
  if (keys.length === 0) return {};
  if (progress <= keys[0].t) return { ...keys[0].params };
  if (progress >= keys[keys.length - 1].t) return { ...keys[keys.length - 1].params };

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (progress < a.t || progress > b.t) continue;
    const local = smooth((progress - a.t) / (b.t - a.t || 1));
    const out: Partial<RigParams> = {};
    const from = a.params as Record<string, number>;
    const to = b.params as Record<string, number>;
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      (out as unknown as Record<string, number>)[key] =
        (from[key] ?? 0) + ((to[key] ?? 0) - (from[key] ?? 0)) * local;
    }
    return out;
  }

  return { ...keys[keys.length - 1].params };
}
