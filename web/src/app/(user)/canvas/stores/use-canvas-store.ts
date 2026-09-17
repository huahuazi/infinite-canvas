import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { fetchCanvasProject, listCanvasProjects, saveCanvasProject, syncCanvasProjects } from "@/services/api/canvas-tasks";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAgentConfig, CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasPendingAgentRequest, ViewportTransform } from "../types";

export type CanvasSidePanelState = {
    open: boolean;
    width: number;
};

export const DEFAULT_CANVAS_SIDE_PANEL: CanvasSidePanelState = { open: true, width: 280 };
export const DEFAULT_CANVAS_AGENT_PANEL: CanvasSidePanelState = { open: false, width: 390 };

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    agentConfig: CanvasAgentConfig | null;
    autoTitlePending: boolean;
    pendingAgentRequest?: CanvasPendingAgentRequest;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    sidePanel: CanvasSidePanelState;
    agentPanel: CanvasSidePanelState;
    // 列表接口只回传摘要，内容按需加载：
    // nodeCount/connectionCount 是服务端给出的真实计数（摘要态下 nodes/connections 为空数组）；
    // contentLoaded 为 false 表示内容尚未拉取，此时禁止保存，避免用空数据覆盖服务端。
    nodeCount?: number;
    connectionCount?: number;
    contentLoaded?: boolean;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string, options?: { agentConfig?: CanvasAgentConfig; pendingAgentRequest?: CanvasPendingAgentRequest }) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    loadProjectContent: (id: string) => Promise<CanvasProject | null>;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "agentConfig" | "autoTitlePending" | "backgroundMode" | "showImageInfo" | "viewport" | "sidePanel" | "agentPanel" | "pendingAgentRequest">>) => void;
    syncWithRemote: (token: string, syncEnabled: boolean) => Promise<void>;
    setSyncEnabled: (enabled: boolean) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let accountCanvasSyncEnabled = false;
const projectSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function waitForUserStoreHydration() {
    if (useUserStore.persist.hasHydrated()) return Promise.resolve();

    return new Promise<void>((resolve) => {
        let unsubscribe = () => { };
        unsubscribe = useUserStore.persist.onFinishHydration(() => {
            unsubscribe();
            resolve();
        });
        if (useUserStore.persist.hasHydrated()) {
            unsubscribe();
            resolve();
        }
    });
}

function queueProjectSave(project: CanvasProject) {
    const previous = projectSaveTimers.get(project.id);
    if (previous) clearTimeout(previous);

    projectSaveTimers.set(
        project.id,
        setTimeout(() => {
            projectSaveTimers.delete(project.id);
            const token = useUserStore.getState().token;
            const syncEnabled = accountCanvasSyncEnabled;
            if (
                !token ||
                !syncEnabled ||
                !accountCanvasSyncEnabled ||
                useUserStore.getState().token !== token
            ) {
                return;
            }
            // 摘要态（内容未加载）不能直接回写：该画布 nodes 为空，写上去会清空服务端数据。
            // 先把完整内容拉回来，再用本次改动覆盖元数据（如列表页重命名）。
            if (project.contentLoaded === false) {
                void useCanvasStore
                    .getState()
                    .loadProjectContent(project.id)
                    .then((loaded) => {
                        if (!loaded || loaded.contentLoaded === false) return;
                        return saveCanvasProject(token, {
                            ...loaded,
                            ...project,
                            nodes: loaded.nodes,
                            connections: loaded.connections,
                            contentLoaded: true,
                        });
                    })
                    .catch(() => undefined);
                return;
            }
            void saveCanvasProject(token, project).catch(() => undefined);
        }, 400),
    );
}

function cancelProjectSaves(ids: string[]) {
    ids.forEach((id) => {
        const timer = projectSaveTimers.get(id);
        if (!timer) return;
        clearTimeout(timer);
        projectSaveTimers.delete(id);
    });
}

// 列表接口只回传摘要，而本地缓存里可能仍存有完整内容。合并时必须按「本地内容是否完整 + 谁更新」判断，
// 绝不能用摘要覆盖本地的完整画布 —— 否则会出现空画布，甚至把空数据写回服务端。
function mergeCanvasProjectSummaries(
    remoteSummaries: CanvasProject[],
    localProjects: CanvasProject[],
): CanvasProject[] {
    const localById = new Map(
        localProjects.map((project) => [project.id, project]),
    );
    const merged: CanvasProject[] = [];

    for (const remote of remoteSummaries) {
        const local = localById.get(remote.id);
        localById.delete(remote.id);
        const localHasContent = Boolean(local) && local!.contentLoaded !== false;
        const localIsNewer =
            localHasContent &&
            Date.parse(local!.updatedAt || "") >=
                Date.parse(remote.updatedAt || "");

        if (localIsNewer) {
            // 本地内容齐全且不落后：保留完整数据，仅用摘要里的计数校正展示值。
            merged.push({
                ...local!,
                nodeCount: remote.nodeCount ?? local!.nodeCount,
                connectionCount: remote.connectionCount ?? local!.connectionCount,
            });
            continue;
        }

        // 服务端更新，或本地没有内容：采用摘要，节点内容留待打开画布时按需拉取。
        const remoteHasContent = remote.contentLoaded !== false;
        merged.push({
            ...remote,
            nodes: remoteHasContent ? remote.nodes || [] : [],
            connections: remoteHasContent ? remote.connections || [] : [],
            contentLoaded: remoteHasContent,
        });
    }

    // 本地独有（服务端还没有）的画布：原样保留完整数据。
    for (const local of localById.values()) merged.push(local);

    return merged.sort(
        (a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""),
    );
}

