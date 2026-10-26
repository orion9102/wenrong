# 文镕（WenRong）— 通用翻译润色服务

产品设计文档 v1.1（与 v1.1.0 已上线实现对齐）
日期：2026-10-26（v1.0）/ 2026-10-26 更新（v1.1）
作者：烛龙（AI 助理，代用户 feng 撰写）

> v1.1 变更摘要：技术选型从 Express+React 改为零依赖 node:http + 原生 DOM 前端；管理台登录改为统一账号中心 acc（OAuth PKCE）；新增 OpenAPI 文档端点、Scalar 在线文档页、幂等、限流响应头、温度/术语表/目标语言等可选字段、构建标识（version+commit）；外部访问经 Cloudflare 隧道 https://wr.909939.xyz。流式/异步/批量另见 docs/ASYNC_API_DESIGN.md（未实现）。

---

## 1. 项目概述

### 1.1 背景与目标

多个业务（爬虫改写、文章生成、社媒文案等）都需要"把一段文本交给 LLM 处理，拿回处理后的文本"这个通用能力，常见场景是：

- 把英文/多语种原文润色后翻译成中文
- 只润色不翻译
- 按自定义指令对文本做任意转换（摘要、改写语气、格式化等）

目前这个能力分散在各个项目里各写一套，重复造轮子且难以统一维护（LLM 供应商切换、Prompt 调优、调用监控都要改多处代码）。

**目标**：做一个独立部署的通用文本处理服务 **文镕（WenRong）**，对外暴露一个简单的 HTTP API：输入 `prompt`（可选）+ `text`，输出处理后的文本。服务内置默认的翻译润色行为，同时支持调用方自定义指令覆盖默认行为。配一个 Web 管理后台，用来配置 Prompt、LLM 供应商参数，并观察运行状态和调用日志。

### 1.2 核心价值

- **统一入口**：所有需要"文本润色/翻译"能力的项目，都调用这一个服务，不用各自维护 Prompt 和 LLM 调用逻辑。
- **可配置**：默认行为（系统提示词、默认用户提示词）和 LLM 供应商可以在 Web 后台直接改，不用改代码重新部署。
- **可观测**：请求量、成功率、延迟、Token 消耗、错误日志都能在后台看到，便于排查问题和控制成本。
- **可扩展**：预留多供应商、多模型的配置能力，未来换模型或接入新供应商只需在后台增加配置。

### 1.3 非目标（本期不做）

- 不做多语言 i18n 的 Web 界面（后台默认中文即可）。
- 不做用户体系/多租户隔离（本期是内部工具，默认单租户，用简单的 API Key 做访问控制）。
- 不做文件级别的批量翻译（如上传 Word/PDF），本期只做文本字符串级别的同步 API。
- 不做流式输出（streaming），本期用同步请求-响应模式，这样对接简单，后续如有长文本场景再考虑加流式（设计稿见 docs/ASYNC_API_DESIGN.md，尚未实现）。

---

## 2. 使用场景举例

1. **爬虫改写场景**：apkpure-crawler 抓到一段英文应用描述，调用文镕接口（不传 prompt），拿到润色过的中文译文，直接发布。
2. **自定义场景**：x-trends 项目想把一段话改写成"吸引眼球的标题风格"，调用时自己传 `prompt: "将下面内容改写为吸引点击的中文标题，不超过20字"`，文镕按这个指令处理，不走默认的翻译逻辑。
3. **运营排查**：用户发现某天翻译结果质量下降，打开文镕后台看调用日志，发现是 Prompt 被误改了，一键恢复到之前的版本。

---

## 3. 系统架构

