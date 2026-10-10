import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { cancelMediaRequest } from "@/utils/media/requests";

// 停止生成：媒体生成的取消不依赖连接断开（服务端在 Bun 下收不到断开事件），
// 由前端在取消时显式调用一次，服务端据此中止对应请求并撤销远端已提交的任务。
export default Router().post("/", validateFields({
  requestId: z.string().min(1).max(128),
}), (req, res) => {
  res.json(success({ cancelled: cancelMediaRequest(req.body.requestId) }));
});
