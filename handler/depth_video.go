package handler

// 深度视频（WaveSpeedAI）渠道适配。
//
// 跑的是真正的单目深度估计模型（Video Depth Anything），
// 不是让视频生成模型「照着提示词画一张深度图」，因此请求形态与普通视频生成完全不同。
//
// 流程：读源视频（自家素材直接读磁盘）→ 走官方 /media/uploads 直传到 WaveSpeed 存储
// → 用返回的 download_url 提交任务 → 轮询 /predictions/{id}/result。
//
// 为什么必须直传：只提交 URL 时 WaveSpeed 会自己回源拉取，遇到网络/证书问题就报
// `4006 Could not read the duration of the provided media`（官方对 4006 的定义是
// 「媒体时长读不出来」）。直传把文件推到它的存储里，完全不依赖对方能否访问我们域名。
//
// 历史：曾同时支持 Hugging Face Gradio Space（官方 Video-Depth-Anything 演示），
// 但该 Space 自 2026-08 起报 Zero GPU Worker Error 且作者未修复，已按需求移除。

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const (
	// WaveSpeed 把模型 ID 直接写进路径：POST {base}/api/v3/{model}
	WaveSpeedDepthModelDefault = "wavespeed-ai/depth-anything/video"

	// 素材大小上限，防止把磁盘和上游带宽打满
	depthVideoSourceMaxBytes = 200 << 20
)

// -----------------------------------------------------------------------------
// WaveSpeed 请求体与响应
// -----------------------------------------------------------------------------

// normalizeWaveSpeedDepthBody 把画布发来的 OpenAI 风格请求体收敛成 WaveSpeed 需要的形态。
// 深度模型只接受一个 video 字段，其余参数（prompt、size、seconds…）一律不收。
//
// 注意：创建任务实际走 proxyWaveSpeedDepthVideoTask（要先直传素材），
// 这个函数保留给纯文本转换场景与测试使用。
func normalizeWaveSpeedDepthBody(body []byte, contentType string) ([]byte, string, error) {
	var payload map[string]any
	if len(body) == 0 || json.Unmarshal(body, &payload) != nil {
		return nil, "", errors.New("深度视频请求体不是合法 JSON")
	}
	videoURL := readDepthVideoSourceURL(payload)
	if videoURL == "" {
		return nil, "", errors.New("深度视频需要一个可公网访问的视频地址（video 字段），当前请求里没有")
	}
	normalized, err := json.Marshal(map[string]any{"video": videoURL})
	if err != nil {
		return nil, "", err
	}
	return normalized, "application/json", nil
}

// transformWaveSpeedDepthPayload 把 WaveSpeed 的信封摊平成项目内部统一字段。
// 上游形态：{"code":200,"message":"success","data":{"id":"...","status":"completed","outputs":["https://..."]}}
// 内部形态：{"id":"...","status":"completed","video_url":"https://..."}
//
// 注意 outputs 是数组，而 findFirstHTTPURL 的白名单里没有 outputs，
// 不在这里提前转成 video_url，产物地址会被解析成空。
func transformWaveSpeedDepthPayload(payload []byte) ([]byte, bool) {
	var root map[string]any
	if len(payload) == 0 || json.Unmarshal(payload, &root) != nil {
		return nil, false
	}
	data, _ := root["data"].(map[string]any)
	if data == nil {
		data = root
	}
	result := map[string]any{
		"id":     toStringSafe(data["id"]),
		"status": toStringSafe(data["status"]),
	}
	if outputs, ok := data["outputs"].([]any); ok {
		for _, item := range outputs {
			if videoURL := findFirstHTTPURL(item); videoURL != "" {
				result["video_url"] = videoURL
				break
			}
		}
	}
	if message := toStringSafe(data["error"]); message != "" {
		result["error"] = message
	}
	if message := toStringSafe(root["message"]); message != "" {
		result["message"] = message
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, false
	}
	return encoded, true
}

