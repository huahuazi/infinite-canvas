package handler

import (
	"encoding/json"
	"strconv"
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
// duration 必须是 4~30（2.5）/ 4~15（2.0）的整数秒，传 -1 会被上游直接 400。
// 缺失时补默认值（文档标注为必填），越界时收敛到区间内，避免上游强校验拒绝。
func clampAnmiaoVideoBody(body []byte, contentType string, modelName string) ([]byte, error) {
	if len(body) == 0 || !strings.Contains(strings.ToLower(contentType), "json") {
		return body, nil
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return body, nil
	}
	changed := false
	if seconds, ok := clampAnmiaoDuration(payload["duration"], service.AnmiaoDurationMax(modelName)); ok {
		payload["duration"] = seconds
		changed = true
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

// clampAnmiaoDuration 把 duration 收敛到灵智按秒通道的合法区间（整数秒）。
// 返回 (秒数, 是否需要改写)；duration 缺失时补默认值，因为文档把它标成必填。
func clampAnmiaoDuration(raw any, maxSeconds int) (int, bool) {
	if maxSeconds < service.LingzhiMinDurationSeconds {
		maxSeconds = service.LingzhiMaxDurationSeconds20
	}
	clamp := func(seconds int) (int, bool) {
		if seconds < 0 {
			return anmiaoDefaultDurationSeconds, true
		}
		if seconds < service.LingzhiMinDurationSeconds {
			return service.LingzhiMinDurationSeconds, true
		}
		if seconds > maxSeconds {
			return maxSeconds, true
		}
		return seconds, false
	}
	switch value := raw.(type) {
	case nil:
		return anmiaoDefaultDurationSeconds, true
	case float64:
		seconds := int(value)
		clamped, changed := clamp(seconds)
		// 8.7 这类小数秒不是合法整数，即便落在区间内也要改写。
		return clamped, changed || float64(seconds) != value
	case json.Number:
		if seconds, err := value.Int64(); err == nil {
			return clamp(int(seconds))
		}
		return anmiaoDefaultDurationSeconds, true
	case string:
		text := strings.TrimSpace(value)
		if text == "" {
			return anmiaoDefaultDurationSeconds, true
		}
		seconds, err := strconv.Atoi(text)
		if err != nil {
			return anmiaoDefaultDurationSeconds, true
		}
		return clamp(seconds)
	default:
		return anmiaoDefaultDurationSeconds, true
	}
}

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
func rewriteModelChannelRequestBody(body []byte, contentType string, channel model.ModelChannel, modelName string, normalize func([]byte) ([]byte, string, error)) ([]byte, string, error) {
	aliased, err := applyChannelModelAlias(body, contentType, channel)
	if err != nil {
		return body, contentType, err
	}
	body = aliased
	if isAnmiaoVideoChannel(channel) {
		// 用改写后的 model 判时长上限：灵智计费 SKU 与火山真名都带 seedance-2-5 / seedance-2-0 特征。
		clamped, err := clampAnmiaoVideoBody(body, contentType, firstNonEmpty(readBodyModelName(body), modelName))
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

// readBodyModelName 读请求体里的 model 字段（已在 alias 之后调用，拿到的是上游真名）。
func readBodyModelName(body []byte) string {
	var payload struct {
		Model string `json:"model"`
	}
	if len(body) == 0 || json.Unmarshal(body, &payload) != nil {
		return ""
	}
	return strings.TrimSpace(payload.Model)
}
