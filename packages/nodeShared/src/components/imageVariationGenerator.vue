<template>
  <footer class="variationFooter">
    <el-select v-model="settings.model" class="modelSelect" filterable :loading="modelsLoading" :disabled="busy" placeholder="选择图片模型" :aria-label="`${label}模型`" noDataText="请先在设置中添加图片模型" placement="top-start" @visible-change="visible => visible && refreshModels()">
      <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
        <el-option v-for="model in provider.models" :key="model.modelId" :label="model.label" :value="JSON.stringify([model.providerId, model.modelId])" />
      </el-option-group>
    </el-select>
    <el-popover trigger="click" placement="top" :width="240" :disabled="busy || !selectedModel" :showArrow="false">
      <template #reference><el-button class="sizeButton" text :disabled="busy || !selectedModel" :aria-label="`${label}输出设置`">{{ settingsSummary }}</el-button></template>
      <div class="variationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @wheel.stop @keydown.stop>
        <label>分辨率<el-select v-model="settings.size" :disabled="busy" :aria-label="`${label}分辨率`"><el-option v-for="size in sizeOptions" :key="size" :label="size" :value="size" /></el-select></label>
        <label>比例<el-select v-model="settings.ratio" :disabled="busy" :aria-label="`${label}比例`"><el-option v-for="ratio in ratioOptions" :key="ratio" :label="ratio" :value="ratio" /></el-select></label>
        <!-- 只有工作流类承载节点带提示词改写分支，内置图片生成节点没有这一项，不给开关。 -->
        <div v-if="supportsRewrite" class="switchControl"><span>重写提示词</span><el-switch v-model="settings.rewritePrompt" :disabled="busy" aria-label="重写提示词" /></div>
      </div>
    </el-popover>
    <el-button type="primary" :icon="IconSparkles" :loading="generating" :disabled="busy || modelsLoading || !source || !selectedModel || !prompt.trim()" @click="generate">{{ buttonLabel ?? '生成图片' }}</el-button>
  </footer>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { ElButton, ElOption, ElOptionGroup, ElPopover, ElSelect, ElSwitch } from "element-plus";
import { IconSparkles } from "@tabler/icons-vue";
import { useNodeAi, useNodeFiles, useNodeToolsContext, type NodeMediaModel, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useImageVariationNode, variationSizeKey, VARIATION_NODE, AUTO_RATIO, persistVariationImages } from "@toonflow/node-shared/useImageVariationNode";

const props = defineProps<{
  settings: { model: string; size: string; ratio: string; rewritePrompt?: boolean };
  source?: NodeMediaValue;
  aspectRatio: number;
  prompt: string;
  label: string;
  buttonLabel?: string;
  disabled?: boolean;
  /** 生成的子节点类型，默认内置图片生成节点；传 ComfyUI 图片节点时尺寸落成 megapixels。 */
  nodeType?: string;
  /**
   * 玩法预置的额外参考图。内容为内联 data URI，生成时先落盘到新节点目录、再把路径挂到子节点，
   * 子节点生成时并入 images 数组（排在连线参考图之后）。典型用途：「制作资产」的版式引导图。
   */
  extraImages?: { path: string; mimeType: string }[];
  /**
   * 额引导参考图的名称（如「三头版式」）。只用于在新节点底栏把它显示出来——
   * 额外参考图不走连线，不在底栏点明的话画布上看不出「这张板照的是哪个版式」。
   * 不给就只显示额外参考图本身，不带名称。
   */
  guideLabel?: string;
  /**
   * 锁定比例：不让面板把比例改成「自适应」。
   * 默认行为是「自适应」（出图比例跟随参考图），对局部重绘/打光这类**要求与原图同比例**的玩法是对的；
   * 但「制作资产」的版式自带固定画幅（单头 16:9、双头与三头 4:3），参考图却是 9:16 竖版立绘——
   * 走「自适应」会把板拉成竖版、版式全废。所以这种玩法要自己指定比例并锁住。
   */
  lockedRatio?: boolean;
  /**
   * 重写提示词的默认值。不传时沿用本节点的存档值（多数玩法「跟随上一次」即可）；
   * 「制作资产」传 false —— 它的提示词是逐字写死的版式结构，被工作流改写等于版式废掉。
   * 同时它会**覆盖**从父节点继承来的值，不让父节点那次实验留下的开关漏进来。
   */
  rewriteDefault?: boolean;
}>();
const emit = defineEmits<{ generated: [] }>();
const generating = defineModel<boolean>("generating", { default: false });
const { id, node } = useNode();
const { findNode, getEdges } = useVueFlow();
const ai = useNodeAi();
const files = useNodeFiles();
const getNodeTools = useNodeToolsContext();
const createVariation = useImageVariationNode({ nodeType: props.nodeType });
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const busy = computed(() => props.disabled || generating.value);
const modelGroups = computed(() => groupNodeModels(models.value));
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === props.settings.model));
const sizeOptions = computed(() => selectedModel.value?.imageSizes?.length ? selectedModel.value.imageSizes : ["2K"]);
// 工作流类承载节点的尺寸档位是百万像素，内置节点是分辨率档位，显示时补上单位才不会看错。
const supportsRewrite = computed(() => (props.nodeType ?? VARIATION_NODE.builtin) === VARIATION_NODE.comfyui);
// 扩图会算出模型没声明的动态比例（如 8:3），不并进选项就会被下面的 nearestRatio 校正回档位。
// 「自适应」也是本地约定而非模型声明的档位，同理要并进去。
const ratioOptions = computed(() => {
  const declared = selectedModel.value?.imageRatios?.length ? selectedModel.value.imageRatios : ["16:9"];
  // 锁定比例的玩法（制作资产）不提供「自适应」档位：画幅由版式决定，选了也会被覆盖回去，
  // 留着只会让用户以为能选。
  const base = supportsRewrite.value && !props.lockedRatio ? [...declared, AUTO_RATIO] : declared;
  const current = props.settings.ratio?.trim();
  return current && !base.includes(current) ? [current, ...base] : base;
});
const sizeSummary = computed(() => props.settings.size ? `${props.settings.size}${supportsRewrite.value ? "MP" : ""}` : "分辨率");
const settingsSummary = computed(() => [props.settings.ratio || "比例", sizeSummary.value, ...(supportsRewrite.value ? [props.settings.rewritePrompt ? "重写" : "原文"] : [])].join(" · "));
let generationController: AbortController | undefined;
let disposed = false;
let inheritModelConfig = true;

