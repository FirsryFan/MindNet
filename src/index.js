/**
 * MindNet —— Node 侧统一入口：require('mindnet') 或 require('./src/index.js')
 *
 * 导出三组东西：
 *   1. 内核与机制：MechanismKernel / createKernel / loadMechanisms / memoryDsr（v2 路线）
 *   2. v1.1 引擎：Graph / Config / CognitiveModel / apply_forgetting …（旧语义基线，保持可用）
 *   3. 工具：createRng（可播种 PRNG）
 *
 * 浏览器侧不需要本文件（各文件按 <script> 顺序自行挂到全局 MindNet 命名空间）。
 */
'use strict';

const config = require('./config.js');
const model = require('./model.js');
const memory = require('./memory.js');
const diffusion = require('./diffusion.js');
const rng = require('./core/rng.js');
const core = require('./core/kernel.js');
const registry = require('../mechanisms/index.js');
const memoryDsr = require('../mechanisms/memory.dsr.js');

/**
 * 建一个装好机制的内核。
 *
 * @param {object} graph Graph 实例
 * @param {object} [config] Config 实例
 * @param {object} [options]
 *   seed      随机种子（确定性）
 *   hours     起始现实时间（小时）
 *   overrides 参数覆盖，形如 { 'memory.dsr.kappa': 4 }
 *   mechanisms 只启用指定 id（缺省＝用 profile）
 *   profile   预置配置：'v2'（默认）/ 'memory' / 'legacy'
 */
function createKernel(graph, configInstance, options) {
  const opts = options || {};
  const kernel = new core.MechanismKernel(graph, configInstance, opts);
  const loaded = registry.loadMechanisms();
  const ids = opts.mechanisms || registry.PROFILES[opts.profile || 'v2'];
  kernel.load(registry.pickMechanisms(loaded, ids));
  return kernel;
}

/** 已注册机制的清单摘要（不建内核，仅报告） */
function listMechanisms() {
  return registry.loadMechanisms().map((x) => ({
    id: x.manifest.id,
    name: x.manifest.name,
    layer: x.manifest.layer,
    level: x.manifest.level,
    hooks: Object.keys(x.manifest.hooks),
    params: (x.manifest.params || []).length,
    file: x.file,
  }));
}

module.exports = Object.assign(
  {},
  config,
  model,
  memory,
  diffusion,
  core,
  rng,
  // v2 快层引擎也挂在统一入口上（浏览器壳按 profile 装配内核时要用到）
  require('./v2/engine.js'),
  { createKernel, listMechanisms, loadMechanisms: registry.loadMechanisms, memoryDsr }
);
