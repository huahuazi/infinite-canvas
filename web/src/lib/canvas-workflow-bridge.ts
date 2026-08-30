/**
 * 跨页面桥梁：工作流（/workflows）→ 画布（/canvas/[id]）
 *
 * 两个页面路由不同，无法直接 import 通信。这里用同源 BroadcastChannel
 * 做实时、单向传递，不持久化、不污染画布 store。
 *
 * 通道约定：
 *  - 工作流页：postWorkflowImages(images) 推送生成结果
 *  - 画布页：subscribeWorkflowImages(callback) 监听并创建节点
 */

export type CanvasWorkflowImage = {
    imageUrl: string;
    storageKey?: string;
    prompt?: string;
    workflowName?: string;
    width?: number;
    height?: number;
};

export type CanvasWorkflowImagesMessage = {
    __canvasWorkflow: true;
    images: CanvasWorkflowImage[];
    sentAt: number;
};

const CHANNEL_NAME = "infinite-canvas:workflow-to-canvas";

function getChannel(): BroadcastChannel | null {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
    return new BroadcastChannel(CHANNEL_NAME);
}

/**
 * 工作流侧：把一批生成结果推送到画布页。
 * 返回一个可选的清理函数（关闭通道）。
 */
export function postWorkflowImages(images: CanvasWorkflowImage[]): () => void {
    const channel = getChannel();
    if (!channel) return () => undefined;
    const message: CanvasWorkflowImagesMessage = {
        __canvasWorkflow: true,
        images,
        sentAt: Date.now(),
    };
    channel.postMessage(message);
    // 发送完即可关闭本端通道（监听端不受影响）
    channel.close();
    return () => undefined;
}

/**
 * 画布侧：订阅工作流推送。返回取消订阅函数。
 * 已在非 Next 服务端环境（SSR）安全降级为 no-op。
 */
export function subscribeWorkflowImages(callback: (images: CanvasWorkflowImage[]) => void): () => void {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return () => undefined;
    const channel = getChannel();
    if (!channel) return () => undefined;
    const handleMessage = (event: MessageEvent) => {
        const data = event.data as CanvasWorkflowImagesMessage | null;
        if (!data || data.__canvasWorkflow !== true || !Array.isArray(data.images)) return;
        callback(data.images);
    };
    channel.addEventListener("message", handleMessage);
    return () => {
        channel.removeEventListener("message", handleMessage);
        channel.close();
    };
}
