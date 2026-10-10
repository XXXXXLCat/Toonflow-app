<template>
  <el-popover trigger="click" placement="top-start" width="min(360px, calc(100vw - 24px))" :disabled="disabled" :showArrow="false" :popperStyle="{ padding: '14px' }">
    <template #reference>
      <el-button class="settingsButton" text size="small" :disabled="disabled" aria-label="音乐生成设置">
        <icon-adjustments-horizontal :size="15" aria-hidden="true" />
        <span>{{ formatLabel }}</span>
        <icon-chevron-up :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="generationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <!-- 时长上限：提示词过长时 ComfyUI 会自动缩短，实际也可能提前结束。 -->
      <div class="sectionLabel durationLabel">时长上限</div>
      <div class="seedRow">
        <el-slider
          v-model="maxDuration"
          class="durationSlider"
          :min="MIN_DURATION"
          :max="MAX_DURATION"
          :step="durationStep"
          :disabled="disabled"
          :marks="{ [MIN_DURATION]: `${MIN_DURATION}s`, [MAX_DURATION]: `${MAX_DURATION}s` }"
          aria-label="时长上限（秒）" />
        <span class="durationValue">{{ maxDuration }}s</span>
      </div>
      <div class="sectionLabel formatLabel">输出格式</div>
      <el-radio-group v-model="format" class="optionRow" :disabled="disabled" aria-label="音乐输出格式">
        <el-radio-button v-for="item in formats" :key="item" :value="item">{{ formatLabels[item] ?? item.toUpperCase() }}</el-radio-button>
      </el-radio-group>
      <!-- 音质是格式的二级入参：mp3 / opus 才有，flac 无损没有这一项。切换格式时回到该格式的默认档位。 -->
      <template v-if="qualities.length">
        <div class="sectionLabel qualityLabel">音质</div>
        <el-radio-group v-model="quality" class="optionRow" :disabled="disabled" aria-label="音乐输出音质">
          <el-radio-button v-for="item in qualities" :key="item" :value="item" :title="qualityHints[item]">{{ item }}</el-radio-button>
        </el-radio-group>
      </template>
      <!-- 种子决定旋律与编曲的细微变化：每次随机便于挑选，满意的切到固定就能复现。 -->
      <div class="sectionLabel seedLabel">随机种子</div>
      <div class="seedRow">
        <el-switch v-model="randomSeed" :disabled="disabled" active-text="每次随机" inactive-text="固定" aria-label="每次随机种子" />
        <el-input-number
          v-model="seedValue"
          class="seedInput"
          size="small"
          :min="1"
          :max="maxSeed"
          :step="1"
          :controls="false"
          :disabled="disabled || randomSeed"
          aria-label="种子值" />
        <el-button text size="small" :disabled="disabled || !randomSeed" title="换一个种子" aria-label="换一个种子" @click="rollSeed">
          <icon-refresh :size="14" aria-hidden="true" />
        </el-button>
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import { ElButton, ElInputNumber, ElPopover, ElRadioButton, ElRadioGroup, ElSlider, ElSwitch } from "element-plus";
import { IconAdjustmentsHorizontal, IconChevronUp, IconRefresh } from "@tabler/icons-vue";
import {
  defaultQuality, durationStep, formatLabels, maxDuration as MAX_DURATION, maxSeed, minDuration as MIN_DURATION,
  qualityOptions, randomSeed as randomSeedValue,
} from "../musicFormats";

defineProps<{ disabled?: boolean; formats: string[] }>();
const format = defineModel<string>("format", { required: true });
const quality = defineModel<string>("quality", { required: true });
const maxDuration = defineModel<number>("maxDuration", { required: true });
const seedMode = defineModel<string>("seedMode", { required: true });
const seedValue = defineModel<number>("seedValue", { required: true });
const qualities = computed(() => qualityOptions[format.value] ?? []);
// 换格式时旧档位可能不再适用（128k 对 flac 没意义），直接落回新格式的默认档位。
watch(format, () => { quality.value = defaultQuality(format.value); });
const randomSeed = computed({
  get: () => seedMode.value !== "fixed",
  // 切到固定时保留刚用到的那个种子，这样「这首不错」可以直接定下来。
  set: (value: boolean) => { seedMode.value = value ? "random" : "fixed"; },
});
function rollSeed() {
  seedValue.value = randomSeedValue();
}
const formatLabel = computed(() => {
  const label = formatLabels[format.value] ?? format.value.toUpperCase();
  return quality.value ? `${label} · ${quality.value}` : label;
});
// V0 是 VBR 预设而非码率，仅作悬浮提示，按钮文本保持与 ComfyUI 节点一致。
const qualityHints: Record<string, string> = { V0: "VBR 可变码率预设，约 245 kbps" };
</script>

<style scoped lang="scss">
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

  // 时长成了弹层第一项，不该再留一段上边距。
  .durationLabel { margin-top: 0; }

  .formatLabel,
  .qualityLabel,
  .seedLabel { margin-top: 14px; }

  .optionRow {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;

    .el-radio-button {
      --el-radio-button-checked-bg-color: var(--el-fill-color);
      --el-radio-button-checked-text-color: var(--el-text-color-primary);
      --el-radio-button-checked-border-color: var(--el-text-color-regular);

      :deep(.el-radio-button__inner) {
        width: 100%;
        padding: 8px 6px;
        border: 1px solid var(--el-border-color);
        border-radius: var(--el-border-radius-base);
        box-shadow: none;
        font-size: 12px;

        &:hover { color: var(--el-text-color-primary); }
      }

      &.is-active :deep(.el-radio-button__inner) {
        border-color: var(--el-text-color-regular);
      }
    }
  }

  .seedRow {
    display: flex;
    align-items: center;
    gap: 8px;

    .durationSlider { flex: 1; min-width: 0; }
    .durationValue { width: 44px; flex-shrink: 0; font-size: 12px; color: var(--el-text-color-secondary); text-align: right; }
    .seedInput { width: 132px; flex-shrink: 0; }
  }
}
</style>
