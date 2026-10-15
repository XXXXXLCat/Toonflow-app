<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    :bottomWidth="660"
    toolbar-two-row
    :style="{ width: (previewUrl || inpaintGuideUrl) && imageWidth ? `${imageWidth + 18}px` : undefined }">
    <template v-if="editor?.mode" #top><div ref="paintToolbar" /></template>
    <template #topActions>
      <el-button
        :icon="IconPanoramaHorizontal"
        :disabled="generating || deleting || uploading || editor?.busy || gridSplit?.splitting || !previewUrl"
        text
        title="全景图"
        aria-label="全景图"
        @click.stop="panorama?.open($event)">全景图<icon-chevron-down :size="14" /></el-button>
      <el-button
        :icon="IconBrush"
        :disabled="generating || deleting || uploading || gridSplit?.splitting || !previewUrl || panorama?.busy"
        text
        title="局部重绘"
        aria-label="局部重绘"
        @click.stop="startEditor('inpaint')">局部重绘</el-button>
      <el-button
        :icon="IconSun"
        :disabled="generating || deleting || uploading || editor?.busy || gridSplit?.splitting || !previewUrl"
        text
        title="打光"
        aria-label="打光"
        @click.stop="openLighting">打光</el-button>
      <el-button
        :icon="IconCameraRotate"
        :disabled="generating || deleting || uploading || editor?.busy || gridSplit?.splitting || !previewUrl"
        text
        title="多角度"
        aria-label="多角度"
        @click.stop="openMultiAngle">多角度</el-button>
      <el-button
        :icon="IconLayoutBoardSplit"
        :disabled="generating || deleting || uploading || editor?.busy || gridSplit?.splitting || !previewUrl"
        text
        title="制作资产：把单张立绘转成多角度角色板（六格一张）"
        aria-label="制作资产"
        @click.stop="openMultiviewAsset">制作资产</el-button>
      <el-button
        :icon="IconArrowsMaximize"
        :disabled="generating || deleting || uploading || editor?.busy || gridSplit?.splitting || !previewUrl"
        :loading="outpaint?.generating"
        text
        title="扩图"
        aria-label="扩图"
        @click.stop="openOutpaint">扩图</el-button>
      <el-button
        :icon="IconUserScan"
        :disabled="generating || deleting || uploading || editor?.busy || gridSplit?.splitting || !previewUrl"
        :loading="toonSwap?.busy"
        text
        title="漫 / 真互转：动漫转真人、真人转动漫"
        aria-label="漫/真互转"
        @click.stop="toonSwap?.open($event)">漫/真互转</el-button>
      <el-button
        :icon="IconZoomIn"
        :disabled="generating || deleting || uploading || editor?.busy || gridSplit?.splitting || !previewUrl || !upscaleModelChoice"
        :loading="upscale?.busy"
        :title="upscaleTitle"
        text
        aria-label="放大"
        @click.stop="upscale?.open($event)">放大</el-button>
    </template>
    <!-- 第二行：承载型（宫格切分 / 镜像）与管理类（替换图片 / 历史记录）——它们只搬动像素或管理产物，不生成新画面。 -->
    <template #topSecondaryActions>
      <el-button
        :icon="IconLayoutGrid"
        :disabled="generating || deleting || uploading || editor?.busy || !previewUrl || panorama?.busy"
        :loading="gridSplit?.splitting"
        text
        title="宫格切分"
        aria-label="宫格切分"
        @click.stop="gridSplit?.open($event)">宫格切分</el-button>
      <el-button
        :icon="IconFlipHorizontal"
        :disabled="generating || deleting || uploading || editor?.busy || !previewUrl || panorama?.busy"
        :loading="mirror?.mirroring"
        text
        title="镜像 / 旋转：左右翻转、上下翻转、顺时针 90°、逆时针 90°、180°"
        aria-label="镜像"
        @click.stop="mirror?.open($event)">镜像</el-button>
      <el-button
        :icon="IconAdjustmentsHorizontal"
        :disabled="generating || deleting || uploading || editor?.busy || !previewUrl || panorama?.busy"
        :loading="adjust?.busy"
        text
        title="调整：亮度、曝光、对比度、阴影、晕影、饱和度、暖色、淡色、清晰度"
        aria-label="调整"
        @click.stop="adjust?.open($event)">调整</el-button>
      <el-button
        :icon="IconTransfer"
        :loading="uploading"
        :disabled="generating || deleting || editor?.busy || panorama?.busy"
        text
        title="替换图片"
        aria-label="替换图片"
        @click.stop="fileInput?.click()">替换图片</el-button>
      <mediaHistory mediaType="image" :current="outputFile" :disabled="generating || deleting" @select="outputs.image = { dataType: 'IMAGE', value: $event }" />
    </template>
    <template #topRightActions>
      <el-button
        :icon="IconPencil"
        :disabled="generating || deleting || uploading || !previewUrl || gridSplit?.splitting || panorama?.busy"
        text
        title="标记"
        aria-label="标记"
        @click.stop="startEditor('mark')" />
    </template>
    <div v-loading="generating" class="imageContent nopan" :aria-busy="generating">
      <imageEditor
        v-if="previewUrl"
        ref="editor"
        :src="previewUrl"
        :toolbarTarget="paintToolbar"
        :disabled="generating || deleting || uploading"
        :nodeType="VARIATION_NODE.comfyui"
        :carrierNodeType="VARIATION_NODE.comfyui"
        alt="生成的图片"
        @load="resizeImage"
        @error="showNodeError(new Error('无法预览该图片'), '图片预览失败')" />
      <div v-else-if="inpaintGuideUrl" class="inpaintGuide">
        <img :src="inpaintGuideUrl" alt="局部重绘标注图" draggable="false" @load="resizeImage" @error="showNodeError(new Error('无法读取重绘标注图'), '重绘标注读取失败')" />
        <span>红色标注为重绘区域</span>
      </div>
      <div v-else class="imageEmpty" role="img" aria-label="暂无生成图片">
        <icon-photo-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
      <input
        ref="fileInput"
        class="fileInput"
        type="file"
        accept="image/*"
        aria-label="选择替换图片"
        :disabled="generating || deleting || uploading || editor?.busy"
        @change="replaceOutput" />
    </div>
    <template #bottom>
      <div v-if="lightingVisible" ref="lightingTarget" />
      <div v-else-if="multiAngleVisible" ref="multiAngleTarget" />
      <div v-else-if="multiviewAssetVisible" ref="multiviewAssetTarget" />
      <div v-else-if="outpaintVisible" ref="outpaintTarget" />
      <div v-else-if="editor?.mode === 'inpaint'" ref="inpaintTarget" />
      <el-card v-else class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <!-- 重绘子节点在出图后仍能回看重绘区域：上面那条 v-else-if 已保证提示词卡不在重绘态渲染 -->
        <el-button v-if="inpaintGuideUrl" class="inpaintInfo" text :icon="IconBrush" @click="inpaintPreviewVisible = true">查看重绘标注</el-button>
        <!-- 引用区：连线引用（可拖拽排序/删除）+ 玩法预置的引导参考图（只读）。
             两者都是本次生成真正会下发的参考图，排在一起用户才看得出「一共引用了什么」——
             引导图不走连线，不显示的话画布上完全看不出它存在。 -->
        <div v-if="refList.length || guideImage" class="referenceRow">
          <referenceItem
            v-if="refList.length"
            v-model="refList"
            @preview="setReferencePreview"
            @remove="removeReference" />
          <guideReferenceCard v-if="guideImage" :image="guideImage" />
        </div>
        <!-- 放大类模型没有提示词通道，整块藏起来，不留任何说明文字 -->
        <promptInput v-if="!upscaleModel" v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" expandable />
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || deleting"
            placeholder="选择图片模型"
            aria-label="图片生成模型"
            noDataText="未找到可用的图片供应商，请先在「设置 → 媒体模型」中安装"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showNodeError(error, '图片模型读取失败'))">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option
                v-for="item in provider.models"
                :key="item.modelId"
                :label="item.label"
                :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <!-- 放大类模型只留放大倍数：分辨率、比例、提示词改写都不适用，参数按钮整个不显示 -->
          <generationSettings
            v-if="!upscaleModel"
            v-model:megapixels="data.megapixels"
            v-model:ratio="data.ratio"
            v-model:rewritePrompt="data.rewritePrompt"
            :megapixelOptions="megapixelOptions"
            :ratios="ratioOptions"
            :disabled="generating || deleting || !selectedModel" />
          <!-- 放大类模型只留放大倍数：分辨率、比例、提示词改写、LoRA 都不适用 -->
          <div v-if="upscaleModel" class="multiplierControl">
            <span class="multiplierLabel">放大倍数</span>
            <el-select
              v-model="data.multiplier"
              class="multiplierSelect"
              :disabled="generating || deleting"
              aria-label="放大倍数">
              <el-option v-for="item in multiplierOptions" :key="item" :label="`${item}×`" :value="item" />
            </el-select>
          </div>
          <loraStackPicker v-else v-model="data.loras" :disabled="generating || deleting || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="deleting || panorama?.visible || !!toonSwap?.busy || (!generating && (!selectedModel || (!upscaleModel && !generationPrompt) || (upscaleModel && !refList.some(item => item.dataType === 'IMAGE' && item.value))))"
            :title="generating ? '停止生成' : '生成图片'"
            :aria-label="generating ? '停止生成' : '生成图片'"
            @click="generating ? generationController?.abort() : startGeneration().catch((error) => showNodeError(error, '图片生成失败'))" />
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <el-image-viewer
    v-if="previewVisible && previewUrl"
    :urlList="[previewUrl]"
    teleported
    @close="previewVisible = false" />
  <el-image-viewer
    v-if="inpaintPreviewVisible && inpaintGuideUrl"
    :urlList="[inpaintGuideUrl]"
    teleported
    @close="inpaintPreviewVisible = false" />
  <imageAdjustPanel
    ref="adjust"
    :src="previewUrl"
    :disabled="generating || deleting || !!editor?.busy"
    :active="node.selected"
    :nodeType="VARIATION_NODE.comfyui" />
  <imageGridSplit ref="gridSplit" :src="previewUrl" :disabled="generating || deleting" :active="node.selected" :nodeType="VARIATION_NODE.comfyui" />
  <imageMirror ref="mirror" :src="previewUrl" :disabled="generating || deleting" :active="node.selected" :nodeType="VARIATION_NODE.comfyui" />
  <imageLighting
    v-if="lightingVisible"
    ref="lighting"
    :src="previewUrl"
    :source="outputFile"
    :target="lightingTarget"
    :nodeType="VARIATION_NODE.comfyui"
    :disabled="panelDisabled"
    @close="lightingVisible = false" />
  <imageMultiAngle
    v-if="multiAngleVisible"
    ref="multiAngle"
    :src="previewUrl"
    :source="outputFile"
    :target="multiAngleTarget"
    :nodeType="VARIATION_NODE.comfyui"
    :disabled="panelDisabled"
    @close="multiAngleVisible = false" />
  <imageMultiviewAsset
    v-if="multiviewAssetVisible"
    ref="multiviewAsset"
    :src="previewUrl"
    :source="outputFile"
    :target="multiviewAssetTarget"
    :nodeType="VARIATION_NODE.comfyui"
    :disabled="panelDisabled"
    @close="multiviewAssetVisible = false" />
  <imagePanorama
    ref="panorama"
    :src="previewUrl"
    :source="outputFile"
    :nodeType="VARIATION_NODE.comfyui"
    :disabled="panelDisabled"
    @open="openPanorama" />
  <imageToonSwap
    ref="toonSwap"
    :src="previewUrl"
    :source="outputFile"
    :nodeType="VARIATION_NODE.comfyui"
    :disabled="generating || deleting || uploading || editor?.busy || gridSplit?.splitting"
    :resolve-model="resolveEditModel"
    :rewrite-prompt="data.rewritePrompt" />
  <imageUpscale
    ref="upscale"
    :src="previewUrl"
    :source="outputFile"
    :nodeType="VARIATION_NODE.comfyui"
    :disabled="generating || deleting || uploading || editor?.busy || gridSplit?.splitting || !upscaleModelChoice"
    :multipliers="multiplierOptions"
    :size="data.megapixels"
    :resolve-model="resolveUpscaleModel" />
  <imageOutpaint
    v-if="outpaintVisible"
    ref="outpaint"
    :src="previewUrl"
    :source="outputFile"
    :target="outpaintTarget"
    :nodeType="VARIATION_NODE.comfyui"
    :disabled="panelDisabled"
    @close="outpaintVisible = false" />
  <imageInpaintPrompt
    v-if="editor?.mode === 'inpaint'"
    ref="inpaintPrompt"
    :target="inpaintTarget"
    :createDraft="createInpaint"
    :disabled="panelDisabled" />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref } from "vue";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElLoading, ElImageViewer } from "element-plus";
