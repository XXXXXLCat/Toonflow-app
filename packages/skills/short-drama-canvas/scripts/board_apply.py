#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把画布施工计划导出成一份可导入的画布文件。

一次性建好整集的节点与连线，避免逐个调用画布工具。产出是独立的新画布文件，
不修改任何正在打开的画布；用户主动导入后再由画布正常运行节点逻辑。

参考接线：消费节点的「输入参考」里已落地的图片与视频槽位会接进它的 in 端口——
图片（REF-IMG-*）连到同名资产节点；视频（REF-VIDEO-*）是创作时已有的外部文件，
为它建一个视频参考源节点、把文件预置进节点输出，再连到消费节点的 in 端口
（画布导入时 useNode 会从 node.data.outputs 水合出 VIDEO 输出），作为图生视频的
参考片段。音频槽位（REF-VOICE-*）是人物的**基础音色**文件（用途：音色），只引导
对白生成、并约束视频模型的音色，不是该镜的音频轨——它不在此处并到 MOTION 的 in，
而由 short-drama-voice 的 voice_apply 接进对白生成节点的 in、由 producer 经
REF-VOICE- 槽位绑成 reference_audio。--structure-only 时参考连线全部跳过。

用法：
  python3 board_apply.py <project> --episode EP001 --out EP001.canvas.json
  python3 board_apply.py <project> --episode EP001 --out EP001.canvas.json --structure-only
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_plan import build_plan, find_episode_dir  # noqa: E402

# 节点类型名与端口，随实际安装的节点包变化；改这里即可对接别的节点实现。
NODE_TYPES = {"image": "remote-comfyuiImageNode", "video": "remote-comfyuiVideoNode", "audio": "remote-comfyuiAudioNode"}
SOURCE_HANDLES = {"image": "image", "video": "video", "audio": "audio"}
TARGET_HANDLE = "in"

COLUMN_X = {"asset": 0, "keyframe": 900, "motion": 1800}
COLUMN_GAP = 620
NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")

# 参考源节点：视频参考是创作时已有的外部文件，建一个视频源节点、把文件预置进
# 它的输出（画布导入时 useNode 会从 node.data.outputs 水合），再连到消费节点的 in 端口，
# 作为图生视频的参考片段。REF-VOICE-（基础音色）不在此建节点——它引导对白生成、
# 约束视频模型音色，不是该镜音频轨，由 voice_apply / producer 处理（见模块说明）。
REFERENCE_SOURCE_TYPE = {"video": "remote-comfyuiVideoNode"}
REFERENCE_COLUMN_X = 1200
REFERENCE_GAP = 360
MIME_BY_SUFFIX = {
    "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
    "mkv": "video/x-matroska", "m4v": "video/mp4", "avi": "video/x-msvideo",
    "wav": "audio/wav", "mp3": "audio/mpeg", "m4a": "audio/mp4",
    "aac": "audio/aac", "flac": "audio/flac",
}


def mime_for_path(path: str) -> str:
    suffix = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return MIME_BY_SUFFIX.get(suffix, "application/octet-stream")


def node_id(key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"node:{key}"))


def edge_id(source: str, target: str, reason: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"edge:{source}->{target}:{reason}"))


