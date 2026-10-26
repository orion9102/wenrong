'use strict';

/**
 * 文镕管理后台前端（原生 JS，零依赖，零构建步骤）
 */

const API = '/api/admin';

const state = {
  route: 'dashboard',
  user: null
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function toast(message, type = 'success') {
  const node = el('div', { class: 'toast ' + type }, message);
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3000);
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    renderLogin(document.getElementById('app'));
  }
  if (!res.ok || data.success === false) {
    const msg = (data && (data.message || (data.error && data.error.message))) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fmtTime(ms) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

// ---------------- 登录 ----------------

async function boot() {
  const root = document.getElementById('app');
  root.innerHTML = '';
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.status === 401) {
      renderLogin(root);
      return;
    }
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error((data && data.message) || 'HTTP ' + res.status);
    state.user = data.user;
    renderApp(root);
  } catch (err) {
    root.appendChild(el('div', { class: 'loading' }, '无法连接服务：' + err.message));
  }
}

function renderLogin(root) {
  root.innerHTML = '';
  root.appendChild(
    el('div', { class: 'login-wrap' }, [
      el('div', { class: 'login-box' }, [
        el('h1', {}, '🦞 文镕 WenRong'),
        el('p', {}, '通用翻译润色服务 · 管理台'),
        el('a', { class: 'btn-link', href: '/api/auth/login', style: 'width:100%' }, '使用统一账号中心登录'),
        el('p', { class: 'muted', style: 'margin-top:14px;font-size:12px' }, '登录由 acc.909939.xyz 提供，仅管理员账号可进入')
      ])
    ])
  );
}

// ---------------- 主应用布局 ----------------

function renderApp(root) {
  root.innerHTML = '';
  const nav = ['dashboard', 'playground', 'prompts', 'providers', 'logs', 'settings'];
  const labels = { dashboard: '概览', playground: 'Playground', prompts: 'Prompt 配置', providers: 'LLM 供应商', logs: '调用日志', settings: '设置' };
  if (!nav.includes(state.route)) state.route = 'dashboard';

  const userName = state.user ? state.user.name || state.user.email || state.user.sub : '';
  const sidebar = el('div', { class: 'sidebar', style: 'position:relative' }, [
    el('div', { class: 'brand' }, ['文镕 WenRong', el('small', {}, '通用翻译润色服务')]),
    el(
      'nav',
      {},
      nav.map((r) =>
        el('a', { class: r === state.route ? 'active' : '', href: '#' + r, onclick: (e) => { e.preventDefault(); state.route = r; location.hash = r; renderApp(root); } }, labels[r])
      )
    ),
    el('div', { class: 'logout' }, [
      el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px;word-break:break-all' }, userName),
      el('a', { href: '#', onclick: async (e) => { e.preventDefault(); await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); boot(); } }, '退出登录')
    ])
  ]);

  const main = el('main', { class: 'main' });

  root.appendChild(sidebar);
  root.appendChild(main);

  const renderers = { dashboard: renderDashboard, playground: renderPlayground, prompts: renderPrompts, providers: renderProviders, logs: renderLogs, settings: renderSettings };
  renderers[state.route](main);
}

// ---------------- Playground ----------------