import { IconPhotoAi, IconSparkles, IconArrowUp, IconPlayerStop, IconLayoutGrid, IconFlipHorizontal, IconAdjustmentsHorizontal, IconTransfer, IconPencil, IconSun, IconCameraRotate, IconPanoramaHorizontal, IconChevronDown, IconArrowsMaximize, IconUserScan, IconBrush, IconZoomIn, IconLayoutBoardSplit } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, z, type NodeMediaModel, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { isImageCapableModel } from "@toonflow/node-shared/imageCapable";
import { modelIdOf, pickPlaybookModel, PLAYBOOK_MEGAPIXELS } from "@toonflow/node-shared/playbookDefaults";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import referenceItem from "@toonflow/node-shared/referenceItem";
import guideReferenceCard from "@toonflow/node-shared/guideReferenceCard";
import promptInput from "@toonflow/node-shared/promptInput";
import mediaHistory from "@toonflow/node-shared/mediaHistory";
import imageGridSplit from "@toonflow/node-shared/imageGridSplit";
import imageMirror from "@toonflow/node-shared/imageMirror";
import imageEditor from "@toonflow/node-shared/imageEditor";
import imageLighting from "@toonflow/node-shared/imageLighting";
import imageMultiAngle from "@toonflow/node-shared/imageMultiAngle";
import imageMultiviewAsset from "@toonflow/node-shared/imageMultiviewAsset";
import imagePanorama from "@toonflow/node-shared/imagePanorama";
import imageToonSwap from "@toonflow/node-shared/imageToonSwap";
import imageUpscale from "@toonflow/node-shared/imageUpscale";
import imageAdjustPanel from "@toonflow/node-shared/imageAdjustPanel";
import imageOutpaint from "@toonflow/node-shared/imageOutpaint";
import imageInpaintPrompt from "@toonflow/node-shared/imageInpaintPrompt";
import { useImageInpaint, type ImageInpaint, type InpaintDraftInput } from "@toonflow/node-shared/imageInpaint";
import { buildAnimeToRealPrompt } from "@toonflow/node-shared/imageAnimeToReal";
import { useImageVariationNode, VARIATION_NODE, AUTO_RATIO, recommendedLora } from "@toonflow/node-shared/useImageVariationNode";
import generationSettings from "./components/generationSettings.vue";
import loraStackPicker from "@toonflow/node-shared/loraStackPicker";

