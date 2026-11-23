/**
 * DsmlStreamFilter 单元测试：模拟 DeepSeek 综合轮 DSML 泄漏的各种形态。
 * 运行: npx tsx scripts/kb/dsml-filter.test.ts
 */
import { strict as assert } from 'node:assert';
import { DsmlStreamFilter } from '../../lib/kb/agent';

/** 把字符串按 n 字一片切开模拟流式 chunk */
function feedAll(f: DsmlStreamFilter, s: string, n: number): string {
  let out = '';
  for (let i = 0; i < s.length; i += n) out += f.feed(s.slice(i, i + n));
  return out + f.end();
}

// 1. 纯正文透传
{
  const f = new DsmlStreamFilter();
  const r = feedAll(f, '失眠要从心脏论治，黄连阿胶汤主之 [1]。', 5);
  assert.equal(r, '失眠要从心脏论治，黄连阿胶汤主之 [1]。');
  assert.equal(f.stripped, 0);
}

// 2. 半角 DSML 块整块剥离（正文在块前后）
{
  const f = new DsmlStreamFilter();
  const leaked =
    '好的，我再检索一下。\n<|DSML|function_calls> <|DSML|invoke name="search_course_segments">' +
    '<|DSML|parameter name="query">心肾不交 失眠</|DSML|parameter> </|DSML|invoke> </|DSML|function_calls>' +
    '\n心肾不交的治法是黄连阿胶汤 [2]。';
  const r = feedAll(f, leaked, 7);
  assert.ok(!r.includes('DSML') && !r.includes('invoke') && !r.includes('心肾不交 失眠'), '工具语法应被剥离');
  assert.ok(r.includes('好的，我再检索一下'), '块前正文保留');
  assert.ok(r.includes('心肾不交的治法是黄连阿胶汤'), '块后正文保留');
  assert.deepEqual(f.queries, ['心肾不交 失眠']);
  assert.ok(f.stripped >= 1);
}

// 3. 全角 ｜ 变体 + 跨 chunk 极端切分（逐字流）
{
  const f = new DsmlStreamFilter();
  const leaked =
    '<｜DSML｜function_calls><｜DSML｜invoke name="search_course_segments">' +
    '<｜DSML｜parameter name="query">手脚冰凉 当归四逆汤</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>';
  const r = feedAll(f, leaked, 1);
  assert.equal(r.replace(/\s/g, ''), '');
  assert.deepEqual(f.queries, ['手脚冰凉 当归四逆汤']);
}

// 4. 块未闭合（流中断）→ 全部丢弃，不吐语法
{
  const f = new DsmlStreamFilter();
  const r = feedAll(f, '<|DSML|function_calls> <|DSML|parameter name="query">失眠<', 4);
  assert.ok(!r.includes('DSML'));
}

// 5. 正文中途出现泄漏块且正文已部分流出 → 已流出部分保留
{
  const f = new DsmlStreamFilter();
  let out = '';
  out += f.feed('黄连阿胶汤治心血不足之失眠');
  out += f.feed('<|DSML|invoke name="search_course_segments"><|DSML|parameter name="query">黄连');
  out += f.feed('阿胶汤</|DSML|parameter></|DSML|invoke>');
  out += f.feed('，不用蛋黄不行 [3]。');
  out += f.end();
  assert.ok(out.startsWith('黄连阿胶汤治心血不足之失眠'));
  assert.ok(out.endsWith('，不用蛋黄不行 [3]。'));
  assert.deepEqual(f.queries, ['黄连阿胶汤']);
}

// 6. 特殊 token 风格（tool_calls begin/end）
{
  const f = new DsmlStreamFilter();
  const leaked = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_course_segments\n```json\n{"query":"失眠"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>回答正文';
  const r = feedAll(f, leaked, 6);
  assert.ok(!r.includes('tool▁calls') && !r.includes('search_course_segments'), '特殊 token 风格应被剥离');
  assert.ok(r.includes('回答正文'));
}

console.log('✅ dsml-filter.test: 6 组用例全部通过');
