import { inject, nextTick } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import type { ImageInpaint } from "./imageInpaint";

export const VARIATION_NODE = { builtin: "remote-imageGenerationNode", comfyui: "remote-comfyuiImageNode" } as const;

// 「自适应」不是 W:H 比例：选中它表示比例跟随参考图，供应商据此让主 latent 取参考图编码，节点也不下发 ratio。
// 局部重绘必须用这个值——生成图若与原图比例不同，按蒙版合成时会被拉伸变形。
export const AUTO_RATIO = "自适应";

// 不同承载节点存放尺寸的数据键不同：内置图片生成节点用 size（分辨率档位），ComfyUI 图片节点用 megapixels（百万像素）。
export function variationSizeKey(nodeType: string) {
  return nodeType === VARIATION_NODE.comfyui ? "megapixels" : "size";
}

// 玩法自带的推荐 LoRA：目录名是 Qwen-Image-2.1（与两个 qwen 工作流的底模一致）。
// 只在 ComfyUI 图片节点上生效——内置节点没有 LoRA 通道。找不到文件时供应商会报明确错误。
const RECOMMENDED_LORA_DIR = "Qwen-Image-2.1";

/** 可选 LoRA 的目录（= 底模归属）。跨底模混用会让 ComfyUI 直接报错，所以按底模过滤。 */
export const LORA_FOLDERS = {
  /** Qwen Image 2.1 的文生图 / 图生图工作流。 */
  qwen: [RECOMMENDED_LORA_DIR, "qwen"],
  /** MiniMax-H3 视频工作流。 */
  minimax: ["MiniMax-H3"],
} as const;

const RECOMMENDED_LORAS = {
  // 全景：把参考图转成 720°/360° 等距柱状贴图，球面与圆柱都要拉得开。
  panorama: `${RECOMMENDED_LORA_DIR}\\pano360_qwen21_edit_v1.safetensors`,
  // 扩图：补全画面外新露出的区域。
  outpaint: `${RECOMMENDED_LORA_DIR}\\qwen-image-2.1-outpaint-v2.safetensors`,
  // 动漫转真人：只换渲染方式不换画面。
  animeToReal: `${RECOMMENDED_LORA_DIR}\\Qwen2.1_Anything2RealCharacters.safetensors`,
  // 局部重绘：压住重绘带来的整体漂移，让选区外的构图与色调尽量贴近原图。
  inpaint: `${RECOMMENDED_LORA_DIR}\\qwen-image-2.1-consistency.safetensors`,
} as const;

/** 取某个玩法推荐的 LoRA；强度按玩法给定（都是 1 = 100% 效果）。 */
export function recommendedLora(kind: keyof typeof RECOMMENDED_LORAS, strength = 1) {
  return [{ name: RECOMMENDED_LORAS[kind], strength }];
}

const NODE_LABELS: Record<string, string> = {
  [VARIATION_NODE.builtin]: "图片生成节点",
  [VARIATION_NODE.comfyui]: "ComfyUI 图片节点",
};

export function useImageVariationNode(options?: { nodeType?: string }) {
  const { id, node } = useNode();
  const { addNodes, addEdges, removeNodes, findNode, getNodes, nodeTypes } = useVueFlow();
  const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());

  return async function createVariation(input: { label: string; prompt: string; model: string; size: string; ratio: string; rewritePrompt?: boolean; loras?: { name: string; strength: number }[]; multiplier?: string; nodeId?: string; inpaint?: ImageInpaint }, signal?: AbortSignal) {
    const type = options?.nodeType ?? VARIATION_NODE.builtin;
    signal?.throwIfAborted();
    if (!nodeTypes?.value?.[type]) throw new Error(`请先启用${NODE_LABELS[type] ?? type}插件`);
    if (findNode(id) !== node) throw new Error("原节点已变化，请重新操作");
    const nodeId = input.nodeId ?? crypto.randomUUID();
    const edgeId = crypto.randomUUID();
    const { label, prompt, model, size, ratio } = input;
    const [ratioWidth = 0, ratioHeight = 0] = ratio.split(":").map(Number);
    const outputWidth = Number.isFinite(ratioWidth / ratioHeight) && ratioWidth > 0 && ratioHeight > 0 ? Math.max(320, 240 * ratioWidth / ratioHeight + 18) : 320;
    const x = node.computedPosition.x + (node.dimensions.width || 320) + 80;
    let y = node.computedPosition.y;
    for (const other of [...getNodes.value].sort((left, right) => left.computedPosition.y - right.computedPosition.y)) {
      const position = other.computedPosition;
      if (position.x < x + outputWidth && position.x + (other.dimensions.width || 320) > x && position.y < y + 300 && position.y + (other.dimensions.height || 300) > y) {
        y = position.y + (other.dimensions.height || 300) + 40;
      }
    }
    await batchHistory(async () => {
      signal?.throwIfAborted();
      try {
        // 玩法可以预置推荐的 LoRA（如全景配 pano360）；只有 ComfyUI 图片节点认 loras 字段。
        // 放大（SeedVR2 等）同理：只有 ComfyUI 图片节点认 multiplier 字段，且它没有 LoRA / 尺寸通道。
        // 提示词为空时不要塞 [""] —— promptInput 会渲染出一个空行，而放大节点的输入框本就不显示。
        const promptModel = prompt ? prompt.split("\n").map(text => [{ type: "Write" as const, text }]) : [];
        addNodes({ id: nodeId, type, position: { x, y }, data: { label: `${node.data.label || "图片"} · ${label}`, model, [variationSizeKey(type)]: size, ratio, prompt, promptModel, ...(type === VARIATION_NODE.comfyui ? { rewritePrompt: input.rewritePrompt ?? true, ...(input.loras?.length ? { loras: input.loras } : {}), ...(input.multiplier ? { multiplier: input.multiplier } : {}) } : {}), ...(input.inpaint ? { inpaint: input.inpaint } : {}) } });
        addEdges({ id: edgeId, source: id, sourceHandle: "image", target: nodeId, targetHandle: "in" });
      } catch (error) {
        removeNodes(nodeId, true, false);
        throw error;
      }
      await nextTick();
    });
    return { nodeId, edgeId };
  };
}
