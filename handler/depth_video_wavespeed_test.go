package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

// WaveSpeed 只收 URL 时会自己回源拉素材，拉不动就报 4006（媒体时长读不出来）。
// 正确做法是走官方 /media/uploads：先取票据，再 PUT 字节，最后用 download_url 提交任务。
func TestUploadWaveSpeedMedia(t *testing.T) {
	var putCalled bool
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("上传方法 = %s，期望 PUT", r.Method)
		}
		// 票据本身就是凭证，带上 Authorization 会被官方拒绝。
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("PUT 不能带 Authorization，实际 %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "video/mp4" {
			t.Errorf("Content-Type = %q，期望 video/mp4", got)
		}
		putCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer storage.Close()

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3/media/uploads" {
			t.Errorf("票据路径 = %s，期望 /api/v3/media/uploads", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q", got)
		}
		var payload struct {
			Filename string `json:"filename"`
			Size     int    `json:"size"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload.Filename != "ref.mp4" || payload.Size != 4 {
			t.Errorf("票据参数不对: %+v", payload)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 200,
			"data": map[string]any{
				"download_url": "https://cdn.example.com/media/abc.mp4",
				"upload": map[string]any{
					"method":  "PUT",
					"url":     storage.URL + "/upload",
					"headers": map[string]string{"Content-Type": "video/mp4"},
				},
			},
		})
	}))
	defer api.Close()

	channel := model.ModelChannel{Protocol: "wavespeed", BaseURL: api.URL, APIKey: "test-key"}
	got, err := uploadWaveSpeedMedia(channel, "ref.mp4", []byte("fake"), "video/mp4")
	if err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if got != "https://cdn.example.com/media/abc.mp4" {
		t.Fatalf("download_url = %q", got)
	}
	if !putCalled {
		t.Fatal("没有执行 PUT 上传")
	}
}

func TestUploadWaveSpeedMediaRejectsEmptyPayload(t *testing.T) {
	channel := model.ModelChannel{Protocol: "wavespeed", BaseURL: "https://api.wavespeed.ai", APIKey: "k"}
	if _, err := uploadWaveSpeedMedia(channel, "ref.mp4", nil, "video/mp4"); err == nil {
		t.Fatal("空素材应报错")
	}
}

func TestParseWaveSpeedDepthSource(t *testing.T) {
	source, err := parseWaveSpeedDepthSource([]byte(`{"model":"m","video":"https://cdn.example.com/a.mp4"}`))
	if err != nil || source != "https://cdn.example.com/a.mp4" {
		t.Fatalf("source = %q, err = %v", source, err)
	}
	if _, err := parseWaveSpeedDepthSource([]byte(`{"model":"m"}`)); err == nil {
		t.Fatal("缺少 video 时应报错")
	}
}
