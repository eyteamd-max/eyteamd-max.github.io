// =============================================================
// 频率限制：基于 D1 的滑动窗口（轻量、无 KV 依赖）
// =============================================================

export async function takeToken(env, bucket, limit, windowSec) {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - windowSec;
    // 清理过期
    await env.DB.prepare('DELETE FROM rate_events WHERE bucket=?1 AND created_at<?2')
        .bind(bucket, cutoff).run();
    // 统计当前窗口
    const row = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM rate_events WHERE bucket=?1 AND created_at>=?2'
    ).bind(bucket, cutoff).first();
    if ((row?.c || 0) >= limit) {
        return { ok: false, retryAfter: windowSec };
    }
    await env.DB.prepare('INSERT INTO rate_events (bucket) VALUES (?1)').bind(bucket).run();
    return { ok: true };
}
