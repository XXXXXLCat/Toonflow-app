<template>
  <el-popover
    v-model:visible="visible"
    virtualTriggering
    :virtualRef="trigger"
    placement="bottom-start"
    :width="340"
    :persistent="false"
    :showArrow="false"
    :disabled="disabled || !src"
    :popperStyle="{ maxWidth: 'calc(100vw - 24px)', padding: '16px', borderRadius: '12px' }">
    <div class="mirrorPanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @keydown.esc.prevent="visible = false; trigger?.focus()">
      <div class="panelHeader">
        <strong>镜像 / 旋转</strong>
        <span>保留原图</span>
      </div>
      <div class="mirrorPreview" :class="{ empty: !src }">
        <img v-if="src" :src="src" :style="{ transform: previewTransform || undefined }" alt="镜像效果预览" />
        <span v-else>暂无图片</span>
      </div>
      <div class="mirrorActions" aria-label="镜像与旋转操作">
        <button
          v-for="action in MIRROR_ACTIONS"
          :key="action.key"
          type="button"
          class="mirrorButton"
          :aria-label="action.label"
          :disabled="mirroring || disabled || !src"
          @click="runMirror(action.key)"
          @mouseenter="previewTransform = action.css"
          @mouseleave="previewTransform = ''"
          @focus="previewTransform = action.css"
          @blur="previewTransform = ''">
          <component :is="action.icon" :size="20" aria-hidden="true" />
          <span class="mirrorLabel">{{ action.label }}</span>
          <small>{{ action.hint }}</small>
        </button>
      </div>
      <p class="mirrorHint">点击即生成新节点，原图保留；90° 旋转会交换宽高。</p>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { useNode, useVueFlow, type Node } from "@vue-flow/core";
import { ElMessage, ElPopover } from "element-plus";
import { IconFlipHorizontal, IconFlipVertical, IconRotate2, IconRotateClockwise, IconRotateClockwise2 } from "@tabler/icons-vue";
import { uploadNodeFile, useNodeFiles } from "@toonflow/nodes-scaffold/runtime";
import { showNodeError } from "../showNodeError";

const props = defineProps<{ src: string; disabled?: boolean; active: boolean; nodeType?: string }>();
const { node } = useNode();
const { addNodes, findNode, getNodes, nodeTypes, onNodeDragStart, onSelectionStart, onMoveStart } = useVueFlow();
const files = useNodeFiles();
const getCanvas = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
const visible = ref(false);
const trigger = ref<HTMLElement>();
const mirroring = ref(false);
const previewTransform = ref("");
// ACT: 悬停某个操作时用 CSS 变换实时预览效果（纯视觉，不影响最终 canvas 绘制）。
const MIRROR_ACTIONS = [
  { key: "flipX", label: "左右翻转", hint: "水平镜像", icon: IconFlipHorizontal, css: "scaleX(-1)" },
  { key: "flipY", label: "上下翻转", hint: "垂直镜像", icon: IconFlipVertical, css: "scaleY(-1)" },
  { key: "rotate90", label: "顺时针 90°", hint: "向右旋转", icon: IconRotateClockwise, css: "rotate(90deg)" },
  { key: "rotate270", label: "逆时针 90°", hint: "向左旋转", icon: IconRotateClockwise2, css: "rotate(-90deg)" },
  { key: "rotate180", label: "180°", hint: "旋转半圈", icon: IconRotate2, css: "rotate(180deg)" },
] as const;
type MirrorKey = typeof MIRROR_ACTIONS[number]["key"];
// ACT: 旋转 90° 的倍数需要交换宽高（swapped），翻转类保持原尺寸。
const SWAPPED: MirrorKey[] = ["rotate90", "rotate270"];
// 镜像出来的图用哪种节点承载由调用方决定：默认内置图片节点；ComfyUI 宿主传自己的类型，
// 让结果与宿主同型（保留该节点的全部玩法按钮）。
const targetType = computed(() => props.nodeType || "remote-imageNode");
let mirrorController: AbortController | undefined;

watch(() => props.src, () => {
  mirrorController?.abort();
  visible.value = false;
}, { flush: "sync" });
watch(() => props.disabled, disabled => {
  if (disabled) { mirrorController?.abort(); visible.value = false; }
}, { flush: "sync" });
watch(() => props.active, active => { if (!active) visible.value = false; });
watch(() => getCanvas?.()?.id, () => { mirrorController?.abort(); visible.value = false; }, { flush: "sync" });
onNodeDragStart(() => { visible.value = false; });
onSelectionStart(() => { visible.value = false; });
onMoveStart(() => { visible.value = false; });
onBeforeUnmount(() => mirrorController?.abort());

function open(event: MouseEvent) {
  if (props.disabled || !props.src) return;
  trigger.value = event.currentTarget as HTMLElement;
  visible.value = !visible.value;
}

defineExpose({ open, mirroring });

