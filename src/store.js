'use strict';

/**
 * 文镕 SQLite 存储层（node:sqlite，零第三方依赖）
 *
 * 表结构见 docs/PRODUCT_DESIGN.md 第 7 节。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { encrypt, decrypt, randomId } = require('./crypto.js');

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

const DEFAULT_DB = path.join(process.cwd(), 'data', 'wenrong.sqlite');

const DEFAULT_SYSTEM_PROMPT = [
  '你是文镕（WenRong）翻译润色服务的执行模型。',
  '只输出处理后的文本本身，不要添加解释、开场白、前后缀、引号或代码块标记，不要重复原文。',
  '专有名词保持原文时，不要在后面加与原文相同的括注：禁止写成 Acme Robotics（Acme Robotics）这种形式。全篇用同一写法。',
  '只有确有通行中文名时，才写「中文名（原文）」，且同一专名全篇只括注一次。'
].join('');

const DEFAULT_USER_PROMPT = `# 角色
你是资深中英双语编辑。目标是读起来像中文母语者写的，而不是能看出翻译痕迹。

# 任务
- 原文不是中文：理解后译成中文，并按中文习惯重写，做到通顺、术语准、文笔干净。
- 原文已是中文：不翻译，只润色拗口、冗余和语气不统一处，不改原意和信息量。

# 原则
1. 忠实。不增删事实、不补背景、不擅自总结。原文明显可疑时按原意处理，文末用一行「⚠️ 存疑：……」标注，不自行改正。
2. 意译。拆掉英文长从句和被动语态，按中文的时间、因果、主次重排。
3. 术语统一。用该领域通行译法（token→词元，embedding→嵌入，alignment→对齐，fine-tuning→微调）。同一术语全篇只用一个译法。
4. 精炼。删掉「实际上」「为了……的目的」「进行……操作」这类填充；用具体动词，保留原文的正式度。
5. 格式原样保留。Markdown 结构不动；代码、变量名、命令、URL、路径、品牌、型号、单位不翻译。
6. 专名与数字。已有通行中文名的直接用中文。没有通行中文名、决定保留原文时，只写原文本身，不要再括注同一串原文。数字精度与原文一致，不做单位换算。
7. 地名与组织名用通行译法且前后一致：Europe→欧洲（不是「欧盟」，EU 才是欧盟）、United States→美国、the company/the firm 指第三方公司时译「该公司/这家公司」，不用第一人称表述。同一地名全篇只用一个译法。

# 输出
只输出处理后的正文。不要分析过程、双语对照、客套话。保留原文段落、标题和列表。
`;
class Store {
  constructor(options = {}) {
    this.file = options.file || process.env.WENRONG_DB || DEFAULT_DB;
    this.now = options.now || (() => Date.now());
    this.encryptionKey = options.encryptionKey || process.env.ENCRYPTION_KEY || 'wenrong-dev-key-change-me';

    if (this.file !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    }
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this._migrate();
    this._prepare();
    this._ensureDefaultConfig();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        system_prompt TEXT NOT NULL,
        default_user_prompt TEXT NOT NULL,
        max_text_length INTEGER NOT NULL DEFAULT 20000,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        field TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT NOT NULL,
        changed_by TEXT,
        changed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
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

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT NOT NULL,
        api_key_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (key, api_key_id)
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        api_key_id TEXT,
        provider_id TEXT NOT NULL,
        used_prompt TEXT NOT NULL,
        input_text_len INTEGER NOT NULL,
        output_text_len INTEGER,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        latency_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);

      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        admin_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      -- 统一账号中心（acc）登录后的本地会话；token 仅存 sha256
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash TEXT PRIMARY KEY,
        sub TEXT NOT NULL,
        email TEXT,
        name TEXT,
        role TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    // 旧版本地管理员会话已废弃（改由 acc 登录），清空避免残留
    this.db.exec('DELETE FROM admin_sessions');
    // api_keys 增加创建者字段（向后兼容迁移）
    const cols = this.db.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name);
    if (!cols.includes('created_by')) this.db.exec('ALTER TABLE api_keys ADD COLUMN created_by TEXT');
  }

  _prepare() {
    this.stmt = {
      getConfig: this.db.prepare('SELECT * FROM config WHERE id = 1'),
      upsertConfig: this.db.prepare(
        'INSERT INTO config(id, system_prompt, default_user_prompt, max_text_length, updated_at) VALUES (1, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET system_prompt=excluded.system_prompt, default_user_prompt=excluded.default_user_prompt, max_text_length=excluded.max_text_length, updated_at=excluded.updated_at'
      ),
      insertHistory: this.db.prepare(
        'INSERT INTO prompt_history(field, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)'
      ),
      listHistory: this.db.prepare('SELECT * FROM prompt_history ORDER BY id DESC LIMIT ?'),

      listProviders: this.db.prepare('SELECT * FROM providers ORDER BY created_at ASC'),
      getProvider: this.db.prepare('SELECT * FROM providers WHERE id = ?'),
      getDefaultProvider: this.db.prepare('SELECT * FROM providers WHERE is_default = 1 LIMIT 1'),
      insertProvider: this.db.prepare(
        'INSERT INTO providers(id, name, base_url, api_key_encrypted, model, timeout_ms, max_retries, is_default, enabled, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ),
      updateProvider: this.db.prepare(
        'UPDATE providers SET name=?, base_url=?, api_key_encrypted=?, model=?, timeout_ms=?, max_retries=?, enabled=?, updated_at=? WHERE id=?'
      ),
      clearDefaultProvider: this.db.prepare('UPDATE providers SET is_default = 0'),
      setDefaultProvider: this.db.prepare('UPDATE providers SET is_default = 1, updated_at = ? WHERE id = ?'),
      deleteProvider: this.db.prepare('DELETE FROM providers WHERE id = ?'),

      listApiKeys: this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC'),
      getApiKeyByHash: this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?'),
      insertApiKey: this.db.prepare(
        'INSERT INTO api_keys(id, label, key_hash, key_prefix, enabled, created_at, created_by) VALUES (?, ?, ?, ?, 1, ?, ?)'
      ),
      touchApiKey: this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?'),
      setApiKeyEnabled: this.db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?'),
      deleteApiKey: this.db.prepare('DELETE FROM api_keys WHERE id = ?'),

      insertLog: this.db.prepare(
        'INSERT INTO request_logs(id, api_key_id, provider_id, used_prompt, input_text_len, output_text_len, status, error_code, error_message, prompt_tokens, completion_tokens, total_tokens, latency_ms, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ),

      insertSession: this.db.prepare(
        'INSERT INTO user_sessions(token_hash, sub, email, name, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ),
      getSession: this.db.prepare('SELECT * FROM user_sessions WHERE token_hash = ?'),
      deleteSession: this.db.prepare('DELETE FROM user_sessions WHERE token_hash = ?'),
      deleteExpiredSessions: this.db.prepare('DELETE FROM user_sessions WHERE expires_at < ?'),

      getIdempotency: this.db.prepare('SELECT * FROM idempotency WHERE key = ? AND api_key_id = ?'),
      upsertIdempotency: this.db.prepare(
        'INSERT INTO idempotency(key, api_key_id, fingerprint, status, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(key, api_key_id) DO UPDATE SET fingerprint=excluded.fingerprint, status=excluded.status, response_json=excluded.response_json, created_at=excluded.created_at, expires_at=excluded.expires_at'
      ),
      deleteExpiredIdempotency: this.db.prepare('DELETE FROM idempotency WHERE expires_at < ?')
    };
  }

  _ensureDefaultConfig() {
    const existing = this.stmt.getConfig.get();
    if (!existing) {
      this.stmt.upsertConfig.run(DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT, 20000, this.now());
    }
  }

  // ---------- config / prompts ----------

  getConfig() {
    return this.stmt.getConfig.get();
  }

  updateConfig(patch, changedBy) {
    const current = this.getConfig();
    const next = {
      system_prompt: patch.systemPrompt !== undefined ? patch.systemPrompt : current.system_prompt,
      default_user_prompt:
        patch.defaultUserPrompt !== undefined ? patch.defaultUserPrompt : current.default_user_prompt,
      max_text_length:
        patch.maxTextLength !== undefined ? Number(patch.maxTextLength) : current.max_text_length
    };
    const ts = this.now();

    if (patch.systemPrompt !== undefined && patch.systemPrompt !== current.system_prompt) {
      this.stmt.insertHistory.run('system_prompt', current.system_prompt, next.system_prompt, changedBy || null, ts);
    }
    if (patch.defaultUserPrompt !== undefined && patch.defaultUserPrompt !== current.default_user_prompt) {
      this.stmt.insertHistory.run(
        'default_user_prompt',
        current.default_user_prompt,
        next.default_user_prompt,
        changedBy || null,
        ts
      );
    }

    this.stmt.upsertConfig.run(next.system_prompt, next.default_user_prompt, next.max_text_length, ts);
    return this.getConfig();
  }

  listPromptHistory(limit = 50) {
    return this.stmt.listHistory.all(limit);
  }

  // ---------- providers ----------

  listProviders({ includeSecret = false } = {}) {
    const rows = this.stmt.listProviders.all();
    return rows.map((r) => this._decorateProvider(r, includeSecret));
  }

  getProvider(id, { includeSecret = false } = {}) {
    const row = this.stmt.getProvider.get(id);
    if (!row) return null;
    return this._decorateProvider(row, includeSecret);
  }

  getDefaultProvider({ includeSecret = false } = {}) {
    const row = this.stmt.getDefaultProvider.get();
    if (!row) return null;
    return this._decorateProvider(row, includeSecret);
  }

  _decorateProvider(row, includeSecret) {
    const out = {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      model: row.model,
      timeoutMs: row.timeout_ms,
      maxRetries: row.max_retries,
      isDefault: !!row.is_default,
      enabled: !!row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    if (includeSecret) {
      try {
        out.apiKey = decrypt(row.api_key_encrypted, this.encryptionKey);
      } catch (err) {
        out.apiKey = null;
        out.apiKeyError = 'decrypt_failed';
      }
    } else {
      let plain = '';
      try {
        plain = decrypt(row.api_key_encrypted, this.encryptionKey);
      } catch (err) {
        plain = '';
      }
      out.apiKeyMasked = plain ? plain.slice(0, 6) + '***' : '(未设置)';
    }
    return out;
  }

  createProvider(input) {
    const id = input.id || randomId('prov');
    const ts = this.now();
    const encrypted = encrypt(input.apiKey || '', this.encryptionKey);
    this.stmt.insertProvider.run(
      id,
      input.name,
      input.baseUrl,
      encrypted,
      input.model,
      input.timeoutMs || 30000,
      input.maxRetries || 1,
      input.isDefault ? 1 : 0,
      input.enabled === false ? 0 : 1,
      ts,
      ts
    );
    if (input.isDefault) this.setDefaultProvider(id);
    return this.getProvider(id);
  }

  updateProvider(id, patch) {
    const current = this.stmt.getProvider.get(id);
    if (!current) return null;
    const ts = this.now();
    const encrypted =
      patch.apiKey !== undefined && patch.apiKey !== ''
        ? encrypt(patch.apiKey, this.encryptionKey)
        : current.api_key_encrypted;
    this.stmt.updateProvider.run(
      patch.name !== undefined ? patch.name : current.name,
      patch.baseUrl !== undefined ? patch.baseUrl : current.base_url,
      encrypted,
      patch.model !== undefined ? patch.model : current.model,
      patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeout_ms,
      patch.maxRetries !== undefined ? patch.maxRetries : current.max_retries,
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled,
      ts,
      id
    );
    if (patch.isDefault) this.setDefaultProvider(id);
    return this.getProvider(id);
  }

  setDefaultProvider(id) {
    const row = this.stmt.getProvider.get(id);
    if (!row) throw Object.assign(new Error('供应商不存在'), { code: 'not_found' });
    this.stmt.clearDefaultProvider.run();
    this.stmt.setDefaultProvider.run(this.now(), id);
  }

  deleteProvider(id) {
    this.stmt.deleteProvider.run(id);
  }

  // ---------- api keys ----------

  listApiKeys() {
    return this.stmt.listApiKeys.all().map((r) => ({
      id: r.id,
      label: r.label,
      keyPrefix: r.key_prefix,
      enabled: !!r.enabled,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      createdBy: r.created_by || null
    }));
  }

  createApiKey(label, rawKey, keyHash, createdBy = null) {
    const id = randomId('key');
    const prefix = rawKey.slice(0, 12) + '...';
    this.stmt.insertApiKey.run(id, label, keyHash, prefix, this.now(), createdBy);
    return { id, label, keyPrefix: prefix, enabled: true, createdAt: this.now(), createdBy };
  }

  getApiKey(id) {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
    return r ? { id: r.id, label: r.label, enabled: !!r.enabled } : null;
  }

  renameApiKey(id, label) {
    this.db.prepare('UPDATE api_keys SET label = ? WHERE id = ?').run(label, id);
  }

  verifyApiKeyHash(hash) {
    const row = this.stmt.getApiKeyByHash.get(hash);
    if (!row || !row.enabled) return null;
    this.stmt.touchApiKey.run(this.now(), row.id);
    return { id: row.id, label: row.label };
  }

  setApiKeyEnabled(id, enabled) {
    this.stmt.setApiKeyEnabled.run(enabled ? 1 : 0, id);
  }

  deleteApiKey(id) {
    this.stmt.deleteApiKey.run(id);
  }

  // ---------- logs ----------

  insertLog(entry) {
    this.stmt.insertLog.run(
      entry.id,
      entry.apiKeyId || null,
      entry.providerId,
      entry.usedPrompt,
      entry.inputTextLen,
      entry.outputTextLen || null,
      entry.status,
      entry.errorCode || null,
      entry.errorMessage || null,
      entry.promptTokens || null,
      entry.completionTokens || null,
      entry.totalTokens || null,
      entry.latencyMs || null,
      entry.createdAt || this.now()
    );
  }

  queryLogs({ limit = 50, offset = 0, status, providerId, since } = {}) {
    const clauses = [];
    const params = [];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (providerId) {
      clauses.push('provider_id = ?');
      params.push(providerId);
    }
    if (since) {
      clauses.push('created_at >= ?');
      params.push(since);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const sql = `SELECT * FROM request_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const stmt = this.db.prepare(sql);
    return stmt.all(...params, limit, offset);
  }

  countLogs({ status, providerId, since } = {}) {
    const clauses = [];
    const params = [];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (providerId) {
      clauses.push('provider_id = ?');
      params.push(providerId);
    }
    if (since) {
      clauses.push('created_at >= ?');
      params.push(since);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const sql = `SELECT COUNT(*) AS n FROM request_logs ${where}`;
    const stmt = this.db.prepare(sql);
    return Number(stmt.get(...params).n || 0);
  }

  metricsSummary(sinceMs) {
    const total = this.countLogs({ since: sinceMs });
    const success = this.countLogs({ since: sinceMs, status: 'success' });
    const error = this.countLogs({ since: sinceMs, status: 'error' });
    const row = this.db
      .prepare(
        'SELECT AVG(latency_ms) AS avgLatency, SUM(total_tokens) AS sumTokens FROM request_logs WHERE created_at >= ? AND status = ?'
      )
      .get(sinceMs, 'success');
    return {
      total,
      success,
      error,
      successRate: total > 0 ? Math.round((success / total) * 10000) / 100 : null,
      avgLatencyMs: row.avgLatency ? Math.round(row.avgLatency) : null,
      totalTokens: row.sumTokens || 0
    };
  }

  // ---------- admin users / sessions ----------

  // ---------- 用户会话（acc 登录） ----------

  createSession(user, ttlMs) {
    const token = crypto.randomBytes(32).toString('base64url');
    const ts = this.now();
    this.stmt.insertSession.run(sha256(token), user.sub, user.email || null, user.name || null, user.role || null, ts, ts + ttlMs);
    return token;
  }

  getSession(token) {
    if (!token) return null;
    this.stmt.deleteExpiredSessions.run(this.now());
    const row = this.stmt.getSession.get(sha256(token));
    if (!row || row.expires_at < this.now()) return null;
    return { sub: row.sub, email: row.email, name: row.name, role: row.role, expiresAt: row.expires_at };
  }

  deleteSession(token) {
    if (token) this.stmt.deleteSession.run(sha256(token));
  }

  /** Idempotency-Key 命中：同一 Key + 同一指纹在 24h 内直接回放 */
  getIdempotent(key, apiKeyId) {
    if (!key) return null;
    this.stmt.deleteExpiredIdempotency.run(this.now());
    const row = this.stmt.getIdempotency.get(key, apiKeyId);
    if (!row || row.expires_at < this.now()) return null;
    return { fingerprint: row.fingerprint, status: row.status, body: JSON.parse(row.response_json) };
  }

  saveIdempotent(key, apiKeyId, fingerprint, status, body, ttlMs = 24 * 60 * 60 * 1000) {
    const ts = this.now();
    this.stmt.upsertIdempotency.run(key, apiKeyId, fingerprint, status, JSON.stringify(body), ts, ts + ttlMs);
  }


  close() {
    try {
      this.db.close();
    } catch (err) {
      /* 已关闭 */
    }
  }
}

module.exports = { Store, DEFAULT_DB, DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT };
