<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    :bottomVisible="node.selected"
    bottomWidth="660"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    :fullscreenVisible="false"
    style="width: 360px">
    <template #topActions>
      <el-button :icon="IconScissors" :disabled="busy || !previewUrl" text title="截取音频" aria-label="截取音频" @click.stop="actions?.open('clip')">截取</el-button>
      <el-button :icon="IconGauge" :disabled="busy || !previewUrl" text title="音频变速" aria-label="音频变速" @click.stop="actions?.open('speed')">变速</el-button>
      <mediaHistory mediaType="audio" :current="outputFile" :disabled="busy" @select="outputs.audio = { dataType: 'AUDIO', value: $event }" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="busy" text title="替换音频" aria-label="替换音频" @click.stop="fileInput?.click()">替换音频</el-button>
      <input ref="fileInput" type="file" accept="audio/*" hidden aria-label="选择替换音频" :disabled="busy" @change="replaceOutput" />
    </template>
    <div v-loading="generating || uploading" class="audioContent nopan" :aria-busy="generating || uploading">
      <audioPlayer v-if="previewUrl" ref="player" class="audioPreview" :src="previewUrl" @loadedmetadata="updateNodeInternals" />
      <div v-else class="audioEmpty" role="img" aria-label="暂无生成音乐"><icon-music-bolt :size="48" stroke="1.25" aria-hidden="true" /></div>
    </div>
    <template #bottom>
      <div v-if="actions?.mode === 'speed'" ref="speedTarget" />
      <el-card v-else class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
        <div v-if="referenceHint" class="referenceHint">{{ referenceHint }}</div>
        <!-- 两条独立的文本通道：风格描述进供应商的 prompt（工作流的 style），歌词进 text（lyrics）。 -->
        <div class="fieldSection">
          <span class="fieldLabel">Text (Style)</span>
          <promptInput
            v-model="data.styleModel"
            v-model:text="data.style"
            :references="referenceMentions"
            placeholder="描述风格、编曲与乐器，如 cinematic orchestral with strings and taiko drums"
            expandable />
        </div>
        <div class="fieldSection">
          <span class="fieldLabel">Text (Lyrics)</span>
          <promptInput
            v-model="data.lyricsModel"
            v-model:text="data.lyrics"
            :references="referenceMentions"
            placeholder="输入歌词，支持 [Verse] / [Chorus] 等段落标记"
            expandable />
        </div>
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="busy"
            placeholder="选择模型"
            aria-label="音乐生成模型"
            noDataText="没有可用的音乐模型，请在设置中添加音乐模型"
            placement="top-start"
            @visible-change="visible => visible && loadModels().catch(error => showNodeError(error, '模型读取失败'))">
            <template #prefix><icon-music-bolt :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option v-for="item in provider.models" :key="item.modelId" :label="item.label" :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings
            v-model:format="data.format"
            v-model:quality="data.quality"
            v-model:max-duration="data.maxDuration"
            v-model:seed-mode="data.seedMode"
            v-model:seed-value="data.seedValue"
            :formats="formatOptions"
            :disabled="busy || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="deleting || uploading || actions?.processing || (!generating && (!generationStyle || !selectedModel))"
            :title="generating ? '停止生成' : '生成音乐'"
            :aria-label="generating ? '停止生成' : '生成音乐'"
            @click="generating ? generationController?.abort() : startGeneration().catch(error => showNodeError(error, '音乐生成失败'))" />
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <audioActions ref="actions" :file="outputFile" :src="previewUrl" :target="speedTarget" :disabled="generating || deleting || uploading" @pause="player?.pause()" />
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from "vue";
import { ElButton, ElCard, ElLoading, ElOption, ElOptionGroup, ElSelect } from "element-plus";
import { IconArrowUp, IconGauge, IconMusicBolt, IconPlayerStop, IconScissors, IconTransfer } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, z, type NodeAudioRequest, type NodeHandle, type NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import audioPlayer from "@toonflow/node-audio/audioPlayer";
import audioActions from "@toonflow/node-audio/audioActions";
import mediaHistory from "@toonflow/node-shared/mediaHistory";
import promptInput from "@toonflow/node-shared/promptInput";
import referenceItem from "@toonflow/node-shared/referenceItem";
import generationSettings from "./components/generationSettings.vue";
import {
  defaultDuration, defaultQuality, durationStep, formatOptions, maxDuration, maxSeed, minDuration,
  qualityOptions, randomSeed,
} from "./musicFormats";

