#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把画布施工计划导出成一份可导入的画布文件。

一次性建好整集的节点与连线，避免逐个调用画布工具。产出是独立的新画布文件，
不修改任何正在打开的画布；用户主动导入后再由画布正常运行节点逻辑。

参考接线：文档里已写明的参考关系接进消费节点的 in 端口。`PLAN-` 与 `REF-` 两类槽位在
board_plan 里都已按**名字**认到画布上已有的节点、落成同一种「参考槽位」边，这里照常落成；
不为参考文件另建节点——边只表达节点之间的关系，不表达「这个节点当前显示第几次生成的结果」。
名字里认不出条目的项目外素材不会出现在连线里，由 board_plan 报进 `unresolved_references`。

每连上一条参考，目标节点还会拿到两样东西：
  - `data.referenceOrder`：按文档写的 `顺序` 排好的引用键序。画布上的引用编号（`{{ref N}}`）
    由它定，来源与正文里 `<Picture N>` 的编号同一个（都是文档那个 `顺序`）；
  - 附在正文之后的「参考约束」块：逐条编译每条参考的 `用途`/`控制`/`不得控制`，结构与
    `$short-drama-produce` 的编译器一致。少了它，执行端只看到 `<Picture 2>`，不知道
    「这张图允许决定什么、不许决定什么」，参考的越权边界就丢了。
  缺声明的槽位不进约束块，由 board_plan 报进 `incomplete_reference_slots`。

音色不在这一层接：它登记在 MOTION 的「参考音频」行上（VID-27），按行内写的「角色」接到
该人物的对白节点 in，不并到 MOTION 的音频输入；它的约束块进对白节点的 instruction。

时间线音乐章节的乐段建成音乐节点，**不与任何节点连线**——单镜产物不自带配乐音轨，
音乐是时间线层的产出物，供剪辑铺轨。乐段在文档里写了实际歌词（主题曲）就把歌词带进节点，
写「无（纯旋律）」就留空；画布不代写歌词，也不放开供应商代写。
`--structure-only` 时只连结构性边（MOTION 的「分镜」）；图片参考边与音色参考节点都留到
素材产出后补。

成片画幅没定出来（`nodes_without_ratio` 非空）时**拒绝导出**：脚本不替节点假造一个比例，
而节点的默认比例（视频 16:9、图片 1:1）多半不是这个项目的画幅，静默按它出图代价太大。
确认画幅并写入项目档案后再导出；确实要先看节点时用 `--allow-missing-ratio` 显式放行。

用法：
  python3 board_apply.py <project> --episode EP001 --out EP001.canvas.json
  python3 board_apply.py <project> --episode EP001 --out EP001.canvas.json --structure-only
  python3 board_apply.py <project> --episode EP001 --out EP001.canvas.json --allow-missing-ratio
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_plan import MEDIA_ORDER, build_plan, find_episode_dir  # noqa: E402

# 节点类型名与端口，随实际安装的节点包变化；改这里即可对接别的节点实现。
NODE_TYPES = {"image": "remote-comfyuiImageNode", "video": "remote-comfyuiVideoNode",
              "audio": "remote-comfyuiAudioNode", "music": "remote-comfyuiMusicNode"}
SOURCE_HANDLES = {"image": "image", "video": "video", "audio": "audio"}
TARGET_HANDLE = "in"

# 音乐列摆最左：它是时间线层的产出物，不属任何一镜的施工链，所以与其余四列不相邻。
COLUMN_X = {"music": -1800, "asset": 0, "keyframe": 900, "motion": 1800, "dialogue": 2700}
COLUMN_GAP = 620
NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")

# 音色参考源摆在对白列左侧，紧挨着它对白的那个人物。
VOICE_REFERENCE_X = 2340
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


# 参考的语义声明编译成的「参考约束」块，附在正文之后。结构与 `short-drama-produce` 的
# provider_adapters._prompt_with_reference_contract 一致，只是词表用文档原词（`用途`
# 原样写），因为画布节点没有 adapter 那套 role 词表——照抄创作者写的词才不越权。
CONTRACT_HEADING_ZH = "参考约束："
CONTRACT_HEADING_EN = "Reference contract:"
CJK = re.compile(r"[\u3400-\u9fff]")


def reference_key(source_id: str, source_handle: str) -> str:
    """引用条目在节点里的键：`[源节点 id, 源端口]` 的 URL 编码（与 useNodeReferences 一致）。

    节点按 `data.referenceOrder["in"]` 的键序排引用列表，正文里的 `{{ref N}}` 才指向文档
    写了 `顺序：N` 的那一张。
    """
    raw = json.dumps([source_id, source_handle], separators=(",", ":"))
    return quote(raw, safe="!'()*-._~")


