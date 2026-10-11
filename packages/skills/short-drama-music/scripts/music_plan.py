#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按分镜的情绪线索列出候选配乐乐段。

读 `分镜.md` 的镜头目的与 `视频提示词.md` 的镜头时长，按场次和情绪转折点切出候选乐段：
  - 每个候选乐段覆盖哪些镜头
  - 建议时长（覆盖镜头时长之和，向上取到 5 秒整数倍并留余量）
  - 该段的情绪线索（取自镜头目的字段）

本脚本只读文档、只输出候选划分，不写文件、不调用供应商、不碰画布。
乐段边界是艺术判断，这里的划分只是初稿，最终由创作者定。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

EPISODE_DIR = re.compile(r"^EP\d+$", re.IGNORECASE)
ENTRY_HEADING = re.compile(r"^##\s+(?P<id>(?:IMG|SHOT|MOTION)-[A-Za-z0-9-]+)\s*(?:·\s*(?P<title>.*))?$")
FIELD = re.compile(r"^-\s*(?P<key>[^：:]+)[：:]\s*(?P<value>.*)$")
SCENE_TOKEN = re.compile(r"EP\d+-SC\d+")
DURATION = re.compile(r"(\d+(?:\.\d+)?)\s*s\b")
DIALOGUE_HINT = re.compile(r"对话|台词|交谈|商议|对白")

# 情绪转折的提示词：镜头目的里出现这些词，说明这里可能是一个乐段边界。
# 只收真正指示「情绪换了」的词。像「第一次」「开始」这类词常出现在铺垫镜里，
# 加上会把乐段切得比情绪变化更碎——一段乐跨几个镜头本来就该是常态。
TURN_HINTS = (
    "转折", "转向", "转为", "落差", "对照面", "揭秘", "揭示", "反转",
    "落点", "破口",
)
CALM_HINTS = ("如常", "松弛", "轻松", "温和", "安然", "平静")

# 时长对齐：音乐节点的 maxDuration 步长 5 秒；留 15% 余量供剪辑裁切。
DURATION_STEP = 5
DURATION_MARGIN = 1.15
MIN_DURATION = 10


def read_text(path: Path) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"无法解码文件：{path}")


def find_episode_dir(root: Path, episode: Optional[str]) -> Path:
    if (root / "分镜.md").is_file():
        return root
    candidates: List[Path] = []
    for base in (root / "剧集", root / "episodes", root):
        if not base.is_dir():
            continue
        for child in sorted(base.iterdir()):
            if child.is_dir() and (EPISODE_DIR.match(child.name) or (child / "分镜.md").is_file()):
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


def parse_entries(markdown: str) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for raw in markdown.splitlines():
        line = raw.strip()
        heading = ENTRY_HEADING.match(line)
        if heading:
            if current is not None:
                entries.append(current)
            current = {"id": heading.group("id"), "title": (heading.group("title") or "").strip(), "fields": {}}
            continue
        if current is None:
            continue
        field = FIELD.match(line)
        if field:
            current["fields"][field.group("key").strip()] = field.group("value").strip()
    if current is not None:
        entries.append(current)
    return entries


def parse_duration(value: Optional[str]) -> float:
    if not value:
        return 0.0
    matched = DURATION.search(value)
    return float(matched.group(1)) if matched else 0.0


def shot_scenes(episode_dir: Path) -> Dict[str, str]:
    shot_doc = episode_dir / "分镜.md"
    if not shot_doc.is_file():
        return {}
    result: Dict[str, str] = {}
    for entry in parse_entries(read_text(shot_doc)):
        matched = SCENE_TOKEN.search(entry["fields"].get("来源", ""))
        if matched:
            result[entry["id"]] = matched.group(0)
    return result


def build_shots(episode_dir: Path) -> List[Dict[str, Any]]:
    """取镜头序列：以分镜为主，补上视频提示词的时长与分镜指向。"""
    shot_doc = episode_dir / "分镜.md"
    if not shot_doc.is_file():
        raise SystemExit(f"找不到分镜：{shot_doc}")
    shots: List[Dict[str, Any]] = []
    for entry in parse_entries(read_text(shot_doc)):
        matched = SCENE_TOKEN.search(entry["fields"].get("来源", ""))
        shots.append({
            "id": entry["id"],
            "title": entry["title"],
            "scene": matched.group(0) if matched else "",
            "purpose": entry["fields"].get("目的", ""),
            "duration": parse_duration(entry["fields"].get("时长")),
            "sound": entry["fields"].get("声音", ""),
        })
    return shots


