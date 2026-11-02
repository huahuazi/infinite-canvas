package handler

// 深度视频专用渠道适配：WaveSpeedAI 与 Hugging Face Gradio Space。
//
// 这两个渠道跑的是真正的单目深度估计模型（Video Depth Anything），
// 不是让视频生成模型「照着提示词画一张深度图」，因此请求形态、参数、
// 上游任务模型都与普通视频生成完全不同，必须独立适配。
//
//	WaveSpeed    标准 REST：POST /api/v3/{model} + GET /api/v3/predictions/{id}/result
//	HuggingFace  Gradio 协议：先 /gradio_api/upload 传文件，再 /gradio_api/call/{api} 取 event_id，
//	             最后用 SSE 监听 /gradio_api/call/{api}/{event_id}，没有「查任务」的 REST 语义。
//
// 因此 WaveSpeed 走既有 /videos 流程（只换路径、请求体与响应字段），
// HuggingFace 必须独立走一条创建 + 轮询流程。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const (
	// WaveSpeed 把模型 ID 直接写进路径：POST {base}/api/v3/{model}
	WaveSpeedDepthModelDefault = "wavespeed-ai/depth-anything/video"
	// Hugging Face Space 上的命名端点（官方 Video-Depth-Anything 演示）
	HuggingFaceDepthAPIName = "infer_video_depth"
	// 前端展示用的模型名，实际端点由 API name 决定
	HuggingFaceDepthModelDefault = "video-depth-anything"

	// 源视频与产物的大小上限，防止把整个容器磁盘写满
	depthVideoSourceMaxBytes  = 200 << 20
	depthVideoProductMaxBytes = 300 << 20

	// 单次 SSE 监听的等待窗口。Hugging Face 的 Space 用 ZeroGPU，
	// 任务本身可能排队几分钟，这里只等一小段，拿不到就交给下一轮轮询，
	// 不能把后端轮询协程卡死在一个连接上。
	huggingFaceSSEWait = 30 * time.Second
)

// -----------------------------------------------------------------------------
// WaveSpeed
// -----------------------------------------------------------------------------

// normalizeWaveSpeedDepthBody 把画布发来的 OpenAI 风格请求体收敛成 WaveSpeed 需要的形态。
// WaveSpeed 的深度模型只接受一个 video 字段，其余参数（prompt、size、seconds…）一律不收。
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
// Hugging Face Gradio Space
// -----------------------------------------------------------------------------

// huggingFaceDepthParams 是 Space 端点 infer_video_depth 的全部入参。
// 参数顺序必须与 Space 的 /info 完全一致，错一位上游会直接抛异常且不带错误详情。
//
//	predict(input_video, max_len, target_fps, max_res, grayscale, api_name="/infer_video_depth")
type huggingFaceDepthParams struct {
	VideoURL  string
	MaxLen    float64
	TargetFPS float64
	MaxRes    float64
	Grayscale bool
}

// parseHuggingFaceDepthParams 解析前端请求体。
// 默认值刻意偏保守：Space 单次 GPU 只有 240 秒，max_res 给 1280 时
// 只有几秒的素材能跑完，518 与模型内部 input_size 一致，速度最稳。
func parseHuggingFaceDepthParams(body []byte) (huggingFaceDepthParams, error) {
	params := huggingFaceDepthParams{
		MaxLen:    -1,
		TargetFPS: -1,
		MaxRes:    518,
		Grayscale: true,
	}
	var payload map[string]any
	if len(body) == 0 || json.Unmarshal(body, &payload) != nil {
		return params, errors.New("深度视频请求体不是合法 JSON")
	}
	params.VideoURL = readDepthVideoSourceURL(payload)
	if params.VideoURL == "" {
		return params, errors.New("深度视频需要一个可公网访问的视频地址（video 字段），当前请求里没有")
	}
	if value, ok := payload["max_len"]; ok {
		params.MaxLen = toFloatValue(value, params.MaxLen)
	}
	if value, ok := payload["target_fps"]; ok {
		params.TargetFPS = toFloatValue(value, params.TargetFPS)
	}
	if value, ok := payload["max_res"]; ok {
		params.MaxRes = toFloatValue(value, params.MaxRes)
	}
	if value, ok := payload["grayscale"]; ok {
		if flag, isBool := value.(bool); isBool {
			params.Grayscale = flag
		}
	}
	return params, nil
}

