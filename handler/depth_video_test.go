package handler

import (
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestDepthVideoChannelDetection(t *testing.T) {
	cases := []struct {
		name      string
		channel   model.ModelChannel
		wantWaves bool
	}{
		{
			name:      "显式 wavespeed 协议",
			channel:   model.ModelChannel{Protocol: "wavespeed", BaseURL: "https://api.wavespeed.ai"},
			wantWaves: true,
		},
		{
			name:      "没声明协议时按域名兜底识别 wavespeed",
			channel:   model.ModelChannel{BaseURL: "https://api.wavespeed.ai/api/v3"},
			wantWaves: true,
		},
		{
			name:    "显式声明 ark 时不能被地址反向覆盖",
			channel: model.ModelChannel{Protocol: "ark", BaseURL: "https://api.wavespeed.ai/api/v3"},
		},
		{
			name:    "普通 OpenAI 渠道不受影响",
			channel: model.ModelChannel{Protocol: "openai", BaseURL: "https://api.openai.com"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := service.IsWaveSpeedChannel(testCase.channel); got != testCase.wantWaves {
				t.Fatalf("IsWaveSpeedChannel = %v, want %v", got, testCase.wantWaves)
			}
		})
	}
}

func TestBuildModelChannelURLDepthChannels(t *testing.T) {
	cases := []struct {
		name    string
		channel model.ModelChannel
		path    string
		want    string
	}{
		{
			name:    "wavespeed 裸域名补齐 /api/v3",
			channel: model.ModelChannel{Protocol: "wavespeed", BaseURL: "https://api.wavespeed.ai"},
			path:    "/wavespeed-ai/depth-anything/video",
			want:    "https://api.wavespeed.ai/api/v3/wavespeed-ai/depth-anything/video",
		},
		{
			name:    "wavespeed 已带版本段时不重复拼接",
			channel: model.ModelChannel{Protocol: "wavespeed", BaseURL: "https://api.wavespeed.ai/api/v3"},
			path:    "/predictions/abc/result",
			want:    "https://api.wavespeed.ai/api/v3/predictions/abc/result",
		},
		{
			name:    "素材直传端点",
			channel: model.ModelChannel{Protocol: "wavespeed", BaseURL: "https://api.wavespeed.ai"},
			path:    "/media/uploads",
			want:    "https://api.wavespeed.ai/api/v3/media/uploads",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := service.BuildModelChannelURL(testCase.channel, testCase.path); got != testCase.want {
				t.Fatalf("BuildModelChannelURL = %q, want %q", got, testCase.want)
			}
		})
	}
}

// WaveSpeed 的 Base URL 天然带 /api/v3，绝不能被火山方舟的兜底判定抢走，
// 否则视频任务会被改写到 /contents/generations/tasks 并 404。
func TestArkSeedanceDetectionExcludesWaveSpeed(t *testing.T) {
	waveSpeed := model.ModelChannel{
		Protocol: "wavespeed",
		BaseURL:  "https://api.wavespeed.ai/api/v3",
	}
	if isArkSeedanceVideo(waveSpeed, "wavespeed-ai/seedance-video") {
		t.Fatal("wavespeed 渠道被误判成火山方舟")
	}
	// 真正的方舟渠道仍要命中，避免这条排除把老路径带坏。
	ark := model.ModelChannel{Protocol: "ark", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"}
	if !isArkSeedanceVideo(ark, "doubao-seedance-2-5-260628") {
		t.Fatal("火山方舟渠道的判定被破坏")
	}
}

func TestNormalizeWaveSpeedDepthBody(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
		fail bool
	}{
		{
			name: "只保留 video 字段",
			body: `{"model":"wavespeed-ai/depth-anything/video","video":"https://cdn.example.com/a.mp4","prompt":"x","size":"720p","seconds":"5"}`,
			want: `{"video":"https://cdn.example.com/a.mp4"}`,
		},
		{
			name: "兼容 image 字段携带视频",
			body: `{"model":"m","image":"https://cdn.example.com/b.mp4"}`,
			want: `{"video":"https://cdn.example.com/b.mp4"}`,
		},
		{
			name: "缺少视频地址时报错",
			body: `{"model":"m","prompt":"只有提示词"}`,
			fail: true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, contentType, err := normalizeWaveSpeedDepthBody([]byte(testCase.body), "application/json")
			if testCase.fail {
				if err == nil {
					t.Fatal("期望报错，实际通过")
				}
				return
			}
			if err != nil {
				t.Fatalf("意外报错：%v", err)
			}
			if contentType != "application/json" {
				t.Fatalf("contentType = %q", contentType)
			}
			if strings.TrimSpace(string(got)) != testCase.want {
				t.Fatalf("body = %s, want %s", got, testCase.want)
			}
		})
	}
}

func TestTransformWaveSpeedDepthPayload(t *testing.T) {
	t.Run("完成时把 outputs 摊平成 video_url", func(t *testing.T) {
		payload := `{"code":200,"message":"success","data":{"id":"pred-1","status":"completed","outputs":["https://cdn.example.com/depth.mp4"]}}`
		transformed, ok := transformWaveSpeedDepthPayload([]byte(payload))
		if !ok {
			t.Fatal("转换失败")
		}
		parsed := parseVideoTaskPayload(transformed, "wavespeed-ai/depth-anything/video")
		if parsed.UpstreamTaskID != "pred-1" {
			t.Fatalf("task id = %q", parsed.UpstreamTaskID)
		}
		if parsed.Status != "completed" {
			t.Fatalf("status = %q", parsed.Status)
		}
		if parsed.VideoURL != "https://cdn.example.com/depth.mp4" {
			t.Fatalf("video url = %q", parsed.VideoURL)
		}
	})

	t.Run("处理中没有产物时保持 processing", func(t *testing.T) {
		payload := `{"code":200,"data":{"id":"pred-2","status":"processing","outputs":[]}}`
		transformed, ok := transformWaveSpeedDepthPayload([]byte(payload))
		if !ok {
			t.Fatal("转换失败")
		}
		parsed := parseVideoTaskPayload(transformed, "wavespeed-ai/depth-anything/video")
		if parsed.Status != "processing" {
			t.Fatalf("status = %q, want processing", parsed.Status)
		}
		if parsed.VideoURL != "" {
			t.Fatalf("video url 应为空，实际 %q", parsed.VideoURL)
		}
	})

	t.Run("失败时带出上游错误信息", func(t *testing.T) {
		payload := `{"code":200,"data":{"id":"pred-3","status":"failed","outputs":[],"error":"video decode failed"}}`
		transformed, ok := transformWaveSpeedDepthPayload([]byte(payload))
		if !ok {
			t.Fatal("转换失败")
		}
		parsed := parseVideoTaskPayload(transformed, "wavespeed-ai/depth-anything/video")
		if parsed.Status != "failed" {
			t.Fatalf("status = %q", parsed.Status)
		}
		if !strings.Contains(parsed.Error, "video decode failed") {
			t.Fatalf("error = %q", parsed.Error)
		}
	})

	t.Run("created 视为排队中", func(t *testing.T) {
		transformed, _ := transformWaveSpeedDepthPayload([]byte(`{"code":200,"data":{"id":"pred-4","status":"created"}}`))
		parsed := parseVideoTaskPayload(transformed, "wavespeed-ai/depth-anything/video")
		if parsed.Status != "queued" {
			t.Fatalf("status = %q, want queued", parsed.Status)
		}
	})
}