def motion_shots(episode_dir: Path) -> Dict[str, Dict[str, Any]]:
    """MOTION 到 SHOT 的映射与它自己的时长。"""
    motion_doc = episode_dir / "视频提示词.md"
    if not motion_doc.is_file():
        return {}
    result: Dict[str, Dict[str, Any]] = {}
    for entry in parse_entries(read_text(motion_doc)):
        result[entry["id"]] = {
            "shot": entry["fields"].get("分镜", "").strip(),
            "duration": parse_duration(entry["fields"].get("时长")),
        }
    return result


def is_turn(prev: Optional[Dict[str, Any]], current: Dict[str, Any]) -> Optional[str]:
    """判断这里是否为乐段边界，返回原因。"""
    if prev is None:
        return "全集开始"
    if prev["scene"] != current["scene"]:
        return f"场次切换 {prev['scene']} → {current['scene']}"
    purpose = current.get("purpose", "")
    for hint in TURN_HINTS:
        if hint in purpose:
            return f"情绪转折（{hint}）"
    prev_calm = any(hint in prev.get("purpose", "") for hint in CALM_HINTS)
    now_calm = any(hint in purpose for hint in CALM_HINTS)
    if prev_calm != now_calm:
        return "情绪转向（松弛 ↔ 紧张）"
    return None


def suggest_duration(seconds: float) -> int:
    if seconds <= 0:
        return MIN_DURATION
    target = seconds * DURATION_MARGIN
    aligned = int(round(target / DURATION_STEP) * DURATION_STEP)
    return max(MIN_DURATION, aligned)


def build_plan(episode_dir: Path) -> Dict[str, Any]:
    shots = build_shots(episode_dir)
    motions = motion_shots(episode_dir)
    by_shot = {item["id"]: item for item in shots}

    # 把 MOTION 按分镜顺序挂到 SHOT 上；没有 MOTION 的镜头不进乐段（还没建视频提示词）。
    segments: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for motion_id in sorted(motions):
        info = motions[motion_id]
        shot = by_shot.get(info["shot"])
        if shot is None:
            continue
        shot = dict(shot)
        shot["motion"] = motion_id
        shot["duration"] = info["duration"] or shot["duration"]
        reason = is_turn(current["shots"][-1] if current and current["shots"] else None, shot)
        if current is None or reason:
            if current is not None:
                segments.append(current)
            current = {"shots": [], "reasons": [], "boundary": reason}
        if reason and current["shots"]:
            current["reasons"].append(reason)
        current["shots"].append(shot)
    if current is not None:
        segments.append(current)

    result: List[Dict[str, Any]] = []
    for index, segment in enumerate(segments, start=1):
        shots_in = segment["shots"]
        total = sum(item["duration"] for item in shots_in)
        dialogue_heavy = any(DIALOGUE_HINT.search(item.get("purpose", "") + item.get("sound", [])) for item in shots_in)
        motions_in = sorted({item["motion"] for item in shots_in})
        result.append({
            "seg_key": f"MUSIC-{episode_dir.name}-{index:02d}",
            "scene": shots_in[0]["scene"] if shots_in else "",
            "motions": motions_in,
            "motion_range": f"{motions_in[0]} ~ {motions_in[-1]}" if len(motions_in) > 1 else (motions_in[0] if motions_in else ""),
            "shot_count": len(shots_in),
            "raw_seconds": round(total, 2),
            "suggested_duration": suggest_duration(total),
            "boundary_reason": segment["boundary"],
            "inner_turns": segment["reasons"],
            "purposes": [{"motion": item["motion"], "purpose": item["purpose"]} for item in shots_in],
            "dialogue_heavy": dialogue_heavy,
            "titles": [item["title"] for item in shots_in],
        })

    stats = {
        "episode": episode_dir.name,
        "shots_total": len(shots),
        "motions_total": len(motions),
        "segments": len(result),
        "total_seconds": round(sum(item["raw_seconds"] for item in result), 2),
        "suggested_seconds": sum(item["suggested_duration"] for item in result),
        "review_exists": (episode_dir / "配乐本.md").is_file(),
        "shots_without_motion": [item["id"] for item in shots
                                 if not any(m["shot"] == item["id"] for m in motions.values())],
    }
    return {"stats": stats, "segments": result}


def main() -> int:
    parser = argparse.ArgumentParser(description="按分镜给出候选配乐乐段（只读，不写文件）")
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
    print(f"提示：{stats['segments']} 个候选乐段，覆盖 {stats['motions_total']} 个镜头；"
          "边界只是初稿，最终由创作者定", file=sys.stderr)
    if stats["shots_without_motion"]:
        print(f"提示：{len(stats['shots_without_motion'])} 个镜头还没有视频提示词，暂不参与配乐："
              f"{stats['shots_without_motion'][:6]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