def build_payload(plan: Dict[str, Any], include_references: bool) -> Dict[str, Any]:
    counters = {"asset": 0, "keyframe": 0, "motion": 0}
    nodes: List[Dict[str, Any]] = []

    for node in plan["nodes"]:
        role = node["role"]
        column = COLUMN_X[role]
        position = {"x": column, "y": counters[role] * COLUMN_GAP}
        counters[role] += 1

        data: Dict[str, Any] = {"label": f"{node['key']} · {node['title']}".rstrip(" ·"), "prompt": node["prompt"]}
        if node["kind"] == "image":
            data["model"] = ""
            data["promptModel"] = []
            data["ratio"] = node.get("ratio") or "自适应"
            data["megapixels"] = "1"
            # 这里的 prompt 是 board_plan 从《图片提示词.md》的「可复制提示词」下原样抽出的成品正文，
            # 再经重写器扩写等于把定稿重写一遍：白跑一次语言模型，还可能改动措辞；
            # 「制作资产」那类逐字写死的版式结构被改写就会直接废掉版式。
            data["rewritePrompt"] = False
        else:
            data["model"] = ""
            data["promptModel"] = []
            data["ratio"] = node.get("ratio") or "16:9"
            data["resolution"] = ""
            data["mode"] = ""
            data["generateAudio"] = True
            data["megapixels"] = "0.9"
            # 同理：视频正文也是写好的成品，不再交给重写器。
            data["rewritePrompt"] = False
            data["turbo"] = True
            if node.get("duration"):
                data["duration"] = node["duration"]

        nodes.append({
            "id": node_id(node["key"]),
            "type": NODE_TYPES[node["kind"]],
            "position": position,
            "data": data,
        })

    edges: List[Dict[str, Any]] = []
    kinds_by_key = {n["key"]: n["kind"] for n in plan["nodes"]}
    for edge in plan["edges"]:
        if edge["reason"] == "图片提示词项" and not include_references:
            continue
        edges.append({
            "id": edge_id(edge["from"], edge["to"], edge["reason"]),
            "source": node_id(edge["from"]),
            "sourceHandle": SOURCE_HANDLES[kinds_by_key[edge["from"]]],
            "target": node_id(edge["to"]),
            "targetHandle": TARGET_HANDLE,
        })

    # 参考性连线：把「输入参考」里的真实文件接进消费节点的 in 端口。
    # 图片类（REF-IMG-*）连到同名资产节点；视频类（REF-VIDEO-）建参考源节点预置文件输出再连入。
    # 音频类（REF-VOICE-）是人物基础音色，跳过——它引导对白生成、不是该镜音频轨，由
    # voice_apply / producer 处理。--structure-only 时跳过视频参考源（与图片提示词项同样受门控）。
    ref_nodes: List[Dict[str, Any]] = []
    ref_edges: List[Dict[str, Any]] = []
    ref_counter = 0
    existing_pairs = {(e["from"], e["to"]) for e in plan["edges"]}
    node_keys = {n["key"] for n in plan["nodes"]}
    for node in plan["nodes"]:
        slots = node.get("reference_slots") or []
        if not slots:
            continue
        consumer_id = node_id(node["key"])
        for slot in slots:
            # --structure-only 时只连分镜等结构性关系，参考连线（含图片/视频/音频）全部留到资产产出后补。
            if not include_references:
                break
            media = slot["media"]
            if media == "image":
                # 已落地的 REF-IMG-* 才有真实资产节点；挂图计划（PLAN-）没有实体，跳过。
                asset_key = slot["id"]
                for prefix in ("REF-", "PLAN-"):
                    if asset_key.startswith(prefix):
                        asset_key = asset_key[len(prefix):]
                        break
                if asset_key in node_keys and (asset_key, node["key"]) not in existing_pairs:
                    ref_edges.append({
                        "id": edge_id(asset_key, node["key"], "参考"),
                        "source": node_id(asset_key),
                        "sourceHandle": SOURCE_HANDLES["image"],
                        "target": consumer_id,
                        "targetHandle": TARGET_HANDLE,
                    })
                    existing_pairs.add((asset_key, node["key"]))
                continue
            if media == "audio":
                # REF-VOICE- 是人物基础音色（用途：音色）：引导对白生成、约束视频模型音色，
                # 不是该镜音频轨。并到 MOTION 的 in 会被当成成片音轨，与「参考音频不能直接充当
                # 成品音轨」冲突。基础音色由 voice_apply 接进对白生成节点的 in、由 producer 经
                # REF-VOICE- 绑成 reference_audio；此处不并到 MOTION。
                continue
            # 视频：创作时已有的外部文件，建参考源节点、把文件预置进输出再连入。
            src_type = REFERENCE_SOURCE_TYPE[media]
            src_key = f"REFNODE-{node['key']}-{slot['id']}"
            src_id = node_id(src_key)
            path = slot["locator"].strip()
            data: Dict[str, Any] = {"label": f"{slot['id']} · {node['key']}"}
            data.update({
                "prompt": "", "model": "", "ratio": node.get("ratio") or "16:9",
                "resolution": "", "mode": "", "generateAudio": True,
                "megapixels": "0.9", "rewritePrompt": False, "turbo": True,
            })
            data["outputs"] = {media: {"dataType": media.upper(), "value": {"url": path, "mimeType": mime_for_path(path)}}}
            ref_nodes.append({
                "id": src_id,
                "type": src_type,
                "position": {"x": REFERENCE_COLUMN_X, "y": ref_counter * REFERENCE_GAP},
                "data": data,
            })
            ref_counter += 1
            ref_edges.append({
                "id": edge_id(src_key, node["key"], "参考"),
                "source": src_id,
                "sourceHandle": SOURCE_HANDLES[media],
                "target": consumer_id,
                "targetHandle": TARGET_HANDLE,
            })

    nodes.extend(ref_nodes)
    edges.extend(ref_edges)

    return {
        "toonflowCanvas": True,
        "nodes": nodes,
        "edges": edges,
        "viewport": {"x": -100, "y": -100, "zoom": 0.3},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="把短剧项目的创作文档导出成画布文件（只读文档，不碰已有画布）")
    parser.add_argument("project", help="项目根目录，或直接指定剧集目录")
    parser.add_argument("--episode", help="剧集目录名，如 EP001；省略时取第一个")
    parser.add_argument("--out", required=True, help="输出画布文件路径")
    parser.add_argument("--structure-only", action="store_true",
                        help="只连结构性关系（分镜）；省略时连上资产图的参考关系")
    args = parser.parse_args()

    root = Path(args.project).expanduser()
    if not root.is_dir():
        raise SystemExit(f"目录不存在：{root}")
    episode_dir = find_episode_dir(root.resolve(), args.episode)
    plan = build_plan(episode_dir)

    stats = plan["stats"]
    if stats["dangling_items"] or stats["empty_prompts"]:
        print("计划不完整，先回对应 owner 修文档：", file=sys.stderr)
        if stats["dangling_items"]:
            print(f"  引用了不存在的条目：{stats['dangling_items']}", file=sys.stderr)
        if stats["empty_prompts"]:
            print(f"  缺可复制提示词：{stats['empty_prompts']}", file=sys.stderr)
        return 2

    payload = build_payload(plan, include_references=not args.structure_only)
    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    kinds: Dict[str, int] = {}
    for node in payload["nodes"]:
        kinds[node["type"]] = kinds.get(node["type"], 0) + 1
    print(json.dumps({
        "画布文件": str(out),
        "剧集": episode_dir.name,
        "节点数": len(payload["nodes"]),
        "节点构成": kinds,
        "连线数": len(payload["edges"]),
        "连线范围": "结构性 + 参考" if not args.structure_only else "仅结构性",
        "画幅": stats["aspect_ratio"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
