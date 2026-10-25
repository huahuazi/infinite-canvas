package config

import (
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

type Config struct {
	Port           string `env:"PORT" envDefault:"8080"`
	AdminUsername  string `env:"ADMIN_USERNAME" envDefault:"admin"`
	AdminPassword  string `env:"ADMIN_PASSWORD" envDefault:"infinite-canvas"`
	JWTSecret      string `env:"JWT_SECRET" envDefault:"infinite-canvas"`
	JWTExpireHours int    `env:"JWT_EXPIRE_HOURS" envDefault:"168"`
	StorageDriver  string `env:"STORAGE_DRIVER" envDefault:"sqlite"`
	DatabaseDSN    string `env:"DATABASE_DSN" envDefault:"data/infinite-canvas.db"`
	PublicBaseURL  string `env:"PUBLIC_BASE_URL"`
	// 公共直链镜像：自建出口不可用时，把素材转存到公共文件托管换一条上游能拉的直链。
	// PUBLIC_MIRROR_MODE：off（关闭）/ fallback（默认，仅自建出口失败时兜底）。
	PublicMirrorProviders string `env:"PUBLIC_MIRROR_PROVIDERS" envDefault:"catbox,0x0st,litterbox,tmpfiles"`
	PublicMirrorMode      string `env:"PUBLIC_MIRROR_MODE" envDefault:"fallback"`
	// 是否允许把「生成结果」也镜像到公共托管（默认关闭：成片可能含客户素材）。
	PublicMirrorResults bool   `env:"PUBLIC_MIRROR_RESULTS" envDefault:"false"`
	LinuxDoAuthorizeURL string `env:"LINUX_DO_AUTHORIZE_URL" envDefault:"https://connect.linux.do/oauth2/authorize"`
	LinuxDoTokenURL     string `env:"LINUX_DO_TOKEN_URL" envDefault:"https://connect.linux.do/oauth2/token"`
	LinuxDoUserInfoURL  string `env:"LINUX_DO_USERINFO_URL" envDefault:"https://connect.linux.do/api/user"`
	AILogDir            string `env:"AI_LOG_DIR" envDefault:"data/logs/ai-calls"`
}

var Cfg Config

func Load() error {
	_ = godotenv.Load()
	if err := env.Parse(&Cfg); err != nil {
		return err
	}
	normalizeDockerSQLiteDSN("/app/data")
	if strings.TrimSpace(Cfg.JWTSecret) == "" || Cfg.JWTSecret == "infinite-canvas" {
		secret, err := randomSecret()
		if err != nil {
			return err
		}
		Cfg.JWTSecret = secret
	}
	return nil
}

func normalizeDockerSQLiteDSN(appDataDir string) {
	driver := strings.ToLower(strings.TrimSpace(Cfg.StorageDriver))
	if driver != "" && driver != "sqlite" {
		return
	}
	dsn := strings.TrimSpace(Cfg.DatabaseDSN)
	if dsn == "" || dsn == ":memory:" || strings.HasPrefix(dsn, "file:") {
		return
	}
	pathPart, suffix := dsn, ""
	if index := strings.Index(dsn, "?"); index >= 0 {
		pathPart = dsn[:index]
		suffix = dsn[index:]
	}
	if filepath.IsAbs(pathPart) {
		return
	}
	slashPath := filepath.ToSlash(pathPart)
	if slashPath != "data" && !strings.HasPrefix(slashPath, "data/") {
		return
	}
	if _, err := os.Stat(appDataDir); err != nil {
		return
	}
	Cfg.DatabaseDSN = filepath.Join(filepath.Dir(appDataDir), filepath.FromSlash(slashPath)) + suffix
}

func randomSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
