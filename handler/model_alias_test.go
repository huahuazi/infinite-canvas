package handler

import (
	"encoding/json"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

// 灵智（lk888.ai）按秒计费通道的兼容性问题：
//  1. 对外暴露的计费 SKU（seedance-2.5-guanfang-anmiao）不是 Ark 接口认的真名，
//     请求体 model 必须是 doubao-seedance-2-5-260628，否则上游直接 400。
//  2. base_url 的 /anmiao 前缀必须保留 —— 之前 normalizeModelChannelBaseURL
//     看到 "/api/v3/" 就截断，会把它砍成 /api/v3，打到错误的节点。
//  3. duration 不接受 -1（智能时长），必须给具体整数秒。
//  4. 不支持 asset:// 素材引用；seed/watermark 等参数收下但不生效。

func anmiaoChannel() model.ModelChannel {
	return model.ModelChannel{
		Protocol:     "ark",
		BaseURL:      "https://api.lk888.ai/api/v3/anmiao",
		Models:       []string{"seedance-2.5-guanfang-anmiao"},
		ModelAliases: map[string]string{"seedance-2.5-guanfang-anmiao": "doubao-seedance-2-5-260628"},
	}
}

func TestAnmiaoChannelURLKeepsPrefix(t *testing.T) {
	channel := anmiaoChannel()
	created := resolveAIProxyURL(channel, "seedance-2.5-guanfang-anmiao", "/contents/generations/tasks")
	want := "https://api.lk888.ai/api/v3/anmiao/contents/generations/tasks"
	if created != want {
		t.Fatalf("创建任务 URL = %q，期望 %q（/anmiao 不能被吃掉，也不能被追加 /v1）", created, want)
	}
	polled := resolveAIProxyURL(channel, "seedance-2.5-guanfang-anmiao", "/contents/generations/tasks/99936297")
	wantPoll := "https://api.lk888.ai/api/v3/anmiao/contents/generations/tasks/99936297"
	if polled != wantPoll {
		t.Fatalf("轮询 URL = %q，期望 %q", polled, wantPoll)
	}
	if !isArkSeedanceVideo(channel, "seedance-2.5-guanfang-anmiao") {
		t.Fatal("灵智渠道应按 Ark 协议处理，任务路径需改写成 /contents/generations/tasks")
	}
	if !service.IsAnmiaoChannel(channel) {
		t.Fatal("应识别为灵智按秒计费通道")
	}
}

// 误粘完整任务路径时仍要能裁回基础地址，但不能连 /anmiao 一起裁掉。
func TestAnmiaoChannelURLTrimsPastedTaskPath(t *testing.T) {
	channel := model.ModelChannel{Protocol: "ark", BaseURL: "https://api.lk888.ai/api/v3/anmiao/contents/generations/tasks"}
	got := resolveAIProxyURL(channel, "seedance-2.5", "/contents/generations/tasks")
	want := "https://api.lk888.ai/api/v3/anmiao/contents/generations/tasks"
	if got != want {
		t.Fatalf("归一化后 URL = %q，期望 %q", got, want)
	}
}

func TestAnmiaoModelAliasRewritesModelField(t *testing.T) {
	channel := anmiaoChannel()
	body := []byte(`{"model":"seedance-2.5-guanfang-anmiao","content":[{"type":"text","text":"海边金毛犬"}],"duration":8,"resolution":"720p","ratio":"16:9"}`)
	normalized, contentType, err := normalizeVideoCreateBody(body, "application/json", "seedance-2.5-guanfang-anmiao", channel, "/contents/generations/tasks")
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	if contentType != "application/json" {
		t.Fatalf("contentType = %q，期望保持 application/json", contentType)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatalf("解析改写后的请求体失败: %v", err)
	}
	if got := payload["model"]; got != "doubao-seedance-2-5-260628" {
		t.Fatalf("model = %v，期望 doubao-seedance-2-5-260628", got)
	}
	if got := payload["duration"]; got != float64(8) {
		t.Fatalf("duration = %v，期望原样保留 8", got)
	}
	if got := payload["resolution"]; got != "720p" {
		t.Fatalf("resolution = %v，期望原样保留 720p", got)
	}
}

// 没有配置映射时必须原样透传，不能擅自改写火山官方渠道的 model。
func TestModelAliasAbsentKeepsOriginalModel(t *testing.T) {
	channel := model.ModelChannel{Protocol: "ark", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"}
	body := []byte(`{"model":"doubao-seedance-2-5-260628","duration":8}`)
	normalized, _, err := normalizeVideoCreateBody(body, "application/json", "doubao-seedance-2-5-260628", channel, "/contents/generations/tasks")
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatalf("解析改写后的请求体失败: %v", err)
	}
	if got := payload["model"]; got != "doubao-seedance-2-5-260628" {
		t.Fatalf("model = %v，期望保持 doubao-seedance-2-5-260628", got)
	}
	if _, ok := payload["seed"]; ok {
		t.Fatal("火山官方渠道的 seed 参数不应被剥离")
	}
}

// duration=-1 在按秒通道会被上游 400，必须收敛成具体秒数。
func TestAnmiaoClampsSmartDuration(t *testing.T) {
	channel := anmiaoChannel()
	body := []byte(`{"model":"seedance-2.5-guanfang-anmiao","content":[{"type":"text","text":"x"}],"duration":-1}`)
	normalized, _, err := normalizeVideoCreateBody(body, "application/json", "seedance-2.5-guanfang-anmiao", channel, "/contents/generations/tasks")
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatalf("解析改写后的请求体失败: %v", err)
	}
	if got := payload["duration"]; got != float64(anmiaoDefaultDurationSeconds) {
		t.Fatalf("duration = %v，期望收敛为 %d", got, anmiaoDefaultDurationSeconds)
	}
}

