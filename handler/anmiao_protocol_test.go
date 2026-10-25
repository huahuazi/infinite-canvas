package handler

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

// 灵智是火山方舟 Ark 的一种方言：任务接口与请求体结构完全同 Ark，
// 只是 model 名、duration 约束、素材引用与产物地址有几处差异。
// 显式选了「灵智」协议后，任务路径必须改写成 /contents/generations/tasks，
// 否则请求会打到 /videos 去，灵智那边直接 404。
func TestAnmiaoProtocolResolvesArkTaskPath(t *testing.T) {
	channel := model.ModelChannel{Protocol: "anmiao", BaseURL: "https://api.lk888.ai/api/v3/anmiao"}

	if !isArkSeedanceVideo(channel, "seedance-2.5-guanfang-anmiao") {
		t.Fatal("灵智协议应按 Ark 视频任务处理")
	}
	if got := resolveAIProxyPath(channel, "seedance-2.5-guanfang-anmiao", "/videos"); got != "/contents/generations/tasks" {
		t.Fatalf("创建任务路径 = %q，期望 /contents/generations/tasks", got)
	}
	if got := resolveAIProxyPath(channel, "seedance-2.5-guanfang-anmiao", "/videos/99936297"); got != "/contents/generations/tasks/99936297" {
		t.Fatalf("轮询路径 = %q，期望 /contents/generations/tasks/99936297", got)
	}
}

// 灵智协议渠道的 Base URL 必须原样保留 /anmiao 前缀，且不能被追加 /v1。
func TestAnmiaoProtocolURLKeepsPrefix(t *testing.T) {
	channel := model.ModelChannel{Protocol: "anmiao", BaseURL: "https://api.lk888.ai/api/v3/anmiao"}
	created := resolveAIProxyURL(channel, "seedance-2.5-guanfang-anmiao", "/contents/generations/tasks")
	want := "https://api.lk888.ai/api/v3/anmiao/contents/generations/tasks"
	if created != want {
		t.Fatalf("创建任务 URL = %q，期望 %q", created, want)
	}
}

// 显式选「灵智」协议时，即使 Base URL 没写 /anmiao 也按灵智处理
// （用户可能先选了协议再补地址），duration 约束等灵智专属规则必须生效。
func TestAnmiaoProtocolAppliesLinguizhiRules(t *testing.T) {
	channel := model.ModelChannel{Protocol: "anmiao", BaseURL: "https://api.lk888.ai/api/v3"}
	if !isAnmiaoVideoChannel(channel) {
		t.Fatal("显式 anmiao 协议应命中灵智专属处理")
	}
	body := []byte(`{"model":"doubao-seedance-2-5-260628","content":[{"type":"text","text":"x"}],"duration":-1,"watermark":true}`)
	normalized, _, err := normalizeVideoCreateBody(body, "application/json", "doubao-seedance-2-5-260628", channel, "/contents/generations/tasks")
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	if string(normalized) == string(body) {
		t.Fatal("灵智协议下 duration=-1 应被收敛、watermark 应被剥离")
	}
}

// 显式选了其它协议时，不该被灵智地址反向覆盖成灵智渠道。
func TestOtherProtocolNotOverriddenByAnmiaoBaseURL(t *testing.T) {
	channel := model.ModelChannel{Protocol: "openai", BaseURL: "https://api.lk888.ai/api/v3/anmiao"}
	if isAnmiaoVideoChannel(channel) {
		t.Fatal("显式选了 openai 协议，不该被地址反推成灵智渠道")
	}
}
