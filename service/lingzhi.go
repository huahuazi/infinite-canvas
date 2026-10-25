package service

import (
	"net/url"
	"strings"
)

// 灵智（lk888.ai / lingkeai.ai）「按秒计费」Ark 通道的对接常量与判定。
//
// 对接文档：https://lingzhiai.lk666.ai/apidoc#model/seedance-2.5-guanfang-anmiao
// 该文档站只提供网页，真正的 API 域名是 api.lk888.ai / api.lingkeai.ai，
// 版本前缀是 /api/v3/anmiao（不是 /api/v3）。两者混填会拿到一份 HTML 200，
// 前端只会看到「视频接口没有返回任务 ID」，所以这里单独提供判定。
const (
	// LingzhiAnmiaoPathSuffix 是按秒计费通道的自定义路径前缀。
	LingzhiAnmiaoPathSuffix = "/anmiao"
	// LingzhiMinDurationSeconds 是文档给出的最短时长（整数秒）。
	LingzhiMinDurationSeconds = 4
	// LingzhiMaxDurationSeconds25 是 Seedance 2.5 系列的最长时长。
	LingzhiMaxDurationSeconds25 = 30
	// LingzhiMaxDurationSeconds20 是拿不到型号时的兜底上限（2.0 系列为 15 秒）。
	LingzhiMaxDurationSeconds20 = 15
	// LingzhiDefaultDurationSeconds 是 duration=-1（智能时长）的兜底秒数。
	LingzhiDefaultDurationSeconds = 5
)

// IsLingzhiDocHost 判断地址是否指向灵智的文档站（lk666.ai）。
// 文档站只托管前端页面，任何 /api/... 请求都会返回 200 + HTML，
// 必须在发请求前拦下来，否则错误现场会变成「接口没有返回任务 ID」。
func IsLingzhiDocHost(baseURL string) bool {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "lk666.ai" || strings.HasSuffix(host, ".lk666.ai")
}

// AnmiaoDurationMax 返回灵智按秒通道允许的最长时长。
// 2.5 系列 4~30 秒，2.0 系列 4~15 秒；拿不准时按 15 秒收敛，宁可短一点也别被上游 400。
func AnmiaoDurationMax(modelName string) int {
	key := strings.ToLower(strings.TrimSpace(modelName))
	if strings.Contains(key, "seedance-2-5") || strings.Contains(key, "seedance-2.5") {
		return LingzhiMaxDurationSeconds25
	}
	return LingzhiMaxDurationSeconds20
}

// IsVolcNativeModelName 判断 model 是否是火山方舟认得的真名。
// 灵智的 Ark 通道只认 doubao-* 真名（或 ep- 推理接入点），
// 直接发它自己的计费 SKU（seedance-2.5-guanfang-anmiao）会被上游拒绝。
func IsVolcNativeModelName(modelName string) bool {
	key := strings.ToLower(strings.TrimSpace(modelName))
	if key == "" {
		return false
	}
	return strings.HasPrefix(key, "doubao-") || strings.HasPrefix(key, "ep-")
}

// AnmiaoModelNameError 在 model 名不可能被灵智 Ark 通道接受时返回可操作的提示。
// 返回空串表示放行（映射已配置或被上游接受）。
func AnmiaoModelNameError(modelName string) string {
	name := strings.TrimSpace(modelName)
	if name == "" || IsVolcNativeModelName(name) {
		return ""
	}
	return "灵智按秒通道只认火山真名，当前请求体的 model 是「" + name + "」。请在后台渠道的「模型名映射」里配一条「" +
		name + " = doubao-seedance-2-5-260628」（按实际型号填写），或直接把渠道模型改成 doubao-* 真名后重试"
}

// lingzhiErrorTypes 把灵智的错误码 / 错误类型翻译成可操作的中文提示。
// 灵智的错误信封是 {"error":{"code":"invalid_api_key","message":"...","type":"authentication_error"}}，
// 只回传 message 会丢掉机器码，用户看不出该改密钥还是改参数。
var lingzhiErrorHints = map[string]string{
	"missing_api_key":       "渠道没有携带 API Key：请在后台渠道配置里填写灵智的 sk- 密钥（Authorization: Bearer sk-xxx）",
	"invalid_api_key":       "API Key 无效：请核对渠道里填的是灵智控制台签发的 sk- 密钥，且没有多余空格",
	"authentication_error":  "鉴权失败：请先确认渠道 API Key 有效，再检查该密钥是否已开通当前模型",
	"model_not_found":       "模型不存在：灵智按秒通道的 model 必须是火山真名（doubao-*），不是平台计费 SKU；请检查「模型名映射」",
	"not_found":             "接口路径不存在：请确认 Base URL 是 https://api.lk888.ai/api/v3/anmiao（带 /anmiao 前缀，不是文档站域名）",
	"insufficient_quota":    "账户额度不足：请到灵智控制台充值或更换可用的线路分组",
	"insufficient_balance":  "账户额度不足：请到灵智控制台充值后重试",
	"rate_limit_exceeded":   "触发限流：请降低并发或稍后重试",
	"invalid_request_error": "请求参数被上游拒绝：请对照灵智文档核对该模型的时长、分辨率、素材数量限制",
	// 灵智的业务错误带 type=BadRequest；参数类错误码是 InvalidParameter。
	"badrequest":               "请求被上游拒绝：多为参数越界或素材不合规，请核对分辨率（2.5 最高 1080p）、时长（4~30 整数秒）、比例与素材数量",
	"invalidparameter":         "参数不合法：2.5 最高 1080p（传 4k 会 400）、时长必须是 4~30 的整数秒、首帧任务 ratio 只能 adaptive",
	"sensitivecontentdetected": "内容审核未通过：请修改提示词或更换素材后重试（该任务上游已自动退款）",
}

// LingzhiErrorHint 返回附在错误信息后面的中文提示，未命中时返回空串。
func LingzhiErrorHint(code string, errorType string) string {
	for _, key := range []string{strings.ToLower(strings.TrimSpace(code)), strings.ToLower(strings.TrimSpace(errorType))} {
		if key == "" {
			continue
		}
		if hint, ok := lingzhiErrorHints[key]; ok {
			return hint
		}
	}
	return ""
}