// 字符串形式的 "-1" 也要拦住（前端 config.videoSeconds 就是字符串）。
func TestAnmiaoClampsStringSmartDuration(t *testing.T) {
	channel := anmiaoChannel()
	body := []byte(`{"model":"seedance-2.5-guanfang-anmiao","duration":"-1"}`)
	normalized, _, err := normalizeVideoCreateBody(body, "application/json", "seedance-2.5-guanfang-anmiao", channel, "/contents/generations/tasks")
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatalf("解析改写后的请求体失败: %v", err)
	}
	if got := payload["duration"]; got != float64(anmiaoDefaultDurationSeconds) {
		t.Fatalf("duration = %v，期望收敛为 %d", got, anmiaoDefaultDurationSeconds)
	}
}

// 明确秒数不该被动。
func TestAnmiaoKeepsExplicitDuration(t *testing.T) {
	channel := anmiaoChannel()
	body := []byte(`{"model":"seedance-2.5-guanfang-anmiao","duration":12}`)
	normalized, _, err := normalizeVideoCreateBody(body, "application/json", "seedance-2.5-guanfang-anmiao", channel, "/contents/generations/tasks")
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatalf("解析改写后的请求体失败: %v", err)
	}
	if got := payload["duration"]; got != float64(12) {
		t.Fatalf("duration = %v，期望保持 12", got)
	}
}

// asset:// 是火山素材库的账号级授权引用，中转站无法透传，必须剥掉。
func TestAnmiaoStripsAssetReferences(t *testing.T) {
	channel := anmiaoChannel()
	body := []byte(`{"model":"seedance-2.5-guanfang-anmiao","content":[{"type":"text","text":"x"},{"type":"image_url","image_url":{"url":"asset://asset-abc123"},"role":"first_frame"}]}`)
	normalized, _, err := normalizeVideoCreateBody(body, "application/json", "seedance-2.5-guanfang-anmiao", channel, "/contents/generations/tasks")
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatalf("解析改写后的请求体失败: %v", err)
	}
	items, _ := payload["content"].([]any)
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if _, exists := entry["image_url"]; exists {
			t.Fatalf("asset:// 素材引用应被剥离，实际 content = %v", items)
		}
	}
}