// -----------------------------------------------------------------------------
// 素材读取（自家出口直接读磁盘）
// -----------------------------------------------------------------------------

// downloadDepthVideoSource 把源视频取回来，供直传使用。
func downloadDepthVideoSource(channel model.ModelChannel, sourceURL string) ([]byte, string, error) {
	// 先判断是不是本项目自己的素材出口：是的话磁盘里就有，直接读。
	// 容器内解析自家域名经常拿到内网 IPv6 + 反代的内部证书，Go 会直接报
	// x509: certificate is not valid for any names；而且公网绕一圈纯属浪费。
	if path, ok := localReferenceMediaPath(sourceURL); ok {
		if payload, err := os.ReadFile(path); err == nil && len(payload) > 0 {
			if int64(len(payload)) > depthVideoSourceMaxBytes {
				return nil, "", fmt.Errorf("源视频超过 %dMB，无法上传", depthVideoSourceMaxBytes>>20)
			}
			return payload, filepath.Base(path), nil
		}
	}
	request, err := http.NewRequest(http.MethodGet, sourceURL, nil)
	if err != nil {
		return nil, "", fmt.Errorf("深度视频的源视频地址不可用：%v", err)
	}
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return nil, "", fmt.Errorf("下载深度视频的源视频失败：%v", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		return nil, "", fmt.Errorf("下载深度视频的源视频失败：HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, depthVideoSourceMaxBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("读取源视频失败：%v", err)
	}
	if int64(len(payload)) > depthVideoSourceMaxBytes {
		return nil, "", fmt.Errorf("源视频超过 %dMB，无法上传", depthVideoSourceMaxBytes>>20)
	}
	if len(payload) == 0 {
		return nil, "", errors.New("源视频为空，请确认画布素材已经上传成功")
	}
	return payload, depthVideoSourceFilename(sourceURL, response.Header.Get("Content-Type")), nil
}

// localReferenceMediaPath 判断源地址是不是本项目自己的素材出口
// （{PUBLIC_BASE_URL}/api/media/references/{id}），是的话返回本地磁盘路径。
//
// 为什么要短路：容器内解析自家域名会拿到内网 IPv6 地址，反代在那条链路返回的是
// 没有 SAN 的内部证书，Go 直接报 `x509: certificate is not valid for any names`；
// 而文件本来就在 /app/data/reference-media 里，读磁盘又快又稳。
func localReferenceMediaPath(sourceURL string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(sourceURL))
	if err != nil {
		return "", false
	}
	const prefix = "/api/media/references/"
	if !strings.HasPrefix(parsed.Path, prefix) {
		return "", false
	}
	id := strings.TrimPrefix(parsed.Path, prefix)
	// 与 ReferenceMedia handler 保持一致的路径安全校验，防止 ../ 穿越。
	if id == "" || id != filepath.Base(id) || strings.Contains(id, "..") {
		return "", false
	}
	return filepath.Join(referenceMediaDir(), id), true
}

func depthVideoSourceFilename(sourceURL string, contentType string) string {
	name := "input.mp4"
	if parsed, err := url.Parse(sourceURL); err == nil {
		if base := filepath.Base(parsed.Path); base != "" && base != "." && base != "/" {
			name = base
		}
	}
	if ext := filepath.Ext(name); ext == "" {
		switch {
		case strings.Contains(contentType, "quicktime"):
			name += ".mov"
		case strings.Contains(contentType, "webm"):
			name += ".webm"
		default:
			name += ".mp4"
		}
	}
	return name
}

// -----------------------------------------------------------------------------
// WaveSpeed 素材直传
// -----------------------------------------------------------------------------

