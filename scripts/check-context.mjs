import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 检查文档入口与关键引用是否存在。
 * 只做存在性/必填字段检查，不评价文档内容质量。
 * 运行：node scripts/check-context.mjs
 */
const root = resolve(import.meta.dirname, '..');
const problems = [];

function mustExist(relative) {
  const full = resolve(root, relative);
  if (!existsSync(full)) problems.push(`缺少文件：${relative}`);
  return full;
}

const required = [
  'AGENTS.md',
  'README.md',
  'docs/README.md',
  'docs/project.md',
  'docs/tasks.md',
  'docs/product.md',
  'docs/character.md',
  'docs/development.md',
  'docs/references.md',
  'docs/architecture/overview.md',
  'characters/dafeiyu/profile.json',
  'characters/dafeiyu/system.md',
  'packages/contracts/src/index.ts',
  '.agents/skills/project-handoff/SKILL.md',
  '.agents/skills/add-capability/SKILL.md',
];

for (const file of required) mustExist(file);

// AGENTS.md 必须指向 project.md 与 tasks.md
const agents = readFileSync(resolve(root, 'AGENTS.md'), 'utf8');
for (const target of ['docs/project.md', 'docs/tasks.md', 'docs/README.md']) {
  if (!agents.includes(target)) problems.push(`AGENTS.md 未指向 ${target}`);
}

// 角色配置必填字段
const profile = JSON.parse(readFileSync(resolve(root, 'characters/dafeiyu/profile.json'), 'utf8'));
if (profile.name !== '大肥鱼') problems.push('角色名必须固定为“大肥鱼”');
if (typeof profile.version !== 'string') problems.push('profile.json 缺少 version');

// 契约必须导出核心 schema
const contracts = readFileSync(resolve(root, 'packages/contracts/src/index.ts'), 'utf8');
for (const file of [
  './events.js',
  './model.js',
  './programs.js',
  './souvenirs.js',
  './stage.js',
  './tools.js',
]) {
  if (!contracts.includes(file)) problems.push(`contracts 未导出 ${file}`);
}

// skills 必须有 name / description 元数据
for (const skill of ['.agents/skills/project-handoff/SKILL.md', '.agents/skills/add-capability/SKILL.md']) {
  const text = readFileSync(resolve(root, skill), 'utf8');
  if (!text.startsWith('---')) problems.push(`${skill} 缺少 frontmatter`);
  if (!text.includes('name:')) problems.push(`${skill} 缺少 name`);
  if (!text.includes('description:')) problems.push(`${skill} 缺少 description`);
}

// --- 边界检查：web 不得 import server / 密钥，contracts 不得 import server ---
const webSrc = resolve(root, 'apps/web/src');
const contractSrc = resolve(root, 'packages/contracts/src');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const forbidden = [
  { pattern: /@dafeiyu\/server/, reason: 'web/contracts 不得 import 服务端包' },
  { pattern: /apps\/server/, reason: 'web/contracts 不得引用服务端路径' },
  { pattern: /process\.env/, reason: 'web/contracts 不得读取服务端环境变量' },
  { pattern: /HS_GW_API_KEY|STAGE_TOKEN|INGEST_TOKEN|STUDIO_TOKEN/, reason: '前端不得出现服务端令牌名' },
  { pattern: /dev-only-/, reason: '前端不得内置开发令牌字面量' },
];

for (const file of [...walk(webSrc), ...walk(contractSrc)]) {
  const text = readFileSync(file, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) {
      problems.push(`${file.slice(root.length + 1)}: ${rule.reason}（命中 ${rule.pattern}）`);
    }
  }
}

if (problems.length > 0) {
  console.error('文档检查失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `文档与边界检查通过：${required.length} 个入口文件、角色配置、契约导出、skills 元数据、web/contracts 无服务端依赖。`,
);
