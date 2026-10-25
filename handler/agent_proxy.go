package handler

import (
	"crypto/subtle"
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

// agentServiceKey 是外部 Agent 与无头画布接口共用的共享密钥。
// 优先读 AGENT_MCP_KEY；未配置时回退 AGENT_TOKEN（服务器上两者本就同源，回退保证开箱可用）。
var agentServiceKey string

// defaultAgentProxyURL 是 docker compose 网络内 agent 服务的默认地址。
const defaultAgentProxyURL = "http://agent:17371"

func init() {
	// 密钥初始化必须早于反代地址解析：地址非法时下面会提前 return，
	// 若把密钥初始化放在后面，无头画布接口会拿到空密钥并拒绝所有请求。
	initAgentServiceKey()

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

// initAgentServiceKey 决定外部 Agent 与无头画布接口使用的共享密钥。
func initAgentServiceKey() {
	agentServiceKey = strings.TrimSpace(os.Getenv("AGENT_MCP_KEY"))
	if agentServiceKey == "" {
		agentServiceKey = strings.TrimSpace(os.Getenv("AGENT_TOKEN"))
		log.Printf("[Agent 鉴权] 未配置 AGENT_MCP_KEY，MCP 端点与无头画布接口回退使用 AGENT_TOKEN 校验；如需独立轮换，请在 .env 里单独配置 AGENT_MCP_KEY（openssl rand -hex 24）。")
	}
	if agentServiceKey == "" {
		log.Printf("[Agent 鉴权] AGENT_MCP_KEY 与 AGENT_TOKEN 均为空：MCP 端点（/api/agent/mcp）与无头画布接口（/api/agent-canvas/*）将拒绝所有请求。")
	}
}

// ValidAgentServiceKey 用常量时间比较校验 Agent 共享密钥。
func ValidAgentServiceKey(key string) bool {
	key = strings.TrimSpace(key)
	if agentServiceKey == "" || key == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(key), []byte(agentServiceKey)) == 1
}

// agentRouteRequiresKey 判断反代路径是否属于「外部 Agent 入口」。
// 浏览器专用路径（/events、/canvas/*）不在其中：EventSource 无法自定义请求头，
// 它们的安全边界仍是「同源 + 反代注入 token」。
func agentRouteRequiresKey(path string) bool {
	switch strings.TrimPrefix(path, "/api/agent") {
	case "/mcp", "/tools", "/api/tools":
		return true
	default:
		return false
	}
}

// AgentProxy 是 /api/agent/* 的统一反向代理入口（GET/POST/SSE 流式均支持）。
func AgentProxy(w http.ResponseWriter, r *http.Request) {
	if agentProxy == nil {
		Fail(w, "Agent 服务未配置")
		return
	}
	if agentRouteRequiresKey(r.URL.Path) && !requestAgentKey(r) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="infinite-canvas-agent"`)
		FailWithStatus(w, http.StatusUnauthorized, "缺少或无效的 Agent 密钥：请在请求头带 X-Agent-Key，或 Authorization: Bearer <AGENT_MCP_KEY>")
		return
	}
	agentProxy.ServeHTTP(w, r)
}

// requestAgentKey 依次从请求头、Bearer 与查询参数读取候选密钥。
// 支持两类凭据：服务间共享密钥（X-Agent-Key / AGENT_MCP_KEY），以及按用户签发的 MCP token（mcp_<uid>_<sig>）。
func requestAgentKey(r *http.Request) bool {
	for _, candidate := range []string{
		r.Header.Get("X-Agent-Key"),
		strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "),
		r.URL.Query().Get("key"),
	} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if ValidAgentServiceKey(candidate) || validAgentUserToken(candidate) {
			return true
		}
	}
	return false
}
