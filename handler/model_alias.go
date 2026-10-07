package handler

import (
	"encoding/json"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

// applyChannelModelAlias 把请求体里的 model 字段改写成上游真实模型名。
//
// 中转站对外暴露的往往是自己的计费 SKU（例如灵智的 seedance-2.5-guanfang-anmiao），
// 但 Ark 协议只认火山真名（doubao-seedance-2-5-260628）——直接透传会被上游 400 掉。
// 渠道可通过 modelAliases 配置「前端名 -> 上游名」的映射，未配置时原样返回。
//
// 只处理 JSON 请求体；表单 / multipart（图片编辑等）不在此改写，
// 那些协议本身也不依赖 Ark 的 model 字段。
func applyChannelModelAlias(body []byte, contentType string, channel model.ModelChannel) ([]byte, error) {
	if len(channel.ModelAliases) == 0 || len(body) == 0 {
		return body, nil
	}
	if !strings.Contains(strings.ToLower(contentType), "json") {
		return body, nil
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		// 解析失败就放行，交给上游报错，避免这里先失败导致错误信息失真。
		return body, nil
	}
	current, ok := payload["model"].(string)
	if !ok || strings.TrimSpace(current) == "" {
		return body, nil
	}
	upstream := service.UpstreamModelName(channel, current)
	if upstream == current {
		return body, nil
	}
	payload["model"] = upstream
	encoded, err := json.Marshal(payload)
	if err != nil {
		return body, nil
	}
	return encoded, nil
}

// isAnmiaoVideoChannel 判断是否灵智按秒计费的视频通道。
// 该通道拒绝 duration=-1（智能时长），需要收敛成具体秒数。
func isAnmiaoVideoChannel(channel model.ModelChannel) bool {
	return service.IsAnmiaoChannel(channel)
}

// clampAnmiaoVideoBody 修正灵智按秒通道的请求体：
// duration 必须是 4~30 的整数秒，传 -1 会被上游直接 400。
func clampAnmiaoVideoBody(body []byte, contentType string) ([]byte, error) {
	if len(body) == 0 || !strings.Contains(strings.ToLower(contentType), "json") {
		return body, nil
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return body, nil
	}
	changed := false
	switch value := payload["duration"].(type) {
	case float64:
		if value < 0 {
			payload["duration"] = anmiaoDefaultDurationSeconds
			changed = true
		}
	case json.Number:
		if seconds, err := value.Int64(); err == nil && seconds < 0 {
			payload["duration"] = anmiaoDefaultDurationSeconds
			changed = true
		}
	case string:
		if strings.TrimSpace(value) == "-1" {
			payload["duration"] = anmiaoDefaultDurationSeconds
			changed = true
		}
	}
	// 灵智不认 asset:// 素材库引用（火山素材库 ID 是账号级授权，中转站无法透传）。
	// 出现时直接删掉，避免上游报一个用户看不懂的错。
	if removed := stripArkAssetReferences(payload); removed {
		changed = true
	}
	// 灵智对 seed / watermark / generate_audio / service_tier 等「收下但不生效」，
	// 发过去只是徒增被强校验拒绝的风险，统一剥掉。
	if removed := stripInertArkFields(payload); removed {
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

// anmiaoDefaultDurationSeconds 是 duration=-1 时的兜底秒数，落在文档给的 4~30 区间内。
const anmiaoDefaultDurationSeconds = 5

// stripArkAssetReferences 递归移除 content[] 里的 asset:// 素材引用，返回是否改动了。
func stripArkAssetReferences(payload map[string]any) bool {
	changed := false
	for _, key := range []string{"content", "contents", "messages", "input"} {
		items, ok := payload[key].([]any)
		if !ok {
			continue
		}
		for _, item := range items {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			for _, field := range []string{"image_url", "video_url", "audio_url"} {
				holder, ok := entry[field].(map[string]any)
				if !ok {
					continue
				}
				url, _ := holder["url"].(string)
				if strings.HasPrefix(strings.ToLower(strings.TrimSpace(url)), "asset://") {
					delete(entry, field)
					changed = true
				}
			}
		}
	}
	return changed
}

// stripInertArkFields 移除灵智通道「收下但不生效」的顶层可选参数。
func stripInertArkFields(payload map[string]any) bool {
	changed := false
	for _, field := range []string{"seed", "watermark", "generate_audio", "service_tier", "draft", "return_last_frame", "camera_fixed", "output_format", "omni_reference_task_type"} {
		if _, ok := payload[field]; ok {
			delete(payload, field)
			changed = true
		}
	}
	return changed
}

// rewriteModelChannelRequestBody 是请求体改写的统一入口：
// 先按渠道映射表改写 model，再套用各协议自己的归一化规则。
// normalize 回调必须接收改写后的请求体，否则会拿到原始 body 把改写结果覆盖掉。
func rewriteModelChannelRequestBody(body []byte, contentType string, channel model.ModelChannel, normalize func([]byte) ([]byte, string, error)) ([]byte, string, error) {
	aliased, err := applyChannelModelAlias(body, contentType, channel)
	if err != nil {
		return body, contentType, err
	}
	body = aliased
	if isAnmiaoVideoChannel(channel) {
		clamped, err := clampAnmiaoVideoBody(body, contentType)
		if err != nil {
			return body, contentType, err
		}
		body = clamped
	}
	if normalize == nil {
		return body, contentType, nil
	}
	return normalize(body)
}
