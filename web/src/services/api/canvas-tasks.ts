import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { apiGet, apiPost } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

// 列表只回传摘要（id / 标题 / 时间 / 节点计数），不含画布内容 —— 避免大画布拖慢「我的画布」加载。
export async function listCanvasProjects(token: string) {
    return apiGet<CanvasProject[]>("/api/v1/canvas/projects", undefined, token);
}

// 单画布完整内容，供打开画布时按需加载。
export async function fetchCanvasProject(token: string, id: string) {
    return apiGet<CanvasProject>(
        `/api/v1/canvas/projects/${encodeURIComponent(id)}`,
        undefined,
        token,
    );
}

export async function saveCanvasProject(
    token: string,
    project: CanvasProject,
) {
    return apiPost<CanvasProject>(
        "/api/v1/canvas/projects",
        { data: project },
        token,
    );
}

export async function syncCanvasProjects(
    token: string,
    projects: CanvasProject[],
) {
    return apiPost<CanvasProject[]>(
        "/api/v1/canvas/projects/sync",
        { projects },
        token,
    );
}

export async function deleteCanvasTasks(sourceId: string, nodeIds: string[] = []) {
    const token = useUserStore.getState().token;
    const source = sourceId.trim();
    if (!token || !source) return;
    return apiPost<{ deleted: boolean }>(
        "/api/v1/canvas/tasks/delete",
        {
            source_id: source,
            node_ids: Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean))),
        },
        token,
    );
}

export async function deleteCanvasProjects(ids: string[]) {
    const token = useUserStore.getState().token;
    const projectIds = Array.from(
        new Set(ids.map((id) => id.trim()).filter(Boolean)),
    );
    if (!token || !projectIds.length) return;
    return apiPost<{ deleted: boolean }>(
        "/api/v1/canvas/projects/delete",
        { ids: projectIds },
        token,
    );
}
