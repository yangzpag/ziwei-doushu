/** 流时干支标签回归：label 必须是真实时辰支（时钟），而非流日叠加后的宫位支。 */
import assert from 'node:assert/strict';
import { generateChart } from '../../lib/ziwei/algorithm';
import { computeLayers } from '../../lib/ziwei/layers';
import { BRANCHES } from '../../lib/ziwei/constants';

// 选取生时支与当前时辰支不同、且流日宫 ≠ 命宫锚点的组合：
// 1990-05-09 巳时生人，查看日期取 14:00（未时）——若实现误用宫位支，
// 标签会随流日宫偏移而非落在「未」。
const chart = generateChart({ year: 1990, month: 5, day: 9, hour: 9, gender: 'male', longitude: 120 });
const layers = computeLayers(chart, new Date(2026, 5, 15, 14, 0));

const liushi = layers.liushi;
const hourBranch = BRANCHES[Math.floor((14 + 1) / 2) % 12]; // 未

assert.ok(
  liushi.ganzhi.endsWith(hourBranch),
  `流时干支标签应以当前时辰支「${hourBranch}」结尾，实际为「${liushi.ganzhi}」——` +
    '实现误用了宫位支（流日宫叠加偏移）而非时钟时辰支',
);

// 锚点（流日宫）允许 ≠ 时辰支：anchorBranch 是"在哪个宫起运"，ganzhi 是"哪个时辰"
assert.notEqual(
  liushi.anchorBranch,
  undefined,
  'anchorBranch 必须存在（表示流时运进入的宫位）',
);

console.log('liushi-ganzhi-label.test.ts ✓ 流时标签 = 真实时辰支，锚点独立于标签');
