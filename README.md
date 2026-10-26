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

首次启动会自动创建一条默认 LLM 供应商记录（地址来自 `DEFAULT_PROVIDER_BASE_URL`）。
打开 `http://<host>:4090/`，点「使用统一账号中心登录」，在 acc.909939.xyz 登录后回到管理台。

### Docker 部署

```bash
cp config/.env.example .env
# 编辑 .env，至少设置 ENCRYPTION_KEY 为随机字符串
docker compose up -d
```

- 管理台：`http://<host>:4090/`（旧的 `/admin` 路由已移除）
- 业务 API：`http://<host>:4090/api/v1/process`

> 安全提示：业务 API 必须携带 `Authorization: Bearer <API_KEY>`（在管理台「设置 → API Key 管理」生成，
> 可建多个、可单独禁用/删除），否则 401。管理台登录由统一账号中心完成，默认仅 `admin` 角色可进入。
> 服务走纯 HTTP，推荐部署在内网，仅供内部项目调用。

### 统一账号中心登录（acc.909939.xyz）

采用 OAuth 2.0 授权码 + PKCE（S256，公共客户端，无 secret）：

1. `GET /api/auth/login` → 生成 state/code_verifier，302 到 acc 授权页
2. acc 登录后回跳 `GET /api/auth/callback?code&state` → 校验 state（与浏览器 cookie 绑定，防登录 CSRF）→
   携 code_verifier 换令牌 → 用 acc JWKS 验签 `id_token`（RS256，校验 iss/aud/exp/nonce）→ 校验角色
3. 签发本地会话 cookie `wenrong_session`（HttpOnly、SameSite=Lax、7 天；服务端只存 sha256）

在 acc 登记应用（已在 s47 完成，app_id 见部署 `.env`）：

```bash
docker exec account-center node admin.mjs add-app wenrong "" "http://192.168.88.47:4090/api/auth/callback"
```

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `ACC_BASE` | 账号中心地址 | `https://acc.909939.xyz` |
| `ACC_CLIENT_ID` | acc 登记的 app_id（必填） | 空 |
| `ACC_REDIRECT_URI` | 回调地址，须与 acc 登记的完全一致 | `http://192.168.88.47:4090/api/auth/callback` |
| `ACC_REQUIRED_ROLE` | 放行角色；`*` 表示任意已登录账号 | `admin` |

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
    "promptVersion": "pv_3f9a1c2b7d4e",
    "detectedLang": "en",
    "targetLang": "zh",
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

可选字段（都叠加在提示词之后，不替换默认翻译润色）：

| 字段 | 说明 |
|---|---|
| `instruction` | 附加要求，≤1000 字，例如「语气更口语」 |
| `targetLang` | 目标语言，默认 `zh`；可选 zh、zh-Hant、en、ja、ko、fr、de、es、pt、it、ru、vi、th、ar |
| `glossary` | 术语表 `{"token":"词元"}`，最多 100 条 |
| `temperature` | 0～1，默认 0.2 |

```json
{ "text": "Hello world", "targetLang": "fr", "glossary": { "world": "monde" }, "instruction": "保持简短" }
```

响应里 `promptVersion` 是实际生效提示词的指纹（后台改提示词后会变），`detectedLang` 是按文字系统粗判的原文语言。

可选请求头：`Idempotency-Key`（8～128 位，同一 Key 同一内容 24 小时内回放，内容冲突返回 409）；`X-Request-Id`（原样作为 requestId 返回）。

响应头：`X-Request-Id`、`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`（秒）；429/503 另带 `Retry-After`。

错误体：`{"success":false,"error":{"code":"...","message":"...","retryable":true},"requestId":"..."}`。
`retryable` 为 true 时按 `Retry-After` 退避重试；`TEXT_TOO_LONG` 额外带 `limit`/`actualLength`/`unit`；参数错误带 `field`。

错误码：`INVALID_REQUEST` (400) · `MALFORMED_JSON` (400) · `UNAUTHORIZED` (401) · `PROVIDER_NOT_FOUND` (400) ·
`IDEMPOTENCY_CONFLICT` (409) · `TEXT_TOO_LONG` (413) · `BODY_TOO_LARGE` (413，>2 MB) · `RATE_LIMITED` (429) ·
`UPSTREAM_RATE_LIMITED` (429，上游限流) · `LLM_UPSTREAM_ERROR` (502/503) · `INTERNAL_ERROR` (500)

机器可读的接口定义见 `GET /api/v1/openapi.json`（OpenAPI 3.0，无需鉴权），可直接导入 Swagger UI / Postman / openapi-generator。

> 只能从后端服务调用。不要在浏览器、小程序或 App 里直接带 API Key 调用：Key 会暴露，服务也不开放 CORS。

### 探活：GET /healthz、GET /readyz、GET /api/v1/health

无需鉴权。`/healthz` 返回 `{"ok":true}`，给容器健康检查用；`/readyz` 在数据库可读且默认供应商已启用、配了 Key 时返回 200，否则 503（不调上游）；`/api/v1/health` 带服务版本和默认供应商状态。
局域网偶发丢包时第一次连接会失败，探活请至少重试 2 次：`curl --retry 2 --retry-connrefused --retry-delay 2`。

## 管理台

打开 `/`（统一账号中心登录）：

- **概览**：今日调用量、成功率、平均延迟、Token 消耗、默认供应商连通性
- **Prompt 配置**：编辑 System Prompt / Default User Prompt / 最大文本长度，带修改历史
- **LLM 供应商**：增删改查供应商配置，一键测试连通性，设置默认供应商
- **调用日志**：按时间/状态/供应商筛选，查看错误详情
- **设置**：当前账号信息；**API Key 管理**——可添加多个 Key（每个调用方一个），完整 Key 仅创建时展示一次，
  支持重命名、禁用/启用、删除，记录创建者与最后使用时间

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
