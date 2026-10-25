import type { AiConfig } from "@/stores/use-config-store";
import { activeChannelForConfig, channelProtocolForConfig } from "@/stores/use-config-store";
import { isAnmiaoChannel, isFlatkeyBaseUrl } from "@/lib/seedance-video";
import { modelKey } from "@/lib/video-model-capabilities";

/** 视频派生类型：白模（clay render）/ 深度图（depth map）。 */
export type VideoDeriveKind = "clay" | "depth";

export type VideoDerivePreset = {
    /** 面板 / 提示里用的短名 */
    label: string;
    /** 新视频节点的标题前缀 */
    nodeTitle: string;
    /** 右键菜单的悬停说明 */
    menuTitle: string;
    /** 提交给上游的提示词 */
    prompt: string;
};

/**
 * 白模 / 深度都走火山的「视频编辑」子任务（omni_reference_task_type=edit）：
 * 在原视频上做全局材质替换或通道化，构图、机位、动作由参考视频锁定。
 *
 * 提示词写法对齐官方要求：
 *   1. 必须出现「编辑 / 修改 / 去掉」等编辑类关键词，否则会被判成参考生视频；
 *   2. 用「视频1」直接指代素材，不能写「参考 视频1」（会被误判为 reference 任务）。
 */
export const VIDEO_DERIVE_PRESETS: Record<VideoDeriveKind, VideoDerivePreset> = {
    clay: {
        label: "白模",
        nodeTitle: "白模",
        menuTitle: "把画面材质替换为纯白素模，保留运镜与动作",
        prompt:
            "严格编辑 视频1：把画面里人物、动物、道具、建筑、植被与地面的表面材质，全部修改为统一的纯白色哑光石膏素模质感（clay render）；去掉全部颜色、花纹、纹理、贴图、Logo 与文字；保留并强化环境光遮蔽与柔和方向光形成的明暗过渡和接触阴影，用它们表达体积与结构转折；保持原视频的构图、机位、镜头运动、动作节奏、物体轮廓与前后遮挡关系完全不变；背景改为均匀的浅灰渐变；整体呈现专业 3D 软件里的白模预览效果，表面细腻干净，无噪点，无闪烁，无水印，无字幕。",
    },
    depth: {
        label: "深度",
        nodeTitle: "深度图",
        menuTitle: "输出近白远黑的深度图序列，保留运镜与轮廓",
        prompt:
            "严格编辑 视频1：把画面整体修改为单通道深度图可视化，按真实空间距离映射灰度，越靠近镜头越白、越远越黑，同一物体表面的深度连续平滑过渡；去掉全部颜色、纹理、材质、明暗与投影、Logo 与文字；只保留物体轮廓与前后遮挡关系；保持原视频的构图、机位、镜头运动与动作节奏完全不变；输出干净清晰的深度通道视频，无噪点，无闪烁，无水印，无字幕。",
    },
};

/**
 * 视频编辑任务的硬约束（火山官方）：
 *   - ratio 必须 adaptive
 *   - duration 必须 -1
 *   - content 至少一个 reference_video，时长 4~30 秒
 *   - 输出不需要音轨
 * 这里在调用前就地覆盖，不改用户的全局配置。
 */
export function applyVideoDeriveConfig(config: AiConfig, kind?: VideoDeriveKind | null | string): AiConfig {
    if (!kind) return config;
    return {
        ...config,
        videoArkTaskType: "edit",
        videoSeconds: "-1",
        size: "adaptive",
        videoGenerateAudio: "false",
    };
}

/** 派生前的本地预检：命中就返回给用户看的提示，null 表示可以提交。 */
export function videoDeriveSupportIssue(config: AiConfig, durationMs?: number): string | null {
    const model = config.model || config.videoModel || "";
    if (!modelKey(model).includes("seedance-2")) {
        return "白模 / 深度视频依赖火山「视频编辑」任务，仅 Seedance 2.5 / 2.0 系列支持：请先把视频模型切换为 Seedance 2.5";
    }
    const channel = activeChannelForConfig(config);
    const baseUrl = channel?.baseUrl || config.baseUrl || "";
    if (isAnmiaoChannel(channelProtocolForConfig(config), baseUrl)) {
        return "灵智按秒通道会把时长强制改成 5 秒、也不承接视频编辑任务，白模 / 深度视频请切换到火山方舟官方渠道";
    }
    // Flatkey 只接受 4~30 的整数时长，duration=-1 会被本地过滤掉，而视频编辑任务必须传 -1。
    if (channelProtocolForConfig(config) === "flatkey" || isFlatkeyBaseUrl(baseUrl)) {
        return "Flatkey 通道不承接视频编辑任务（必须传 duration=-1）：白模 / 深度视频请改用火山方舟官方渠道";
    }
    // 这些协议各有自己的请求体与接口路径，塞不进火山的 content[] + omni_reference_task_type。
    const protocol = channelProtocolForConfig(config);
    if (["kie", "apimart", "grok2api", "mimo", "gemini"].includes(protocol)) {
        return `当前渠道走 ${protocol} 协议，不支持火山视频编辑任务：白模 / 深度视频请切换到火山方舟（Ark）渠道`;
    }
    if (typeof durationMs === "number" && durationMs > 0) {
        if (durationMs < 4000) return "原视频不足 4 秒：视频编辑任务要求素材时长 4~30 秒，请换一段更长的视频";
        if (durationMs > 30000) return "原视频超过 30 秒：视频编辑任务只接受 4~30 秒素材，请先截取 30 秒以内的片段再生成";
    }
    return null;
}
