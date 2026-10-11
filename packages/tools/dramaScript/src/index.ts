import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const configSchema = z.strictObject({
  pythonPath: z.string().trim().max(4096).default(""),
  timeoutSeconds: z.number().int().min(5).max(3600).default(900),
  maxOutputChars: z.number().int().min(1000).max(2_000_000).default(200_000),
}).strict();

const requestSchema = z.strictObject({
  skill: z.string().trim().min(1).max(96)
    .describe("技能名称，必须是当前技能目录里实际存在的技能，如 short-drama、short-drama-storyboard"),
  script: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.-]+\.py$/)
    .describe("该技能 scripts/ 目录下的脚本文件名，如 project_tool.py、novel_index.py"),
  args: z.array(z.string().max(8192)).max(200).default([])
    .describe("逐项原样传给脚本的参数；不经过 shell，不做通配符展开，含空格的值直接作为一项传入"),
  projectRoot: z.string().trim().min(1).max(4096).optional()
    .describe("脚本运行目录，默认当前工作区；脚本里项目路径的相对写法以它为准"),
}).strict();

// ACT: 只放行技能目录 scripts/ 内的脚本，解释器按固定候选链查找，不经过 shell。
function pythonCandidates(explicit: string) {
  const names = process.platform === "win32" ? ["python.exe"] : ["python3", "python"];
  const candidates: string[] = [];
  const push = (value: string | undefined) => { if (value && !candidates.includes(value)) candidates.push(value); };
  push(explicit);
  push(process.env.TOONFLOW_PYTHON);
  let here = "";
  try { here = fileURLToPath(new URL(".", import.meta.url)); } catch { here = ""; }
  const exec = dirname(process.execPath);
  const roots = [
    here ? resolve(here, "../python") : "",
    here ? resolve(here, "../../python") : "",
    resolve(exec, "../Resources/app/python"),
    resolve(exec, "../../Resources/app/python"),
    resolve(exec, "../app/python"),
  ].filter(Boolean);
  for (const root of roots) for (const name of names) push(join(root, name));
  for (const name of names) push(name);
  return candidates;
}

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function runScript(python: string, scriptPath: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<RunResult>((settle, fail) => {
    signal?.throwIfAborted();
    const child = spawn(python, [scriptPath, ...args], {
      cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult) => { if (!settled) { settled = true; settle(result); } };
    const stop = () => { timedOut = true; child.kill(); };
    const timer = setTimeout(stop, timeoutMs);
    const abort = () => { clearTimeout(timer); child.kill(); };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", abort); fail(error); });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

function truncate(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n……输出已截断，共 ${text.length} 字，只保留前 ${limit} 字；需要后续内容时缩小脚本范围或分次查询。`;
}

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ config, skills, resolvePath }) {
    if (!skills) return [];
    const { pythonPath, timeoutSeconds, maxOutputChars } = configSchema.parse(config);
    const candidates = pythonCandidates(pythonPath);
    return [{
      name: "dramaScript",
      label: "短剧脚本",
      description: `执行短剧技能自带脚本。skill 填技能名，script 填该技能 scripts/ 目录下的脚本文件名，args 按顺序原样传给脚本。只能执行技能目录内已存在的 python 脚本，不经过 shell，参数不做通配符与变量展开。脚本退出码、标准输出与标准错误原样返回。`,
      promptSnippet: "按技能正文给出的命令执行短剧技能自带脚本。",
      promptGuidelines: [
        "技能正文里的 python3 命令由本工具执行：命令中的 {技能目录}/scripts/xxx.py 拆成 skill 与 script 两项，其余参数按原顺序逐项放进 args，不合并成整条命令行。{技能目录} 指脚本实际所属的技能目录，跨技能引用时（如原著分析正文里出现的 project_tool.py）skill 填脚本所属的那个技能名，不填当前技能名。",
        "args 逐项原样传递，含空格的值直接作为一项，不需要加引号或转义；管道路径和重定向都要改写成脚本自身的参数。",
        "脚本处理的项目用 projectRoot 指定运行目录，省略时为当前工作区。脚本报错时按标准错误原文修正入参，不重复执行同一条失败命令。",
        "校验脚本输出 ERROR 时，那些是文档之间的事实冲突；按报错指出的条目回到对应文档修正后重新校验，不要绕过校验继续生产。",
      ],
      parameters: z.toJSONSchema(requestSchema, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const { skill, script, args, projectRoot } = requestSchema.parse(params);
        signal?.throwIfAborted();
        const listed = skills.list();
        const target = listed.find(item => item.name === skill);
        if (!target) {
          throw new Error(`技能不存在：${skill}；当前可用：${listed.map(item => item.name).join("、")}`);
        }
        const scriptsDirectory = join(dirname(target.filePath), "scripts");
        const scriptPath = resolve(scriptsDirectory, script);
        const offset = relative(scriptsDirectory, scriptPath);
        if (!offset || isAbsolute(offset) || offset.startsWith("..")) throw new Error(`脚本不在该技能的 scripts 目录内：${script}`);
        if (!existsSync(scriptPath)) {
          throw new Error(`脚本不存在：${skill}/scripts/${offset}`);
        }
        const runDirectory = projectRoot ? await resolvePath(projectRoot) : await resolvePath(".");
        const timeoutMs = timeoutSeconds * 1000;
        let lastError: Error | undefined;
        const startedAt = Date.now();
        for (const python of candidates) {
          let result: RunResult;
          try {
            result = await runScript(python, scriptPath, args, runDirectory, timeoutMs, signal);
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") continue;
            throw error;
          }
          if (result.timedOut) throw new Error(`脚本超过 ${timeoutSeconds} 秒未结束，已中止：${skill}/scripts/${offset}`);
          const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
          const lines = [`${skill}/scripts/${offset} · 退出码 ${result.code} · ${seconds}s`];
          if (result.stdout.trim()) lines.push(result.stdout.trim());
          if (result.stderr.trim()) lines.push(`[标准错误]\n${result.stderr.trim()}`);
          if (result.code !== 0) lines.push("脚本非零退出，按上面的标准错误修正入参或先修文档，不要当作成功。");
          return {
            content: [{ type: "text", text: truncate(lines.join("\n"), maxOutputChars) }],
            details: { skill, script: offset, exitCode: result.code, seconds, python },
          };
        }
        throw new Error(`没有可用的 python 解释器，已尝试：${candidates.join("、")}${lastError ? `；最后一个错误：${lastError.message}` : ""}`);
      },
    }];
  },
};

export default plugin;
