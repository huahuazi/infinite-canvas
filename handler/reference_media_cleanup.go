package handler

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
)

// 参考素材目录清理。
//
// data/reference-media 里混着两种文件：
//   - 上游回源用的参考素材（灵智 / 火山 / WaveSpeed / HF 都要来拉）
//   - 深度视频等任务落下来的成片（persistDepthVideo 也写这里）
//
// 两者生命周期都有限：任务跑完素材就没人再读，成片也该由用户自己存进资产库。
// 之前这块完全没有 TTL，深度视频每生成一次就多一个视频文件，磁盘迟早打满。
//
// 只按 mtime 判断，不做引用计数：
// 任务执行期间文件刚写入，mtime 必然落在保留期内，不会被误删；
// 唯一风险是「任务排队超过保留期」，而任务最长也就 HF 的 240 秒 GPU 限制，30 天完全够。
//
// ⚠️ 注意取舍：深度视频的产物也写在这个目录，画布节点的 video_url 直接指向它。
// 删掉以后画布上的那个视频会 404，所以默认保留期给到 30 天而不是 7 天；
// 想省磁盘就调 REFERENCE_MEDIA_RETENTION_DAYS，代价是旧画布里的视频会失效。

const referenceMediaCleanupInterval = 6 * time.Hour

// StartReferenceMediaCleaner 启动后台清理协程。
// 启动时先扫一次，避免重启前积压的文件再等一个完整周期。
func StartReferenceMediaCleaner() {
	go func() {
		cleanupReferenceMediaOnce()
		ticker := time.NewTicker(referenceMediaCleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			cleanupReferenceMediaOnce()
		}
	}()
}

// referenceMediaRetention 返回保留期；0 表示关闭清理。
// 单位是天，所以配 1 就已经是下限 24 小时，不会出现「刚写完就被删」的窗口。
func referenceMediaRetention() time.Duration {
	days := config.Cfg.ReferenceMediaRetentionDays
	if days <= 0 {
		return 0
	}
	return time.Duration(days) * 24 * time.Hour
}

func cleanupReferenceMediaOnce() {
	retention := referenceMediaRetention()
	if retention <= 0 {
		return
	}
	removed, freed := cleanupReferenceMediaDir(referenceMediaDir(), retention, time.Now())
	if removed > 0 {
		log.Printf("reference media cleanup: removed=%d freed=%.1fMB retention=%s", removed, float64(freed)/(1<<20), retention)
	}
}

// cleanupReferenceMediaDir 是纯函数（目录与时间都可注入），便于测试。
// 只删「普通文件」且 mtime 早于 cutoff 的条目：子目录、符号链接、刚写入的文件都不动。
func cleanupReferenceMediaDir(dir string, retention time.Duration, now time.Time) (int, int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		// 目录不存在是正常状态（从没上传过素材），不刷日志。
		if !os.IsNotExist(err) {
			log.Printf("reference media cleanup: read dir failed dir=%s err=%v", dir, err)
		}
		return 0, 0
	}
	cutoff := now.Add(-retention)
	removed := 0
	var freed int64
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		// mtime 在 cutoff 之后 = 仍在保留期内；时钟漂移到未来的文件同样跳过。
		if info.ModTime().After(cutoff) {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		size := info.Size()
		if err := os.Remove(path); err != nil {
			log.Printf("reference media cleanup: remove failed file=%s err=%v", path, err)
			continue
		}
		removed++
		freed += size
	}
	return removed, freed
}
