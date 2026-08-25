export type PetEmotion = "neutral" | "shy" | "disgust" | "surprised";

export const PET_EMOTIONS: readonly PetEmotion[] = ["neutral", "shy", "disgust", "surprised"];

export const EMOTION_DURATIONS_MS: Readonly<Record<PetEmotion, number>> = {
  neutral: 0,
  shy: 10000,
  disgust: 8500,
  surprised: 4500,
};

export function normalizeEmotion(value: unknown): PetEmotion | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (PET_EMOTIONS as readonly string[]).includes(normalized)
    ? normalized as PetEmotion
    : null;
}

/** AI 未按协议返回 emotion 时的本地兜底；只匹配较明确的情绪措辞，避免频繁误触。 */
export function inferEmotion(userText: string, assistantText: string): PetEmotion {
  const text = `${userText}\n${assistantText}`.toLowerCase();
  if (/(嫌弃|恶心|反胃|变态|离我远点|好脏|讨厌死了|无语|啧|咦惹|噫)/u.test(text)) return "disgust";
  if (/(震惊|惊讶|没想到|居然|竟然|天哪|我的天|不会吧|真的假的|哇[！!]|什么[？?！!]{1,})/u.test(text)) return "surprised";
  if (/(害羞|脸红|不好意思|别夸了|喜欢你|好可爱|真可爱|心动|嘿嘿|\/{3})/u.test(text)) return "shy";
  return "neutral";
}
