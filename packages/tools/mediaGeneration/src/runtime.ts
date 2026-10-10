import { z } from "zod";

export type { MediaModel, MediaReference, MediaGenerationRequest, GeneratedMedia, MediaContext } from "@toonflow/tools-scaffold/runtime";

const relativePath = z.string().min(1).max(2048).refine(
  path => !/^[\\/]|[:\u0000-\u001f]/.test(path) && path.split(/[\\/]/).every(part => part && part !== "." && part !== ".."),
  "路径必须是工作区内的相对路径，不能包含空路径段或 ..",
);
const imageReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i) });
const videoReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^video\/[a-z0-9.+-]+$/i) });
// text 是该参考音频的转写内容，复刻音色的供应商用它做对齐；不填时供应商沿用自己的默认值。
const audioReference = z.strictObject({
  path: relativePath,
  mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i),
  text: z.string().trim().min(1).max(100000).optional(),
});
const sharedFields = {
  providerId: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/),
  modelId: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(100000),
  outputDirectory: relativePath.optional(),
  images: z.array(imageReference).max(64).optional(),
  ratio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
};
const referenceMode = z.templateLiteral([z.enum(["image", "video", "audio"]), "Reference:", z.number()])
  .refine(value => /Reference:(?:[1-9]\d?|1\d{2}|2[0-4]\d|25[0-6])$/.test(value), "参考数量必须在 1 到 256 之间");

export const listMediaModelsSchema = z.strictObject({});
// 可叠加的 LoRA：按数组顺序依次应用，最多 12 条（ComfyUI 堆叠节点的槽位数）。
// name 是 ComfyUI 的「目录\文件名」全路径形式，供应商原样填进堆叠节点；
// strength 是 -10~10 的权重，与堆叠节点同口径，缺省 1（=100% 效果），负值表示反转。
const loraEntry = z.strictObject({
  name: z.string().trim().min(1).max(512),
  strength: z.number().finite().min(-10).max(10).optional(),
});
export const imageGenerationSchema = z.strictObject({
  ...sharedFields,
  size: z.string().trim().min(1).max(64).optional(),
  loras: z.array(loraEntry).max(12).optional(),
  // 放大倍数：只放大/超分类模型消费（SeedVR2 等），范围 1.5~4，缺省由供应商决定。
  multiplier: z.number().finite().min(1.5).max(4).optional(),
});
export const videoGenerationSchema = z.strictObject({
  ...sharedFields,
  videos: z.array(videoReference).max(64).optional(),
  audios: z.array(audioReference).max(64).optional(),
  firstFrame: imageReference.optional(),
  lastFrame: imageReference.optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  duration: z.number().finite().positive().max(3600).optional(),
  generateAudio: z.boolean().optional(),
  // 与图片同一个 LoRA 通道；只有工作流里接了堆叠节点的供应商会消费，其余忽略。
  loras: z.array(loraEntry).max(12).optional(),
  mode: z.union([
    z.enum(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text"]),
    z.array(referenceMode).min(1).max(3),
  ]).optional(),
});
export const audioGenerationSchema = z.strictObject({
  providerId: sharedFields.providerId,
  modelId: sharedFields.modelId,
  prompt: sharedFields.prompt,
  outputDirectory: sharedFields.outputDirectory,
  images: sharedFields.images,
  audios: z.array(audioReference).max(64).optional(),
  instruction: z.string().trim().min(1).max(100000).optional(),
  voice: z.string().trim().min(1).max(256).optional(),
  speed: z.number().finite().positive().optional(),
  volume: z.number().finite().optional(),
  pitch: z.number().finite().optional(),
  language: z.string().trim().min(1).max(64).optional(),
  format: z.string().trim().min(1).max(64).optional(),
  quality: z.string().trim().min(1).max(64).optional(),
  sampleRate: z.number().int().positive().optional(),
  // 各供应商宿主节点的 seed 类型不同（Breeze 是 32 位 INT，KSampler 是 64 位），上限交给供应商校验。
  seed: z.number().int().min(0).optional(),
  // 供应商专属通道：音频工作流的参数差异太大（YuE2 的 mode / max_duration），不便逐项进白名单，
  // 统一放这里由供应商自己解释。形状由供应商负责校验，宿主只做大小与嵌套深度的兜底限制。
  other: z.record(z.string(), z.unknown()).optional(),
});
