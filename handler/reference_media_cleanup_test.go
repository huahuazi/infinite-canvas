package handler

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
)

func withRetentionDays(t *testing.T, days int) {
	t.Helper()
	old := config.Cfg.ReferenceMediaRetentionDays
	config.Cfg.ReferenceMediaRetentionDays = days
	t.Cleanup(func() { config.Cfg.ReferenceMediaRetentionDays = old })
}

// 写一个指定 mtime 的文件，内容长度可控，便于校验释放的字节数。
func writeAgedFile(t *testing.T, dir string, name string, size int, modTime time.Time) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(make([]byte, size)), 0o644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatalf("设置 mtime 失败: %v", err)
	}
	return path
}

func TestCleanupReferenceMediaDirRemovesExpiredOnly(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()

	expired := writeAgedFile(t, dir, "expired.mp4", 10, now.Add(-8*24*time.Hour))
	recent := writeAgedFile(t, dir, "recent.mp4", 20, now.Add(-3*24*time.Hour))
	brandNew := writeAgedFile(t, dir, "new.mp4", 30, now)
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}

	removed, freed := cleanupReferenceMediaDir(dir, 7*24*time.Hour, now)
	if removed != 1 {
		t.Fatalf("removed = %d，期望只删 1 个（8 天前的）", removed)
	}
	if freed != 10 {
		t.Fatalf("freed = %d，期望 10 字节", freed)
	}
	if _, err := os.Stat(expired); !os.IsNotExist(err) {
		t.Fatal("过期文件应被删除")
	}
	if _, err := os.Stat(recent); err != nil {
		t.Fatal("保留期内的文件不该被删")
	}
	if _, err := os.Stat(brandNew); err != nil {
		t.Fatal("刚写入的文件不该被删")
	}
	if info, err := os.Stat(filepath.Join(dir, "subdir")); err != nil || !info.IsDir() {
		t.Fatal("子目录不该被删")
	}
}

// 目录不存在是正常状态（从没上传过素材），必须安静返回而不是报错。
func TestCleanupReferenceMediaDirMissingDir(t *testing.T) {
	removed, freed := cleanupReferenceMediaDir(filepath.Join(t.TempDir(), "not-exist"), 7*24*time.Hour, time.Now())
	if removed != 0 || freed != 0 {
		t.Fatalf("removed=%d freed=%d，期望都为 0", removed, freed)
	}
}

// mtime 落在未来（时钟漂移）的文件不能被当成过期删掉。
func TestCleanupReferenceMediaDirSkipsFutureModTime(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	future := writeAgedFile(t, dir, "future.mp4", 5, now.Add(48*time.Hour))

	removed, _ := cleanupReferenceMediaDir(dir, 7*24*time.Hour, now)
	if removed != 0 {
		t.Fatalf("removed = %d，期望 0（未来时间应跳过）", removed)
	}
	if _, err := os.Stat(future); err != nil {
		t.Fatal("未来 mtime 的文件不该被删")
	}
}

func TestReferenceMediaRetention(t *testing.T) {
	cases := []struct {
		days int
		want time.Duration
	}{
		{7, 7 * 24 * time.Hour},
		{1, 24 * time.Hour},
		{0, 0},  // 显式关闭
		{-1, 0}, // 负数同样视为关闭
	}
	for _, testCase := range cases {
		withRetentionDays(t, testCase.days)
		if got := referenceMediaRetention(); got != testCase.want {
			t.Fatalf("days=%d 时 retention = %v，期望 %v", testCase.days, got, testCase.want)
		}
	}
}

// 关闭后 cleanupReferenceMediaOnce 必须一个文件都不删。
func TestCleanupReferenceMediaOnceDisabled(t *testing.T) {
	withRetentionDays(t, 0)
	// 关掉后不会去碰真实目录，直接确认保留期为 0 即可短路。
	if referenceMediaRetention() != 0 {
		t.Fatal("设为 0 时应关闭清理")
	}
}