function runMirror(key: MirrorKey) {
  if (mirroring.value || props.disabled || !props.src) return;
  const type = targetType.value;
  if (!nodeTypes?.value?.[type]) return void ElMessage.error("请先启用对应的节点插件");
  mirroring.value = true;
  const controller = mirrorController = new AbortController();
  const action = MIRROR_ACTIONS.find(item => item.key === key)!;
  const source = new Image();
  const canvas = document.createElement("canvas");
  const pendingIds: string[] = [];
  let committed = false;
  void (async () => {
    let workspace: ReturnType<typeof files.getWorkspaceFiles> | undefined;
    try {
      workspace = files.getWorkspaceFiles();
      source.src = props.src;
      await source.decode();
      controller.signal.throwIfAborted();
      const { naturalWidth: width, naturalHeight: height } = source;
      const swap = SWAPPED.includes(key);
      canvas.width = swap ? height : width;
      canvas.height = swap ? width : height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建图片画布");
      // ACT: 先平移再缩放/旋转，让变换后的图像完整落在画布左上角。
      context.save();
      if (key === "flipX") { context.translate(width, 0); context.scale(-1, 1); }
      else if (key === "flipY") { context.translate(0, height); context.scale(1, -1); }
      else if (key === "rotate90") { context.translate(height, 0); context.rotate(Math.PI / 2); }
      else if (key === "rotate270") { context.translate(0, width); context.rotate(-Math.PI / 2); }
      // ACT: 180° = 水平 + 垂直同时翻转（等价于绕中心旋转半圈，宽高不变）。
      else { context.translate(width, height); context.scale(-1, -1); }
      context.drawImage(source, 0, 0);
      context.restore();
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片处理失败")), "image/png"));
      controller.signal.throwIfAborted();
      const id = crypto.randomUUID();
      pendingIds.push(id);
      const path = await uploadNodeFile(workspace, id, new File([blob], "mirror.png", { type: "image/png" }));
      controller.signal.throwIfAborted();
      const suffix = action.label.replace(/\s/g, "");
      const newNode: Node = {
        id,
        type,
        position: { x: 0, y: 0 },
        data: { label: `${node.data.label || "图片"} · ${suffix}`, outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } } } },
      };
      // ACT: 结果节点放源节点右侧，与既有节点重叠时向下让位（单节点，简化避让）。
      const x = node.computedPosition.x + node.dimensions.width + 80;
      let y = node.computedPosition.y;
      for (const other of getNodes.value) {
        const position = other.computedPosition;
        if (position.x < x + 320 && position.x + other.dimensions.width > x && position.y < y + 360 && position.y + other.dimensions.height > y) {
          y = position.y + other.dimensions.height + 40;
        }
      }
      newNode.position = { x, y };
      if (findNode(node.id) !== node || !nodeTypes?.value?.[type]) throw new Error("画布节点已变化，请重试");
      await batchHistory(async () => {
        controller.signal.throwIfAborted();
        addNodes([newNode]);
        committed = true;
      });
      visible.value = false;
      previewTransform.value = "";
      ElMessage.success(`已生成「${suffix}」图片节点`);
    } catch (error) {
      if (!controller.signal.aborted) showNodeError(error, "镜像处理失败");
    } finally {
      source.removeAttribute("src");
      canvas.width = canvas.height = 0;
      if (!committed && workspace) {
        const results = await Promise.allSettled(pendingIds.map(id => workspace!.remove(`assets/${id}`, true)));
        if (results.some(result => result.status === "rejected" && result.reason?.response?.data?.data?.code !== "ENOENT")) {
          ElMessage.error("处理中断，临时图片清理失败");
        }
      }
      mirroring.value = false;
      mirrorController = undefined;
    }
  })();
}
</script>

<style scoped lang="scss">
.mirrorPanel {
  color: var(--el-text-color-primary);

  .panelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;

    span { color: var(--el-text-color-secondary); font-size: 12px; }
  }

  .mirrorPreview {
    display: grid;
    place-items: center;
    height: 156px;
    padding: 8px;
    border-radius: 8px;
    background: var(--el-fill-color-light);
    overflow: hidden;

    img {
      display: block;
      max-width: 100%;
      max-height: 140px;
      transition: transform 0.18s ease;
    }

    &.empty { color: var(--el-text-color-placeholder); font-size: 12px; }
  }

  .mirrorActions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 14px 0 10px;

    .mirrorButton {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 10px 4px;
      border: 1px solid var(--el-border-color-light);
      border-radius: 8px;
      background: var(--el-fill-color-blank);
      color: var(--el-text-color-regular);
      font: inherit;
      cursor: pointer;

      &:hover, &:focus-visible { border-color: var(--el-color-primary); color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
      &:disabled { cursor: wait; opacity: 0.65; }

      .mirrorLabel { font-size: 13px; }

      small { font-size: 11px; opacity: 0.7; }
    }

    // ACT: 5 个操作，最后一个跨满两列，避免半行空白；内容整体居中，别贴左。
    .mirrorButton:last-child { grid-column: span 2; flex-direction: row; justify-content: center; gap: 8px; }
  }

  .mirrorHint {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}
</style>
