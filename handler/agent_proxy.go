package handler

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

// Agent 反向代理：把 /api/agent/* 转发到本地 Agent 服务，并把 Agent token 注入请求头，
// 使浏览器同源访问画布能力而无需接触 token。默认目标 http://agent:17371（docker-compose 网络）。
var agentProxy *httputil.ReverseProxy

// defaultAgentProxyURL 是 docker compose 网络内 agent 服务的默认地址。
const defaultAgentProxyURL = "http://agent:17371"

func init() {
	target := os.Getenv("AGENT_PROXY_URL")
	if target == "" {
		target = defaultAgentProxyURL
		log.Printf("[Agent 反代] 警告：未配置 AGENT_PROXY_URL，按默认地址 %s 转发；若 agent 不在同一个 docker compose 网络内，请在 .env 里设置 AGENT_PROXY_URL，否则 /api/agent/health 会返回 502。", defaultAgentProxyURL)
	}
	parsed, err := url.Parse(target)
	if err != nil {
		log.Printf("[Agent 反代] 警告：AGENT_PROXY_URL 不是合法地址（%s），/api/agent/* 反代不可用，浏览器会提示网络或跨域失败。正确示例：%s", target, defaultAgentProxyURL)
		return
	}
	agentProxy = &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = parsed.Scheme
			pr.Out.URL.Host = parsed.Host
			// 去掉 /api/agent 前缀，转发到 agent 服务的原生路由（/events、/mcp、/api/tools 等）。
			// 注意：前缀本身以 / 开头，剩余路径也已保留 / 前缀，直接 TrimPrefix 即可。
			path := strings.TrimPrefix(pr.Out.URL.Path, "/api/agent")
			if path == "" {
				path = "/"
			}
			pr.Out.URL.Path = path
		},
	}
	agentToken := os.Getenv("AGENT_TOKEN")
	if agentToken == "" {
		log.Printf("[Agent 反代] 警告：未配置 AGENT_TOKEN，反代不会注入 x-canvas-agent-token；此时 /api/agent/health 可能仍返回 ok，但 /events、/canvas/* 等受保护路由会返回 401，画布表现为连接失败。请在 .env 里配置与 agent 容器完全一致的 AGENT_TOKEN（生成示例：openssl rand -hex 18）。")
	}
	if agentToken != "" {
		agentProxy.ModifyResponse = nil
		director := agentProxy.Rewrite
		agentProxy.Rewrite = func(pr *httputil.ProxyRequest) {
			director(pr)
			pr.Out.Header.Set("x-canvas-agent-token", agentToken)
			pr.Out.Header.Del("Authorization")
		}
	}
}

// AgentProxy 是 /api/agent/* 的统一反向代理入口（GET/POST/SSE 流式均支持）。
func AgentProxy(w http.ResponseWriter, r *http.Request) {
	if agentProxy == nil {
		Fail(w, "Agent 服务未配置")
		return
	}
	agentProxy.ServeHTTP(w, r)
}