async function renderPlayground(main) {
  main.innerHTML = '';
  main.appendChild(el('h1', {}, 'Playground'));
  main.appendChild(el('p', { class: 'muted' }, '以第三方调用者的视角体验翻译润色效果：输入文本，系统按当前生效的 Prompt 配置处理并返回结果。'));

  const errorBox = el('div', { class: 'error', style: 'display:none' });

  // 供应商选择
  let providers = [];
  try {
    const resp = await api('/providers');
    providers = resp.data || [];
  } catch (err) { /* 忽略，用默认 */ }
  const providerSelect = el('select', {}, [
    el('option', { value: '' }, '默认供应商'),
    ...providers.map((p) => el('option', { value: p.id }, p.name + (p.isDefault ? '（默认）' : '') + (p.enabled ? '' : ' · 已停用')))
  ]);

  const textInput = el('textarea', { placeholder: '输入需要翻译润色的内容…' });
  const promptInput = el('textarea', { style: 'min-height:60px', placeholder: '自定义 prompt（可选，留空则使用默认的润色+翻译行为）' });

  const resultBox = el('div', { class: 'key-reveal', style: 'display:none; border-color: var(--accent); white-space: pre-wrap;' });
  const metaLine = el('div', { class: 'muted', style: 'margin-top:8px; font-size:12px;' });

  const submitBtn = el('button', {}, '运行');
  submitBtn.onclick = async () => {
    errorBox.style.display = 'none';
    resultBox.style.display = 'none';
    metaLine.textContent = '';
    const text = textInput.value.trim();
    if (!text) {
      errorBox.textContent = '请输入要处理的文本';
      errorBox.style.display = 'block';
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '处理中…（最长 60 秒）';
    try {
      const body = { text };
      if (providerSelect.value) body.providerId = providerSelect.value;
      const customPrompt = promptInput.value.trim();
      if (customPrompt) body.prompt = customPrompt;
      const resp = await api('/playground', { method: 'POST', body });
      resultBox.style.display = 'block';
      resultBox.textContent = resp.data.result;
      metaLine.textContent = 'Prompt: ' + resp.data.usedPrompt +
        ' · 模型: ' + resp.data.model +
        ' · 延迟: ' + resp.data.latencyMs + ' ms' +
        ' · Token: ' + resp.data.usage.totalTokens +
        ' · 请求ID: ' + resp.requestId;
    } catch (err) {
      errorBox.textContent = '调用失败：' + err.message;
      errorBox.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '运行';
    }
  };

  main.appendChild(el('div', { class: 'card' }, [
    el('h2', {}, '输入'),
    el('label', {}, 'LLM 供应商'),
    providerSelect,
    el('label', {}, '待处理文本'),
    textInput,
    el('label', {}, '自定义 Prompt（可选）'),
    promptInput,
    errorBox,
    submitBtn
  ]));
  main.appendChild(el('div', { class: 'card' }, [
    el('h2', {}, '结果'),
    el('div', { class: 'muted' }, '尚未运行'),
    resultBox,
    metaLine
  ]));
}

// ---------------- 概览 ----------------

async function renderDashboard(main) {
  main.innerHTML = '';
  main.appendChild(el('h1', {}, '概览'));
  const grid = el('div', { class: 'stat-grid' }, '加载中…');
  main.appendChild(grid);

  try {
    const { data } = await api('/metrics?hours=24');
    grid.innerHTML = '';
    const items = [
      ['今日调用量', data.total],
      ['成功', data.success],
      ['失败', data.error],
      ['成功率', data.successRate !== null ? data.successRate + '%' : '-'],
      ['平均延迟', data.avgLatencyMs !== null ? data.avgLatencyMs + ' ms' : '-'],
      ['Token 消耗', data.totalTokens]
    ];
    for (const [label, value] of items) {
      grid.appendChild(el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label)]));
    }
  } catch (err) {
    grid.innerHTML = '';
    grid.appendChild(el('div', { class: 'muted' }, '加载统计失败：' + err.message));
  }

  const providerCard = el('div', { class: 'card' }, [el('h2', {}, '默认供应商连通性'), el('div', {}, '检测中…')]);
  main.appendChild(providerCard);
  try {
    const { data: providers } = await api('/providers');
    const def = providers.find((p) => p.isDefault);
    providerCard.lastChild.remove();
    if (!def) {
      providerCard.appendChild(el('div', { class: 'muted' }, '尚未配置默认供应商'));
    } else {
      const result = await api(`/providers/${def.id}/test`, { method: 'POST' });
      const ok = result.data.ok;
      providerCard.appendChild(
        el('div', {}, [
          el('span', { class: 'badge ' + (ok ? 'success' : 'error') }, ok ? '连通正常' : '连通失败'),
          el('span', { class: 'muted', style: 'margin-left:10px' }, def.name + ' (' + def.baseUrl + ')'),
          !ok ? el('div', { class: 'mt-10 muted' }, result.data.error || '') : el('div', { class: 'mt-10 muted' }, '延迟 ' + result.data.latencyMs + 'ms')
        ])
      );
    }
  } catch (err) {
    providerCard.lastChild.remove();
    providerCard.appendChild(el('div', { class: 'muted' }, '检测失败：' + err.message));
  }
}

// ---------------- Prompt 配置 ----------------

