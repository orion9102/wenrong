# 文镕 同步/异步接口设计

## 1. 背景与现状约束

- 上游 freellmapi 单次调用延迟 2~40s（波动大，auto 路由更慢），偶发超时。
- 文镕为单实例、node:http + node:sqlite，零外部依赖。
- 调用方主要是本机/局域网内的 agent 与脚本，当前量级低（日调用量个位数到几十）。

## 2. 接口设计

### 2.1 同步接口（已有，保持不变）

POST /api/v1/process

- 行为不变：阻塞直到 LLM 返回，一次性给出结果。
- 适合：短文本、交互式调用、调用方能接受 3~60s 等待。
- 已有 Bearer API Key 鉴权、限流、日志。

### 2.2 异步接口（新增）

#### 提交任务

POST /api/v1/tasks

请求体与 /api/v1/process 完全一致（text、prompt 可选、providerId 可选）。

响应（202）：

{
  "success": true,
  "data": {
    "taskId": "task_a1b2c3d4e5f6",
    "status": "queued",
    "createdAt": 1793000000000
  }
}

- 校验逻辑与同步接口一致（鉴权、限流、文本长度），校验失败当场返回 4xx，不产生任务。

#### 查询任务

GET /api/v1/tasks/:taskId

响应 data 含：taskId、status（queued/processing/succeeded/failed）、result（成功时）、errorCode/errorMessage（失败时）、model、latencyMs、usage、createdAt/startedAt/finishedAt。

- 任何持有该 taskId 的有效 API Key 均可查询（taskId 为 22 位随机 hex，不可枚举）。
  简化起见第一版不做任务级归属校验；如后续多租户再加 apiKeyId 归属过滤。

#### （可选，暂不实现）回调

提交时带 callbackUrl 则完成后 POST 结果。第一版只做轮询，理由见 §4。

## 3. 要不要排队机制？——结论：要，但用「SQLite 持久化任务表 + 进程内单队列消费循环」即可，不引入 Redis/独立 MQ

### 3.1 为什么需要队列（哪怕量小）

1. 上游延迟波动大：10 个并发直接打向 freellmapi 会互相拖慢、触发上游限流
   （已实测 auto 路由有全局侧限流），需要并发上限。
2. 进程重启不丢任务：异步接口的契约是"提交即受理"，只在内存排队则容器一重启任务全丢。
   任务必须落库。
3. 背压可见：队列长度/等待时间是运营指标，没有队列就无从谈起。

### 3.2 为什么不需要 Redis/独立 MQ

- 单实例部署，没有跨进程消费的需求；
- SQLite 足以支撑当前及可预见的量级（数千级积压毫无压力）；
- 零依赖是本项目的架构原则。

### 3.3 队列设计

任务表 tasks（SQLite）：

| 字段 | 说明 |
|---|---|
| id | task_ + 22位随机hex，主键 |
| api_key_id | 提交者 |
| provider_id | 快照提交时的供应商 |
| request_json | {text, prompt, providerId} 完整快照 |
| status | queued / processing / succeeded / failed |
| result_text / error_code / error_message | 终态填充 |
| model / prompt_tokens / completion_tokens / total_tokens / latency_ms | 成功后填充 |
| created_at / started_at / finished_at | 三个时间戳 |
| attempts | 重试计数 |

消费循环（进程内，单循环）：

- 每 1s 扫一次：取一条最早的 queued 任务，当且仅当 processing 数 < N（最大并发，默认 3）。
- 对取到的任务执行与同步接口完全相同的管道（Prompt 合并 → chatComplete → 写日志 → 回写任务终态）。
- 失败重试：attempts < maxRetries（默认 1 次重试）时回 queued 并退避 5s；超过则终态 failed。
- 崩溃恢复：启动时把所有 status='processing' 且超过 10 分钟未更新的任务重置为 queued
  （attempts+1），不丢任务。

复用与一致性：

- 同步/异步共用 buildMessages + chatComplete + insertLog，仅外层调度不同。
- 调用日志的 requestId：同步 req_ 前缀，异步 task_ 前缀，便于区分。

管理后台：

- 概览页加队列指标：排队数、处理中、今日完成/失败、平均排队等待。
- （可选，后续）任务列表页：查看/重试失败任务。第一版只做指标，不做人工干预入口。

### 3.4 容量与超时参数

| 参数 | 默认 | 说明 |
|---|---|---|
| queueConcurrency | 3 | 同时处理任务数 |
| taskMaxRetries | 1 | 失败重试次数 |
| taskRetryBackoffMs | 5000 | 重试退避 |
| taskStaleMs | 600000 | processing 超10分钟视为僵死，启动时回收 |
| 任务保留期 | 24h | 定期清理终态任务，防表膨胀 |
| 队列上限 | 100/Key | 排队超过即拒绝 429，防恶意堆积 |

## 4. 轮询 vs 回调

第一版只做轮询：

- 调用方是 agent/脚本，轮询实现成本最低且无安全面（不用管回调 URL 的可达性、签名、重放）。
- 平均等待 2~40s，轮询间隔 2~3s 足够友好。
- callbackUrl 字段在协议中预留（提交时可传，先忽略），后续需要时再加回调派发器。

## 5. 里程碑

1. tasks 表 + 提交/查询接口 + 消费循环 + 崩溃恢复（本次）
2. 概览页队列指标
3. （按需）回调派发、失败任务手动重试
