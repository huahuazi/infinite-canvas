package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

// 回归：列表接口曾回传每个画布的完整 project_data，画布内含内联 Base64 图片时
// 响应可达数 MB。摘要必须只含元数据与计数，绝不携带节点内容。
func TestSummarizeCanvasProjectDropsInlineContent(t *testing.T) {
	inlineImage := strings.Repeat("A", 200000)
	projectData := `{"id":"p1","title":"自己ppt","createdAt":"2026-09-03T09:58:31Z","updatedAt":"2026-09-05T13:13:56Z",` +
		`"nodes":[{"id":"n1","type":"image","metadata":{"content":"data:image/png;base64,` + inlineImage + `"}},{"id":"n2"}],` +
		`"connections":[{"id":"c1"}]}`

	summary := summarizeCanvasProject(model.CanvasProject{
		ID:          "p1",
		ProjectData: projectData,
		CreatedAt:   "2026-09-03T09:58:31Z",
		UpdatedAt:   "2026-09-05T13:13:56Z",
	})

	if summary.Title != "自己ppt" {
		t.Fatalf("title = %q，期望 自己ppt", summary.Title)
	}
	if summary.NodeCount != 2 {
		t.Fatalf("nodeCount = %d，期望 2", summary.NodeCount)
	}
	if summary.ConnectionCount != 1 {
		t.Fatalf("connectionCount = %d，期望 1", summary.ConnectionCount)
	}
	if summary.ContentLoaded {
		t.Fatal("摘要的 contentLoaded 必须为 false，否则前端会误判内容已加载")
	}

	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatalf("序列化摘要失败：%v", err)
	}
	if len(encoded) > 1024 {
		t.Fatalf("摘要体积 %d 字节，过大——内联内容可能泄漏进了摘要", len(encoded))
	}
	if strings.Contains(string(encoded), inlineImage[:64]) {
		t.Fatal("摘要中出现了内联图片数据")
	}
}

func TestSummarizeCanvasProjectToleratesInvalidData(t *testing.T) {
	summary := summarizeCanvasProject(model.CanvasProject{
		ID:          "broken",
		ProjectData: "<html>not json</html>",
		CreatedAt:   "2026-09-01T00:00:00Z",
		UpdatedAt:   "2026-09-02T00:00:00Z",
	})
	if summary.ID != "broken" {
		t.Fatalf("id = %q，期望 broken", summary.ID)
	}
	if summary.Title != "" || summary.NodeCount != 0 || summary.ConnectionCount != 0 {
		t.Fatalf("非法数据应退化为空元数据，实际 %+v", summary)
	}
	if summary.UpdatedAt != "2026-09-02T00:00:00Z" {
		t.Fatalf("updatedAt 应保留表字段值，实际 %q", summary.UpdatedAt)
	}
}

func TestSummarizeCanvasProjectHandlesEmptyArrays(t *testing.T) {
	summary := summarizeCanvasProject(model.CanvasProject{
		ID:          "empty",
		ProjectData: `{"id":"empty","title":"新画布","nodes":[],"connections":[]}`,
	})
	if summary.NodeCount != 0 || summary.ConnectionCount != 0 {
		t.Fatalf("空画布计数应为 0，实际 nodes=%d connections=%d", summary.NodeCount, summary.ConnectionCount)
	}
	if summary.Title != "新画布" {
		t.Fatalf("title = %q", summary.Title)
	}
}
