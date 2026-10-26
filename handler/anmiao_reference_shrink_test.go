package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image/png"
	"strings"
	"testing"
)

// buildOversizedPNG 生成一张 PNG 大图，用来构造超过灵智 10MB 限制的参考图。
// PNG 无损、体积大，最容易复现用户报的「单文件解码后不能超过 10MB」。
func buildOversizedPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := noisyTestImage(width, height)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("构造 PNG 失败: %v", err)
	}
	return buf.Bytes()
}

func wrapAnmiaoBody(t *testing.T, imageURL string) []byte {
	t.Helper()
	body := map[string]any{
		"model": "doubao-seedance-2-5-260628",
		"content": []any{
			map[string]any{"type": "text", "text": "让画面动起来"},
			map[string]any{
				"type":      "image_url",
				"role":      "reference_image",
				"image_url": map[string]any{"url": imageURL},
			},
		},
		"duration": 4,
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("构造请求体失败: %v", err)
	}
	return encoded
}

func readContentImageURL(t *testing.T, body []byte) string {
	t.Helper()
	var payload struct {
		Content []struct {
			Type     string `json:"type"`
			ImageURL struct {
				URL string `json:"url"`
			} `json:"image_url"`
		} `json:"content"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("解析返回体失败: %v", err)
	}
	for _, item := range payload.Content {
		if item.Type == "image_url" {
			return item.ImageURL.URL
		}
	}
	t.Fatal("返回体里找不到 image_url")
	return ""
}

// 用户场景：参考图解码后超过 10MB，灵智直接 400。必须压到限制内。
func TestShrinkAnmiaoReferenceImagesCompressesOversized(t *testing.T) {
	raw := buildOversizedPNG(t, 2600, 3600)
	t.Logf("原图 PNG %d 字节（%.2f MB），灵智上限 %d", len(raw), float64(len(raw))/(1<<20), anmiaoReferenceImageMaxBytes)
	if len(raw) <= anmiaoReferenceImageMaxBytes {
		t.Skipf("测试图只有 %.2f MB，未超上限，跳过", float64(len(raw))/(1<<20))
	}

	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)
	body := wrapAnmiaoBody(t, dataURL)

	shrunk, err := shrinkAnmiaoReferenceImages(body)
	if err != nil {
		t.Fatalf("压缩失败: %v", err)
	}
	resultURL := readContentImageURL(t, shrunk)
	if !strings.HasPrefix(resultURL, "data:image/jpeg;base64,") {
		t.Fatalf("应转为 JPEG 内联，实际前缀: %.40s", resultURL)
	}
	decoded, err := base64.StdEncoding.DecodeString(resultURL[strings.Index(resultURL, ",")+1:])
	if err != nil {
		t.Fatalf("压缩结果 base64 解析失败: %v", err)
	}
	t.Logf("压缩后 %d 字节（%.2f MB）", len(decoded), float64(len(decoded))/(1<<20))
	if len(decoded) > anmiaoReferenceImageMaxBytes {
		t.Fatalf("压缩后 %d 字节仍超上限 %d", len(decoded), anmiaoReferenceImageMaxBytes)
	}
	// 其余字段必须原样保留。
	var payload map[string]any
	if err := json.Unmarshal(shrunk, &payload); err != nil {
		t.Fatalf("返回体不是合法 JSON: %v", err)
	}
	if payload["duration"].(float64) != 4 {
		t.Fatalf("duration 被改动: %v", payload["duration"])
	}
	if payload["model"] != "doubao-seedance-2-5-260628" {
		t.Fatalf("model 被改动: %v", payload["model"])
	}
}

// 未超限的图不该被重新编码（无损原图被转 JPEG 会白掉画质）。
func TestShrinkAnmiaoReferenceImagesKeepsSmallImage(t *testing.T) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, noisyTestImage(320, 320)); err != nil {
		t.Fatalf("构造 PNG 失败: %v", err)
	}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	body := wrapAnmiaoBody(t, dataURL)
	shrunk, err := shrinkAnmiaoReferenceImages(body)
	if err != nil {
		t.Fatalf("处理失败: %v", err)
	}
	if got := readContentImageURL(t, shrunk); got != dataURL {
		t.Fatal("小图不该被改动")
	}
	if string(shrunk) != string(body) {
		t.Fatal("无改动时应原样返回原 body")
	}
}

// 公网 URL 与 asset:// 必须原样放行——它们不受内联体积限制。
func TestShrinkAnmiaoReferenceImagesLeavesURLsAlone(t *testing.T) {
	for _, url := range []string{
		"https://example.com/a.png",
		"asset://abc123",
	} {
		body := wrapAnmiaoBody(t, url)
		shrunk, err := shrinkAnmiaoReferenceImages(body)
		if err != nil {
			t.Fatalf("%s 处理失败: %v", url, err)
		}
		if string(shrunk) != string(body) {
			t.Fatalf("%s 不该被改动", url)
		}
	}
}

// 非 JSON / 没有 content 的请求体必须安全返回，不能报错打断主流程。
func TestShrinkAnmiaoReferenceImagesToleratesUnexpectedBody(t *testing.T) {
	cases := [][]byte{
		nil,
		[]byte("not json"),
		[]byte(`{"model":"x"}`),
		[]byte(`{"content":"not-an-array"}`),
	}
	for _, body := range cases {
		got, err := shrinkAnmiaoReferenceImages(body)
		if err != nil {
			t.Fatalf("不该报错: %v（body=%s）", err, body)
		}
		if string(got) != string(body) {
			t.Fatalf("应原样返回，body=%s", body)
		}
	}
}
