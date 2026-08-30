"use client";

import { CopyOutlined, DeleteOutlined, EditOutlined, ExportOutlined, EyeOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SyncOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { Button, Card, Col, Flex, Form, Image, Input, Modal, Row, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { useEffect, useState } from "react";

import { useCopyText } from "@/hooks/use-copy-text";
import type { Prompt } from "@/services/api/prompts";
import { type AdminPromptCategory } from "@/services/api/admin";
import { useAdminPrompts } from "./use-admin-prompts";

export default function AdminPromptsPage() {
    const {
        categories,
        customCategories,
        prompts,
        tags,
        keyword,
        category,
        tag,
        page,
        pageSize,
        total,
        isLoading,
        isSyncing,
        searchPrompts,
        changeCategory,
        changeTag,
        changePage,
        changePageSize,
        resetFilters,
        refreshPrompts,
        syncCategory,
        syncAllCategories,
        savePrompt: saveAdminPrompt,
        deletePrompt,
        deletePrompts,
        saveCustomCategory,
        deleteCustomCategory,
        syncCustomCategory,
    } = useAdminPrompts();
    const copyText = useCopyText();
    const [form] = Form.useForm<Partial<Prompt> & { tagText?: string }>();
    const [keywordText, setKeywordText] = useState(keyword);
    const [editingPrompt, setEditingPrompt] = useState<Partial<Prompt> | null>(null);
    const [detailPrompt, setDetailPrompt] = useState<Prompt | null>(null);
    const [deletingPrompt, setDeletingPrompt] = useState<Prompt | null>(null);
    const [selectedPromptIds, setSelectedPromptIds] = useState<string[]>([]);
    const [isBatchDeleteOpen, setIsBatchDeleteOpen] = useState(false);
    const [isSyncOpen, setIsSyncOpen] = useState(false);
    const [editingCustomCategory, setEditingCustomCategory] = useState<AdminPromptCategory | null>(null);
    const [deletingCustomCategory, setDeletingCustomCategory] = useState<AdminPromptCategory | null>(null);
    const [customCategoryForm] = Form.useForm<AdminPromptCategory>();
    const defaultCategory = categories[0]?.category || "";
    const categoryName = (category: string) => categories.find((item) => item.category === category)?.name || category;
    const categoryOptions = [{ label: "全部分类", value: "" }, ...categories.map((item) => ({ label: item.name, value: item.category }))];
    const tagOptions = tags.map((item) => ({ label: item, value: item }));

    useEffect(() => {
        if (editingPrompt) form.setFieldsValue({ ...editingPrompt, tagText: editingPrompt.tags?.join(", ") || "" });
    }, [editingPrompt, form]);

    useEffect(() => setKeywordText(keyword), [keyword]);

    const savePrompt = async () => {
        const value = await form.validateFields();
        await saveAdminPrompt({
            ...editingPrompt,
            ...value,
            category: value.category || defaultCategory,
            tags: (value.tagText || "")
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
        });
        setEditingPrompt(null);
    };

    const batchDeletePrompts = async () => {
        await deletePrompts(selectedPromptIds);
        setSelectedPromptIds([]);
        setIsBatchDeleteOpen(false);
    };

    const saveCustomCategoryPrompt = async () => {
        const value = await customCategoryForm.validateFields();
        await saveCustomCategory(value);
        setEditingCustomCategory(null);
    };

    const deleteCustomCategoryPrompt = async () => {
        if (!deletingCustomCategory) return;
        await deleteCustomCategory(deletingCustomCategory.category);
        setDeletingCustomCategory(null);
    };

    const columns: ProColumns<Prompt>[] = [
        {
            title: "封面",
            dataIndex: "coverUrl",
            width: 88,
            render: (_, item) => <Image src={item.coverUrl || "/logo.svg"} alt={item.title} width={56} height={42} style={{ objectFit: "cover", borderRadius: 6 }} preview={{ mask: "放大" }} fallback="/logo.svg" />,
        },
        {
            title: "标题",
            dataIndex: "title",
            width: 260,
            render: (_, item) => (
                <Typography.Link strong ellipsis style={{ maxWidth: 260, display: "block" }} onClick={() => setDetailPrompt(item)}>
                    {item.title}
                </Typography.Link>
            ),
        },
        {
            title: "分类",
            dataIndex: "category",
            width: 150,
            render: (_, item) => <Typography.Text type="secondary">{categoryName(item.category)}</Typography.Text>,
        },
        {
            title: "标签",
            dataIndex: "tags",
            width: 180,
            render: (_, item) => (
                <Space size={[4, 4]} wrap>
                    {(item.tags || []).slice(0, 3).map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                    ))}
                </Space>
            ),
        },
        {
            title: "操作",
            key: "actions",
            width: 112,
            align: "right",
            render: (_, item) => (
                <Space size={4}>
                    <Tooltip title="详情">
                        <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => setDetailPrompt(item)} />
                    </Tooltip>
                    <Tooltip title="编辑">
                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditingPrompt(item)} />
                    </Tooltip>
                    <Tooltip title="删除">
                        <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => setDeletingPrompt(item)} />
                    </Tooltip>
                </Space>
            ),
        },
    ];

    return (
        <main style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <Form layout="vertical">
                        <Row gutter={16} align="bottom">
                            <Col flex="360px">
                                <Form.Item label="关键词">
                                    <Input.Search value={keywordText} placeholder="搜索标题或提示词" allowClear enterButton={<SearchOutlined />} onSearch={() => searchPrompts(keywordText)} onChange={(event) => setKeywordText(event.target.value)} />
                                </Form.Item>
                            </Col>
                            <Col flex="220px">
                                <Form.Item label="分组">
                                    <Select value={category} onChange={changeCategory} options={categoryOptions} />
                                </Form.Item>
                            </Col>
                            <Col flex="220px">
                                <Form.Item label="标签">
                                    <Select mode="multiple" allowClear maxTagCount="responsive" value={tag} onChange={changeTag} options={tagOptions} placeholder="全部标签" />
                                </Form.Item>
                            </Col>
                            <Col flex="none">
                                <Form.Item>
                                    <Space>
                                        <Button
                                            onClick={() => {
                                                setKeywordText("");
                                                resetFilters();
                                            }}
                                        >
                                            重置
                                        </Button>
                                        <Button type="primary" icon={<ReloadOutlined />} onClick={() => searchPrompts(keywordText)}>
                                            查询
                                        </Button>
                                    </Space>
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Card>
                <Card variant="borderless" title={
                    <Space>
                        <Typography.Text strong>自定义提示词库</Typography.Text>
                        <Tag>{customCategories.length} 个</Tag>
                    </Space>
                } extra={
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => { customCategoryForm.resetFields(); setEditingCustomCategory({ category: "", name: "", description: "", file: "", githubUrl: "", remote: false, custom: true }); }}>
                        新建库
                    </Button>
                }>
                    <Table
                        rowKey="category"
                        dataSource={customCategories}
                        pagination={false}
                        columns={[
                            {
                                title: "分类编码",
                                dataIndex: "category",
                                width: 200,
                            },
                            {
                                title: "名称",
                                dataIndex: "name",
                                render: (_, item) => <Typography.Text strong>{item.name}</Typography.Text>,
                            },
                            {
                                title: "说明",
                                dataIndex: "description",
                                render: (_, item) => <Typography.Text type="secondary" ellipsis>{item.description || "-"}</Typography.Text>,
                            },
                            {
                                title: "GitHub 源",
                                dataIndex: "githubUrl",
                                render: (_, item) => item.githubUrl ? <Typography.Link href={item.githubUrl} target="_blank"><Space><ExportOutlined />远程源</Space></Typography.Link> : <Typography.Text type="secondary">未配置</Typography.Text>,
                            },
                            {
                                title: "操作",
                                key: "actions",
                                width: 180,
                                align: "right",
                                render: (_, item) => (
                                    <Space size={4}>
                                        <Tooltip title="同步">
                                            <Button type="text" size="small" icon={<SyncOutlined />} onClick={async () => { try { await syncCustomCategory(item.category); } catch {} }} />
                                        </Tooltip>
                                        <Tooltip title="编辑">
                                            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => { customCategoryForm.setFieldsValue(item); setEditingCustomCategory(item); }} />
                                        </Tooltip>
                                        <Tooltip title="删除">
                                            <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => setDeletingCustomCategory(item)} />
                                        </Tooltip>
                                    </Space>
                                ),
                            },
                        ]}
                    />
                </Card>
                <ProTable<Prompt>
                    rowKey="id"
                    columns={columns}
                    dataSource={prompts}
                    loading={isLoading}
                    search={false}
                    defaultSize="middle"
                    tableLayout="fixed"
                    cardProps={{ variant: "borderless" }}
                    headerTitle={
                        <Space>
                            <Typography.Text strong>提示词列表</Typography.Text>
                            <Tag>{total} 条</Tag>
                        </Space>
                    }
                    options={{ density: true, setting: true, reload: () => void refreshPrompts() }}
                    rowSelection={{ selectedRowKeys: selectedPromptIds, onChange: (keys) => setSelectedPromptIds(keys.map(String)) }}
                    toolBarRender={() => [
                        <Button key="batch-delete" danger icon={<DeleteOutlined />} disabled={!selectedPromptIds.length} onClick={() => setIsBatchDeleteOpen(true)}>
                            批量删除{selectedPromptIds.length ? ` ${selectedPromptIds.length}` : ""}
                        </Button>,
                        <Button key="sync" icon={<SyncOutlined />} onClick={() => setIsSyncOpen(true)}>
                            同步
                        </Button>,
                        <Button key="sync-all" icon={<SyncOutlined />} loading={isSyncing} onClick={() => void syncAllCategories()}>
                            全部同步
                        </Button>,
                        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => setEditingPrompt({ category: defaultCategory, tags: [] })}>
                            新增
                        </Button>,
                    ]}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showSizeChanger: true,
                        pageSizeOptions: [10, 20, 50, 100],
                        showTotal: (value) => `共 ${value} 条`,
                        onChange: (nextPage, nextPageSize) => (nextPageSize !== pageSize ? changePageSize(nextPageSize) : changePage(nextPage)),
                    }}
                />
            </Flex>

            <Modal title={editingPrompt?.id ? "编辑提示词" : "新增提示词"} open={Boolean(editingPrompt)} width={720} onCancel={() => setEditingPrompt(null)} onOk={() => void savePrompt()} okText="保存" cancelText="取消" destroyOnHidden>
                <Form form={form} layout="vertical" requiredMark={false}>
                    <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                        <Input />
                    </Form.Item>
                    <Form.Item name="category" label="分类">
                        <Select options={categories.map((item) => ({ label: item.name, value: item.category }))} />
                    </Form.Item>
                    <Form.Item name="coverUrl" label="封面 URL">
                        <Input />
                    </Form.Item>
                    <Form.Item name="tagText" label="标签，用逗号分隔">
                        <Input />
                    </Form.Item>
                    <Form.Item name="prompt" label="提示词" rules={[{ required: true, message: "请输入提示词" }]}>
                        <Input.TextArea rows={6} />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal title="提示词详情" open={Boolean(detailPrompt)} width={760} onCancel={() => setDetailPrompt(null)} footer={<Button onClick={() => setDetailPrompt(null)}>关闭</Button>}>
                {detailPrompt ? (
                    <Flex vertical gap={14}>
                        <Flex gap={14} align="start">
                            <Image src={detailPrompt.coverUrl || "/logo.svg"} alt={detailPrompt.title} width={116} height={84} style={{ objectFit: "cover", borderRadius: 8 }} preview={{ mask: "放大" }} fallback="/logo.svg" />
                            <Flex vertical gap={8} style={{ minWidth: 0 }}>
                                <Typography.Title level={5} style={{ margin: 0 }}>
                                    {detailPrompt.title}
                                </Typography.Title>
                                <Space wrap>
                                    <Tag>{categoryName(detailPrompt.category)}</Tag>
                                    {(detailPrompt.tags || []).map((tag) => (
                                        <Tag key={tag}>{tag}</Tag>
                                    ))}
                                </Space>
                            </Flex>
                        </Flex>
                        {detailPrompt.preview ? (
                            <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                                {detailPrompt.preview}
                            </Typography.Paragraph>
                        ) : null}
                        <Input.TextArea value={detailPrompt.prompt} rows={8} readOnly />
                        <Space>
                            <Button icon={<CopyOutlined />} onClick={() => copyText(detailPrompt.prompt)}>
                                复制提示词
                            </Button>
                            {detailPrompt.githubUrl ? (
                                <Button icon={<ExportOutlined />} href={detailPrompt.githubUrl} target="_blank">
                                    远程源
                                </Button>
                            ) : null}
                        </Space>
                    </Flex>
                ) : null}
            </Modal>

            <Modal
                title="同步远程提示词源"
                open={isSyncOpen}
                width={640}
                onCancel={() => !isSyncing && setIsSyncOpen(false)}
                mask={{ closable: !isSyncing }}
                footer={
                    <Button disabled={isSyncing} onClick={() => setIsSyncOpen(false)}>
                        取消
                    </Button>
                }
            >
                <Table
                    rowKey="category"
                    dataSource={categories.filter((item) => item.remote)}
                    pagination={false}
                    columns={[
                        {
                            title: "远程源",
                            dataIndex: "name",
                            render: (_, item) => (
                                <Flex align="center" gap={8}>
                                    {item.name}
                                    {item.githubUrl ? (
                                        <Typography.Link href={item.githubUrl} target="_blank">
                                            <ExportOutlined />
                                        </Typography.Link>
                                    ) : null}
                                </Flex>
                            ),
                        },
                        {
                            title: "",
                            key: "sync",
                            width: 96,
                            align: "right",
                            render: (_, item) => (
                                <Button
                                    type="primary"
                                    loading={isSyncing}
                                    onClick={async () => {
                                        try {
                                            await syncCategory(item.category);
                                            setIsSyncOpen(false);
                                        } catch {}
                                    }}
                                >
                                    同步
                                </Button>
                            ),
                        },
                    ]}
                />
            </Modal>

            <Modal
                title="删除提示词"
                open={Boolean(deletingPrompt)}
                onCancel={() => setDeletingPrompt(null)}
                onOk={async () => {
                    if (!deletingPrompt) return;
                    await deletePrompt(deletingPrompt.id);
                    setDeletingPrompt(null);
                }}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                确定删除「{deletingPrompt?.title}」吗？删除后会从当前分类中删除。
            </Modal>

            <Modal title="批量删除提示词" open={isBatchDeleteOpen} onCancel={() => setIsBatchDeleteOpen(false)} onOk={() => void batchDeletePrompts()} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除已选中的 {selectedPromptIds.length} 条提示词吗？删除后会从当前分类中删除。
            </Modal>

            <Modal title={editingCustomCategory?.category ? "编辑自定义提示词库" : "新建自定义提示词库"} open={Boolean(editingCustomCategory)} width={640} onCancel={() => setEditingCustomCategory(null)} onOk={() => void saveCustomCategoryPrompt()} okText="保存" cancelText="取消" destroyOnHidden>
                <Form form={customCategoryForm} layout="vertical" requiredMark={false}>
                    <Form.Item name="category" label="分类编码（唯一，英文/数字/中划线）" rules={[{ required: true, message: "请输入分类编码" }]}>
                        <Input placeholder="如 video-prompts / ecommerce-prompts" disabled={Boolean(editingCustomCategory?.category)} />
                    </Form.Item>
                    <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
                        <Input placeholder="如 视频提示词库 / 电商产品出图库" />
                    </Form.Item>
                    <Form.Item name="description" label="说明">
                        <Input.TextArea rows={2} placeholder="这个库的用途简介" />
                    </Form.Item>
                    <Form.Item name="githubUrl" label="GitHub 仓库地址（配置后可一键同步）">
                        <Input placeholder="如 https://github.com/owner/repo" />
                    </Form.Item>
                </Form>
                <Typography.Text type="secondary">配置 GitHub 地址后点「同步」会按 Markdown 标题+代码块 / JSON / 纯文本自动解析出提示词；不填则仅作为空库手动添加。</Typography.Text>
            </Modal>

            <Modal title="删除自定义提示词库" open={Boolean(deletingCustomCategory)} onCancel={() => setDeletingCustomCategory(null)} onOk={async () => { await deleteCustomCategoryPrompt(); }} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除「{deletingCustomCategory?.name}」吗？该分类及其下全部提示词都会被删除，且不影响内置库。
            </Modal>
        </main>
    );
}
