import { useNode, useVueFlow } from "@vue-flow/core";
import { useNodeAi, useNodeFiles, type NodeImageRequest, type NodeImageResult } from "@toonflow/nodes-scaffold/runtime";
import { showNodeError } from "./showNodeError";

export type ImageInpaint = { source: string; original: string; guide: string; mask: string; images: NonNullable<NodeImageRequest["images"]> };
export type InpaintDraftInput = { prompt: string; images?: NodeImageRequest["images"] };

const inpaintInstruction = "对父节点提供的第一张原图片进行局部重绘。第二张图片是同一原图的标注图，红色涂抹标出了需要修改的区域；红色仅用于指示选区，不要把标注画进结果。只修改标注区域，保留原图的构图、尺寸比例和区域外内容，返回完整图片。";

export function buildInpaintPrompt(prompt: string) {
  return prompt.startsWith(inpaintInstruction) ? prompt : `${inpaintInstruction}\n\n重绘要求：\n${prompt}`;
}

// 蒙版里有没有涂过的像素。蒙版本身不参与合成，这里只用来拦住「什么都没涂就生成」。
function maskHasPaint(mask: HTMLImageElement) {
  if (!mask.naturalWidth || !mask.naturalHeight) return false;
  const canvas = document.createElement("canvas");
  canvas.width = mask.naturalWidth;
  canvas.height = mask.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.drawImage(mask, 0, 0);
  const painted = context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value);
  canvas.width = canvas.height = 0;
  return painted;
}

export function useImageInpaint() {
  const { id, node } = useNode();
  const { findNode } = useVueFlow();
  const files = useNodeFiles();
  const ai = useNodeAi();

  return async function generateInpaint(input: NodeImageRequest, inpaint: ImageInpaint, signal: AbortSignal): Promise<NodeImageResult[]> {
    signal.throwIfAborted();
    if (!inpaint || ![inpaint.original, inpaint.guide, inpaint.mask].every(path => typeof path === "string" && path.trim())
      || !Array.isArray(inpaint.images) || inpaint.images.some(image => !image || typeof image.path !== "string" || !image.path.trim() || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/"))) {
      throw new Error("局部重绘素材无效，请重新创建重绘节点");
    }
    const workspace = files.getWorkspaceFiles();
    const urls: string[] = [];

    async function readImage(path: string, mimeType = "image/png") {
      const content = await workspace.read(path);
      signal.throwIfAborted();
      const image = new Image();
      const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
      urls.push(url);
      image.src = url;
      await image.decode();
      signal.throwIfAborted();
      return image;
    }

    try {
      const original = await readImage(inpaint.original);
      const mask = await readImage(inpaint.mask);
      const guide = await readImage(inpaint.guide);
      if (!original.naturalWidth || !original.naturalHeight || [mask, guide].some(image => image.naturalWidth !== original.naturalWidth || image.naturalHeight !== original.naturalHeight)) {
        throw new Error("局部重绘原图、引导图与蒙版尺寸不一致，请重新创建重绘节点");
      }
      // 蒙版本身不参与合成，但空蒙版等于没告诉模型要改哪里——早点拦住，别浪费一次生成。
      if (!maskHasPaint(mask)) throw new Error("局部重绘蒙版为空，请重新涂抹区域");
      const { directory } = await workspace.list();
      signal.throwIfAborted();
      // ACT: 工作流没有原生 mask 通道，用「原图 + 红色标注图」引导模型重绘。
      // 成图直接用模型输出的整张——模型除选区外通常还会做必要的融合修改（色调、光线衔接），
      // 按蒙版裁剪会把这部分丢掉，还会在边界留下生硬的接缝。
      // 输出直接落在本节点目录（input.outputDirectory 由调用方给），不要写临时目录再搬：
      // 直出时没有搬运步骤，临时目录会在 finally 里被删掉，返回的路径就失效了（404）。
      const [result] = await ai.generateImage({
        ...input,
        directory,
        images: [{ path: inpaint.original, mimeType: "image/png" }, { path: inpaint.guide, mimeType: "image/png" }, ...inpaint.images, ...(input.images ?? [])],
        prompt: buildInpaintPrompt(input.prompt),
      }, signal);
      signal.throwIfAborted();
      if (!result) throw new Error("供应商未返回图片");
      if (findNode(id) !== node) throw new Error("重绘节点已移除");
      return [result];
    } finally {
      urls.forEach(url => URL.revokeObjectURL(url));
    }
  };
}
