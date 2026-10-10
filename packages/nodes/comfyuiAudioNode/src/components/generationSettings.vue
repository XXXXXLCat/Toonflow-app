<template>
  <el-popover trigger="click" placement="top-start" width="min(360px, calc(100vw - 24px))" :disabled="disabled" :showArrow="false" :popperStyle="{ padding: '14px' }">
    <template #reference>
      <el-button class="settingsButton" text size="small" :disabled="disabled" aria-label="音频生成设置">
        <icon-adjustments-horizontal :size="15" aria-hidden="true" />
        <span>{{ formatLabel }}</span>
        <icon-chevron-up :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="generationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <div class="sectionLabel">输出格式</div>
      <!-- Breeze TTS 2 只暴露输出编码格式；音色、语气等由节点上方的「语音指令」输入区描述。
           SaveAudioAdvanced 只声明 mp3 / flac / opus，其余格式会在 ComfyUI 执行时被拒。 -->
      <el-radio-group v-model="format" class="optionRow" :disabled="disabled" aria-label="音频输出格式">
        <el-radio-button v-for="item in formats" :key="item" :value="item">{{ formatLabels[item] ?? item.toUpperCase() }}</el-radio-button>
      </el-radio-group>
      <!-- 音质是格式的二级入参：mp3 / opus 才有，flac 无损没有这一项。切换格式时回到该格式的默认档位。 -->
      <template v-if="qualities.length">
        <div class="sectionLabel qualityLabel">音质</div>
        <el-radio-group v-model="quality" class="optionRow" :disabled="disabled" aria-label="音频输出音质">
          <el-radio-button v-for="item in qualities" :key="item" :value="item" :title="qualityHints[item]">{{ item }}</el-radio-button>
        </el-radio-group>
      </template>
      <!-- 种子决定韵律的细微变化：每次随机便于挑声音，听到满意的切到固定就能复现它。 -->
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
      <!-- 只有接了参考音频才出现。复刻音色的供应商（语音方向控制）会用工作流里的 Whisper 自动转录，
           这里填的文本只在填了时才覆盖自动结果——自动听错了才需要手填纠正。
           模型不声明 referenceAudio 时给不出可用的输入框，直接说明音频不会被使用。 -->
      <template v-if="hasReferenceAudio">
        <template v-if="supportsReferenceAudio">
          <div class="sectionLabel referenceLabel">参考音频文本（选填）</div>
          <el-input
            v-model="referenceText"
            type="textarea"
            :rows="2"
            resize="none"
            :disabled="disabled"
            aria-label="参考音频文本"
            placeholder="留空则自动转录这段音频；转写不准时才手填" />
        </template>
        <div v-else class="sectionLabel referenceLabel">当前模型不使用参考音频，接入的音频会被忽略</div>
      </template>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import { ElButton, ElInput, ElInputNumber, ElPopover, ElRadioButton, ElRadioGroup, ElSwitch } from "element-plus";
import { IconAdjustmentsHorizontal, IconChevronUp, IconRefresh } from "@tabler/icons-vue";
import { defaultQuality, formatLabels, maxSeed, qualityOptions, randomSeed as randomSeedValue } from "../audioFormats";

defineProps<{ disabled?: boolean; formats: string[]; hasReferenceAudio?: boolean; supportsReferenceAudio?: boolean }>();
const format = defineModel<string>("format", { required: true });
const quality = defineModel<string>("quality", { required: true });
const seedMode = defineModel<string>("seedMode", { required: true });
const seedValue = defineModel<number>("seedValue", { required: true });
const referenceText = defineModel<string>("referenceText", { required: true });
const qualities = computed(() => qualityOptions[format.value] ?? []);
// 换格式时旧档位可能不再适用（128k 对 flac 没意义），直接落回新格式的默认档位。
watch(format, () => { quality.value = defaultQuality(format.value); });
const randomSeed = computed({
  get: () => seedMode.value !== "fixed",
  // 切到固定时保留刚用到的那个种子，这样「这次的声音不错」可以直接定下来。
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

  .qualityLabel,
  .seedLabel,
  .referenceLabel { margin-top: 14px; }

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

    .seedInput {
      width: 132px;
      flex-shrink: 0;
    }
  }
}
</style>