```
                     ┌─────────────────────────┐
                     │        调用方项目          │
                     │ (apkpure-crawler / x-trends │
                     │  / omnidesk-crawler / ...) │
                     └───────────┬─────────────┘
                                 │ HTTP POST /api/v1/process
                                 │ { prompt?, text }
                                 ▼
                     ┌─────────────────────────┐
                     │      文镕 Server (Node.js) │
                     │  ┌───────────────────┐  │
                     │  │   API 层 (REST)    │  │
                     │  ├───────────────────┤  │
                     │  │  Prompt 解析与合并   │  │
                     │  ├───────────────────┤  │
                     │  │  LLM 调用适配层      │  │
                     │  ├───────────────────┤  │
                     │  │  日志 / 指标采集     │  │
                     │  └───────────────────┘  │
                     └──────┬───────────┬──────┘
                             │           │
                 ┌───────────┘           └───────────┐
                 ▼                                    ▼
      ┌─────────────────────┐              ┌─────────────────────┐
      │   SQLite 数据库       │              │   LLM 供应商          │
      │ (配置/日志/指标持久化)  │              │ http://192.168.88.62  │
      └─────────────────────┘              │      :3001/ (默认)    │
                 ▲                          │ 可配置切换其他供应商     │
                 │                          └─────────────────────┘
                 │
      ┌─────────────────────┐
      │   文镕 Web 管理后台     │
      │ (配置 Prompt/供应商/   │
      │  查看状态与日志)        │
      └─────────────────────┘
```

### 3.1 技术选型

| 模块 | 实际选型（v1.1） | 理由 |
|---|---|---|
| 后端语言/运行时 | Node.js ≥22（CommonJS）+ node:http，**零 npm 运行时依赖** | 单文件服务、镜像小、无供应链负担；node:22 内置 fetch/http 能力足够 |
| 数据库 | SQLite（node:sqlite 内置模块，WAL 模式） | 单机部署，数据量小（配置+日志），免运维，备份就是复制文件；不引 better-sqlite3 保持零依赖 |
| 前端 | 原生 DOM（无框架）单页应用 app.js + style.css，由后端 node:http 直接托管 | 管理台规模小（7 个页面），不值得引入构建链；样式为蜜桃抹茶主题，静态资源带版本号防缓存 |
| LLM 客户端 | 自封装 OpenAI 兼容客户端（node:http + fetch） | 目标服务是 OpenAI 兼容接口，含超时、重试、429/5xx 分类映射 |
| 鉴权 | 业务 API：Bearer API Key（sha256+salt 哈希存储）；管理台：统一账号中心 acc.909939.xyz（OAuth 2.0 授权码 + PKCE，RS256 JWKS 验签） | 复用工作区统一账号中心，无本地账号密码；两套鉴权完全隔离 |
| 部署 | Docker + docker compose，部署于 s47（192.168.88.47:4090） | 与工作区惯例一致；镜像构建时注入 git commit（build-commit.txt） |
| 对外暴露 | Cloudflare 隧道 → https://wr.909939.xyz（OAuth 回调地址已登记） | 内网直连与公网域名都可访问；管理台与文档页走域名，业务 API 供内网/公网后端调用 |
| 进程管理 | Docker restart=unless-stopped + healthcheck（/healthz） | 简化运维 |

---

## 4. API 设计

### 4.1 核心接口：文本处理

```
POST /api/v1/process
Content-Type: application/json
Authorization: Bearer <API_KEY>
```

**请求体**：

```json
{
  "text": "This is a sample paragraph that needs polishing and translation.",
  "prompt": "可选，调用方自定义指令。不传则使用系统默认的『润色并翻译为中文』提示词",
  "providerId": "可选，指定使用哪个已配置的 LLM 供应商，不传则用默认供应商",
  "instruction": "可选，附加要求（≤1000 字），叠加在提示词之后，不替换默认行为",
  "targetLang": "可选，目标语言，默认 zh；可选 zh/zh-Hant/en/ja/ko/fr/de/es/pt/it/ru/vi/th/ar",
  "glossary": "可选，术语表 {"原文":"译法"}，最多 100 条，每条 ≤100 字符",
  "temperature": "可选，0～1，默认 0.2；透传上游，不保证确定性输出"
}
```

可选请求头：
- `Idempotency-Key`（8～128 位）：同一 Key 同一内容 24 小时内回放响应；同 Key 不同内容返回 409。
- `X-Request-Id`（8～80 位）：调用方请求 ID，原样作为 requestId 返回。

**响应体（成功）**：