// huggingFaceSpaceBaseURL 把渠道地址归一成 `https://<owner>-<space>.hf.space` 形态。
// 用户经常直接粘浏览器地址栏的 https://huggingface.co/spaces/owner/space，
// 那个地址是网页，不是 API 根，必须换算成 Space 的真实域名。
func huggingFaceSpaceBaseURL(channel model.ModelChannel) string {
	baseURL := strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" {
		return baseURL
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.HasSuffix(host, ".hf.space") {
		return baseURL
	}
	if !strings.Contains(host, "huggingface.co") {
		return baseURL
	}
	// /spaces/{owner}/{space}
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	for index := 0; index+2 < len(segments); index++ {
		if strings.EqualFold(segments[index], "spaces") {
			owner := strings.ToLower(strings.TrimSpace(segments[index+1]))
			space := strings.ToLower(strings.TrimSpace(segments[index+2]))
			if owner != "" && space != "" {
				return fmt.Sprintf("https://%s-%s.hf.space", owner, space)
			}
		}
	}
	return baseURL
}

// submitHuggingFaceDepthVideo 完成「上传 → 调用」两步，返回 Gradio 的 event_id。
// Gradio 没有任务 ID 概念，event_id 就是后续 SSE 监听的凭据，因此直接当作上游任务号。
func submitHuggingFaceDepthVideo(channel model.ModelChannel, params huggingFaceDepthParams) (string, []byte, error) {
	spaceURL := huggingFaceSpaceBaseURL(channel)
	source, filename, err := downloadDepthVideoSource(channel, params.VideoURL)
	if err != nil {
		return "", nil, err
	}
	uploadPath, err := uploadGradioFile(channel, spaceURL, filename, source)
	if err != nil {
		return "", nil, err
	}
	payload := map[string]any{
		"data": []any{
			map[string]any{
				"path": uploadPath,
				"meta": map[string]any{"_type": "gradio.FileData"},
			},
			params.MaxLen,
			params.TargetFPS,
			params.MaxRes,
			params.Grayscale,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", nil, err
	}
	endpoint := spaceURL + "/gradio_api/call/" + HuggingFaceDepthAPIName
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	service.SetModelChannelAuthHeader(request, channel)
	response, status, err := doAIRequest(request, channel)
	if err != nil {
		return "", nil, err
	}
	if status >= http.StatusBadRequest {
		return "", response, fmt.Errorf("%s", readUpstreamAIErrorMessage(response, status))
	}
	var parsed struct {
		EventID string `json:"event_id"`
	}
	if err := json.Unmarshal(response, &parsed); err != nil || strings.TrimSpace(parsed.EventID) == "" {
		return "", response, errors.New("Hugging Face 没有返回 event_id，请检查 Space 是否仍在运行、模型名与 API 端点是否匹配")
	}
	return strings.TrimSpace(parsed.EventID), response, nil
}

// downloadDepthVideoSource 把公网视频取回内存，供 Gradio 的 multipart 上传使用。
// Gradio 的 upload 端点只收文件本体，不收 URL，所以必须先落地再传。
func downloadDepthVideoSource(channel model.ModelChannel, sourceURL string) ([]byte, string, error) {
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
		return nil, "", fmt.Errorf("源视频超过 %dMB，Hugging Face 无法接收", depthVideoSourceMaxBytes>>20)
	}
	if len(payload) == 0 {
		return nil, "", errors.New("源视频为空，请确认画布素材已经上传成功")
	}
	return payload, depthVideoSourceFilename(sourceURL, response.Header.Get("Content-Type")), nil
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

func uploadGradioFile(channel model.ModelChannel, spaceURL string, filename string, payload []byte) (string, error) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("files", filename)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(payload); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	request, err := http.NewRequest(http.MethodPost, spaceURL+"/gradio_api/upload", body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	service.SetModelChannelAuthHeader(request, channel)
	response, status, err := doAIRequest(request, channel)
	if err != nil {
		return "", err
	}
	if status >= http.StatusBadRequest {
		return "", fmt.Errorf("%s", readUpstreamAIErrorMessage(response, status))
	}
	var paths []string
	if err := json.Unmarshal(response, &paths); err != nil || len(paths) == 0 {
		return "", errors.New("Hugging Face 上传没有返回文件路径")
	}
	return strings.TrimSpace(paths[0]), nil
}

// pollHuggingFaceDepth 监听一次 SSE，把结果翻译成项目内部的轮询更新。
// Gradio 对已完成的 event 会重放整段消息，所以「读不到 complete」只代表还没好，
// 不应当作失败——交给下一轮即可。
func pollHuggingFaceDepth(channel model.ModelChannel, eventID string) (service.VideoTaskPollUpdate, []byte, error) {
	spaceURL := huggingFaceSpaceBaseURL(channel)
	endpoint := spaceURL + "/gradio_api/call/" + HuggingFaceDepthAPIName + "/" + url.PathEscape(eventID)
	ctx, cancel := context.WithTimeout(context.Background(), huggingFaceSSEWait)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return service.VideoTaskPollUpdate{}, nil, err
	}
	service.SetModelChannelAuthHeader(request, channel)

	client := &http.Client{Timeout: huggingFaceSSEWait + 5*time.Second}
	response, err := client.Do(request)
	if err != nil {
		// 超时表示任务还在跑，不是失败。
		if errors.Is(err, context.DeadlineExceeded) {
			return service.VideoTaskPollUpdate{Status: "processing"}, nil, nil
		}
		return service.VideoTaskPollUpdate{}, nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return service.VideoTaskPollUpdate{
			Status:      "failed",
			Error:       "Hugging Face 找不到这个任务（event 已过期或 Space 已重启），请重新提交",
			ErrorDetail: "gradio event 404",
		}, nil, nil
	}
	if response.StatusCode >= http.StatusBadRequest {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 32<<10))
		return service.VideoTaskPollUpdate{
			Status:      "failed",
			Error:       readUpstreamAIErrorMessage(payload, response.StatusCode),
			ErrorDetail: string(payload),
		}, payload, nil
	}
	eventName, data, raw := readGradioSSE(response.Body)
	switch eventName {
	case "complete":
		videoURL, extractErr := extractGradioDepthResult(spaceURL, data)
		if extractErr != nil {
			return service.VideoTaskPollUpdate{Status: "failed", Error: extractErr.Error(), ErrorDetail: raw}, []byte(raw), nil
		}
		// Space 的产物是临时文件（/tmp/gradio/...），必须转存到本地，
		// 否则 Space 重启或缓存清理后，画布上的视频会直接 404。
		localURL, persistErr := persistDepthVideo(channel, videoURL)
		if persistErr != nil {
			return service.VideoTaskPollUpdate{
				Status:      "completed",
				Progress:    100,
				VideoURL:    videoURL,
				ErrorDetail: fmt.Sprintf("产物转存失败，暂时使用上游临时地址：%v", persistErr),
			}, []byte(raw), nil
		}
		return service.VideoTaskPollUpdate{Status: "completed", Progress: 100, VideoURL: localURL}, []byte(raw), nil
	case "error":
		return service.VideoTaskPollUpdate{
			Status:      "failed",
			Error:       "Hugging Face Space 执行失败，常见原因是免费 GPU 配额已用完（每天 5 分钟）或排队超时",
			ErrorDetail: raw,
		}, []byte(raw), nil
	default:
		return service.VideoTaskPollUpdate{Status: "processing"}, []byte(raw), nil
	}
}

