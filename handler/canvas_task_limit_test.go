package handler

import (
	"strings"
	"testing"
)

// 回归：旧实现用 io.LimitReader 直接截断，超限时不报错，
// 导致被截断的 JSON 被当成正常响应，最终表现为「图片接口没有返回图片」。
func TestReadLimitedBodyRejectsOversizedResponse(t *testing.T) {
	payload := strings.Repeat("a", 2048)
	if _, err := readLimitedBody(strings.NewReader(payload), 1024); err == nil {
		t.Fatal("超过上限时必须返回错误，不能静默截断")
	}
}

func TestReadLimitedBodyAllowsPayloadAtLimit(t *testing.T) {
	got, err := readLimitedBody(strings.NewReader(strings.Repeat("a", 1024)), 1024)
	if err != nil {
		t.Fatalf("恰好等于上限时不应报错：%v", err)
	}
	if len(got) != 1024 {
		t.Fatalf("读取长度 = %d，期望 1024", len(got))
	}
}

// 回归：响应体内的 Base64 图片原样入库会撑爆数据库 TEXT 字段，
// 写入失败又会让任务永远停在 processing，前端一直转圈拿不到图。
func TestSummarizeCanvasTaskResponseRedactsInlineImages(t *testing.T) {
	base64Image := strings.Repeat("A", 4096)
	summary := summarizeCanvasTaskResponse([]byte(`{"data":[{"b64_json":"` + base64Image + `"}],"created":1}`))
	if strings.Contains(summary, base64Image) {
		t.Fatal("摘要必须移除内联 Base64")
	}
	if !strings.Contains(summary, "redacted") {
		t.Fatalf("摘要应保留脱敏占位符，实际=%s", summary)
	}
	if !strings.Contains(summary, `"created":1`) {
		t.Fatalf("摘要应保留非图片字段，实际=%s", summary)
	}
}

func TestSummarizeCanvasTaskResponseKeepsImageURL(t *testing.T) {
	summary := summarizeCanvasTaskResponse([]byte(`{"data":[{"url":"https://example.com/a.png"}]}`))
	if !strings.Contains(summary, "https://example.com/a.png") {
		t.Fatalf("图片地址应原样保留，实际=%s", summary)
	}
}

func TestSummarizeCanvasTaskResponseHandlesNonJSON(t *testing.T) {
	if got := summarizeCanvasTaskResponse([]byte("<html>error</html>")); !strings.Contains(got, "unparsed response") {
		t.Fatalf("非 JSON 响应应给出长度摘要，实际=%s", got)
	}
}

// 回归：标准火山方舟 OpenAPI（/api/v3）此前不被识别，只认 Agent Plan（/api/plan/v3）。
func TestIsArkSeedanceVideoRecognizesBaseURLs(t *testing.T) {
	cases := []struct {
		name     string
		baseURL  string
		model    string
		expected bool
	}{
		{"标准 OpenAPI + 接入点 ID", "https://ark.cn-beijing.volces.com/api/v3", "ep-20250101-abcdef", true},
		{"标准 OpenAPI + 模型名", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seedance-2-5-260628", true},
		{"Agent Plan", "https://ark.cn-beijing.volces.com/api/plan/v3", "doubao-seedance-2.0", true},
		{"带尾斜杠", "https://ark.cn-beijing.volces.com/api/v3/", "doubao-seedance-2-5-260628", true},
		{"非 Ark 渠道", "https://api.kie.ai/api/v1", "kling-v3", false},
		{"非 Ark 渠道上的其他模型", "https://api.apimart.ai/v1", "grok-imagine-video", false},
	}
	for _, item := range cases {
		if got := isArkSeedanceVideo(item.baseURL, item.model); got != item.expected {
			t.Errorf("%s：isArkSeedanceVideo(%q, %q) = %v，期望 %v", item.name, item.baseURL, item.model, got, item.expected)
		}
	}
}
