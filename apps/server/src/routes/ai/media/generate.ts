import { Router } from "express";
import { z } from "zod";
import { audioGenerationSchema, imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success, error, errorFromCause } from "@/lib/responseFormat";
import u from "@/utils";
import { registerMediaRequest, releaseMediaRequest } from "@/utils/media/requests";
import { translateMessage, validationOptions } from "@/lib/i18n";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), mediaType: z.enum(["image", "video", "audio"]),
}), async (req, res) => {
  const { directory, mediaType, ...request } = req.body;
  const parsed = (mediaType === "image" ? imageGenerationSchema : mediaType === "video" ? videoGenerationSchema : audioGenerationSchema).safeParse(request, validationOptions());
  if (!parsed.success) {
    res.status(400).json(error("参数错误", parsed.error.issues.map(issue => ({ ...issue, message: translateMessage(issue.message) })), 400));
    return;
  }
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const controller = new AbortController();
  // 停止生成由前端显式通知（POST /api/ai/media/cancel）：客户端断开后服务端收不到任何事件，
  // 靠连接状态判断取消不可靠，下面的 close 只作为运行时支持时的兜底。
  const requestId = req.get("x-toonflow-request-id") ?? "";
  if (requestId) registerMediaRequest(requestId, controller);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = () => { clearInterval(heartbeat); controller.abort(); };
  res.once("close", close);
  req.once("aborted", close);
  req.socket.once("close", close);
  try {
    res.set({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    // ACT: JSON 允许前导空白，保活时保留现有 response.json() 契约。
    heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write("\n"); }, 20000);
    const files = await u.mediaGeneration.generateMedia(cwd, mediaType, parsed.data, controller.signal);
    if (!res.destroyed) res.write(JSON.stringify(success(files)));
  } catch (err) {
    if (!res.destroyed) res.write(JSON.stringify(errorFromCause(err)));
  } finally {
    if (requestId) releaseMediaRequest(requestId);
    clearInterval(heartbeat);
    res.off("close", close);
    req.off("aborted", close);
    req.socket.off("close", close);
    res.end();
  }
});
