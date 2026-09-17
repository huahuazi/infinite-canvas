package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type canvasProjectMetadata struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func canvasProjectFromRaw(
	userID string,
	raw json.RawMessage,
) (model.CanvasProject, error) {
	var metadata canvasProjectMetadata
	if len(raw) == 0 || json.Unmarshal(raw, &metadata) != nil {
		return model.CanvasProject{}, errors.New("画布项目数据无效")
	}

	metadata.ID = strings.TrimSpace(metadata.ID)
	metadata.CreatedAt = strings.TrimSpace(metadata.CreatedAt)
	metadata.UpdatedAt = strings.TrimSpace(metadata.UpdatedAt)
	if metadata.ID == "" || metadata.CreatedAt == "" ||
		metadata.UpdatedAt == "" {
		return model.CanvasProject{}, errors.New("画布项目数据无效")
	}

	return model.CanvasProject{
		UserID:      strings.TrimSpace(userID),
		ID:          metadata.ID,
		ProjectData: string(raw),
		CreatedAt:   metadata.CreatedAt,
		UpdatedAt:   metadata.UpdatedAt,
	}, nil
}

func canvasProjectData(
	projects []model.CanvasProject,
) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(projects))
	for _, project := range projects {
		if strings.TrimSpace(project.ProjectData) != "" {
			result = append(
				result,
				json.RawMessage(project.ProjectData),
			)
		}
	}
	return result
}

// CurrentUserCanvasProjects 返回画布完整数据列表（保留供内部/兼容调用）。
// 列表接口已改用 CurrentUserCanvasProjectSummaries，不要在新代码里用它下发列表。
func CurrentUserCanvasProjects(
	ctx context.Context,
) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	projects, err := repository.ListUserCanvasProjects(user.ID)
	if err != nil {
		return nil, err
	}
	return canvasProjectData(projects), nil
}

// CanvasProjectSummary 画布列表项摘要：只含元数据与计数，不含节点内容。
// 列表接口原先把每个画布的完整 project_data 都回传，画布一多、或某个画布里内联了
// Base64 图片时，「我的画布」每次加载都要传输数 MB（实测 2MB 且未压缩），
// 因此改为只回传摘要，画布内容按需通过 CurrentUserCanvasProject 拉取。
type CanvasProjectSummary struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	NodeCount       int    `json:"nodeCount"`
	ConnectionCount int    `json:"connectionCount"`
	// ContentLoaded 恒为 false：提示前端该条记录只有摘要，需要时再拉取完整内容。
	ContentLoaded bool `json:"contentLoaded"`
}

type canvasProjectSummarySource struct {
	Title       string            `json:"title"`
	Nodes       []json.RawMessage `json:"nodes"`
	Connections []json.RawMessage `json:"connections"`
}

func summarizeCanvasProject(project model.CanvasProject) CanvasProjectSummary {
	summary := CanvasProjectSummary{
		ID:        project.ID,
		CreatedAt: project.CreatedAt,
		UpdatedAt: project.UpdatedAt,
	}
	var source canvasProjectSummarySource
	if err := json.Unmarshal([]byte(project.ProjectData), &source); err != nil {
		return summary
	}
	summary.Title = source.Title
	summary.NodeCount = len(source.Nodes)
	summary.ConnectionCount = len(source.Connections)
	return summary
}

// CurrentUserCanvasProjectSummaries 返回画布列表摘要，不包含任何节点内容。
func CurrentUserCanvasProjectSummaries(
	ctx context.Context,
) ([]CanvasProjectSummary, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	projects, err := repository.ListUserCanvasProjects(user.ID)
	if err != nil {
		return nil, err
	}

	result := make([]CanvasProjectSummary, 0, len(projects))
	for _, project := range projects {
		if strings.TrimSpace(project.ProjectData) == "" {
			continue
		}
		result = append(result, summarizeCanvasProject(project))
	}
	return result, nil
}

// CurrentUserCanvasProject 返回单个画布的完整内容，供打开画布时按需加载。
func CurrentUserCanvasProject(
	ctx context.Context,
	projectID string,
) (json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	project, found, err := repository.GetUserCanvasProject(user.ID, projectID)
	if err != nil {
		return nil, err
	}
	if !found || strings.TrimSpace(project.ProjectData) == "" {
		return nil, errors.New("画布项目不存在")
	}
	return json.RawMessage(project.ProjectData), nil
}

func SaveCurrentUserCanvasProject(
	ctx context.Context,
	raw json.RawMessage,
) (json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	project, err := canvasProjectFromRaw(user.ID, raw)
	if err != nil {
		return nil, err
	}
	saved, err := repository.SaveUserCanvasProject(project)
	if err != nil {
		return nil, err
	}
	if saved.DeletedAt != "" {
		return nil, errors.New("画布项目已删除")
	}
	return json.RawMessage(saved.ProjectData), nil
}

func SyncCurrentUserCanvasProjects(
	ctx context.Context,
	rawProjects []json.RawMessage,
) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	projects := make([]model.CanvasProject, 0, len(rawProjects))
	for _, raw := range rawProjects {
		project, err := canvasProjectFromRaw(user.ID, raw)
		if err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}

	saved, err := repository.SaveUserCanvasProjects(user.ID, projects)
	if err != nil {
		return nil, err
	}
	return canvasProjectData(saved), nil
}

func DeleteCurrentUserCanvasProjects(
	ctx context.Context,
	projectIDs []string,
) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}

	for _, projectID := range projectIDs {
		if strings.TrimSpace(projectID) != "" {
			return repository.SoftDeleteUserCanvasProjects(
				user.ID,
				projectIDs,
				time.Now().UTC().Format(time.RFC3339Nano),
			)
		}
	}
	return errors.New("画布项目参数无效")
}
