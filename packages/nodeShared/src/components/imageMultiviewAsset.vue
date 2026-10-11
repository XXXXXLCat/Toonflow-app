<template>
  <teleport :to="target ?? 'body'" :disabled="!target">
    <section v-show="!!target" class="multiviewAssetPanel nodrag nopan nowheel" aria-label="制作资产" @pointerdown.stop @mousedown.stop @dblclick.stop @wheel.stop @keydown.stop>
      <header class="panelHeader">
        <div><icon-layout-board-split :size="18" /><strong>制作资产</strong><span>把单张立绘转成多角度角色板</span></div>
        <el-button :icon="IconX" text :disabled="generating" aria-label="关闭制作资产" @click="emit('close')" />
      </header>
      <!-- 版式的唯一变量是右段格数；面板给三种预设，选哪个就把哪张灰模作为第二参考，
           同时用该版式写死的提示词一起加强引导。画幅随版式走，不用用户手动对齐。 -->
      <div class="layoutSection">
        <span class="sectionLabel">版式 · 右段头部格数</span>
        <div class="layoutGrid" role="group" aria-label="版式">
          <button
            v-for="option in layoutOptions"
            :key="option.id"
            type="button"
            class="layoutOption"
            :class="{ active: settings.layout === option.id }"
            :disabled="generating"
            :aria-pressed="settings.layout === option.id"
            @click="settings.layout = option.id">
            <img :src="option.url" alt="" aria-hidden="true" />
            <b>{{ option.label }}</b>
            <i>{{ option.hint }}</i>
          </button>
        </div>
        <div class="layoutPreview" :style="{ aspectRatio: previewRatio, gridTemplateColumns: `${sectionWidth.left}fr ${sectionWidth.right}fr` }" role="img" :aria-label="`左段三竖栏躯干，右段${rightViews.length}格头部`">
          <div class="leftSection" aria-hidden="true">
            <span v-for="view in leftViews" :key="view">{{ view }}</span>
          </div>
          <div class="rightSection" aria-hidden="true" :style="{ gridTemplateRows: `repeat(${rightViews.length}, minmax(0, 1fr))` }">
            <span v-for="view in rightViews" :key="view">{{ view }}</span>
          </div>
        </div>
        <p class="layoutHint">左段固定三竖栏（约占 <b>{{ sectionWidthLabel }}</b> 画幅）放躯干剪裁与背面，右段放脸与颈。左段刻意裁掉头部，让领口、肩线、袖长在竖栏里看得更清，头部信息由右段承接——<b>三张版式的差别只在右段放几个头</b>。</p>
        <p class="layoutHint">画幅跟着版式走：<b>{{ settings.ratio }}</b>（{{ settings.layout === "oneHead" ? "右段单格竖长大脸" : "右段两三个横栏，整板更方" }}），与所选灰模比例一致。</p>
      </div>
      <imageVariationGenerator
        v-model:generating="generating"
        :settings="settings"
        :source="source"
        :aspectRatio="sourceRatio"
        :prompt="prompt"
        :disabled="props.disabled"
        :nodeType="nodeType"
        :extraImages="extraImages"
        :guideLabel="guideLabel"
        :lockedRatio="true"
        :rewriteDefault="false"
        label="制作资产"
        buttonLabel="生成角色板"
        @generated="emit('close')" />
      <!-- 只用来读原图比例，不展示。 -->
      <img v-if="src" :src="src" class="ratioProbe" alt="" aria-hidden="true" @load="readRatio" />
    </section>
  </teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useNode } from "@vue-flow/core";
import { ElButton } from "element-plus";
import { IconLayoutBoardSplit, IconX } from "@tabler/icons-vue";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { buildMultiviewAssetPrompt, multiviewAssetLayoutOf, multiviewAssetLayouts, multiviewAssetLeftViews, multiviewAssetRatioOf, multiviewAssetRightViews, multiviewAssetSectionWidth, readMultiviewAssetSettings, type MultiviewAssetSettings } from "../multiviewAsset";
import imageVariationGenerator from "./imageVariationGenerator.vue";

const props = defineProps<{ src: string; source?: NodeMediaValue; target?: HTMLElement; disabled?: boolean; nodeType?: string }>();
const emit = defineEmits<{ close: [] }>();
const { node } = useNode();
node.data.multiviewAsset = readMultiviewAssetSettings(node.data.multiviewAsset);
const settings = computed(() => node.data.multiviewAsset as MultiviewAssetSettings);
const generating = ref(false);

