<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    :bottomVisible="node.selected && panelVisible"
    :bottomWidth="660"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    toolbar-two-row
    :style="{ width: previewUrl && imageWidth ? `${imageWidth + 18}px` : undefined }">
    <template v-if="editor?.mode" #top><div ref="paintToolbar" /></template>
    <template #topActions>
      <el-button :icon="IconPanoramaHorizontal" :disabled="playbookDisabled || !previewUrl" text title="全景图" aria-label="全景图" @click.stop="panorama?.open($event)">全景图<icon-chevron-down :size="14" /></el-button>
      <el-button :icon="IconBrush" :disabled="playbookDisabled || !previewUrl" text title="局部重绘" aria-label="局部重绘" @click.stop="startEditor('inpaint')">局部重绘</el-button>
      <el-button :icon="IconSun" :disabled="playbookDisabled || !previewUrl" text title="打光" aria-label="打光" @click.stop="openLighting">打光</el-button>
      <el-button :icon="IconCameraRotate" :disabled="playbookDisabled || !previewUrl" text title="多角度" aria-label="多角度" @click.stop="openMultiAngle">多角度</el-button>
      <el-button :icon="IconLayoutBoardSplit" :disabled="playbookDisabled || !previewUrl" text title="制作资产：把单张立绘转成多角度角色板（六格一张）" aria-label="制作资产" @click.stop="openMultiviewAsset">制作资产</el-button>
      <el-button :icon="IconArrowsMaximize" :disabled="playbookDisabled || !previewUrl" text title="扩图" aria-label="扩图" @click.stop="openOutpaint">扩图</el-button>
      <el-button :icon="IconUserScan" :loading="toonSwap?.busy" :disabled="playbookDisabled || !previewUrl" text title="漫 / 真互转：动漫转真人、真人转动漫" aria-label="漫/真互转" @click.stop="toonSwap?.open($event)">漫/真互转</el-button>
      <el-button :icon="IconZoomIn" :loading="upscale?.busy" :disabled="playbookDisabled || !previewUrl" text title="放大：1.5× / 2× / 3× / 4×" aria-label="放大" @click.stop="upscale?.open($event)">放大</el-button>
    </template>
    <!-- 第二行：承载型（宫格切分 / 镜像）与管理类（替换图片 / 历史记录）——它们只搬动像素或管理产物，不生成新画面。 -->
    <template #topSecondaryActions>
      <el-button :icon="IconLayoutGrid" :loading="gridSplit?.splitting" :disabled="uploading || editor?.busy || !previewUrl" text title="宫格切分" aria-label="宫格切分" @click.stop="gridSplit?.open($event)">宫格切分</el-button>
      <el-button :icon="IconFlipHorizontal" :loading="mirror?.mirroring" :disabled="playbookDisabled || !previewUrl" text title="镜像 / 旋转：左右翻转、上下翻转、顺时针 90°、逆时针 90°、180°" aria-label="镜像" @click.stop="mirror?.open($event)">镜像</el-button>
      <el-button :icon="IconAdjustmentsHorizontal" :loading="adjust?.busy" :disabled="adjustDisabled || !previewUrl" text title="调整：亮度、曝光、对比度、阴影、晕影、饱和度、暖色、淡色、清晰度" aria-label="调整" @click.stop="adjust?.open($event)">调整</el-button>
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="editor?.busy" text title="替换图片" aria-label="替换图片" @click.stop="fileInput?.click()">替换图片</el-button>
      <mediaHistory mediaType="image" :current="outputFile" :disabled="playbookDisabled" @select="outputs.image = { dataType: 'IMAGE', value: $event }" />
    </template>
    <template #topRightActions>
      <el-button :icon="IconPencil" :disabled="playbookDisabled || !previewUrl" text title="标记" aria-label="标记" @click.stop="startEditor('mark')" />
    </template>
    <div class="imageContent nopan">
      <imageEditor
        v-if="previewUrl"
        ref="editor"
        :src="previewUrl"
        :toolbarTarget="paintToolbar"
        :nodeType="VARIATION_NODE.comfyui"
        :carrierNodeType="VARIATION_NODE.picture"
        :disabled="uploading || !!toonSwap?.busy || upscale?.busy"
        alt="节点图片"
        @load="resizeImage"
        @error="ElMessage.error('无法预览该图片')" />
      <input ref="fileInput" class="fileInput" type="file" accept="image/*" aria-label="选择图片" :disabled="playbookDisabled" @change="uploadImage" />
      <el-button
        v-if="!outputFile"
        class="uploadButton"
        text
        :loading="uploading"
        title="上传图片"
        aria-label="上传图片"
        @dblclick.stop
        @click="fileInput?.click()">
        <icon-upload v-if="!uploading" :size="48" stroke="1.5" />
      </el-button>
    </div>
    <template v-if="panelVisible" #bottom>
      <div v-if="lightingVisible" ref="lightingTarget" />
      <div v-else-if="multiAngleVisible" ref="multiAngleTarget" />
      <div v-else-if="multiviewAssetVisible" ref="multiviewAssetTarget" />
      <div v-else-if="outpaintVisible" ref="outpaintTarget" />
      <div v-else ref="inpaintTarget" />
    </template>
  </nodeSkeleton>
  <imageInpaintPrompt v-if="editor?.mode === 'inpaint'" ref="inpaintPrompt" :target="inpaintTarget" :createDraft="createInpaint" :disabled="playbookDisabled" />
  <imageLighting v-if="lightingVisible" ref="lighting" :src="previewUrl" :source="outputFile" :target="lightingTarget" :nodeType="VARIATION_NODE.comfyui" :disabled="playbookDisabled" @close="lightingVisible = false" />
  <imageMultiAngle v-if="multiAngleVisible" ref="multiAngle" :src="previewUrl" :source="outputFile" :target="multiAngleTarget" :nodeType="VARIATION_NODE.comfyui" :disabled="playbookDisabled" @close="multiAngleVisible = false" />
  <imageMultiviewAsset v-if="multiviewAssetVisible" ref="multiviewAsset" :src="previewUrl" :source="outputFile" :target="multiviewAssetTarget" :nodeType="VARIATION_NODE.comfyui" :disabled="playbookDisabled" @close="multiviewAssetVisible = false" />
  <imageOutpaint v-if="outpaintVisible" ref="outpaint" :src="previewUrl" :source="outputFile" :target="outpaintTarget" :nodeType="VARIATION_NODE.comfyui" :disabled="playbookDisabled" @close="outpaintVisible = false" />
  <imagePanorama ref="panorama" :src="previewUrl" :source="outputFile" :nodeType="VARIATION_NODE.comfyui" :disabled="playbookDisabled" @open="closePanels" />
  <imageToonSwap
    ref="toonSwap"
    :src="previewUrl"
    :source="outputFile"
    :nodeType="VARIATION_NODE.comfyui"
    :disabled="carrierDisabled"
    :resolve-model="resolvePlaybookModel" />
  <imageUpscale
    ref="upscale"
    :src="previewUrl"
    :source="outputFile"
    :nodeType="VARIATION_NODE.comfyui"
    :disabled="upscaleDisabled"
    :size="DEFAULT_MEGAPIXELS"
    :resolve-model="resolveUpscaleModel" />
  <imageAdjustPanel
    ref="adjust"
    :src="previewUrl"
    :disabled="adjustDisabled"
    :active="node.selected"
    :nodeType="VARIATION_NODE.picture" />
  <imageGridSplit ref="gridSplit" :src="previewUrl" :disabled="gridSplitDisabled" :active="node.selected" :nodeType="VARIATION_NODE.picture" />
  <imageMirror ref="mirror" :src="previewUrl" :disabled="mirrorDisabled" :active="node.selected" :nodeType="VARIATION_NODE.picture" />
  <el-image-viewer
    v-if="previewVisible && previewUrl"
    :urlList="[previewUrl]"
    teleported
    @close="previewVisible = false" />
  <!-- 一键玩法（漫 / 真互转）需要模型，但本节点不是生成节点、没有模型配置：
       第一次点击时让用户挑一次并记进 node.data.playbookModel，之后直接复用不再打扰。 -->
  <el-dialog v-model="modelDialog.visible" title="选择玩法模型" width="380px" align-center append-to-body :close-on-click-modal="false" @closed="cancelModelChoice">
    <p class="modelDialogHint">「漫 / 真互转」需要一个能接参考图的图片模型来出图，选择后会记住，下次直接使用。</p>
    <el-select v-model="modelDialog.value" class="modelDialogSelect" filterable placeholder="选择图片模型" aria-label="玩法模型" noDataText="请先在「设置 → 媒体模型」中安装图片供应商">
      <el-option-group v-for="provider in dialogModelGroups" :key="provider.id" :label="provider.label">
        <el-option
          v-for="item in provider.models"
          :key="item.modelId"
          :label="item.label"
          :value="JSON.stringify([item.providerId, item.modelId])" />
      </el-option-group>
    </el-select>
    <template #footer>
      <div class="modelDialogFooter">
        <el-button @click="cancelModelChoice">取消</el-button>
        <el-button type="primary" :disabled="!modelDialog.value" @click="confirmModelChoice">确定</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref } from "vue";
