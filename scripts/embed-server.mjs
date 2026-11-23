/**
 * 中医知识库 embedding 微服务
 *
 * 模型：bge-small-zh-v1.5（ONNX 量化，512 维，中文检索向）
 * 进程独立：挂掉不影响主服务（BFF 自动降级为关键词检索）
 *
 *   GET  /healthz            → { ok, loaded }
 *   POST /embed {texts:[…]}  → { vectors: [[…512], …] }
 *
 * 启动：node scripts/embed-server.mjs（或 bash deploy/local/start-embed.sh）
 * 首次请求时懒加载模型（HF 下载 ~48MB，之后走本地缓存）。
 */
import http from 'node:http';
import process from 'node:process';

// 沙箱/服务器直连 huggingface.co 的 LFS CDN 不通时走镜像（hf-mirror.com）
if (!process.env.HF_ENDPOINT && !process.env.EMBED_SKIP_MIRROR) {
  process.env.HF_ENDPOINT = 'https://hf-mirror.com';
}

const PORT = Number(process.env.EMBED_PORT || 3001);
const MODEL = process.env.EMBED_MODEL || 'Xenova/bge-small-zh-v1.5';

let extractor = null;
let loading = null;
const queue = []; // 等待模型就绪期间的请求排队

async function getExtractor() {
  if (extractor) return extractor;
  if (!loading) {
    loading = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      extractor = await pipeline('feature-extraction', MODEL, { quantized: true });
      console.log(`[embed] 模型就绪: ${MODEL}`);
      return extractor;
    })();
  }
  return loading;
}

async function embedBatch(texts) {
  const ex = await getExtractor();
  const out = [];
  for (const t of texts) {
    const r = await ex(t, { pooling: 'mean', normalize: true });
    out.push(Array.from(r.data));
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/healthz') {
    send(200, { ok: true, loaded: !!extractor, model: MODEL });
    return;
  }

  if (req.method === 'POST' && req.url === '/embed') {
    try {
      const body = JSON.parse(await readBody(req));
      const texts = body.texts;
      if (!Array.isArray(texts) || texts.length === 0 || texts.length > 128) {
        send(400, { error: 'texts must be a non-empty array (max 128)' });
        return;
      }
      if (texts.some((t) => typeof t !== 'string' || t.length > 2000)) {
        send(400, { error: 'each text must be a string (max 2000 chars)' });
        return;
      }
      const vectors = await embedBatch(texts.map((t) => t.slice(0, 512)));
      send(200, { vectors });
    } catch (e) {
      send(500, { error: String(e?.message || e).slice(0, 200) });
    }
    return;
  }

  send(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[embed] listening on http://127.0.0.1:${PORT}`);
});
