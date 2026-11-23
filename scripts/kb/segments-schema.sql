-- 语义段落表（kb_segment）：段落级检索单元，每段带视频起止时间
-- 句子边界来自语料 h2 标注（摘录语料的话题标签）；起止时间 = 组内首末句 t_hms
-- 幂等：可重复执行（embedding 由 scripts/kb/build-segments.ts 重算）

CREATE TABLE IF NOT EXISTS kb_segment (
    segment_id      varchar(96) PRIMARY KEY,          -- 如 03-bencao-ep12-s003
    video_id        varchar(64) NOT NULL,             -- 如 03-bencao-ep12
    course_id       varchar(32) NOT NULL,             -- 如 03-bencao
    title           varchar(256) NOT NULL,            -- 段落主题（h2 主名）
    h2_full         varchar(512) NOT NULL DEFAULT '', -- h2 原文（含注释）
    text            text NOT NULL,                    -- 组内句子按时间序拼接
    start_seconds   double precision NOT NULL,        -- 首句开始时间（秒）
    end_seconds     double precision NOT NULL,        -- 末句时间（秒，摘录无结束时间）
    bvid            varchar(24) NOT NULL,
    ep              int NOT NULL,
    sentence_count  int NOT NULL,
    embedding       vector(512),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_segment_course_idx ON kb_segment (course_id, start_seconds);
CREATE INDEX IF NOT EXISTS kb_segment_embedding_idx
    ON kb_segment USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

COMMENT ON TABLE kb_segment IS '语义段落检索单元：段落文本 + 视频起止秒数 + 段落级 embedding';
