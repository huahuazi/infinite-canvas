package handler

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

// Flatkey 复用火山方舟的请求体格式，但任务接口是标准的 /v1/videos。
// 上游对 seedance 系列会明确拒绝 /v1/generation/tasks：
//   {"code":"invalid_request","message":"this channel type is only available on /v1/videos and /v1/video/generations"}
// 所以路径必须原样透传，同时不能被 Ark 分支改写成 /contents/generations/tasks。
func TestResolveAIProxyPathFlatkeyKeepsStandardVideoPath(t *testing.T) {
	channel := model.ModelChannel{Protocol: "flatkey", BaseURL: "https://router.flatkey.ai/v1"}

	if got := resolveAIProxyPath(channel, "seedance-2.5", "/videos"); got != "/videos" {
		t.Fatalf("创建任务路径 = %q，期望 /videos", got)
	}
	if got := resolveAIProxyPath(channel, "seedance-2.5", "/videos/task-123"); got != "/videos/task-123" {
		t.Fatalf("轮询路径 = %q，期望 /videos/task-123", got)
	}
	if isArkSeedanceVideo(channel, "seedance-2.5") {
		t.Fatal("flatkey 渠道不应被判定为火山方舟，否则路径会被改写成 /contents/generations/tasks")
	}
	// 同一个渠道仍可复用 [OI] 生图等接口，非视频路径保持原样。
	if got := resolveAIProxyPath(channel, "seedance-2.5", "/images/generations"); got != "/images/generations" {
		t.Fatalf("生图路径 = %q，期望原样透传", got)
	}
}

// Flatkey 创建任务只返回 { id }。
func TestParseVideoTaskPayloadFlatkeyCreateResponse(t *testing.T) {
	parsed := parseVideoTaskPayload([]byte(`{"id":"task_abc"}`), "seedance-2.5")

	if parsed.UpstreamTaskID != "task_abc" {
		t.Fatalf("upstreamTaskID = %q，期望 task_abc", parsed.UpstreamTaskID)
	}
	if parsed.Status != "queued" {
		t.Fatalf("status = %q，期望 queued", parsed.Status)
	}
}

// Flatkey 的产物地址嵌在 content[] 数组里（content[].video_url.url），
// 与火山方舟的 content.video_url 对象结构不同，必须也能提取出来。
func TestParseVideoTaskPayloadExtractsFlatkeyContentVideoURL(t *testing.T) {
	payload := `{"id":"task_abc","model":"seedance-2.5","status":"succeeded",` +
		`"content":[{"type":"video_url","video_url":{"url":"https://cdn.flatkey.ai/v/abc.mp4"}}]}`

	parsed := parseVideoTaskPayload([]byte(payload), "seedance-2.5")

	if parsed.VideoURL != "https://cdn.flatkey.ai/v/abc.mp4" {
		t.Fatalf("video_url = %q，期望 https://cdn.flatkey.ai/v/abc.mp4", parsed.VideoURL)
	}
	if parsed.Status != "completed" {
		t.Fatalf("status = %q，期望 completed", parsed.Status)
	}
	if parsed.Progress != 100 {
		t.Fatalf("progress = %d，期望 100", parsed.Progress)
	}
}
