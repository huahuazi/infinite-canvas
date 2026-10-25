package handler

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strings"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/service"
)

// publicMirrorMaxBytes 是单次镜像允许的最大体积，与素材出口保持一致（视频 50MB 上限再多留余量）。
const publicMirrorMaxBytes = 80 << 20

// UploadPublicMirror 把素材转存到公共文件托管，换一条上游可拉取的直链。
//
// 两种入参：
//   - multipart/form-data：本地文件（字段名 file）
//   - application/json：{"url":"https://...","filename":"可选"}，由后端带 SSRF 防护去下载
//
// 隐私提示：这些托管服务是公开可读的，仅应在自建出口不可用时作为兜底使用。
func UploadPublicMirror(w http.ResponseWriter, r *http.Request) {
	if len(service.PublicMirrorProviders()) == 0 {
		Fail(w, "未启用公共直链镜像：如需兜底请设置 PUBLIC_MIRROR_MODE=fallback 或 always")
		return
	}
	contentType := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type")))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		uploadPublicMirrorFile(w, r)
		return
	}
	// 远程地址模式只用于「生成结果」兜底，默认关闭（成片可能含客户素材）。
	if !config.Cfg.PublicMirrorResults {
		Fail(w, "未启用生成结果镜像：如需保活成片链接，请设置 PUBLIC_MIRROR_RESULTS=true")
		return
	}
	uploadPublicMirrorRemote(w, r)
}

func uploadPublicMirrorFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, publicMirrorMaxBytes+1)
	if err := r.ParseMultipartForm(publicMirrorMaxBytes); err != nil {
		Fail(w, "参考素材过大或上传格式不正确")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请上传需要镜像的素材文件")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, publicMirrorMaxBytes+1))
	if err != nil {
		Fail(w, "参考素材读取失败")
		return
	}
	if len(data) == 0 {
		Fail(w, "参考素材为空")
		return
	}
	filename := strings.TrimSpace(header.Filename)
	mimeType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = mirrorMimeTypeByFilename(filename)
	}
	if message := checkMirrorSize(mimeType, int64(len(data))); message != "" {
		Fail(w, message)
		return
	}
	result, err := service.UploadToPublicMirror(r.Context(), filename, mimeType, data)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

func uploadPublicMirrorRemote(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		URL      string `json:"url"`
		Filename string `json:"filename"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
		Fail(w, "请求格式不正确")
		return
	}
	target := strings.TrimSpace(payload.URL)
	parsed, err := url.Parse(target)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		Fail(w, "请提供 http(s) 素材地址")
		return
	}
	// 走带 SSRF 防护的客户端：内网 / 回环地址在这里就会被拦下，避免拿本站当中转打内网。
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		Fail(w, "素材地址无效")
		return
	}
	response, err := service.SafeProxyHTTPClient().Do(request)
	if err != nil {
		Fail(w, "素材下载失败："+err.Error())
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		Fail(w, "素材下载失败：远端返回 "+response.Status)
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, publicMirrorMaxBytes+1))
	if err != nil {
		Fail(w, "素材下载失败")
		return
	}
	if len(data) == 0 {
		Fail(w, "素材下载失败：内容为空")
		return
	}
	mimeType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = mirrorMimeTypeByFilename(parsed.Path)
	}
	if message := checkMirrorSize(mimeType, int64(len(data))); message != "" {
		Fail(w, message)
		return
	}
	filename := strings.TrimSpace(payload.Filename)
	if filename == "" {
		filename = path.Base(parsed.Path)
	}
	if filename == "" || filename == "/" || filename == "." {
		filename = "reference"
	}
	result, err := service.UploadToPublicMirror(r.Context(), filename, mimeType, data)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

func checkMirrorSize(mimeType string, bytes int64) string {
	limit := int64(0)
	switch {
	case strings.HasPrefix(mimeType, "video/"):
		limit = referenceVideoMaxBytes
	case strings.HasPrefix(mimeType, "image/"):
		limit = referenceImageMaxBytes
	case strings.HasPrefix(mimeType, "audio/"):
		limit = referenceAudioMaxBytes
	}
	if limit > 0 && bytes > limit {
		return referenceMediaSizeMessage(mimeType)
	}
	if bytes > publicMirrorMaxBytes {
		return "参考素材超过 80MB，无法转存到公共托管"
	}
	return ""
}

func mirrorMimeTypeByFilename(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		return ""
	}
	if mimeType := mime.TypeByExtension(ext); mimeType != "" {
		return strings.Split(mimeType, ";")[0]
	}
	return mimeTypeByReferenceMediaExt(ext)
}
