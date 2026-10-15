import type { NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";
import { isImageCapableModel } from "./imageCapable";

/**
 * 玩法新建子节点的默认分辨率：百万像素档位「2」。
 *
 * 为什么写死一个数而不是沿用宿主节点的档位：玩法出图是「照着参考图改」（打光、多角度、
 * 局部重绘、动漫转真人、全景图），宿主节点上那个档位是用户给**文生图**挑的，
 * 两者没有继承关系；统一 2MP 既能保证画质，又不会一上来就跑 4MP 拖慢出图。
 */
export const PLAYBOOK_MEGAPIXELS = "2";

/**
 * 玩法默认模型：Qwen Image 2.1 图像编辑（providerId `qwenImageEdit`、modelId `qwen_image_edit`）。
 * 它带参考图通道（mode 含 singleImage / multiReference），是上面这些玩法的实际执行者——
 * 玩法要「照着原图改」，纯文生图模型吃不下参考图。
 * 匹配放宽到「providerId 命中」或「名称带『图像编辑』且能接参考图」，
 * 这样用户重命名供应商 / 换成同类的编辑工作流时也还能自动选中。
 */
const PREFERRED_PROVIDER = "qwenImageEdit";
const PREFERRED_MODEL = "qwen_image_edit";
const PREFERRED_LABEL_HINT = "图像编辑";

function isPreferredEditModel(item: NodeMediaModel) {
  if (!isImageCapableModel(item)) return false;
  return item.providerId === PREFERRED_PROVIDER || item.modelId === PREFERRED_MODEL || (item.label ?? "").includes(PREFERRED_LABEL_HINT);
}

/**
 * 挑玩法要用的模型：
 * ① Qwen Image 2.1 图像编辑（存在就用它，玩法默认就是它）；
 * ② 宿主节点当前选的模型，前提是它能接参考图（用户明确换过模型时尊重用户）；
 * ③ 第一个能接参考图的；
 * ④ 一个都没有才退到列表首项——让面板照常打开，由用户自己换。
 */
export function pickPlaybookModel(items: NodeMediaModel[], hostId?: string): NodeMediaModel | undefined {
  const preferred = items.find(isPreferredEditModel);
  if (preferred) return preferred;
  const host = typeof hostId === "string" && hostId.trim() ? items.find(item => modelIdOf(item) === hostId) : undefined;
  if (host && isImageCapableModel(host)) return host;
  return items.find(item => isImageCapableModel(item)) ?? items[0];
}

/** 模型在节点 data.model 里的存档形态：`["providerId","modelId"]`。 */
export function modelIdOf(item: NodeMediaModel) {
  return JSON.stringify([item.providerId, item.modelId]);
}

/**
 * 在模型声明的档位里挑最接近 `preferred` 的一项（精确命中优先）。
 * 档位不含 "2" 时（例如某些模型只有 1 / 4），取数值最近的而不是最小档，
 * 免得默认分辨率掉到最低画质。
 */
export function nearestSize(options: string[], preferred = PLAYBOOK_MEGAPIXELS) {
  if (!options.length) return preferred;
  if (options.includes(preferred)) return preferred;
  const target = Number.parseFloat(preferred);
  const numeric = options.map(value => ({ value, number: Number.parseFloat(value) })).filter(item => Number.isFinite(item.number));
  if (!Number.isFinite(target) || !numeric.length) return options[0]!;
  return numeric.sort((left, right) => Math.abs(left.number - target) - Math.abs(right.number - target))[0]!.value;
}
