package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

type adminSyncRequest struct {
	Category string `json:"category"`
}

type adminBatchDeleteRequest struct {
	IDs []string `json:"ids"`
}

func AdminPromptCategories(w http.ResponseWriter, r *http.Request) {
	OK(w, service.ListPromptCategories())
}

func AdminSyncAllPromptCategories(w http.ResponseWriter, r *http.Request) {
	service.SyncRemotePromptCategories()
	OK(w, service.ListPromptCategories())
}

func AdminPrompts(w http.ResponseWriter, r *http.Request) {
	result, err := service.ListPrompts(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminSavePrompt(w http.ResponseWriter, r *http.Request) {
	var item model.Prompt
	_ = json.NewDecoder(r.Body).Decode(&item)
	result, err := service.SavePrompt(item)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminDeletePrompt(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeletePrompt(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminDeletePrompts(w http.ResponseWriter, r *http.Request) {
	var request adminBatchDeleteRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	if err := service.DeletePrompts(request.IDs); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminSyncPromptCategories(w http.ResponseWriter, r *http.Request) {
	var request adminSyncRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	log.Printf("sync prompt category start category=%s", request.Category)
	categories, err := service.SyncPromptCategory(request.Category)
	if err != nil {
		log.Printf("sync prompt category failed category=%s err=%v", request.Category, err)
		FailError(w, err)
		return
	}
	log.Printf("sync prompt category done category=%s", request.Category)
	OK(w, categories)
}

// AdminCustomPromptCategories 返回管理员自定义提示词分类。
func AdminCustomPromptCategories(w http.ResponseWriter, r *http.Request) {
	categories, err := service.ListCustomPromptCategories()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, categories)
}

// AdminSaveCustomPromptCategory 新建或更新自定义提示词分类。
func AdminSaveCustomPromptCategory(w http.ResponseWriter, r *http.Request) {
	var item model.PromptCategory
	_ = json.NewDecoder(r.Body).Decode(&item)
	if strings.TrimSpace(item.Category) == "" || strings.TrimSpace(item.Name) == "" {
		Fail(w, "分类编码与名称不能为空")
		return
	}
	result, err := service.SaveCustomPromptCategory(item)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

// AdminDeleteCustomPromptCategory 删除自定义提示词分类及其提示词。
func AdminDeleteCustomPromptCategory(w http.ResponseWriter, r *http.Request, category string) {
	if err := service.DeleteCustomPromptCategory(category); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

// AdminSyncCustomPromptCategory 从自定义分类的 GitHub URL 同步提示词。
func AdminSyncCustomPromptCategory(w http.ResponseWriter, r *http.Request) {
	var request adminSyncRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	log.Printf("sync custom prompt category start category=%s", request.Category)
	categories, err := service.SyncCustomPromptCategory(request.Category)
	if err != nil {
		log.Printf("sync custom prompt category failed category=%s err=%v", request.Category, err)
		FailError(w, err)
		return
	}
	log.Printf("sync custom prompt category done category=%s", request.Category)
	OK(w, categories)
}