```json
{
  "success": true,
  "data": {
    "result": "这是一段需要润色和翻译的示例段落。",
    "usedPrompt": "default_translate_polish",
    "promptVersion": "pv_3f9a1c2b7d4e",
    "detectedLang": "en",
    "targetLang": "zh",
    "model": "claude-sonnet-4-5",
    "usage": { "promptTokens": 42, "completionTokens": 18, "totalTokens": 60 },
    "latencyMs": 820,
    "upstreamMs": 780
  },
  "requestId": "req_7f3a9c2e"
}
```

说明：`promptVersion` 是实际生效提示词（system + user）的指纹，后台改提示词后即变，用于对账与复现；`latencyMs` 为总耗时，`upstreamMs` 为其中上游 LLM 调用耗时，两者之差即本服务自身开销；幂等回放时额外带 `idempotentReplay: true`。

响应头：`X-Request-Id`、`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`（距窗口重置剩余秒数，真实倒数）；429/503 另带 `Retry-After`。

**响应体（失败）**：

```json
{
  "success": false,
  "error": {
    "code": "LLM_UPSTREAM_ERROR",
    "message": "上游 LLM 服务返回错误：Invalid API key"
  },
  "requestId": "req_7f3a9c2e"
}
```

**错误码设计**：

| code | HTTP 状态 | 说明 |
|---|---|---|
| `INVALID_REQUEST` | 400 | 请求体缺少 `text` 或可选字段格式不对（带 `field` 指明问题字段） |
| `MALFORMED_JSON` | 400 | 请求体不是合法 JSON |
| `UNAUTHORIZED` | 401 | API Key 缺失或无效 |
| `PROVIDER_NOT_FOUND` | 400 | 指定的 `providerId` 不存在或未启用 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同一 Idempotency-Key 用于不同请求内容 |
| `TEXT_TOO_LONG` | 413 | 文本超过字符上限或估算 token 上限（带 `limit`/`actualLength`/`unit`） |
| `BODY_TOO_LARGE` | 413 | 请求体超过 2 MB |
| `RATE_LIMITED` | 429 | 本服务限流（滑动窗口，默认 60 次/分钟/API Key） |
| `UPSTREAM_RATE_LIMITED` | 429 | 上游 LLM 限流（透传，带 Retry-After） |
| `LLM_UPSTREAM_ERROR` | 502/503 | 上游 LLM 调用失败（鉴权、网络、超时等；`retryable` 标明是否值得重试） |
| `INTERNAL_ERROR` | 500 | 服务内部异常 |

机器可读契约：`GET /api/v1/openapi.json`（OpenAPI 3.0，无需鉴权）；在线文档页：`GET /api/v1/docs`（Scalar 渲染，脚本已本地打包，离线可用）。

### 4.2 健康检查接口

```
GET /api/v1/health
```

返回服务自身状态、版本与构建标识、默认供应商状态：

```json
{
  "status": "ok",
  "version": "1.1.0",
  "commit": "bd5a4ef",
  "uptime": 123456,
  "defaultProvider": { "id": "default", "name": "默认 LLM 供应商", "enabled": true }
}
```

`version` 来自 package.json，`commit` 为镜像构建时注入的 git 短 hash（build-commit.txt 随镜像分发），用于判断线上跑的是哪次构建。另有 `GET /healthz`（容器健康检查，恒 `{"ok":true}`）和 `GET /readyz`（就绪探针：数据库可读且默认供应商已启用并配了 Key 才 200，不打上游、不产生费用）。

### 4.3 管理后台 API（需管理员登录）

管理台接口统一挂在 `/api/admin/*`，登录由统一账号中心 acc.909939.xyz 完成（OAuth 2.0 授权码 + PKCE，`/api/auth/login`、`/api/auth/callback`），登录后使用本地会话 cookie，和业务 API 的 API Key 鉴权分开（2026-10-26 起取代本地账号密码登录；管理台页面从 `/admin` 迁到根路径 `/`）：