/**
 * 在模型声明的档位里找最接近的比例。
 * 基准默认取源图比例（多数玩法要求出图与原图同比例）；
 * 锁定比例的玩法要传自己的目标比例——它的出图比例不跟源图走（制作资产的源图是 9:16 立绘，
 * 目标却是 16:9 / 4:3 的板），拿源图当基准会把比例校正歪。
 */
function nearestRatio(target?: number) {
  const reference = target ?? props.aspectRatio;
  const numeric = ratioOptions.value.map(value => ({ value, number: value.split(":").map(Number).reduce((width, height) => width / height) })).filter(item => Number.isFinite(item.number) && item.number > 0);
  return reference && numeric.length ? numeric.sort((left, right) => Math.abs(Math.log(left.number / reference)) - Math.abs(Math.log(right.number / reference)))[0]!.value : ratioOptions.value[0]!;
}

/** 锁定比例时要保住的目标比例：由面板指定的比例字符串换算而来。 */
function lockedRatioTarget() {
  const [width, height] = props.settings.ratio.split(":").map(Number);
  return width && height ? width / height : undefined;
}

watch(selectedModel, choice => {
  if (!choice) return;
  if (!sizeOptions.value.includes(props.settings.size)) props.settings.size = sizeOptions.value.toSorted((left, right) => (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity))[0]!;
  if (!ratioOptions.value.includes(props.settings.ratio)) props.settings.ratio = nearestRatio(props.lockedRatio ? lockedRatioTarget() : undefined);
}, { flush: "sync" });
watch(() => [props.source?.url, props.source?.mimeType], () => generationController?.abort(), { flush: "sync" });
onMounted(refreshModels);
onScopeDispose(() => { disposed = true; generationController?.abort(); });

