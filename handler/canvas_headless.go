package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/service"
)

// 无头画布通道：让「没有浏览器」的外部智能体也能读写画布。
//
// 背景：MCP 的画布工具由浏览器上报并执行，页面一关就全部失效。
// 这里直接操作 canvas_project.project_data（nodes / connections），
// 只依赖服务端鉴权，因此可以在无人值守、批量生产、CI 里使用。
//
// 鉴权：middleware.AgentServiceAuth（X-Agent-Key + X-User-Id），仅限服务器同机/内网。
// 与浏览器前端并发写同一画布时以 updatedAt 较新者为准（仓储层已有该保护）。

const headlessSnapshotContentLimit = 240

// headlessNow 返回与前端 new Date().toISOString() 一致的时间格式。
// 必须精确到毫秒：仓储层用字符串比较判断新旧，格式不一致会让服务端写入被误判为旧数据。
func headlessNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// headlessID 生成节点/连线 ID（前端只要求唯一，不校验格式）。
func headlessID(prefix string) string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return prefix + hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return prefix + hex.EncodeToString(buffer)
}

// AgentCanvasProjects 列出目标用户的画布摘要。
func AgentCanvasProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := service.CurrentUserCanvasProjectSummaries(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, projects)
}

// AgentCanvasGraph 读取画布图结构（节点 + 连线），供智能体规划。
func AgentCanvasGraph(w http.ResponseWriter, r *http.Request, projectID string) {
	raw, err := service.CurrentUserCanvasProject(r.Context(), projectID)
	if err != nil {
		FailError(w, err)
		return
	}
	project, err := decodeHeadlessProject(raw)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, headlessGraphView(project))
}

type headlessOp struct {
	Op           string         `json:"op"`
	NodeID       string         `json:"nodeId"`
	Node         map[string]any `json:"node"`
	Patch        map[string]any `json:"patch"`
	FromNodeID   string         `json:"fromNodeId"`
	ToNodeID     string         `json:"toNodeId"`
	ConnectionID string         `json:"connectionId"`
}

type headlessOpsRequest struct {
	Ops []headlessOp `json:"ops"`
}

// AgentCanvasOps 批量执行画布操作，一次请求完成多个节点的增删改与连线。
func AgentCanvasOps(w http.ResponseWriter, r *http.Request, projectID string) {
	var request headlessOpsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&request); err != nil {
		Fail(w, "操作参数无效")
		return
	}
	if len(request.Ops) == 0 {
		Fail(w, "ops 不能为空")
		return
	}
	if len(request.Ops) > 200 {
		Fail(w, "单次最多 200 个操作")
		return
	}

	raw, err := service.CurrentUserCanvasProject(r.Context(), projectID)
	if err != nil {
		FailError(w, err)
		return
	}
	project, err := decodeHeadlessProject(raw)
	if err != nil {
		Fail(w, err.Error())
		return
	}

	applied := 0
	for index, op := range request.Ops {
		if err := applyHeadlessOp(project, op); err != nil {
			Fail(w, "第 "+strconv.Itoa(index+1)+" 个操作失败："+err.Error())
			return
		}
		applied++
	}

	project["updatedAt"] = headlessNow()
	saved, err := service.SaveCurrentUserCanvasProject(r.Context(), mustJSON(project))
	if err != nil {
		FailError(w, err)
		return
	}
	result, err := decodeHeadlessProject(saved)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	view := headlessGraphView(result)
	view["applied"] = applied
	OK(w, view)
}

