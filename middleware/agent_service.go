package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

// AgentServiceAuth 是「agent 容器 → 后端」的服务间通道鉴权：
// 校验 X-Agent-Key（或 Authorization: Bearer），并按 X-User-Id 注入目标用户。
//
// 为什么不用用户 JWT：外部智能体（Codex / Claude Code）连上 agent 容器后，
// 容器手里没有用户会话；无头画布接口需要一条不依赖浏览器、也不依赖用户登录态的路径。
// 该密钥即 AGENT_MCP_KEY（未配置时回退 AGENT_TOKEN），只在服务器同机/同内网使用，
// 不要把 /api/agent-canvas/* 暴露到公网。
func AgentServiceAuth(c *gin.Context) {
	key := strings.TrimSpace(c.GetHeader("X-Agent-Key"))
	if key == "" {
		key = strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	}
	if !handler.ValidAgentServiceKey(key) {
		handler.FailWithStatus(c.Writer, http.StatusUnauthorized, "Agent 服务密钥无效：请在请求头带 X-Agent-Key")
		c.Abort()
		return
	}

	userID := strings.TrimSpace(c.GetHeader("X-User-Id"))
	if userID == "" {
		handler.FailWithStatus(c.Writer, http.StatusBadRequest, "缺少 X-User-Id：无头画布接口必须指明目标用户")
		c.Abort()
		return
	}
	user, found, err := repository.GetUserByID(userID)
	if err != nil {
		handler.FailWithStatus(c.Writer, http.StatusInternalServerError, "读取用户失败")
		c.Abort()
		return
	}
	if !found {
		handler.FailWithStatus(c.Writer, http.StatusNotFound, "目标用户不存在")
		c.Abort()
		return
	}
	if user.Status == model.UserStatusBan {
		handler.FailWithStatus(c.Writer, http.StatusForbidden, "目标用户已被禁用")
		c.Abort()
		return
	}

	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), model.AuthUser{
		ID:          user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		AvatarURL:   user.AvatarURL,
		Role:        user.Role,
		Credits:     user.Credits,
		CreatedAt:   user.CreatedAt,
		UpdatedAt:   user.UpdatedAt,
	}))
	c.Next()
}
