// =============================================================
// 附件 / 头像上传：写入 Cloudflare R2，限制大小/类型
// =============================================================

export const ALLOWED_AVATAR = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const ALLOWED_COMMENT_FILE = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'text/plain', 'text/x-log',
];

export const MAX_AVATAR_SIZE   = 2 * 1024 * 1024;       // 2 MB
export const MAX_COMMENT_FILE  = 5 * 1024 * 1024;       // 5 MB
export const MAX_FILES_PER_COMMENT = 4;

export const detectKind = (mime, filename) => {
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'text/plain' || /\.log$/i.test(filename || '')) return /\.(log|txt)$/i.test(filename || '') ? (/log$/i.test(filename) ? 'log' : 'text') : 'text';
    return 'other';
};

export async function putObject(env, key, data, contentType) {
    await env.STORAGE.put(key, data, {
        httpMetadata: { contentType },
    });
}

export function publicUrlFor(env, key) {
    if (env.R2_PUBLIC_URL) {
        return `${env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
    }
    return `/api/files/${encodeURIComponent(key)}`;
}