import { IconPhoto, IconUpload, IconTransfer, IconLayoutGrid, IconFlipHorizontal, IconAdjustmentsHorizontal, IconBrush, IconPencil, IconSun, IconCameraRotate, IconPanoramaHorizontal, IconChevronDown, IconArrowsMaximize, IconUserScan, IconZoomIn, IconLayoutBoardSplit } from "@tabler/icons-vue";
import { ElButton, ElDialog, ElImageViewer, ElMessage, ElOption, ElOptionGroup, ElSelect } from "element-plus";
import { nodeSkeleton, nodeTools, useNode, z, type NodeHandle, type NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { isImageCapableModel } from "@toonflow/node-shared/imageCapable";
import { modelIdOf, pickPlaybookModel, PLAYBOOK_MEGAPIXELS } from "@toonflow/node-shared/playbookDefaults";
import mediaHistory from "@toonflow/node-shared/mediaHistory";
import imageGridSplit from "@toonflow/node-shared/imageGridSplit";
import imageMirror from "@toonflow/node-shared/imageMirror";
import imageEditor from "@toonflow/node-shared/imageEditor";
import imageInpaintPrompt from "@toonflow/node-shared/imageInpaintPrompt";
import imageLighting from "@toonflow/node-shared/imageLighting";
import imagePanorama from "@toonflow/node-shared/imagePanorama";
import imageMultiAngle from "@toonflow/node-shared/imageMultiAngle";
import imageMultiviewAsset from "@toonflow/node-shared/imageMultiviewAsset";
import imageToonSwap from "@toonflow/node-shared/imageToonSwap";
import imageUpscale from "@toonflow/node-shared/imageUpscale";
import imageAdjustPanel from "@toonflow/node-shared/imageAdjustPanel";
import imageOutpaint from "@toonflow/node-shared/imageOutpaint";
import type { InpaintDraftInput } from "@toonflow/node-shared/imageInpaint";
import { buildAnimeToRealPrompt } from "@toonflow/node-shared/imageAnimeToReal";
import { useImageVariationNode, VARIATION_NODE, AUTO_RATIO, recommendedLora } from "@toonflow/node-shared/useImageVariationNode";

defineOptions({
  inheritAttrs: false,
  icon: IconPhoto,
  handles: [
    { id: "in", type: "target", dataType: "IMAGE", label: "来源图片" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ] satisfies NodeHandle[],
});
const { id, node, nodeProps, outputs, nodeEvent, files, ai, updateNodeInternals } = useNode({
  label: "ComfyUI 图片",
});
// ACT: 本节点不是生成节点，没有模型与尺寸配置；playbookModel 只为一键玩法（漫 / 真互转）记住一次模型选择。
const data = computed(() => node.data as { playbookModel?: string });
const fileInput = ref<HTMLInputElement>();
const gridSplit = ref<InstanceType<typeof imageGridSplit>>();
const mirror = ref<InstanceType<typeof imageMirror>>();
const editor = ref<InstanceType<typeof imageEditor>>();
const paintToolbar = ref<HTMLElement>();
const inpaintPrompt = ref<InstanceType<typeof imageInpaintPrompt>>();
const inpaintTarget = ref<HTMLElement>();
const lighting = ref<InstanceType<typeof imageLighting>>();
const lightingTarget = ref<HTMLElement>();
const lightingVisible = ref(false);
const multiAngle = ref<InstanceType<typeof imageMultiAngle>>();
const multiAngleTarget = ref<HTMLElement>();
const multiAngleVisible = ref(false);
const multiviewAsset = ref<InstanceType<typeof imageMultiviewAsset>>();
const multiviewAssetTarget = ref<HTMLElement>();
const multiviewAssetVisible = ref(false);
const outpaint = ref<InstanceType<typeof imageOutpaint>>();
const outpaintTarget = ref<HTMLElement>();
const outpaintVisible = ref(false);
const panorama = ref<InstanceType<typeof imagePanorama>>();
const toonSwap = ref<InstanceType<typeof imageToonSwap>>();
const upscale = ref<InstanceType<typeof imageUpscale>>();
const adjust = ref<InstanceType<typeof imageAdjustPanel>>();
const uploading = ref(false);
const previewVisible = ref(false);
const imageWidth = ref(0);
const createVariation = useImageVariationNode({ nodeType: VARIATION_NODE.comfyui });
// 玩法新建子节点的默认分辨率与其余玩法一致：2MP。
const DEFAULT_MEGAPIXELS = PLAYBOOK_MEGAPIXELS;


const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showError(error, "图片读取失败")
);
// 底栏只在玩法面板打开时出现（本节点没有提示词卡，空底栏会白占一块）。
const panelVisible = computed(() => lightingVisible.value || multiAngleVisible.value || multiviewAssetVisible.value || outpaintVisible.value || editor.value?.mode === "inpaint");
// 玩法面板打开期间底栏被接管，其余交互让路，避免读到半途的状态。
const playbookDisabled = computed(() => uploading.value || !!editor.value?.busy || !!gridSplit.value?.splitting || !!mirror.value?.mirroring || !!panorama.value?.busy || !!toonSwap.value?.busy || !!upscale.value?.busy || !!adjust.value?.busy);
// ACT: 承载型面板（宫格切分 / 镜像）在 disabled 变 true 时会中止「自己正在跑」的任务，
// 因此传给它们的 disabled 只能包含「别的任务在跑」，不能包含该组件自身的 busy，否则一点击就被自己中止（点了没反应）。
const carrierDisabled = computed(() => uploading.value || !!editor.value?.busy || !!panorama.value?.busy || !!toonSwap.value?.busy || !!upscale.value?.busy);
// ACT: 同宫格切分 / 镜像的教训——传给面板组件的 disabled 不能含该组件自身的 busy，否则会把自己中止。
const upscaleDisabled = computed(() => uploading.value || !!editor.value?.busy || !!gridSplit.value?.splitting || !!mirror.value?.mirroring || !!panorama.value?.busy || !!toonSwap.value?.busy);
// 同上：传给调整面板的 disabled 不含它自己的 busy，否则它会把自己中止。
const adjustDisabled = computed(() => uploading.value || !!editor.value?.busy || !!gridSplit.value?.splitting || !!mirror.value?.mirroring || !!panorama.value?.busy || !!toonSwap.value?.busy || !!upscale.value?.busy);
const gridSplitDisabled = computed(() => carrierDisabled.value || !!mirror.value?.mirroring);
const mirrorDisabled = computed(() => carrierDisabled.value || !!gridSplit.value?.splitting);

nodeEvent.on("save", () => {
  if (playbookDisabled.value) throw new Error("图片处理中，请完成后再切换或刷新节点");
});
nodeEvent.on("delete", () => {
  if (playbookDisabled.value) throw new Error("图片处理中，请稍后删除节点");
  uploading.value = true;
  return files.removeNodeFiles().finally(() => {
    uploading.value = false;
  });
});

nodeTools.register({
  name: "setImage",
  description: "选择工作区内已有的图片文件作为此节点的输出，path 使用工作区相对路径",
  parameters: z.strictObject({
    path: z.string().min(1).max(4096),
    mimeType: z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/),
  }),
  async execute({ path, mimeType }, { signal }) {
    signal?.throwIfAborted();
    if (playbookDisabled.value) throw new Error("图片处理中，请稍后重试");
    uploading.value = true;
    try {
      const content = await files.getWorkspaceFiles().read(path);
      signal?.throwIfAborted();
      if (!content.byteLength || content.byteLength > 100 * 1024 * 1024) throw new Error("图片不能为空且不能超过 100 MB");
      outputs.value.image = { dataType: "IMAGE", value: { url: path, mimeType } };
      return outputs.value.image;
    } finally {
      uploading.value = false;
    }
  },
});

