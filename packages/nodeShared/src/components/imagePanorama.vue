<template>
  <el-dropdown ref="dropdown" trigger="click" virtualTriggering :virtualRef="trigger" :disabled="disabled || busy || !src" @command="selectAction">
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="generateSphere">生成720°全景图</el-dropdown-item>
        <el-dropdown-item command="generateCylinder">生成360°环绕图</el-dropdown-item>
        <el-dropdown-item command="previewSphere" divided>预览720°全景图</el-dropdown-item>
        <el-dropdown-item command="previewCylinder">预览360°环绕图</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
  <el-dialog
    v-model="visible"
    class="panoramaDialog"
    :title="`预览${mode === 'sphere' ? '720°全景图' : '360°环绕图'}`"
    width="80%"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!busy"
    :showClose="!busy"
    :beforeClose="close"
    :style="{ maxWidth: 'calc(100vw - 32px)' }">
    <template #header>
      <div class="panoramaHeader">
        <icon-panorama-horizontal :size="20" />
        <strong>{{ mode === 'sphere' ? '720°全景图' : '360°环绕图' }}</strong>
        <span>预览与校正</span>
      </div>
    </template>
    <div class="panoramaPanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @wheel.stop @keydown.stop>
      <imagePanoramaPreview v-if="visible" ref="previewStage" :src="src" :mode="mode" :disabled="disabled || saving" @capture="saveCapture" />
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ElDialog, ElDropdown, ElDropdownItem, ElDropdownMenu } from "element-plus";
import { IconPanoramaHorizontal } from "@tabler/icons-vue";
import { useNode } from "@vue-flow/core";
import { useNodeAi, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { buildPanoramaPrompt, type PanoramaMode } from "../imagePanorama";
import { usePanoramaCapture } from "../usePanoramaCapture";
import { useImageVariationNode, AUTO_RATIO, recommendedLora } from "@toonflow/node-shared/useImageVariationNode";
import { modelIdOf, pickPlaybookModel, PLAYBOOK_MEGAPIXELS } from "@toonflow/node-shared/playbookDefaults";
import imagePanoramaPreview from "./imagePanoramaPreview.vue";

const props = defineProps<{ src: string; source?: NodeMediaValue; disabled?: boolean; nodeType?: string }>();
const emit = defineEmits<{ open: [] }>();
const { node } = useNode();
const ai = useNodeAi();
const dropdown = ref<InstanceType<typeof ElDropdown>>();
const trigger = ref<HTMLElement>();
const visible = ref(false);
const mode = ref<PanoramaMode>("sphere");
const creating = ref(false);
const createVariation = useImageVariationNode({ nodeType: props.nodeType });
const previewStage = ref<InstanceType<typeof imagePanoramaPreview>>();
const { saving, saveCapture } = usePanoramaCapture(() => props.src, { nodeType: props.nodeType });
const busy = computed(() => creating.value || saving.value || !!previewStage.value?.capturing);

defineExpose({ open, busy, visible });

watch(() => props.src, () => { visible.value = false; }, { flush: "sync" });

async function open(event: MouseEvent) {
  if (props.disabled || busy.value || !props.src) return;
  trigger.value = event.currentTarget as HTMLElement;
  await nextTick();
  dropdown.value?.handleOpen();
}

async function selectAction(command: string) {
  if (props.disabled || busy.value || !props.src) return;
  emit("open");
  mode.value = command.endsWith("Sphere") ? "sphere" : "cylinder";
  if (command.startsWith("preview")) {
    visible.value = true;
    return;
  }
  if (!props.source) return;
  creating.value = true;
  try {
    // 全景图也是「照着参考图改」，执行者统一是编辑模型（Qwen Image 2.1 图像编辑），
    // 分辨率固定 2MP、比例自适应——与其余玩法保持同一套默认值。
    const choice = pickPlaybookModel((await ai.getMediaModels()).filter(item => item.type === "image"));
    if (!choice) throw new Error("未找到可用的图片模型，请先在「设置 → 媒体模型」中安装");
    await createVariation({
      label: mode.value === "sphere" ? "720°全景图" : "360°环绕图",
      prompt: buildPanoramaPrompt(mode.value),
      model: modelIdOf(choice),
      size: PLAYBOOK_MEGAPIXELS,
      ratio: AUTO_RATIO,
      loras: recommendedLora("panorama"),
    });
  } catch (error) {
    showNodeError(error, "全景节点创建失败");
  } finally {
    creating.value = false;
  }
}

function close(done: () => void) {
  if (!busy.value) done();
}
</script>

<style scoped lang="scss">
:global(.panoramaDialog .el-dialog__header) { padding-bottom: 16px; }
.panoramaHeader {
  display: flex; align-items: center; gap: 8px; min-height: 24px; padding-right: 24px; color: var(--el-text-color-primary);
  strong { font-size: 15px; font-weight: 600; }
  span { margin-left: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
}
.panoramaPanel { height: min(70vh, 760px); min-height: 0; }
</style>
