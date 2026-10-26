package handler

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

// 灵智对参考图有单独的体积限制：单文件**解码后**不能超过 10MB，超了直接 400
// （`字段 images[0] 的文件过大`）。这与火山官方的 64MB 请求体上限完全不是一回事，
// 所以只按请求体大小判断会放行，然后被上游拒。
const anmiaoReferenceImageMaxBytes = 10 << 20

// 压缩目标留出余量：判断用 10MB，实际压到 8MB，避免边界值反复被拒。
const anmiaoReferenceImageTargetBytes = 8 << 20

// shrinkAnmiaoReferenceImages 把灵智请求体里超限的 Base64 参考图压到限制以内。
//
// 前端 arkReferenceImageUrl 优先把图片转存成公网 URL，失败才内联 Base64；
// 一旦走内联且图片偏大就会撞这条限制。前端压缩依赖浏览器已加载最新脚本，
// 页面停在旧 chunk 时不执行，因此这里做兜底，保证任何客户端都能出片。
func shrinkAnmiaoReferenceImages(body []byte) ([]byte, error) {
	if len(body) == 0 {
		return body, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body, nil
	}
	content, ok := payload["content"].([]any)
	if !ok {
		return body, nil
	}
	changed := false
	for _, item := range content {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		imageURL, ok := entry["image_url"].(map[string]any)
		if !ok {
			continue
		}
		raw, ok := imageURL["url"].(string)
		if !ok {
			continue
		}
		shrunken, ok := shrinkAnmiaoDataURLImage(raw)
		if !ok {
			continue
		}
		imageURL["url"] = shrunken
		changed = true
	}
	if !changed {
		return body, nil
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return body, nil
	}
	return encoded, nil
}

// shrinkAnmiaoDataURLImage 压缩单张 data URL 图片，返回新 data URL 与是否压缩过。
// 只处理 base64 内联；公网 URL 和 asset:// 原样放行。
func shrinkAnmiaoDataURLImage(dataURL string) (string, bool) {
	lower := strings.ToLower(dataURL)
	if !strings.HasPrefix(lower, "data:image/") {
		return dataURL, false
	}
	comma := strings.Index(dataURL, ",")
	if comma < 0 || !strings.HasSuffix(lower[:comma], ";base64") {
		return dataURL, false
	}
	raw, err := base64.StdEncoding.DecodeString(dataURL[comma+1:])
	if err != nil || len(raw) <= anmiaoReferenceImageMaxBytes {
		return dataURL, false
	}
	shrunken, ok := shrinkCanvasTaskImage(raw, anmiaoReferenceImageTargetBytes)
	if !ok {
		return dataURL, false
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(shrunken), true
}
