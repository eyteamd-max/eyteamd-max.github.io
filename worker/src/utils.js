// =============================================================
// 工具函数
// =============================================================

export const json = (data, init = {}) =>
    new Response(JSON.stringify(data), {
        ...init,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...(init.headers || {}),
        },
    });

export const err = (status, message, extra = {}) =>
    json({ ok: false, error: message, ...extra }, { status });

export const ok = (data = {}) => json({ ok: true, ...data });

export const getIp = (req) =>
    req.headers.get('CF-Connecting-IP') ||
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '0.0.0.0';

export const sha256Hex = async (s) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// RFC 5322 简化版邮箱校验
export const isEmail = (s) =>
    typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

export const sanitize = (s, max = 5000) => {
    if (typeof s !== 'string') return '';
    return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
};

export const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '');

export const methodNotAllowed = (allowed) =>
    new Response('Method Not Allowed', {
        status: 405,
        headers: { 'Allow': allowed.join(', ') },
    });

export const notFound = () => new Response('Not Found', { status: 404 });

// 处理 CORS 预检 & 设置跨域头（站点主域默认放行，可通过 ENV 扩展）
export const corsHeaders = (origin) => ({
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
});
