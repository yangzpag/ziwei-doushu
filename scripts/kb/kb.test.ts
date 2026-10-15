/**
 * 知识库段落检索 · 纯函数单测（无网络/DB 依赖）。
 * 覆盖：标题命中规则（数字边界）、时间格式化、B 站链接、段长统计。
 */
import assert from 'node:assert/strict';
import { titleNamedInQuery } from '../../lib/kb/search';
import { courseName, formatSeconds, jumpUrl } from '../../lib/kb/courses';

// 标题命中：问题点名段落主题
assert.equal(titleNamedInQuery('条336', '条336讲什么'), true, '条336 应命中');
assert.equal(titleNamedInQuery('半夏', '半夏止恶心配什么药'), true, '半夏 应命中');
assert.equal(titleNamedInQuery('条117', '条117和条1的区别'), true, '条117 应命中');
assert.equal(titleNamedInQuery('条1', '条117和条1的区别'), true, '条1 独立出现也应命中');
assert.equal(titleNamedInQuery('条1', '条117讲什么'), false, '数字边界：条1 不得命中条117');
assert.equal(titleNamedInQuery('条11', '条110讲什么'), false, '数字边界：条11 不得命中条110');
assert.equal(titleNamedInQuery('大黄', '麻黄汤和大黄'), true);
assert.equal(titleNamedInQuery('命', '命门'), false, '单字标题不参与命中');
console.log('✓ 标题命中规则（含数字边界）');

// 时间格式化（起始 floor / 结束 round，与规格示例一致）
assert.equal(formatSeconds(7), '0:07');
assert.equal(formatSeconds(125.3), '2:05');
assert.equal(formatSeconds(196.8, 'round'), '3:17');
assert.equal(formatSeconds(3661), '1:01:01');
assert.equal(formatSeconds(0), '0:00');
console.log('✓ 秒数格式化');

// B 站跳转链接（程序生成）
assert.equal(jumpUrl('BV1Tr8czuEws', 125.3), 'https://www.bilibili.com/video/BV1Tr8czuEws?t=125');
assert.equal(jumpUrl('BV1Tr8czuEws', 7), 'https://www.bilibili.com/video/BV1Tr8czuEws?t=7');
assert.equal(jumpUrl('', 7), '', '无 BV 号返回空');
console.log('✓ B 站跳转链接');

// 课程名映射
assert.equal(courseName('03-bencao'), '神农本草经');
assert.equal(courseName('unknown'), 'unknown');
console.log('✓ 课程名映射');

console.log('\n知识库段落检索单测全部通过');
