/* =============================================================
 * STS2 娘化MOD站 · 评论区前端
 * 用法：Comments.mount(rid, containerEl)
 * 依赖：fetch API（XHR/CORS 走 credentials: 'include'）
 * 配置：通过 window.COMMENT_API_BASE 设置后端地址（默认同源 /api）
 * ============================================================= */
(function () {
    'use strict';

    const API_BASE = (window.COMMENT_API_BASE || '/api').replace(/\/$/, '');
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const fmtTime = (ts) => {
        const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
        const now = new Date(), diff = (now - d) / 1000;
        if (diff < 60)        return '刚刚';
        if (diff < 3600)      return Math.floor(diff / 60) + ' 分钟前';
        if (diff < 86400)     return Math.floor(diff / 3600) + ' 小时前';
        if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
        const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
        return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    };
    const fmtSize = (n) => {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    };
    const fileIcon = (kind, mime) => {
        if (kind === 'image') return '🖼';
        if (kind === 'log')   return '📋';
        if (kind === 'text')  return '📄';
        if (mime?.includes('zip')) return '🗜';
        return '📎';
    };

    // ---- API 封装 ----
    async function api(path, opts = {}) {
        const init = {
            method: opts.method || 'GET',
            credentials: 'include',
            headers: {},
        };
        if (opts.body instanceof FormData) {
            init.body = opts.body;
        } else if (opts.body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.body);
        }
        const r = await fetch(API_BASE + path, init);
        let data = null;
        try { data = await r.json(); } catch { /* not json */ }
        if (!r.ok || (data && data.ok === false)) {
            const msg = (data && (data.error || data.message)) || ('请求失败 (' + r.status + ')');
            const err = new Error(msg);
            err.status = r.status;
            err.data   = data;
            throw err;
        }
        return data || {};
    }
    const apiUpload = (path, file) => {
        const fd = new FormData();
        fd.append('file', file);
        return api(path, { method: 'POST', body: fd });
    };

    // ---- 状态 ----
    const state = {
        rid: null,
        container: null,
        me: null,                // { id, email, nickname, avatar, isAdmin, isVerified }
        comments: [],
        replyTo: null,           // 评论 id
        pendingFiles: [],        // { key, url, name, mime, size, kind }
        busy: false,
    };

    // ===========================================================
    // 顶层挂载
    // ===========================================================
    function mount(rid, container) {
        if (!rid || !container) return;
        state.rid = rid;
        state.container = container;
        renderShell();
        refresh();
    }
    function unmount() {
        state.rid = null;
        state.container = null;
        state.me = null;
        state.comments = [];
        state.replyTo = null;
        state.pendingFiles = [];
    }

    function renderShell() {
        const el = state.container;
        el.classList.add('cm-root');
        el.innerHTML = `
            <div class="cm-header">
                <div class="cm-title">评论区 <span class="cm-count" id="cmCount"></span></div>
                <div class="cm-user" id="cmUser"></div>
            </div>
            <div id="cmAlert"></div>
            <div id="cmForm"></div>
            <div id="cmList"></div>
        `;
    }

    async function refresh() {
        // 拉取自己
        try {
            const r = await api('/auth/me');
            state.me = r.user;
        } catch {
            state.me = null;
        }
        // 拉取评论
        const list = document.getElementById('cmList');
        list.innerHTML = '<div class="cm-loading"><span class="cm-spinner"></span>正在加载评论…</div>';
        try {
            const r = await api('/comments?rid=' + encodeURIComponent(state.rid));
            state.comments = r.comments || [];
            state.me = state.me || (r.user || null);
            renderUser();
            renderForm();
            renderList();
        } catch (e) {
            list.innerHTML = `<div class="cm-error">评论加载失败：${esc(e.message)}</div>`;
        }
    }

    // ===========================================================
    // 用户区（登录 / 昵称 / 退出）
    // ===========================================================
    function renderUser() {
        const box = document.getElementById('cmUser');
        if (!box) return;
        if (state.me) {
            const avatar = state.me.avatar || defaultAvatar(state.me.nickname);
            box.innerHTML = `
                <img class="cm-avatar" src="${esc(avatar)}" alt="" onerror="this.src='${defaultAvatar(state.me.nickname)}'">
                <span class="cm-nick">${esc(state.me.nickname)}</span>
                <button class="cm-link" id="cmEditBtn">编辑资料</button>
                <button class="cm-link" id="cmLogoutBtn">退出</button>
            `;
            document.getElementById('cmEditBtn').onclick   = openProfileModal;
            document.getElementById('cmLogoutBtn').onclick  = doLogout;
        } else {
            box.innerHTML = `
                <button class="cm-link" id="cmLoginBtn">登录</button>
                <span style="color:var(--cm-text-3)">或</span>
                <button class="cm-link" id="cmRegisterBtn">注册</button>
            `;
            document.getElementById('cmLoginBtn').onclick    = () => openAuthModal('login');
            document.getElementById('cmRegisterBtn').onclick = () => openAuthModal('register');
        }
    }

    function defaultAvatar(name) {
        const c = (name || '?').trim().charAt(0).toUpperCase();
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <rect width="64" height="64" fill="#f5c4c4"/><text x="50%" y="55%" text-anchor="middle"
                font-family="sans-serif" font-size="32" font-weight="700" fill="#fff" dominant-baseline="middle">${esc(c)}</text>
        </svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }

    // ===========================================================
    // 发表评论表单
    // ===========================================================
    function renderForm() {
        const box = document.getElementById('cmForm');
        const disabled = !state.me || !state.me.isVerified;
        if (!state.me) {
            box.innerHTML = `<div class="cm-card" style="text-align:center;color:var(--cm-text-3);font-size:.9rem">
                请先<a href="javascript:void(0)" class="cm-link" id="cmGotoLogin">登录</a>
                后参与评论（支持邮箱注册，免费）
            </div>`;
            document.getElementById('cmGotoLogin').onclick = () => openAuthModal('login');
            return;
        }
        if (!state.me.isVerified) {
            box.innerHTML = `<div class="cm-card" style="text-align:center;color:var(--cm-text-3);font-size:.9rem">
                你的邮箱尚未验证，请前往注册邮箱点击验证链接
            </div>`;
            return;
        }
        box.innerHTML = `
            <div class="cm-card cm-form">
                <textarea class="cm-textarea" id="cmInput" placeholder="说点什么吧…（支持 Markdown 不解析，自动转义）" maxlength="2000"></textarea>
                <div class="cm-form-row">
                    <div class="cm-file-list" id="cmFiles"></div>
                    <input type="file" class="cm-file-input" id="cmFile" accept="image/*,.txt,.log">
                    <button class="cm-btn cm-btn-ghost cm-btn-sm" id="cmPickFile" type="button">添加附件</button>
                    <button class="cm-btn" id="cmSubmit" type="button">发表</button>
                </div>
            </div>
        `;
        const ta = document.getElementById('cmInput');
        const submit = document.getElementById('cmSubmit');
        const pick = document.getElementById('cmPickFile');
        const file = document.getElementById('cmFile');
        ta.disabled = disabled;
        submit.disabled = disabled;
        if (disabled) ta.placeholder = '请先登录并验证邮箱';
        submit.onclick = () => doSubmit(null);
        pick.onclick   = () => file.click();
        file.onchange  = onPickFile;
        renderPendingFiles();
    }

    async function onPickFile(e) {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        if (state.pendingFiles.length >= 4) { showAlert('error', '最多 4 个附件'); return; }
        if (f.size > 5 * 1024 * 1024) { showAlert('error', '单个附件不能超过 5MB'); return; }
        try {
            showAlert('info', '附件上传中…');
            const r = await apiUpload('/uploads/comment-file', f);
            state.pendingFiles.push(r);
            renderPendingFiles();
            clearAlert();
        } catch (err) {
            showAlert('error', '附件上传失败：' + err.message);
        }
    }
    function renderPendingFiles() {
        const box = document.getElementById('cmFiles');
        if (!box) return;
        if (!state.pendingFiles.length) { box.innerHTML = ''; return; }
        box.innerHTML = state.pendingFiles.map((f, i) => `
            <span class="cm-file-chip" title="${esc(f.name)}">
                <span>${fileIcon(f.kind, f.mime)}</span>
                <span class="cm-file-chip-name">${esc(f.name)}</span>
                <button class="cm-file-chip-x" data-i="${i}" aria-label="移除">×</button>
            </span>
        `).join('');
        box.querySelectorAll('.cm-file-chip-x').forEach(b => {
            b.onclick = () => {
                const i = Number(b.dataset.i);
                state.pendingFiles.splice(i, 1);
                renderPendingFiles();
            };
        });
    }

    async function doSubmit(parentId) {
        if (state.busy) return;
        const ta = parentId
            ? document.querySelector(`.cm-reply-form[data-parent="${parentId}"] textarea`)
            : document.getElementById('cmInput');
        if (!ta) return;
        const content = ta.value.trim();
        if (content.length < 2) { showAlert('error', '评论至少 2 个字'); return; }
        state.busy = true;
        try {
            const body = {
                rid: state.rid,
                content,
                parentId: parentId || null,
                attachments: parentId ? [] : state.pendingFiles.map(f => ({
                    key: f.key, name: f.name, mime: f.mime, size: f.size, kind: f.kind,
                })),
            };
            const r = await api('/comments', { method: 'POST', body });
            ta.value = '';
            if (!parentId) state.pendingFiles = [];
            showAlert('info', r.message || '评论已提交');
            await refresh();
            setTimeout(clearAlert, 2200);
        } catch (e) {
            showAlert('error', '发表失败：' + e.message);
        } finally {
            state.busy = false;
        }
    }

    // ===========================================================
    // 列表渲染
    // ===========================================================
    function renderList() {
        const box = document.getElementById('cmList');
        const list = state.comments || [];
        const count = countAll(list);
        document.getElementById('cmCount').textContent = `(${count})`;

        if (!list.length) {
            box.innerHTML = '<div class="cm-empty">还没有评论，快来抢沙发吧～</div>';
            return;
        }
        box.innerHTML = list.map(c => renderItem(c, 0)).join('');
        bindListEvents(box);
    }
    function countAll(list) {
        let n = 0;
        list.forEach(c => { n++; if (c.replies) n += countAll(c.replies); });
        return n;
    }
    function renderItem(c, depth) {
        const avatar = c.author.avatar || defaultAvatar(c.author.nickname);
        const isAdmin = state.me && state.me.isAdmin;
        const canDelete = state.me && (state.me.id === c.author.id || state.me.isAdmin);
        const replyBtn = state.me && state.me.isVerified
            ? `<button data-act="reply" data-id="${c.id}">回复</button>` : '';
        const delBtn = canDelete
            ? `<button data-act="delete" data-id="${c.id}" class="cm-danger">删除</button>` : '';
        const modBtns = isAdmin ? `
            <span class="cm-mod-actions">
                <button class="cm-mod-btn cm-mod-ok" data-act="mod-ok" data-id="${c.id}">通过</button>
                <button class="cm-mod-btn cm-mod-no" data-act="mod-no" data-id="${c.id}">拒绝</button>
            </span>
        ` : '';

        return `
            <div class="cm-item" data-id="${c.id}">
                <div class="cm-item-head">
                    <img class="cm-item-avatar" src="${esc(avatar)}" alt=""
                         onerror="this.src='${defaultAvatar(c.author.nickname)}'">
                    <div class="cm-item-meta">
                        <div class="cm-item-name">
                            ${esc(c.author.nickname)}
                            ${c.author.id && state.me && c.author.id === state.me.id ? '<span class="cm-item-badge">我</span>' : ''}
                            ${c.author.isAdmin ? '<span class="cm-item-badge cm-item-badge-admin">管理员</span>' : ''}
                            ${c.status && c.status !== 'approved' ? `<span class="cm-item-badge">${esc(c.status)}</span>` : ''}
                        </div>
                        <div class="cm-item-time">${fmtTime(c.createdAt)}</div>
                    </div>
                    ${modBtns}
                </div>
                <div class="cm-content">${esc(c.content)}</div>
                ${renderAttachments(c.attachments)}
                <div class="cm-actions">
                    ${replyBtn}
                    ${delBtn}
                </div>
                ${state.replyTo === c.id ? renderReplyForm(c.id) : ''}
                ${c.replies && c.replies.length ? `<div class="cm-replies">${c.replies.map(r => renderItem(r, depth + 1)).join('')}</div>` : ''}
            </div>
        `;
    }
    function renderAttachments(list) {
        if (!list || !list.length) return '';
        return `<div class="cm-attach">${list.map(a => {
            if (a.kind === 'image') {
                return `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">
                          <img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy">
                        </a>`;
            }
            return `<a class="cm-attach-file" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" title="${esc(a.name)}">
                <span>${fileIcon(a.kind, a.mime)}</span>
                <span class="cm-attach-file-name">${esc(a.name)}</span>
                <span class="cm-attach-file-size">${fmtSize(a.size)}</span>
            </a>`;
        }).join('')}</div>`;
    }
    function renderReplyForm(parentId) {
        return `
            <div class="cm-reply-form" data-parent="${parentId}">
                <textarea class="cm-textarea" placeholder="回复 ${esc(getNameById(parentId))}…" maxlength="2000"></textarea>
                <div class="cm-form-row">
                    <button class="cm-btn cm-btn-sm" data-act="send-reply" data-id="${parentId}">发送</button>
                    <button class="cm-btn cm-btn-ghost cm-btn-sm" data-act="cancel-reply" data-id="${parentId}">取消</button>
                </div>
            </div>
        `;
    }
    function getNameById(id) {
        const find = (list) => {
            for (const c of list) {
                if (c.id === id) return c.author.nickname;
                if (c.replies) { const r = find(c.replies); if (r) return r; }
            }
            return null;
        };
        return find(state.comments) || '';
    }

    function bindListEvents(root) {
        root.querySelectorAll('button[data-act]').forEach(btn => {
            const id = Number(btn.dataset.id);
            const act = btn.dataset.act;
            btn.onclick = async () => {
                if (act === 'reply') {
                    state.replyTo = id;
                    renderList();
                } else if (act === 'cancel-reply') {
                    state.replyTo = null;
                    renderList();
                } else if (act === 'send-reply') {
                    await doSubmit(id);
                    state.replyTo = null;
                } else if (act === 'delete') {
                    if (!confirm('确定删除这条评论？')) return;
                    try {
                        await api('/comments/' + id, { method: 'DELETE' });
                        await refresh();
                    } catch (e) {
                        showAlert('error', '删除失败：' + e.message);
                    }
                } else if (act === 'mod-ok' || act === 'mod-no') {
                    const path = act === 'mod-ok'
                        ? '/admin/comments/' + id + '/approve'
                        : '/admin/comments/' + id + '/reject';
                    try {
                        await api(path, { method: 'POST' });
                        await refresh();
                    } catch (e) {
                        showAlert('error', '操作失败：' + e.message);
                    }
                }
            };
        });
    }

    // ===========================================================
    // 登录 / 注册 弹窗
    // ===========================================================
    function openAuthModal(tab) {
        tab = tab || 'login';
        const mask = document.createElement('div');
        mask.className = 'cm-modal-mask';
        mask.innerHTML = `
            <div class="cm-modal" role="dialog" aria-modal="true">
                <div class="cm-modal-head">
                    <span id="cmAuthTitle">登录</span>
                    <button class="cm-modal-close" aria-label="关闭">×</button>
                </div>
                <div class="cm-modal-body">
                    <div class="cm-tab-row">
                        <button class="cm-tab ${tab==='login'?'active':''}" data-tab="login">登录</button>
                        <button class="cm-tab ${tab==='register'?'active':''}" data-tab="register">注册</button>
                    </div>
                    <div class="cm-field">
                        <label class="cm-label">邮箱</label>
                        <input class="cm-input" type="email" id="cmAuthEmail" autocomplete="email" placeholder="you@example.com">
                    </div>
                    <div class="cm-field">
                        <label class="cm-label">密码（注册时 ≥ 8 位）</label>
                        <input class="cm-input" type="password" id="cmAuthPwd" autocomplete="${tab==='login'?'current-password':'new-password'}" placeholder="••••••••">
                    </div>
                    <div class="cm-field" id="cmNickWrap" style="display:${tab==='register'?'block':'none'}">
                        <label class="cm-label">昵称</label>
                        <input class="cm-input" type="text" id="cmAuthNick" maxlength="24" placeholder="2 ~ 24 字">
                    </div>
                    <div class="cm-modal-foot">
                        <button class="cm-btn" id="cmAuthSubmit" type="button">${tab==='login'?'登录':'注册并发送验证邮件'}</button>
                    </div>
                    <div id="cmAuthAlert" style="margin-top:10px"></div>
                </div>
            </div>
        `;
        document.body.appendChild(mask);
        const close = () => mask.remove();
        mask.querySelector('.cm-modal-close').onclick = close;
        mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

        const titleEl = mask.querySelector('#cmAuthTitle');
        const emailEl = mask.querySelector('#cmAuthEmail');
        const pwdEl   = mask.querySelector('#cmAuthPwd');
        const nickEl  = mask.querySelector('#cmAuthNick');
        const nickWrap= mask.querySelector('#cmNickWrap');
        const submit  = mask.querySelector('#cmAuthSubmit');
        const alertEl = mask.querySelector('#cmAuthAlert');

        function setTab(t) {
            if (t === 'register') {
                titleEl.textContent = '注册';
                submit.textContent = '注册并发送验证邮件';
                nickWrap.style.display = 'block';
                pwdEl.setAttribute('autocomplete', 'new-password');
            } else {
                titleEl.textContent = '登录';
                submit.textContent = '登录';
                nickWrap.style.display = 'none';
                pwdEl.setAttribute('autocomplete', 'current-password');
            }
            alertEl.innerHTML = '';
            mask.querySelectorAll('.cm-tab').forEach(b =>
                b.classList.toggle('active', b.dataset.tab === t));
        }
        mask.querySelectorAll('.cm-tab').forEach(b => {
            b.onclick = () => setTab(b.dataset.tab);
        });
        setTab(tab);
        setTimeout(() => emailEl.focus(), 60);

        submit.onclick = async () => {
            const email = emailEl.value.trim();
            const pwd   = pwdEl.value;
            const nick  = nickEl.value.trim();
            const isReg = submit.textContent.includes('注册');
            alertEl.innerHTML = '';
            if (!email || !pwd) {
                alertEl.innerHTML = '<div class="cm-error">请填写邮箱和密码</div>'; return;
            }
            submit.disabled = true;
            try {
                if (isReg) {
                    if (!nick) { alertEl.innerHTML = '<div class="cm-error">请填写昵称</div>'; submit.disabled = false; return; }
                    const r = await api('/auth/register', { method: 'POST', body: { email, password: pwd, nickname: nick } });
                    alertEl.innerHTML = `<div class="cm-info">${esc(r.message || '注册成功')}<br>请前往注册邮箱点击验证链接后再登录</div>`;
                } else {
                    await api('/auth/login', { method: 'POST', body: { email, password: pwd } });
                    close();
                    await refresh();
                }
            } catch (e) {
                alertEl.innerHTML = `<div class="cm-error">${esc(e.message)}</div>`;
            } finally {
                submit.disabled = false;
            }
        };
        pwdEl.addEventListener('keydown', e => { if (e.key === 'Enter') submit.click(); });
    }

    // ===========================================================
    // 个人资料弹窗（昵称 / 头像）
    // ===========================================================
    function openProfileModal() {
        if (!state.me) return;
        const me = state.me;
        const mask = document.createElement('div');
        mask.className = 'cm-modal-mask';
        mask.innerHTML = `
            <div class="cm-modal" role="dialog" aria-modal="true">
                <div class="cm-modal-head">
                    <span>编辑个人资料</span>
                    <button class="cm-modal-close" aria-label="关闭">×</button>
                </div>
                <div class="cm-modal-body">
                    <div class="cm-avatar-row">
                        <img class="cm-avatar-big" id="cmPAvatar" src="${esc(me.avatar || defaultAvatar(me.nickname))}">
                        <div>
                            <input type="file" class="cm-file-input" id="cmPFile" accept="image/*">
                            <button class="cm-btn cm-btn-ghost cm-btn-sm" id="cmPChoose" type="button">更换头像</button>
                            <div style="color:var(--cm-text-3);font-size:.78rem;margin-top:6px">JPG/PNG/WEBP/GIF，≤ 2MB</div>
                        </div>
                    </div>
                    <div class="cm-field">
                        <label class="cm-label">昵称</label>
                        <input class="cm-input" id="cmPNick" maxlength="24" value="${esc(me.nickname)}">
                    </div>
                    <div class="cm-field">
                        <label class="cm-label">邮箱（不可修改）</label>
                        <input class="cm-input" value="${esc(me.email)}" disabled>
                    </div>
                    <div class="cm-modal-foot">
                        <button class="cm-btn" id="cmPSave" type="button">保存</button>
                    </div>
                    <div id="cmPAlert" style="margin-top:10px"></div>
                </div>
            </div>
        `;
        document.body.appendChild(mask);
        const close = () => mask.remove();
        mask.querySelector('.cm-modal-close').onclick = close;
        mask.addEventListener('click', e => { if (e.target === mask) close(); });

        const av = mask.querySelector('#cmPAvatar');
        const fileEl = mask.querySelector('#cmPFile');
        const pickBtn = mask.querySelector('#cmPChoose');
        const nickEl = mask.querySelector('#cmPNick');
        const saveBtn = mask.querySelector('#cmPSave');
        const alertEl = mask.querySelector('#cmPAlert');
        let pendingAvatarKey = null;

        pickBtn.onclick = () => fileEl.click();
        fileEl.onchange = async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 2 * 1024 * 1024) { alertEl.innerHTML = '<div class="cm-error">头像不能超过 2MB</div>'; return; }
            try {
                alertEl.innerHTML = '<div class="cm-info">上传中…</div>';
                const r = await apiUpload('/uploads/avatar', f);
                pendingAvatarKey = r.key;
                av.src = r.url;
                alertEl.innerHTML = '';
            } catch (err) {
                alertEl.innerHTML = `<div class="cm-error">${esc(err.message)}</div>`;
            }
        };
        saveBtn.onclick = async () => {
            const nickname = nickEl.value.trim();
            if (nickname.length < 2) { alertEl.innerHTML = '<div class="cm-error">昵称至少 2 个字</div>'; return; }
            saveBtn.disabled = true;
            try {
                await api('/auth/me', {
                    method: 'PATCH',
                    body: { nickname, avatarKey: pendingAvatarKey || undefined },
                });
                close();
                await refresh();
            } catch (e) {
                alertEl.innerHTML = `<div class="cm-error">${esc(e.message)}</div>`;
            } finally {
                saveBtn.disabled = false;
            }
        };
    }

    // ===========================================================
    // 通用工具
    // ===========================================================
    function showAlert(type, msg) {
        const el = document.getElementById('cmAlert');
        if (!el) return;
        el.innerHTML = `<div class="cm-${type==='error'?'error':'info'}">${esc(msg)}</div>`;
    }
    function clearAlert() {
        const el = document.getElementById('cmAlert');
        if (el) el.innerHTML = '';
    }
    async function doLogout() {
        try { await api('/auth/logout', { method: 'POST' }); } catch {}
        await refresh();
    }

    // ===========================================================
    // 处理 ?verify=xxx 链接（用户从邮件点击进来后自动确认）
    // ===========================================================
    async function handleVerifyInUrl() {
        const u = new URL(location.href);
        const t = u.searchParams.get('verify');
        if (!t) return;
        try {
            const r = await api('/auth/verify?token=' + encodeURIComponent(t), { method: 'GET' });
            showAlert('info', r.message || '邮箱已验证，请登录');
        } catch (e) {
            showAlert('error', '验证失败：' + e.message);
        }
        // 清掉 URL 上的 token
        u.searchParams.delete('verify');
        history.replaceState({}, '', u.pathname + (u.search ? u.search : '') + u.hash);
    }

    // ===========================================================
    // 暴露
    // ===========================================================
    window.Comments = {
        mount, unmount, refresh,
        _state: state,
    };

    // ===========================================================
    // 自动挂载：监听原网站帖子详情弹窗的开启，向其末尾注入评论区
    // 依赖：原 #mO（弹窗遮罩）、#mC（弹窗内容）、window._cm.rid
    // ===========================================================
    function autoBootstrap() {
        const mO = document.getElementById('mO');
        if (!mO || mO.__cmHooked) return;
        mO.__cmHooked = true;

        const observer = new MutationObserver(() => {
            if (mO.classList.contains('act')) {
                const mod = window._cm;
                const mC  = document.getElementById('mC');
                if (!mod || !mod.rid || !mC) return;
                let sec = document.getElementById('cmSection');
                if (!sec) {
                    sec = document.createElement('div');
                    sec.id = 'cmSection';
                    mC.appendChild(sec);
                }
                if (sec.dataset.rid !== mod.rid) {
                    sec.dataset.rid = mod.rid;
                    mount(mod.rid, sec);
                }
            } else {
                const sec = document.getElementById('cmSection');
                if (sec) { sec.dataset.rid = ''; sec.innerHTML = ''; }
            }
        });
        observer.observe(mO, { attributes: true, attributeFilter: ['class'] });
    }

    document.addEventListener('DOMContentLoaded', () => {
        autoBootstrap();
        // 顶层页面：检测 ?verify= 然后提示
        const c = document.getElementById('cmAlert');
        if (c) handleVerifyInUrl();
    });
    if (document.readyState !== 'loading') autoBootstrap();
})();