def order_key(entry: Dict[str, Any]) -> tuple:
    """引用排序：文档写了 `顺序` 的排前面（按顺序），结构边（没有顺序）排后面。"""
    return (entry["order"] is None, entry["order"] or 0)


def reference_contract(body: str, entries: List[Dict[str, Any]]) -> str:
    """把参考的语义声明编译成「参考约束」块；没有可编译的条目时返回空串。

    每条的编号取文档那条声明自己的 `顺序`——它与正文里 `<Picture N>` 的编号同源。两套编号
    对不上时模型会收到互相矛盾的素材说明，而接口不会报错，所以这里不再另编一套。
    缺 `用途`/`控制`/`不得控制` 的槽位编译不出约束，跳过（board_plan 已把它报成
    `incomplete_reference_slots`）。
    """
    usable = [
        entry for entry in entries
        if entry.get("order") and entry.get("usage")
        and entry.get("may_control") and entry.get("must_not_control")
    ]
    if not usable:
        return ""
    chinese = bool(CJK.search(body or ""))
    lines: List[str] = []
    for entry in sorted(usable, key=order_key):
        name = entry.get("name") or entry.get("slot") or ""
        if entry.get("character"):
            # 音色参考的标签用说话人：正文里说的是「谁的声音」，不认得素材文件名。
            name = f"{entry['character']}音色参考"
        if chinese:
            lines.append(
                f"参考 {entry['order']}（{name}），用途 {entry['usage']}。"
                f"允许控制：{entry['may_control']}。不得控制：{entry['must_not_control']}。"
            )
        else:
            lines.append(
                f"Reference {entry['order']} ({name}), purpose {entry['usage']}. "
                f"May control: {entry['may_control']}. "
                f"Must not control: {entry['must_not_control']}."
            )
    heading = CONTRACT_HEADING_ZH if chinese else CONTRACT_HEADING_EN
    return f"\n\n{heading}\n" + "\n".join(lines)


def node_id(key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"node:{key}"))


def edge_id(source: str, target: str, reason: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"edge:{source}->{target}:{reason}"))


