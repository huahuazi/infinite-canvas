import type { NextRequest } from "next/server";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

export const runtime = "nodejs";
// 视频提交带参考图时，上游排队 + 大请求体传输可能远超 5 分钟。
// 自托管下这个值不强制生效（真正的超时由下面的 socket setTimeout 控制），
// 同步放宽只是让两处口径一致，避免后来者读代码时被误导。
export const maxDuration = 900;

// Node 的 socket 空闲超时：只在「连上之后长时间没有数据流动」时触发。
// 视频提交后上游可能几分钟才吐首字节，SSE 更是长期持有连接，
// 默认的短超时会在两种场景下误杀，所以放到 15 分钟。
const UPSTREAM_IDLE_TIMEOUT_MS = 900_000;

type RouteContext = {
    params: Promise<{ path: string[] }>;
};

// 逐跳头不该转发；content-length 由下面按实际 body 重算。
// expect 单独处理：Safari 大 body 会先发 Expect: 100-continue，Node 侧不接管
// 会直接抛错，报错还会被写成"请确认后端服务已启动"，把排查方向完全带偏。
const REQUEST_SKIP_HEADERS = new Set([
    "host",
    "connection",
    "content-length",
    "expect",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
]);

const RESPONSE_SKIP_HEADERS = new Set([
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "connection",
    "keep-alive",
]);

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    const apiBaseUrl = process.env.API_BASE_URL || "http://127.0.0.1:8080";
    const target = new URL(
        `${apiBaseUrl.replace(/\/$/, "")}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`,
    );
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
        if (REQUEST_SKIP_HEADERS.has(key)) return;
        headers[key] = value;
    });
    headers["x-forwarded-host"] = request.nextUrl.host;
    headers["x-forwarded-proto"] = request.nextUrl.protocol.replace(":", "");

    // 请求体整体缓冲后一次性发送，不做流式透传。
    // 流式时大 body 迟迟不向下游流动，连接会在传输中途被判定超时而切断——
    // 现象是日志里只有一句超时、后端连一条请求日志都收不到。
    const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (body) headers["content-length"] = String(body.length);

    return await new Promise<Response>((resolve) => {
        let settled = false;
        const finish = (response: Response) => {
            if (settled) return;
            settled = true;
            resolve(response);
        };

        const transport = target.protocol === "https:" ? https : http;
        const upstream = transport.request(
            {
                hostname: target.hostname,
                port: target.port || undefined,
                path: `${target.pathname}${target.search}`,
                method: request.method,
                headers,
            },
            (upstreamResponse) => {
                const responseHeaders = new Headers();
                for (const [key, value] of Object.entries(upstreamResponse.headers)) {
                    if (RESPONSE_SKIP_HEADERS.has(key) || value == null) continue;
                    if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
                    else responseHeaders.set(key, value);
                }
                // 响应侧必须保持流式，否则 SSE 用不了。
                finish(
                    new Response(Readable.toWeb(upstreamResponse) as ReadableStream, {
                        status: upstreamResponse.statusCode || 502,
                        statusText: upstreamResponse.statusMessage || "",
                        headers: responseHeaders,
                    }),
                );
            },
        );

        upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
            upstream.destroy(new Error("upstream idle timeout"));
        });
        upstream.on("error", (error) => {
            console.error("Failed to proxy", target.toString(), error);
            finish(Response.json({ code: 1, data: null, msg: "接口连接失败，请确认后端服务已启动" }, { status: 502 }));
        });

        upstream.end(body);
    });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
