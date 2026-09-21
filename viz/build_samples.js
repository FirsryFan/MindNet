#!/usr/bin/env node
/**
 * 把 example/*.json 编译成 viz/sample_graph.js。
 *
 * 为什么需要这一步：可视化壳要能直接双击打开（file:// 协议下浏览器禁止 fetch 本地文件），
 * 所以示例数据必须以 <script> 形式提供。生成脚本保证示例数据只有 example/*.json 一个来源，
 * 不会出现「文档里的示例」和「壳里的示例」不一致。
 *
 * 用法：node viz/build_samples.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EXAMPLE_DIR = path.join(__dirname, '..', 'example');
const OUT = path.join(__dirname, 'sample_graph.js');

const files = fs
  .readdirSync(EXAMPLE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

const samples = {};
for (const file of files) {
  const key = path.basename(file, '.json');
  samples[key] = JSON.parse(fs.readFileSync(path.join(EXAMPLE_DIR, file), 'utf8'));
}

const banner = `/**
 * 本文件由 viz/build_samples.js 自动生成，请勿手改。
 * 数据来源：mindnet/example/*.json —— 生成时间 ${new Date().toISOString()}
 */
`;
const body = `(function () {
  'use strict';
  const samples = ${JSON.stringify(samples, null, 2)};
  if (typeof module !== 'undefined' && module.exports) module.exports = samples;
  else globalThis.MindNetSamples = samples;
})();
`;

fs.writeFileSync(OUT, banner + body, 'utf8');
process.stdout.write(`已生成 ${OUT}（${files.length} 个示例：${files.join(', ')}）\n`);