- `GET/PUT /api/admin/prompts` — 查看/更新系统提示词与默认用户提示词
- `GET/PUT /api/admin/prompts` — 查看/更新系统提示词与默认用户提示词
- `GET/POST/PUT/DELETE /api/admin/providers` — LLM 供应商的增删改查
- `POST /api/admin/providers/:id/test` — 测试供应商连通性（发一个最小请求验证 key 和地址可用）
- `GET /api/admin/logs` — 分页查询调用日志，支持按时间、状态、供应商筛选
- `GET /api/admin/metrics` — 聚合统计（今日调用量、成功率、平均延迟、Token 消耗趋势）
- `GET/POST /api/admin/api-keys` — 管理业务调用方的 API Key（生成、吊销、重命名）
- `POST /api/auth/logout` / `GET /api/auth/me` — 登出与当前会话信息

> 历史备注：本地账号密码登录（admin_users/admin_sessions 表）已被统一账号中心登录取代，表结构保留但不再使用。

---

## 5. Prompt 管理设计

### 5.1 两层 Prompt 结构

- **System Prompt（系统提示词）**：定义 LLM 的角色和总体行为约束，比如"你是专业的翻译和文字润色助手，只输出处理后的文本，不要添加任何解释、前后缀或引号"。这一层始终生效，调用方不能覆盖，只能在后台改。
- **Default User Prompt（默认用户提示词）**：定义默认的处理指令，即本期要求的"润色并翻译成中文"。当调用方请求中没有带 `prompt` 字段时，用这个默认值拼接到 `text` 前面发给 LLM。

### 5.2 请求时的合并逻辑

```
if request.prompt is provided and non-empty:
    effective_user_prompt = request.prompt
    usedPrompt = "custom"
else:
    effective_user_prompt = config.defaultUserPrompt
    usedPrompt = "default_translate_polish"

messages = [
  { role: "system", content: config.systemPrompt },
  { role: "user", content: effective_user_prompt + "\n\n---\n" + request.text }
]
```

这样保证：
- 系统提示词始终是后台配置的那一份，调用方无法越权修改模型的基本行为约束。
- 默认行为是"润色+翻译成中文"，和需求一致。
- 调用方可以通过传 `prompt` 完全自定义这次处理的指令（比如改写、摘要），灵活度足够。

### 5.3 Prompt 版本历史

每次在后台修改 System Prompt 或 Default User Prompt，旧版本不删除，而是存一条历史记录（`prompt_history` 表），后台提供"查看历史版本 / 一键回滚"的功能，避免误改后无法恢复。

---

## 6. LLM 供应商管理设计

### 6.1 供应商配置项

每个供应商配置包含：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，如 `wan8` |
| `name` | 显示名称，如 "内网 WAN8 服务" |
| `baseUrl` | API 地址，如 `http://192.168.88.62:3001/` |
| `apiKey` | 密钥，后台输入后加密存储，列表页只显示掩码 |
| `model` | 默认使用的模型名，如 `gpt-4o-mini` |
| `timeoutMs` | 请求超时时间，默认 30000 |
| `maxRetries` | 失败重试次数，默认 1 |
| `isDefault` | 是否为默认供应商（全局唯一一个） |
| `enabled` | 是否启用 |

### 6.2 默认供应商

本期默认配置一条记录：

```json
{
  "id": "wan8",
  "name": "内网 WAN8 服务",
  "baseUrl": "http://192.168.88.62:3001/",
  "model": "gpt-4o-mini",
  "isDefault": true,
  "enabled": true
}
```

`apiKey` 留空由部署时在后台填入（本期该服务需要的 key 待 feng/龙虾二号提供后补齐，不写入代码库，不写入配置文件明文，只通过后台表单输入后加密存入数据库）。

### 6.3 连通性测试

后台"供应商管理"页提供「测试连接」按钮，点击后用极小的 prompt（如 "ping"）发一次真实请求，展示返回结果或具体错误（鉴权失败/超时/网络不可达），方便快速定位配置问题——即前面探活时遇到的 `Invalid API key` 这类问题能直接在页面上看到。

### 6.4 多供应商与路由（预留能力）

数据结构上支持配置多个供应商，调用方可以在请求里传 `providerId` 指定用哪个；不传则用标记为 `isDefault` 的那个。本期只会配置一个供应商，但设计上不限制未来接入第二个（比如阿里云通义、OpenAI 官方等）。

---

## 7. 数据模型（SQLite）

```sql
-- 系统配置（单行表，存当前生效的 Prompt）
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  system_prompt TEXT NOT NULL,
  default_user_prompt TEXT NOT NULL,
  max_text_length INTEGER NOT NULL DEFAULT 20000,
  updated_at INTEGER NOT NULL
);

-- Prompt 修改历史
CREATE TABLE prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  field TEXT NOT NULL,              -- 'system_prompt' | 'default_user_prompt'
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_by TEXT,                  -- 后台操作人标识
  changed_at INTEGER NOT NULL
);

-- LLM 供应商
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  model TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  max_retries INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 业务调用方 API Key
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,              -- 如 "apkpure-crawler"
  key_hash TEXT NOT NULL,           -- 存哈希，不存明文
  key_prefix TEXT NOT NULL,         -- 展示用前缀，如 "wr_live_ab12..."
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- 调用日志
CREATE TABLE request_logs (
  id TEXT PRIMARY KEY,              -- requestId
  api_key_id TEXT,
  provider_id TEXT NOT NULL,
  used_prompt TEXT NOT NULL,        -- 'default_translate_polish' | 'custom'
  input_text_len INTEGER NOT NULL,
  output_text_len INTEGER,
  status TEXT NOT NULL,             -- 'success' | 'error'
  error_code TEXT,
  error_message TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);

-- 后台管理员账号（历史遗留：已被统一账号中心登录取代，不再使用）
CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 幂等缓存（Idempotency-Key 回放）
CREATE TABLE idempotency (
  key TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,        -- 请求内容指纹，冲突检测用
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,      -- 完整响应体缓存
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,      -- 24 小时
  PRIMARY KEY (key, api_key_id)
);

-- 统一账号中心（acc）登录后的本地会话；token 仅存 sha256
CREATE TABLE user_sessions (
  token_hash TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  email TEXT,
  name TEXT,
  role TEXT,                        -- admin / user，管理台要求 admin
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL       -- 7 天
);
```

说明：
- 输入/输出的**原文全文不落库**，只记录长度和元信息，避免敏感文本长期堆积、也减少存储压力；如后续需要全文留痕用于排查，可以加一个开关单独控制（默认关闭）。
- `api_key_encrypted` 用 AES-256-GCM 加密存储，密钥来自环境变量 `ENCRYPTION_KEY`（部署时配置，不入库不入代码）。
- `key_hash` 用 sha256+salt，业务方的 API Key 本身只在创建时完整展示一次。
- `admin_users`/`admin_sessions` 为本地账号密码时代的历史表，2026-10-26 起管理台登录走统一账号中心，这两张表保留但不再写入。

---

## 8. Web 管理后台设计

### 8.1 页面结构

1. **登录页**：跳转统一账号中心 acc.909939.xyz 登录（OAuth 授权码 + PKCE，仅 admin 角色可进），回调后签发本地 httpOnly 会话 cookie（7 天，SameSite=Lax）。
2. **概览页（Dashboard）**
   - 今日/近7日调用量趋势图
   - 成功率、平均延迟、Token 消耗统计卡片
   - 默认供应商连通性状态指示灯
3. **Prompt 配置页**
   - System Prompt 编辑框（多行文本）
   - Default User Prompt 编辑框
   - 最大文本长度限制输入框
   - 保存按钮 + 历史版本列表（可查看 diff、可回滚）
4. **供应商管理页**
   - 供应商列表（名称、地址、模型、状态、是否默认）
   - 新增/编辑表单（含 API Key 输入框，编辑时显示掩码不回显原文）
   - 「测试连接」按钮，实时显示测试结果
   - 设为默认 / 启用禁用 / 删除操作
5. **API Key 管理页**
   - 业务调用方 Key 列表（标签、前缀、状态、最后使用时间）
   - 新增 Key（生成后仅展示一次完整 key，提示用户立即保存）
   - 吊销/启用 Key
6. **调用日志页**
   - 分页表格：时间、供应商、使用的 Prompt 类型、状态、延迟、Token 数、错误信息
   - 完整分页控件：首页/上一页/页码窗口（5 页）/下一页/末页 + 每页条数切换（10/20/50/100）
   - 后端支持 limit（≤200）/offset/status/providerId/since 参数
7. **Playground 页**：管理台内直接试调 /api/v1/process（选 Key、传文本，看实时结果与耗时）
8. **文档页**：内嵌本服务的 API 说明（错误码、响应头、重试策略）

### 8.2 UI 技术与风格

- 原生 JavaScript（零框架、零构建）单文件应用 `web/admin/app.js`，由后端 node:http 直接托管在根路径 `/`。
- 视觉风格：蜜桃抹茶主题（抹茶绿 `#7a9a54` 主色 × 蜜桃粉 `#f2a48c` 辅助 × 奶油米底），圆角卡片 + 柔和阴影。
- 静态资源引用带版本号（`?v=x.y.z`），避免更新后浏览器缓存不刷新。

---

## 9. 安全设计

- **业务 API 鉴权**：`Authorization: Bearer <API_KEY>`，Key 以哈希形式存储比对，支持单独吊销。
- **管理后台鉴权**：统一账号中心 acc.909939.xyz（OAuth 2.0 授权码 + PKCE 公共客户端，RS256 id_token 验签，仅 admin 角色放行），本地会话 cookie 为 httpOnly + SameSite=Lax，7 天有效。
- **供应商密钥保护**：API Key 加密存储，日志和列表接口永远只返回掩码（如 `sk-***abcd`），不提供"查看完整密钥"的接口，只能重新编辑覆盖。
- **网络暴露范围**：内网（s47:4090）与公网域名（https://wr.909939.xyz，经 Cloudflare 隧道）双通道。业务 API 始终要求 Bearer Key；管理台要求 acc admin 角色；openapi.json/docs 页为公开只读契约，不泄露密钥信息。
- **限流**：业务 API 按 API Key 滑动窗口限流（默认 60 次/分钟），响应带 X-RateLimit-* 头（Reset 为真实倒数秒数）；上游 429 透传并附 Retry-After。
- **幂等**：Idempotency-Key 支持安全重试（24h 回放，内容冲突 409），应对网络抖动下的重复提交。
- **输入校验**：`text` 长度上限可配置（默认 20000 字符），超限直接拒绝，避免单次请求消耗过多 Token 或拖垂上游。

> 安全提示：本服务一旦启动即对外提供 HTTP API，必须配置 API Key 鉴权才可用；管理后台同样需要账号密码才能访问。部署时请确认不要在没有鉴权的情况下暴露到公网。

---

## 10. 部署设计

### 10.1 目录结构（实际）

```
wenrong/
├── docs/
│   ├── PRODUCT_DESIGN.md       # 本文档
│   └── ASYNC_API_DESIGN.md     # 流式/异步/批量接口设计稿（未实现）
├── src/                        # 后端服务（Node.js，零依赖）
│   ├── server.js               # 入口：路由、业务 API、静态托管
│   ├── admin-routes.js         # 管理台与 auth 路由
│   ├── acc-auth.js             # 统一账号中心 OAuth PKCE + JWKS 验签
│   ├── admin-auth.js           # 管理台会话
│   ├── store.js                # SQLite 数据层（node:sqlite）
│   ├── llm-client.js           # OpenAI 兼容上游客户端（超时/重试/错误映射）
│   ├── prompt-engine.js        # 提示词合并与可选字段校验
│   ├── rate-limiter.js         # 滑动窗口限流
│   ├── text-policy.js          # 括注清理、token 估算、语言粗判
│   └── crypto.js               # AES-GCM 加密、API Key 哈希
├── web/admin/                  # 管理后台前端（原生 JS，无构建）
│   ├── index.html / app.js / style.css
│   └── vendor/scalar-standalone.js   # Scalar 文档渲染器（本地打包，离线可用）
├── tests/                      # node:test 测试（44 个用例）
├── scripts/syntax-check.js
├── Dockerfile                  # node:24-alpine，非 root 运行
├── docker-compose.yml
├── config/.env.example
└── README.md
```

