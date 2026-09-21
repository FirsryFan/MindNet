/**
 * MindNet v2 内核 —— 可播种伪随机数发生器
 *
 * 为什么要自己带一个：内核不变量 I1 要求「同一 seed + 同一输入 ⇒ 同一输出」，
 * 所以模块一律不许用 Math.random（工具会静态扫描并把违规模块拒绝加载）。
 * 算法：mulberry32（32 位状态，周期 2^32，统计质量足够做模型模拟，零依赖）。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;

  /**
   * @param {number} seed 任意整数
   * @returns {() => number} 返回 [0,1) 上的伪随机数
   */
  function createRng(seed) {
    let s = (Number(seed) || 0) >>> 0;
    return function rng() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const api = { createRng };

  if (isNode) {
    module.exports = api;
  } else {
    globalThis.MindNet = Object.assign(globalThis.MindNet || {}, api);
  }
})();
