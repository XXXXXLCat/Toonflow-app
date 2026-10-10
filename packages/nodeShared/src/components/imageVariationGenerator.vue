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
import { useNodeAi, useNodeToolsContext, type NodeMediaModel, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useImageVariationNode, variationSizeKey, VARIATION_NODE, AUTO_RATIO } from "@toonflow/node-shared/useImageVariationNode";

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
}>();
const emit = defineEmits<{ generated: [] }>();
const generating = defineModel<boolean>("generating", { default: false });
const { id, node } = useNode();
const { findNode, getEdges } = useVueFlow();
const ai = useNodeAi();
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
  const base = supportsRewrite.value ? [...declared, AUTO_RATIO] : declared;
  const current = props.settings.ratio?.trim();
  return current && !base.includes(current) ? [current, ...base] : base;
});
const sizeSummary = computed(() => props.settings.size ? `${props.settings.size}${supportsRewrite.value ? "MP" : ""}` : "分辨率");
const settingsSummary = computed(() => [props.settings.ratio || "比例", sizeSummary.value, ...(supportsRewrite.value ? [props.settings.rewritePrompt ? "重写" : "原文"] : [])].join(" · "));
let generationController: AbortController | undefined;
let disposed = false;
let inheritModelConfig = true;

function nearestRatio() {
  const numeric = ratioOptions.value.map(value => ({ value, number: value.split(":").map(Number).reduce((width, height) => width / height) })).filter(item => Number.isFinite(item.number) && item.number > 0);
  return props.aspectRatio && numeric.length ? numeric.sort((left, right) => Math.abs(Math.log(left.number / props.aspectRatio)) - Math.abs(Math.log(right.number / props.aspectRatio)))[0]!.value : ratioOptions.value[0]!;
}

watch(selectedModel, choice => {
  if (!choice) return;
  if (!sizeOptions.value.includes(props.settings.size)) props.settings.size = sizeOptions.value.toSorted((left, right) => (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity))[0]!;
  if (!ratioOptions.value.includes(props.settings.ratio)) props.settings.ratio = nearestRatio();
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
      const inherited = (node.data as Record<string, unknown>).ratio;
      props.settings.ratio = supportsRewrite.value ? AUTO_RATIO : props.settings.ratio?.trim() || (typeof inherited === "string" ? inherited.trim() : "");
      // 重写提示词是布尔开关，单独从本节点继承（内置节点没有这一项，保持默认开）。
      const inheritedRewrite = (node.data as Record<string, unknown>).rewritePrompt;
      if (typeof inheritedRewrite === "boolean") props.settings.rewritePrompt = inheritedRewrite;
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
    const { nodeId, edgeId } = await createVariation({ ...props.settings, label: props.label, prompt: props.prompt }, controller.signal);
    const createdNode = findNode(nodeId);
    await getNodeTools().call({ nodeId, name: "node:getConfig", args: {} }, controller.signal);
    if (!createdNode || findNode(nodeId) !== createdNode || !getEdges.value.some(edge => edge.id === edgeId && edge.source === id && edge.sourceHandle === "image" && edge.target === nodeId && edge.targetHandle === "in")) {
      throw new Error("新节点或原图连接已变化，请在新节点中检查后生成");
    }
    await getNodeTools().call({ nodeId, name: "node:generateImage", args: {} }, controller.signal);
    emit("generated");
  } catch (error) { if (!controller.signal.aborted && !disposed) showNodeError(error, `${props.label}失败`); }
  finally { generating.value = false; generationController = undefined; }
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
