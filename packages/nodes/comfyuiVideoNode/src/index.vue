<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="player?.enterFullscreen()"
    :bottomWidth="660"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth + 18}px` : undefined }">
    <template #topActions>
      <el-button :icon="IconMusic" text :disabled="!outputFile || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('extractAudio')">提取音轨</el-button>
      <el-button :icon="IconLayersSubtract" text :disabled="!outputFile || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('separate')">分离音视频</el-button>
      <el-button :icon="IconScissors" text :disabled="!outputFile || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('trim')">截取片段</el-button>
      <mediaHistory mediaType="video" :current="outputFile" :disabled="generating || deleting || uploading" @select="outputs.video = { dataType: 'VIDEO', value: $event }" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || deleting" text title="替换视频" aria-label="替换视频" @click.stop="fileInput?.click()">替换视频</el-button>
      <input ref="fileInput" type="file" accept="video/*" hidden aria-label="选择替换视频" :disabled="generating || deleting || uploading" @change="replaceOutput" />
    </template>
    <template #topRightActions>
      <el-dropdown trigger="click" placement="bottom-end" :disabled="!player?.ready || player?.capturing || generating || deleting || uploading" @command="player?.captureFrame($event)">
        <el-button :icon="IconPhotoScan" :loading="player?.capturing" :disabled="!player?.ready || player?.capturing || generating || deleting || uploading" text title="截取视频帧" aria-label="截取视频帧" />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="current" :icon="IconPhotoScan">截取当前帧</el-dropdown-item>
            <el-dropdown-item command="first" :icon="IconPlayerSkipBack">截取首帧</el-dropdown-item>
            <el-dropdown-item command="last" :icon="IconPlayerSkipForward">截取尾帧</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </template>
    <div v-loading="generating || uploading" class="videoContent nopan" :aria-busy="generating || uploading">
      <videoPlayer
        v-if="previewUrl"
        ref="player"
        :src="previewUrl"
        label="生成视频"
        @loadedmetadata="resizeVideo" />
      <div v-else class="videoEmpty" role="img" aria-label="暂无生成视频">
        <icon-camera-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem
          v-if="refList.length"
          v-model="refList"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <!-- 素材一个模式都匹配不上：下拉没有可选项也无从修改，改为列出模型支持的能力。 -->
        <div v-if="unmatchedModes" class="referenceHint">当前素材组合没有可用的生成模式，模型支持：{{ modeSummary }}</div>
        <!-- 模式下拉可见时选项本身就是图片的去向（首帧 / 尾帧），这行提示不再重复；只在没有下拉时补位。 -->
        <div v-else-if="frameMode && modeChoiceCount <= 1" class="referenceHint">{{ frameHint }}</div>
        <!-- 供应商声明了 text 模式：不接图片时按文生视频提交，画幅、百万像素、时长等照常生效。 -->
        <div v-else-if="textMode" class="referenceHint">未接入图片时按文生视频生成</div>
        <!-- 单图参考是当前素材的唯一去向时（下拉不展示），这里补上图片的位置；有多选时交给下拉。 -->
        <div v-else-if="selectedMode === 'singleImage' && modeChoiceCount <= 1" class="referenceHint">图片引用作为首帧</div>
        <!-- 混合参考模式：图片、视频、音频都是参考素材，没有首帧/尾帧语义，上限取模型声明的能力。 -->
        <div v-else-if="referenceCapacity" class="referenceHint">接入的素材均作为视频参考{{ referenceCapacity }}</div>
        <promptInput v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" expandable />
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || deleting"
            placeholder="选择模型"
            aria-label="生成模型"
            noDataText="请先在设置中添加视频模型"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showNodeError(error, '模型读取失败'))">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option
                v-for="item in provider.models"
                :key="item.modelId"
                :label="item.label"
                :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings
            v-model:duration="data.duration"
            v-model:resolution="data.resolution"
            v-model:ratio="data.ratio"
            v-model:mode="data.mode"
            v-model:generateAudio="data.generateAudio"
            v-model:megapixels="data.megapixels"
            v-model:rewritePrompt="data.rewritePrompt"
            v-model:turbo="data.turbo"
            :ratios="ratioOptions"
            :megapixelOptions="megapixelOptions"
            :durationOptions="durationOptions"
            :modeChoiceCount="modeChoiceCount"
            :modeOptions="modeOptions"
            :workflow="workflowCapable"
            :model="selectedModel"
            :disabled="generating || deleting || !selectedModel" />
          <loraStackPicker
            v-model="data.loras"
            :folders="LORA_FOLDERS_LIST"
            :disabled="generating || deleting || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="deleting || uploading || (!generating && (!generationPrompt || !selectedModel))"
            :title="generating ? '停止生成' : '生成视频'"
            :aria-label="generating ? '停止生成' : '生成视频'"
            @click="generating ? generationController?.abort() : startGeneration().catch((error) => showNodeError(error, '视频生成失败'))" />
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <videoActions ref="actions" :file="outputFile" :src="previewUrl" :disabled="generating || deleting || uploading" />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElLoading, ElDropdown, ElDropdownMenu, ElDropdownItem } from "element-plus";
import { IconCameraAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer, IconMusic, IconLayersSubtract, IconScissors, IconPhotoScan, IconPlayerSkipBack, IconPlayerSkipForward } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, z, type NodeMediaModel, type NodeVideoRequest, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import promptInput from "@toonflow/node-shared/promptInput";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import videoActions from "@toonflow/node-video/videoActions";
import referenceItem from "@toonflow/node-shared/referenceItem";
import mediaHistory from "@toonflow/node-shared/mediaHistory";
import generationSettings from "./components/generationSettings.vue";
import loraStackPicker from "@toonflow/node-shared/loraStackPicker";
import { LORA_FOLDERS } from "@toonflow/node-shared/useImageVariationNode";

const LORA_FOLDERS_LIST = [...LORA_FOLDERS.minimax];
import { modeLabel, outcomeLabel } from "./modeLabels";

defineOptions({
  inheritAttrs: false,
  icon: IconCameraAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "VIDEO", "AUDIO", "STRING"], label: "图片、视频、音频、文本输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({
  label: "ComfyUI 视频生成",
});
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; model: string; duration?: number; resolution: string; ratio: string; mode: string; generateAudio: boolean; megapixels: string; rewritePrompt: boolean; turbo: boolean; loras?: { name: string; strength: number }[] });
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.resolution ??= "";
data.value.mode ??= "";
data.value.generateAudio ??= true;
data.value.ratio ??= "16:9";
data.value.megapixels ??= "0.9";
// 默认与工作流自带的开关一致：重写提示词开（#192 走 TextGenerate）、Turbo 开（#202 同时驱动
// #198 的 turbo LoRA 与 #201 的少步 sigmas）。
data.value.rewritePrompt ??= true;
data.value.turbo ??= true;
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
let disposed = false;
const deleting = ref(false);
const player = ref<InstanceType<typeof videoPlayer>>();
const actions = ref<InstanceType<typeof videoActions>>();
const videoWidth = ref(0);
let generationController: AbortController | undefined;
const generationState = useNodeGeneration(outputs, () => generationController?.abort());
const { generating } = generationState;
let generation: Promise<void> | undefined;
let modelsRequest: Promise<void> | undefined;
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
// ACT: 供应商未声明视频比例范围，沿用界面的通用比例，具体支持范围由供应商校验。
const DEFAULT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
const DEFAULT_MEGAPIXELS = ["0.4", "0.9", "1.6", "2"];
// 工作流模型的时长在画布上是 PrimitiveFloat「Float (duration)」，节点按 1–15 秒的整数档位提供
// （画布取 6），供应商再据此换算帧数；云端模型走 durationResolutionMap 的固定档位。
const DURATION_MIN = 1;
const DURATION_MAX = 15;
const DEFAULT_DURATION = 6;
const DURATION_OPTIONS = Array.from({ length: DURATION_MAX - DURATION_MIN + 1 }, (_, index) => DURATION_MIN + index);
function clampWorkflowDuration(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DURATION;
  return Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(value)));
}
// 未声明「时长-分辨率」档位的模型（本地 ComfyUI 工作流）没有分辨率可选，节点把请求里的 resolution
// 复用为「输出规格」通道，并展示百万像素、重写提示词与 Turbo；云端供应商声明了档位，行为保持不变。
// 声明了 imageSizes 的模型一律按工作流处理，这样即便日后补上时长档位，输出规格通道也不会失效。
function optionsFor(choice?: NodeMediaModel) {
  const workflow = !!choice?.imageSizes?.length || !choice?.durationResolutionMap?.length;
  return {
    workflow,
    ratios: workflow && choice?.imageRatios?.length ? choice.imageRatios : DEFAULT_RATIOS,
    megapixels: choice?.imageSizes?.length ? choice.imageSizes : DEFAULT_MEGAPIXELS,
    durations: workflow ? DURATION_OPTIONS : [],
  };
}
const workflowCapable = computed(() => optionsFor(selectedModel.value).workflow);
const ratioOptions = computed(() => optionsFor(selectedModel.value).ratios);
const megapixelOptions = computed(() => optionsFor(selectedModel.value).megapixels);
const durationOptions = computed(() => optionsFor(selectedModel.value).durations);
const selectedMode = computed(() => selectedModel.value?.mode?.find((item) => JSON.stringify(item) === data.value.mode) as NodeVideoRequest["mode"]);
const frameMode = computed(() => ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(selectedMode.value)));
// 未接入任何图片且供应商声明了 text 模式时，按文生视频提交（工作流会走无关键帧分支）。
const textMode = computed(() => String(selectedMode.value) === "text");
// 混合参考模式（数组型 mode）：素材统一作为参考输入，没有首帧/尾帧语义。
// 上限直接来自模型声明的能力（如 imageReference:9），供应商换了上限这里会跟着变。
const REFERENCE_LABELS: Record<string, string> = { imageReference: "图片", videoReference: "视频", audioReference: "音频" };
function referenceCapacityOf(mode?: NodeVideoRequest["mode"]) {
  if (!Array.isArray(mode)) return "";
  const parts = mode.map((item) => {
    const [type = "", max = ""] = item.split(":");
    return max ? `${REFERENCE_LABELS[type] ?? type} ${max} 个` : null;
  }).filter(Boolean);
  return parts.length ? `（最多 ${parts.join("、")}）` : "";
}
const referenceCapacity = computed(() => referenceCapacityOf(selectedMode.value));
const mediaCounts = computed(() => ({
  image: refList.value.filter((item) => item.dataType === "IMAGE").length,
  video: refList.value.filter((item) => item.dataType === "VIDEO").length,
  audio: refList.value.filter((item) => item.dataType === "AUDIO").length,
}));
const matchingModes = computed(() => getMatchingModes(selectedModel.value));
// 一个模式对当前素材的「结果」= 最终落到哪几个槽位。不同模式可能结果完全相同（两张图时
// 「首尾帧必填」与「首帧可选」都得到 首帧+尾帧），这种模式选了也没差别，不构成选择。
function modeOutcome(mode: string | string[], image: number) {
  if (Array.isArray(mode)) return "reference";
  // 「尾帧可选」只有一张图时退化成单图作首帧，两张图时就是首尾帧。
  if (mode === "endFrameOptional") return image > 1 ? "first+last" : "first";
  // 「首帧可选」只有一张图时该图作尾帧（L2VA），两张图时按顺序作首尾帧。
  if (mode === "startFrameOptional") return image > 1 ? "first+last" : "last";
  if (mode === "singleImage") return "first";
  if (mode === "startEndRequired") return "first+last";
  return String(mode);
}
// ACT: 下拉只在「当前素材真的能对应到不同结果」时出现（0 或 1 种结果都隐藏）。
const modeChoiceCount = computed(() => new Set(matchingModes.value.map((mode) => modeOutcome(mode, mediaCounts.value.image))).size);
// 下拉选项按当前素材下的**结果**命名（首帧 / 尾帧 / 首尾帧 / 参考素材），而不是模式声明名。
// 结果相同的模式对用户没有差别，只留一个；被合并掉的若是当前选中项则保留它，否则下拉会因为
// 找不到当前值而显示空白。
const modeOptions = computed(() => {
  const image = mediaCounts.value.image;
  const kept = new Map<string, { value: string; label: string }>();
  for (const item of matchingModes.value) {
    const value = JSON.stringify(item);
    const outcome = modeOutcome(item, image);
    const existing = kept.get(outcome);
    if (!existing) kept.set(outcome, { value, label: outcomeLabel(outcome) });
    else if (value === data.value.mode) kept.set(outcome, { ...existing, value });
  }
  return [...kept.values()];
});
// 素材组合一个模式都匹配不上（多为类型或数量超出模型声明）时，模式下拉没有可选项也无从修改，
// 改为在提示词下方列出模型支持的能力——这里成了唯一的说明入口。
const unmatchedModes = computed(() => (selectedModel.value?.mode?.length ?? 0) > 0 && !matchingModes.value.length);
const modeSummary = computed(() => {
  const list = selectedModel.value?.mode ?? [];
  return `${list.map(modeLabel).join("、")}${referenceCapacityOf(list.find(Array.isArray))}`;
});
// 首尾帧模式下图片的去向：单图时由所选模式决定作首帧还是尾帧（「首帧可选」= 该图作尾帧），
// 两张图则按引用顺序分配。与供应商里 first_frame / last_frame 的落位保持一致。
const frameHint = computed(() => mediaCounts.value.image === 1
  ? (selectedMode.value === "startFrameOptional" ? "图片引用作为尾帧" : "图片引用作为首帧")
  : "图片引用按顺序作为首帧、尾帧");

function getMatchingModes(choice?: NodeMediaModel) {
  return (choice?.mode ?? []).filter((mode) => {
    const { image, video, audio } = mediaCounts.value;
    if (Array.isArray(mode)) return image + video + audio > 0 && Object.entries(mediaCounts.value).every(([type, count]) =>
      count <= Number(mode.find((item) => item.startsWith(`${type}Reference:`))?.split(":")[1] ?? 0)
    );
    if (mode === "text") return image + video + audio === 0;
    if (video || audio) return false;
    if (mode === "singleImage") return image === 1;
    if (mode === "startEndRequired") return image === 2;
    return ["endFrameOptional", "startFrameOptional"].includes(mode) && image >= 1 && image <= 2;
  });
}

function getDurations(choice: NodeMediaModel) {
  return [...new Set((choice.durationResolutionMap ?? []).flatMap((item) => item.duration))].sort((a, b) => a - b);
}

function getResolutions(choice: NodeMediaModel, duration?: number) {
  // ACT: 当前视频分辨率使用 p 单位；出现其他单位时再统一换算。
  return [...new Set((choice.durationResolutionMap ?? []).filter((item) => item.duration.includes(duration!)).flatMap((item) => item.resolution))]
    .sort((left, right) => (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity));
}
// 工作流模型：平台给视频请求的字段是严格白名单（没有图片请求那样的 size 通道），因此把
// 「百万像素 / 是否重写提示词 / 是否开启 Turbo」编进 resolution 的片段，由供应商解析。
// 声明了分辨率档位的云端模型继续传真实分辨率。
function outputSpec() {
  if (!workflowCapable.value) return data.value.resolution || undefined;
  return [
    `mp=${Number(data.value.megapixels) || 1}`,
    `rw=${data.value.rewritePrompt ? 1 : 0}`,
    `tb=${data.value.turbo ? 1 : 0}`,
  ].join("|");
}
// ACT: 引用改变时只替换不适用的模式；普通媒体优先作为参考，避免自动变成首尾帧。
watch([selectedModel, matchingModes, () => data.value.mode], ([choice, matches]) => {
  if (!choice || matches.some((item) => JSON.stringify(item) === data.value.mode)) return;
  const modes = choice.mode ?? [];
  const mode = matches.find(Array.isArray) ?? matches.find((item) => item === "singleImage")
    ?? matches.find((item) => item === "endFrameOptional") ?? matches[0]
    ?? modes.find((item) => JSON.stringify(item) === data.value.mode) ?? modes.find(Array.isArray) ?? modes[0];
  data.value.mode = mode === undefined ? "" : JSON.stringify(mode);
}, { flush: "sync" });
// 档位列表变化时（如供应商换了档位）把旧值吸附到最接近的档位，避免单选组空选。
function nearestOption(options: string[], value: string) {
  if (!options.length || options.includes(value)) return value;
  const target = Number(value);
  if (!Number.isFinite(target)) return options[0]!;
  return options.reduce((best, item) => (Math.abs(Number(item) - target) < Math.abs(Number(best) - target) ? item : best), options[0]!);
}
// ACT: 参数在节点内归一化，未选中、未挂载底部设置时也可由 Agent 直接生成。
watch([selectedModel, () => data.value.duration], ([choice]) => {
  if (!choice) return;
  const durations = getDurations(choice);
  // 工作流模型没有「时长-分辨率」档位：时长是 1–15 秒的连续浮点，只夹取范围；云端模型吸附到档位。
  data.value.duration = durations.length
    ? (durations.includes(data.value.duration!) ? data.value.duration : durations[0])
    : clampWorkflowDuration(data.value.duration);
  const resolutions = getResolutions(choice, data.value.duration);
  if (!resolutions.includes(data.value.resolution)) data.value.resolution = resolutions[0] ?? "";
  if (!ratioOptions.value.includes(data.value.ratio)) data.value.ratio = ratioOptions.value[0] ?? "16:9";
  data.value.megapixels = nearestOption(megapixelOptions.value, data.value.megapixels);
  if (choice.audio !== "optional") data.value.generateAudio = choice.audio === true;
}, { flush: "sync" });
const modelGroups = computed(() => groupNodeModels(models.value));
const generationPrompt = computed(() =>
  [
    data.value.prompt.trim(),
    ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n")
);
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showNodeError(error, "视频读取失败")
);

onMounted(() => loadModels().catch((error) => showNodeError(error, "模型读取失败")));
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
});

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || deleting.value || uploading.value || disposed) return;
  if (!file.type.startsWith("video/")) return void showNodeError("请选择视频文件", "视频替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("视频不能为空且不能超过 100 MB", "视频替换失败");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: 保留历史输出文件，避免破坏撤销记录和复制节点的引用。
    outputs.value.video = { dataType: "VIDEO", value: { url, mimeType: file.type } };
  } catch (error) {
    showNodeError(error, "视频替换失败");
  } finally {
    uploading.value = false;
  }
}

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then((items) => {
    if (generating.value || deleting.value) return;
    models.value = items.filter((item) => item.type === "video");
    // ACT: 只给空配置选默认工作流，保留暂时不可用的旧选择及其参数。优先内置的 ComfyUI 供应商。
    if (!data.value.model) {
      const first = models.value.find((item) => item.providerId === "comfyuiVideo") ?? models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function startGeneration() {
  const choice = selectedModel.value;
  if (generating.value) throw new Error("视频正在生成，请等待完成");
  if (uploading.value) throw new Error("视频正在替换，请等待完成");
  if (deleting.value) throw new Error("节点正在删除");
  if (!choice) throw new Error("请先选择视频模型");
  if (!generationPrompt.value) throw new Error("请输入生成提示词");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  const images = refList.value.flatMap((item) => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  if (choice.mode?.length && !matchingModes.value.length) throw new Error("当前模型没有适合这些参考素材的生成模式，请更换模型或调整引用");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  const input: Omit<NodeVideoRequest, "directory"> = {
    providerId: choice.providerId,
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    mode: selectedMode.value,
    duration: data.value.duration,
    resolution: outputSpec(),
    ratio: data.value.ratio,
    generateAudio: choice.audio === "optional" ? data.value.generateAudio : choice.audio,
    // LoRA 堆叠：按面板顺序依次应用，最多 12 条。空数组不下发，供应商全部槽位跳过。
    ...(data.value.loras?.length ? { loras: data.value.loras } : {}),
    outputDirectory: `assets/${id}`,
    images: frameMode.value ? undefined : images,
    firstFrame: frameMode.value && (selectedMode.value !== "startFrameOptional" || images.length > 1) ? images[0] : undefined,
    lastFrame: frameMode.value ? images[selectedMode.value === "startFrameOptional" && images.length === 1 ? 0 : 1] : undefined,
    videos: refList.value.flatMap((item) => item.dataType === "VIDEO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
    audios: refList.value.flatMap((item) => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
  };
  generationController = controller;
  // ACT: 工具立即返回，任务由节点持有，停止或卸载时取消。
  generation = generationState.run(() => workspace
    .list()
    .then(({ directory }) => {
      controller.signal.throwIfAborted();
      return ai.generateVideo({ ...input, directory }, controller.signal);
    })
    .then(([result]) => {
      controller.signal.throwIfAborted();
      if (!result) throw new Error("供应商未返回视频");
      outputs.value.video = { dataType: "VIDEO", value: { url: result.path, mimeType: result.mimeType } };
    }))
    .catch((error) => showNodeError(error, "视频生成失败"))
    .finally(() => {
      generationController = undefined;
    });
  return { status: "generating" };
}

nodeEvent.on("save", (reason) => {
  if (reason === "reload" && (generating.value || uploading.value || deleting.value)) throw new Error("视频处理中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error("视频正在替换，请稍后删除节点");
  deleting.value = true;
  generationController?.abort();
  try {
    await generation;
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeVideo(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  videoWidth.value = Math.max(180, (240 * video.videoWidth) / video.videoHeight);
  await nextTick();
  updateNodeInternals();
}

function getConfig() {
  const options = optionsFor(selectedModel.value);
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      duration: data.value.duration,
      resolution: data.value.resolution,
      ratio: data.value.ratio,
      mode: selectedMode.value,
      generateAudio: data.value.generateAudio,
      // 工作流模型专有：resolution 被节点复用为输出规格，改由以下参数描述实际输出。
      ...(options.workflow ? {
        megapixels: data.value.megapixels,
        rewritePrompt: data.value.rewritePrompt,
        turbo: data.value.turbo,
      } : {}),
    },
    models: models.value,
    ratios: options.ratios,
    megapixelOptions: options.workflow ? options.megapixels : [],
    durationOptions: options.workflow ? options.durations : [],
    matchingModes: matchingModes.value,
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取此视频生成节点的当前配置、可选视频模型能力、支持的比例及适合当前引用的模式，不含密钥；云端模型的时长与分辨率须符合 durationResolutionMap，工作流模型的时长是 1–15 秒，另有 megapixels、rewritePrompt 与 turbo",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return getConfig();
  },
});

nodeTools.register({
  name: "setConfig",
  description: "修改此视频生成节点的模型、时长、分辨率、比例、模式、声音，或工作流模型的百万像素、提示词重写与 Turbo；先用 getConfig 查询能力，providerId 与 modelId 必须同时提供；工作流模型的时长是 1–15 秒的浮点；mode 使用返回的原始字符串或数组，须匹配当前引用；不修改提示词、不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    duration: z.number().positive().optional(),
    resolution: z.string().min(1).optional(),
    ratio: z.string().min(1).optional(),
    mode: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    generateAudio: z.boolean().optional(),
    megapixels: z.string().min(1).optional(),
    rewritePrompt: z.boolean().optional(),
    turbo: z.boolean().optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效视频模型");
    const options = optionsFor(choice);
    const durations = getDurations(choice);
    // 工作流模型的时长是 1–15 的整数档位；云端模型必须命中 durationResolutionMap。
    if (args.duration !== undefined && durations.length && !durations.includes(args.duration)) throw new Error(`当前模型不支持时长 ${args.duration}，可选：${durations.join("、")}`);
    if (args.duration !== undefined && !durations.length && (args.duration < DURATION_MIN || args.duration > DURATION_MAX)) throw new Error(`工作流模型的时长范围为 ${DURATION_MIN}–${DURATION_MAX} 秒的整数`);
    let duration = durations.length
      ? (durations.includes(data.value.duration!) ? data.value.duration : durations[0])
      : clampWorkflowDuration(data.value.duration);
    if (args.duration !== undefined) duration = durations.length ? args.duration : clampWorkflowDuration(args.duration);
    const resolutions = getResolutions(choice, duration);
    if (args.resolution !== undefined && !resolutions.includes(args.resolution)) throw new Error(`当前时长不支持分辨率 ${args.resolution}，可选：${resolutions.join("、")}`);
    const resolution = args.resolution ?? (resolutions.includes(data.value.resolution) ? data.value.resolution : resolutions[0] ?? "");
    if (args.ratio !== undefined && !options.ratios.includes(args.ratio)) throw new Error(`当前模型不支持比例 ${args.ratio}，可选：${options.ratios.join("、")}`);
    if (args.megapixels !== undefined && !options.workflow) throw new Error("当前模型用分辨率而非百万像素描述输出，请改用 resolution");
    if (args.megapixels !== undefined && !options.megapixels.includes(args.megapixels)) throw new Error(`当前模型不支持百万像素 ${args.megapixels}，可选：${options.megapixels.join("、")}`);
    if (args.rewritePrompt !== undefined && !options.workflow) throw new Error("当前模型不支持切换提示词重写");
    if (args.turbo !== undefined && !options.workflow) throw new Error("当前模型不支持切换 Turbo");
    if (args.mode !== undefined && !getMatchingModes(choice).some((item) => JSON.stringify(item) === JSON.stringify(args.mode))) throw new Error("所选模式不受当前模型支持或不适用于当前引用，请根据模型能力及已连接素材选择");
    if (args.generateAudio !== undefined && choice.audio !== "optional" && args.generateAudio !== (choice.audio === true)) throw new Error("当前模型不支持切换声音，请查看 getConfig 返回的 audio 能力");
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    data.value.duration = duration;
    data.value.resolution = resolution;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    if (args.mode !== undefined) data.value.mode = JSON.stringify(args.mode);
    if (args.generateAudio !== undefined) data.value.generateAudio = args.generateAudio;
    if (args.megapixels !== undefined) data.value.megapixels = args.megapixels;
    if (args.rewritePrompt !== undefined) data.value.rewritePrompt = args.rewritePrompt;
    if (args.turbo !== undefined) data.value.turbo = args.turbo;
    return getConfig();
  },
});

nodeTools.register({
  name: "setPrompt",
  description: "修改此节点的视频生成提示词，支持 {{ref 1}} 等参考标记；只修改提示词，不启动生成",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt: value }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    data.value.prompt = value;
    data.value.promptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
    return { prompt: value };
  },
});

nodeTools.register({
  name: "generateVideo",
  description: "启动此节点的后台视频生成，使用当前提示词、模型、模式、时长、分辨率、比例和参考素材；立即返回已开始，用 getGenerationStatus 查询完成结果，cancelGeneration 停止生成",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.videoContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .videoEmpty {
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
  .referenceHint {
    margin: 8px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
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