async function renderPrompts(main) {
  main.innerHTML = '';
  main.appendChild(el('h1', {}, 'Prompt 配置'));

  const { data } = await api('/prompts');
  const systemInput = el('textarea', {}, data.systemPrompt);
  const userInput = el('textarea', {}, data.defaultUserPrompt);
  const maxLenInput = el('input', { type: 'number' });
  maxLenInput.value = data.maxTextLength;

  const save = async () => {
    try {
      await api('/prompts', {
        method: 'PUT',
        body: { systemPrompt: systemInput.value, defaultUserPrompt: userInput.value, maxTextLength: Number(maxLenInput.value) }
      });
      toast('已保存');
      renderPrompts(main);
    } catch (err) {
      toast('保存失败：' + err.message, 'error');
    }
  };

  main.appendChild(
    el('div', { class: 'card' }, [
      el('h2', {}, 'System Prompt（系统提示词，始终生效，调用方不可覆盖）'),
      systemInput,
      el('h2', {}, 'Default User Prompt（默认用户提示词，调用方未传 prompt 时使用）'),
      userInput,
      el('h2', {}, '单次请求文本最大长度（字符）'),
      maxLenInput,
      el('button', { onclick: save }, '保存')
    ])
  );

  const historyCard = el('div', { class: 'card' }, [el('h2', {}, '修改历史'), el('div', {}, '加载中…')]);
  main.appendChild(historyCard);
  try {
    const { data: history } = await api('/prompts/history?limit=20');
    historyCard.lastChild.remove();
    if (history.length === 0) {
      historyCard.appendChild(el('div', { class: 'muted' }, '暂无修改记录'));
    } else {
      const table = el('table', {}, [
        el('thead', {}, el('tr', {}, [el('th', {}, '时间'), el('th', {}, '字段'), el('th', {}, '变更前'), el('th', {}, '变更后')])),
        el(
          'tbody',
          {},
          history.map((h) =>
            el('tr', {}, [
              el('td', {}, fmtTime(h.changed_at)),
              el('td', {}, h.field),
              el('td', { class: 'mono', style: 'max-width:240px;overflow:hidden;text-overflow:ellipsis' }, h.old_value.slice(0, 80)),
              el('td', { class: 'mono', style: 'max-width:240px;overflow:hidden;text-overflow:ellipsis' }, h.new_value.slice(0, 80))
            ])
          )
        )
      ]);
      historyCard.appendChild(table);
    }
  } catch (err) {
    historyCard.lastChild.remove();
    historyCard.appendChild(el('div', { class: 'muted' }, '加载历史失败：' + err.message));
  }
}

// ---------------- 供应商管理 ----------------

async function renderProviders(main) {
  main.innerHTML = '';
  main.appendChild(el('h1', {}, 'LLM 供应商'));

  const listCard = el('div', { class: 'card' }, '加载中…');
  main.appendChild(listCard);

  async function reload() {
    const { data: providers } = await api('/providers');
    listCard.innerHTML = '';
    listCard.appendChild(el('h2', {}, '已配置供应商'));
    const table = el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', {}, '名称'), el('th', {}, '地址'), el('th', {}, '模型'), el('th', {}, 'Key'), el('th', {}, '状态'), el('th', {}, '操作')])),
      el(
        'tbody',
        {},
        providers.map((p) =>
          el('tr', {}, [
            el('td', {}, p.name),
            el('td', { class: 'mono' }, p.baseUrl),
            el('td', { class: 'mono' }, p.model),
            el('td', { class: 'mono' }, p.apiKeyMasked),
            el('td', {}, [
              p.isDefault ? el('span', { class: 'badge default' }, '默认') : null,
              ' ',
              el('span', { class: 'badge ' + (p.enabled ? 'success' : 'disabled') }, p.enabled ? '启用' : '禁用')
            ]),
            el('td', { class: 'flex-row' }, [
              el('button', { class: 'secondary', onclick: () => testProvider(p.id) }, '测试'),
              !p.isDefault ? el('button', { class: 'secondary', onclick: async () => { await api(`/providers/${p.id}/set-default`, { method: 'POST' }); reload(); } }, '设为默认') : null,
              el('button', { class: 'secondary', onclick: () => editProvider(p) }, '编辑'),
              el('button', { class: 'danger', onclick: async () => { if (confirm('确定删除供应商「' + p.name + '」？')) { await api(`/providers/${p.id}`, { method: 'DELETE' }); reload(); } } }, '删除')
            ])
          ])
        )
      )
    ]);
    listCard.appendChild(table);
  }

  async function testProvider(id) {
    toast('测试中…');
    try {
      const result = await api(`/providers/${id}/test`, { method: 'POST' });
      if (result.data.ok) toast('连通正常，延迟 ' + result.data.latencyMs + 'ms');
      else toast('连通失败：' + result.data.error, 'error');
    } catch (err) {
      toast('测试失败：' + err.message, 'error');
    }
  }

  function formFields(existing) {
    return {
      name: el('input', { type: 'text', value: existing ? existing.name : '' }),
      baseUrl: el('input', { type: 'text', value: existing ? existing.baseUrl : 'http://192.168.88.62:3001/' }),
      model: el('input', { type: 'text', value: existing ? existing.model : 'claude-sonnet-4-5' }),
      apiKey: el('input', { type: 'password', placeholder: existing ? '留空则不修改' : '' }),
      timeoutMs: el('input', { type: 'number', value: existing ? existing.timeoutMs : 30000 }),
      maxRetries: el('input', { type: 'number', value: existing ? existing.maxRetries : 1 })
    };
  }

  function editProvider(existing) {
    const f = formFields(existing);
    const box = el('div', { class: 'card' }, [
      el('h2', {}, existing ? '编辑供应商' : '新增供应商'),
      el('label', {}, '名称'), f.name,
      el('label', {}, '地址 (baseUrl)'), f.baseUrl,
      el('label', {}, '模型'), f.model,
      el('label', {}, 'API Key'), f.apiKey,
      el('label', {}, '超时 (ms)'), f.timeoutMs,
      el('label', {}, '最大重试次数'), f.maxRetries,
      el('div', { class: 'flex-row' }, [
        el('button', {
          onclick: async () => {
            const payload = {
              name: f.name.value,
              baseUrl: f.baseUrl.value,
              model: f.model.value,
              timeoutMs: Number(f.timeoutMs.value),
              maxRetries: Number(f.maxRetries.value)
            };
            if (f.apiKey.value) payload.apiKey = f.apiKey.value;
            try {
              if (existing) await api(`/providers/${existing.id}`, { method: 'PUT', body: payload });
              else await api('/providers', { method: 'POST', body: payload });
              toast('已保存');
              box.remove();
              reload();
            } catch (err) {
              toast('保存失败：' + err.message, 'error');
            }
          }
        }, '保存'),
        el('button', { class: 'secondary', onclick: () => box.remove() }, '取消')
      ])
    ]);
    main.insertBefore(box, listCard);
  }

  main.appendChild(el('button', { onclick: () => editProvider(null) }, '+ 新增供应商'));
  await reload();
}