// 灵智对 seed/watermark/generate_audio 等「收下但不生效」，发了徒增被强校验拒绝的风险。
func TestAnmiaoStripsInertFields(t *testing.T) {
	channel := anmiaoChannel()
	body := []byte(`{"model":"seedance-2.5-guanfang-anmiao","duration":8,"seed":123,"watermark":true,"generate_audio":false,"service_tier":"flex"}`)
	normalized, _, err := normalizeVideoCreateBody(body, "application/json", "seedance-2.5-guanfang-anmiao", channel, "/contents/generations/tasks")
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatalf("解析改写后的请求体失败: %v", err)
	}
	for _, field := range []string{"seed", "watermark", "generate_audio", "service_tier"} {
		if _, ok := payload[field]; ok {
			t.Fatalf("%s 在灵智通道应被剥离，实际请求体 = %v", field, payload)
		}
	}
}

// 火山官方渠道必须保留全部可选参数，否则会破坏既有能力（flex 离线推理等）。
func TestOfficialArkKeepsOptionalFields(t *testing.T) {
	channel := model.ModelChannel{Protocol: "ark", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"}
	body := []byte(`{"model":"doubao-seedance-2-5-260628","duration":8,"seed":123,"service_tier":"flex","generate_audio":true,"content":[{"type":"image_url","image_url":{"url":"asset://asset-abc"},"role":"first_frame"}]}`)
	normalized, _, err := normalizeVideoCreateBody(body, "application/json", "doubao-seedance-2-5-260628", channel, "/contents/generations/tasks")
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatalf("解析改写后的请求体失败: %v", err)
	}
	for _, field := range []string{"seed", "service_tier", "generate_audio"} {
		if _, ok := payload[field]; !ok {
			t.Fatalf("火山官方渠道的 %s 不应被剥离，实际请求体 = %v", field, payload)
		}
	}
	items, _ := payload["content"].([]any)
	found := false
	for _, item := range items {
		if entry, ok := item.(map[string]any); ok {
			if holder, ok := entry["image_url"].(map[string]any); ok {
				if url, _ := holder["url"].(string); url == "asset://asset-abc" {
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatal("火山官方渠道的 asset:// 素材引用应原样保留")
	}
}

// 非 JSON 请求体（表单上传）不应被改写，避免破坏 multipart 结构。
func TestModelAliasSkipsNonJSONBody(t *testing.T) {
	channel := anmiaoChannel()
	body := []byte("--boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nseedance-2.5-guanfang-anmiao\r\n--boundary--")
	got, err := applyChannelModelAlias(body, "multipart/form-data", channel)
	if err != nil {
		t.Fatalf("改写请求体失败: %v", err)
	}
	if string(got) != string(body) {
		t.Fatal("multipart 请求体不应被改写")
	}
}

// 非法 JSON 放行给上游处理，避免本地先失败导致错误信息失真。
func TestModelAliasKeepsBrokenJSON(t *testing.T) {
	channel := anmiaoChannel()
	body := []byte("{not json")
	got, err := applyChannelModelAlias(body, "application/json", channel)
	if err != nil {
		t.Fatalf("非法 JSON 不应返回错误: %v", err)
	}
	if string(got) != string(body) {
		t.Fatal("非法 JSON 应原样放行")
	}
}

// 配置的映射值指向的 model 也要能命中（大小写不敏感）。
func TestUpstreamModelNameCaseInsensitive(t *testing.T) {
	channel := anmiaoChannel()
	if got := upstreamModelNameForTest(channel, "Seedance-2.5-Guanfang-Anmiao"); got != "doubao-seedance-2-5-260628" {
		t.Fatalf("大小写不同也应命中映射，实际 = %q", got)
	}
	if got := upstreamModelNameForTest(channel, "doubao-seedance-2-5-260628"); got != "doubao-seedance-2-5-260628" {
		t.Fatalf("未配置映射的名字应原样返回，实际 = %q", got)
	}
}

func upstreamModelNameForTest(channel model.ModelChannel, modelName string) string {
	body := []byte(`{"model":"` + modelName + `"}`)
	got, err := applyChannelModelAlias(body, "application/json", channel)
	if err != nil {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		return ""
	}
	name, _ := payload["model"].(string)
	return name
}
