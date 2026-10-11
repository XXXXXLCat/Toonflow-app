<template>
  <!--
    只读的「引导参考图」卡片：把玩法预置的额外参考图（不进连线、走 extraImages 通道的那张）
    在节点底栏显示出来。
    为什么需要它：额外参考图不参与连线，画布上看不到任何痕迹，用户会以为「根本没引用多角度图」。
    这张卡不给删除按钮、不参与拖拽排序——它由玩法固定注入，不是普通引用。
  -->
  <div class="guideCard" role="group" :title="title" :aria-label="title" @keydown.enter.self.stop.prevent="imageRef?.showPreview()" @keydown.space.self.stop.prevent="imageRef?.showPreview()">
    <el-image
      v-if="previewUrl && !previewError"
      ref="imageRef"
      class="preview"
      :src="previewUrl"
      :previewSrcList="[previewUrl]"
      previewTeleported
      fit="cover"
      :alt="label"
      draggable="false"
      @click.stop
      @error="previewError = '无法预览该图片'" />
    <icon-photo v-else class="typeIcon" :size="21" aria-hidden="true" />
    <span class="guideBadge" aria-hidden="true">引导</span>
    <div class="guideLabel" aria-hidden="true">{{ label }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElImage } from "element-plus";
import { IconPhoto } from "@tabler/icons-vue";
import { useNodeFiles } from "@toonflow/nodes-scaffold/workspaceFiles";

const props = defineProps<{ image: { path: string; mimeType: string; label: string } }>();
const imageRef = ref<InstanceType<typeof ElImage>>();
const previewError = ref("");
const media = computed(() => ({ url: props.image.path, mimeType: props.image.mimeType }));
const label = computed(() => props.image.label);
const title = computed(() => `引导参考图：${label.value}${previewError.value ? `（${previewError.value}）` : ""}`);

watch(media, () => { previewError.value = ""; });
const { useFileUrl } = useNodeFiles();
const previewUrl = useFileUrl(media, () => { previewError.value = "读取引导参考图失败"; });
</script>

<style scoped>
.guideCard {
  position: relative;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  box-sizing: border-box;
  width: 48px;
  height: 48px;
  overflow: hidden;
  border: 1px dashed var(--el-border-color);
  border-radius: var(--el-border-radius-base, 8px);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  cursor: default;
  user-select: none;

  &:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: -2px;
  }

  .preview {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .guideBadge {
    position: absolute;
    top: 2px;
    left: 2px;
    padding: 0 2px;
    border-radius: 3px;
    background: var(--el-bg-color-overlay);
    color: var(--el-text-color-primary);
    font-size: 9px;
    line-height: 13px;
  }

  .guideLabel {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    overflow: hidden;
    padding: 1px 3px;
    background: color-mix(in srgb, var(--el-bg-color-overlay) 85%, transparent);
    color: var(--el-text-color-primary);
    font-size: 9px;
    line-height: 12px;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
