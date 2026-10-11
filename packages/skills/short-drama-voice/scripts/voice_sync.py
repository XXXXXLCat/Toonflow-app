#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把配音本里定好的音色参考回写到跨文档校验认的两个规范位置。

配音本是工作稿；校验器与生产读的是这两个位置，必须同步：

  1. 《视觉设定.md》的人物条目下加/更新 `- 声音参考：<路径>（用途：…；控制：…；不得控制：…）`
  2. 《视频提示词.md》的 MOTION 条目加/更新 `- 参考音频：REF-…（顺序：n）· <路径>《中文名》
     （用途：音色；角色：<人物名>；控制：…；不得控制：台词、语气、情绪）`

只改这两处，不碰其他内容；已存在的行原地更新，不重复追加。
默认先出计划（--dry-run 效果），加 --write 才真正落盘。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from voice_plan import (  # noqa: E402
    build_plan, find_episode_dir, match_visual_entry, read_text,
)
from voice_apply import parse_roll_cast, parse_roll_lines, line_to_motion, scene_to_motions  # noqa: E402

VISUAL_HEADING = re.compile(r"^##\s+人物\s*·\s*(?P<name>.+?)\s*$")
MOTION_HEADING = re.compile(r"^##\s+(?P<id>MOTION-[A-Za-z0-9-]+)\s*(?:·\s*(?P<title>.*))?$")
VOICE_RECORD_LINE = re.compile(r"^[ \t　]*[-*+][ \t　]*声音参考[：:]")
AUDIO_REF_LINE = re.compile(r"^[ \t　]*[-*+][ \t　]*参考音频[：:]")
FIELD_LINE = re.compile(r"^[ \t　]*[-*+][ \t　]*(?P<key>[^：:]+)[：:]")
# 音色参考行的用途/控制/不得控制/状态四段（顺序固定，匹配配音本的写法）。
VOICE_DETAIL = re.compile(r"[（(]用途[：:](?P<purpose>[^；）]*)[；;]控制[：:](?P<may>[^；）]*)[；;]不得控制[：:](?P<must>[^）]*)[）)]")

AUDIO_MUST_NOT = "台词、语气、情绪"


def split_voice_detail(value: str) -> Optional[Dict[str, str]]:
    """从配音本的「声音参考」值里拆出路径与三段控制边界。"""
    matched = VOICE_DETAIL.search(value)
    if not matched:
        return None
    path = value[: matched.start()].strip()
    if not path:
        return None
    return {
        "path": path,
        "purpose": matched.group("purpose").strip(),
        "may": matched.group("may").strip(),
        "must": matched.group("must").strip(),
    }


def slot_for(character: str) -> str:
    """REF 槽位名：ASCII 大写，与人物一一对应。"""
    ascii_name = re.sub(r"[^A-Za-z0-9]+", "-", character).strip("-").upper()
    return f"REF-VOICE-{ascii_name}" if ascii_name else "REF-VOICE"


def apply_visual(episode_dir: Path, cast: Dict[str, Dict[str, str]], write: bool) -> Dict[str, Any]:
    """在《视觉设定.md》的人物条目下加/更新声音参考行。

    插入点优先选「状态变化」/「本集状态」之后；没有该字段时落在条目第一行之后。
    已存在的行原地更新，不重复追加（校验器对重复会判错）。
    """
    doc = episode_dir / "视觉设定.md"
    if not doc.is_file():
        raise SystemExit(f"找不到视觉设定：{doc}")
    lines = read_text(doc).splitlines()
    changed: List[Dict[str, str]] = []

    current: Optional[str] = None
    insert_targets: Dict[str, int] = {}
    has_line: Dict[str, int] = {}
    for index, raw in enumerate(lines):
        heading = VISUAL_HEADING.match(raw.strip())
        if heading:
            current = heading.group("name").strip()
            insert_targets[current] = index + 1
            continue
        if current is None or raw.strip().startswith("## "):
            current = None
            continue
        field = FIELD_LINE.match(raw)
        if field and field.group("key").strip() in ("状态变化", "本集状态"):
            insert_targets[current] = index + 1
            continue
        if VOICE_RECORD_LINE.match(raw):
            has_line[current] = index
            insert_targets.pop(current, None)

    for name, record in cast.items():
        detail = split_voice_detail(record.get("声音参考", ""))
        if not detail:
            continue
        visual_name = record.get("别名_visual") or name
        text = f"- 声音参考：{detail['path']}（用途：{detail['purpose']}；控制：{detail['may']}；不得控制：{detail['must']}）"
        if visual_name in has_line:
            lines[has_line[visual_name]] = text
            changed.append({"位置": f"视觉设定.md · {visual_name}", "动作": "更新"})
        elif visual_name in insert_targets:
            at = insert_targets[visual_name]
            lines.insert(at, text)
            # 插入后后续行号整体后移，重建索引。
            for key in list(insert_targets):
                if insert_targets[key] > at:
                    insert_targets[key] += 1
            for key in list(has_line):
                if has_line[key] > at:
                    has_line[key] += 1
            insert_targets.pop(visual_name, None)
            changed.append({"位置": f"视觉设定.md · {visual_name}", "动作": "新增"})

    if write and changed:
        doc.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"changed": changed, "count": len(changed)}


def apply_motion(episode_dir: Path, roll_lines: List[Dict[str, Any]], cast: Dict[str, Dict[str, str]], by_scene: Dict[str, List[str]], write: bool) -> Dict[str, Any]:
    """在《视频提示词.md》的 MOTION 条目加/更新参考音频行。"""
    doc = episode_dir / "视频提示词.md"
    if not doc.is_file():
        raise SystemExit(f"找不到视频提示词：{doc}")
    lines = read_text(doc).splitlines()

    # 先按 MOTION 归拢：每个镜头绑哪些人物的音色。
    binding: Dict[str, List[Tuple[str, str, str]]] = {}
    for line in roll_lines:
        speaker = line["fields"].get("说话人", "").strip()
        motion = line_to_motion(line, by_scene)
        if not speaker or not motion:
            continue
        record = cast.get(speaker, {})
        detail = split_voice_detail(record.get("声音参考", ""))
        if not detail:
            continue
        visual_name = record.get("别名_visual") or speaker
        binding.setdefault(motion, [])
        if not any(item[0] == visual_name for item in binding[motion]):
            binding[motion].append((visual_name, detail["path"], detail["may"]))

    # 走文档，在每个 MOTION 条目里插入/更新参考音频行。
    changed: List[Dict[str, str]] = []
    insert_targets: Dict[str, int] = {}
    existing: Dict[str, int] = {}
    current: Optional[str] = None
    for index, raw in enumerate(lines):
        heading = MOTION_HEADING.match(raw.strip())
        if heading:
            current = heading.group("id")
            insert_targets[current] = index + 1
            continue
        if current is None or (raw.strip().startswith("## ") and not heading):
            current = None
            continue
        if AUDIO_REF_LINE.match(raw):
            existing[current] = index
            insert_targets.pop(current, None)
            continue
        field = FIELD_LINE.match(raw)
        if field and field.group("key").strip() == "输入参考图":
            insert_targets[current] = index + 1
            continue

    for motion, items in binding.items():
        parts = []
        for order, (name, path, may) in enumerate(items, start=1):
            parts.append(
                f"{slot_for(name)}（顺序：{order}）· {path}《{name}的音色》"
                f"（用途：音色；角色：{name}；控制：{may}；不得控制：{AUDIO_MUST_NOT}）"
            )
        text = "- 参考音频：" + "；".join(parts)
        if motion in existing:
            lines[existing[motion]] = text
            changed.append({"位置": f"视频提示词.md · {motion}", "动作": "更新", "绑定": len(items)})
        elif motion in insert_targets:
            lines.insert(insert_targets[motion], text)
            for key in insert_targets:
                if insert_targets[key] > insert_targets[motion]:
                    insert_targets[key] += 1
            if motion in existing:
                existing[motion] += 1
            insert_targets.pop(motion, None)
            changed.append({"位置": f"视频提示词.md · {motion}", "动作": "新增", "绑定": len(items)})
        else:
            changed.append({"位置": f"视频提示词.md · {motion}", "动作": "跳过（找不到条目）", "绑定": 0})

    if write and changed:
        doc.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"changed": changed, "count": len(changed)}


def main() -> int:
    parser = argparse.ArgumentParser(description="把配音本的音色参考回写到视觉设定与视频提示词（默认只出计划）")
    parser.add_argument("project", help="项目根目录，或直接指定剧集目录")
    parser.add_argument("--episode", help="剧集目录名，如 EP001；省略时取第一个")
    parser.add_argument("--write", action="store_true", help="真正落盘；省略时只显示将要做的改动")
    parser.add_argument("--pretty", action="store_true", help="格式化输出")
    args = parser.parse_args()

    root = Path(args.project).expanduser()
    if not root.is_dir():
        raise SystemExit(f"目录不存在：{root}")
    episode_dir = find_episode_dir(root.resolve(), args.episode)

    roll_doc = episode_dir / "配音本.md"
    if not roll_doc.is_file():
        raise SystemExit(f"找不到配音本：{roll_doc}")
    markdown = read_text(roll_doc)
    raw_cast = parse_roll_cast(markdown)
    roll_lines = parse_roll_lines(markdown)

    # 用 voice_plan 的对齐逻辑把别名解析出来，供回写使用。
    plan = build_plan(episode_dir)
    visual_of = {item["speaker"]: item.get("visual_entry") for item in plan["cast"]}
    cast: Dict[str, Dict[str, str]] = {}
    for speaker, record in raw_cast.items():
        merged = dict(record)
        merged["别名_visual"] = visual_of.get(speaker) or record.get("别名") or speaker
        cast[speaker] = merged

    by_scene = scene_to_motions(episode_dir)
    visual_result = apply_visual(episode_dir, cast, args.write)
    motion_result = apply_motion(episode_dir, roll_lines, cast, by_scene, args.write)

    report = {
        "剧集": episode_dir.name,
        "模式": "写入" if args.write else "计划（--write 才落盘）",
        "视觉设定改动": visual_result["changed"],
        "视频提示词改动": motion_result["changed"],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None))
    if not args.write:
        print("以上是计划；确认无误后加 --write 落盘", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
