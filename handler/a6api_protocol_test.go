package handler

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

// A6API 是标准 OpenAI 兼容网关（不是 Ark 方言）：视频走 /v1/videos，
// 模型名即使带 seedance 也不能被改写成 /contents/generations/tasks，
// 否则上游直接 404。
func TestA6APIProtocolKeepsStandardVideoPath(t *testing.T) {
	channel := model.ModelChannel{Protocol: "a6api", BaseURL: "https://api.a6api.vip"}

	if isArkSeedanceVideo(channel, "doubao-seedance-2.5") {
		t.Fatal("A6API 渠道上的 seedance 模型不应按 Ark 协议处理")
	}
	if got := resolveAIProxyPath(channel, "doubao-seedance-2.5", "/videos"); got != "/videos" {
		t.Fatalf("创建任务路径 = %q，期望 /videos", got)
	}
	if got := resolveAIProxyPath(channel, "doubao-seedance-2.5", "/videos/task_123"); got != "/videos/task_123" {
		t.Fatalf("轮询路径 = %q，期望 /videos/task_123", got)
	}
}

// Base URL 只有域名时要补 /v1，且不能重复补成 /v1/v1。
func TestA6APIProtocolURLAddsSingleV1(t *testing.T) {
	cases := []struct {
		base string
		want string
	}{
		{"https://api.a6api.vip", "https://api.a6api.vip/v1/videos"},
		{"https://api.a6api.vip/", "https://api.a6api.vip/v1/videos"},
		{"https://api.a6api.vip/v1", "https://api.a6api.vip/v1/videos"},
		{"https://api.a6api.vip/v1/", "https://api.a6api.vip/v1/videos"},
	}
	for _, item := range cases {
		channel := model.ModelChannel{Protocol: "a6api", BaseURL: item.base}
		if got := resolveAIProxyURL(channel, "kling-3.0", "/videos"); got != item.want {
			t.Fatalf("Base URL %q 生成 %q，期望 %q", item.base, got, item.want)
		}
	}
}

// 判定顺序：显式协议优先，地址兜底只在没声明协议时生效。
func TestA6APIChannelResolutionOrder(t *testing.T) {
	if !service.IsA6APIChannel(model.ModelChannel{Protocol: "a6api", BaseURL: "https://example.com"}) {
		t.Fatal("显式选 a6api 协议时应命中，即使地址不是 a6api 域名")
	}
	if !service.IsA6APIChannel(model.ModelChannel{BaseURL: "https://api.a6api.vip"}) {
		t.Fatal("未声明协议时，a6api 域名应兜底命中")
	}
	if service.IsA6APIChannel(model.ModelChannel{Protocol: "openai", BaseURL: "https://api.a6api.vip"}) {
		t.Fatal("显式选了 openai 时不应被地址反向覆盖")
	}
	if service.IsA6APIChannel(model.ModelChannel{Protocol: "ark", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"}) {
		t.Fatal("火山方舟渠道不应被判定为 A6API")
	}
}

// 回归保护：普通 openai / 未声明协议的 seedance 渠道仍然按 Ark 处理，
// 不能因为新增了 a6api 分支把原有行为改坏。
func TestSeedanceWithoutA6APIStillUsesArkPath(t *testing.T) {
	openaiChannel := model.ModelChannel{Protocol: "openai", BaseURL: "https://api.example.com"}
	if !isArkSeedanceVideo(openaiChannel, "doubao-seedance-2.5") {
		t.Fatal("普通渠道上的 seedance 模型仍应按 Ark 协议处理")
	}
	arkChannel := model.ModelChannel{Protocol: "ark", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"}
	if got := resolveAIProxyPath(arkChannel, "doubao-seedance-2.5", "/videos"); got != "/contents/generations/tasks" {
		t.Fatalf("火山方舟创建任务路径 = %q，期望 /contents/generations/tasks", got)
	}
}
