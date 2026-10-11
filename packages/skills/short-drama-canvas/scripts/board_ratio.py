#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读或写短剧项目的成片画幅。

成片画幅住在项目档案 `short-drama.json` 的 `format.aspect_ratio`，是全流程共用的一个值：
关键帧与视频节点按它出图，之后不再逐镜询问。本脚本只做一件事——读它、或改它。

优先在项目初始化时就定好（`project_tool.py init --aspect-ratio`）。本脚本的 --set 是补救路径：
项目已经建好、当时留了 `unset`，或者画幅要变更时用它，避免为此重建项目。

用法：
  python3 board_ratio.py <project>                 # 读当前画幅及来源
  python3 board_ratio.py <project> --set 9:16      # 写入档案
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_plan import RATIO, find_episode_dir, read_profile_ratio, read_visual_ratio  # noqa: E402

PROFILE_NAME = "short-drama.json"
VALID_RATIO = re.compile(r"^\d{1,3}:\d{1,3}$")


def locate_project(start: Path) -> tuple[Path, Optional[Path]]:
    """返回（项目根, 剧集目录）。项目根是含 short-drama.json 的最近上级。"""
    for parent in [start, *start.parents]:
        if not (parent / PROFILE_NAME).is_file():
            continue
        # start 自身就是剧集目录时 find_episode_dir 直接返回它；是项目根时往下找第一集。
        try:
            episode: Optional[Path] = find_episode_dir(start, None)
        except SystemExit:
            episode = None
        return parent, episode
    raise SystemExit(f"向上找不到 {PROFILE_NAME}；请传入项目目录或其下的剧集目录")


def describe(project_root: Path, episode: Optional[Path]) -> Dict[str, Any]:
    profile_ratio, profile_path = read_profile_ratio(project_root)
    visual_ratio = read_visual_ratio(episode) if episode else None
    conflict = None
    if profile_ratio and visual_ratio and profile_ratio != visual_ratio:
        conflict = f"档案 {profile_ratio} 与视觉设定 {visual_ratio} 不一致"
    return {
        "项目": str(project_root),
        "档案": str(profile_path) if profile_path else None,
        "成片画幅": profile_ratio,
        "视觉设定": visual_ratio,
        "冲突": conflict,
        "状态": "已定" if profile_ratio else "未定（先确认画幅再建图）",
    }


def write_ratio(project_root: Path, ratio: str) -> Dict[str, Any]:
    if not VALID_RATIO.match(ratio):
        raise SystemExit(f"画幅格式无效：{ratio}；应形如 9:16、16:9、1:1、4:5")
    profile_path = project_root / PROFILE_NAME
    payload = json.loads(profile_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit("项目档案不是 JSON 对象，未做改动")
    block = payload.get("format")
    if not isinstance(block, dict):
        raise SystemExit("项目档案缺少 format 段，未做改动")
    before = block.get("aspect_ratio")
    block["aspect_ratio"] = ratio
    # 先写临时文件再替换，避免中断留下半个档案。
    temporary = profile_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(profile_path)
    return {"字段": "format.aspect_ratio", "原值": before, "新值": ratio}


def main() -> int:
    parser = argparse.ArgumentParser(description="读或写短剧项目的成片画幅（format.aspect_ratio）")
    parser.add_argument("project", help="项目根目录，或其下的剧集目录")
    parser.add_argument("--set", dest="value", help="写入新画幅，如 9:16")
    args = parser.parse_args()

    start = Path(args.project).expanduser()
    if not start.is_dir():
        raise SystemExit(f"目录不存在：{start}")
    project_root, episode = locate_project(start.resolve())

    if args.value:
        changed = write_ratio(project_root, args.value.strip())
        print(json.dumps(changed, ensure_ascii=False, indent=2))
        print("已写入。视觉设定里的画幅若与它不同，请回对应 owner 统一；")
        print("画布上已有的节点不受影响，需重新导出或按新画幅调 node:setConfig。")
        return 0

    info = describe(project_root, episode)
    print(json.dumps(info, ensure_ascii=False, indent=2))
    if info["冲突"]:
        print(f"警告：{info['冲突']}；建图时以档案为准", file=sys.stderr)
    if not info["成片画幅"]:
        print("提示：成片画幅还没定。先问一次并写入档案，再进画布。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