defineOptions({
  inheritAttrs: false,
  icon: IconPhotoAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "STRING"], label: "图片、文本输入" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({
  label: "ComfyUI 图片生成",
});
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; model: string; megapixels: string; ratio: string; rewritePrompt: boolean; loras?: { name: string; strength: number }[]; multiplier?: string; /** 一键玩法（局部重绘 / 漫真互转）挑过一次的模型，记住下次直接用。 */ playbookModel?: string });
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.megapixels ??= "1";
data.value.ratio ??= "1:1";
// 放大类模型的唯一参数：放大倍数。默认 2×（质量与耗时较平衡；4× 更慢且显存压力大）。
data.value.multiplier ??= "2";
// 默认重写：与工作流自带的重写分支（ComfySwitchNode.switch=true）保持一致。
data.value.rewritePrompt ??= true;
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const deleting = ref(false);
const previewVisible = ref(false);
const gridSplit = ref<InstanceType<typeof imageGridSplit>>();
const mirror = ref<InstanceType<typeof imageMirror>>();
const editor = ref<InstanceType<typeof imageEditor>>();
const lighting = ref<InstanceType<typeof imageLighting>>();
const lightingTarget = ref<HTMLElement>();
const lightingVisible = ref(false);
const multiAngle = ref<InstanceType<typeof imageMultiAngle>>();
const multiAngleTarget = ref<HTMLElement>();
const multiAngleVisible = ref(false);
const multiviewAsset = ref<InstanceType<typeof imageMultiviewAsset>>();
const multiviewAssetTarget = ref<HTMLElement>();
const multiviewAssetVisible = ref(false);
const panorama = ref<InstanceType<typeof imagePanorama>>();
const outpaint = ref<InstanceType<typeof imageOutpaint>>();
const outpaintTarget = ref<HTMLElement>();
const outpaintVisible = ref(false);
const inpaintPrompt = ref<InstanceType<typeof imageInpaintPrompt>>();
const inpaintTarget = ref<HTMLElement>();
const toonSwap = ref<InstanceType<typeof imageToonSwap>>();
const upscale = ref<InstanceType<typeof imageUpscale>>();
const adjust = ref<InstanceType<typeof imageAdjustPanel>>();
const createVariation = useImageVariationNode({ nodeType: VARIATION_NODE.comfyui });
const generateInpaint = useImageInpaint();
const paintToolbar = ref<HTMLElement>();
const fileInput = ref<HTMLInputElement>();
const uploading = ref(false);
const imageWidth = ref(0);
let generationController: AbortController | undefined;
const generationState = useNodeGeneration(outputs, () => generationController?.abort());
const { generating } = generationState;
let modelsRequest: Promise<void> | undefined;
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
// 可选参数由供应商的模型声明决定（imageSizes = 分辨率、imageRatios = 比例），未声明时用兜底值。
const DEFAULT_MEGAPIXELS = ["0.5", "1", "2", "4", "8"];
const DEFAULT_RATIOS = ["1:1"];
// 参考图能力由所选模型的 mode 声明决定（取值 text / singleImage / multiReference），未声明时按文生图处理。
const imageCapable = computed(() => isImageCapableModel(selectedModel.value));
// 「自适应」不是 W:H：选中它表示比例跟随参考图，供应商据此让主 latent 取参考图编码，节点也不传 ratio。
const megapixelOptions = computed(() => (selectedModel.value?.imageSizes?.length ? selectedModel.value.imageSizes : DEFAULT_MEGAPIXELS));
const ratioOptions = computed(() => {
  const declared = selectedModel.value?.imageRatios?.length ? selectedModel.value.imageRatios : DEFAULT_RATIOS;
  return imageCapable.value ? [...declared, AUTO_RATIO] : declared;
});
const usesRatio = computed(() => !imageCapable.value || data.value.ratio !== AUTO_RATIO);
// 放大/超分类模型（如 SeedVR2）：只接一张图、没有提示词与 LoRA 通道，画布只留放大倍数。
const upscaleModel = computed(() => selectedModel.value?.upscale === true);
const DEFAULT_MULTIPLIERS = ["1.5", "2", "3", "4"];
const multiplierOptions = computed(() => selectedModel.value?.upscaleMultipliers?.length ? selectedModel.value.upscaleMultipliers : DEFAULT_MULTIPLIERS);
// 「放大」按钮点一下就该出图，所以放大模型要能自己找：优先用户当前选中的放大模型，
// 否则取第一个声明了 upscale 的（SeedVR2 等）。一个都没有时按钮禁用。
const upscaleModelChoice = computed(() =>
  upscaleModel.value ? selectedModel.value : models.value.find((item) => item.upscale === true));