async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  imageWidth.value = 240 * image.naturalWidth / image.naturalHeight;
  await nextTick();
  updateNodeInternals();
}

// 打光、多角度、制作资产、扩图互斥：四者都把底栏换成自己的面板，同时开只会互相盖住。
function closePanels(keep?: "lighting" | "multiAngle" | "multiviewAsset" | "outpaint") {
  editor.value?.cancel();
  lightingVisible.value = keep === "lighting";
  multiAngleVisible.value = keep === "multiAngle";
  multiviewAssetVisible.value = keep === "multiviewAsset";
  outpaintVisible.value = keep === "outpaint";
}

function openLighting() {
  if (playbookDisabled.value || !previewUrl.value) return;
  closePanels("lighting");
}

function openMultiAngle() {
  if (playbookDisabled.value || !previewUrl.value) return;
  closePanels("multiAngle");
}

function openMultiviewAsset() {
  if (playbookDisabled.value || !previewUrl.value) return;
  closePanels("multiviewAsset");
}

function openOutpaint() {
  if (playbookDisabled.value || !previewUrl.value) return;
  closePanels("outpaint");
}

function startEditor(mode: "inpaint" | "mark") {
  if (playbookDisabled.value) return;
  closePanels();
  editor.value?.start(mode);
}

// 放大也是一键玩法：在旁边建一个挂了放大模型的新节点并自己发起生成，倍数由下拉选择。
// 放大模型不是本节点选的，直接取第一个声明了 upscale 的（SeedVR2 等），与本仓库的生成节点一致。
async function resolveUpscaleModel() {
  const target = (await ai.getMediaModels()).find((item) => item.type === "image" && item.upscale === true);
  if (!target) {
    showNodeError(new Error("请先在设置里安装放大模型（如 SeedVR2）"), "放大失败");
    return undefined;
  }
  return JSON.stringify([target.providerId, target.modelId]);
}

