# 文镕 WenRong

通用翻译润色服务。输入 `prompt`（可选）+ `text`，输出 LLM 处理后的文本。

- 不传 `prompt`：默认按「润色并翻译成中文」处理。
- 传了 `prompt`：按调用方自定义指令处理（改写、摘要、任意转换均可）。
- 配套 Web 管理后台：配置 System/Default Prompt、管理 LLM 供应商、管理业务 API Key、查看调用日志与运行指标。

详细产品设计见 [`docs/PRODUCT_DESIGN.md`](docs/PRODUCT_DESIGN.md)。

## 快速开始

### 本地运行

```bash
npm start
# 默认监听 http://0.0.0.0:4090
```

首次启动会自动创建一条默认 LLM 供应商记录（地址来自 `DEFAULT_PROVIDER_BASE_URL`，API Key 留空），
打开 `http://localhost:4090/admin` 完成管理员账号初始化后，在「LLM 供应商」页填入真实 API Key。

### Docker 部署

```bash
cp config/.env.example .env
# 编辑 .env，至少设置 ENCRYPTION_KEY 为随机字符串
docker compose up -d
```

- 业务 API：`http://<host>:4090/api/v1/process`
- 管理后台：`http://<host>:4090/admin`

> 安全提示：本服务启动后即对外提供 HTTP API 和管理后台。业务 API 需要 `Authorization: Bearer <API_KEY>`
> 才能调用（在后台「API Key 管理」页生成），管理后台需要账号密码登录。默认不建议把本服务直接暴露到公网，
> 推荐部署在内网，仅供内部项目调用。

## 业务 API

### POST /api/v1/process

```bash
curl -X POST http://localhost:4090/api/v1/process \
  -H "Authorization: Bearer wr_live_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"text": "This is a sample paragraph."}'
```

响应：

```json
{
  "success": true,
  "data": {
    "result": "这是一段示例段落。",
    "usedPrompt": "default_translate_polish",
    "model": "claude-sonnet-4-5",
    "usage": { "promptTokens": 42, "completionTokens": 18, "totalTokens": 60 },
    "latencyMs": 820
  },
  "requestId": "req_7f3a9c2e"
}
```

携带自定义 `prompt` 时，覆盖默认行为：

```json
{ "text": "...", "prompt": "将下面内容改写为吸引点击的中文标题，不超过20字" }
```

错误码：`INVALID_REQUEST` (400) · `UNAUTHORIZED` (401) · `TEXT_TOO_LONG` (413) ·
`PROVIDER_NOT_FOUND` (400) · `LLM_UPSTREAM_ERROR` (502) · `RATE_LIMITED` (429) · `INTERNAL_ERROR` (500)

### GET /api/v1/health

无需鉴权，返回服务状态和默认供应商信息，用于探活监控。

## 管理后台

打开 `/admin`：

- **概览**：今日调用量、成功率、平均延迟、Token 消耗、默认供应商连通性
- **Prompt 配置**：编辑 System Prompt / Default User Prompt / 最大文本长度，带修改历史
- **LLM 供应商**：增删改查供应商配置，一键测试连通性，设置默认供应商
- **API Key 管理**：为每个业务调用方生成独立 Key，可随时吊销
- **调用日志**：按时间/状态/供应商筛选，查看错误详情

## 开发

```bash
npm run check   # 语法自检
npm test        # 单元测试（node --test）
```

零 npm 运行时依赖：后端用 `node:http` + `node:sqlite` + `node:crypto`，前端是零构建步骤的原生 JS。

## 目录结构

```
wenrong/
├── docs/PRODUCT_DESIGN.md   # 产品设计文档
├── src/                      # 后端源码
├── web/admin/                # 管理后台前端（原生 JS，无需构建）
├── tests/                    # 单元测试
├── config/.env.example       # 环境变量示例
├── Dockerfile
└── docker-compose.yml
```