// 按钮提示列出可选倍数（如「放大：1.5× / 2× / 3× / 4×」），没装放大模型时改成安装提示。
const upscaleTitle = computed(() => upscaleModelChoice.value ? `放大：${multiplierOptions.value.map(value => `${value}×`).join(" / ")}（${upscaleModelChoice.value.label}）` : "请先在设置里安装放大模型（如 SeedVR2）");
const modelGroups = computed(() => groupNodeModels(models.value));
// 放大类模型没有提示词通道，schema 要求 prompt 非空，这里给一个占位值即可。
const generationPrompt = computed(() =>
  upscaleModel.value
    ? "upscale"
    : [
        data.value.prompt.trim(),
        ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])),
      ]
        .filter(Boolean)
        .join("\n\n")
        // 打光、多角度等玩法下发的提示词里带 {{ref N}} 标记，这里换成与引用编号一致的称呼，原样下发没有意义。
        .replace(/\{\{ref (\d+)\}\}/g, "参考 $1")
);
const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showNodeError(error, "图片读取失败")
);
// 局部重绘子节点在出图前没有输出，但有标注图（原图叠红色标记）——先把它显示出来，
// 用户才能确认涂的选区对不对，而不是对着一个空节点等结果。
const inpaintData = computed(() => (node.data as Record<string, unknown>).inpaint as ImageInpaint | undefined);
const inpaintGuideUrl = files.useFileUrl(
  () => inpaintData.value?.guide ? { url: inpaintData.value.guide, mimeType: "image/png" } : undefined,
  (error) => showNodeError(error, "重绘标注读取失败")
);
const inpaintPreviewVisible = ref(false);

