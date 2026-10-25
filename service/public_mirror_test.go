package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
)

func withMirrorConfig(t *testing.T, providers string, mode string) {
	t.Helper()
	oldProviders, oldMode := config.Cfg.PublicMirrorProviders, config.Cfg.PublicMirrorMode
	config.Cfg.PublicMirrorProviders = providers
	config.Cfg.PublicMirrorMode = mode
	t.Cleanup(func() {
		config.Cfg.PublicMirrorProviders = oldProviders
		config.Cfg.PublicMirrorMode = oldMode
	})
}

func withMirrorEndpoint(t *testing.T, name string, endpoint string) {
	t.Helper()
	old, ok := publicMirrorEndpoints[name]
	publicMirrorEndpoints[name] = endpoint
	t.Cleanup(func() {
		if ok {
			publicMirrorEndpoints[name] = old
		} else {
			delete(publicMirrorEndpoints, name)
		}
	})
}

// catbox / litterbox / 0x0.st 都是「纯文本直链」响应。
func TestUploadToPublicMirrorPlainText(t *testing.T) {
	withMirrorConfig(t, "catbox", "fallback")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			t.Errorf("解析 multipart 失败: %v", err)
		}
		if got := r.FormValue("reqtype"); got != "fileupload" {
			t.Errorf("reqtype = %q，期望 fileupload", got)
		}
		if _, _, err := r.FormFile("fileToUpload"); err != nil {
			t.Errorf("缺少 fileToUpload 字段: %v", err)
		}
		_, _ = w.Write([]byte("https://files.catbox.moe/abc.mp4\n"))
	}))
	defer server.Close()
	withMirrorEndpoint(t, "catbox", server.URL)

	result, err := UploadToPublicMirror(context.Background(), "ref.mp4", "video/mp4", []byte("fake"))
	if err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if result.URL != "https://files.catbox.moe/abc.mp4" {
		t.Fatalf("url = %q", result.URL)
	}
	if result.Provider != "catbox" {
		t.Fatalf("provider = %q", result.Provider)
	}
}

// tmpfiles 返回的是预览页地址，必须补成 /dl 直链。
func TestUploadToPublicMirrorTmpfilesRewritesToDirectLink(t *testing.T) {
	withMirrorConfig(t, "tmpfiles", "fallback")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"url":"https://tmpfiles.org/12345/ref.mp4"}}`))
	}))
	defer server.Close()
	withMirrorEndpoint(t, "tmpfiles", server.URL)

	result, err := UploadToPublicMirror(context.Background(), "ref.mp4", "video/mp4", []byte("fake"))
	if err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if result.URL != "https://tmpfiles.org/dl/12345/ref.mp4" {
		t.Fatalf("url = %q，期望补上 /dl 直链", result.URL)
	}
	if result.ExpiresIn == 0 {
		t.Fatal("tmpfiles 应给出过期秒数")
	}
}

// 第一个托管失败（HTTP 500）时，必须自动切到下一个。
func TestUploadToPublicMirrorFallsBackOnServerError(t *testing.T) {
	withMirrorConfig(t, "catbox,0x0st", "fallback")
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer broken.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("https://0x0.st/xyz.mp4"))
	}))
	defer healthy.Close()
	withMirrorEndpoint(t, "catbox", broken.URL)
	withMirrorEndpoint(t, "0x0st", healthy.URL)

	result, err := UploadToPublicMirror(context.Background(), "ref.mp4", "video/mp4", []byte("fake"))
	if err != nil {
		t.Fatalf("应回退成功，实际失败: %v", err)
	}
	if result.Provider != "0x0st" || result.URL != "https://0x0.st/xyz.mp4" {
		t.Fatalf("回退结果不对: %+v", result)
	}
}

// 200 但返回的是错误文本（0x0.st 的失败形态）也要继续切下一个。
func TestUploadToPublicMirrorFallsBackOnErrorText(t *testing.T) {
	withMirrorConfig(t, "0x0st,catbox", "fallback")
	errorText := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("*** upload failed: file too large\n"))
	}))
	defer errorText.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("https://files.catbox.moe/ok.mp4"))
	}))
	defer healthy.Close()
	withMirrorEndpoint(t, "0x0st", errorText.URL)
	withMirrorEndpoint(t, "catbox", healthy.URL)

	result, err := UploadToPublicMirror(context.Background(), "ref.mp4", "video/mp4", []byte("fake"))
	if err != nil {
		t.Fatalf("应回退成功，实际失败: %v", err)
	}
	if result.Provider != "catbox" {
		t.Fatalf("provider = %q，期望 catbox", result.Provider)
	}
}

// 全部失败时要给出每个托管的原因，前端才能展示「都试过哪些」。
func TestUploadToPublicMirrorAllFailed(t *testing.T) {
	withMirrorConfig(t, "catbox,litterbox", "fallback")
	for _, name := range []string{"catbox", "litterbox"} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, name+" down", http.StatusBadGateway)
		}))
		defer server.Close()
		withMirrorEndpoint(t, name, server.URL)
	}

	_, err := UploadToPublicMirror(context.Background(), "ref.mp4", "video/mp4", []byte("fake"))
	if err == nil {
		t.Fatal("全部失败时应报错")
	}
	var mirrorErr *PublicMirrorError
	if !errors.As(err, &mirrorErr) {
		t.Fatalf("错误类型 = %T，期望 *PublicMirrorError", err)
	}
	if len(mirrorErr.Attempts) != 2 {
		t.Fatalf("应记录 2 次失败，实际 %d", len(mirrorErr.Attempts))
	}
	if !strings.Contains(err.Error(), "catbox") || !strings.Contains(err.Error(), "litterbox") {
		t.Fatalf("错误信息应包含两个托管名，实际: %v", err)
	}
}

// mode=off 时整个功能不可用，避免无意间把素材传到公网。
func TestPublicMirrorDisabled(t *testing.T) {
	withMirrorConfig(t, "catbox", "off")
	if providers := PublicMirrorProviders(); len(providers) != 0 {
		t.Fatalf("off 模式不应有可用托管，实际 %v", providers)
	}
	_, err := UploadToPublicMirror(context.Background(), "ref.mp4", "video/mp4", []byte("fake"))
	if !errors.Is(err, ErrPublicMirrorDisabled) {
		t.Fatalf("err = %v，期望 ErrPublicMirrorDisabled", err)
	}
}

// 未知托管名要被忽略，不能让配置错误把整个功能拖死。
func TestPublicMirrorSkipsUnknownProviders(t *testing.T) {
	withMirrorConfig(t, "unknown,catbox", "fallback")
	providers := PublicMirrorProviders()
	if len(providers) != 1 || providers[0] != "catbox" {
		t.Fatalf("providers = %v，期望只剩 catbox", providers)
	}
}
