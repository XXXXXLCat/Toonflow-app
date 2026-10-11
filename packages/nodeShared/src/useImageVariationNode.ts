import { inject, nextTick } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import type { NodeImageRequest } from "@toonflow/nodes-scaffold/runtime";
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

/**
 * 玩法自带的额外参考图（如「制作资产」的版式引导图）。
 *
 * 为什么走「先落盘、再存路径」而不是直接把 data URI 交给供应商：
 * 节点请求的 images 通道收的是**工作区文件路径**，供应商按路径读文件上传到 ComfyUI。
 * 因此额外参考图必须先写进新节点自己的目录，再把路径挂到子节点 data 上；
 * 子节点生成时（`startGeneration`）把它并入 images 数组，编号顺延在连线参考图之后。
 *
 * 落盘文件名固定（`guide.<ext>`），重跑时直接覆盖，不会在节点目录里堆垃圾。
 */
export async function persistVariationImages(files: { getWorkspaceFiles(): { mkdir(path: string): Promise<void>; write(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean): Promise<void> } }, nodeId: string, images: { url: string; mimeType?: string; name: string }[]) {
  if (!images.length) return;
  const workspace = files.getWorkspaceFiles();
  const directory = `assets/${nodeId}`;
  for (const path of ["assets", directory]) {
    await workspace.mkdir(path).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "EEXIST") throw error;
    });
  }
  for (const image of images) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(image.url);
    if (!match) throw new Error(`引导参考图 ${image.name} 不是内联数据，无法保存`);
    // 走 Blob 而不是 ArrayBuffer/Buffer：与 uploadNodeFile 一致，且是 write 签名里的正式形态。
    const binary = atob(match[2]!);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    await workspace.write(`${directory}/${image.name}`, new Blob([bytes], { type: match[1] }), false);
  }
}

export function useImageVariationNode(options?: { nodeType?: string }) {
  const { id, node } = useNode();
  const { addNodes, addEdges, removeNodes, findNode, getNodes, nodeTypes } = useVueFlow();
  const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());

  return async function createVariation(input: { label: string; prompt: string; model: string; size: string; ratio: string; rewritePrompt?: boolean; loras?: { name: string; strength: number }[]; multiplier?: string; nodeId?: string; inpaint?: ImageInpaint; extraImages?: NonNullable<NodeImageRequest["images"]>; guideImage?: { path: string; mimeType: string; label: string } }, signal?: AbortSignal) {
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
        // guideImage 是「当前这张额外参考图是什么」的一句话标记（如「制作资产 · 三头版式」）。
        // 只用于在节点底栏把那行隐藏的额外参考显示出来，不参与生成；extraImages 才是真正下发的路径。
        // 缺了它画布上就看不出「这张板是照哪个版式生成的」——用户反映过这个不可见的问题。
        const data: Record<string, unknown> = { label: `${node.data.label || "图片"} · ${label}`, model, [variationSizeKey(type)]: size, ratio, prompt, promptModel, ...(type === VARIATION_NODE.comfyui ? { rewritePrompt: input.rewritePrompt ?? false, ...(input.loras?.length ? { loras: input.loras } : {}), ...(input.multiplier ? { multiplier: input.multiplier } : {}) } : {}), ...(input.inpaint ? { inpaint: input.inpaint } : {}), ...(input.extraImages?.length ? { extraImages: input.extraImages } : {}) };
        if (input.guideImage) data.guideImage = input.guideImage;
        addNodes({ id: nodeId, type, position: { x, y }, data });
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
