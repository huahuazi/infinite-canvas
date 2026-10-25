"use client";

import { create } from "zustand";

/**
 * 参考素材「转存公网直链」的临时状态。
 *
 * 生成视频前如果需要把本地素材换成公网直链（本机素材出口 / 公共托管兜底），
 * 这个过程对用户是无感的，但可能持续几秒到几十秒，所以单独抽一个 store
 * 让工作台把「正在上传到公共直链」显示出来，而不是一直卡在「生成中」。
 */
type MediaMirrorState = {
    active: boolean;
    text: string;
    begin: (text: string) => void;
    update: (text: string) => void;
    end: () => void;
};

export const useMediaMirrorStore = create<MediaMirrorState>((set) => ({
    active: false,
    text: "",
    begin: (text) => set({ active: true, text }),
    update: (text) => set({ active: true, text }),
    end: () => set({ active: false, text: "" }),
}));