async function refreshModels() {
  if (modelsLoading.value || busy.value) return;
  modelsLoading.value = true;
  try {
    const result = await ai.getMediaModels();
    if (disposed) return;
    if (inheritModelConfig) {
      // 尺寸键按承载节点走：ComfyUI 节点上叫 megapixels，其余叫 size。
      for (const [key, sourceKey] of [["model", "model"], ["size", variationSizeKey(props.nodeType ?? VARIATION_NODE.builtin)]] as const) {
        const value = (node.data as Record<string, unknown>)[sourceKey];
        if (typeof value === "string" && value.trim()) props.settings[key] = value;
      }
      // 比例：打光、多角度、扩图、动漫转真人要求出图与原图同比例，
      // ComfyUI 承载时一律默认「自适应」（比例跟随参考图），每次打开面板都是这个默认项。
      // 内置节点没有「自适应」档位，沿用存档值或父节点比例。
      // lockedRatio 的玩法跳过这一步：它的画幅由版式自带（如制作资产的 16:9 / 4:3），
      // 跟随 9:16 立绘参考图会把版式拉废。
      if (props.lockedRatio) {
        // 只校正到模型声明过的档位，不改变「就该是这个比例」这个事实；
        // 基准用版式目标比例而不是源图比例，否则会被 9:16 立绘带偏。
        if (!ratioOptions.value.includes(props.settings.ratio)) props.settings.ratio = nearestRatio(lockedRatioTarget());
      } else {
        const inherited = (node.data as Record<string, unknown>).ratio;
        props.settings.ratio = supportsRewrite.value ? AUTO_RATIO : props.settings.ratio?.trim() || (typeof inherited === "string" ? inherited.trim() : "");
      }
      // 重写提示词是布尔开关：默认沿用本节点的存档值（跟随上一次操作）；
      // 指定了 rewriteDefault 的玩法则强制用它的值——「制作资产」是逐字写死的版式结构，
      // 不能被工作流改写，也不能让父节点那次实验留下的开关漏进来。
      if (typeof props.rewriteDefault === "boolean") props.settings.rewritePrompt = props.rewriteDefault;
      else {
        const inheritedRewrite = (node.data as Record<string, unknown>).rewritePrompt;
        if (typeof inheritedRewrite === "boolean") props.settings.rewritePrompt = inheritedRewrite;
      }
      inheritModelConfig = false;
    }
    models.value = result.filter(item => item.type === "image");
    if (!props.settings.model) {
      const choice = models.value[0];
      props.settings.model = choice ? JSON.stringify([choice.providerId, choice.modelId]) : "";
    }
  } catch (error) { if (!disposed) showNodeError(error, "模型读取失败"); }
  finally { modelsLoading.value = false; }
}

async function generate() {
  if (disposed || busy.value || modelsLoading.value || !selectedModel.value || !props.source || !props.prompt.trim()) return;
  const controller = generationController = new AbortController();
  generating.value = true;
  try {
    // 额外参考图（内联 data URI）先落盘到新节点目录，换成路径才能进 images 通道。
    const nodeId = crypto.randomUUID();
    const extra = props.extraImages ?? [];
    await persistVariationImages(files, nodeId, extra.map((image, index) => ({ url: image.path, mimeType: image.mimeType, name: `guide_${index}.${extensionOf(image.mimeType)}` })));
    controller.signal.throwIfAborted();
    const extraImages = extra.map((image, index) => ({ path: `assets/${nodeId}/guide_${index}.${extensionOf(image.mimeType)}`, mimeType: image.mimeType }));
    // 把第一张额外参考图（= 版式灰模）连同名称交给新节点，让它能在底栏把这张「隐藏的引用」显示出来。
    const guideImage = extraImages.length ? { ...extraImages[0]!, label: props.guideLabel ?? props.label } : undefined;
    const { nodeId: createdId, edgeId } = await createVariation({
      ...props.settings,
      label: props.label,
      // 各玩法自带的提示词用各自约定的参考记号：局部重绘/打光/多角度用 {{ref N}}，
      // 「制作资产」用 <imageN>。前者在这里重排成「参考 N」，后者原样透传给供应商
      // （节点侧会追加一条「<imageN> 对应第几张图」的映射，两条路都要保住）。
      prompt: props.prompt.replace(/\{\{ref (\d+)\}\}/g, "参考 $1"),
      nodeId,
      ...(extraImages.length ? { extraImages } : {}),
      ...(guideImage ? { guideImage } : {}),
    }, controller.signal);
    const createdNode = findNode(createdId);
    await getNodeTools().call({ nodeId: createdId, name: "node:getConfig", args: {} }, controller.signal);
    if (!createdNode || findNode(createdId) !== createdNode || !getEdges.value.some(edge => edge.id === edgeId && edge.source === id && edge.sourceHandle === "image" && edge.target === createdId && edge.targetHandle === "in")) {
      throw new Error("新节点或原图连接已变化，请在新节点中检查后生成");
    }
    await getNodeTools().call({ nodeId: createdId, name: "node:generateImage", args: {} }, controller.signal);
    emit("generated");
  } catch (error) { if (!controller.signal.aborted && !disposed) showNodeError(error, `${props.label}失败`); }
  finally { generating.value = false; generationController = undefined; }
}

function extensionOf(mimeType: string) {
  return mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
}
</script>

<style scoped lang="scss">
.variationFooter {
  display: flex; align-items: center; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter);
  .modelSelect { flex: 1; min-width: 0; }
  .sizeButton { max-width: 230px; overflow: hidden; }
  > .el-button { margin-left: 0; flex-shrink: 0; }
}
.variationSettings {
  display: grid; gap: 12px;
  label { display: grid; gap: 6px; font-size: 12px; }
  .switchControl { display: flex; align-items: center; justify-content: space-between; }
}
</style>
