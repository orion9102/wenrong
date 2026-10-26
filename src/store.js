'use strict';

/**
 * 文镕 SQLite 存储层（node:sqlite，零第三方依赖）
 *
 * 表结构见 docs/PRODUCT_DESIGN.md 第 7 节。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { encrypt, decrypt, randomId } = require('./crypto.js');

const DEFAULT_DB = path.join(process.cwd(), 'data', 'wenrong.sqlite');

const DEFAULT_SYSTEM_PROMPT =
  '你是专业的多语种翻译与文字润色助手。只输出处理后的文本本身，不要添加任何解释、前后缀、引号或markdown代码块标记，不要重复原文。';

const DEFAULT_USER_PROMPT = '请将下面的文本润色后翻译成中文，保持原意，语言自然流畅：';

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
    `);
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
        'INSERT INTO api_keys(id, label, key_hash, key_prefix, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)'
      ),
      touchApiKey: this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?'),
      setApiKeyEnabled: this.db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?'),
      deleteApiKey: this.db.prepare('DELETE FROM api_keys WHERE id = ?'),

      insertLog: this.db.prepare(
        'INSERT INTO request_logs(id, api_key_id, provider_id, used_prompt, input_text_len, output_text_len, status, error_code, error_message, prompt_tokens, completion_tokens, total_tokens, latency_ms, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ),

      getAdminByUsername: this.db.prepare('SELECT * FROM admin_users WHERE username = ?'),
      countAdmins: this.db.prepare('SELECT COUNT(*) AS n FROM admin_users'),
      insertAdmin: this.db.prepare(
        'INSERT INTO admin_users(username, password_hash, created_at) VALUES (?, ?, ?)'
      ),

      insertSession: this.db.prepare(
        'INSERT INTO admin_sessions(token, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
      ),
      getSession: this.db.prepare('SELECT * FROM admin_sessions WHERE token = ?'),
      deleteSession: this.db.prepare('DELETE FROM admin_sessions WHERE token = ?'),
      deleteExpiredSessions: this.db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?')
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
      lastUsedAt: r.last_used_at
    }));
  }

  createApiKey(label, rawKey, keyHash) {
    const id = randomId('key');
    const prefix = rawKey.slice(0, 12) + '...';
    this.stmt.insertApiKey.run(id, label, keyHash, prefix, this.now());
    return { id, label, keyPrefix: prefix };
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

  countAdmins() {
    return Number(this.stmt.countAdmins.get().n || 0);
  }

  getAdminByUsername(username) {
    return this.stmt.getAdminByUsername.get(username);
  }

  createAdmin(username, passwordHash) {
    this.stmt.insertAdmin.run(username, passwordHash, this.now());
  }

  createSession(adminId, ttlMs) {
    const token = randomId('sess') + randomId('');
    const ts = this.now();
    this.stmt.insertSession.run(token, adminId, ts, ts + ttlMs);
    return token;
  }

  getSession(token) {
    this.stmt.deleteExpiredSessions.run(this.now());
    const row = this.stmt.getSession.get(token);
    if (!row) return null;
    if (row.expires_at < this.now()) return null;
    return row;
  }

  deleteSession(token) {
    this.stmt.deleteSession.run(token);
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
