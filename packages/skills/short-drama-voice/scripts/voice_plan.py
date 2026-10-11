#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""扫短剧剧本，列出需要配音的人物与他们的每一句对白。

只读 `剧本.md` 与已有的《配音本.md》《视觉设定.md`，输出结构化配音计划：
  - 谁开口说话了（需要配音）
  - 每人几句、分别在哪些场景
  - 每句的台词原文与剧本已有的表演括注
  - 哪些句还缺语气方向、哪些人物还缺音色参考

本脚本只读文档、只输出计划，不写任何文件、不调用供应商、不碰画布。

台词格式（来自 $short-drama-write 的约定）：
    角色（可选表演提示）：台词
行首带 [VO] / [OS] / [SFX] 等生产标签的行单独处理。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

EPISODE_DIR = re.compile(r"^EP\d+$", re.IGNORECASE)
SCENE_HEADING = re.compile(r"^##\s+(?P<id>EP\d+-SC\d+)\s*(?P<title>.*)$")
# 对白：行首是人名，可带一层括号表演提示，冒号后是台词。
# 冒号必须是全角或半角冒号，且台词非空；括号里不能有冒号，避免把动作叙述误判成对白。
DIALOGUE = re.compile(
    r"^(?P<speaker>[^\s：:（）()\[\]]{1,12})"
    r"(?:\s*[（(](?P<direction>[^：:（）()]{1,40})[）)])?"
    r"\s*[：:]\s*(?P<line>.+?)\s*$"
)
PRODUCTION_TAG = re.compile(r"^\[(?P<tag>VO|OS|SFX|画面文字|连续性|转场)\]\s*(?P<body>.*)$")
QUOTE_NOTE = re.compile(r"^[（(](?P<direction>[^：:（）()]{1,40})[）)]")

CHARACTER_SECTION = re.compile(r"^##\s+人物\s*·\s*(?P<name>.+?)\s*$")
FIELD = re.compile(r"^-\s*(?P<key>[^：:]+)[：:]\s*(?P<value>.*)$")
# 配音本可用「- 别名：卢修斯、Lucius」把剧本简称对到视觉设定的全名条目。
ALIAS_FIELD = "别名"

# 不是说话人的行首词：场景标题、道具、动作主体等常见误判来源。
NON_SPEAKER = {
    "旁白", "字幕", "画外音", "镜头", "画面", "场", "场景", "地点", "时间",
    "备注", "道具", "音效", "配乐", "转场", "连续性", "说明", "注",
}


def read_text(path: Path) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"无法解码文件：{path}")


def find_episode_dir(root: Path, episode: Optional[str]) -> Path:
    if (root / "剧本.md").is_file():
        return root
    candidates: List[Path] = []
    for base in (root / "剧集", root / "episodes", root):
        if not base.is_dir():
            continue
        for child in sorted(base.iterdir()):
            if child.is_dir() and (EPISODE_DIR.match(child.name) or (child / "剧本.md").is_file()):
                candidates.append(child)
    if episode:
        wanted = episode.upper()
        for candidate in candidates:
            if candidate.name.upper() == wanted:
                return candidate
        raise SystemExit(f"找不到剧集目录：{episode}")
    if not candidates:
        raise SystemExit(f"在 {root} 下找不到任何剧集目录")
    return candidates[0]


def parse_dialogue(markdown: str) -> List[Dict[str, Any]]:
    """逐行取对白，保留场次上下文与剧本自带的表演括注。"""
    items: List[Dict[str, Any]] = []
    scene_id = ""
    scene_title = ""
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line:
            continue
        scene = SCENE_HEADING.match(line)
        if scene:
            scene_id = scene.group("id")
            scene_title = scene.group("title").strip(" ·")
            continue
        if line.startswith("#") or line.startswith(">"):
            continue
        tag = PRODUCTION_TAG.match(line)
        if tag:
            # [VO]/[OS] 后面常直接跟台词，但本技能不负责生产标签的语义归属，跳过即可。
            continue
        matched = DIALOGUE.match(line)
        if not matched:
            continue
        speaker = matched.group("speaker").strip()
        if speaker in NON_SPEAKER or speaker.startswith("["):
            continue
        # 「他：」这类指代不到位的人名留给创作者确认，但如实列出而不是丢掉。
        items.append({
            "speaker": speaker,
            "direction": (matched.group("direction") or "").strip(),
            "line": matched.group("line").strip(),
            "scene": scene_id,
            "scene_title": scene_title,
        })
    return items


def read_voice_cast(episode_dir: Path) -> Dict[str, Dict[str, str]]:
    """读配音本里已经定好的人物声音方向，用来判断谁还缺音色。"""
    roll = episode_dir / "配音本.md"
    if not roll.is_file():
        return {}
    cast: Dict[str, Dict[str, str]] = {}
    current: Optional[str] = None
    for raw in read_text(roll).splitlines():
        section = CHARACTER_SECTION.match(raw.strip())
        if section:
            current = section.group("name").strip()
            cast[current] = {}
            continue
        if current is None:
            continue
        field = FIELD.match(raw.strip())
        if field:
            cast[current][field.group("key").strip()] = field.group("value").strip()
    return cast


def read_visual_voices(episode_dir: Path) -> Dict[str, Dict[str, str]]:
    """读《视觉设定.md》里人物条目的声音方向，作为音色参考的既有来源。"""
    setting = episode_dir / "视觉设定.md"
    if not setting.is_file():
        return {}
    cast: Dict[str, Dict[str, str]] = {}
    current: Optional[str] = None
    for raw in read_text(setting).splitlines():
        section = CHARACTER_SECTION.match(raw.strip())
        if section:
            current = section.group("name").strip()
            cast[current] = {}
            continue
        if current is None:
            continue
        field = FIELD.match(raw.strip())
        if field:
            key = field.group("key").strip()
            if key in ("声音参考", "选型判据", "对比角色", "专名发音"):
                cast[current][key] = field.group("value").strip()
    return cast


def match_visual_entry(speaker: str, visual: Dict[str, Dict[str, str]]) -> Optional[str]:
    """把剧本里的说话人名字对到视觉设定的人物条目。

    剧本惯用简称（`卢修斯`），视觉设定惯用全名（`卢修斯·瓦伦丁`）。对不上时不做猜测，
    如实报出，让创作者在配音本里补一行「别名」。
    """
    if speaker in visual:
        return speaker
    # 简称是全名前缀（去掉「·姓氏」）时视为同一人；这一条覆盖中西名混排的写法。
    for name in visual:
        short, _, _ = name.partition("·")
        if short and short == speaker:
            return name
        if name.startswith(speaker) or speaker.startswith(name):
            return name
    return None


def existing_lines(episode_dir: Path) -> Dict[str, List[str]]:
    """读配音本里已写的 LINE 条目，标出仍然缺语气或缺朗读文本的那些。"""
    roll = episode_dir / "配音本.md"
    if not roll.is_file():
        return {}
    done: Dict[str, List[str]] = {}
    current: Optional[str] = None
    for raw in read_text(roll).splitlines():
        line = raw.strip()
        if line.startswith("## 人物"):
            current = line.split("·", 1)[-1].strip()
            continue
        if current is None:
            continue
        if line.startswith("- 语气：") or line.startswith("- 朗读文本："):
            if line.endswith("：") or not line.split("：", 1)[1].strip():
                continue
            done.setdefault(current, []).append(line)
    return done


def build_plan(episode_dir: Path) -> Dict[str, Any]:
    script = episode_dir / "剧本.md"
    if not script.is_file():
        raise SystemExit(f"找不到剧本：{script}")
    dialogue = parse_dialogue(read_text(script))
    roll = read_voice_cast(episode_dir)
    visual = read_visual_voices(episode_dir)

    by_speaker: Dict[str, List[Dict[str, Any]]] = {}
    for item in dialogue:
        by_speaker.setdefault(item["speaker"], []).append(item)

    cast: List[Dict[str, Any]] = []
    matched_visual: set[str] = set()
    for speaker in sorted(by_speaker, key=lambda name: (-len(by_speaker[name]), name)):
        lines = by_speaker[speaker]
        record = roll.get(speaker, {})
        # 别名优先：配音本里显式写的对得上就用它，其次按简称/全名规则匹配。
        alias = record.get(ALIAS_FIELD, "").strip()
        visual_name = alias or match_visual_entry(speaker, visual)
        voice = visual.get(visual_name, {}) if visual_name else {}
        if visual_name:
            matched_visual.add(visual_name)
        reference = record.get("声音参考") or voice.get("声音参考") or ""
        instruction = record.get("语音指令", "")
        reference_text = record.get("参考文本", "")
        missing: List[str] = []
        if not reference or reference.startswith("待选型"):
            missing.append("声音参考")
        if not instruction:
            missing.append("语音指令")
        if not reference_text:
            missing.append("参考文本")
        cast.append({
            "speaker": speaker,
            "visual_entry": visual_name,
            "lines": len(lines),
            "scenes": sorted({item["scene"] for item in lines if item["scene"]}),
            "has_voice_reference": bool(reference) and not reference.startswith("待选型"),
            "voice_reference": reference,
            "missing_voice_fields": missing,
            "line_items": lines,
        })

    # 只有剧本里明确的人物条目才算「无声人物」；对不上的是名字没对齐，单独报。
    silent = sorted(name for name in visual if name not in matched_visual)
    unmatched = sorted(item["speaker"] for item in cast if not item["visual_entry"])

    stats = {
        "episode": episode_dir.name,
        "speakers": len(cast),
        "lines": len(dialogue),
        "cast_without_voice": [item["speaker"] for item in cast if item["missing_voice_fields"]],
        "unmatched_speakers": unmatched,
        "visual_entries_without_lines": silent,
        "scenes": sorted({item["scene"] for item in dialogue if item["scene"]}),
        "roll_exists": (episode_dir / "配音本.md").is_file(),
    }
    return {"stats": stats, "cast": cast}


def main() -> int:
    parser = argparse.ArgumentParser(description="扫剧本出配音计划（只读，不写文件）")
    parser.add_argument("project", help="项目根目录，或直接指定剧集目录")
    parser.add_argument("--episode", help="剧集目录名，如 EP001；省略时取第一个")
    parser.add_argument("--pretty", action="store_true", help="格式化输出，便于人工核对")
    args = parser.parse_args()

    root = Path(args.project).expanduser()
    if not root.is_dir():
        raise SystemExit(f"目录不存在：{root}")
    episode_dir = find_episode_dir(root.resolve(), args.episode)
    plan = build_plan(episode_dir)
    print(json.dumps(plan, ensure_ascii=False, indent=2 if args.pretty else None))

    stats = plan["stats"]
    if not stats["roll_exists"]:
        print("提示：还没有《配音本.md》，本集尚未定音色", file=sys.stderr)
    if stats["cast_without_voice"]:
        print(f"警告：{len(stats['cast_without_voice'])} 个人物还缺音色字段：{stats['cast_without_voice']}",
              file=sys.stderr)
    if stats["unmatched_speakers"]:
        print(f"警告：说话人没对上视觉设定条目，需在配音本补「别名」：{stats['unmatched_speakers']}",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
