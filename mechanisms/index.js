/**
 * 机制注册表（Node 侧）：扫描 mechanisms/*.js，加载并校验模块清单
 *
 * 浏览器侧不用这个文件——可视化壳将来读 viz/mechanism_manifest.js（由 tools 生成）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { validateManifest } = require('../src/core/kernel.js');

/**
 * @param {string} [dir] 机制目录，默认 mechanisms/
 * @returns {Array<{file:string, module:object, manifest:object}>}
 */
function loadMechanisms(dir) {
  const base = dir || __dirname;
  const files = fs
    .readdirSync(base)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .sort();
  const out = [];
  for (const file of files) {
    const full = path.join(base, file);
    const mod = require(full);
    if (!mod || !mod.manifest) continue; // 非机制文件（例如纯工具）跳过
    validateManifest(mod.manifest, `模块 ${file}`);
    out.push({ file, module: mod, manifest: mod.manifest });
  }
  return out;
}

/** 把已加载模块按给定 id 列表筛选（顺序按列表） */
function pickMechanisms(list, ids) {
  if (!ids || ids.length === 0) return list.map((x) => x.manifest);
  const byId = new Map(list.map((x) => [x.manifest.id, x.manifest]));
  return ids.map((id) => {
    const m = byId.get(id);
    if (!m) throw new Error(`找不到机制 "${id}"（可用：${list.map((x) => x.manifest.id).join(', ')}）`);
    return m;
  });
}

module.exports = { loadMechanisms, pickMechanisms };