/**
 * 一键玩法（局部重绘、漫真互转）用哪个模型。
 *
 * 它们不带模型下拉，只能自己找：① 默认「Qwen Image 2.1 图像编辑」（玩法是照着参考图改，
 * 执行者就是它）；② 退而求其次用上次挑过的（data.playbookModel）；
 * ③ 都没有就自动取第一个支持参考图的并记住。
 * 之前是「节点模型不支持参考图就禁用按钮」，逼用户先去换模型——玩法本来就该点了就用。
 */
async function resolveEditModel() {
  const items = models.value.length ? models.value : (await ai.getMediaModels()).filter((item) => item.type === "image");
  const preferred = pickPlaybookModel(items, data.value.model);
  // 记忆值只在默认模型不可用（没装 / 换名了）时才顶上，用户以前挑过的偏好不至于丢。
  const remembered = items.find((item) => modelIdOf(item) === data.value.playbookModel);
  const target = preferred ?? (remembered && isImageCapableModel(remembered) ? remembered : undefined) ?? items.find((item) => isImageCapableModel(item));
  if (!target) throw new Error("未找到支持参考图的图片模型，请先在「设置 → 媒体模型」中安装（如 Qwen Image Edit）");
  data.value.playbookModel = modelIdOf(target);
  return data.value.playbookModel;
}
// 面板打开期间底栏被面板接管，其余交互都要让路，避免读到半途的状态。
const panelDisabled = computed(() => generating.value || deleting.value || uploading.value || !!editor.value?.busy || !!gridSplit.value?.splitting || !!mirror.value?.mirroring);
// 玩法预置的引导参考图（「制作资产」的版式灰模等）。它不走连线，只在 data 上留一条标记，
// 底栏据此把它显示成一张只读卡片——否则画布上看不出它存在。
const guideImage = computed(() => (node.data as Record<string, unknown>).guideImage as { path: string; mimeType: string; label: string } | undefined);

onMounted(() => loadModels().catch((error) => showNodeError(error, "图片模型读取失败")));
onScopeDispose(() => {
  generationController?.abort();
});

// 百万像素档位 → 边长：按 1024 基数线性递进，1MP = 1024×1024、2MP = 2048×2048、4MP = 4096×4096。
// 厂商出图以此为准（不是按十进制百万），所以换算基数必须是 1024 而不是 10⁶。
// 比例非 1:1 时按面积守恒缩放：边长 = 基准边长 × √(比例)。
// 宽高取 8 的倍数。
function longEdgeFromMegapixels(mp: number, ratio: string): number {
  const match = /^(\d{1,4})\s*[:x×]\s*(\d{1,4})$/.exec(ratio);
  const rw = match ? parseInt(match[1], 10) : 1;
  const rh = match ? parseInt(match[2], 10) : 1;
  const longEdge = mp * 1024 * (rw >= rh ? Math.sqrt(rw / rh) : Math.sqrt(rh / rw));
  return Math.max(8, Math.round(longEdge / 8) * 8);
}

