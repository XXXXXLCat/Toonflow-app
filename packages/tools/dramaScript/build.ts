import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "dramaScript",
  displayName: "短剧脚本",
  description: "执行短剧技能自带的分析、校验与项目脚本，用于原著索引、分集切片、文档校验与项目管理。",
  author: "Toonflow",
  github: "https://github.com/XXXXXLCat/Toonflow-app",
  prompt: `短剧技能正文里的 python3 命令由 dramaScript 执行：把命令中的 {技能目录}/scripts/xxx.py 拆成 skill 与 script，剩余参数按原顺序逐项放进 args，不拼成整条命令行，也不加引号转义。
处理具体项目的脚本用 projectRoot 指向该项目目录。校验脚本输出 ERROR 时，那是文档之间的事实冲突；按报错指出的条目回到对应文档修正后重新校验，不绕过校验继续生产，也不把非零退出当成功。`,
  configRules: [],
}, import.meta.url);
