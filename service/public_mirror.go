package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
)

// 公共直链镜像：把本地素材 / 上游临时产物转存到公共文件托管，换一条外部可拉取的直链。
//
// 为什么需要它：火山方舟与灵智的参考视频只接受公网可访问 URL，
// 当前自建出口（PUBLIC_BASE_URL + /api/media/references）在
// 「域名只有 IPv6」「办公宽带上行被打满」「上游根本回源不到内网」这几种情况下会失败。
//
// 注意：这些托管服务是**公开可读**的，素材一旦上传就等于公开。
// 因此默认只在自建出口失败时兜底使用（PUBLIC_MIRROR_MODE=fallback）；
// 想强制全走公共托管，把 PUBLIC_BASE_URL 留空即可（自建出口会失败，自然落到这里），
// 完全不想用就设 PUBLIC_MIRROR_MODE=off。

var ErrPublicMirrorDisabled = errors.New("未启用公共直链镜像")

// PublicMirrorResult 是一次成功转存的结果。
type PublicMirrorResult struct {
	URL       string `json:"url"`
	Provider  string `json:"provider"`
	ExpiresIn int    `json:"expiresIn"` // 秒；0 表示托管方未承诺过期时间
}

// PublicMirrorAttempt 记录单个托管服务的失败原因，便于前端展示「都试过哪些」。
type PublicMirrorAttempt struct {
	Provider string `json:"provider"`
	Error    string `json:"error"`
}

// PublicMirrorError 是所有托管服务都失败时的聚合错误。
type PublicMirrorError struct {
	Attempts []PublicMirrorAttempt
}

func (err *PublicMirrorError) Error() string {
	if len(err.Attempts) == 0 {
		return "公共直链镜像失败"
	}
	parts := make([]string, 0, len(err.Attempts))
	for _, attempt := range err.Attempts {
		parts = append(parts, fmt.Sprintf("%s：%s", attempt.Provider, attempt.Error))
	}
	return "公共直链镜像全部失败（" + strings.Join(parts, "；") + "）"
}

// publicMirrorEndpoints 独立成变量，测试里可以指向 httptest。
//
// 2026-11-02 实测结论（决定了默认顺序）：
//   - x0.at    可用，512MB、保留 30~365 天、国内直连约 0.6MB/s、512MB 上限最宽
//   - uguu.se  可用，128MB、约 3 小时、国内直连约 0.5MB/s、HEAD 正常
//   - catbox   全站暂停上传（Uploads paused until I can resolve storage issues）
//   - litterbox 返回 Invalid uploader（与 catbox 同源，一并失效）
//   - 0x0.st   已关闭（公告：被 AI 机器人滥用，no ETA）
//   - tmpfiles 直链改为 /dl/<时间戳>.<hash>/<id>/<name>，旧解析会 302 回预览页
//
// 失效的四家实现保留：对方恢复后改一行配置就能用回来；未知名字本来就会被忽略。
var publicMirrorEndpoints = map[string]string{
	"x0at":      "https://x0.at",
	"uguu":      "https://uguu.se/upload?output=text",
	"catbox":    "https://catbox.moe/user/api.php",
	"litterbox": "https://litterbox.catbox.moe/resources/internals/api.php",
	"0x0st":     "https://0x0.st",
	"tmpfiles":  "https://tmpfiles.org/api/v1/upload",
}

type publicMirrorProvider struct {
	name      string
	endpoint  string
	fileField string
	fields    map[string]string
	expiresIn int
	parse     func([]byte) (string, error)
}

func newPublicMirrorProvider(name string) (publicMirrorProvider, bool) {
	endpoint, ok := publicMirrorEndpoints[name]
	if !ok {
		return publicMirrorProvider{}, false
	}
	switch name {
	case "catbox":
		return publicMirrorProvider{name: name, endpoint: endpoint, fileField: "fileToUpload", fields: map[string]string{"reqtype": "fileupload"}, parse: parsePlainMirrorURL}, true
	case "litterbox":
		// 1h 够上游拉取；太长等于把素材长期公开。
		return publicMirrorProvider{name: name, endpoint: endpoint, fileField: "fileToUpload", fields: map[string]string{"reqtype": "fileupload", "time": "1h"}, expiresIn: 3600, parse: parsePlainMirrorURL}, true
	case "0x0st", "x0at":
		// x0.at 是 0x0.st 的姊妹站，协议完全一致：file 字段 + 纯文本直链。
		return publicMirrorProvider{name: name, endpoint: endpoint, fileField: "file", parse: parsePlainMirrorURL}, true
	case "uguu":
		// uguu 默认返回 JSON，只有带 output=text 时才回一行纯文本 URL；
		// 字段名固定为 files[]（带方括号），写成 files 会被拒。
		return publicMirrorProvider{name: name, endpoint: endpoint, fileField: "files[]", expiresIn: 3 * 3600, parse: parsePlainMirrorURL}, true
	case "tmpfiles":
		return publicMirrorProvider{name: name, endpoint: endpoint, fileField: "file", expiresIn: 3600, parse: parseTmpfilesURL}, true
	default:
		return publicMirrorProvider{}, false
	}
}

