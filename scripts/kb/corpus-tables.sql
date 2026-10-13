-- 中医知识库语料表（nihai-renji-corpus，CC BY-NC-SA 4.0）
-- 依赖 pgvector 扩展（Neon 已支持）

CREATE EXTENSION IF NOT EXISTS vector;

-- 部（六本书）
CREATE TABLE IF NOT EXISTS corpus_book (
    id varchar(32) PRIMARY KEY,
    name varchar(64) NOT NULL,
    short varchar(8) NOT NULL,
    entries int NOT NULL DEFAULT 0,
    eps int NOT NULL DEFAULT 0,
    eps_list jsonb,
    h2_count int NOT NULL DEFAULT 0,
    intro text NOT NULL DEFAULT '',
    sort_no int NOT NULL DEFAULT 0
);

-- 判语条目（含向量，供语义检索）
CREATE TABLE IF NOT EXISTS corpus_entry (
    id bigserial PRIMARY KEY,
    book_id varchar(32) NOT NULL,
    h2 varchar(128) NOT NULL DEFAULT '',
    h3 varchar(64) NOT NULL DEFAULT '',
    quote text NOT NULL,
    bvid varchar(24) NOT NULL DEFAULT '',
    ep int NOT NULL DEFAULT 0,
    t_hms varchar(16) NOT NULL DEFAULT '',
    search_text text NOT NULL DEFAULT '',
    embedding vector(512),
    CONSTRAINT fk_corpus_entry_book FOREIGN KEY (book_id) REFERENCES corpus_book(id)
);

CREATE INDEX IF NOT EXISTS corpus_entry_book_idx ON corpus_entry (book_id, ep);

-- HNSW 余弦索引（19k 条规模，m=16/ef=64 足够；构建约需 1-2 分钟）
CREATE INDEX IF NOT EXISTS corpus_entry_embedding_idx
    ON corpus_entry USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

COMMENT ON TABLE corpus_book IS '中医知识库-部（伤寒论/金匮要略等六部）';
COMMENT ON TABLE corpus_entry IS '中医知识库-判语条目（含 embedding，pgvector 余弦检索）';
COMMENT ON COLUMN corpus_entry.search_text IS 'h2+h3+quote 拼接，embed 服务不可用时关键词回退';
