package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/tigerowo/infinite-canvas/service"
)

// 用户级 MCP 凭据：外部智能体（Codex / Claude Code）没有浏览器会话，
// 也不应该拿服务器共享密钥。这里按用户签发一枚无状态 token：
//
//	token = "mcp_" + userId + "_" + HMAC-SHA256(agentServiceKey, "infinite-canvas-agent:"+userId)[:32]
//
// 服务端只需重算 HMAC 即可校验，不需要落库；agentServiceKey 轮换时全部失效，符合预期。

const agentUserTokenPrefix = "mcp_"
const agentUserTokenSignatureLength = 32

func agentUserSignature(userID string) string {
	mac := hmac.New(sha256.New, []byte(agentServiceKey))
	mac.Write([]byte("infinite-canvas-agent:" + userID))
	return hex.EncodeToString(mac.Sum(nil))[:agentUserTokenSignatureLength]
}

// AgentUserToken 生成（或重新生成）当前用户的 MCP token。
// 同一用户在同一 agentServiceKey 下始终得到同一个值，前端可以缓存。
func AgentUserToken(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "未登录或权限不足")
		return
	}
	signature := agentUserSignature(user.ID)
	if agentServiceKey == "" {
		Fail(w, "服务端未配置 Agent 密钥，无法签发 token")
		return
	}
	OK(w, map[string]any{
		"token": agentUserTokenPrefix + user.ID + "_" + signature,
		"hint":  "作为 Authorization: Bearer 传给 MCP 地址；服务端轮换 AGENT_MCP_KEY 后需要重新获取。",
	})
}

// validAgentUserToken 校验用户级 MCP token（常量时间比较签名部分）。
func validAgentUserToken(token string) bool {
	if agentServiceKey == "" || !strings.HasPrefix(token, agentUserTokenPrefix) {
		return false
	}
	rest := strings.TrimPrefix(token, agentUserTokenPrefix)
	index := strings.LastIndex(rest, "_")
	if index <= 0 || index == len(rest)-1 {
		return false
	}
	userID := rest[:index]
	signature := rest[index+1:]
	expected := agentUserSignature(userID)
	if len(signature) != len(expected) {
		return false
	}
	return hmac.Equal([]byte(signature), []byte(expected))
}
