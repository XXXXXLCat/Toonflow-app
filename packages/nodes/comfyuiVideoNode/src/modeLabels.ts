// 生成模式的显示名：设置面板的下拉与提示词下方的说明共用同一份，避免两处各写一套而分叉。
export const MODE_LABELS: Record<string, string> = {
  text: "文生视频",
  singleImage: "单图参考",
  startEndRequired: "首尾帧必填",
  endFrameOptional: "尾帧可选",
  startFrameOptional: "首帧可选",
};

export function modeLabel(mode: string | string[]) {
  return Array.isArray(mode) ? "混合参考" : MODE_LABELS[mode] ?? mode;
}

// 下拉里的选项按「这张（些）素材最终落到哪」命名——模式名说的是"哪一端可选"，读的人还得自己
// 反推图片的去向；直接写结果更省事。一个模式的结果随素材数量变化（「首帧可选」在 1 图时是尾帧、
// 2 图时是首尾帧），所以标签由节点按当前素材数算好后下发。
export const OUTCOME_LABELS: Record<string, string> = {
  first: "首帧",
  last: "尾帧",
  "first+last": "首尾帧",
  reference: "参考素材",
};

export function outcomeLabel(outcome: string) {
  return OUTCOME_LABELS[outcome] ?? outcome;
}