// ---------------- 设置（账号信息 + API Key 管理） ----------------

async function renderSettings(main) {
  main.innerHTML = '';
  main.appendChild(el('h1', {}, '设置'));

  const u = state.user || {};
  main.appendChild(
    el('div', { class: 'card' }, [
      el('h2', {}, '当前账号'),
      el('div', {}, [el('span', { class: 'muted' }, '名称：'), u.name || '-']),
      el('div', {}, [el('span', { class: 'muted' }, '邮箱：'), u.email || '-']),
      el('div', {}, [el('span', { class: 'muted' }, '角色：'), u.role || '-']),
      el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' }, '账号由统一账号中心 acc.909939.xyz 管理')
    ])
  );

  const section = el('div');
  main.appendChild(section);
  await renderApiKeys(section);
}

async function renderApiKeys(main) {
  main.innerHTML = '';
  main.appendChild(el('h2', { style: 'margin-top:8px' }, 'API Key 管理'));
  main.appendChild(
    el('p', { class: 'muted' }, [
      '外部调用文镕 API 时需携带请求头 ',
      el('code', {}, 'Authorization: Bearer <API_KEY>'),
      '。可为每个调用方单独创建 Key，随时禁用或删除，互不影响。'
    ])
  );

  const revealBox = el('div', { style: 'display:none' });
  const labelInput = el('input', { type: 'text', maxlength: '64', placeholder: '名称/调用方标识，如 apkpure-crawler', 'aria-label': 'API Key 名称' });

  const create = async () => {
    const label = labelInput.value.trim();
    if (!label) { toast('请输入名称', 'error'); return; }
    try {
      const { data } = await api('/api-keys', { method: 'POST', body: { label } });
      revealBox.style.display = 'block';
      revealBox.innerHTML = '';
      const keyText = el('div', { class: 'mono', style: 'margin-top:6px;word-break:break-all' }, data.apiKey);
      const copyBtn = el('button', {
        class: 'secondary',
        style: 'margin-top:8px',
        onclick: async () => {
          try { await navigator.clipboard.writeText(data.apiKey); toast('已复制'); } catch (e) { toast('复制失败，请手动选择复制', 'error'); }
        }
      }, '复制');
      revealBox.appendChild(
        el('div', { class: 'key-reveal', role: 'status' }, [
          el('div', { class: 'muted' }, `「${data.label}」的密钥仅在此展示一次，请立即保存：`),
          keyText,
          copyBtn
        ])
      );
      labelInput.value = '';
      reload();
    } catch (err) {
      toast('创建失败：' + err.message, 'error');
    }
  };
  labelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

  main.appendChild(el('div', { class: 'card' }, [el('h2', {}, '新增 API Key'), labelInput, el('button', { onclick: create }, '生成新 Key'), revealBox]));

  const listCard = el('div', { class: 'card' }, '加载中…');
  main.appendChild(listCard);

  async function reload() {
    let keys;
    try {
      ({ data: keys } = await api('/api-keys'));
    } catch (err) {
      listCard.innerHTML = '';
      listCard.appendChild(el('div', { class: 'muted' }, '加载失败：' + err.message));
      return;
    }
    listCard.innerHTML = '';
    listCard.appendChild(el('h2', {}, `已创建的 Key（${keys.length}）`));
    if (!keys.length) {
      listCard.appendChild(el('div', { class: 'muted' }, '还没有 API Key，外部调用将全部被拒绝（401）。'));
      return;
    }
    const table = el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', {}, '名称'), el('th', {}, '前缀'), el('th', {}, '状态'), el('th', {}, '创建者'), el('th', {}, '创建时间'), el('th', {}, '最后使用'), el('th', {}, '操作')])),
      el(
        'tbody',
        {},
        keys.map((k) =>
          el('tr', {}, [
            el('td', {}, k.label),
            el('td', { class: 'mono' }, k.keyPrefix),
            el('td', {}, el('span', { class: 'badge ' + (k.enabled ? 'success' : 'disabled') }, k.enabled ? '启用' : '禁用')),
            el('td', {}, (k.createdBy || '-').replace(/^acc:/, '')),
            el('td', {}, fmtTime(k.createdAt)),
            el('td', {}, fmtTime(k.lastUsedAt)),
            el('td', { class: 'flex-row' }, [
              el('button', {
                class: 'secondary',
                onclick: async () => {
                  const name = prompt('新的名称', k.label);
                  if (name === null || !name.trim()) return;
                  try { await api(`/api-keys/${k.id}`, { method: 'PUT', body: { label: name.trim() } }); reload(); } catch (err) { toast(err.message, 'error'); }
                }
              }, '重命名'),
              el('button', {
                class: 'secondary',
                onclick: async () => {
                  try { await api(`/api-keys/${k.id}`, { method: 'PUT', body: { enabled: !k.enabled } }); reload(); } catch (err) { toast(err.message, 'error'); }
                }
              }, k.enabled ? '禁用' : '启用'),
              el('button', {
                class: 'danger',
                onclick: async () => {
                  if (!confirm(`确定删除「${k.label}」？使用该 Key 的调用方将立即无法访问。`)) return;
                  try { await api(`/api-keys/${k.id}`, { method: 'DELETE' }); reload(); } catch (err) { toast(err.message, 'error'); }
                }
              }, '删除')
            ])
          ])
        )
      )
    ]);
    listCard.appendChild(table);
  }
  await reload();
}

