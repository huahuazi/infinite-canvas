package service

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// ListCustomPromptCategories 返回管理员自定义分类。
func ListCustomPromptCategories() ([]model.PromptCategory, error) {
	return repository.ListCustomPromptCategories()
}

// SaveCustomPromptCategory 保存自定义分类。
func SaveCustomPromptCategory(item model.PromptCategory) (model.PromptCategory, error) {
	return repository.SaveCustomPromptCategory(item)
}

// DeleteCustomPromptCategory 删除自定义分类及其提示词。
func DeleteCustomPromptCategory(category string) error {
	return repository.DeleteCustomPromptCategory(category)
}

// SyncCustomPromptCategory 从自定义分类的 GitHub URL 拉取并替换该分类全部提示词。
func SyncCustomPromptCategory(category string) ([]model.PromptCategory, error) {
	item, ok := repository.PromptCategoryByCode(category)
	if !ok || !item.Custom {
		return nil, nil
	}
	if strings.TrimSpace(item.GithubURL) == "" {
		return ListCustomPromptCategories()
	}
	items, err := buildCustomPromptCategory(item.GithubURL)
	if err != nil {
		return nil, err
	}
	promptItems := make([]model.Prompt, 0, len(items))
	for i := range items {
		now := time.Now().Format(time.RFC3339)
		items[i].ID = category + "-" + leftPad(i+1)
		items[i].Category = category
		items[i].CreatedAt = now
		items[i].UpdatedAt = now
		items[i].GithubURL = ""
		promptItems = append(promptItems, items[i])
	}
	if err := repository.ReplacePromptCategory(item, promptItems); err != nil {
		return nil, err
	}
	return ListPromptCategories(), nil
}

// buildCustomPromptCategory 从给定 GitHub 仓库（raw base URL）解析出提示词条目。
//
// 兼容常见格式，按优先级依次尝试：
//  1. README.md 中 Markdown 标题 + 提示词代码块（### 标题 / **Prompt:** 代码块）
//  2. 仓库内的 cases-*.md / 全部 *.md 分片文件（逐个拉取解析合并，适合分片仓库）
//  3. JSON 数组（[{title, prompt}, ...]）
//  4. prompts.json / data/*.json 数组
//  5. 单行文本（每行一条 prompt，行首可选 "标题: prompt"）
func buildCustomPromptCategory(baseURL string) ([]model.Prompt, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, nil
	}
	rawBase := normalizeGithubRawBase(baseURL)

	// 先尝试 README.md
	if data, err := fetchText(rawBase, "README.md"); err == nil {
		if items := parseCustomMarkdownPrompts(rawBase, data); len(items) > 0 {
			return items, nil
		}
	}
	if data, err := fetchText(rawBase, "README_zh.md"); err == nil {
		if items := parseCustomMarkdownPrompts(rawBase, data); len(items) > 0 {
			return items, nil
		}
	}
	if data, err := fetchText(rawBase, "README.zh-CN.md"); err == nil {
		if items := parseCustomMarkdownPrompts(rawBase, data); len(items) > 0 {
			return items, nil
		}
	}

	// 读取仓库内的分片 Markdown 文件（cases-*.md 优先，其次所有 .md）
	if items := buildCustomCaseFiles(rawBase); len(items) > 0 {
		return items, nil
	}

	// 尝试 JSON 文件（常见命名）
	for _, file := range []string{"prompts.json", "data/prompts.json", "data/ingested_tweets.json", "data/latest-prompts.json"} {
		data, err := fetchText(rawBase, file)
		if err != nil {
			continue
		}
		if items := parseCustomJsonPrompts(data); len(items) > 0 {
			return items, nil
		}
	}

	// 最后退回：直接拉 README 全文，每行作为一条
	if data, err := fetchText(rawBase, "README.md"); err == nil {
		if items := parseCustomPlainTextPrompts(data); len(items) > 0 {
			return items, nil
		}
	}
	return []model.Prompt{}, nil
}

// buildCustomCaseFiles 列出仓库内 Markdown 分片文件并逐个解析合并。
// 优先取 cases-*.md，其次取其余 *.md（跳过 README 与打包清单）。
func buildCustomCaseFiles(rawBase string) []model.Prompt {
	apiBase := normalizeGithubApiBase(rawBase)
	files := listGithubMarkdownFiles(apiBase)
	if len(files) == 0 {
		return nil
	}
	var items []model.Prompt
	for _, file := range files {
		if data, err := fetchText(rawBase, file); err == nil {
			if parsed := parseCustomMarkdownPrompts(rawBase, data); len(parsed) > 0 {
				items = append(items, parsed...)
			}
		}
	}
	return items
}