const modelDialog = reactive<{ visible: boolean; value: string; resolve?: (value: string | undefined) => void }>({ visible: false, value: "" });
const dialogModels = ref<NodeMediaModel[]>([]);
const dialogModelGroups = computed(() => groupNodeModels(dialogModels.value));

/**
 * 取一键玩法要用的模型：默认自动选「Qwen Image 2.1 图像编辑」（玩法是照着参考图改，执行者就是它），
 * 找不到它时才依次退让：记忆值 → 第一个能吃参考图的 → 让用户挑一次。
 */
async function resolvePlaybookModel() {
  const items = (await ai.getMediaModels()).filter((item) => item.type === "image");
  if (!items.length) throw new Error("请先在「设置 → 媒体模型」中安装图片供应商");
  const auto = pickPlaybookModel(items);
  if (auto) return modelIdOf(auto);
  const saved = data.value.playbookModel;
  if (saved) return saved;
  const preferred = items.find((item) => isImageCapableModel(item)) ?? items[0]!;
  dialogModels.value = items;
  modelDialog.value = JSON.stringify([preferred.providerId, preferred.modelId]);
  const choice = await new Promise<string | undefined>((resolve) => {
    modelDialog.resolve = resolve;
    modelDialog.visible = true;
  });
  if (choice) data.value.playbookModel = choice;
  return choice;
}

