// =============================================================
// 邮件发送（默认走 Resend HTTP API；未配置则降级为开发模式日志）
// 部署前请通过 `wrangler secret put RESEND_API_KEY` 配置密钥
// =============================================================

export async function sendMail(env, { to, subject, html, text }) {
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) {
        // 开发模式：把内容打印到 Workers 日志
        console.log('[mail:dev]', { to, subject, text });
        return { ok: true, dev: true };
    }
    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({
            from: env.EMAIL_FROM || 'no-reply@example.com',
            to, subject, html, text,
        }),
    });
    if (!resp.ok) {
        const err = await resp.text();
        console.error('[mail:error]', err);
        return { ok: false, error: err };
    }
    return { ok: true };
}

export function renderVerifyEmail({ siteOrigin, token, nickname }) {
    const url = `${siteOrigin}/?verify=${token}`;
    const text = `你好 ${nickname}，点击下方链接完成邮箱验证（24小时内有效）：\n${url}`;
    const html = `
        <div style="font-family:'PingFang SC',sans-serif;max-width:520px;margin:auto;padding:24px;background:#faf7f4;border-radius:10px;">
            <h2 style="color:#4a4458;margin:0 0 14px">验证你的邮箱</h2>
            <p style="color:#6b6378;line-height:1.7">你好 <b>${escapeHtml(nickname)}</b>，请点击下方按钮完成邮箱验证，链接 24 小时内有效。</p>
            <p style="margin:22px 0">
                <a href="${url}" style="display:inline-block;padding:10px 24px;background:#e89b9b;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">验证邮箱</a>
            </p>
            <p style="color:#9a92a5;font-size:12px">如果按钮无法点击，请复制以下链接到浏览器打开：<br>${url}</p>
        </div>
    `;
    return { html, text };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
