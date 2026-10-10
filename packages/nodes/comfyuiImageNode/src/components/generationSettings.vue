<template>
  <el-popover trigger="click" placement="top-start" width="min(340px, calc(100vw - 24px))" :disabled="disabled" :showArrow="false" :popperStyle="{ padding: '14px' }">
    <template #reference>
      <el-button class="settingsButton" text size="small" :disabled="disabled" aria-label="生成参数设置">
        <span v-if="!autoRatio" class="ratioShape" :style="ratioShape(ratio)" aria-hidden="true" />
        <icon-aspect-ratio v-else :size="16" aria-hidden="true" />
        <span>{{ ratioSummary }}</span>
        <icon-chevron-up :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="generationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <div class="sectionLabel">分辨率</div>
      <el-radio-group v-model="megapixels" class="sizeOptions" :disabled="disabled" aria-label="分辨率">
        <el-radio-button v-for="item in megapixelOptions" :key="item" :value="item">{{ item }}MP</el-radio-button>
      </el-radio-group>
      <div class="sectionLabel">比例</div>
      <div class="ratioOptions" role="group" aria-label="图片比例">
        <el-button
          v-for="item in ratios"
          :key="item"
          class="ratioButton"
          :disabled="disabled"
          :aria-label="`比例 ${item}`"
          :aria-pressed="ratio === item"
          @click="ratio = item">
          <span class="ratioContent">
            <span v-if="ratioShape(item)" class="ratioShape" :style="ratioShape(item)" aria-hidden="true" />
            <icon-aspect-ratio v-else :size="16" aria-hidden="true" />
            <span>{{ item }}</span>
          </span>
        </el-button>
      </div>
      <div v-if="autoRatio" class="sectionHint">比例跟随参考图，分辨率决定出图面积</div>
      <div class="rewriteOption">
        <span class="sectionLabel">重写提示词</span>
        <el-switch v-model="rewritePrompt" :disabled="disabled" aria-label="重写提示词" />
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElPopover, ElRadioGroup, ElRadioButton, ElSwitch } from "element-plus";
import { IconAspectRatio, IconChevronUp } from "@tabler/icons-vue";

defineProps<{ megapixelOptions: string[]; ratios: string[]; disabled?: boolean }>();
const megapixels = defineModel<string>("megapixels", { required: true });
const ratio = defineModel<string>("ratio", { required: true });
const rewritePrompt = defineModel<boolean>("rewritePrompt", { required: true });
// 非 W:H 的选项（如「自适应」）表示比例跟随参考图，此时不画比例框、只给图标。
const autoRatio = computed(() => !ratioShape(ratio.value));
const ratioSummary = computed(() => `${ratio.value} · ${megapixels.value}MP · 1张`);

function ratioShape(value: string) {
  const [width = 1, height = 1] = value.split(":").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
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

  .sizeOptions {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
    .el-radio-button {
      flex: 1;
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

  .sectionHint {
    margin-top: 12px;
    color: var(--el-text-color-placeholder);
    font-size: 12px;
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

  .rewriteOption {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
    .sectionLabel { margin: 0; }
  }
}
</style>