// PublicMirrorMode 返回当前模式：off / fallback / always。
func PublicMirrorMode() string {
	mode := strings.ToLower(strings.TrimSpace(config.Cfg.PublicMirrorMode))
	if mode == "" {
		return "fallback"
	}
	return mode
}

// PublicMirrorProviders 返回启用的托管服务顺序；空表示功能关闭。
func PublicMirrorProviders() []string {
	switch PublicMirrorMode() {
	case "off", "disabled", "none":
		return nil
	}
	raw := strings.TrimSpace(config.Cfg.PublicMirrorProviders)
	if raw == "" {
		// 默认只用 2026-11 实测可用的两家；旧的 catbox / 0x0st / litterbox / tmpfiles
		// 已集体失效，留在默认列表里只会让每次兜底多等几轮超时。
		raw = "x0at,uguu"
	}
	result := []string{}
	seen := map[string]bool{}
	for _, item := range strings.Split(raw, ",") {
		name := strings.ToLower(strings.TrimSpace(item))
		if name == "" || seen[name] {
			continue
		}
		if _, ok := newPublicMirrorProvider(name); !ok {
			continue
		}
		seen[name] = true
		result = append(result, name)
	}
	return result
}

// UploadToPublicMirror 按配置顺序依次尝试，任一成功即返回。
func UploadToPublicMirror(ctx context.Context, filename string, contentType string, data []byte) (PublicMirrorResult, error) {
	providers := PublicMirrorProviders()
	if len(providers) == 0 {
		return PublicMirrorResult{}, ErrPublicMirrorDisabled
	}
	if len(data) == 0 {
		return PublicMirrorResult{}, errors.New("公共直链镜像失败：素材为空")
	}
	if strings.TrimSpace(filename) == "" {
		filename = "reference" + extensionForMirrorMimeType(contentType)
	}
	attempts := make([]PublicMirrorAttempt, 0, len(providers))
	for _, name := range providers {
		provider, ok := newPublicMirrorProvider(name)
		if !ok {
			continue
		}
		link, err := provider.upload(ctx, filename, contentType, data)
		if err != nil {
			attempts = append(attempts, PublicMirrorAttempt{Provider: name, Error: err.Error()})
			continue
		}
		return PublicMirrorResult{URL: link, Provider: name, ExpiresIn: provider.expiresIn}, nil
	}
	return PublicMirrorResult{}, &PublicMirrorError{Attempts: attempts}
}

func (provider publicMirrorProvider) upload(ctx context.Context, filename string, contentType string, data []byte) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range provider.fields {
		if err := writer.WriteField(key, value); err != nil {
			return "", err
		}
	}
	part, err := writer.CreateFormFile(provider.fileField, filename)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, provider.endpoint, &body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	// 0x0.st 对空 UA 会直接拒绝，统一给一个可识别的 UA。
	request.Header.Set("User-Agent", "infinite-canvas/1.0 (self-hosted; reference-mirror)")
	if contentType != "" {
		request.Header.Set("X-Content-Type", contentType)
	}
	// 超时给到 300 秒：参考视频上限 50MB，而这些托管都在境外，
	// 国内直连实测只有 0.5~0.7MB/s，90 秒传不完一个稍大的视频。
	client := &http.Client{Timeout: 300 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if response.StatusCode >= http.StatusBadRequest {
		message := strings.TrimSpace(string(payload))
		if len(message) > 160 {
			message = message[:160]
		}
		if message == "" {
			message = fmt.Sprintf("HTTP %d", response.StatusCode)
		}
		return "", errors.New(message)
	}
	return provider.parse(payload)
}

func parsePlainMirrorURL(payload []byte) (string, error) {
	text := strings.TrimSpace(string(payload))
	if text == "" {
		return "", errors.New("托管方返回空响应")
	}
	// 有些服务失败时也返回 200 + 一行错误文本，这里只认 http(s) 开头。
	fields := strings.Fields(text)
	if len(fields) > 0 && strings.HasPrefix(strings.ToLower(fields[0]), "http") {
		return fields[0], nil
	}
	if len(text) > 120 {
		text = text[:120]
	}
	return "", errors.New(text)
}

func parseTmpfilesURL(payload []byte) (string, error) {
	var decoded struct {
		Data struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return "", errors.New("托管方返回了无法解析的响应")
	}
	link := strings.TrimSpace(decoded.Data.URL)
	if link == "" {
		return "", errors.New("托管方没有返回直链")
	}
	// tmpfiles 给的是「预览页」地址，直链要在路径前面加 /dl。
	parsed, err := url.Parse(link)
	if err != nil || parsed.Host == "" {
		return "", errors.New("托管方返回的地址无效")
	}
	if !strings.HasPrefix(parsed.Path, "/dl/") {
		parsed.Path = "/dl" + parsed.Path
	}
	return parsed.String(), nil
}

func extensionForMirrorMimeType(contentType string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0])) {
	case "video/mp4":
		return ".mp4"
	case "video/quicktime":
		return ".mov"
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/wav", "audio/x-wav":
		return ".wav"
	default:
		return ".bin"
	}
}