// AgentCanvasGenerate 在无浏览器场景下触发生成任务（图片）。
// 任务与画布节点相互独立：调用方拿到 taskId 后轮询 AgentCanvasTask，
// 再用 ops 把结果写回节点 metadata.content。
func AgentCanvasGenerate(w http.ResponseWriter, r *http.Request, projectID string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var request struct {
		NodeID      string         `json:"nodeId"`
		Prompt      string         `json:"prompt"`
		Model       string         `json:"model"`
		ChannelID   string         `json:"channelId"`
		Size        string         `json:"size"`
		Quality     string         `json:"quality"`
		Count       int            `json:"count"`
		Endpoint    string         `json:"endpoint"`
		RequestBody map[string]any `json:"requestBody"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&request); err != nil {
		Fail(w, "生成参数无效")
		return
	}
	request.Prompt = strings.TrimSpace(request.Prompt)
	request.Model = strings.TrimSpace(request.Model)
	if request.Prompt == "" || request.Model == "" {
		Fail(w, "prompt 与 model 不能为空")
		return
	}
	endpoint := strings.TrimSpace(request.Endpoint)
	if endpoint == "" {
		endpoint = "/images/generations"
	}
	if !strings.HasPrefix(endpoint, "/images/") {
		Fail(w, "endpoint 目前仅支持 /images/generations 与 /images/edits")
		return
	}

	// 确认画布存在，避免给一个不存在的 project 建任务。
	if _, err := service.CurrentUserCanvasProject(r.Context(), projectID); err != nil {
		FailError(w, err)
		return
	}

	channel, resolvedUserChannelID, err := selectAIRequestChannel(user, request.Model, request.ChannelID, "")
	if err != nil {
		Fail(w, err.Error())
		return
	}

	payload := request.RequestBody
	if len(payload) == 0 {
		count := request.Count
		if count <= 0 {
			count = 1
		}
		payload = map[string]any{
			"model":           request.Model,
			"prompt":          request.Prompt,
			"n":               count,
			"response_format": "b64_json",
		}
		if strings.TrimSpace(request.Size) != "" {
			payload["size"] = strings.TrimSpace(request.Size)
		}
		if strings.TrimSpace(request.Quality) != "" {
			payload["quality"] = strings.TrimSpace(request.Quality)
		}
		payload["model"] = request.Model
	}
	body := mustJSON(payload)

	task, err := service.CreateCanvasImageTask(service.CanvasImageTaskCreateInput{
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Source:          "agent",
		SourceID:        projectID,
		NodeID:          strings.TrimSpace(request.NodeID),
		Model:           request.Model,
		ChannelID:       channel.ID,
		UserChannelID:   resolvedUserChannelID,
		ChannelName:     channel.Name,
		Prompt:          request.Prompt,
		GenerationType:  strings.TrimPrefix(endpoint, "/images/"),
		Endpoint:        endpoint,
		ContentType:     "application/json",
		RequestBody:     summarizeAIRequest(body, "application/json"),
	})
	if err != nil {
		FailError(w, err)
		return
	}
	go runCanvasImageTask(task, user, body, "application/json", task.ChannelID, task.UserChannelID)
	OK(w, service.CanvasImageTaskResponse(task))
}

// AgentCanvasTask 查询图片/音频任务状态。
func AgentCanvasTask(w http.ResponseWriter, r *http.Request, taskID string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	if task, found, err := service.GetUserCanvasImageTask(user.ID, taskID); err != nil {
		FailError(w, err)
	} else if found {
		OK(w, service.CanvasImageTaskResponse(task))
		return
	}
	if task, found, err := service.GetUserCanvasAudioTask(user.ID, taskID); err != nil {
		FailError(w, err)
	} else if found {
		OK(w, service.CanvasAudioTaskResponse(task))
		return
	}
	FailWithStatus(w, http.StatusNotFound, "任务不存在")
}

// ---- 内部实现 ----

func decodeHeadlessProject(raw json.RawMessage) (map[string]any, error) {
	var project map[string]any
	if err := json.Unmarshal(raw, &project); err != nil {
		return nil, errors.New("画布数据解析失败")
	}
	if project == nil {
		return nil, errors.New("画布数据为空")
	}
	ensureHeadlessSlice(project, "nodes")
	ensureHeadlessSlice(project, "connections")
	return project, nil
}

func ensureHeadlessSlice(project map[string]any, key string) {
	if _, ok := project[key].([]any); ok {
		return
	}
	project[key] = []any{}
}

func headlessNodes(project map[string]any) []any {
	nodes, _ := project["nodes"].([]any)
	return nodes
}

func headlessConnections(project map[string]any) []any {
	connections, _ := project["connections"].([]any)
	return connections
}

func headlessGraphView(project map[string]any) map[string]any {
	nodes := make([]any, 0, len(headlessNodes(project)))
	for _, item := range headlessNodes(project) {
		if node, ok := item.(map[string]any); ok {
			nodes = append(nodes, summarizeHeadlessNode(node))
		}
	}
	connections := headlessConnections(project)
	if connections == nil {
		connections = []any{}
	}
	return map[string]any{
		"projectId":     project["id"],
		"title":         project["title"],
		"updatedAt":     project["updatedAt"],
		"nodeCount":     len(nodes),
		"connectionCount": len(connections),
		"nodes":         nodes,
		"connections":   connections,
	}
}

// summarizeHeadlessNode 截断可能内联 Base64 的长字段，避免把几 MB 图片塞给智能体。
func summarizeHeadlessNode(node map[string]any) map[string]any {
	result := map[string]any{}
	for key, value := range node {
		if key == "metadata" {
			continue
		}
		result[key] = value
	}
	metadata, ok := node["metadata"].(map[string]any)
	if !ok {
		return result
	}
	cloned := make(map[string]any, len(metadata))
	for key, value := range metadata {
		if text, ok := value.(string); ok && len(text) > headlessSnapshotContentLimit {
			cloned[key] = text[:headlessSnapshotContentLimit]
			cloned[key+"Truncated"] = true
			continue
		}
		cloned[key] = value
	}
	result["metadata"] = cloned
	return result
}

func applyHeadlessOp(project map[string]any, op headlessOp) error {
	switch strings.TrimSpace(op.Op) {
	case "add_node":
		return headlessAddNode(project, op.Node)
	case "update_node":
		return headlessUpdateNode(project, op.NodeID, op.Patch)
	case "remove_node":
		return headlessRemoveNode(project, op.NodeID)
	case "add_connection":
		return headlessAddConnection(project, op.FromNodeID, op.ToNodeID)
	case "remove_connection":
		return headlessRemoveConnection(project, op.ConnectionID)
	default:
		return errors.New("不支持的操作：" + op.Op)
	}
}

func headlessAddNode(project map[string]any, node map[string]any) error {
	if node == nil {
		return errors.New("add_node 缺少 node")
	}
	id := strings.TrimSpace(asString(node["id"]))
	if id == "" {
		id = headlessID("node-")
	}
	if headlessFindNode(project, id) != nil {
		return errors.New("节点 ID 已存在：" + id)
	}
	nodeType := strings.TrimSpace(asString(node["type"]))
	if nodeType == "" {
		nodeType = "text"
	}
	width, height := defaultHeadlessNodeSize(nodeType)
	created := map[string]any{
		"id":       id,
		"type":     nodeType,
		"title":    firstNonEmpty(strings.TrimSpace(asString(node["title"])), "未命名节点"),
		"position": map[string]any{"x": 0.0, "y": 0.0},
		"width":    width,
		"height":   height,
	}
	if position, ok := node["position"].(map[string]any); ok {
		created["position"] = position
	}
	if value, ok := node["width"]; ok {
		created["width"] = value
	}
	if value, ok := node["height"]; ok {
		created["height"] = value
	}
	if metadata, ok := node["metadata"].(map[string]any); ok {
		created["metadata"] = metadata
	}
	project["nodes"] = append(headlessNodes(project), created)
	return nil
}

func headlessUpdateNode(project map[string]any, nodeID string, patch map[string]any) error {
	node := headlessFindNode(project, strings.TrimSpace(nodeID))
	if node == nil {
		return errors.New("节点不存在：" + nodeID)
	}
	if len(patch) == 0 {
		return errors.New("update_node 缺少 patch")
	}
	for key, value := range patch {
		if key == "id" || key == "type" {
			continue
		}
		if key == "metadata" {
			incoming, ok := value.(map[string]any)
			if !ok {
				continue
			}
			current, _ := node["metadata"].(map[string]any)
			node["metadata"] = mergeHeadlessMap(current, incoming)
			continue
		}
		node[key] = value
	}
	return nil
}

func headlessRemoveNode(project map[string]any, nodeID string) error {
	nodeID = strings.TrimSpace(nodeID)
	if nodeID == "" {
		return errors.New("remove_node 缺少 nodeId")
	}
	if headlessFindNode(project, nodeID) == nil {
		return errors.New("节点不存在：" + nodeID)
	}
	nodes := make([]any, 0, len(headlessNodes(project)))
	for _, item := range headlessNodes(project) {
		if node, ok := item.(map[string]any); ok && asString(node["id"]) == nodeID {
			continue
		}
		nodes = append(nodes, item)
	}
	project["nodes"] = nodes

	connections := make([]any, 0, len(headlessConnections(project)))
	for _, item := range headlessConnections(project) {
		connection, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if asString(connection["fromNodeId"]) == nodeID || asString(connection["toNodeId"]) == nodeID {
			continue
		}
		connections = append(connections, item)
	}
	project["connections"] = connections
	return nil
}

func headlessAddConnection(project map[string]any, fromNodeID string, toNodeID string) error {
	fromNodeID = strings.TrimSpace(fromNodeID)
	toNodeID = strings.TrimSpace(toNodeID)
	if fromNodeID == "" || toNodeID == "" {
		return errors.New("add_connection 需要 fromNodeId 与 toNodeId")
	}
	if fromNodeID == toNodeID {
		return errors.New("不允许自连")
	}
	if headlessFindNode(project, fromNodeID) == nil {
		return errors.New("起点节点不存在：" + fromNodeID)
	}
	if headlessFindNode(project, toNodeID) == nil {
		return errors.New("终点节点不存在：" + toNodeID)
	}
	for _, item := range headlessConnections(project) {
		if connection, ok := item.(map[string]any); ok && asString(connection["fromNodeId"]) == fromNodeID && asString(connection["toNodeId"]) == toNodeID {
			return nil
		}
	}
	project["connections"] = append(headlessConnections(project), map[string]any{
		"id":         headlessID("conn-"),
		"fromNodeId": fromNodeID,
		"toNodeId":   toNodeID,
	})
	return nil
}

func headlessRemoveConnection(project map[string]any, connectionID string) error {
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return errors.New("remove_connection 缺少 connectionId")
	}
	connections := make([]any, 0, len(headlessConnections(project)))
	found := false
	for _, item := range headlessConnections(project) {
		if connection, ok := item.(map[string]any); ok && asString(connection["id"]) == connectionID {
			found = true
			continue
		}
		connections = append(connections, item)
	}
	if !found {
		return errors.New("连线不存在：" + connectionID)
	}
	project["connections"] = connections
	return nil
}

func headlessFindNode(project map[string]any, nodeID string) map[string]any {
	if nodeID == "" {
		return nil
	}
	for _, item := range headlessNodes(project) {
		node, ok := item.(map[string]any)
		if ok && asString(node["id"]) == nodeID {
			return node
		}
	}
	return nil
}

func mergeHeadlessMap(base map[string]any, patch map[string]any) map[string]any {
	merged := make(map[string]any, len(base)+len(patch))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range patch {
		merged[key] = value
	}
	return merged
}

func defaultHeadlessNodeSize(nodeType string) (int, int) {
	switch nodeType {
	case "image", "panorama":
		return 360, 360
	case "video":
		return 480, 270
	case "audio":
		return 320, 120
	case "group":
		return 480, 320
	case "config":
		return 280, 200
	default:
		return 320, 200
	}
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}

func mustJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("{}")
	}
	return data
}
