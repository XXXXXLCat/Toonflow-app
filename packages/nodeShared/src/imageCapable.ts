import type { NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";

/**
 * 能吃参考图的模式（mode 由供应商模型声明）：`text` 是纯文生图，喂不进参考图。
 * 数组型 mode 表示一次生成里混合了多类参考（如 imageReference + videoReference），同样算能接图。
 */
export const IMAGE_CAPABLE_MODES = ["singleImage", "multiReference"];

/**
 * 该模型能否接参考图（图生图 / 编辑类）。
 *
 * 玩法（打光、多角度、局部重绘…）一律要拿当前节点的出图当参考图，
 * 纯文生图模型吃不下，所以「能不能用」由这个函数判，而不是看节点上选了什么模型。
 */
export function isImageCapableModel(model?: Pick<NodeMediaModel, "mode"> | null) {
  return (model?.mode ?? []).flat().some((mode) => IMAGE_CAPABLE_MODES.includes(mode));
}
