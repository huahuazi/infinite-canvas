package handler

import (
	"strings"
	"testing"
)

// 回归：火山方舟 succeeded 响应的产物地址在 content.video_url 里（嵌套），
// findFirstHTTPURL 的 key 清单漏掉 content 会导致 completed 任务的 video_url 一直为空，
// 前端节点永远拿不到视频。
func TestParseVideoTaskPayloadExtractsArkContentVideoURL(t *testing.T) {
	payload := `{"id":"cgt-20260917130921-6jrae","model":"doubao-seedance-2-5-260628","status":"succeeded",` +
		`"created_at":1789621761,"updated_at":1789621762,"service_tier":"default",` +
		`"content":{"video_url":"https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-5/2129774526/output.mp4"},` +
		`"generate_audio":false,"draft":false,"priority":0,"output_format":"mp4"}`

	parsed := parseVideoTaskPayload([]byte(payload), "doubao-seedance-2-5-260628")

	if parsed.VideoURL != "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-5/2129774526/output.mp4" {
		t.Fatalf("video_url = %q，期望产物地址", parsed.VideoURL)
	}
	if parsed.Status != "completed" {
		t.Fatalf("status = %q，期望 completed", parsed.Status)
	}
	if parsed.Progress != 100 {
		t.Fatalf("progress = %d，期望 100", parsed.Progress)
	}
	if parsed.UpstreamTaskID != "cgt-20260917130921-6jrae" {
		t.Fatalf("upstreamTaskID = %q", parsed.UpstreamTaskID)
	}
}

func TestParseVideoTaskPayloadRunningTaskHasNoURL(t *testing.T) {
	payload := `{"id":"cgt-x","status":"running","service_tier":"default","output_format":"mp4"}`

	parsed := parseVideoTaskPayload([]byte(payload), "doubao-seedance-2-5-260628")

	if parsed.VideoURL != "" {
		t.Fatalf("running 任务不应有 video_url，实际 %q", parsed.VideoURL)
	}
	if parsed.Status != "processing" {
		t.Fatalf("status = %q，期望 processing", parsed.Status)
	}
}

func TestParseVideoTaskPayloadStillHandlesFlatURLs(t *testing.T) {
	// 其他渠道（OpenAI 风格）是顶层 video_url，不能被本次修复破坏。
	payload := `{"id":"task-1","status":"succeeded","video_url":"https://cdn.example.com/v.mp4"}`

	parsed := parseVideoTaskPayload([]byte(payload), "some-openai-video-model")

	if parsed.VideoURL != "https://cdn.example.com/v.mp4" {
		t.Fatalf("video_url = %q，期望 https://cdn.example.com/v.mp4", parsed.VideoURL)
	}
	if parsed.Status != "completed" {
		t.Fatalf("status = %q，期望 completed", parsed.Status)
	}
	if !strings.HasPrefix(parsed.VideoURL, "https://") {
		t.Fatalf("video_url 应为 https 链接")
	}
}