def build_payload(plan: Dict[str, Any], include_references: bool) -> Dict[str, Any]:
    counters = {"music": 0, "asset": 0, "keyframe": 0, "motion": 0, "dialogue": 0}
    nodes: List[Dict[str, Any]] = []
    # 每个节点写进画布的 data，留给后面统一补写引用顺序与「参考约束」。
    data_by_key: Dict[str, Dict[str, Any]] = {}
    # 每个节点 in 端口上挂了哪些引用（含音色）。按文档的「顺序」排好后写进 data.referenceOrder。
    inbound: Dict[str, List[Dict[str, Any]]] = {}

    def record_inbound(target_key: str, entry: Dict[str, Any]) -> None:
        inbound.setdefault(target_key, []).append(entry)

    for node in plan["nodes"]:
        role = node["role"]
        column = COLUMN_X[role]
        position = {"x": column, "y": counters[role] * COLUMN_GAP}
        counters[role] += 1

        # 画外音与画外旁白不是画内对白，标在标签上，免得在画布里和同期声混着看。
        label = f"{node['key']} · {node['title']}".rstrip(" ·")
        channel = node.get("channel") or "sync"
        if channel in ("VO", "OS"):
            label = f"{label} · {channel}"

        # 音乐节点没有提示词正文：它的文本是风格描述，写在《视频提示词.md》的时间线音乐章节里
        # （VID-14）。它不与任何节点连线——单镜产物不自带配乐音轨，音乐供剪辑铺轨。
        if node["kind"] == "music":
            music_data: Dict[str, Any] = {
                "label": label,
                "style": node.get("style") or "",
                # 歌词只在篇章给了实际文本（主题曲）时才带；纯配乐留空。供应商代写歌词一律
                # 拒绝——歌词须创作者提供或明确接受，画布只转抄、不下笔。
                "lyrics": node.get("lyrics") or "",
                "model": "",
                "styleModel": [],
                "lyricsModel": [],
                "format": "mp3",
                "quality": "",
                "seedMode": "random",
                "seedValue": 0,
            }
            # 时长上限只在文档真的给出时才写。定不出来就整个键不写——节点自己有默认值，
            # 画布不替创作者假造一个 60 秒（`stats.music_without_duration` 会报出这一段）。
            if node.get("duration"):
                music_data["maxDuration"] = node["duration"]
            data_by_key[node["key"]] = music_data
            nodes.append({
                "id": node_id(node["key"]),
                "type": NODE_TYPES["music"],
                "position": position,
                "data": music_data,
            })
            continue

        data: Dict[str, Any] = {"label": label, "prompt": node["prompt"]}
        # 成片画幅由项目档案定过一次，条目写了「画幅」就取它。两处都拿不到时整个键不写——
        # 节点自己有默认比例，画布不替创作者假造一个（脚本会在导出后把缺画幅的节点列出来）。
        if node.get("ratio"):
            data["ratio"] = node["ratio"]
        if node["kind"] == "image":
            data["model"] = ""
            data["promptModel"] = []
            data["megapixels"] = "1"
            # 这里的 prompt 是 board_plan 从《图片提示词.md》的「可复制提示词」下原样抽出的成品正文，
            # 再经重写器扩写等于把定稿重写一遍：白跑一次语言模型，还可能改动措辞；
            # 「制作资产」那类逐字写死的版式结构被改写就会直接废掉版式。
            data["rewritePrompt"] = False
        elif node["kind"] == "video":
            data["model"] = ""
            data["promptModel"] = []
            data["resolution"] = ""
            data["mode"] = ""
            data["generateAudio"] = True
            data["megapixels"] = "0.9"
            # 同理：视频正文也是写好的成品，不再交给重写器。
            data["rewritePrompt"] = False
            data["turbo"] = True
            if node.get("duration"):
                data["duration"] = node["duration"]
        else:
            # 对白：待朗读文本已在 prompt 里，instruction 只放表演侧——录音表的 tactic
            # （可执行策略，不是情绪词）与专名发音。音色不在这里决定：它属于视觉设定的
            # 声音参考，创作者在节点上挑定并重生成。
            parts: List[str] = []
            if node.get("tactic"):
                parts.append(str(node["tactic"]).strip())
            for note in node.get("notes") or []:
                surface = str(note.get("surface") or "").strip()
                reading = str(note.get("reading") or "").strip()
                if surface and reading:
                    parts.append(f"{surface}读作{reading}")
            data["instruction"] = "；".join(parts)
            data["model"] = ""
            data["instructionModel"] = []
            data["format"] = "mp3"
            data["quality"] = ""
            data["seedMode"] = "random"
            data["seedValue"] = 0

        data_by_key[node["key"]] = data
        nodes.append({
            "id": node_id(node["key"]),
            "type": NODE_TYPES[node["kind"]],
            "position": position,
            "data": data,
        })

    plan_by_key = {item["key"]: item for item in plan["nodes"]}

    def slot_for(target_key: str, slot_id: str) -> Optional[Dict[str, Any]]:
        """目标节点自己那行声明里的这个槽位——「参考约束」照着它编译。"""
        for candidate in plan_by_key[target_key].get("reference_slots") or []:
            if candidate["id"] == slot_id:
                return candidate
        return None

    edges: List[Dict[str, Any]] = []
    kinds_by_key = {n["key"]: n["kind"] for n in plan["nodes"]}
    for edge in plan["edges"]:
        # 参考类的边（图片提示词项、参考槽位）留到资产图产出后再补，`--structure-only` 时不连。
        if not include_references and edge["reason"] in ("图片提示词项", "参考槽位"):
            continue
        edges.append({
            "id": edge_id(edge["from"], edge["to"], edge["reason"]),
            "source": node_id(edge["from"]),
            "sourceHandle": SOURCE_HANDLES[kinds_by_key[edge["from"]]],
            "target": node_id(edge["to"]),
            "targetHandle": TARGET_HANDLE,
        })
        # 结构边（「图片提示词项」/「分镜」）没有文档顺序，排在声明了顺序的参考之后，也不进
        # 「参考约束」——文档没为它写下用途与控制范围，画布不替它编一段。
        record_inbound(edge["to"], {
            "source_key": edge["from"],
            "source": node_id(edge["from"]),
            "sourceHandle": SOURCE_HANDLES[kinds_by_key[edge["from"]]],
            "order": edge.get("order"),
            "slot": slot_for(edge["to"], edge["slot"]) if edge.get("slot") else None,
        })

    # 参考性连线全部来自 board_plan 的「参考槽位」边：`PLAN-` 与 `REF-` 两类槽位都只按名字
    # 认节点（见 board_plan.resolve_reference_target），上面的循环已经把它们落成边。
    # 这里不为参考文件另建节点——边只表达节点之间的关系，不表达「这个节点当前显示第几次
    # 生成的结果」；名字里认不出条目的项目外素材，由 board_plan 报进 `unresolved_references`，
    # 留创作者自己在画布上挂。

    # 音色：MOTION 的「参考音频」行登记的是人物基础音色（VID-27），按它写的「角色」接到该人物
    # 的对白节点上。它不接 MOTION——接上去会被当成成片音轨，而参考音频不能直接充当成品音轨。
    # 角色名对不上任何对白时只建源节点不连线，留着创作者自己接，不猜。
    # 它也是参考类素材（真实音频文件），`--structure-only` 时与图片参考一起留到素材产出后补。
    by_speaker: Dict[str, List[str]] = {}
    for node in plan["nodes"]:
        if node.get("role") == "dialogue":
            by_speaker.setdefault((node.get("title") or "").strip(), []).append(node["key"])

    voice_nodes: List[Dict[str, Any]] = []
    voice_edges: List[Dict[str, Any]] = []
    if include_references:
        for node in plan["nodes"]:
            for slot in node.get("audio_slots") or []:
                path = (slot.get("locator") or "").strip()
                if not path:
                    continue
                src_key = f"VOICEREF-{slot['slot']}"
                src_id = node_id(src_key)
                voice_nodes.append({
                    "id": src_id,
                    "type": NODE_TYPES["audio"],
                    "position": {"x": VOICE_REFERENCE_X, "y": len(voice_nodes) * REFERENCE_GAP},
                    "data": {
                        "label": f"{slot['id']} · {slot.get('character') or '音色'}",
                        "prompt": "",
                        "instruction": "",
                        "model": "",
                        "instructionModel": [],
                        "format": "mp3",
                        "quality": "",
                        "seedMode": "random",
                        "seedValue": 0,
                        "outputs": {"audio": {"dataType": "AUDIO", "value": {"url": path, "mimeType": mime_for_path(path)}}},
                    },
                })
                for target_key in by_speaker.get((slot.get("character") or "").strip(), []):
                    voice_edges.append({
                        "id": edge_id(src_key, target_key, "音色参考"),
                        "source": src_id,
                        "sourceHandle": SOURCE_HANDLES["audio"],
                        "target": node_id(target_key),
                        "targetHandle": TARGET_HANDLE,
                    })
                    # 音色是挂在对白节点上的参考：编号取「参考音频」行里那个 `顺序`，
                    # 它的语义声明也一并编译进该对白节点的 instruction。
                    record_inbound(target_key, {
                        "source_key": src_key,
                        "source": src_id,
                        "sourceHandle": SOURCE_HANDLES["audio"],
                        "order": slot.get("order"),
                        "slot": slot,
                    })

    nodes.extend(voice_nodes)
    edges.extend(voice_edges)

    # 引用顺序与「参考约束」都等边全部落定后再补：这两件事只看「这一对节点确实连上了」，
    # 与边由哪条规则产生无关。
    for node in plan["nodes"]:
        target_key = node["key"]
        data = data_by_key.get(target_key)
        if data is None:
            continue
        # 画布引用列表的次序：先按文档声明过的参考（`顺序` 递增），再接没进声明的结构边。
        # 形状是 `[源节点 id, 源端口]`；用声明而不是只用连上的边，是为了让 `--structure-only`
        # 与整集导出得到**同一份**引用编号，也让关键帧不会被结构边挤到第一位去。
        connected = sorted(inbound.get(target_key) or [], key=order_key)
        ordered: List[Dict[str, Any]] = []
        seen: set = set()
        for item in sorted(
            node.get("resolved_references") or [],
            key=lambda item: (MEDIA_ORDER.get(item["media"], 9), item["order"]),
        ):
            source_key = item["target"]
            if source_key in seen or source_key not in kinds_by_key:
                continue
            seen.add(source_key)
            ordered.append({
                "source": node_id(source_key),
                "sourceHandle": SOURCE_HANDLES[kinds_by_key[source_key]],
            })
        for item in connected:
            if item["source_key"] in seen:
                continue
            seen.add(item["source_key"])
            ordered.append({"source": item["source"], "sourceHandle": item["sourceHandle"]})
        if ordered:
            data["referenceOrder"] = {
                "in": [reference_key(item["source"], item["sourceHandle"]) for item in ordered]
            }
        # 「参考约束」按**文档的声明**编译，不只按连上的边：声明里的 `顺序` 就是正文
        # `<Picture N>` 的编号，某一张还没挂上时也要照它写——漏掉它会让它后面的编号整体错位，
        # 而接口不会报错，模型只会照着错的编号认素材。音色没有声明槽位，取连上的那条。
        declared_slots = sorted(node.get("reference_slots") or [], key=lambda item: item["order"])
        contract_slots = declared_slots + [
            item["slot"] for item in connected
            if item["slot"] and item["slot"] not in declared_slots
        ]
        contract = reference_contract(
            data.get("prompt") or data.get("instruction") or "", contract_slots
        )
        if not contract:
            continue
        # 对白的参考（音色）属表演侧，进 instruction；画面与视频的进 prompt。
        field = "instruction" if node["kind"] == "audio" else "prompt"
        current = (data.get(field) or "").rstrip()
        data[field] = current + contract if current else contract.lstrip("\n")

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
                        help="只连结构性关系（MOTION 的「分镜」）；省略时连上参考关系与音色参考节点")
    parser.add_argument("--allow-missing-ratio", action="store_true",
                        help="画幅未定时仍然导出（节点沿用自身默认比例）；默认拒绝导出")
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

    # 画幅没定出来就拒绝导出：这是**错值**不是缺值。脚本不写 ratio 时，节点会沿用自身默认为
    # 视频 16:9、图片 1:1，一部别的画幅的片子会整套按错比例出图，而且画布上看不出异样。
    if stats.get("nodes_without_ratio") and not args.allow_missing_ratio:
        print("成片画幅未定，先确认并写入项目档案再导出（画布不替节点假造比例）：", file=sys.stderr)
        print(f"  拿不到画幅的节点：{stats['nodes_without_ratio']}", file=sys.stderr)
        print(f"  取值链：项目档案 format.aspect_ratio → 视觉设定.md；改写用 board_ratio.py --set",
              file=sys.stderr)
        print("  确实要先看节点时加 --allow-missing-ratio，那些节点会沿用自身默认比例。",
              file=sys.stderr)
        return 3

    # 参考没备齐不阻断建图（节点先立起来，素材随后补），但必须说清哪些还不能生成。
    if stats.get("unready_references"):
        print("注意：这些条目的参考图还没备齐，节点照建，但生成前要先补上：", file=sys.stderr)
        for row in stats["unready_references"]:
            gap = "、".join(row["missing"]) or "未点明缺口（先与创作者确认走图生还是文生）"
            print(f"  {row['key']}（{row['state']}；缺口：{gap}）", file=sys.stderr)
    if stats.get("music_without_style"):
        print(f"注意：乐段缺风格描述，节点没有可进模型的文本：{stats['music_without_style']}", file=sys.stderr)
    if stats.get("music_without_duration"):
        print(f"注意：乐段定不出时长上限，节点保留自己的默认值：{stats['music_without_duration']}",
              file=sys.stderr)
    if stats.get("music_lyrics_pending"):
        print(f"注意：乐段的歌词标着待补，节点现在只出纯旋律：{stats['music_lyrics_pending']}",
              file=sys.stderr)
    if stats.get("music_with_lyrics"):
        print(f"注意：这些乐段是主题曲，歌词已随节点送进模型，付费前先核对："
              f"{stats['music_with_lyrics']}", file=sys.stderr)
    if stats.get("incomplete_reference_slots"):
        print("注意：这些参考缺语义声明，编译不出「参考约束」，执行端收不到保留要求："
              "（回上游把用途/控制/不得控制写全）", file=sys.stderr)
        for row in stats["incomplete_reference_slots"]:
            print(f"  {row['key']} → {row['slot']}（缺 {'、'.join(row['missing'])}）", file=sys.stderr)
    if stats.get("reference_over_limit"):
        print("注意：声明的素材数超过目标模型一次生成的上限，建议回分镜阶段取舍：", file=sys.stderr)
        for row in stats["reference_over_limit"]:
            print(f"  {row['key']}：{row['media']} {row['count']} 项，上限 {row['limit']}", file=sys.stderr)
    if stats.get("unresolved_references"):
        print("注意：这些参考槽位点到的名字在项目里没有条目（多为项目外素材），"
              "不建节点也不连线，要在画布上自行挂：", file=sys.stderr)
        for row in stats["unresolved_references"]:
            print(f"  {row['key']} → {row['slot']}《{row['name']}》· {row['path']}", file=sys.stderr)
    if stats.get("nodes_without_ratio"):
        print(f"注意（已放行）：这些节点没定出画幅，导出时留空、由节点用默认比例："
              f"{stats['nodes_without_ratio']}", file=sys.stderr)

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
        "画幅": stats["aspect_ratio"] or "未定（节点沿用默认比例）",
        "带引用顺序的节点": sum(1 for node in payload["nodes"] if node["data"].get("referenceOrder")),
        "主题曲歌词已带入": stats.get("music_with_lyrics") or [],
        "项目外素材参考（未连线）": [
            f"{row['key']} → {row['slot']}《{row['name']}》" for row in stats.get("unresolved_references") or []
        ],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
