package handler

import (
	"strings"
	"testing"
)

// 容器内解析自家域名会拿到内网 IPv6 + 无 SAN 的内部证书，
// Go 会报 x509: certificate is not valid for any names。
// 所以「自家素材出口」必须走磁盘短路，不能再绕公网。
func TestLocalReferenceMediaPath(t *testing.T) {
	cases := []struct {
		name     string
		url      string
		wantOK   bool
		wantTail string
	}{
		{
			name:     "自家出口正常地址",
			url:      "https://huabu.leohome.site/api/media/references/84be1b53-248f-4a56-910a-08529a5bf60a.mp4",
			wantOK:   true,
			wantTail: "84be1b53-248f-4a56-910a-08529a5bf60a.mp4",
		},
		{
			name:     "换了 cdn 域名也应该短路（文件仍在本地）",
			url:      "https://cdn.example.com/api/media/references/abc.png",
			wantOK:   true,
			wantTail: "abc.png",
		},
		{
			name:   "路径穿越必须拒绝",
			url:    "https://huabu.leohome.site/api/media/references/../../etc/passwd",
			wantOK: false,
		},
		{
			name:   "空 id 必须拒绝",
			url:    "https://huabu.leohome.site/api/media/references/",
			wantOK: false,
		},
		{
			name:   "其他路径不短路",
			url:    "https://cdn.example.com/files/abc.mp4",
			wantOK: false,
		},
		{
			name:   "外网地址不短路",
			url:    "https://n.uguu.se/abc.mp4",
			wantOK: false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			path, ok := localReferenceMediaPath(testCase.url)
			if ok != testCase.wantOK {
				t.Fatalf("ok = %v，期望 %v（path=%q）", ok, testCase.wantOK, path)
			}
			if ok && !strings.HasSuffix(path, testCase.wantTail) {
				t.Fatalf("path = %q，期望以 %q 结尾", path, testCase.wantTail)
			}
		})
	}
}