// readGradioSSE 读一段 Gradio 的 SSE 流，返回第一个 complete/error 事件。
// 流没结束时返回空事件名，由调用方当作「还在处理」。
func readGradioSSE(reader io.Reader) (string, []byte, string) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
	eventName := ""
	var dataLines []string
	var raw strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		raw.WriteString(line)
		raw.WriteString("\n")
		if strings.TrimSpace(line) == "" {
			if eventName == "complete" || eventName == "error" {
				return eventName, []byte(strings.Join(dataLines, "\n")), raw.String()
			}
			eventName = ""
			dataLines = nil
			continue
		}
		if value, ok := strings.CutPrefix(line, "event:"); ok {
			eventName = strings.TrimSpace(value)
			continue
		}
		if value, ok := strings.CutPrefix(line, "data:"); ok {
			dataLines = append(dataLines, strings.TrimSpace(value))
		}
	}
	return "", nil, raw.String()
}

// extractGradioDepthResult 从 complete 事件的 data 里取出深度视频地址。
// Space 有两个输出：Preprocessed video（预处理后的原片）与 Generated Depth Video，
// 深度视频是第二个，必须先按位置取，再退化成「找最后一个能解析出视频的项」。
func extractGradioDepthResult(spaceURL string, data []byte) (string, error) {
	var outputs []any
	if len(data) == 0 || json.Unmarshal(data, &outputs) != nil {
		return "", fmt.Errorf("Hugging Face 返回的结果不是合法 JSON：%s", truncateForMessage(string(data), 200))
	}
	// 部分 Gradio 版本会把 outputs 再包一层数组
	if len(outputs) == 1 {
		if inner, ok := outputs[0].([]any); ok && len(inner) > 0 {
			outputs = inner
		}
	}
	if len(outputs) >= 2 {
		if videoURL := extractGradioVideoURL(spaceURL, outputs[1]); videoURL != "" {
			return videoURL, nil
		}
	}
	for index := len(outputs) - 1; index >= 0; index-- {
		if videoURL := extractGradioVideoURL(spaceURL, outputs[index]); videoURL != "" {
			return videoURL, nil
		}
	}
	return "", errors.New("Hugging Face 任务完成了但没有返回视频地址")
}

