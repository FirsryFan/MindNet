/**
 * MindNet —— 认知模型引擎 v1.1
 * 时间与记忆机制（对应设计文档 §4）
 *
 * 时间单位统一为「小时」。扩散内时间不用 Tick，只有更新轮次；现实时间只用于 MS 衰减。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('./config.js'))
    : (globalThis.MindNet || {});
  const { NotImplementedError, MindNetError, now_hours } = deps;

  const MS_EPS = 1e-9;

  /**
   * 遗忘曲线（§4.2）：
   *   MS(t) = MS0 * exp(-t / S)，  S = k * MS0
   * ms0 <= 0 → 0；ms0 > 0 时按公式；ms0 触底后不再变负。
   */
  function apply_forgetting(ms0, t, config) {
    const k = config.forgetting_k;
    if (ms0 <= 0) return 0.0;
    if (t <= 0) return ms0;
    const S = k * ms0;
    if (S <= MS_EPS) return 0.0;
    return ms0 * Math.exp(-t / S);
  }

  /**
   * 软件打开时的全局记忆更新（§4.2）：
   * 只有距离上次复习超过 forget_update_threshold_hours 的节点才衰减，并刷新 last_review_time。
   * 未超阈值的节点保持原样（包括 last_review_time），与文档伪码一致。
   */
  function update_global_memory(graph, config, current_real_time) {
    const now = current_real_time === undefined || current_real_time === null
      ? now_hours()
      : current_real_time;
    const updated = [];
    const touched_missing = [];
    for (const node of graph.nodes.values()) {
      if (node.last_review_time === null || node.last_review_time === undefined || node.last_review_time === 0) {
        node.last_review_time = now;
        touched_missing.push(node.id);
        continue;
      }
      const t = now - node.last_review_time;
      if (t > config.forget_update_threshold_hours) {
        const ms0 = node.ms;
        node.ms = ms0 <= 0 ? 0.0 : apply_forgetting(ms0, t, config);
        node.last_review_time = now;
        updated.push({ id: node.id, ms_before: ms0, ms_after: node.ms, elapsed_hours: t });
      }
    }
    return { current_real_time: now, updated, filled_missing: touched_missing };
  }

  /** 专注复习（§4.3）：ms 拉满，衰减从当前时间重新开始 */
  function focused_review(node, current_real_time) {
    const now = current_real_time === undefined || current_real_time === null
      ? now_hours()
      : current_real_time;
    node.ms = 1.0;
    node.last_review_time = now;
    return node;
  }

  /** 过程访问复习（§4.4）：本版不实现，只保留接口位置 */
  function process_visit_review() {
    throw new NotImplementedError('过程访问复习（process_visit_review）在 v1.1 未实现，见设计文档 §4.4');
  }

  /** 按 review_type 分发；未知类型报错，不静默忽略 */
  function update_memory(graph, node_id, options) {
    const opts = options || {};
    const review_type = opts.review_type === undefined ? 'focused' : opts.review_type;
    const node = graph.get_node(node_id);
    if (!node) {
      throw new MindNetError(`节点 "${node_id}" 不存在于图中`);
    }
    if (review_type === 'focused') {
      return focused_review(node, opts.current_real_time);
    }
    if (review_type === 'process') {
      return process_visit_review(node, opts.current_real_time);
    }
    throw new MindNetError(`未知的 review_type "${review_type}"（可用：focused / process）`);
  }

  const api = { apply_forgetting, update_global_memory, focused_review, process_visit_review, update_memory };

  if (isNode) {
    module.exports = api;
  } else {
    globalThis.MindNet = Object.assign(globalThis.MindNet || {}, api);
  }
})();
