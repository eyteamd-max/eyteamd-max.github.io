// =============================================================
// 认证模块：密码哈希 (PBKDF2) + JWT (HS256) + Cookie 工具
// 兼容 Cloudflare Workers（仅使用 Web Crypto API）
// =============================================================

const PBKDF2_ITERATIONS = 120_000;
const PBKDF2_HASH = 'SHA-256';
const KEY_LEN = 32;
const SALT_LEN = 16;
const JWT_TTL  = 60 * 60 * 24 * 7;     // 7 天
const COOKIE   = 'sts2_token';

// ---------- 工具：base64url ----------
const b64uEncode = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64uDecode = (s) => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
};

// ---------- 工具：随机 ----------
const randomBytes = (n) => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return a;
};

// ---------- 密码哈希 ----------
export const hashPassword = async (password) => {
    const salt = randomBytes(SALT_LEN);
    const key  = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
        key, KEY_LEN * 8
    );
    return {
        hash: b64uEncode(bits),
        salt: b64uEncode(salt),
    };
};

export const verifyPassword = async (password, hashB64, saltB64) => {
    const salt = b64uDecode(saltB64);
    const key  = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
        key, KEY_LEN * 8
    );
    const got = b64uEncode(bits);
    return timingSafeEqual(got, hashB64);
};

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// ---------- JWT (HS256) ----------
const importJwtKey = async (secret) =>
    crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    );

export const signJwt = async (payload, secret) => {
    const header  = { alg: 'HS256', typ: 'JWT' };
    const now     = Math.floor(Date.now() / 1000);
    const body    = { ...payload, iat: now, exp: now + JWT_TTL };
    const enc     = (o) => b64uEncode(new TextEncoder().encode(JSON.stringify(o)));
    const data    = `${enc(header)}.${enc(body)}`;
    const key     = await importJwtKey(secret);
    const sig     = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    return `${data}.${b64uEncode(sig)}`;
};

export const verifyJwt = async (token, secret) => {
    if (!token || token.split('.').length !== 3) return null;
    const [h, p, s] = token.split('.');
    const key = await importJwtKey(secret);
    const ok  = await crypto.subtle.verify(
        'HMAC', key,
        b64uDecode(s),
        new TextEncoder().encode(`${h}.${p}`)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(p)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
};

// ---------- Cookie 工具 ----------
export const setAuthCookie = (resp, token) => {
    resp.headers.append(
        'Set-Cookie',
        `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${JWT_TTL}`
    );
    return resp;
};

export const clearAuthCookie = (resp) => {
    resp.headers.append(
        'Set-Cookie',
        `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    );
    return resp;
};

export const getTokenFromRequest = (req) => {
    const c = req.headers.get('Cookie') || '';
    const m = c.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
};

// ---------- 邮箱 token ----------
export const generateEmailToken = () => b64uEncode(randomBytes(32));
