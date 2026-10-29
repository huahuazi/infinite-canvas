package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

// 显式声明的类型必须压过关键词猜测。
// 用户场景：deepseek-flash 这种名字猜不出问题，但 gemini-2.5-flash 之类
// 会被前端当成图片模型，声明一次就永久生效。
func TestModelCapabilityPrefersDeclared(t *testing.T) {
	channels := []model.ModelChannel{{
		Models:            []string{"some-new-model"},
		ModelCapabilities: map[string]string{"some-new-model": "image"},
	}}
	if got := modelCapability(channels, "some-new-model"); got != capabilityImage {
		t.Fatalf("应使用声明值 image，实际 %q", got)
	}
}

// 没有声明时回退到关键词猜测，保证存量配置行为不变。
func TestModelCapabilityFallsBackToGuess(t *testing.T) {
	channels := []model.ModelChannel{{Models: []string{"gpt-image-2.5-sunburst"}}}
	if got := modelCapability(channels, "gpt-image-2.5-sunburst"); got != capabilityImage {
		t.Fatalf("无声明时应猜成 image，实际 %q", got)
	}
	if got := modelCapability(channels, "deepseek-flash"); got != capabilityText {
		t.Fatalf("deepseek-flash 应猜成 text，实际 %q", got)
	}
	if got := modelCapability(channels, "seedance-2.5-guanfang-anmiao"); got != capabilityVideo {
		t.Fatalf("seedance 应猜成 video，实际 %q", got)
	}
}

// 保存时要把类型表补全到与 models 一致：调用方没传也不能留半吊子状态。
func TestNormalizeModelChannelFillsCapabilities(t *testing.T) {
	channel := normalizeModelChannel(model.ModelChannel{
		Models:            []string{"deepseek-flash", "gpt-image-2.5-sunburst"},
		ModelCapabilities: map[string]string{"deepseek-flash": "text"},
	})
	if channel.ModelCapabilities["deepseek-flash"] != capabilityText {
		t.Fatalf("已有声明被覆盖: %v", channel.ModelCapabilities)
	}
	if channel.ModelCapabilities["gpt-image-2.5-sunburst"] != capabilityImage {
		t.Fatalf("缺失项应被猜测补全: %v", channel.ModelCapabilities)
	}
}

// 模型被删掉后，类型表里不该留残留。
func TestNormalizeModelChannelDropsStaleCapabilities(t *testing.T) {
	channel := normalizeModelChannel(model.ModelChannel{
		Models:            []string{"deepseek-flash"},
		ModelCapabilities: map[string]string{"deepseek-flash": "text", "removed-model": "video"},
	})
	if _, ok := channel.ModelCapabilities["removed-model"]; ok {
		t.Fatalf("已删除的模型不该留在类型表里: %v", channel.ModelCapabilities)
	}
}

// 非法类型值要收敛，不能让脏数据进库。
func TestNormalizeModelChannelRejectsBadCapability(t *testing.T) {
	channel := normalizeModelChannel(model.ModelChannel{
		Models:            []string{"deepseek-flash"},
		ModelCapabilities: map[string]string{"deepseek-flash": "聊天"},
	})
	if got := channel.ModelCapabilities["deepseek-flash"]; got != capabilityText {
		t.Fatalf("非法类型应回退到猜测结果 text，实际 %q", got)
	}
}

// 核心回归：视频模型不能继续当 defaultTextModel。
// 线上曾出现 defaultTextModel = seedance-2.5-guanfang-anmiao，
// 因为旧实现只校验「在不在列表里」，不校验类型。
func TestRepairDefaultModelChecksCapability(t *testing.T) {
	channels := []model.ModelChannel{{
		Models: []string{"seedance-2.5-guanfang-anmiao", "gpt-image-2.5-sunburst", "deepseek-flash"},
	}}
	available := []string{"seedance-2.5-guanfang-anmiao", "gpt-image-2.5-sunburst", "deepseek-flash"}

	textCheck := func(name string) bool { return modelCapability(channels, name) == capabilityText }
	got := repairDefaultModel("seedance-2.5-guanfang-anmiao", available, textCheck)
	if got != "deepseek-flash" {
		t.Fatalf("视频模型不该被当成 defaultTextModel，应换成 deepseek-flash，实际 %q", got)
	}

	videoCheck := func(name string) bool { return modelCapability(channels, name) == capabilityVideo }
	if got := repairDefaultModel("seedance-2.5-guanfang-anmiao", available, videoCheck); got != "seedance-2.5-guanfang-anmiao" {
		t.Fatalf("视频槽位应保留 seedance，实际 %q", got)
	}
}

// 合格的当前值不该被乱换。
func TestRepairDefaultModelKeepsValidCurrent(t *testing.T) {
	channels := []model.ModelChannel{{Models: []string{"deepseek-flash", "gpt-4o"}}}
	available := []string{"deepseek-flash", "gpt-4o"}
	textCheck := func(name string) bool { return modelCapability(channels, name) == capabilityText }
	if got := repairDefaultModel("gpt-4o", available, textCheck); got != "gpt-4o" {
		t.Fatalf("合格值被换掉了: %q", got)
	}
}