// normalizeGithubApiBase 把 raw base 转成 GitHub contents API base（用于列文件）。
// raw: https://raw.githubusercontent.com/owner/repo/branch[/path] -> https://api.github.com/repos/owner/repo/contents[/path]
func normalizeGithubApiBase(rawBase string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(rawBase), "/")
	prefix := "https://raw.githubusercontent.com/"
	if !strings.HasPrefix(trimmed, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(trimmed, prefix)
	parts := strings.Split(rest, "/")
	if len(parts) < 3 {
		return ""
	}
	owner, repo, branch := parts[0], parts[1], parts[2]
	path := ""
	if len(parts) > 3 {
		path = strings.Join(parts[3:], "/")
	}
	api := "https://api.github.com/repos/" + owner + "/" + repo + "/contents"
	if path != "" {
		api += "/" + path
	}
	return api + "?ref=" + branch
}

// listGithubMarkdownFiles 通过 GitHub contents API 列出仓库内可解析的 Markdown 分片文件。
func listGithubMarkdownFiles(apiBase string) []string {
	if apiBase == "" {
		return nil
	}
	request, _ := http.NewRequest(http.MethodGet, apiBase, nil)
	request.Header.Set("Accept", "application/vnd.github+json")
	client := http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil
	}
	var entries []struct {
		Name string `json:"name"`
		Type string `json:"type"`
	}
	if err := json.NewDecoder(response.Body).Decode(&entries); err != nil {
		return nil
	}
	var cases, others []string
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name)
		if entry.Type != "file" || !strings.HasSuffix(strings.ToLower(name), ".md") {
			continue
		}
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "readme") || strings.HasPrefix(lower, "changelog") || strings.HasPrefix(lower, "license") || strings.HasPrefix(lower, "contributing") || strings.HasPrefix(lower, "security") {
			continue
		}
		if strings.HasPrefix(lower, "cases-") {
			cases = append(cases, name)
		} else {
			others = append(others, name)
		}
	}
	result := make([]string, 0, len(cases)+len(others))
	result = append(result, cases...)
	result = append(result, others...)
	return result
}

// normalizeGithubRawBase 把 github.com 的仓库地址转成 raw.githubusercontent.com 的 base。
func normalizeGithubRawBase(url string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(url), "/")
	replacer := []string{
		"https://raw.githubusercontent.com/", "",
		"http://raw.githubusercontent.com/", "",
		"https://github.com/", "",
		"http://github.com/", "",
		"git@github.com:", "",
		".git", "",
	}
	for i := 0; i < len(replacer); i += 2 {
		if strings.HasPrefix(trimmed, replacer[i]) {
			trimmed = replacer[i+1] + trimmed[len(replacer[i]):]
			break
		}
	}
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	// owner/repo 或 owner/repo/tree/branch/path
	if len(parts) >= 2 {
		owner, repo := parts[0], parts[1]
		repo = strings.TrimSuffix(repo, ".git")
		branch := "main"
		pathPrefix := ""
		if len(parts) >= 4 && parts[2] == "tree" {
			branch = parts[3]
			if len(parts) > 4 {
				pathPrefix = strings.Join(parts[4:], "/")
			}
		}
		base := "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + branch
		if pathPrefix != "" {
			base += "/" + pathPrefix
		}
		return base
	}
	return "https://raw.githubusercontent.com/" + trimmed + "/main"
}

