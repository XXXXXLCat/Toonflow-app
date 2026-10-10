<template>
  <el-popover trigger="click" placement="top-start" width="min(340px, calc(100vw - 24px))" :disabled="disabled" :showArrow="false" :popperStyle="{ padding: '14px' }">
    <template #reference>
      <el-button class="settingsButton" text size="small" :disabled="disabled" aria-label="视频生成设置">
        <span class="ratioShape" :style="ratioStyle(ratio)" aria-hidden="true" />
        <span>{{ summary }}</span>
        <icon-chevron-up :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="generationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <template v-if="showMode">
        <div class="sectionLabel">生成模式</div>
        <el-select v-model="mode" :disabled="disabled" :teleported="false" aria-label="视频生成模式">
          <el-option v-for="item in modes" :key="item.value" :value="item.value" :label="item.label" />
        </el-select>
      </template>
      <div v-if="workflow || durations.length || resolutions.length" class="outputOptions">
        <div v-if="workflow || durations.length" class="outputField">
          <div class="sectionLabel">时长</div>
          <!-- 工作流模型的时长是画布上的 PrimitiveFloat（Float (duration)），节点提供 1–15 秒的整数档位；
               云端模型只有 durationResolutionMap 里的固定档位。 -->
          <el-radio-group v-if="workflow" v-model="duration" class="durationOptions" :disabled="disabled" aria-label="视频时长">
            <el-radio-button v-for="item in durationOptions" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
          <el-select v-else v-model="duration" :disabled="disabled" :teleported="false" aria-label="视频时长">
            <el-option v-for="item in durations" :key="item" :value="item" :label="`${item}秒`" />
          </el-select>
        </div>
        <div v-if="resolutions.length" class="outputField">
          <div class="sectionLabel">分辨率</div>
          <el-select v-model="resolution" :disabled="disabled" :teleported="false" aria-label="视频分辨率">
            <el-option v-for="item in resolutions" :key="item" :value="item" :label="item" />
          </el-select>
        </div>
      </div>
      <template v-if="workflow">
        <div class="sectionLabel">百万像素</div>
        <el-radio-group v-model="megapixels" class="sizeOptions" :disabled="disabled" aria-label="百万像素">
          <el-radio-button v-for="item in megapixelOptions" :key="item" :value="item">{{ item }}MP</el-radio-button>
        </el-radio-group>
      </template>
      <div class="sectionLabel">高宽比</div>
      <div class="ratioOptions" role="group" aria-label="视频高宽比">
        <el-button v-for="item in ratios" :key="item" class="ratioButton" :disabled="disabled" :aria-label="`高宽比 ${item}`" :aria-pressed="ratio === item" @click="ratio = item">
          <span class="ratioContent">
            <span class="ratioShape" :style="ratioStyle(item)" aria-hidden="true" />
            <span>{{ item }}</span>
          </span>
        </el-button>
      </div>
      <div v-if="workflow" class="switchOption">
        <span class="sectionLabel">重写提示词</span>
        <el-switch v-model="rewritePrompt" :disabled="disabled" aria-label="重写提示词" />
      </div>
      <div v-if="workflow" class="switchOption">
        <span class="sectionLabel">Turbo</span>
        <el-switch v-model="turbo" :disabled="disabled" aria-label="Turbo" />
      </div>
      <div v-if="model?.audio === 'optional'" class="switchOption">
        <span class="sectionLabel">生成音频</span>
        <el-switch v-model="generateAudio" :disabled="disabled" aria-label="生成音频" />
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElPopover, ElRadioGroup, ElRadioButton, ElSelect, ElOption, ElSwitch } from "element-plus";
import { IconChevronUp } from "@tabler/icons-vue";
import type { NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";
import { modeLabel } from "../modeLabels";

const props = defineProps<{ model?: NodeMediaModel; disabled?: boolean; ratios: string[]; megapixelOptions: string[]; durationOptions?: number[]; workflow?: boolean; modeChoiceCount?: number; modeOptions?: { value: string; label: string }[] }>();
const duration = defineModel<number | undefined>("duration", { required: true });
const resolution = defineModel<string>("resolution", { required: true });
const ratio = defineModel<string>("ratio", { required: true });
const mode = defineModel<string>("mode", { required: true });
const generateAudio = defineModel<boolean>("generateAudio", { required: true });
const megapixels = defineModel<string>("megapixels", { required: true });
const rewritePrompt = defineModel<boolean>("rewritePrompt", { required: true });
const turbo = defineModel<boolean>("turbo", { required: true });
// 工作流模型没有分辨率档位，改为展示百万像素；摘要里也用百万像素代替分辨率。
const summary = computed(() => [
  props.workflow ? `${megapixels.value}MP` : "",
  ratio.value,
  props.workflow ? "" : resolution.value,
  duration.value ? `${duration.value}秒` : "",
].filter(Boolean).join(" · "));
// 节点下发的选项已按「当前素材最终落到哪」命名（首帧 / 尾帧 / 首尾帧 / 参考素材），直接用；
// 没有下发时退回模型声明的模式名。
const modes = computed(() => props.modeOptions ?? (props.model?.mode ?? []).map(item => ({
  value: JSON.stringify(item),
  label: modeLabel(item),
})));
// 模式对当前素材的结果唯一时（如 0 个素材走文生视频、≥1 个走混合参考、两张图必为首尾帧），
// 下拉没有可选项，隐藏；只有真的能选到**不同结果**（单图作首帧还是尾帧）时才展示。
const showMode = computed(() => (props.modeChoiceCount ?? 0) > 1);
const mappings = computed(() => props.model?.durationResolutionMap ?? []);
const durations = computed(() => [...new Set(mappings.value.flatMap(item => item.duration))].sort((a, b) => a - b));
const resolutions = computed(() => resolutionsFor(duration.value));

function resolutionsFor(value: number | undefined) {
  return [...new Set(mappings.value.filter(item => value !== undefined && item.duration.includes(value)).flatMap(item => item.resolution))];
}

function ratioStyle(value: string) {
  const [width = 1, height = 1] = value.split(":").map(Number);
  return { width: `${16 * Math.min(width / height, 1)}px`, height: `${16 * Math.min(height / width, 1)}px` };
}
</script>

<style scoped lang="scss">
.ratioShape {
  display: inline-block;
  flex-shrink: 0;
  border: 1px solid currentColor;
  border-radius: 2px;
  box-sizing: border-box;
}

.settingsButton {
  flex-shrink: 0;
  :deep(> span) { gap: 6px; }
}

.generationSettings {
  text-align: left;

  .sectionLabel {
    margin-bottom: 8px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    font-weight: 500;
  }

  > .el-select { margin-bottom: 14px; }

  .outputOptions {
    display: flex;
    gap: 12px;
    margin-bottom: 14px;
    .outputField { flex: 1; min-width: 0; }
  }

  .sizeOptions,
  .durationOptions {
    display: grid;
    gap: 8px;
    .el-radio-button {
      --el-radio-button-checked-bg-color: var(--el-fill-color);
      --el-radio-button-checked-text-color: var(--el-text-color-primary);
      --el-radio-button-checked-border-color: var(--el-text-color-regular);

      :deep(.el-radio-button__inner) {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--el-border-color);
        border-radius: var(--el-border-radius-base);
        box-shadow: none;

        &:hover { color: var(--el-text-color-primary); }
      }

      &.is-active :deep(.el-radio-button__inner) {
        border-color: var(--el-text-color-regular);
      }
    }
  }

  .sizeOptions {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-bottom: 14px;
  }

  // 1–15 秒共 15 档，排成 5 列 3 行；下拉会有 15 项且需要展开，点选更快。
  .durationOptions {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .ratioOptions {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;

    .ratioButton {
      height: 60px;
      margin: 0;
      padding: 8px 4px;
      color: var(--el-text-color-secondary);
      --el-button-bg-color: var(--el-fill-color-light);
      --el-button-hover-bg-color: var(--el-fill-color);
      --el-button-hover-text-color: var(--el-text-color-primary);
      --el-button-hover-border-color: var(--el-border-color-darker);

      &[aria-pressed="true"] {
        color: var(--el-text-color-primary);
        border-color: var(--el-text-color-regular);
        background: var(--el-fill-color);
      }

      .ratioContent {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        font-size: 12px;
      }
    }
  }

  .switchOption {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
    .sectionLabel { margin: 0; }
  }
}
</style>
