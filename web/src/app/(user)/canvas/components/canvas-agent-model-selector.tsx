"use client";

import { useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import { Button, Modal, Select, Tooltip } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import {
    filterModelsByCapability,
    normalizeLocalChannels,
    type AiConfig,
    type ModelCapability,
} from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

export type AgentModelSelection = {
    textModel: string;
    textChannelId: string;
    imageModel: string;
    imageChannelId: string;
    videoModel: string;
    videoChannelId: string;
    audioModel: string;
    audioChannelId: string;
};

type CapabilityTab = ModelCapability;

type CanvasAgentModelSelectorProps = {
    config: AiConfig;
    value: AgentModelSelection;
    onChange: (patch: Partial<AgentModelSelection>) => void;
};

const TAB_META: Array<{ key: CapabilityTab; label: string }> = [
    { key: "text", label: "对话" },
    { key: "image", label: "图片" },
    { key: "video", label: "视频" },
    { key: "audio", label: "音频" },
];

function modelFieldFor(tab: CapabilityTab): { model: "textModel" | "imageModel" | "videoModel" | "audioModel"; channel: "textChannelId" | "imageChannelId" | "videoChannelId" | "audioChannelId" } {
    switch (tab) {
        case "image":
            return { model: "imageModel", channel: "imageChannelId" };
        case "video":
            return { model: "videoModel", channel: "videoChannelId" };
        case "audio":
            return { model: "audioModel", channel: "audioChannelId" };
        default:
            return { model: "textModel", channel: "textChannelId" };
    }
}

function fallbackModelFor(config: AiConfig, tab: CapabilityTab): string {
    switch (tab) {
        case "image":
            return config.imageModel || config.model || "";
        case "video":
            return config.videoModel || config.model || "";
        case "audio":
            return config.audioModel || "";
        default:
            return config.textModel || config.model || "";
    }
}

function fallbackChannelIdFor(config: AiConfig, tab: CapabilityTab): string {
    switch (tab) {
        case "image":
            return config.imageChannelId || config.activeChannelId || "";
        case "video":
            return config.videoChannelId || config.activeChannelId || "";
        case "audio":
            return config.audioChannelId || config.activeChannelId || "";
        default:
            return config.textChannelId || config.activeChannelId || "";
    }
}

export function CanvasAgentModelSelector({ config, value, onChange }: CanvasAgentModelSelectorProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [open, setOpen] = useState(false);

    const channels = useMemo(() => {
        if (config.channelMode === "remote") {
            return (config.publicChannels || []).map((channel) => ({
                id: channel.id || "",
                protocol: channel.protocol || "openai",
                name: channel.name || "云端渠道",
                baseUrl: channel.baseUrl || "",
                models: channel.models || [],
            }));
        }
        return normalizeLocalChannels(config).map((channel) => ({
            id: channel.id,
            protocol: channel.protocol,
            name: channel.name,
            baseUrl: channel.baseUrl,
            models: channel.models,
        }));
    }, [config]);

    const channelOptions = channels
        .filter((channel) => channel.id)
        .map((channel) => ({ value: channel.id, label: channel.name || channel.baseUrl || channel.id }));

    const resolveCurrent = (tab: CapabilityTab) => {
        const fields = modelFieldFor(tab);
        const model = value[fields.model] || fallbackModelFor(config, tab);
        const channelId = value[fields.channel] || fallbackChannelIdFor(config, tab);
        return { model, channelId };
    };

    const handleTabChange = (tab: CapabilityTab, nextChannelId: string, nextModel: string) => {
        const fields = modelFieldFor(tab);
        onChange({ [fields.model]: nextModel, [fields.channel]: nextChannelId });
    };

    const selectedSummary = [
        { label: "文本", model: value.textModel || fallbackModelFor(config, "text") },
        { label: "图片", model: value.imageModel || fallbackModelFor(config, "image") },
        { label: "视频", model: value.videoModel || fallbackModelFor(config, "video") },
        { label: "音频", model: value.audioModel || fallbackModelFor(config, "audio") },
    ];

    return (
        <>
            <Tooltip title="选择 Agent 模型 / 渠道">
                <Button
                    type="text"
                    shape="circle"
                    className="!h-8 !w-8 !min-w-8"
                    style={{ color: theme.node.text }}
                    icon={<Settings2 className="size-4" />}
                    onClick={() => setOpen(true)}
                    aria-label="选择 Agent 模型 / 渠道"
                />
            </Tooltip>
            <Modal
                open={open}
                title="Agent 模型 / 渠道"
                width={640}
                footer={<Button onClick={() => setOpen(false)}>完成</Button>}
                onCancel={() => setOpen(false)}
                destroyOnHidden
            >
                <div className="mb-4 grid grid-cols-4 gap-2">
                    {selectedSummary.map((item) => (
                        <div key={item.label} className="min-w-0 rounded-lg border px-3 py-2">
                            <div className="text-xs opacity-50">{item.label}</div>
                            <div className="truncate text-sm font-medium" title={item.model}>
                                {item.model || "未选择"}
                            </div>
                        </div>
                    ))}
                </div>
                <CapabilityTabs
                    channels={channels}
                    channelOptions={channelOptions}
                    resolveCurrent={resolveCurrent}
                    onChange={handleTabChange}
                />
                <div className="mt-4 rounded-lg px-3 py-2 text-xs opacity-60" style={{ background: theme.toolbar.itemHover }}>
                    此选择仅作用于当前画布的创作 Agent，不会修改全局配置。
                </div>
            </Modal>
        </>
    );
}

function CapabilityTabs({
    channels,
    channelOptions,
    resolveCurrent,
    onChange,
}: {
    channels: Array<{ id: string; protocol: string; name: string; baseUrl: string; models: string[] }>;
    channelOptions: Array<{ value: string; label: string }>;
    resolveCurrent: (tab: CapabilityTab) => { model: string; channelId: string };
    onChange: (tab: CapabilityTab, channelId: string, model: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [activeTab, setActiveTab] = useState<CapabilityTab>("text");

    const current = resolveCurrent(activeTab);
    const activeChannel = channels.find((channel) => channel.id === current.channelId) || channels[0];
    const effectiveChannelId = activeChannel?.id || "";
    const effectiveModel = current.model || activeChannel?.models?.[0] || "";
    const modelOptions = (activeChannel?.models || [])
        .filter((model) => filterModelsByCapability([model], activeTab, activeChannel?.protocol || "").length > 0)
        .map((model) => ({ value: model, label: model }));

    return (
        <div>
            <div className="mb-3 flex items-center gap-2">
                {TAB_META.map((tab) => (
                    <button
                        key={tab.key}
                        type="button"
                        className="cursor-pointer rounded-full border px-3 py-1 text-sm transition"
                        style={
                            activeTab === tab.key
                                ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText, borderColor: theme.toolbar.activeBg }
                                : { background: "transparent", color: theme.node.text, borderColor: theme.node.stroke }
                        }
                        onClick={() => setActiveTab(tab.key)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="space-y-3">
                <div>
                    <div className="mb-1 text-xs opacity-60">渠道</div>
                    <Select
                        className="w-full"
                        value={effectiveChannelId || undefined}
                        options={channelOptions}
                        onChange={(nextChannelId) => {
                            const channel = channels.find((item) => item.id === nextChannelId);
                            const firstModel = channel?.models?.find((model) =>
                                filterModelsByCapability([model], activeTab, channel?.protocol || "").length > 0,
                            );
                            onChange(activeTab, nextChannelId, firstModel || "");
                        }}
                        placeholder="选择渠道"
                    />
                </div>
                <div>
                    <div className="mb-1 text-xs opacity-60">模型</div>
                    <Select
                        className="w-full"
                        value={effectiveModel || undefined}
                        options={modelOptions}
                        onChange={(nextModel) => onChange(activeTab, effectiveChannelId, nextModel)}
                        placeholder="选择模型"
                        notFoundContent="该渠道暂无匹配模型"
                    />
                </div>
                <div className="text-xs opacity-50">
                    {activeChannel?.baseUrl ? <span className="mr-2">Base URL：{activeChannel.baseUrl}</span> : null}
                    {activeChannel?.protocol ? <span>协议：{activeChannel.protocol}</span> : null}
                </div>
            </div>
        </div>
    );
}
