<template>
  <el-popover
    v-model:visible="visible"
    virtualTriggering
    :virtualRef="trigger"
    placement="bottom-start"
    :width="380"
    :persistent="false"
    :showArrow="false"
    :disabled="disabled || !src"
    :popperStyle="{ maxWidth: 'calc(100vw - 24px)', padding: '16px', borderRadius: '12px' }">
    <div class="adjustPanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @keydown.esc.prevent="visible = false; trigger?.focus()">
      <div class="panelHeader">
        <strong>调整</strong>
        <button type="button" class="resetButton" :disabled="applying || isNoop" @click="reset">重置</button>
      </div>
      <div class="adjustPreview">
        <canvas ref="previewCanvas" class="previewCanvas" aria-label="调整效果预览" />
        <span v-if="!src" class="empty">暂无图片</span>
        <span v-if="rendering" class="badge">预览中…</span>
      </div>
      <div class="adjustList">
        <div v-for="field in ADJUST_FIELDS" :key="field.key" class="adjustRow">
          <span class="adjustLabel">{{ field.label }}</span>
          <el-slider
            v-model="params[field.key]"
            :min="field.min"
            :max="field.max"
            :step="0.01"
            :show-tooltip="false"
            size="small"
            @input="schedulePreview" />
          <span class="adjustValue" :class="{ changed: params[field.key] !== 0 }">{{ format(params[field.key]) }}</span>
        </div>
      </div>
      <div class="adjustFooter">
        <span>拖到满意后应用，会生成新节点、原图保留。</span>
        <button type="button" class="applyButton" :disabled="applying || isNoop || disabled" @click="apply">应用</button>
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { useNode, useVueFlow, type Node } from "@vue-flow/core";
// ⚠️ UMD 节点包是独立打包的，Element Plus 不会自动注册：用到的组件必须显式 import，
// 否则模板里的 <el-slider> 会被当成未知元素留下一个空壳（面板照常弹出、滑块一个都不显示）。
import { ElMessage, ElPopover, ElSlider } from "element-plus";
import { uploadNodeFile, useNodeFiles } from "@toonflow/nodes-scaffold/runtime";
import { ADJUST_FIELDS, applyImageAdjust, defaultImageAdjust, isNoopImageAdjust, type ImageAdjustParams } from "../imageAdjust";
import { showNodeError } from "../showNodeError";

const props = defineProps<{ src: string; disabled?: boolean; active: boolean; nodeType?: string }>();
const { node } = useNode();
const { addNodes, findNode, getNodes, nodeTypes, onNodeDragStart, onSelectionStart, onMoveStart } = useVueFlow();
const files = useNodeFiles();
const getCanvas = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());

const visible = ref(false);
const trigger = ref<HTMLElement>();
const applying = ref(false);
const rendering = ref(false);
const previewCanvas = ref<HTMLCanvasElement>();
const params = ref<ImageAdjustParams>(defaultImageAdjust());
const isNoop = computed(() => isNoopImageAdjust(params.value));
// 目标节点类型由调用方决定：默认内置图片节点；ComfyUI 宿主传自己的类型，
// 让结果与宿主同型（保留该节点的全部玩法按钮）——调整只搬像素，不出新画面，属承载型。
const targetType = computed(() => props.nodeType || "remote-imageNode");

// 源图与它的降采样副本：预览始终从副本出发重算，避免多次叠加。
const source = new Image();
const previewWidth = ref(0);
const previewHeight = ref(0);
let sourceReady = false;
let baseImage: ImageData | undefined;
let frame = 0;
let idlePreview: ReturnType<typeof requestIdleCallback> | undefined;
let controller: AbortController | undefined;

function format(value: number) {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
}

function reset() {
  params.value = defaultImageAdjust();
  schedulePreview();
}

/** 载入源图并铺上一条预览副本（缩小到宽 512，够看又够快）。 */
async function ensureSource() {
  if (sourceReady) return;
  const url = props.src;
  if (!url) throw new Error("暂无图片");
  source.src = url;
  await source.decode();
  const width = source.naturalWidth;
  const height = source.naturalHeight;
  if (!width || !height) throw new Error("无法读取图片尺寸");
  const scale = Math.min(1, 512 / Math.max(width, height));
  previewWidth.value = Math.max(1, Math.round(width * scale));
  previewHeight.value = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = previewWidth.value;
  canvas.height = previewHeight.value;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建图片画布");
  context.drawImage(source, 0, 0, previewWidth.value, previewHeight.value);
  baseImage = context.getImageData(0, 0, previewWidth.value, previewHeight.value);
  sourceReady = true;
}

function paintPreview() {
  const canvas = previewCanvas.value;
  if (!canvas || !baseImage) return;
  canvas.width = previewWidth.value;
  canvas.height = previewHeight.value;
  const context = canvas.getContext("2d");
  if (!context) return;
  const image = new ImageData(new Uint8ClampedArray(baseImage.data), previewWidth.value, previewHeight.value);
  applyImageAdjust(image, params.value);
  context.putImageData(image, 0, 0);
}

/** 滑块连续拖动时用帧节流，别让每张预览都同步算完。 */
function schedulePreview() {
  if (!visible.value) return;
  rendering.value = true;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    void (async () => {
      try {
        await ensureSource();
        paintPreview();
      } catch {
        // 预览失败不影响最终导出，导出时会再报一次真正的错误
      } finally {
        rendering.value = false;
      }
    })();
  });
}

