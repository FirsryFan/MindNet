#!/usr/bin/env node
/**
 * 把机制注册表编译成浏览器可用的清单：viz/mechanism_manifest.js
 *
 * 为什么需要：mechanisms/index.js 用 fs 扫描目录，浏览器里没有 fs。
 * 这个脚本在 Node 侧读一遍注册表，并**核对**每个模块挂到全局的名字，
 * 生成 { profiles, globals }，壳就能按 profile 装配内核。
 *
 * 用法：node viz/build_mechanisms.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadMechanisms, PROFILES } = require('../mechanisms/index.js');

/** id → 浏览器全局名（与各模块文件里的挂载名一致，并由源码核对） */
function globalNameOf(id) {
  const parts = id.split(/[._]/);
  return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

const dir = path.join(__dirname, '..', 'mechanisms');
const loaded = loadMechanisms();
const globals = {};
const files = {};
const problems = [];

for (const item of loaded) {
  const id = item.manifest.id;
  const name = globalNameOf(id);
  const src = fs.readFileSync(path.join(dir, item.file), 'utf8');
  if (!src.includes(`${name}: api`) && !src.includes(`${name}: api }`)) {
    problems.push(`${item.file}：源码里没有挂载到全局 "${name}"（期望形如 { ${name}: api }）`);
  }
  globals[id] = name;
  files[id] = `../mechanisms/${item.file}`;
}

if (problems.length) {
  process.stderr.write(`机制全局名核对失败：\n  ${problems.join('\n  ')}\n`);
  process.exit(1);
}

const banner = `/**
 * 本文件由 viz/build_mechanisms.js 自动生成，请勿手改。
 * 生成时间 ${new Date().toISOString()}
 */
`;
const body = `(function () {
  'use strict';
  const manifest = {
    profiles: ${JSON.stringify(PROFILES, null, 2)},
    globals: ${JSON.stringify(globals, null, 2)},
    files: ${JSON.stringify(files, null, 2)},
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
  else globalThis.MindNetMechanisms = manifest;
})();
`;

fs.writeFileSync(path.join(__dirname, 'mechanism_manifest.js'), banner + body, 'utf8');
process.stdout.write(`已生成 viz/mechanism_manifest.js（${loaded.length} 个模块，${Object.keys(PROFILES).length} 个配置档）\n`);
