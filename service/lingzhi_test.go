package service

import "testing"

// 灵智文档站与 API 域名不是同一个：文档站 lk666.ai 只返回网页，
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