watch(() => props.src, () => {
  controller?.abort();
  visible.value = false;
  sourceReady = false;
  baseImage = undefined;
  source.removeAttribute("src");
}, { flush: "sync" });
watch(() => props.disabled, disabled => {
  if (disabled) { controller?.abort(); visible.value = false; }
}, { flush: "sync" });
watch(() => props.active, active => { if (!active) visible.value = false; });
watch(() => getCanvas?.()?.id, () => { controller?.abort(); visible.value = false; }, { flush: "sync" });
onNodeDragStart(() => { visible.value = false; });
onSelectionStart(() => { visible.value = false; });
onMoveStart(() => { visible.value = false; });
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  if (idlePreview !== undefined) cancelIdleCallback(idlePreview);
  controller?.abort();
  source.removeAttribute("src");
});

function open(event: MouseEvent) {
  if (props.disabled || !props.src) return;
  trigger.value = event.currentTarget as HTMLElement;
  visible.value = !visible.value;
  // 面板一打开先垫一张预览，免得归一化之前是空白。
  void schedulePreview();
  if (idlePreview !== undefined) cancelIdleCallback(idlePreview);
  idlePreview = requestIdleCallback(() => void ensureSource().catch(() => undefined));
}

defineExpose({ open, busy: applying });

/** 按原图全分辨率重算一次——清晰度这类 local contrast 算子必须在原分辨率上做才准。 */
async function renderFull(): Promise<Blob> {
  await ensureSource();
  const width = source.naturalWidth;
  const height = source.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建图片画布");
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, width, height);
  applyImageAdjust(image, params.value);
  context.putImageData(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片处理失败")), "image/png"));
}

function apply() {
  if (applying.value || props.disabled || isNoop.value) return;
  const type = targetType.value;
  if (!nodeTypes?.value?.[type]) return void ElMessage.error("请先启用对应的节点插件");
  applying.value = true;
  const local = new AbortController();
  controller = local;
  const workspace = files.getWorkspaceFiles();
  const pendingIds: string[] = [];
  let committed = false;
  // 摘要放进节点名里，历史记录里能一眼看出调了什么。
  const summary = ADJUST_FIELDS.filter(field => params.value[field.key] !== 0).map(field => field.label).slice(0, 3).join("·");
  void (async () => {
    try {
      const blob = await renderFull();
      local.signal.throwIfAborted();
      const id = crypto.randomUUID();
      pendingIds.push(id);
      const path = await uploadNodeFile(workspace, id, new File([blob], "adjust.png", { type: "image/png" }));
      local.signal.throwIfAborted();
      const suffix = summary ? `调整 ${summary}` : "调整";
      const newNode: Node = {
        id,
        type,
        position: { x: 0, y: 0 },
        data: { label: `${node.data.label || "图片"} · ${suffix}`, outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } } } },
      };
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
        local.signal.throwIfAborted();
        addNodes([newNode]);
        committed = true;
      });
      visible.value = false;
      ElMessage.success(`已生成「${suffix}」图片节点`);
    } catch (error) {
      if (!local.signal.aborted) showNodeError(error, "调整失败");
    } finally {
      if (!committed) {
        const results = await Promise.allSettled(pendingIds.map(item => workspace.remove(`assets/${item}`, true)));
        if (results.some(result => result.status === "rejected" && result.reason?.response?.data?.data?.code !== "ENOENT")) {
          ElMessage.error("处理中断，临时图片清理失败");
        }
      }
      applying.value = false;
      controller = undefined;
    }
  })();
}
</script>

<style scoped lang="scss">
.adjustPanel {
  color: var(--el-text-color-primary);

  .panelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;

    .resetButton {
      padding: 0;
      border: 0;
      background: none;
      color: var(--el-color-primary);
      font: inherit;
      font-size: 12px;
      cursor: pointer;

      &:disabled { color: var(--el-text-color-disabled); cursor: default; }
    }
  }

  .adjustPreview {
    position: relative;
    display: grid;
    place-items: center;
    height: 150px;
    padding: 6px;
    border-radius: 8px;
    background: var(--el-fill-color-light);
    overflow: hidden;

    .previewCanvas {
      display: block;
      max-width: 100%;
      max-height: 138px;
      border-radius: 4px;
    }

    .empty { color: var(--el-text-color-placeholder); font-size: 12px; }

    .badge {
      position: absolute;
      right: 10px;
      bottom: 10px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--el-fill-color);
      color: var(--el-text-color-secondary);
      font-size: 11px;
    }
  }

  .adjustList {
    max-height: 232px;
    margin: 12px 0;
    padding-right: 4px;
    overflow-y: auto;

    &::-webkit-scrollbar { width: 8px; }
    &::-webkit-scrollbar-thumb {
      border: 2px solid transparent;
      border-radius: 999px;
      background-clip: padding-box;
      background-color: color-mix(in oklch, var(--el-border-color) 100%, transparent);
    }
    &::-webkit-scrollbar-thumb:hover { background-color: color-mix(in oklch, var(--el-border-color-hover) 100%, transparent); }
    &::-webkit-scrollbar-track { background: transparent; }
  }

  .adjustRow {
    display: grid;
    grid-template-columns: 68px minmax(0, 1fr) 46px;
    align-items: center;
    gap: 8px;
    padding: 2px 0;

    .adjustLabel { font-size: 12px; color: var(--el-text-color-regular); }

    .adjustValue {
      font-size: 12px;
      color: var(--el-text-color-secondary);
      text-align: right;
      font-variant-numeric: tabular-nums;

      &.changed { color: var(--el-color-primary); }
    }
  }

  .adjustFooter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    span { font-size: 12px; color: var(--el-text-color-secondary); }

    .applyButton {
      flex: none;
      padding: 6px 14px;
      border: 0;
      border-radius: 6px;
      background: var(--el-color-primary);
      color: #fff;
      font: inherit;
      font-size: 13px;
      cursor: pointer;

      &:disabled { opacity: 0.5; cursor: default; }
    }
  }
}
</style>
