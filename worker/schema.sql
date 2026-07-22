-- ============================================================
-- STS2 娘化MOD站 评论系统 数据库结构 (Cloudflare D1 / SQLite)
-- ============================================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    nickname      TEXT    NOT NULL,
    avatar_key    TEXT,                                  -- R2 存储 key
    password_hash TEXT    NOT NULL,                      -- PBKDF2 派生
    password_salt TEXT    NOT NULL,
    is_verified   INTEGER NOT NULL DEFAULT 0,            -- 0/1
    is_admin      INTEGER NOT NULL DEFAULT 0,
    is_banned     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 邮箱验证 / 找回密码 token
CREATE TABLE IF NOT EXISTS email_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    token      TEXT    NOT NULL UNIQUE,
    purpose    TEXT    NOT NULL,            -- 'verify' | 'reset'
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rid         TEXT    NOT NULL,                       -- 关联的帖子 RID
    user_id     INTEGER NOT NULL,
    parent_id   INTEGER,                                -- 嵌套回复；NULL=顶级
    content     TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',     -- pending|approved|rejected|spam
    ip_hash     TEXT,                                   -- 提交者 IP 哈希（反垃圾）
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (user_id)   REFERENCES users(id)    ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_rid     ON comments(rid, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_user    ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments(parent_id);

-- 评论附件（图片 / .txt / .log）
CREATE TABLE IF NOT EXISTS comment_attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id  INTEGER NOT NULL,
    r2_key      TEXT    NOT NULL,
    filename    TEXT    NOT NULL,
    mime        TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    kind        TEXT    NOT NULL,            -- 'image' | 'log' | 'text' | 'other'
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attach_comment ON comment_attachments(comment_id);

-- 审核日志
CREATE TABLE IF NOT EXISTS moderation_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id   INTEGER NOT NULL,
    moderator_id INTEGER NOT NULL,
    action       TEXT    NOT NULL,           -- 'approve' | 'reject' | 'spam' | 'delete'
    reason       TEXT,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (comment_id)   REFERENCES comments(id) ON DELETE CASCADE,
    FOREIGN KEY (moderator_id) REFERENCES users(id)    ON DELETE CASCADE
);

-- 频率限制日志（按 IP+动作）
CREATE TABLE IF NOT EXISTS rate_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket     TEXT    NOT NULL,             -- e.g. 'login:<ipHash>'
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_rate_bucket_time ON rate_events(bucket, created_at);