// 百万像素 → 等效面积边长（≈ √出图面积）：能吃参考图的供应商按这个口径接收尺寸，
// 因为跟随参考图比例时比例未知，只能用面积表达百万像素。同样取 8 的倍数。
// 注意这里是几何平均边长：2MP → 1448（面积恰为 2×1024²），与上面的档位边长不是一回事。
function areaSideFromMegapixels(mp: number): number {
  return Math.max(8, Math.round(Math.sqrt(mp) * 1024 / 8) * 8);
}

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then((items) => {
    if (generating.value || deleting.value) return;
    // ACT: 列出所有已安装的图片供应商，用户自行在设置里安装的本地 ComfyUI 工作流供应商也能选到。
    models.value = items.filter((item) => item.type === "image");
    // ACT: 只给空配置选默认工作流，保留暂时不可用的旧选择及其参数。优先内置供应商。
    if (!data.value.model) {
      const first = models.value.find((item) => item.providerId === "comfyuiImage") ?? models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
    // 参数随当前模型的能力收敛：不在可选范围内时回落到首项（模型暂时不可用时保留旧值）。
    if (selectedModel.value) {
      if (!megapixelOptions.value.includes(data.value.megapixels)) data.value.megapixels = megapixelOptions.value[0] ?? "1";
      if (!ratioOptions.value.includes(data.value.ratio)) data.value.ratio = ratioOptions.value[0] ?? "1:1";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

// 标记与局部重绘共用同一个画布编辑器：进入编辑态后必须先确认或取消，才能做别的操作。
function startEditor(mode: "inpaint" | "mark") {
  if (generating.value || deleting.value || uploading.value || gridSplit.value?.splitting || mirror.value?.mirroring || panorama.value?.busy) return;
  lightingVisible.value = false;
  multiAngleVisible.value = false;
  multiviewAssetVisible.value = false;
  outpaintVisible.value = false;
  editor.value?.start(mode);
}

// 局部重绘：编辑器把涂抹区域导出成标注图与 mask，交给新节点按提示词重绘，出图后再本地合成。
async function createInpaint(input: InpaintDraftInput, signal: AbortSignal) {
  if (!editor.value) throw new Error("请先进入局部重绘");
  await editor.value.createInpaint(input, signal, await resolveEditModel());
}

// 打光、多角度、制作资产、扩图互斥：四者都把底栏换成自己的面板，同时开只会互相盖住。
function openLighting() {
  if (panelDisabled.value || !previewUrl.value) return;
  editor.value?.cancel();
  multiAngleVisible.value = false;
  multiviewAssetVisible.value = false;
  outpaintVisible.value = false;
  lightingVisible.value = true;
}

function openMultiAngle() {
  if (panelDisabled.value || !previewUrl.value) return;
  editor.value?.cancel();
  lightingVisible.value = false;
  multiviewAssetVisible.value = false;
  outpaintVisible.value = false;
  multiAngleVisible.value = true;
}

// 制作资产：把单张立绘转成一张多角度角色板。与「多角度」是两件事——
// 多角度出的是绕相机拍到的单张新视角图，制作资产出的是版式固定的资产板
// （左段三格躯干 + 右段按版式 1/2/3 格头部；画幅随版式：单头 16:9，双头与三头 4:3）。
function openMultiviewAsset() {
  if (panelDisabled.value || !previewUrl.value) return;
  editor.value?.cancel();
  lightingVisible.value = false;
  multiAngleVisible.value = false;
  outpaintVisible.value = false;
  multiviewAssetVisible.value = true;
}

function openOutpaint() {
  if (panelDisabled.value || !previewUrl.value) return;
  editor.value?.cancel();
  lightingVisible.value = false;
  multiAngleVisible.value = false;
  multiviewAssetVisible.value = false;
  outpaintVisible.value = true;
}

// 全景图自带全屏预览弹窗，打开时其余面板与生成都要让路。
function openPanorama() {
  editor.value?.cancel();
  lightingVisible.value = false;
  multiAngleVisible.value = false;
  multiviewAssetVisible.value = false;
  outpaintVisible.value = false;
}

// 放大也是一键玩法：在旁边建一个挂了放大模型的新节点并自己发起生成，倍数由下拉选择。
// 放大模型不吃提示词与 LoRA，尺寸/比例也由它按原图推导，所以只下发倍数。
// 模型优先用节点当前选中的放大模型，否则取第一个声明了 upscale 的（SeedVR2 等）。
async function resolveUpscaleModel() {
  const target = upscaleModelChoice.value;
  if (!target) {
    showNodeError(new Error("请先在设置里安装放大模型（如 SeedVR2）"), "放大失败");
    return undefined;
  }
  return JSON.stringify([target.providerId, target.modelId]);
}

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || deleting.value || uploading.value || editor.value?.busy) return;
  if (!file.type.startsWith("image/")) return void showNodeError(new Error("请选择图片文件"), "图片替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError(new Error("图片不能为空且不能超过 100 MB"), "图片替换失败");
  uploading.value = true;
  try {
    const url = await files.uploadFile(file);
    // ACT: 复制节点可能仍引用旧图片，替换输出不删除共享文件。
    outputs.value.image = { dataType: "IMAGE", value: { url, mimeType: file.type } };
  } catch (error) {
    showNodeError(error, "图片替换失败");
  } finally {
    uploading.value = false;
  }
}

async function startGeneration() {
  const choice = selectedModel.value;
  if (generating.value) throw new Error("图片正在生成，请等待完成");
  if (deleting.value) throw new Error("节点正在删除");
  if (uploading.value) throw new Error("图片正在替换，请等待完成");
  // 编辑器处于标记态时画布被标注层接管，此时生成会读到未确认的标注。
  if (editor.value?.mode) throw new Error("请先完成图片标记");
  // 全景图预览是全屏弹窗，开着的时候生成结果看不到，也容易并发抢显存。
  if (panorama.value?.visible) throw new Error("请先关闭全景图，再启动图片生成");
  // 扩图与漫 / 真互转都会在旁边建新节点并自己发起生成，重复点击只会抢显存。
  if (outpaint.value?.generating || toonSwap.value?.busy || !!upscale.value?.busy) throw new Error("玩法正在生成，请等待完成");
  if (!generationPrompt.value) throw new Error("请输入生成提示词");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  if (!choice) throw new Error("请先选择图片生成模型");
  // 所选模型声明了参考图能力时，必须接入至少一张图，避免退化成文生图。
  if (imageCapable.value && !refList.value.some(item => item.dataType === "IMAGE" && item.value)) throw new Error("请先接入参考图片");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  generationController = controller;
  // ACT: 工具立即返回，任务由节点持有，停止或卸载时取消。
  generationState
    .run(() => workspace.list()
      .then(({ directory }) => {
        controller.signal.throwIfAborted();
        const megapixels = Number(data.value.megapixels);
        // 尺寸：能吃参考图的供应商按「等效面积边长」接收，其余仍按分辨率 + 比例推导的长边像素。
        const size = imageCapable.value ? areaSideFromMegapixels(megapixels) : longEdgeFromMegapixels(megapixels, data.value.ratio);
        // 局部重绘节点：父节点原图已经作为 original / guide 送进去了，
        // 这里再把连线带过来的同一张图加进去只会重复一遍。
        const inpaintData = (node.data as Record<string, unknown>).inpaint as ImageInpaint | undefined;
        // 「制作资产」等玩法预置的引导参考图：已落盘在节点目录，路径存在 data 上。
        // 它们排在连线参考图之后，所以 <imageN> / {{ref N}} 的编号对连线图仍成立。
        const extraImages = ((node.data as Record<string, unknown>).extraImages as { path: string; mimeType: string }[] | undefined) ?? [];
        const references = refList.value.filter(item => !inpaintData || item.dataType !== "IMAGE" || item.value?.url !== inpaintData.source);
        const input = {
          providerId: choice.providerId,
          modelId: choice.modelId,
          prompt: generationPrompt.value,
          // 平台给图片生成的请求体是严格白名单（只有 providerId/modelId/prompt/images/ratio/size），
          // 因此「重写提示词」关闭时以 size 前缀 + 告知供应商跳过重写分支；
          // 前缀不改变数值语义（Number("+1000") === 1000），不认这个约定的供应商行为不变。
          size: `${data.value.rewritePrompt ? "" : "+"}${size}`,
          // 不传 ratio 表示比例跟随参考图（主 latent 取参考图编码），传了才按所选比例与百万像素重绘。
          ...(usesRatio.value ? { ratio: data.value.ratio } : {}),
          outputDirectory: `assets/${id}`,
          images: [
            ...references.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
            ...extraImages,
          ],
          // LoRA 堆叠：按面板里的顺序依次应用，最多 12 条。空数组不下发，供应商会全部槽位跳过。
          ...(data.value.loras?.length ? { loras: data.value.loras } : {}),
          // 放大类模型：尺寸与比例由它自己按原图推导，只下发放大倍数。
          ...(upscaleModel.value ? { multiplier: Number(data.value.multiplier) || 2, size: undefined, ratio: undefined } : {}),
          directory,
        };
        // 局部重绘：原图、标注图、蒙版已占掉提交图片的前 3 个位置，连线带过来的图顺延其后。
        // 不把「参考 N 对应第几张图」写进提示词，模型就不知道引用对应哪张素材——这是与内置节点的关键差异。
        if (inpaintData) {
          let imageIndex = 3 + (inpaintData.images?.length ?? 0);
          const mapping = refList.value.flatMap((item, index) =>
            item.dataType === "IMAGE" && item.value
              ? [`参考 ${index + 1} / {{ref ${index + 1}}} 对应第 ${item.value.url === inpaintData.source ? 1 : imageIndex++} 张图`]
              : []
          );
          if (mapping.length) input.prompt += `\n当前节点参考编号对应关系：${mapping.join("；")}。`;
        }
        // 玩法预置的引导图排在连线参考图之后（见上面的 images 拼接顺序），编号自然顺延。
        // 不点明这层对应关系，模型会把两张风格差别极大的图混成一张看。
        // 「制作资产」的提示词用 <image1> / <image2> 指代两张图，这里的映射必须用同一套记号，
        // 否则提示词里的 <image2> 落不到实处（模型不知道它对应第几张）。
        if (extraImages.length) {
          const offset = refList.value.filter(item => item.dataType === "IMAGE" && item.value).length;
          const mapping = refList.value.flatMap((item, index) =>
            item.dataType === "IMAGE" && item.value ? [`<image${index + 1}> 对应第 ${index + 1} 张图`] : []
          );
          extraImages.forEach((_image, index) => {
            mapping.push(`<image${offset + index + 1}> 对应第 ${offset + index + 1} 张图`);
          });
          if (mapping.length) input.prompt += `\nImage reference mapping: ${mapping.join("; ")}.`;
        }
        // ACT: 工作流类供应商也没有原生 mask 通道，与内置节点一样走「标注图引导 + 本地蒙版合成」。
        return inpaintData ? generateInpaint(input, inpaintData, controller.signal) : ai.generateImage(input, controller.signal);
      })
      .then(([result]) => {
        controller.signal.throwIfAborted();
        if (!result) throw new Error("供应商未返回图片");
        outputs.value.image = { dataType: "IMAGE", value: { url: result.path, mimeType: result.mimeType } };
      }))
    .catch((error) => showNodeError(error, "图片生成失败"))
    .finally(() => {
      generationController = undefined;
    });
  return { status: "generating" };
}

nodeEvent.on("save", (reason) => {
  if (uploading.value || gridSplit.value?.splitting || mirror.value?.mirroring || panorama.value?.busy) throw new Error("图片处理中，请完成后再切换或刷新节点");
  if (lighting.value?.generating || multiAngle.value?.generating || multiviewAsset.value?.generating || outpaint.value?.generating || toonSwap.value?.busy || !!upscale.value?.busy) throw new Error("玩法正在生成，请完成后再切换或刷新节点");
  if (reason === "reload" && generating.value) throw new Error("图片生成中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  deleting.value = true;
  generationController?.abort();
  try {
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  imageWidth.value = (240 * image.naturalWidth) / image.naturalHeight;
  await nextTick();
  updateNodeInternals();
}

function getConfig() {
  return {
    label: node.data.label ?? "",
    prompt: data.value.prompt,
    model: data.value.model,
    megapixels: data.value.megapixels,
    ratio: data.value.ratio,
    rewritePrompt: data.value.rewritePrompt,
    imageCapable: imageCapable.value,
    // 放大类模型没有提示词与尺寸通道，只吃 multiplier；其余模型没有这一项。
    ...(upscaleModel.value ? { multiplier: data.value.multiplier, multiplierOptions: multiplierOptions.value } : {}),
    megapixelOptions: megapixelOptions.value,
    ratioOptions: ratioOptions.value,
    models: models.value,
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取此图片生成节点的当前提示词、模型、分辨率（megapixels，百万像素档位）、比例（ratio，可选「自适应」表示跟随参考图）、提示词重写开关及可用模型与档位，不含密钥；imageCapable 为 true 表示该模型能接参考图；放大类模型改为只提供 multiplier 与 multiplierOptions；改提示词用 setPrompt，改配置用 setConfig",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return getConfig();
  },
});

nodeTools.register({
  name: "setPrompt",
  description: "修改此节点的生成提示词，支持 {{ref 1}} 等参考标记（编号与引用列表、输入框 @ 提及一致）；不修改模型、分辨率、比例，不启动生成",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt: value }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    if (upscaleModel.value) throw new Error("放大模型没有提示词通道，请先换成支持提示词的模型");
    // 标记态下画布被标注层接管，此时改提示词会让人以为改的是待确认的那次重绘。
    if (editor.value?.mode) throw new Error("请先完成图片标记，再修改提示词");
    data.value.prompt = value;
    data.value.promptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
    return { prompt: value };
  },
});

nodeTools.register({
  name: "setConfig",
  description: "修改此节点的图片生成配置：模型、分辨率档位、比例与提示词重写开关；先用 getConfig 读取当前值与可选范围，providerId 与 modelId 必须成对提供；megapixels 用百万像素档位（按 1024 基数换算，如 1 = 1024×1024），ratio 可选「自适应」表示跟随参考图；rewritePrompt 控制生成前是否由工作流重写提示词，写好的成品提示词应设为 false；切换模型后不兼容的档位会落到该模型的首项；配置修改不触发生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    megapixels: z.string().optional(),
    ratio: z.string().optional(),
    rewritePrompt: z.boolean().optional(),
    multiplier: z.string().optional(),
  }).refine(args => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  execute(args) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改配置");
    if (generating.value) throw new Error("图片正在生成，请等待完成后再修改配置");
    if (args.providerId !== undefined || args.modelId !== undefined) {
      const choice = models.value.find(item => item.providerId === args.providerId && item.modelId === args.modelId);
      if (!choice) throw new Error("请选择 getConfig 返回的有效图片模型");
      data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    }
    // 档位按**换模型后**的可选范围校验：先落模型再校参数，否则会拿旧模型的档位去卡新模型。
    if (args.megapixels !== undefined) {
      if (!megapixelOptions.value.includes(args.megapixels)) throw new Error(`请选择 getConfig 返回的分辨率档位（${megapixelOptions.value.join(" / ")}）`);
      data.value.megapixels = args.megapixels;
    }
    if (args.ratio !== undefined) {
      if (!ratioOptions.value.includes(args.ratio)) throw new Error(`请选择 getConfig 返回的比例（${ratioOptions.value.join(" / ")}）`);
      data.value.ratio = args.ratio;
    }
    if (args.rewritePrompt !== undefined) data.value.rewritePrompt = args.rewritePrompt;
    // 放大倍数只有放大类模型有；flac 那种「无此项」的格式同理用 options 判空。
    if (args.multiplier !== undefined) {
      if (!multiplierOptions.value.includes(args.multiplier)) throw new Error(`请选择 getConfig 返回的放大倍数（${multiplierOptions.value.join(" / ")}）`);
      data.value.multiplier = args.multiplier;
    }
    return getConfig();
  },
});

nodeTools.register({
  name: "generateImage",
  description: "启动此节点的后台图片生成，使用当前提示词、模型、分辨率、比例与参考素材；立即返回已开始，用 getGenerationStatus 查询完成结果，cancelGeneration 停止生成",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.imageContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  // 编辑器自带图片容器，这里只对纯预览态生效；隐藏的文件输入框只由「替换图片」按钮触发。
  img { display: block; max-width: 100%; height: auto; }

  // 局部重绘子节点出图前的占位内容：原图叠红色标记，角标说明红色代表什么。
  .inpaintGuide {
    position: relative;
    width: 100%;
    img { display: block; width: 100%; }
    span { position: absolute; bottom: 8px; left: 8px; padding: 4px 8px; border-radius: 4px; background: #0009; color: #fff; font-size: 12px; }
  }

  .fileInput { display: none; }

  .imageEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }
}

.promptCard {
  .inpaintInfo { margin-bottom: 8px; }
  // 引用行：连线引用与引导参考图并排，共用一条横向滚动带（referenceItem 自带 overflow-x）。
  .referenceRow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    margin-bottom: 8px;
    overflow-x: auto;
  }
  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      &:deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    // 放大类模型的唯一参数：标签 + 倍数下拉。参数按钮与 LoRA 都不显示时，
    // 由它接管 sendButton 的 margin-left:auto 把发送键推到最右。
    .multiplierControl {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
      flex-shrink: 0;

      .multiplierLabel { font-size: 13px; color: var(--el-text-color-regular); white-space: nowrap; }
      .multiplierSelect { width: 84px; }
    }

    .sendButton {
      width: 32px;
      height: 32px;
      margin-left: auto;
      padding: 0;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }
}
</style>
