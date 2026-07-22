// =============================================================
// STS2 娘化MOD站 评论系统 · Cloudflare Workers 主入口
// =============================================================

import { json, err, ok, getIp, sha256Hex, isEmail, sanitize, stripTags,
         methodNotAllowed, notFound, corsHeaders } from './utils.js';
import { hashPassword, verifyPassword, signJwt, verifyJwt,
         setAuthCookie, clearAuthCookie, getTokenFromRequest,
         generateEmailToken } from './auth.js';
import { sendMail, renderVerifyEmail } from './mailer.js';
import { takeToken } from './rateLimit.js';
import { evaluateSpam } from './spam.js';
import { putObject, publicUrlFor, ALLOWED_AVATAR, ALLOWED_COMMENT_FILE,
         MAX_AVATAR_SIZE, MAX_COMMENT_FILE, MAX_FILES_PER_COMMENT, detectKind } from './attachments.js';

export { CommentsDO } from './do.js';   // 预留 Durable Object（未启用时不会实例化）

// ---------------------------------------------------------
// 路由表
// ---------------------------------------------------------
const ROUTES = [
    ['POST',   /^\/api\/auth\/register$/,           handleRegister],
    ['GET',    /^\/api\/auth\/verify$/,             handleVerify],
    ['POST',   /^\/api\/auth\/login$/,              handleLogin],
    ['POST',   /^\/api\/auth\/logout$/,             handleLogout],
    ['GET',    /^\/api\/auth\/me$/,                 handleMe],
    ['PATCH',  /^\/api\/auth\/me$/,                 handleUpdateMe],

    ['POST',   /^\/api\/uploads\/avatar$/,          handleAvatarUpload],
    ['POST',   /^\/api\/uploads\/comment-file$/,    handleCommentFileUpload],

    ['GET',    /^\/api\/comments\/?$/,              handleListComments],
    ['POST',   /^\/api\/comments\/?$/,              handleCreateComment],
    ['DELETE', /^\/api\/comments\/(\d+)$/,          handleDeleteComment],

    ['POST',   /^\/api\/admin\/comments\/(\d+)\/approve$/, handleAdminApprove],
    ['POST',   /^\/api\/admin\/comments\/(\d+)\/reject$/,  handleAdminReject],
    ['GET',    /^\/api\/admin\/comments\/pending$/,        handleAdminPending],

    ['GET',    /^\/api\/files\/(.+)$/,              handleFileProxy],
    ['GET',    /^\/api\/health$/,                   () => ok({ ts: Date.now() })],
];

// ---------------------------------------------------------
// 入口
// ---------------------------------------------------------
export default {
    async fetch(req, env, ctx) {
        const url    = new URL(req.url);
        const origin = req.headers.get('Origin') || '';
        const baseCors = corsHeaders(origin);

        // CORS 预检
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: baseCors });
        }

        // 匹配路由
        for (const [method, re, fn] of ROUTES) {
            const m = url.pathname.match(re);
            if (m) {
                if (method !== req.method) {
                    return methodNotAllowed([method]);
                }
                try {
                    const resp = await fn(req, env, ctx, m);
                    // 给所有响应统一打上 CORS 头
                    for (const [k, v] of Object.entries(baseCors)) {
                        resp.headers.set(k, v);
                    }
                    return resp;
                } catch (e) {
                    console.error('[handler:error]', e);
                    return err(500, '服务器内部错误');
                }
            }
        }
        return notFound();
    },
};

// =============================================================
//                       鉴权工具
// =============================================================
async function requireUser(req, env) {
    const token = getTokenFromRequest(req);
    if (!token) return { error: err(401, '未登录') };
    const payload = await verifyJwt(token, env.JWT_SECRET);
    if (!payload?.uid) return { error: err(401, '会话已过期') };
    const user = await env.DB.prepare(
        'SELECT id,email,nickname,avatar_key,is_verified,is_admin,is_banned FROM users WHERE id=?1'
    ).bind(payload.uid).first();
    if (!user) return { error: err(401, '用户不存在') };
    if (user.is_banned) return { error: err(403, '账号已被封禁') };
    return { user };
}

