package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

// 灵智协议判定：显式 protocol 优先，Base URL 兜底（兼容 v0.8.x 的旧配置）。
func TestIsAnmiaoChannel(t *testing.T) {
	cases := []struct {
		name     string
		channel  model.ModelChannel
		expected bool
	}{
		{
			name:     "显式 anmiao 协议命中",
			channel:  model.ModelChannel{Protocol: "anmiao", BaseURL: "https://api.lk888.ai/api/v3/anmiao"},
			expected: true,
		},
		{
			name:     "显式 anmiao 协议 + 任意地址都命中（地址填错也先按灵智处理）",
			channel:  model.ModelChannel{Protocol: "anmiao", BaseURL: "https://api.lk888.ai/api/v3"},
			expected: true,
		},
		{
			name:     "显式 anmiao 协议大小写不敏感",
			channel:  model.ModelChannel{Protocol: "ANMIAO", BaseURL: ""},
			expected: true,
		},
		{
			name:     "旧配置：ark 协议 + 灵智地址，靠地址兜底",
			channel:  model.ModelChannel{Protocol: "ark", BaseURL: "https://api.lk888.ai/api/v3/anmiao"},
			expected: true,
		},
		{
			name:     "旧配置：未声明协议 + 灵智地址",
			channel:  model.ModelChannel{BaseURL: "https://api.lingkeai.ai/api/v3/anmiao"},
			expected: true,
		},
		{
			name:     "显式选了别的协议时，不该被地址反推回去",
			channel:  model.ModelChannel{Protocol: "openai", BaseURL: "https://api.lk888.ai/api/v3/anmiao"},
			expected: false,
		},
		{
			name:     "火山官方不是灵智",
			channel:  model.ModelChannel{Protocol: "ark", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"},
			expected: false,
		},
		{
			name:     "普通 Ark 渠道不是灵智",
			channel:  model.ModelChannel{Protocol: "ark", BaseURL: "https://router.flatkey.ai/v1"},
			expected: false,
		},
	}
	for _, item := range cases {
		if got := IsAnmiaoChannel(item.channel); got != item.expected {
			t.Fatalf("%s：IsAnmiaoChannel = %v，期望 %v", item.name, got, item.expected)
		}
	}
}

// 灵智是 Ark 的一种方言：显式选 anmiao 时必须走 Ark 的任务协议（/contents/generations/tasks），
// 否则请求会打到 /videos 去，灵智那边直接 404。
func TestAnmiaoProtocolUsesArkTaskPath(t *testing.T) {
	channel := model.ModelChannel{Protocol: "anmiao", BaseURL: "https://api.lk888.ai/api/v3/anmiao"}
	if !isArkChannel(channel) {
		t.Fatal("灵智协议属于 Ark 协议族，isArkChannel 应命中")
	}
}

// 灵智地址本身也带 /api/v3，靠地址判定时同样要命中 Ark 协议族。
func TestAnmiaoBaseURLFallsBackToArkChannel(t *testing.T) {
	channel := model.ModelChannel{Protocol: "ark", BaseURL: "https://api.lk888.ai/api/v3/anmiao"}
	if !isArkChannel(channel) {
		t.Fatal("灵智地址应被识别为 Ark 协议族")
	}
}

// 文档站与 API 域名不是同一个：文档站 lk666.ai 只返回网页，
// 误填后必须在发请求前拦下，否则现场只剩「接口没有返回任务 ID」。
func TestIsLingzhiDocHost(t *testing.T) {
	cases := map[string]bool{
		"https://lingzhiai.lk666.ai":               true,
		"https://lingzhiai.lk666.ai/apidoc":        true,
		"https://api.lk888.ai/api/v3/anmiao":       false,
		"https://api.lingkeai.ai/api/v3/anmiao":    false,
		"https://ark.cn-beijing.volces.com/api/v3": false,
		"":          false,
		"not-a-url": false,
	}
	for input, want := range cases {
		if got := IsLingzhiDocHost(input); got != want {
			t.Fatalf("IsLingzhiDocHost(%q) = %v，期望 %v", input, got, want)
		}
	}
}

// 2.5 系列 4~30 秒，2.0 系列 4~15 秒。
func TestAnmiaoDurationMax(t *testing.T) {
	cases := map[string]int{
		"seedance-2.5-guanfang-anmiao":  30,
		"doubao-seedance-2-5-260628":    30,
		"doubao-seedance-2-5-260628-xx": 30,
		"seedance-2.0-guanfang-anmiao":  15,
		"doubao-seedance-2-0-260128":    15,
		"":                              15,
	}
	for input, want := range cases {
		if got := AnmiaoDurationMax(input); got != want {
			t.Fatalf("AnmiaoDurationMax(%q) = %d，期望 %d", input, got, want)
		}
	}
}

// 灵智 Ark 通道只认火山真名（doubao-* / ep-*），计费 SKU 要被提前拦下。
func TestAnmiaoModelNameError(t *testing.T) {
	for _, name := range []string{"doubao-seedance-2-5-260628", "ep-20260101-abc", ""} {
		if got := AnmiaoModelNameError(name); got != "" {
			t.Fatalf("AnmiaoModelNameError(%q) 应放行，实际 = %q", name, got)
		}
	}
	for _, name := range []string{"seedance-2.5-guanfang-anmiao", "seedance-2.0-anci"} {
		if got := AnmiaoModelNameError(name); got == "" {
			t.Fatalf("AnmiaoModelNameError(%q) 应给出可操作提示", name)
		}
	}
}

// 错误码要能翻译成「该改什么」，不能只把英文 message 丢给用户。
func TestLingzhiErrorHint(t *testing.T) {
	if got := LingzhiErrorHint("invalid_api_key", "authentication_error"); got == "" {
		t.Fatal("invalid_api_key 应命中提示")
	}
	if got := LingzhiErrorHint("", "not_found"); got == "" {
		t.Fatal("仅给 type=not_found 时也应命中提示")
	}
	// 灵智参数类错误：code=InvalidParameter + type=BadRequest（文档「失败示例（400）」）。
	if got := LingzhiErrorHint("InvalidParameter", "BadRequest"); got == "" {
		t.Fatal("InvalidParameter / BadRequest 应命中参数提示")
	}
	if got := LingzhiErrorHint("InvalidParameter", ""); got == "" {
		t.Fatal("仅给 code=InvalidParameter 时也应命中提示")
	}
	if got := LingzhiErrorHint("BadRequest", ""); got == "" {
		t.Fatal("仅给 code=BadRequest 时也应命中提示")
	}
	if got := LingzhiErrorHint("SomethingElse", "UnknownType"); got != "" {
		t.Fatalf("未知错误码不应编造提示，实际 = %q", got)
	}
}
