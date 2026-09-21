/**
 * MindNet —— 认知模型引擎 v1.1
 * 全局配置参数（对应设计文档 §9）
 *
 * 本文件同时支持两种运行环境，不需要打包工具：
 *   - Node（CommonJS）：require('./config.js')
 *   - 浏览器 <script src>：挂到全局 MindNet 命名空间
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;

  /** 全局默认配置（文档 §9 表格逐项对应） */
  const DEFAULT_CONFIG = Object.freeze({
    ct_default: 0.3,                        // 默认意识阈值
    st_default: 0.05,                       // 默认潜意识阈值
    state_coeff_conscious: 1.0,             // 显意识 AL
    state_coeff_subconscious: 0.3,          // 潜意识 AL
    state_coeff_inactive: 0.0,              // 未激活 AL
    max_rounds: 100,                        // 最大更新轮次
    stable_rounds: 2,                       // 连续无变化轮次判定冷却
    forgetting_k: 24.0,                     // 稳定度系数
    forget_update_threshold_hours: 1.0,     // 超过此时间才更新 MS
    gap_constant: 1.2,                      // 发展区缺口常数
  });

  const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG));

  class MindNetError extends Error {
    constructor(message) {
      super(message);
      this.name = 'MindNetError';
    }
  }

  class NotImplementedError extends Error {
    constructor(message) {
      super(message);
      this.name = 'NotImplementedError';
    }
  }

  /**
   * 配置对象。未知参数会直接报错，避免 JSON 里写错键名却被静默忽略。
   * （这是文档未规定处的实现选择，见 README「实现决定」。）
   */
  class Config {
    constructor(overrides) {
      const src = overrides || {};
      for (const key of Object.keys(src)) {
        if (!CONFIG_KEYS.includes(key)) {
          throw new MindNetError(
            `未知配置参数 "${key}"。可用参数：${CONFIG_KEYS.join(', ')}`
          );
        }
      }
      for (const key of CONFIG_KEYS) {
        this[key] = src[key] === undefined ? DEFAULT_CONFIG[key] : src[key];
      }
      Object.freeze(this);
    }

    static from_object(obj) {
      return new Config(obj);
    }

    to_object() {
      const out = {};
      for (const key of CONFIG_KEYS) out[key] = this[key];
      return out;
    }
  }

  /** 当前现实时间，单位小时（从 Unix 纪元起算的浮点小时数） */
  function now_hours() {
    return Date.now() / 3600000;
  }

  const api = { DEFAULT_CONFIG, CONFIG_KEYS, Config, MindNetError, NotImplementedError, now_hours };

  if (isNode) {
    module.exports = api;
  } else {
    globalThis.MindNet = Object.assign(globalThis.MindNet || {}, api);
  }
})();
