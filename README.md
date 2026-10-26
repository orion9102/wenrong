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
