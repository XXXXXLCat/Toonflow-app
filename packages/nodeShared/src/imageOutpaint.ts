import { z } from "@toonflow/nodes-scaffold/runtime";

// 扩图的方向决定目标比例往哪边偏：横向把画面拉宽，纵向把画面拉高，四周保持原比例。
export const outpaintDirections = [
  { id: "all", label: "四周" },
  { id: "horizontal", label: "左右" },
  { id: "vertical", label: "上下" },
  { id: "left", label: "向左" },
  { id: "right", label: "向右" },
  { id: "top", label: "向上" },
  { id: "bottom", label: "向下" },
] as const;

export type OutpaintDirection = (typeof outpaintDirections)[number]["id"];

const outpaintSchema = z.object({
  direction: z.string().refine((value): value is OutpaintDirection => outpaintDirections.some(item => item.id === value)).catch("all"),
  // 扩展幅度只对「往某个方向扩」有意义：1.1 微调构图，3 大幅补环境。
  scale: z.number().finite().transform(value => Math.max(1.1, Math.min(3, value))).catch(1.5),
  desc: z.string().catch(""),
  model: z.string().catch(""),
  size: z.string().catch(""),
  ratio: z.string().catch(""),
  // 扩图推荐用的 LoRA（补全画面外新露出的区域）。新建子节点时随 settings 一起下发。
  loras: z.array(z.object({ name: z.string(), strength: z.number() })).catch([]),
  rewritePrompt: z.boolean().catch(true),
});
export type OutpaintSettings = z.infer<typeof outpaintSchema>;

export function readOutpaintSettings(value: unknown): OutpaintSettings {
  return outpaintSchema.parse(value && typeof value === "object" && !Array.isArray(value) ? value : {});
}

// 找出最接近目标比例的整数比。直接乘 1000 再约分会得到「2667:1000」这种没法看的字符串，
// 而比例只是展示与存档用——真正的宽高由供应商按面积重算，所以这里取小分母的近似就够。
function approximateRatio(value: number) {
  let best = { error: Infinity, width: 1, height: 1 };
  for (let height = 1; height <= 64; height++) {
    const width = Math.max(1, Math.round(value * height));
    // 在对数空间比较误差，宽高比才有可比性（2:1 与 1:2 的偏差应当等价）。
    const error = Math.abs(Math.log(width / height / value));
    if (error < best.error - 1e-9) best = { error, width, height };
  }
  return `${best.width}:${best.height}`;
}

// 原图比例 × 方向 × 幅度 → 目标比例，交给供应商按面积算宽高。
export function getOutpaintRatio(sourceRatio: number, direction: OutpaintDirection, scale: number) {
  const settings = readOutpaintSettings({ direction, scale });
  const base = Number.isFinite(sourceRatio) && sourceRatio > 0 ? sourceRatio : 1;
  const factor = settings.direction === "all" ? 1 : settings.scale;
  const widens = settings.direction === "horizontal" || settings.direction === "left" || settings.direction === "right";
  const ratio = widens ? base * factor : base / factor;
  return approximateRatio(ratio);
}

const DIRECTION_TEXT: Record<OutpaintDirection, string> = {
  all: "outward on all four sides",
  horizontal: "to the left and right",
  vertical: "upward and downward",
  left: "to the left",
  right: "to the right",
  top: "upward",
  bottom: "downward",
};

export function buildOutpaintPrompt(settings: OutpaintSettings) {
  const direction = DIRECTION_TEXT[settings.direction] ?? DIRECTION_TEXT.all;
  return [
    "Use reference image {{ref 1}} as the fixed core content of the output. Keep the original subject, its size, its position within the frame, its pose, its colors, its materials and the overall visual style unchanged.",
    `Extend the canvas ${direction} and fill the newly revealed area with content that plausibly belongs to the same scene, continuing the same environment, perspective, scale, lighting direction and atmosphere.`,
    settings.desc.trim() ? `Additional guidance for the extended area: ${settings.desc.trim()}` : "",
    "The result must read as one single coherent photograph. Do not crop, zoom out, restyle or reinterpret the original content, and do not repeat or mirror the subject into the new area. No borders, no seams, no panels, no grids, no text and no watermarks.",
  ].filter(Boolean).join("\n");
}
