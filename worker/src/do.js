// =============================================================
// 预留 Durable Object：用于实时推送新评论 / 在线状态（可选）
// 默认未启用；如需启用请：
//   1) wrangler.toml 添加 [[durable_objects_bindings]] 段
//   2) 在入口里把相应路由切换到 env.COMMENTS_DO.idFromName(rid)
// =============================================================

export class CommentsDO {
    constructor(state, env) {
        this.state = state;
        this.env   = env;
        this.sessions = new Set();
    }

    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/ws')) {
            const pair = new WebSocketPair();
            const client = pair[0], server = pair[1];
            server.accept();
            this.sessions.add(server);
            server.addEventListener('close', () => this.sessions.delete(server));
            return new Response(null, { status: 101, webSocket: client });
        }
        if (url.pathname.endsWith('/broadcast')) {
            const { message } = await req.json();
            for (const s of this.sessions) {
                try { s.send(JSON.stringify(message)); } catch {}
            }
            return new Response('ok');
        }
        return new Response('Not Found', { status: 404 });
    }
}
