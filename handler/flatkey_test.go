package handler

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

// Flatkey 的视频任务协议与火山方舟同构，但任务路径是 /generation/tasks。
// 这里守住三件事：路径映射正确、不被 Ark 的 seedance 模型名判定抢走、其他接口原样透传。
func TestResolveAIProxyPathFlatkeyVideoTask(t *testing.T) {
	channel := model.ModelChannel{Protocol: "flatkey", BaseURL: "https://router.flatkey.ai/v1"}

	if got := resolveAIProxyPath(channel, "seedance-2.5", "/videos"); got != "/generation/tasks" {
		t.Fatalf("创建任务路径 = %q，期望 /generation/tasks", got)
	}
	if got := resolveAIProxyPath(channel, "seedance-2.5", "/videos/task-123"); got != "/generation/tasks/task-123" {
		t.Fatalf("轮询路径 = %q，期望 /generation/tasks/task-123", got)
	}
	if isArkSeedanceVideo(channel, "seedance-2.5") {
		t.Fatal("flatkey 渠道不应被判定为火山方舟，否则路径会变成 /contents/generations/tasks")
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
