// 媒体生成的「停止生成」登记表。
//
// 【为什么需要它】媒体生成不是普通的即时请求：提交给远端（云端供应商 / 本地 ComfyUI 工作流）之后，
// 服务端只是轮询等待。用户在界面上点「停止」，必须同时做两件事——中止服务端等待，以及撤销远端任务
// （本地工作流不撤销会继续占显存，云端会继续计费）。
//
// 【为什么不能用连接断开】Bun 运行时下客户端断开不触发任何事件：res close / req aborted /
// socket close 都不触发，往已断开的连接写心跳也不报错。请求会一路跑到完成，无人撤销远端任务。
//
// 【为什么插件层做不到】请求 ID 由宿主生成、控制器由宿主持有；供应商跑在 Node vm 沙箱里，
// 注入的全局里没有 fetch，只能用 this.tool.fetch，而它绑定了取消信号——中止后立即抛错，
// 恰恰发不出那个「撤销远端」的一次性请求（宿主为此另开了 fetchDetached 通道）。
//
// 【能否移除】撤掉之后「停止生成」只能中止前端等待，远端任务仍会跑完，占用资源直到自然结束。
// 若运行时换成能收到断开事件的 Node（而非 Bun），可评估改为「连接断开即取消」。
const running = new Map<string, AbortController>();

export function registerMediaRequest(id: string, controller: AbortController) {
  running.set(id, controller);
}

export function releaseMediaRequest(id: string) {
  running.delete(id);
}

/** 返回是否真的找到了该请求；找不到通常说明它已经结束了。 */
export function cancelMediaRequest(id: string) {
  const controller = running.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}
