/**
 * MindNet —— 认知模型引擎 v1.1
 * Node 侧统一入口：require('mindnet') 或 require('./src/index.js')
 * 浏览器侧不需要本文件（各文件按 <script> 顺序自行挂到全局 MindNet 命名空间）。
 */
'use strict';

const config = require('./config.js');
const model = require('./model.js');
const memory = require('./memory.js');
const diffusion = require('./diffusion.js');

module.exports = Object.assign({}, config, model, memory, diffusion);
