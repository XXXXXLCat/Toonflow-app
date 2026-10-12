<template>
  <div class="general">
    <section class="settingSection" aria-labelledby="startupTitle">
      <div class="settingHeader">
        <div class="settingInfo">
          <h3 id="startupTitle">启动动画</h3>
          <p class="description">启动时播放动画。关闭可加快启动速度，可能出现闪屏，下次启动生效。</p>
        </div>
        <el-switch
          :modelValue="uiSettings.startupAnimation"
          aria-label="启动动画"
          @change="(value) => updateUiSettings({ startupAnimation: value === true })" />
      </div>
    </section>
    <section class="settingSection" aria-labelledby="canvasCompositingTitle">
      <div class="settingHeader">
        <div class="settingInfo">
          <h3 id="canvasCompositingTitle">画布合成优化</h3>
          <p class="description">优化大量节点时的平移和缩放，可能增加显存占用并导致模糊，立即生效。</p>
        </div>
        <el-switch
          :modelValue="generalSettings.canvasCompositingEnabled"
          aria-label="画布合成优化"
          @change="(value) => updateGeneralSettings({ canvasCompositingEnabled: value === true })" />
      </div>
    </section>
    <section class="settingSection" aria-labelledby="canvasEdgeAnimationTitle">
      <div class="settingHeader">
        <div class="settingInfo">
          <h3 id="canvasEdgeAnimationTitle">节点连线动画</h3>
          <p class="description">选中或拖动节点时，与它直接相连的线条显示流动动画。关闭仍保留高亮，立即生效。</p>
        </div>
        <el-switch
          :modelValue="generalSettings.canvasEdgeAnimationEnabled"
          aria-label="节点连线动画"
          @change="(value) => updateGeneralSettings({ canvasEdgeAnimationEnabled: value === true })" />
      </div>
    </section>
    <section class="settingSection" aria-labelledby="canvasEdgeColorTitle">
      <div class="settingHeader">
        <div class="settingInfo">
          <h3 id="canvasEdgeColorTitle">节点连线高亮颜色</h3>
          <p class="description">设置选中或拖动节点时，与它直接相连的线条的高亮颜色，立即生效。</p>
        </div>
        <div class="edgeColorControls">
          <el-select
            :modelValue="generalSettings.canvasEdgeColorMode"
            aria-label="节点连线颜色模式"
            @change="(value) => updateGeneralSettings({ canvasEdgeColorMode: value })">
            <el-option label="不使用高亮颜色" value="none" />
            <el-option label="跟随主题色" value="theme" />
            <el-option label="自选颜色" value="custom" />
          </el-select>
          <el-color-picker
            v-if="generalSettings.canvasEdgeColorMode === 'custom'"
            :modelValue="generalSettings.canvasEdgeColor"
            colorFormat="hex"
            aria-label="节点连线自选颜色"
            @change="(value) => updateGeneralSettings({ canvasEdgeColor: value || defaultUiSettings.primaryColor })" />
        </div>
      </div>
    </section>
    <section class="settingSection" aria-labelledby="imageDropNodeTitle">
      <div class="settingHeader">
        <div class="settingInfo">
          <h3 id="imageDropNodeTitle">拖入图片默认节点</h3>
          <p class="description">从文件管理器拖入或选择图片时，默认创建的节点类型。选「每次询问」后，每次拖入都会弹出选择框；「ComfyUI 图片生成节点」需先启用对应的 ComfyUI 节点。</p>
        </div>
        <el-radio-group
          :modelValue="imageDropNodeType"
          class="imageDropRadio"
          aria-label="拖入图片默认节点类型"
          @change="(value) => imageDropNodeType = value as string">
          <el-radio-button value="ask">每次询问</el-radio-button>
          <el-radio-button value="remote-imageNode">普通图片节点</el-radio-button>
          <el-radio-button value="remote-comfyuiImageNode">ComfyUI 图片生成节点</el-radio-button>
        </el-radio-group>
      </div>
    </section>
    <section class="settingSection" aria-labelledby="comfyuiUrlTitle">
      <div class="settingHeader">
        <div class="settingInfo">
          <h3 id="comfyuiUrlTitle">ComfyUI 地址</h3>
          <p class="description">本地 ComfyUI 服务地址。留空默认 http://127.0.0.1:8188；其他地址（如局域网 http://192.168.50.5:8188）需手动填写，填写后仅使用该地址。</p>
        </div>
        <el-input
          v-model="comfyuiUrl"
          class="comfyAddressInput"
          placeholder="http://127.0.0.1:8188"
          clearable
          aria-label="ComfyUI 地址" />
      </div>
    </section>
    <canvasShortcuts />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { defaultUiSettings, generalSettings, settings, uiSettings, updateGeneralSettings, updateUiSettings } from "@/stores/settings";
import canvasShortcuts from "./canvasShortcuts.vue";

// 拖入/选择图片时默认创建的节点类型。值为空（"ask"）时每次都弹出选择框；
// 与画布拖入弹窗里「记住选择」写入的是同一个 settings.imageDropNodeType。
const imageDropNodeType = computed<string>({
  get: () => (settings.value.imageDropNodeType as string | undefined) ?? "ask",
  set: (value) => {
    settings.value.imageDropNodeType = value === "ask" ? undefined : value;
  },
});

// ComfyUI 服务地址。留空用默认本地地址；手动指定后仅用该地址。settings 深度 watch 自动存盘。
const comfyuiUrl = computed<string>({
  get: () => typeof settings.value.comfyuiUrl === "string" ? settings.value.comfyuiUrl : "",
  set: (value) => { settings.value = { ...settings.value, comfyuiUrl: value }; },
});
</script>

<style lang="scss" scoped>
.general {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 0 4px 8px;

  .settingSection {
    .settingHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;

      > .el-switch { flex-shrink: 0; }

      .edgeColorControls {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;

        .el-select { width: 140px; }
      }

      .imageDropRadio {
        flex-shrink: 0;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .comfyAddressInput {
        width: 320px;
        max-width: 100%;
        flex-shrink: 0;
      }

      .settingInfo {
        min-width: 0;

        h3 {
          margin: 0;
          color: var(--el-text-color-primary);
          font-size: 14px;
          font-weight: 600;
        }

        .description {
          margin: 6px 0 0;
          color: var(--el-text-color-secondary);
          font-size: 12px;
          line-height: 1.6;
        }
      }
    }
  }
}
</style>
