package main

import (
	"log"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAdmin(); err != nil {
		log.Fatal(err)
	}
	service.StartPromptSyncScheduler()
	service.StartCanvasProjectCleanupScheduler()
	handler.StartVideoTaskPoller()
	// 参考素材目录没有 TTL 会一直涨（深度视频每生成一次就落一个成片），启动后台清理。
	handler.StartReferenceMediaCleaner()
	log.Fatal(router.New().Run(":" + config.Cfg.Port))
}
