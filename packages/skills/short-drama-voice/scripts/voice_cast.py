#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为需要配音的人物生成「音色试听」的合成请求。

每个人物一条 job：用预置音色读一段带朗读内容的参考文本，出来就是这个人物的参考音频。
它同时是语音模型的 `reference_text`——告诉模型参考音频里念的是什么。

本脚本只输出 job 描述，供 `$short-drama-produce` 的 `tts` 模态执行：
它不调用供应商、不写文件、不生成音频。真正合成要经生产技能的确认闸门。

输出每个 job 的三样关键内容：
  - text：要念的参考文本（带朗读内容，不是描述）
  - instruction：语音指令（写身份，不写情绪）
  - voice_id / model：由创作者与账号给定，脚本不预设
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from voice_plan import build_plan, find_episode_dir, read_voice_cast  # noqa: E402

# 参考文本的目标长度：太短听不出音色，太长白花算力。
REFERENCE_MIN_CHARS = 30
REFERENCE_MAX_CHARS = 120


def reference_text_for(record: Dict[str, str], lines: List[Dict[str, Any]]) -> str:
    """取这个人物的参考文本；配音本没写时用他的头两句台词拼一个候选。"""
    written = record.get("参考文本", "").strip()
    if written:
        return written
    picked = [item["line"] for item in lines[:2] if item.get("line")]
    return "".join(picked)


def build_jobs(episode_dir: Path) -> Dict[str, Any]:
    plan = build_plan(episode_dir)
    roll = read_voice_cast(episode_dir)
    jobs: List[Dict[str, Any]] = []
    blocked: List[Dict[str, Any]] = []

    for item in plan["cast"]:
        speaker = item["speaker"]
        record = roll.get(speaker, {})
        reference = item.get("voice_reference", "")
        # 已经有可用的参考音频（录音或已合成的试听）就不必再合成。
        if reference and not reference.startswith("待选型") and record.get("参考音频来源") != "待合成":
            continue
        text = reference_text_for(record, item["line_items"])
        instruction = record.get("语音指令", "").strip()
        voice_id = record.get("音色ID", "").strip()
        model = record.get("语音模型", "").strip()

        missing: List[str] = []
        if not text:
            missing.append("参考文本")
        elif not (REFERENCE_MIN_CHARS <= len(text) <= REFERENCE_MAX_CHARS):
            missing.append(f"参考文本长度应在 {REFERENCE_MIN_CHARS}–{REFERENCE_MAX_CHARS} 字之间（现在 {len(text)}）")
        if not instruction:
            missing.append("语音指令")
        if not voice_id:
            missing.append("音色ID")
        if not model:
            missing.append("语音模型")

        job = {
            "character": speaker,
            "visual_entry": item.get("visual_entry"),
            "lines": item["lines"],
            "modality": "tts",
            "text": text,
            "instruction": instruction,
            "voice_id": voice_id,
            "model": model,
            "output": f"制作成果/audio/voice-{speaker}.mp3",
        }
        if missing:
            job["missing"] = missing
            blocked.append(job)
        else:
            jobs.append(job)

    stats = {
        "episode": episode_dir.name,
        "needed": len(jobs) + len(blocked),
        "ready": len(jobs),
        "blocked": len(blocked),
        "blocked_characters": [job["character"] for job in blocked],
    }
    return {"stats": stats, "jobs": jobs, "blocked": blocked}


def main() -> int:
    parser = argparse.ArgumentParser(description="生成人物音色试听的合成请求（只读，不合成）")
    parser.add_argument("project", help="项目根目录，或直接指定剧集目录")
    parser.add_argument("--episode", help="剧集目录名，如 EP001；省略时取第一个")
    parser.add_argument("--pretty", action="store_true", help="格式化输出，便于人工核对")
    args = parser.parse_args()

    root = Path(args.project).expanduser()
    if not root.is_dir():
        raise SystemExit(f"目录不存在：{root}")
    episode_dir = find_episode_dir(root.resolve(), args.episode)
    plan = build_jobs(episode_dir)
    print(json.dumps(plan, ensure_ascii=False, indent=2 if args.pretty else None))

    stats = plan["stats"]
    if stats["blocked"]:
        print(f"警告：{stats['blocked']} 个人物的试听 job 还缺字段，先补齐再合成："
              f"{stats['blocked_characters']}", file=sys.stderr)
    if stats["ready"]:
        print(f"有 {stats['ready']} 个人物可以合成试听；每个 job 都要经 $short-drama-produce 的确认闸门",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