// uploadWaveSpeedMedia 把素材直传到 WaveSpeed 存储，返回可直接喂给模型的 download_url。
//
// 官方流程：先 POST /media/uploads 取一次性票据，再 PUT 字节到票据地址，
// 最后拿 data.download_url 当模型输入。字节直达存储，不经过「能不能访问你域名」这一环。
func uploadWaveSpeedMedia(channel model.ModelChannel, filename string, payload []byte, contentType string) (string, error) {
	if len(payload) == 0 {
		return "", errors.New("源视频为空，无法上传到 WaveSpeed")
	}
	ticketPayload, err := json.Marshal(map[string]any{
		"filename":     filename,
		"size":         len(payload),
		"content_type": contentType,
	})
	if err != nil {
		return "", err
	}
	endpoint := service.BuildModelChannelURL(channel, "/media/uploads")
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(ticketPayload))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	service.SetModelChannelAuthHeader(request, channel)
	response, status, err := doAIRequest(request, channel)
	if err != nil {
		return "", err
	}
	if status >= http.StatusBadRequest {
		return "", fmt.Errorf("%s", readUpstreamAIErrorMessage(response, status))
	}
	var ticket struct {
		Data struct {
			DownloadURL string `json:"download_url"`
			Upload      struct {
				Method  string            `json:"method"`
				URL     string            `json:"url"`
				Headers map[string]string `json:"headers"`
			} `json:"upload"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response, &ticket); err != nil {
		return "", errors.New("WaveSpeed 上传票据解析失败")
	}
	if ticket.Data.Upload.URL == "" || ticket.Data.DownloadURL == "" {
		return "", errors.New("WaveSpeed 没有返回上传地址，请检查 access key 与上传配额")
	}
	method := strings.ToUpper(strings.TrimSpace(ticket.Data.Upload.Method))
	if method == "" {
		method = http.MethodPut
	}
	putRequest, err := http.NewRequest(method, ticket.Data.Upload.URL, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	for key, value := range ticket.Data.Upload.Headers {
		putRequest.Header.Set(key, value)
	}
	// 注意：票据本身就是一次性凭证，PUT 时绝不能带 Authorization（官方明确禁止）。
	putClient := &http.Client{Timeout: 300 * time.Second}
	putResponse, err := putClient.Do(putRequest)
	if err != nil {
		return "", fmt.Errorf("上传素材到 WaveSpeed 失败：%v", err)
	}
	defer putResponse.Body.Close()
	if putResponse.StatusCode >= http.StatusBadRequest {
		detail, _ := io.ReadAll(io.LimitReader(putResponse.Body, 4<<10))
		return "", fmt.Errorf("上传素材到 WaveSpeed 失败：HTTP %d %s", putResponse.StatusCode, truncateForMessage(string(detail), 160))
	}
	return ticket.Data.DownloadURL, nil
}

// -----------------------------------------------------------------------------
// 创建任务
// -----------------------------------------------------------------------------

// parseWaveSpeedDepthSource 取出请求体里的源视频地址。
func parseWaveSpeedDepthSource(body []byte) (string, error) {
	var payload map[string]any
	if len(body) == 0 || json.Unmarshal(body, &payload) != nil {
		return "", errors.New("深度视频请求体不是合法 JSON")
	}
	source := readDepthVideoSourceURL(payload)
	if source == "" {
		return "", errors.New("深度视频需要一个视频素材（video 字段），当前请求里没有")
	}
	return source, nil
}

// proxyWaveSpeedDepthVideoTask 处理 WaveSpeed 深度视频的创建请求。
// 因为要「先直传素材、再提交任务」，无法套用只改 body 的通用 /videos 流程。
func proxyWaveSpeedDepthVideoTask(
	w http.ResponseWriter,
	r *http.Request,
	user model.AuthUser,
	userChannelID string,
	channel model.ModelChannel,
	modelName string,
	body []byte,
	credits int,
	startedAt time.Time,
) {
	logContext := aiLogContext{
		StartedAt:       startedAt,
		Endpoint:        "/videos",
		Method:          http.MethodPost,
		Model:           modelName,
		Channel:         channel,
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Credits:         credits,
		RequestBody:     summarizeAIRequest(body, "application/json"),
	}
	failWithRefund := func(message string, response []byte) {
		if credits > 0 {
			refundVideoCredits(user.ID, modelName, credits, "/videos")
		}
		saveAIProxyLog(logContext, 0, string(response), message)
		Fail(w, message)
	}
	source, err := parseWaveSpeedDepthSource(body)
	if err != nil {
		failWithRefund(err.Error(), nil)
		return
	}
	payload, filename, err := downloadDepthVideoSource(channel, source)
	if err != nil {
		failWithRefund(err.Error(), nil)
		return
	}
	mimeType := "video/mp4"
	if ext := strings.ToLower(filepath.Ext(filename)); ext == ".mov" {
		mimeType = "video/quicktime"
	}
	downloadURL, err := uploadWaveSpeedMedia(channel, filename, payload, mimeType)
	if err != nil {
		failWithRefund(err.Error(), nil)
		return
	}
	submitBody, err := json.Marshal(map[string]any{"video": downloadURL})
	if err != nil {
		failWithRefund(err.Error(), nil)
		return
	}
	upstreamModel := strings.TrimPrefix(strings.TrimSpace(service.UpstreamModelName(channel, modelName)), "/")
	endpoint := service.BuildModelChannelURL(channel, "/"+upstreamModel)
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(submitBody))
	if err != nil {
		failWithRefund("AI 接口请求失败", nil)
		return
	}
	request.Header.Set("Content-Type", "application/json")
	service.SetModelChannelAuthHeader(request, channel)
	response, status, err := doAIRequest(request, channel)
	if err != nil {
		failWithRefund("AI 接口请求失败", nil)
		return
	}
	if status >= http.StatusBadRequest {
		failWithRefund(readUpstreamAIErrorMessage(response, status), response)
		return
	}
	transformed := response
	if normalized, ok := transformWaveSpeedDepthPayload(response); ok {
		transformed = normalized
	}
	if message := readVideoCreateErrorMessage(response, transformed, channel, modelName); message != "" {
		failWithRefund(message, response)
		return
	}
	parsed := parseVideoTaskPayload(transformed, modelName)
	if parsed.UpstreamTaskID == "" && parsed.UpstreamVideoID == "" {
		failWithRefund("视频接口没有返回任务 ID", transformed)
		return
	}
	task, err := service.CreateVideoTask(service.VideoTaskCreateInput{
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Model:           modelName,
		ChannelID:       channel.ID,
		UserChannelID:   userChannelID,
		ChannelName:     channel.Name,
		Source:          readVideoTaskSource(r),
		SourceID:        readVideoTaskSourceID(r),
		ClientTaskID:    readClientVideoTaskID(r),
		UpstreamTaskID:  parsed.UpstreamTaskID,
		UpstreamVideoID: parsed.UpstreamVideoID,
		Status:          parsed.Status,
		Progress:        parsed.Progress,
		Seconds:         parsed.Seconds,
		Size:            parsed.Size,
		VideoURL:        parsed.VideoURL,
		Error:           parsed.Error,
		ErrorDetail:     parsed.ErrorDetail,
		RequestBody:     logContext.RequestBody,
		ResponseBody:    string(transformed),
		Credits:         credits,
	})
	if err != nil {
		log.Printf("save wave speed depth video task failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	saveAIProxyLog(logContext, status, string(transformed), "")
	OK(w, service.VideoTaskResponse(task))
}

// -----------------------------------------------------------------------------
// 共用小工具
// -----------------------------------------------------------------------------

// readDepthVideoSourceURL 从请求体里找源视频地址。
// 画布既可能把视频放在 video 字段，也可能沿用 image 字段（老结构），都要认。
func readDepthVideoSourceURL(payload map[string]any) string {
	for _, key := range []string{"video", "video_url", "videoUrl", "reference_video", "referenceVideo", "image", "image_url"} {
		value, exists := payload[key]
		if !exists {
			continue
		}
		if sourceURL := findFirstHTTPURL(value); sourceURL != "" {
			return sourceURL
		}
	}
	return ""
}

func truncateForMessage(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