async function requireAdmin(req, env) {
    const r = await requireUser(req, env);
    if (r.error) return r;
    if (!r.user.is_admin) return { error: err(403, '需要管理员权限') };
    return r;
}

// =============================================================
//                   /api/auth/*  注册 / 登录 / 验证
// =============================================================
async function handleRegister(req, env) {
    const { email, password, nickname } = await req.json().catch(() => ({}));
    if (!isEmail(email))         return err(400, '邮箱格式不正确');
    if (!password || password.length < 8 || password.length > 128) return err(400, '密码需 8 ~ 128 位');
    if (!nickname || nickname.length < 2 || nickname.length > 24)   return err(400, '昵称需 2 ~ 24 字');

    // 频率限制：同 IP 1 小时 5 次
    const ip  = getIp(req);
    const ipH = await sha256Hex(ip);
    const r1  = await takeToken(env, `register:${ipH}`, 5, 3600);
    if (!r1.ok) return err(429, '注册请求过于频繁，请稍后再试');

    const exist = await env.DB.prepare('SELECT id FROM users WHERE email=?1').bind(email.toLowerCase()).first();
    if (exist) return err(409, '该邮箱已注册');

    // 第一个用户自动成为管理员
    const countRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();

    const { hash, salt } = await hashPassword(password);
    const insert = await env.DB.prepare(
        `INSERT INTO users (email, nickname, password_hash, password_salt, is_admin)
         VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(
        email.toLowerCase(), nickname, hash, salt,
        (countRow?.c || 0) === 0 ? 1 : 0
    ).run();

    const userId = insert.meta.last_row_id;

    // 生成验证 token
    const token       = generateEmailToken();
    const expiresAt   = Math.floor(Date.now() / 1000) + 86400;
    await env.DB.prepare(
        'INSERT INTO email_tokens (user_id, token, purpose, expires_at) VALUES (?1, ?2, ?3, ?4)'
    ).bind(userId, token, 'verify', expiresAt).run();

    const { html, text } = renderVerifyEmail({
        siteOrigin: env.SITE_ORIGIN,
        token,
        nickname,
    });
    await sendMail(env, { to: email, subject: '【STS2娘化MOD站】验证你的邮箱', html, text });

    return ok({ message: '注册成功，请前往邮箱完成验证' });
}

async function handleVerify(req, env) {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    if (!token) return err(400, '缺少 token');

    const row = await env.DB.prepare(
        'SELECT id, user_id, purpose, expires_at, used FROM email_tokens WHERE token=?1'
    ).bind(token).first();
    if (!row) return err(400, '无效的验证链接');
    if (row.used) return err(400, '该链接已使用');
    if (row.expires_at < Math.floor(Date.now() / 1000)) return err(400, '链接已过期，请重新申请');

    await env.DB.prepare('UPDATE email_tokens SET used=1 WHERE id=?1').bind(row.id).run();
    await env.DB.prepare('UPDATE users SET is_verified=1 WHERE id=?1').bind(row.user_id).run();
    return ok({ message: '邮箱已验证' });
}

async function handleLogin(req, env) {
    const { email, password } = await req.json().catch(() => ({}));
    if (!isEmail(email) || !password) return err(400, '请输入邮箱和密码');

    // 频率限制：每 IP 每 10 分钟 10 次
    const ip  = getIp(req);
    const ipH = await sha256Hex(ip);
    const r1  = await takeToken(env, `login:${ipH}`, 10, 600);
    if (!r1.ok) return err(429, '尝试次数过多，请稍后再试');

    const user = await env.DB.prepare(
        'SELECT id,email,nickname,password_hash,password_salt,is_verified,is_admin,is_banned FROM users WHERE email=?1'
    ).bind(email.toLowerCase()).first();
    if (!user) return err(401, '邮箱或密码错误');

    if (user.is_banned) return err(403, '账号已被封禁');
    if (!user.is_verified) return err(403, '请先完成邮箱验证');

    const okPwd = await verifyPassword(password, user.password_hash, user.password_salt);
    if (!okPwd) return err(401, '邮箱或密码错误');

    await env.DB.prepare('UPDATE users SET last_login_at=strftime(\'%s\',\'now\') WHERE id=?1')
        .bind(user.id).run();

    const token = await signJwt({ uid: user.id }, env.JWT_SECRET);
    const resp  = ok({
        user: {
            id: user.id, email: user.email, nickname: user.nickname,
            isAdmin: !!user.is_admin, isVerified: !!user.is_verified,
        }
    });
    return setAuthCookie(resp, token);
}

async function handleLogout(req, env) {
    const resp = ok({ message: '已退出登录' });
    return clearAuthCookie(resp);
}

async function handleMe(req, env) {
    const r = await requireUser(req, env);
    if (r.error) return r.error;
    const u = r.user;
    return ok({
        user: {
            id: u.id, email: u.email, nickname: u.nickname,
            avatar: u.avatar_key ? publicUrlFor(env, u.avatar_key) : null,
            isAdmin: !!u.is_admin, isVerified: !!u.is_verified,
        }
    });
}

async function handleUpdateMe(req, env) {
    const r = await requireUser(req, env);
    if (r.error) return r.error;
    const body = await req.json().catch(() => ({}));
    const updates = [];
    const values  = [];
    if (body.nickname) {
        const n = String(body.nickname).trim();
        if (n.length < 2 || n.length > 24) return err(400, '昵称需 2 ~ 24 字');
        updates.push('nickname=?' + (values.length + 1));
        values.push(n);
    }
    if (body.avatarKey) {
        updates.push('avatar_key=?' + (values.length + 1));
        values.push(String(body.avatarKey));
    }
    if (!updates.length) return err(400, '没有可更新字段');
    values.push(r.user.id);
    await env.DB.prepare(`UPDATE users SET ${updates.join(',')} WHERE id=?${values.length}`)
        .bind(...values).run();
    return ok({ message: '已更新' });
}

// =============================================================
//                  /api/uploads/*  头像 / 评论附件
// =============================================================
async function handleAvatarUpload(req, env) {
    const r = await requireUser(req, env);
    if (r.error) return r.error;
    const ct = (req.headers.get('Content-Type') || '').toLowerCase();
    if (!ct.startsWith('multipart/form-data')) return err(400, '请使用 multipart/form-data 上传');

    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return err(400, '未找到文件');
    if (!ALLOWED_AVATAR.includes(file.type)) return err(400, '仅支持 JPG/PNG/WEBP/GIF');
    if (file.size > MAX_AVATAR_SIZE)            return err(400, '头像最大 2MB');

    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const key = `avatars/${r.user.id}-${Date.now()}.${ext}`;
    await putObject(env, key, await file.arrayBuffer(), file.type);

    await env.DB.prepare('UPDATE users SET avatar_key=?1 WHERE id=?2')
        .bind(key, r.user.id).run();

    return ok({ key, url: publicUrlFor(env, key) });
}

async function handleCommentFileUpload(req, env) {
    const r = await requireUser(req, env);
    if (r.error) return r.error;
    const ct = (req.headers.get('Content-Type') || '').toLowerCase();
    if (!ct.startsWith('multipart/form-data')) return err(400, '请使用 multipart/form-data 上传');

    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return err(400, '未找到文件');
    if (!ALLOWED_COMMENT_FILE.includes(file.type) &&
        !/\.(log|txt)$/i.test(file.name || '')) return err(400, '仅支持图片 / .txt / .log');
    if (file.size > MAX_COMMENT_FILE) return err(400, '文件最大 5MB');

    const ext = (file.name || 'file').split('.').pop().toLowerCase().slice(0, 6) || 'bin';
    const key = `comments/tmp/${r.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await putObject(env, key, await file.arrayBuffer(), file.type || 'application/octet-stream');

    return ok({
        key,
        url:    publicUrlFor(env, key),
        name:   file.name || `file.${ext}`,
        mime:   file.type || 'application/octet-stream',
        size:   file.size,
        kind:   detectKind(file.type, file.name),
    });
}

// =============================================================
//                  /api/comments/*  评论读写
// =============================================================
async function handleListComments(req, env) {
    const url  = new URL(req.url);
    const rid  = url.searchParams.get('rid');
    if (!rid) return err(400, '缺少 rid');
    const includePending = url.searchParams.get('include') === 'pending';

    // 是否为管理员
    let isAdmin = false;
    const me = await requireUser(req, env);
    if (me.user) isAdmin = !!me.user.is_admin;

    const statusFilter = (includePending && isAdmin) ? 'pending' : 'approved';
    const list = await env.DB.prepare(`
        SELECT c.id, c.parent_id, c.content, c.created_at, c.status,
               u.id AS uid, u.nickname, u.avatar_key
          FROM comments c
          JOIN users u ON u.id = c.user_id
         WHERE c.rid=?1 AND c.status=?2
         ORDER BY c.created_at ASC
         LIMIT 500
    `).bind(rid, statusFilter).all();

    // 取附件
    const ids = (list.results || []).map(c => c.id);
    let attachMap = {};
    if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        const att = await env.DB.prepare(
            `SELECT * FROM comment_attachments WHERE comment_id IN (${placeholders})`
        ).bind(...ids).all();
        for (const a of (att.results || [])) {
            (attachMap[a.comment_id] ||= []).push({
                id: a.id, name: a.filename, mime: a.mime, size: a.size, kind: a.kind,
                url: publicUrlFor(env, a.r2_key),
            });
        }
    }

    // 嵌套结构
    const byId = {};
    const roots = [];
    for (const c of (list.results || [])) {
        c.attachments = attachMap[c.id] || [];
        c.author = {
            id: c.uid, nickname: c.nickname,
            avatar: c.avatar_key ? publicUrlFor(env, c.avatar_key) : null,
        };
        c.createdAt = c.created_at * 1000;
        byId[c.id] = c;
    }
    for (const c of Object.values(byId)) {
        if (c.parent_id && byId[c.parent_id]) {
            (byId[c.parent_id].replies ||= []).push(c);
        } else {
            roots.push(c);
        }
    }

    return ok({ rid, comments: roots, isAdmin });
}

async function handleCreateComment(req, env) {
    const r = await requireUser(req, env);
    if (r.error) return r.error;
    const u = r.user;

    // 频率限制：每用户每分钟 5 条
    const rate = await takeToken(env, `comment:${u.id}`, 5, 60);
    if (!rate.ok) return err(429, '发言过快，请稍后再试');

    const { rid, content, parentId, attachments } = await req.json().catch(() => ({}));
    if (!rid || typeof rid !== 'string')                  return err(400, '缺少 rid');
    const clean = sanitize(content, 2000);
    if (clean.length < 2)                                  return err(400, '评论至少 2 个字');
    if (clean.length > 2000)                               return err(400, '评论不超过 2000 字');

    // 反垃圾
    const recent = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM comments WHERE user_id=?1 AND created_at>strftime('%s','now')-60"
    ).bind(u.id).first();
    const spam = evaluateSpam({ content: clean, recentByUser: (recent?.c || 0) });

    // 状态决定
    let status = spam.status;
    if (status === 'approved' && u.is_admin) status = 'approved';
    if (status === 'approved') {
        // 简单白名单：老用户（注册超过 24h 且有 3 条已通过评论）直接通过
        const trust = await env.DB.prepare(
            `SELECT (strftime('%s','now')-created_at) AS age,
                    (SELECT COUNT(*) FROM comments WHERE user_id=?1 AND status='approved') AS good
               FROM users WHERE id=?1`
        ).bind(u.id).first();
        if ((trust?.age || 0) > 86400 && (trust?.good || 0) >= 3) {
            status = 'approved';
        } else {
            // 新用户先入 pending
            status = 'pending';
        }
    }

    const insert = await env.DB.prepare(
        'INSERT INTO comments (rid, user_id, parent_id, content, status, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(
        rid, u.id, parentId || null, clean, status,
        await sha256Hex(getIp(req))
    ).run();
    const cid = insert.meta.last_row_id;

    // 写附件（最多 4 个）
    if (Array.isArray(attachments) && attachments.length) {
        const stmt = env.DB.prepare(
            'INSERT INTO comment_attachments (comment_id, r2_key, filename, mime, size, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
        );
        for (const a of attachments.slice(0, MAX_FILES_PER_COMMENT)) {
            if (!a?.key) continue;
            await stmt.bind(
                cid, a.key,
                sanitize(a.name || 'file', 80),
                sanitize(a.mime || 'application/octet-stream', 80),
                Number(a.size) || 0,
                sanitize(a.kind || 'other', 16),
            ).run();
            // 从 tmp 移到正式目录
            const newKey = a.key.replace(/^comments\/tmp\//, 'comments/');
            try {
                const obj = await env.STORAGE.get(a.key);
                if (obj) {
                    await env.STORAGE.put(newKey, await obj.arrayBuffer(), {
                        httpMetadata: obj.httpMetadata,
                    });
                    await env.STORAGE.delete(a.key);
                    await env.DB.prepare(
                        'UPDATE comment_attachments SET r2_key=?1 WHERE comment_id=?2 AND r2_key=?3'
                    ).bind(newKey, cid, a.key).run();
                }
            } catch (e) { /* ignore move errors */ }
        }
    }

    return ok({
        id: cid, status,
        message: status === 'approved' ? '评论已发布' : '评论已提交，等待审核',
    });
}

async function handleDeleteComment(req, env, ctx, m) {
    const id   = Number(m[1]);
    const r    = await requireUser(req, env);
    if (r.error) return r.error;

    const row  = await env.DB.prepare('SELECT user_id FROM comments WHERE id=?1').bind(id).first();
    if (!row) return err(404, '评论不存在');
    if (row.user_id !== r.user.id && !r.user.is_admin) return err(403, '无权删除');

    await env.DB.prepare('DELETE FROM comments WHERE id=?1').bind(id).run();
    return ok({ message: '已删除' });
}

// =============================================================
//                  /api/admin/*  审核
// =============================================================
async function handleAdminPending(req, env) {
    const r = await requireAdmin(req, env);
    if (r.error) return r.error;
    const list = await env.DB.prepare(`
        SELECT c.*, u.nickname, u.email FROM comments c
          JOIN users u ON u.id=c.user_id
         WHERE c.status='pending'
         ORDER BY c.created_at ASC LIMIT 200
    `).all();
    return ok({ comments: list.results || [] });
}
async function handleAdminApprove(req, env, ctx, m) {
    const r = await requireAdmin(req, env);
    if (r.error) return r.error;
    const id = Number(m[1]);
    await env.DB.prepare("UPDATE comments SET status='approved' WHERE id=?1").bind(id).run();
    await env.DB.prepare(
        'INSERT INTO moderation_log (comment_id, moderator_id, action) VALUES (?1, ?2, ?3)'
    ).bind(id, r.user.id, 'approve').run();
    return ok({ message: '已通过' });
}
async function handleAdminReject(req, env, ctx, m) {
    const r = await requireAdmin(req, env);
    if (r.error) return r.error;
    const id = Number(m[1]);
    await env.DB.prepare("UPDATE comments SET status='rejected' WHERE id=?1").bind(id).run();
    await env.DB.prepare(
        'INSERT INTO moderation_log (comment_id, moderator_id, action) VALUES (?1, ?2, ?3)'
    ).bind(id, r.user.id, 'reject').run();
    return ok({ message: '已拒绝' });
}

// =============================================================
//                  /api/files/*  R2 代理下载
// =============================================================
async function handleFileProxy(req, env, ctx, m) {
    const key = decodeURIComponent(m[1]);
    if (key.includes('..')) return err(400, '非法的 key');
    const obj = await env.STORAGE.get(key);
    if (!obj) return new Response('Not Found', { status: 404 });
    const headers = new Headers();
    if (obj.httpMetadata?.contentType) headers.set('Content-Type', obj.httpMetadata.contentType);
    headers.set('Cache-Control', 'public, max-age=3600');
    return new Response(obj.body, { headers });
}