### 10.2 环境变量

```
PORT=4090
WENRONG_DB=/app/data/wenrong.sqlite   # SQLite 路径（Docker volume 持久化）
ENCRYPTION_KEY=<64位hex>              # 用于加密供应商 API Key
DEFAULT_PROVIDER_BASE_URL=http://192.168.88.62:3001/
DEFAULT_PROVIDER_MODEL=auto
DEFAULT_PROVIDER_API_KEY=<首启建默认供应商用，留空则后台填>
ACC_BASE=https://acc.909939.xyz       # 统一账号中心
ACC_CLIENT_ID=app_01M5VR4AFT7EV89TMMWZGXRMQY
ACC_REDIRECT_URI=https://wr.909939.xyz/api/auth/callback
ACC_REQUIRED_ROLE=admin
```

`ENCRYPTION_KEY` 首次部署时随机生成，写入 `.env`（不提交到 git；改动会导致已存供应商 Key 无法解密）。

### 10.3 一条命令跑通

```bash
docker compose up -d
```

启动后：
- 业务 API: `http://<host>:4090/api/v1/process`（内网）或 `https://wr.909939.xyz/api/v1/process`
- 管理后台: `http://<host>:4090/`（内网）或 <https://wr.909939.xyz/>
- 在线 API 文档: `https://wr.909939.xyz/api/v1/docs`（Scalar）
- 首次启动自动初始化 SQLite 表结构；登录走统一账号中心，无本地账号创建步骤。
- 实际部署：s47（192.168.88.47:4090），镜像构建时注入 git commit（build-commit.txt），`/api/v1/health` 可查 version+commit。

---

## 11. 开发计划（里程碑）

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 后端核心：API 骨架、SQLite 建表、Prompt 合并逻辑、LLM 适配层对接 freellmapi | ✅ 完成 |
| M2 | 管理后台 API：Prompt 配置、供应商 CRUD + 测试连接、API Key 管理、日志查询 | ✅ 完成 |
| M3 | 管理后台前端：登录（统一账号中心）、概览、Playground、Prompt、供应商、Key、日志（分页）、文档、设置 | ✅ 完成 |
| M4 | 安全加固与打包：限流、幂等、输入校验、加密存储、OpenAPI 文档、Docker 化、CI 推送 | ✅ 完成（v1.1.0，44 测试） |
| M5 | 接入现有项目试点（如 apkpure-crawler）替换原有翻译逻辑 | ⬜ 待做 |
| M6 | 流式/异步/批量接口（见 docs/ASYNC_API_DESIGN.md） | ⬜ 待用户拍板优先级 |

---

## 12. 已确认事项（v1.1 更新）

1. ~~LLM 供应商鉴权信息~~：已解决，freellmapi（192.168.88.62:3001）的 Key 已配置在后台（加密存储）。
2. ~~LLM 服务支持的模型名~~：已确认，默认用 `auto` 路由，可在后台切换具体模型。
3. ~~部署位置~~：已部署在 s47（192.168.88.47:4090），与上游同局域网。
4. ~~公网访问~~：已通过 Cloudflare 隧道映射 https://wr.909939.xyz，OAuth 回调地址已登记；业务 API 鉴权保留。

### 12.1 当前待确认事项

1. **流式/异步/批量接口优先级**：设计稿已备（docs/ASYNC_API_DESIGN.md），等用户拍板先做哪个。
2. **build-commit.txt 自动化**：目前每次部署前需手动 `git rev-parse --short HEAD > build-commit.txt`，可改为 docker compose build args 自动注入。
3. **acc 应用 redirect_uri 双地址**：目前内网 IP 与域名两个回调都已登记，但容器 ACC_REDIRECT_URI 只指向域名；若需内网 IP 也能完成登录，需按访问来源动态选择回调地址。

---

## 13. 后续事项（本次任务范围之外，仅记录）

- 代码仓库按 USER.md 约定需推送到 ipaapk-spec 或 orion9102 账号下的新建远程仓库（随机选一个），并包含 README.md。
- 每次提交需使用中文详细描述修改内容。