func extractGradioVideoURL(spaceURL string, value any) string {
	switch typed := value.(type) {
	case string:
		return gradioFileURL(spaceURL, typed)
	case map[string]any:
		for _, key := range []string{"video", "url", "path", "name"} {
			if path := toStringSafe(typed[key]); path != "" {
				if resolved := gradioFileURL(spaceURL, path); resolved != "" {
					return resolved
				}
			}
		}
	case []any:
		for _, item := range typed {
			if resolved := extractGradioVideoURL(spaceURL, item); resolved != "" {
				return resolved
			}
		}
	}
	return ""
}

// gradioFileURL 把 Gradio 的服务器本地路径翻成可下载的文件地址。
// 注意下载端点是 /gradio_api/file=<path>，等号后面直接跟绝对路径，
// 不能做 PathEscape（会把斜杠转义掉，导致 404）。
func gradioFileURL(spaceURL string, path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return path
	}
	if !strings.Contains(path, "/") && filepath.Ext(path) == "" {
		return ""
	}
	return strings.TrimRight(spaceURL, "/") + "/gradio_api/file=" + path
}

// persistDepthVideo 把上游产物下载到本地参考素材目录，返回可直接播放的地址。
func persistDepthVideo(channel model.ModelChannel, sourceURL string) (string, error) {
	request, err := http.NewRequest(http.MethodGet, sourceURL, nil)
	if err != nil {
		return "", err
	}
	service.SetModelChannelAuthHeader(request, channel)
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		return "", fmt.Errorf("下载深度视频失败：HTTP %d", response.StatusCode)
	}
	if err := os.MkdirAll(referenceMediaDir(), 0o755); err != nil {
		return "", err
	}
	name := uuid.NewString() + ".mp4"
	targetPath := filepath.Join(referenceMediaDir(), name)
	target, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", err
	}
	// LimitReader 读满上限不报错，属于静默截断，必须用 +1 判断越界。
	written, copyErr := io.Copy(target, io.LimitReader(response.Body, depthVideoProductMaxBytes+1))
	closeErr := target.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(targetPath)
		return "", errors.Join(copyErr, closeErr)
	}
	if written > depthVideoProductMaxBytes {
		_ = os.Remove(targetPath)
		return "", fmt.Errorf("深度视频超过 %dMB", depthVideoProductMaxBytes>>20)
	}
	if written == 0 {
		_ = os.Remove(targetPath)
		return "", errors.New("深度视频下载为空")
	}
	relative := "/api/media/references/" + name
	if publicBase := strings.TrimRight(strings.TrimSpace(config.Cfg.PublicBaseURL), "/"); publicBase != "" {
		return publicBase + relative, nil
	}
	return relative, nil
}

// -----------------------------------------------------------------------------
// 创建任务（Hugging Face 独立流程）
// -----------------------------------------------------------------------------

// proxyHuggingFaceDepthVideoTask 处理 Hugging Face 深度视频的创建请求。
// 与标准 /videos 流程的差异：上游没有「提交后返回任务号」这一步，
// 必须先把视频传上去再拿 event_id，因此整段实现独立，不套用 resolveAIProxyPath。
func proxyHuggingFaceDepthVideoTask(
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
	params, err := parseHuggingFaceDepthParams(body)
	if err != nil {
		if credits > 0 {
			refundVideoCredits(user.ID, modelName, credits, "/videos")
		}
		saveAIProxyLog(logContext, 0, "", err.Error())
		Fail(w, err.Error())
		return
	}
	eventID, response, err := submitHuggingFaceDepthVideo(channel, params)
	if err != nil {
		if credits > 0 {
			refundVideoCredits(user.ID, modelName, credits, "/videos")
		}
		saveAIProxyLog(logContext, 0, string(response), err.Error())
		Fail(w, err.Error())
		return
	}
	// Hugging Face 侧已经开始排队，额度不能退：Space 的 GPU 时间是按提交消耗的。
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
		UpstreamTaskID:  eventID,
		Status:          "queued",
		RequestBody:     logContext.RequestBody,
		ResponseBody:    string(response),
		Credits:         credits,
	})
	if err != nil {
		log.Printf("save hugging face depth video task failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	saveAIProxyLog(logContext, http.StatusOK, string(response), "")
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

func toFloatValue(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		if parsed, err := typed.Float64(); err == nil {
			return parsed
		}
	case string:
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64); err == nil {
			return parsed
		}
	}
	return fallback
}

func truncateForMessage(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
