package handler

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestDepthVideoChannelDetection(t *testing.T) {
	cases := []struct {
		name        string
		channel     model.ModelChannel
		wantWaves   bool
		wantHugging bool
	}{
		{
			name:      "显式 wavespeed 协议",
			channel:   model.ModelChannel{Protocol: "wavespeed", BaseURL: "https://api.wavespeed.ai"},
			wantWaves: true,
		},
		{
			name:        "显式 huggingface 协议",
			channel:     model.ModelChannel{Protocol: "huggingface", BaseURL: "https://depth-anything-video-depth-anything.hf.space"},
			wantHugging: true,
		},
		{
			name:      "没声明协议时按域名兜底识别 wavespeed",
			channel:   model.ModelChannel{BaseURL: "https://api.wavespeed.ai/api/v3"},
			wantWaves: true,
		},
		{
			name:        "没声明协议时按 hf.space 兜底识别 huggingface",
			channel:     model.ModelChannel{BaseURL: "https://demo-test.hf.space"},
			wantHugging: true,
		},
		{
			name:        "huggingface.co 页面地址也算 huggingface",
			channel:     model.ModelChannel{BaseURL: "https://huggingface.co/spaces/depth-anything/Video-Depth-Anything"},
			wantHugging: true,
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
			if got := service.IsHuggingFaceChannel(testCase.channel); got != testCase.wantHugging {
				t.Fatalf("IsHuggingFaceChannel = %v, want %v", got, testCase.wantHugging)
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
			name:    "huggingface 不能补 /v1",
			channel: model.ModelChannel{Protocol: "huggingface", BaseURL: "https://demo-test.hf.space"},
			path:    "/gradio_api/upload",
			want:    "https://demo-test.hf.space/gradio_api/upload",
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
func TestArkSeedanceDetectionExcludesDepthChannels(t *testing.T) {
	waveSpeed := model.ModelChannel{
		Protocol: "wavespeed",
		BaseURL:  "https://api.wavespeed.ai/api/v3",
	}
	if isArkSeedanceVideo(waveSpeed, "wavespeed-ai/seedance-video") {
		t.Fatal("wavespeed 渠道被误判成火山方舟")
	}
	huggingFace := model.ModelChannel{
		Protocol: "huggingface",
		BaseURL:  "https://demo-test.hf.space",
	}
	if isArkSeedanceVideo(huggingFace, "video-depth-anything") {
		t.Fatal("huggingface 渠道被误判成火山方舟")
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

func TestParseHuggingFaceDepthParams(t *testing.T) {
	params, err := parseHuggingFaceDepthParams([]byte(`{"model":"video-depth-anything","video":"https://cdn.example.com/a.mp4"}`))
	if err != nil {
		t.Fatalf("意外报错：%v", err)
	}
	if params.MaxLen != -1 || params.TargetFPS != -1 {
		t.Fatalf("默认值应为 -1（全部帧 / 原帧率），实际 maxLen=%v fps=%v", params.MaxLen, params.TargetFPS)
	}
	if params.MaxRes != 518 {
		t.Fatalf("默认 max_res 应为 518（与模型 input_size 一致），实际 %v", params.MaxRes)
	}
	if !params.Grayscale {
		t.Fatal("默认应输出灰度")
	}

	overridden, err := parseHuggingFaceDepthParams([]byte(`{"video":"https://cdn.example.com/a.mp4","max_len":100,"target_fps":15,"max_res":714,"grayscale":false}`))
	if err != nil {
		t.Fatalf("意外报错：%v", err)
	}
	if overridden.MaxLen != 100 || overridden.TargetFPS != 15 || overridden.MaxRes != 714 || overridden.Grayscale {
		t.Fatalf("参数覆盖未生效：%+v", overridden)
	}

	if _, err := parseHuggingFaceDepthParams([]byte(`{"model":"m"}`)); err == nil {
		t.Fatal("缺少 video 时应报错")
	}
}

func TestReadGradioSSE(t *testing.T) {
	stream := "event: generating\n" +
		"data: {\"msg\":\"step 1\"}\n\n" +
		"event: complete\n" +
		"data: [{\"video\":\"/tmp/gradio/a_src.mp4\"},{\"video\":\"/tmp/gradio/a_vis.mp4\"}]\n\n"
	eventName, data, raw := readGradioSSE(strings.NewReader(stream))
	if eventName != "complete" {
		t.Fatalf("event = %q, want complete（event: %q）", eventName, raw)
	}
	if !strings.Contains(string(data), "a_vis.mp4") {
		t.Fatalf("data = %s", data)
	}

	// 流还在跑：没有 complete 时应返回空事件名
	running := "event: generating\ndata: {\"msg\":\"still working\"}\n\n"
	if name, _, _ := readGradioSSE(strings.NewReader(running)); name != "" {
		t.Fatalf("未完成时不应返回事件名，实际 %q", name)
	}

	// 错误事件
	failed := "event: error\ndata: null\n\n"
	if name, _, _ := readGradioSSE(strings.NewReader(failed)); name != "error" {
		t.Fatalf("event = %q, want error", name)
	}
}

func TestExtractGradioDepthResult(t *testing.T) {
	spaceURL := "https://demo-test.hf.space"
	// 两个输出：先原片后深度，必须取第二个
	data := `[{"video":"/tmp/gradio/a_src.mp4"},{"video":"/tmp/gradio/a_vis.mp4"}]`
	got, err := extractGradioDepthResult(spaceURL, []byte(data))
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if got != spaceURL+"/gradio_api/file=/tmp/gradio/a_vis.mp4" {
		t.Fatalf("got %q", got)
	}

	// 只有一路输出时退化成取最后一个可用项
	single := `[{"video":"/tmp/gradio/only.mp4"}]`
	if got, err := extractGradioDepthResult(spaceURL, []byte(single)); err != nil || !strings.HasSuffix(got, "only.mp4") {
		t.Fatalf("单输出解析失败：%q %v", got, err)
	}

	// 已经是完整 URL 时不再拼接
	if got, _ := extractGradioDepthResult(spaceURL, []byte(`[null,{"video":"https://cdn.example.com/d.mp4"}]`)); got != "https://cdn.example.com/d.mp4" {
		t.Fatalf("完整 URL 被改写：%q", got)
	}

	if _, err := extractGradioDepthResult(spaceURL, []byte(`[]`)); err == nil {
		t.Fatal("空结果应报错")
	}
}

func TestHuggingFaceSpaceBaseURL(t *testing.T) {
	pageURL := model.ModelChannel{BaseURL: "https://huggingface.co/spaces/depth-anything/Video-Depth-Anything"}
	if got := huggingFaceSpaceBaseURL(pageURL); got != "https://depth-anything-video-depth-anything.hf.space" {
		t.Fatalf("页面地址换算 = %q", got)
	}
	spaceURL := model.ModelChannel{BaseURL: "https://demo-test.hf.space"}
	if got := huggingFaceSpaceBaseURL(spaceURL); got != "https://demo-test.hf.space" {
		t.Fatalf("Space 地址被改写 = %q", got)
	}
}

// 保证 HuggingFace 参数顺序与 Space 的 /info 一致：
// predict(input_video, max_len, target_fps, max_res, grayscale)
func TestHuggingFaceParamsOrder(t *testing.T) {
	params := huggingFaceDepthParams{VideoURL: "https://cdn.example.com/a.mp4", MaxLen: 100, TargetFPS: 15, MaxRes: 714, Grayscale: true}
	payload := map[string]any{
		"data": []any{
			map[string]any{"path": "/tmp/gradio/a.mp4", "meta": map[string]any{"_type": "gradio.FileData"}},
			params.MaxLen,
			params.TargetFPS,
			params.MaxRes,
			params.Grayscale,
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Data []any `json:"data"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Data) != 5 {
		t.Fatalf("参数个数 = %d, want 5", len(decoded.Data))
	}
	if decoded.Data[1].(float64) != 100 || decoded.Data[2].(float64) != 15 || decoded.Data[3].(float64) != 714 || decoded.Data[4].(bool) != true {
		t.Fatalf("参数顺序不对：%v", decoded.Data)
	}
}