function confirmModelChoice() {
  const resolve = modelDialog.resolve;
  modelDialog.resolve = undefined;
  modelDialog.visible = false;
  resolve?.(modelDialog.value);
}

function cancelModelChoice() {
  const resolve = modelDialog.resolve;
  modelDialog.resolve = undefined;
  modelDialog.visible = false;
  resolve?.(undefined);
}

async function createInpaint(input: InpaintDraftInput, signal: AbortSignal) {
  if (!editor.value) throw new Error("请先进入局部重绘");
  const model = await resolvePlaybookModel();
  if (!model) return;
  await editor.value.createInpaint(input, signal, model);
}

async function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || playbookDisabled.value) return;
  if (!file.type.startsWith("image/")) return void ElMessage.error("请选择图片文件");
  if (!file.size || file.size > 100 * 1024 * 1024) return void ElMessage.error("图片不能为空且不能超过 100 MB");
  uploading.value = true;
  try {
    const url = await files.uploadFile(file);
    // ACT: 复制节点可能仍引用旧图片，替换输出不删除共享文件。
    outputs.value.image = { dataType: "IMAGE", value: { url, mimeType: file.type } };
  } catch (error) {
    showError(error, "图片替换失败");
  } finally {
    uploading.value = false;
  }
}

function showError(error: unknown, fallback: string) {
  const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  ElMessage.error(message || (error instanceof Error ? error.message : fallback));
}
</script>

<style scoped lang="scss">
.imageContent {
  min-height: 144px;

  .fileInput {
    display: none;
  }

  .uploadButton {
    width: 100%;
    height: 144px;
    padding: 0;
    color: var(--el-text-color-placeholder);

    &:hover {
      color: var(--el-color-primary);
    }
  }
}

.modelDialogHint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.modelDialogSelect {
  width: 100%;
}
</style>
