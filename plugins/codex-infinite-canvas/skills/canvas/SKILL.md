---
name: canvas
description: 操作无限画布（Infinite Canvas）网页画布：读取节点、选区、创建文本节点、创建生成流程、连接节点或触发生成。需要理解或改动画布内容时使用。
---

# 操作无限画布

你正在帮助用户在无限画布网页画布上工作。需要理解或改动画布时，优先使用已配置的 `infinite-canvas` MCP 工具，不要让用户手动复制 JSON、URL 或 token。

## 可用工具

- 读取类：`get_canvas_summary`、`get_selected_nodes`、`get_node`、`get_upstream_nodes`、`get_downstream_nodes`、`get_connected_nodes`、`get_generation_config`、`get_generation_task`、`get_media_task_status`
- 状态类：`set_agent_state`（保存当前创作阶段、已确认方案和正式参考，供刷新后继续）
- 文本类：`create_text_node`、`create_primary_script_node`（创建片头脚本节点）、`update_text_node`、`update_node`
- 结构类：`delete_node`、`create_connection`、`delete_connection`、`create_group`、`arrange_nodes`
- 生成类：`generate_image`、`edit_image`、`generate_video`、`generate_audio`

## 工作流

- 如果用户还没有打开或连接网页画布，先使用 `open-canvas` 技能打开无限画布，不要要求用户手动复制 URL 或 token。
- 操作前先调用 `get_canvas_summary` 读取当前画布；如果用户明确提到选中内容、当前节点或“这个”，先调用 `get_selected_nodes` 读取选区。
- 创建单个文本内容优先使用 `create_text_node`。
- 创建生成内容优先使用 `generate_image`、`edit_image`、`generate_video`、`generate_audio`；生成任务可用 `get_media_task_status` 或 `get_generation_task` 查询进度。
- 需要把提示词、配置和生成节点串成流程时，用 `create_connection` 连接相关节点，需要分组用 `create_group`，需要自动排版用 `arrange_nodes`。
- 需要批量增删改时，逐节点调用对应的创建/更新/删除工具即可（如需批量移动或整理，可用 `arrange_nodes` 或 `update_node`）。
- 不要模拟鼠标点击，不要要求用户手动复制 JSON。
- 写入画布的操作会由网页侧边栏做二次确认，按当前工具返回结果继续推进即可。

## 风格

- 页面文案和画布节点内容默认使用中文。
- 生成节点、配置节点和提示词节点要保持结构清晰，方便用户继续编辑。
- 批量创建节点时注意给节点留出间距，不要堆叠在同一个位置。
- 图片、视频、音频等媒体节点默认保留原始比例；只有用户明确要求自由变形时才改变比例。
- 生成流程尽量少而清楚，优先让用户一眼能看懂节点关系。