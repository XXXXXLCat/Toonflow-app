<template>
  <teleport :to="target ?? 'body'" :disabled="!target">
    <section v-show="!!target" class="outpaintPanel nodrag nopan nowheel" aria-label="图片扩图" @pointerdown.stop @mousedown.stop @dblclick.stop @wheel.stop @keydown.stop>
      <header class="panelHeader">
        <div><icon-arrow-expand :size="18" /><strong>扩图</strong><span>向外延伸画面，保留原内容</span></div>
        <el-button :icon="IconX" text :disabled="generating" aria-label="关闭扩图" @click="emit('close')" />
      </header>
      <div class="directionSection">
        <span class="sectionLabel">扩展方向</span>
        <div class="directionGrid" role="group" aria-label="扩展方向">
          <button v-for="direction in outpaintDirections" :key="direction.id" type="button" :class="{ active: settings.direction === direction.id }" :disabled="busy" :aria-pressed="settings.direction === direction.id" @click="settings.direction = direction.id">{{ direction.label }}</button>
        </div>
      </div>
      <label v-if="settings.direction !== 'all'" class="rangeControl"><span>扩展幅度 <b>{{ settings.scale.toFixed(1) }}×</b></span><input v-model.number="settings.scale" type="range" min="1.1" max="3" step="0.1" :disabled="busy" aria-label="扩图扩展幅度" /></label>
      <div v-else class="sectionHint">向四周等比扩展，保持原图比例，画面内容范围变大</div>
      <div class="descSection">
        <span class="sectionLabel">补充描述（可选）</span>
        <el-input v-model="settings.desc" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :disabled="busy" placeholder="描述想要延伸出的内容，如：延伸出一片草地与远山…" aria-label="扩图补充描述" />
      </div>
      <imageVariationGenerator v-model:generating="generating" :settings="settings" :source="source" :aspectRatio="sourceRatio" :prompt="buildOutpaintPrompt(settings)" :disabled="disabled" :nodeType="nodeType" label="扩图" @generated="emit('close')" />
      <!-- 只用来读原图比例，不展示。 -->
      <img v-if="src" :src="src" class="ratioProbe" alt="" aria-hidden="true" @load="readRatio" />
    </section>
  </teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useNode } from "@vue-flow/core";
import { ElButton, ElInput } from "element-plus";
import { IconArrowsMaximize, IconX } from "@tabler/icons-vue";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { buildOutpaintPrompt, getOutpaintRatio, outpaintDirections, readOutpaintSettings, type OutpaintSettings } from "../imageOutpaint";
import { recommendedLora } from "../useImageVariationNode";
import imageVariationGenerator from "./imageVariationGenerator.vue";

const props = defineProps<{ src: string; source?: NodeMediaValue; target?: HTMLElement; disabled?: boolean; nodeType?: string }>();
const emit = defineEmits<{ close: [] }>();
const { node } = useNode();
node.data.outpaint = readOutpaintSettings(node.data.outpaint);
const settings = computed(() => node.data.outpaint as OutpaintSettings);
const generating = ref(false);
const busy = computed(() => props.disabled || generating.value);
const sourceRatio = ref(0);

// 方向或幅度变了就重算目标比例，让底栏摘要与实际提交保持一致。
watch(
  () => [settings.value.direction, settings.value.scale, sourceRatio.value],
  () => {
    if (sourceRatio.value) settings.value.ratio = getOutpaintRatio(sourceRatio.value, settings.value.direction, settings.value.scale);
  },
  { immediate: true }
);

// 扩图自带的推荐 LoRA：补全画面外新露出的区域。还没有时补上（老存档没这个字段）。
watch(settings, value => {
  if (!value.loras?.length) value.loras = recommendedLora("outpaint");
}, { immediate: true, deep: true });

defineExpose({ generating });

function readRatio(event: Event) {
  const image = event.target as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  sourceRatio.value = image.naturalWidth / image.naturalHeight;
}
</script>

<style scoped lang="scss">
.outpaintPanel {
  padding: 14px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 14px;
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-primary);
  box-shadow: var(--el-box-shadow-light);
  font-size: 12px;

  .panelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    > div { display: flex; align-items: center; gap: 8px; }
    strong { font-size: 14px; }
    span { margin-left: 4px; color: var(--el-text-color-secondary); }
    .el-button { width: 26px; height: 26px; padding: 0; }
  }
  .sectionLabel { display: block; margin-bottom: 8px; color: var(--el-text-color-secondary); }
  .sectionHint { margin: 8px 0; color: var(--el-text-color-secondary); line-height: 1.6; }
  .directionSection {
    .directionGrid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
      button { padding: 7px 4px; border: 1px solid var(--el-border-color-lighter); border-radius: 7px; color: var(--el-text-color-regular); background: var(--el-fill-color-light); cursor: pointer; font: inherit; }
      button.active { border-color: var(--el-color-primary); color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
      button:disabled { opacity: .5; cursor: default; }
    }
  }
  .rangeControl {
    display: grid; gap: 10px; margin-top: 12px;
    span { display: flex; justify-content: space-between; }
    b { color: var(--el-text-color-secondary); font-weight: 500; font-variant-numeric: tabular-nums; }
    input { width: 100%; margin: 0; accent-color: var(--el-color-primary); cursor: pointer; }
  }
  .descSection { margin-top: 12px; }
}
.ratioProbe { display: none; }
</style>