// parseCustomMarkdownPrompts 从 Markdown 中解析「标题 + 提示词」条目。
func parseCustomMarkdownPrompts(rawBase string, markdown string) []model.Prompt {
	items := []model.Prompt{}
	for _, block := range splitBeforeHeading(markdown, "### ") {
		title := strings.TrimSpace(firstMatch(block, `(?m)^###\s+(.+)$`))
		if title == "" {
			continue
		}
		prompt := strings.TrimSpace(firstMatch(block, "(?s)\\*\\*Prompt\\*?\\*?:\\s*\\r?\\n\\s*```[\\w-]*\\r?\\n(.*?)\\r?\\n```"))
		if prompt == "" {
			prompt = strings.TrimSpace(firstMatch(block, "(?s)\\r?\\n```[\\w-]*\\r?\\n(.*?)\\r?\\n```"))
		}
		if prompt == "" {
			continue
		}
		images := extractMarkdownImages(rawBase, block)
		cover := ""
		if len(images) > 0 {
			cover = images[0]
		}
		tags := tagsFromHeading(title)
		if tagText := firstMatch(block, `标签[:：]\s*\*{0,2}\s*([^\n]+)`); tagText != "" {
			if split := splitCustomTags(tagText); len(split) > 0 {
				tags = split
			}
		} else if tagText := firstMatch(block, `(?i)Tags[:：]\s*\*{0,2}\s*([^\n]+)`); tagText != "" {
			if split := splitCustomTags(tagText); len(split) > 0 {
				tags = split
			}
		}
		items = append(items, model.Prompt{Title: title, CoverURL: cover, Prompt: prompt, Tags: tags, Preview: markdownPreview(images)})
	}
	return items
}

// parseCustomJsonPrompts 从 JSON 数组解析提示词条目。
func parseCustomJsonPrompts(data string) []model.Prompt {
	var raw []json.RawMessage
	if err := json.Unmarshal([]byte(data), &raw); err != nil {
		return nil
	}
	items := []model.Prompt{}
	for _, entry := range raw {
		var record map[string]any
		if err := json.Unmarshal(entry, &record); err != nil {
			continue
		}
		title := firstStringValue(record, "title", "title_en", "title_cn", "name")
		prompt := firstStringValue(record, "prompt", "text", "content", "prompt_text")
		if prompt == "" {
			continue
		}
		if title == "" {
			title = firstNonEmptyPrefix(prompt, 24)
		}
		image := firstStringValue(record, "cover_url", "image", "image_url", "primary_image_url", "coverUrl")
		items = append(items, model.Prompt{Title: title, CoverURL: image, Prompt: prompt, Tags: jsonTagsFromRecord(record), Preview: markdownPreview(nonEmptyStrings(image))})
	}
	return items
}

// parseCustomPlainTextPrompts 从纯文本按行解析提示词（行首可选「标题: prompt」）。
func parseCustomPlainTextPrompts(data string) []model.Prompt {
	items := []model.Prompt{}
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "!") || strings.HasPrefix(line, "[") || strings.HasPrefix(line, "```") {
			continue
		}
		title := ""
		prompt := line
		if idx := strings.Index(line, "："); idx > 0 && idx < 20 {
			title = strings.TrimSpace(line[:idx])
			prompt = strings.TrimSpace(line[idx+1:])
		} else if idx := strings.Index(line, ":"); idx > 0 && idx < 20 {
			title = strings.TrimSpace(line[:idx])
			prompt = strings.TrimSpace(line[idx+1:])
		}
		if prompt == "" {
			continue
		}
		if title == "" {
			title = firstNonEmptyPrefix(prompt, 24)
		}
		items = append(items, model.Prompt{Title: title, Prompt: prompt, Tags: tagsFromHeading(title)})
	}
	return items
}

func firstStringValue(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := record[key]; ok {
			if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
	}
	return ""
}

func jsonTagsFromRecord(record map[string]any) []string {
	value, ok := record["tags"]
	if !ok {
		return []string{}
	}
	switch typed := value.(type) {
	case []any:
		tags := []string{}
		for _, item := range typed {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				tags = append(tags, strings.TrimSpace(text))
			}
		}
		return tags
	case string:
		return splitTags(typed, `\s*(/|&|、|,|，|与)\s*`)
	}
	return []string{}
}

func nonEmptyStrings(values ...string) []string {
	result := []string{}
	for _, value := range values {
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

func firstNonEmptyPrefix(value string, count int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= count {
		return value
	}
	return string(runes[:count]) + "…"
}

// splitCustomTags 拆分标签字串：只按英文逗号、中文逗号、顿号、斜杠拆分，
// 保留 &（如 Products & E-commerce 整体）与原始大小写（UI / 3D 不改写）。
func splitCustomTags(value string) []string {
	parts := regexp.MustCompile(`\s*(,|，|、|/)\s*`).Split(value, -1)
	tags := []string{}
	seen := map[string]bool{}
	for _, part := range parts {
		tag := strings.TrimSpace(part)
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true
		tags = append(tags, tag)
	}
	return tags
}
