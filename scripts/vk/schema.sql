-- 通用视频知识流水线（vk_*）表结构 —— 与 corpus_* 同库（Neon PG + pgvector）
-- 幂等：可重复执行。维度 512 与本地 bge-small-zh-v1.5 embed-server 对齐。

CREATE EXTENSION IF NOT EXISTS vector;

-- 视频源（一集/一个分P）
CREATE TABLE IF NOT EXISTS vk_video (
    video_id varchar(64) PRIMARY KEY,
    course_id varchar(64) NOT NULL,
    course_name varchar(128) NOT NULL,
    bvid varchar(24) NOT NULL DEFAULT '',
    cid bigint,
    part int NOT NULL DEFAULT 1,
    title varchar(256) NOT NULL DEFAULT '',
    mode varchar(16) NOT NULL DEFAULT 'excerpt',      -- full_transcript / excerpt
    content_type varchar(32) NOT NULL DEFAULT 'generic-lecture',
    license text NOT NULL DEFAULT '',
    source text NOT NULL DEFAULT '',
    import_version varchar(32) NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vk_video_course_idx ON vk_video (course_id);

-- 证据（字幕行/摘录，raw_text 不可覆盖；t_end_ms 可空）
CREATE TABLE IF NOT EXISTS vk_evidence (
    id varchar(96) PRIMARY KEY,
    video_id varchar(64) NOT NULL REFERENCES vk_video(video_id) ON DELETE CASCADE,
    seq int NOT NULL,
    t_start_ms int NOT NULL,
    t_end_ms int,
    raw_text text NOT NULL,
    clean_text text NOT NULL DEFAULT '',
    source varchar(16) NOT NULL DEFAULT 'subtitle',
    meta jsonb NOT NULL DEFAULT '{}',
    clean_ops jsonb NOT NULL DEFAULT '[]',
    review_flags text[] NOT NULL DEFAULT '{}',
    dropped varchar(16),
    merged_into varchar(96),
    CONSTRAINT vk_evidence_video_seq UNIQUE (video_id, seq)
);
CREATE INDEX IF NOT EXISTS vk_evidence_video_idx ON vk_evidence (video_id, seq);

-- 粗粒度章节
CREATE TABLE IF NOT EXISTS vk_chapter (
    id varchar(96) PRIMARY KEY,
    video_id varchar(64) NOT NULL REFERENCES vk_video(video_id) ON DELETE CASCADE,
    title varchar(256) NOT NULL DEFAULT '',
    content_type varchar(32),
    t_start_ms int NOT NULL,
    t_end_ms int,
    ev_from_id varchar(96) NOT NULL,
    ev_to_id varchar(96) NOT NULL,
    detection varchar(16) NOT NULL DEFAULT 'fallback'
);

-- 知识段落（切分只存字幕 ID 边界，时间由程序计算）
CREATE TABLE IF NOT EXISTS vk_segment (
    id varchar(96) PRIMARY KEY,
    video_id varchar(64) NOT NULL REFERENCES vk_video(video_id) ON DELETE CASCADE,
    chapter_id varchar(96) NOT NULL,
    content_type varchar(32) NOT NULL,
    title varchar(256) NOT NULL DEFAULT '',
    chapter_raw varchar(256) NOT NULL DEFAULT '',
    ev_ids text[] NOT NULL,
    t_start_ms int NOT NULL,
    t_end_ms int,
    gap_before_ms int,
    internal_gaps_ms int[] NOT NULL DEFAULT '{}',
    completeness varchar(16) NOT NULL DEFAULT 'partial',
    status varchar(16) NOT NULL DEFAULT 'ok',
    pipeline_version varchar(32) NOT NULL DEFAULT ''
);

-- 知识卡片（1:1 对应 segment）
CREATE TABLE IF NOT EXISTS vk_card (
    id varchar(96) PRIMARY KEY,
    segment_id varchar(96) NOT NULL REFERENCES vk_segment(id) ON DELETE CASCADE,
    video_id varchar(64) NOT NULL REFERENCES vk_video(video_id) ON DELETE CASCADE,
    course_id varchar(64) NOT NULL,
    chapter varchar(256) NOT NULL DEFAULT '',
    content_type varchar(32) NOT NULL,
    title varchar(256) NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    points jsonb NOT NULL DEFAULT '[]',
    body text NOT NULL DEFAULT '',
    keywords text[] NOT NULL DEFAULT '{}',
    ev_ids text[] NOT NULL,
    t_start_ms int NOT NULL,
    t_end_ms int,
    bvid varchar(24) NOT NULL DEFAULT '',
    cid bigint,
    part int NOT NULL DEFAULT 1,
    type_fields jsonb NOT NULL DEFAULT '{}',
    quality varchar(16) NOT NULL DEFAULT 'draft',
    gen_mode varchar(16) NOT NULL DEFAULT 'extractive',
    model varchar(128),
    prompt_version varchar(96),
    completeness varchar(16) NOT NULL DEFAULT 'partial',
    version int NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vk_card_course_idx ON vk_card (course_id, t_start_ms);
CREATE INDEX IF NOT EXISTS vk_card_quality_idx ON vk_card (quality);

-- 检索块：head（标题+摘要+关键词）/ body（正文拆块），统一关联父 segment
CREATE TABLE IF NOT EXISTS vk_chunk (
    id varchar(128) PRIMARY KEY,
    card_id varchar(96) NOT NULL REFERENCES vk_card(id) ON DELETE CASCADE,
    segment_id varchar(96) NOT NULL,
    kind varchar(8) NOT NULL DEFAULT 'body',
    ordinal int NOT NULL DEFAULT 0,
    text text NOT NULL,
    embedding vector(512)
);
CREATE INDEX IF NOT EXISTS vk_chunk_segment_idx ON vk_chunk (segment_id);
CREATE INDEX IF NOT EXISTS vk_chunk_embedding_idx
    ON vk_chunk USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- 待复核队列（校验未通过的卡片不得作为已验证结果发布）
CREATE TABLE IF NOT EXISTS vk_review (
    id bigserial PRIMARY KEY,
    card_id varchar(96) NOT NULL,
    video_id varchar(64) NOT NULL,
    course_id varchar(64) NOT NULL,
    quality varchar(16) NOT NULL,
    reason varchar(64) NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vk_review_quality_idx ON vk_review (quality, course_id);

-- 运行记录
CREATE TABLE IF NOT EXISTS vk_run (
    run_id varchar(64) NOT NULL,
    stage varchar(32) NOT NULL,
    status varchar(16) NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, stage)
);

COMMENT ON TABLE vk_evidence IS '视频知识流水线-证据（raw_text 原始不可覆盖；摘录 t_end_ms 为空）';
COMMENT ON TABLE vk_card IS '视频知识流水线-知识卡片（1:1 segment）';
COMMENT ON TABLE vk_chunk IS '检索块：head=章节+标题+摘要+关键词，body=正文拆块；均关联父 segment_id';
COMMENT ON TABLE vk_review IS '待复核队列：quality != validated 的卡片';

-- 幂等列追加（CREATE TABLE IF NOT EXISTS 不会给已存在的表补列）
ALTER TABLE vk_segment ADD COLUMN IF NOT EXISTS chapter_raw varchar(256) NOT NULL DEFAULT '';