const layoutOptions = multiviewAssetLayouts;
const leftViews = multiviewAssetLeftViews;
// 缩略图的右段格数跟着选中版式走，三张版式的差别一眼可见。
const rightViews = computed(() => multiviewAssetRightViews[settings.value.layout]);
// 两段列宽也跟版式走：单头右段放大到 1/3（只有一格大脸，给 1/4 会画不细），双头与三头仍 1/4。
// 缩略图与提示词共用同一张表，避免两处各写一份段宽而漂移。
const sectionWidth = computed(() => multiviewAssetSectionWidth[settings.value.layout]);
const sectionWidthLabel = computed(() => `${sectionWidth.value.left}/${sectionWidth.value.left + sectionWidth.value.right}`);
const sourceRatio = ref(0);
const prompt = computed(() => buildMultiviewAssetPrompt(settings.value.layout));
// 所选版式的灰模作为第二参考提交；编号顺延在连线立绘（{{ref 1}}）之后，所以它就是 {{ref 2}}。
const extraImages = computed(() => {
  const layout = multiviewAssetLayoutOf(settings.value.layout);
  return layout ? [{ path: layout.url, mimeType: "image/jpeg" }] : [];
});
// 引导图在新节点底栏显示时用的名字：点明是哪张版式，用户一眼看出这张板照的是什么排布。
const guideLabel = computed(() => `${multiviewAssetLayoutOf(settings.value.layout)?.label ?? "版式"}版式`);
// 画幅是版式的函数（单头 16:9 / 双头与三头 4:3）：切版式时把比例一并带过去，
// 不让用户手动对齐——画布与灰模比例一致，模型照图排布时不会被拉伸。
watch(() => settings.value.layout, layout => {
  settings.value.ratio = multiviewAssetRatioOf(layout);
}, { immediate: true });
// 缩略图按真实画幅给比例，用户点生成前就看得出 16:9 与 4:3 的板形差别。
const previewRatio = computed(() => {
  const [w, h] = settings.value.ratio.split(":").map(Number);
  return w && h ? `${w} / ${h}` : "4 / 3";
});

defineExpose({ generating });

function readRatio(event: Event) {
  const image = event.target as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  sourceRatio.value = image.naturalWidth / image.naturalHeight;
}
</script>

<style scoped lang="scss">
.multiviewAssetPanel {
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
  .layoutHint { margin: 8px 0 0; color: var(--el-text-color-secondary); line-height: 1.6; }
  b { color: var(--el-text-color-regular); font-weight: 500; font-variant-numeric: tabular-nums; }

  // 版式缩略图：左段固定三竖栏，右段横栏数跟着选中版式（1/2/3 格）；
  // 整体比例由内联的 aspect-ratio 按真实画幅给（16:9 或 4:3），
  // 两段列宽由内联的 grid-template-columns 按版式给（单头 2:1，双头与三头 3:1）——
  // 让用户点生成前就看懂板里两段各占多宽。
  .layoutPreview {
    display: grid; gap: 5px;
    .leftSection {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px;
      span { display: grid; place-items: center; padding: 4px; border: 1px solid var(--el-border-color-lighter); border-radius: 7px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); text-align: center; line-height: 1.4; }
    }
    .rightSection {
      display: grid; gap: 5px;
      span { display: grid; place-items: center; padding: 4px; border: 1px solid var(--el-border-color-lighter); border-radius: 7px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); text-align: center; line-height: 1.4; }
    }
  }
  // 版式选择器：每格上方是灰模预览、下方是名称与说明。三张图的差别就在右段格数，
  // 预览图按原图比例展示，用户一眼能看出选了哪个。
  .layoutGrid {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-bottom: 10px;
    .layoutOption {
      display: grid; gap: 4px; padding: 6px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px;
      color: var(--el-text-color-regular); background: var(--el-fill-color-light); cursor: pointer; font: inherit; text-align: left;
      img {
        display: block; width: 100%; height: 54px;
        border-radius: 5px; background: var(--el-bg-color-overlay); object-fit: contain;
      }
      b { font-weight: 500; }
      i { color: var(--el-text-color-secondary); font-style: normal; line-height: 1.4; }
    }
    .layoutOption.active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
    .layoutOption.active b { color: var(--el-color-primary); }
    .layoutOption:disabled { opacity: .5; cursor: default; }
  }
}
.ratioProbe { display: none; }
</style>
