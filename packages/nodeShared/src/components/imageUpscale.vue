<template>
  <el-dropdown ref="dropdown" trigger="click" virtualTriggering :virtualRef="trigger" :disabled="disabled || busy || !src" @command="run">
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item v-for="option in options" :key="option" :command="option">{{ multiplierText(option) }}</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ElDropdown, ElDropdownItem, ElDropdownMenu } from "element-plus";
import { useNode, useVueFlow } from "@vue-flow/core";
import { useNodeToolsContext, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { showNodeError } from "../showNodeError";
import { useImageVariationNode, AUTO_RATIO } from "../useImageVariationNode";
import { PLAYBOOK_MEGAPIXELS } from "../playbookDefaults";

/** 模型没声明可用倍数时的默认档位。 */
const DEFAULT_UPSCALE_MULTIPLIERS = ["1.5", "2", "3", "4"];

const props = defineProps<{
  src: string;
  source?: NodeMediaValue;
  disabled?: boolean;
  /** 生成的子节点类型（ComfyUI 承载节点 vs 内置节点）。 */
  nodeType?: string;
  /** 可选倍数；模型声明了就按它的来（如某些放大模型只到 4×）。 */
  multipliers?: string[];
  /** 尺寸档位：放大模型不吃它，但节点数据要填，缺省用玩法统一的 2MP。 */
  size?: string;
  /**
   * 一键玩法没有模型下拉，放大模型由宿主挑好给进来：
   * ComfyUI 图片生成节点优先用当前选中的放大模型，ComfyUI 图片节点取第一个声明了 upscale 的。
   * 返回空 / undefined 表示没装放大模型（宿主已提示），此时不建节点。
   */
  resolveModel: () => Promise<string | undefined>;
}>();

const { id, node } = useNode();
const { findNode, getEdges } = useVueFlow();
const getNodeTools = useNodeToolsContext();
const createVariation = useImageVariationNode({ nodeType: props.nodeType });
const dropdown = ref<InstanceType<typeof ElDropdown>>();
const trigger = ref<HTMLElement>();
const busy = ref(false);
let controller: AbortController | undefined;

const options = computed(() => props.multipliers?.length ? props.multipliers : DEFAULT_UPSCALE_MULTIPLIERS);

defineExpose({ open, busy });

async function open(event: MouseEvent) {
  if (props.disabled || busy.value || !props.src) return;
  trigger.value = event.currentTarget as HTMLElement;
  dropdown.value?.handleOpen();
}

function multiplierText(value: string) {
  return `${value}×`;
}

/**
 * 选完倍数就立刻跑：建新节点 → 直接发起生成，中间不再让用户点一次「生成」。
 * 放大模型（SeedVR2 等）只接一张图、没有提示词与 LoRA 通道，尺寸与比例也由它按原图推导。
 */
async function run(command: string) {
  if (props.disabled || busy.value || !props.src || !props.source) return;
  const multiplier = command;
  const label = `放大 ${multiplierText(multiplier)}`;
  busy.value = true;
  controller = new AbortController();
  const signal = controller.signal;
  try {
    const model = await props.resolveModel();
    if (!model) return;
    signal.throwIfAborted();
    const { nodeId, edgeId } = await createVariation({
      label,
      prompt: "",
      model,
      size: props.size ?? PLAYBOOK_MEGAPIXELS,
      ratio: AUTO_RATIO,
      multiplier,
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
