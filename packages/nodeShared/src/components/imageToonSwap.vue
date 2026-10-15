<template>
  <el-dropdown ref="dropdown" trigger="click" virtualTriggering :virtualRef="trigger" :disabled="disabled || busy || !src" @command="run">
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="toReal">动漫转真人</el-dropdown-item>
        <el-dropdown-item command="toAnime">真人转动漫</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ElDropdown, ElDropdownItem, ElDropdownMenu } from "element-plus";
import { useNode, useVueFlow } from "@vue-flow/core";
import { useNodeToolsContext, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { showNodeError } from "../showNodeError";
import { buildAnimeToRealPrompt, buildRealToAnimePrompt } from "../imageAnimeToReal";
import { useImageVariationNode, AUTO_RATIO, recommendedLora } from "../useImageVariationNode";
import { PLAYBOOK_MEGAPIXELS } from "../playbookDefaults";

const props = defineProps<{
  src: string;
  source?: NodeMediaValue;
  disabled?: boolean;
  /** 生成的子节点类型（ComfyUI 承载节点 vs 内置节点）。 */
  nodeType?: string;
  /**
   * 一键玩法没有模型下拉，模型由宿主解析后给进来：
   * ComfyUI 图片生成节点用节点自己的模型（能吃参考图），ComfyUI 图片节点用记忆值或让用户挑一次。
   * 返回空串 / undefined 表示用户取消了，此时不建节点。
   */
  resolveModel: () => Promise<string | undefined>;
  /** 是否让工作流重写提示词。玩法提示词是逐字写死的，默认不重写。 */
  rewritePrompt?: boolean;
}>();

const { id, node } = useNode();
const { findNode, getEdges } = useVueFlow();
const getNodeTools = useNodeToolsContext();
const createVariation = useImageVariationNode({ nodeType: props.nodeType });
const dropdown = ref<InstanceType<typeof ElDropdown>>();
const trigger = ref<HTMLElement>();
const busy = ref(false);
let controller: AbortController | undefined;

defineExpose({ open, busy });

async function open(event: MouseEvent) {
  if (props.disabled || busy.value || !props.src) return;
  trigger.value = event.currentTarget as HTMLElement;
  dropdown.value?.handleOpen();
}

/**
 * 选完方向就立刻跑：建新节点 → 直接发起生成，中间不再让用户点一次「生成」。
 * 两个方向唯一的差别是提示词与 LoRA（画风由 LoRA 决定），其余参数与其余玩法一致。
 */
async function run(command: "toReal" | "toAnime") {
  if (props.disabled || busy.value || !props.src || !props.source) return;
  const toReal = command === "toReal";
  const label = toReal ? "动漫转真人" : "真人转动漫";
  busy.value = true;
  controller = new AbortController();
  const signal = controller.signal;
  try {
    const model = await props.resolveModel();
    if (!model) return;
    signal.throwIfAborted();
    const { nodeId, edgeId } = await createVariation({
      label,
      prompt: toReal ? buildAnimeToRealPrompt() : buildRealToAnimePrompt(),
      model,
      size: PLAYBOOK_MEGAPIXELS,
      // 只换渲染方式不换画面，出图必须与原图同比例——固定用「自适应」让比例跟随参考图。
      ratio: AUTO_RATIO,
      rewritePrompt: props.rewritePrompt ?? false,
      loras: recommendedLora(toReal ? "animeToReal" : "realToAnime"),
    }, signal);
    // 新节点刚挂上，先调一次 getConfig 等它把模型与参数就位，再触发生成——
    // 直接 generateImage 会读到还没初始化的配置。
    await getNodeTools().call({ nodeId, name: "node:getConfig", args: {} }, signal);
    const created = findNode(nodeId);
    const linked = getEdges.value.some(edge => edge.id === edgeId && edge.source === id && edge.sourceHandle === "image" && edge.target === nodeId && edge.targetHandle === "in");
    if (!created || !linked) throw new Error("新节点或原图连接已变化，请在新节点中检查后生成");
    await getNodeTools().call({ nodeId, name: "node:generateImage", args: {} }, signal);
  } catch (error) {
    if (!signal.aborted) showNodeError(error, `${label}失败`);
  } finally {
    busy.value = false;
    controller = undefined;
  }
}
</script>
