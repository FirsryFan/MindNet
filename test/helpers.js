'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mindnet = require('../src/index.js');

/** 固定「当前现实时间」，让涉及时间的测试可复现 */
const NOW = 1000;

/**
 * 测试用临时目录：放在组件自己的 .tmp/ 里，
 * 不使用系统 TEMP（C 盘），避免在任何系统盘留下残留。
 */
const TMP_DIR = path.join(__dirname, '..', '.tmp');

function tmpPath(name) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return path.join(TMP_DIR, name);
}

function cleanupTmp() {
  // 只删除「空目录」，绝不递归删除：
  // node:test 会并行跑多个测试文件，递归删除可能删掉另一个进程正在写的文件。
  try {
    fs.rmdirSync(TMP_DIR);
  } catch (ignored) {
    /* 目录里还有别的进程的文件时忽略（下一次运行会复用同一个目录） */
  }
}

/**
 * 构造测试图。
 * @param {Array} nodes  形如 ['A', {ms: 1.0}] 或 [{id:'A', ms:1.0}]
 * @param {Array} edges  形如 ['A', 'B', 0.8]
 */
function makeGraph(nodes, edges, current_real_time) {
  const ns = (nodes || []).map((n) => {
    if (Array.isArray(n)) {
      return Object.assign({ id: n[0], name: n[0], type: 'knowledge' }, n[1] || {});
    }
    return Object.assign({ name: n.id, type: 'knowledge' }, n);
  });
  const es = (edges || []).map((e, i) => ({
    id: `edge_${i + 1}`,
    from: e[0],
    to: e[1],
    ls: e.length > 2 ? e[2] : 0.8,
  }));
  return mindnet.Graph.from_object(
    { nodes: ns, edges: es },
    current_real_time === undefined ? NOW : current_real_time
  );
}

function close(actual, expected, eps) {
  const tolerance = eps === undefined ? 1e-9 : eps;
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`期望 ${expected}，实际 ${actual}（容差 ${tolerance}）`);
  }
}

module.exports = { mindnet, NOW, makeGraph, close, tmpPath, cleanupTmp, TMP_DIR };