async function reconcileCanvasProjects(
    token: string,
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
) {
    const remoteById = new Map(
        remoteProjects.map((project) => [project.id, project]),
    );
    const missingProjects = localProjects.filter(
        (project) => !remoteById.has(project.id),
    );

    // 本地独有的画布先推进服务端；失败也不阻塞，本地数据仍然完整保留。
    if (missingProjects.length) {
        await syncCanvasProjects(token, missingProjects).catch(() => undefined);
    }

    localProjects.forEach((project) => {
        // 内容未加载的画布不能回写，否则会用空 nodes 覆盖服务端。
        if (project.contentLoaded === false) return;
        const remote = remoteById.get(project.id);
        if (
            remote &&
            Date.parse(project.updatedAt || "") >
                Date.parse(remote.updatedAt || "")
        ) {
            queueProjectSave(project);
        }
    });

    return mergeCanvasProjectSummaries(remoteProjects, localProjects);
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        await waitForUserStoreHydration();
        const localValue = await localForageStorage.getItem(name);
        const token = useUserStore.getState().token;
        const localParsed = localValue
            ? (JSON.parse(localValue) as StorageValue<CanvasStore>)
            : null;
        const localProjects =
            (localParsed?.state as PersistedCanvasState)?.projects || [];
        const localHasData =
            Array.isArray(localProjects) && localProjects.length > 0;

        if (token) {
            try {
                const [userConfig, remoteProjects] = await Promise.all([
                    fetchUserConfig(token),
                    listCanvasProjects(token),
                ]);
                accountCanvasSyncEnabled =
                    userConfig.syncCapabilities?.userData === true;

                if (accountCanvasSyncEnabled && localHasData) {
                    const projects = await reconcileCanvasProjects(
                        token,
                        remoteProjects,
                        localProjects,
                    );

                    const nextState = { projects };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await localForageStorage.setItem(
                        name,
                        JSON.stringify(parsed),
                    );
                    return parsed;
                }

                if (
                    remoteProjects.length > 0 &&
                    (accountCanvasSyncEnabled || !localHasData)
                ) {
                    const nextState = { projects: remoteProjects };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await localForageStorage.setItem(
                        name,
                        JSON.stringify(parsed),
                    );
                    return parsed;
                }
            } catch (error) {
                console.error(
                    "Failed to hydrate canvas projects from remote",
                    error,
                );
            }
        }

        if (!localParsed) return null;
        queuedPersistState = localParsed.state as PersistedCanvasState;
        return localParsed;
    },

    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (
            queuedPersistState &&
            queuedPersistState.projects === nextState.projects
        ) {
            return;
        }
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布", options) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    agentConfig: options?.agentConfig || null,
                    autoTitlePending: true,
                    pendingAgentRequest: options?.pendingAgentRequest,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                    sidePanel: DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: options?.pendingAgentRequest ? { ...DEFAULT_CANVAS_AGENT_PANEL, open: true } : DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    agentConfig: source.agentConfig || null,
                    autoTitlePending: false,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    sidePanel: source.sidePanel || DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: source.agentPanel || DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return project.id;
            },
            openProject: (id) =>
                get().projects.find((item) => item.id === id) || null,
            // 按需拉取画布完整内容。列表接口只给摘要，因此打开画布前必须走这里补齐。
            loadProjectContent: async (id) => {
                const project = get().projects.find((item) => item.id === id);
                if (!project) return null;
                if (project.contentLoaded !== false) return project;

                const token = useUserStore.getState().token;
                if (!token) return project;

                try {
                    const full = await fetchCanvasProject(token, id);
                    if (!full || !Array.isArray(full.nodes)) return project;
                    const loaded: CanvasProject = {
                        ...project,
                        ...full,
                        contentLoaded: true,
                        nodeCount: full.nodes.length,
                        connectionCount: Array.isArray(full.connections)
                            ? full.connections.length
                            : 0,
                    };
                    set((state) => ({
                        projects: state.projects.map((item) =>
                            item.id === id ? loaded : item,
                        ),
                    }));
                    return loaded;
                } catch {
                    // 拉取失败时保持摘要态：界面提示重试，绝不写入空内容。
                    return project;
                }
            },
            renameProject: (id, title) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    title: title.trim() || project.title,
                    autoTitlePending: false,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            deleteProjects: (ids) => {
                cancelProjectSaves(ids);
                set((state) => ({
                    projects: state.projects.filter(
                        (project) => !ids.includes(project.id),
                    ),
                }));
            },
            updateProject: (id, patch) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    ...patch,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            syncWithRemote: async (token, syncEnabled) => {
                accountCanvasSyncEnabled = syncEnabled;
                if (!syncEnabled) return;
                const localProjects = get().projects;
                const remoteProjects = await listCanvasProjects(token).catch(
                    () => null,
                );
                if (!remoteProjects) return;
                const projects = await reconcileCanvasProjects(
                    token,
                    remoteProjects,
                    localProjects,
                );
                if (saveTimer) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                }
                const nextState = { projects };
                queuedPersistState = nextState;
                set(nextState);
                await localForageStorage.setItem(
                    CANVAS_STORE_KEY,
                    JSON.stringify({ state: nextState, version: 0 }),
                );
            },
            setSyncEnabled: (enabled) => {
                accountCanvasSyncEnabled = enabled;
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);

export function mergeCanvasProjects(
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
): CanvasProject[] {
    const projects = new Map<string, CanvasProject>();
    [...localProjects, ...remoteProjects].forEach((project) => {
        const previous = projects.get(project.id);
        if (
            !previous ||
            Date.parse(project.updatedAt || "") >=
            Date.parse(previous.updatedAt || "")
        ) {
            projects.set(project.id, project);
        }
    });
    return Array.from(projects.values()).sort(
        (a, b) =>
            Date.parse(b.updatedAt || "") -
            Date.parse(a.updatedAt || ""),
    );
}