// 将 yudao 官方 PG 脚本 + member 手写 DDL 导入 Neon
// 用法: node import-schema.js <NEON_CONNECTION_STRING>
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connStr = process.argv[2];
if (!connStr) {
  console.error('用法: node import-schema.js <postgresql://...>');
  process.exit(1);
}

const files = [
  '/tmp/yudao-sql/sql/postgresql/ruoyi-vue-pro.sql',
  '/tmp/yudao-sql/sql/postgresql/quartz.sql',
  path.join(__dirname, 'member.sql'),
];

async function main() {
  const client = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await client.connect();
  for (const f of files) {
    const sql = fs.readFileSync(f, 'utf8');
    process.stdout.write(`导入 ${f} (${sql.length} 字节) ... `);
    try {
      await client.query(sql); // 简单查询协议，支持多语句
      console.log('完成');
    } catch (e) {
      console.log('失败');
      console.error(e.message);
      process.exit(1);
    }
  }
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`
  );
  console.log(`public schema 共 ${rows[0].n} 张表`);
  await client.end();
}
main();