// ---------------- 调用日志 ----------------

async function renderLogs(main) {
  main.innerHTML = '';
  main.appendChild(el('h1', {}, '调用日志'));

  const listCard = el('div', { class: 'card' }, '加载中…');
  main.appendChild(listCard);

  const { data: logs, pagination } = await api('/logs?limit=50');
  listCard.innerHTML = '';
  listCard.appendChild(el('h2', {}, `最近 ${logs.length} 条（共 ${pagination.total} 条）`));
  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [el('th', {}, '时间'), el('th', {}, '供应商'), el('th', {}, 'Prompt'), el('th', {}, '状态'), el('th', {}, '延迟'), el('th', {}, 'Token'), el('th', {}, '错误')])),
    el(
      'tbody',
      {},
      logs.map((l) =>
        el('tr', {}, [
          el('td', {}, fmtTime(l.created_at)),
          el('td', { class: 'mono' }, l.provider_id),
          el('td', {}, l.used_prompt === 'custom' ? '自定义' : '默认'),
          el('td', {}, el('span', { class: 'badge ' + (l.status === 'success' ? 'success' : 'error') }, l.status === 'success' ? '成功' : '失败')),
          el('td', {}, l.latency_ms ? l.latency_ms + 'ms' : '-'),
          el('td', {}, l.total_tokens || '-'),
          el('td', { class: 'muted' }, l.error_message || '-')
        ])
      )
    )
  ]);
  listCard.appendChild(table);
}

const initialRoute = location.hash.replace(/^#/, '');
if (initialRoute) state.route = initialRoute;
boot();