defineOptions({
  inheritAttrs: false,
  icon: IconMusicBolt,
  // 文本接风格描述与歌词；音频只有翻唱类模型会消费（把参考音频转成 ABC 记谱），
  // 所以同一个端口同时接受两者，由模型的 referenceAudio 能力决定音频去留。
  handles: [
    { id: "in", type: "target", dataType: ["STRING", "AUDIO"], label: "文本、音频输入" },
    { id: "audio", type: "source", dataType: "AUDIO", label: "音频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({ label: "ComfyUI 音乐生成" });
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as {
  style: string; styleModel: PromptModel;
  lyrics: string; lyricsModel: PromptModel;
  model: string; format: string; quality: string;
  maxDuration: number;
  seedMode: string; seedValue: number;
});
data.value.style ??= "";
data.value.styleModel ??= [];
data.value.lyrics ??= "";
data.value.lyricsModel ??= [];
data.value.model ??= "";
data.value.format ??= "mp3";
// 旧文档可能存着工作流不支持的格式（SaveAudioAdvanced 只认 mp3 / flac / opus），直接回落默认格式。
if (!formatOptions.includes(data.value.format)) data.value.format = "mp3";
// 音质是格式的二级入参：格式变了、或旧文档里的档位已不适用，就落回该格式的默认档位。
data.value.quality ??= "";
if (!qualityOptions[data.value.format]?.includes(data.value.quality)) data.value.quality = defaultQuality(data.value.format);
// 模式由供应商按工作流写死（文本生成走 full、翻唱走 melody），画布不提供选择，这里只做旧文档清理。
delete (data.value as { mode?: string }).mode;
data.value.maxDuration = Math.floor(Number(data.value.maxDuration));
if (!Number.isFinite(data.value.maxDuration) || data.value.maxDuration < minDuration || data.value.maxDuration > maxDuration) data.value.maxDuration = defaultDuration;
// 种子：缺省每次随机；旧文档里存了越界值就重新摇一个。
data.value.seedMode ??= "random";
data.value.seedValue = Math.floor(Number(data.value.seedValue));
if (!Number.isFinite(data.value.seedValue) || data.value.seedValue < 1 || data.value.seedValue > maxSeed) data.value.seedValue = randomSeed();
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const deleting = ref(false);
const fileInput = ref<HTMLInputElement>();
const player = ref<InstanceType<typeof audioPlayer>>();
const actions = ref<InstanceType<typeof audioActions>>();
const speedTarget = ref<HTMLElement>();
let disposed = false;
let generationController: AbortController | undefined;
let generation: Promise<void> | undefined;
let modelsRequest: Promise<void> | undefined;
const generationState = useNodeGeneration(outputs, () => generationController?.abort());
const { generating } = generationState;
const busy = computed(() => generating.value || uploading.value || deleting.value || !!actions.value?.processing);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
const modelGroups = computed(() => groupNodeModels(models.value));
// 接入的文本按先后顺序分配：第 1 条并入风格描述，第 2 条及以后并入歌词。
// 编号沿用引用在列表中的位置，与 @ 提及的「参考 N」对得上。
const stringRefs = computed(() => refList.value.flatMap((item, index) =>
  item.dataType === "STRING" && item.value?.trim() ? [{ label: `参考 ${index + 1}`, text: item.value.trim() }] : []));
const styleRefs = computed(() => stringRefs.value.filter((_, index) => index === 0));
const lyricsRefs = computed(() => stringRefs.value.filter((_, index) => index !== 0));
const generationStyle = computed(() => [data.value.style.trim(),
  ...styleRefs.value.map(item => `${item.label}：\n${item.text}`)].filter(Boolean).join("\n\n"));
const generationLyrics = computed(() => [data.value.lyrics.trim(),
  ...lyricsRefs.value.map(item => `${item.label}：\n${item.text}`)].filter(Boolean).join("\n\n"));
// 接了音频才提示：文本生成音乐的模型用不上它，别让用户以为接了就会生效。
const hasReferenceAudio = computed(() => refList.value.some(item => item.dataType === "AUDIO"));
// 参考音频只有翻唱类模型会消费（YuE2 翻唱要把音频转成 ABC 记谱）；文本生成音乐的工作流里
// 根本没有加载音频的节点，接了也会被丢弃。模型用 referenceAudio 声明这项能力，未声明即不支持——
// 据此提示并把音频从请求里剔除，而不是让用户接完再静默丢掉。
const supportsReferenceAudio = computed(() => selectedModel.value?.referenceAudio === true);
const audios = computed(() => supportsReferenceAudio.value
  ? refList.value.flatMap(item => item.dataType === "AUDIO" && item.value
    ? [{ path: item.value.url, mimeType: item.value.mimeType }] : [])
  : []);
const referenceHint = computed(() => {
  if (hasReferenceAudio.value && !supportsReferenceAudio.value) return "当前模型不使用参考音频，接入的音频会被忽略";
  if (selectedModel.value?.requiresReferenceAudio === true && !audios.value.length) return "该模型需要参考音频（翻唱），请接入一段音频";
  return "";
});
const outputFile = computed(() => outputs.value.audio?.dataType === "AUDIO" ? outputs.value.audio.value : undefined);
const previewUrl = files.useFileUrl(outputFile, error => showNodeError(error, "音乐读取失败"));

onMounted(() => loadModels().catch(error => showNodeError(error, "模型读取失败")));
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
});

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then(items => {
    if (disposed || busy.value) return;
    // ACT: 只列音乐模型（audioCategory: "music"）。语音合成的模型归 ComfyUI-音频生成，
    // 混在一起会让两个节点的模型下拉内容完全一样，等于白分成两个节点。
    models.value = items.filter(item => item.type === "audio" && item.audioCategory === "music");
    // 过滤后旧选择可能已不在列表内（比如之前选的是 TTS 模型），那样下拉会空白且发不了——
    // 落回列表里的第一个。仍在列表内则保持原选择，避免临时不可用的模型被静默换掉。
    if (!models.value.some(item => JSON.stringify([item.providerId, item.modelId]) === data.value.model)) {
      const first = models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function startGeneration() {
  if (busy.value || disposed) throw new Error("音乐正在处理或节点已关闭，请稍后重试");
  const choice = selectedModel.value;
  if (!choice) throw new Error("请先选择音乐模型");
  if (!generationStyle.value) throw new Error("请输入风格描述");
  // 翻唱类模型没有参考音频就转不出谱，在这里拦住好过提交一个必然失败的任务。
  if (selectedModel.value?.requiresReferenceAudio === true && !audios.value.length) throw new Error("该模型需要参考音频，请接入一段音频");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  if (!formatOptions.includes(data.value.format)) throw new Error("请重新选择有效的输出格式");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  // 随机模式在每次生成前现摇一个种子——听到满意的曲子后切到「固定」就能复现它。
  if (data.value.seedMode !== "fixed") data.value.seedValue = randomSeed();
  const input: Omit<NodeAudioRequest, "directory"> = {
    providerId: choice.providerId,
    modelId: choice.modelId,
    // 平台把 prompt 映射为供应商的 text（工作流的 lyrics）、instruction 映射为 prompt（style）；
    // 供应商按各自的通道取，这里对应：style 走 instruction、lyrics 走 prompt。
    prompt: generationLyrics.value,
    instruction: generationStyle.value,
    // 翻唱类模型会消费参考音频；其余模型不声明该能力，这里传空数组等于没传。
    audios: audios.value.length ? audios.value : undefined,
    format: data.value.format,
    quality: data.value.quality || undefined,
    // 时长上限通过 other 传给工作流专属参数（音频请求的白名单里没有这一项）。
    other: { maxDuration: data.value.maxDuration },
    seed: data.value.seedValue,
    outputDirectory: `assets/${id}`,
  };
  generationController = controller;
  generation = generationState.run(async () => {
    const { directory } = await workspace.list();
    controller.signal.throwIfAborted();
    const [result] = await ai.generateAudio({ ...input, directory }, controller.signal);
    controller.signal.throwIfAborted();
    if (!result) throw new Error("供应商未返回音乐");
    outputs.value.audio = { dataType: "AUDIO", value: { url: result.path, mimeType: result.mimeType } };
  }).catch(error => showNodeError(error, "音乐生成失败")).finally(() => {
    generationController = undefined;
  });
  return { status: "generating" };
}

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value || disposed) return;
  if (!file.type.startsWith("audio/")) return void showNodeError("请选择音频文件", "音频替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("音频不能为空且不能超过 100 MB", "音频替换失败");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: 替换不删除旧音频，保留复制节点与撤销记录的文件引用。
    outputs.value.audio = { dataType: "AUDIO", value: { url, mimeType: file.type } };
  } catch (error) {
    showNodeError(error, "音频替换失败");
  } finally {
    uploading.value = false;
  }
}

nodeEvent.on("save", reason => {
  if (uploading.value || (reason === "reload" && busy.value)) throw new Error("音乐处理中，请完成或取消后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error("音乐正在替换，请稍后删除节点");
  deleting.value = true;
  generationController?.abort();
  try {
    await Promise.all([generation, actions.value?.cancelAndWait()]);
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

function getConfig() {
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      style: data.value.style,
      lyrics: data.value.lyrics,
      format: data.value.format,
      quality: data.value.quality,
      maxDuration: data.value.maxDuration,
      seedMode: data.value.seedMode === "fixed" ? "fixed" : "random",
      seedValue: data.value.seedValue,
    },
    models: models.value,
    formats: formatOptions,
    qualityOptions,
    // 翻唱类模型没有参考音频就转不出谱，据此告诉调用方当前能不能直接生成。
    requiresReferenceAudio: selectedModel.value?.requiresReferenceAudio === true,
    durationRange: { min: minDuration, max: maxDuration, step: durationStep },
    maxSeed,
    inputLimits: { style: 1, lyrics: 1 },
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取此 ComfyUI 音乐生成节点的当前配置、可选音乐模型、输出格式与音质档位、时长上限及种子设置，不含密钥；Text (Style) 与 Text (Lyrics) 各一条，文本可接上游节点；接入的文本按顺序分配，第 1 条并入风格描述、第 2 条及以后并入歌词；模型带 referenceAudio 才表示它会使用接入的音频，带 requiresReferenceAudio 表示必须接入音频才能生成",
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
  description: "修改此 ComfyUI 音乐生成节点的模型、输出格式、音质档位、时长上限或种子；先用 getConfig 查询选项，providerId 与 modelId 必须同时提供；音质必须与格式匹配，改格式会重置音质；不修改文本、不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    format: z.string().optional(),
    quality: z.string().optional(),
    maxDuration: z.number().min(minDuration).max(maxDuration).optional(),
    seedMode: z.enum(["random", "fixed"]).optional(),
    seedValue: z.number().int().min(1).max(maxSeed).optional(),
  }).refine(args => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (busy.value || disposed) throw new Error("音乐正在处理或节点已关闭，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (busy.value || disposed) throw new Error("音乐正在处理或节点已关闭，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value : models.value.find(item => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效音乐模型");
    if (args.format !== undefined && !formatOptions.includes(args.format)) throw new Error("请选择 getConfig 返回的有效输出格式");
    if (args.quality !== undefined) {
      // 音质挂在格式下面，按生效后的格式校验：换到 flac 时任何档位都不适用。
      const options = qualityOptions[args.format ?? data.value.format] ?? [];
      if (!options.includes(args.quality)) throw new Error(`请选择 getConfig 返回的音质档位（${options.join(" / ") || "当前格式没有音质选项"}）`);
    }
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    if (args.format !== undefined) {
      data.value.format = args.format;
      data.value.quality = defaultQuality(args.format);
    }
    if (args.quality !== undefined) data.value.quality = args.quality;
    if (args.maxDuration !== undefined) data.value.maxDuration = Math.round(args.maxDuration / durationStep) * durationStep;
    // 固定种子时值必须一起给，否则节点会拿着旧的种子却以为是新填的。
    if (args.seedMode !== undefined) data.value.seedMode = args.seedMode;
    if (args.seedValue !== undefined) {
      data.value.seedValue = args.seedValue;
      data.value.seedMode = args.seedMode ?? "fixed";
    } else if (args.seedMode === "fixed" && (!Number.isFinite(data.value.seedValue) || data.value.seedValue < 1)) {
      data.value.seedValue = randomSeed();
    }
    return getConfig();
  },
});
nodeTools.register({
  name: "setText",
  description: "修改此 ComfyUI 音乐生成节点的 Text (Style) 与 Text (Lyrics)，支持 {{ref 1}} 等参考标记；只修改文本，不启动生成",
  parameters: z.strictObject({ style: z.string().optional(), lyrics: z.string().optional() }),
  execute({ style, lyrics }) {
    if (deleting.value || disposed) throw new Error("节点正在删除或已关闭，请稍后修改");
    if (style !== undefined) {
      data.value.style = style;
      data.value.styleModel = style.split("\n").map(line => [{ type: "Write", text: line }]);
    }
    if (lyrics !== undefined) {
      data.value.lyrics = lyrics;
      data.value.lyricsModel = lyrics.split("\n").map(line => [{ type: "Write", text: line }]);
    }
    return { style: data.value.style, lyrics: data.value.lyrics };
  },
});
nodeTools.register({
  name: "generateMusic",
  description: "使用当前风格描述、歌词、模型与输出格式启动后台生成；立即返回已开始，用 getGenerationStatus 查询结果、cancelGeneration 停止（会一并撤销 ComfyUI 上已提交的任务）",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.audioContent {
  position: relative;
  min-height: 144px;
  display: flex;
  align-items: center;

  .audioPreview {
    display: block;
    width: 100%;
    border-radius: var(--el-border-radius-base);
  }

  .audioEmpty {
    display: grid;
    place-items: center;
    width: 100%;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }
}

.promptCard {
  .referenceHint {
    margin-top: 10px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .fieldSection {
    .fieldLabel {
      display: block;
      margin-top: 12px;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      font-weight: 500;
    }

    :deep(.promptInputWrap) {
      margin: 8px 0 0;
    }
  }

  .promptFooter {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;

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
