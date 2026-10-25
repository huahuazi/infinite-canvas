package service

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestFetchAdminChannelModelsParsesOpenAIModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"z-model"},{"id":"a-model"},{"id":""}]}`))
	}))
	defer server.Close()

	models, err := fetchAdminChannelModels(model.ModelChannel{
		BaseURL: server.URL,
		APIKey:  "test-key",
	})
	if err != nil {
		t.Fatalf("fetchAdminChannelModels returned error: %v", err)
	}
	if want := []string{"a-model", "z-model"}; !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %#v, want %#v", models, want)
	}
}

func TestFetchAdminChannelModelsReportsArkPlanModelsUnsupported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/plan/v3/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	_, err := fetchAdminChannelModels(model.ModelChannel{
		BaseURL: server.URL + "/api/plan/v3/contents/generations/tasks",
		APIKey:  "test-key",
	})
	if err == nil {
		t.Fatal("expected unsupported /models error")
	}
	if !strings.Contains(err.Error(), "Agent Plan 未提供 OpenAI /models") {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestBuildModelChannelURLNormalizesArkPlanTaskPath(t *testing.T) {
	got := BuildModelChannelURL(model.ModelChannel{BaseURL: "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks?debug=1"}, "/models")
	want := "https://ark.cn-beijing.volces.com/api/plan/v3/models"
	if got != want {
		t.Fatalf("BuildModelChannelURL = %q, want %q", got, want)
	}
}

func TestBuildModelChannelURLZhipuV4(t *testing.T) {
	tests := []struct {
		baseURL string
		path    string
		want    string
	}{
		{"https://open.bigmodel.cn/api/paas/v4", "/chat/completions", "https://open.bigmodel.cn/api/paas/v4/chat/completions"},
		{"https://open.bigmodel.cn/api/paas/v4/", "/models", "https://open.bigmodel.cn/api/paas/v4/models"},
		{"https://open.bigmodel.cn/api/paas/v4", "/images/generations", "https://open.bigmodel.cn/api/paas/v4/images/generations"},
		{"https://ark.cn-beijing.volces.com/api/plan/v3", "/chat/completions", "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions"},
		{"https://api.openai.com", "/chat/completions", "https://api.openai.com/v1/chat/completions"},
	}
	for _, tt := range tests {
		got := BuildModelChannelURL(model.ModelChannel{BaseURL: tt.baseURL}, tt.path)
		if got != tt.want {
			t.Fatalf("BuildModelChannelURL(%q, %q) = %q, want %q", tt.baseURL, tt.path, got, tt.want)
		}
	}
}

// 灵智的模型列表挂在站点根 /v1/models 下，不在 /api/v3/anmiao 之下。
// 直接拼 baseUrl 会得到 /api/v3/anmiao/models，上游返回 404「未找到接口路径」。
func TestFetchAdminChannelModelsUsesAnmiaoRootModelsPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("灵智应请求 /v1/models，实际: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Fatalf("鉴权头 = %q，期望 Bearer sk-test", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"seedance-2.5-guanfang-anmiao"}]}`))
	}))
	defer server.Close()

	models, err := fetchAdminChannelModels(model.ModelChannel{
		Protocol: "anmiao",
		BaseURL:  server.URL + "/api/v3/anmiao",
		APIKey:   "sk-test",
	})
	if err != nil {
		t.Fatalf("fetchAdminChannelModels 报错: %v", err)
	}
	if want := []string{"seedance-2.5-guanfang-anmiao"}; !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %#v, want %#v", models, want)
	}
}

// 老配置（protocol=ark + 灵智地址）走地址兜底时，也要用 /v1/models。
func TestAnmiaoModelListURL(t *testing.T) {
	cases := map[string]string{
		"https://api.lk888.ai/api/v3/anmiao":          "https://api.lk888.ai/v1/models",
		"https://api.lingkeai.ai/api/v3/anmiao":       "https://api.lingkeai.ai/v1/models",
		"https://api.lk888.ai/api/v3/anmiao/":         "https://api.lk888.ai/v1/models",
		"https://ark.cn-beijing.volces.com/api/v3":    "https://ark.cn-beijing.volces.com/v1/models",
		"not-a-url":                                   "",
		"":                                            "",
	}
	for input, want := range cases {
		if got := anmiaoModelListURL(input); got != want {
			t.Fatalf("anmiaoModelListURL(%q) = %q，期望 %q", input, got, want)
		}
	}
}
