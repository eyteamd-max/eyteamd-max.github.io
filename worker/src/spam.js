// =============================================================
// 反垃圾：简单关键词 + 链接密度 + 速度检测
// 真实生产可替换为机器学习/第三方服务（如 Akismet、Cloudflare Turnstile）
// =============================================================

const BANNED_WORDS = [
    '免费av', '色情', '裸聊', '约炮', '博彩', '赌博', '网赚',
    '代刷', '代练', '兼职', '兼职日结', '微信同号', '薇信', '加微',
];
const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;

export function evaluateSpam({ content, recentByUser = 0 }) {
    const reasons = [];
    const lc = (content || '').toLowerCase();

    for (const w of BANNED_WORDS) {
        if (lc.includes(w.toLowerCase())) reasons.push(`contains:${w}`);
    }

    const urls = content.match(URL_REGEX) || [];
    if (urls.length > 3) reasons.push('too_many_urls');

    // 短文连发：3 条以上评论 / 分钟 视为可疑
    if (recentByUser >= 3) reasons.push('burst_posting');

    if (reasons.length) return { status: 'spam', reasons };
    return { status: 'approved' };
}
