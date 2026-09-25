/**
 * MindNet 可视化壳 · 「反馈」面板
 *
 * 这是把 docs/FEEDBACK.md 那套数学真正交给使用者的地方：
 *   你做完一道题 → 点「答对了 / 答错了」→ 模型立刻改这条线索的稳定度 S，
 *   并告诉你下一个复习时间变成了什么时候。
 *
 * 它只做三件事（其余都交给 src/feedback.js，不在这里重算数学）：
 *   1. 把「这条线索 / 隔了多久 / 对还是错」翻译成 FeedbackLog.record(...)；
 *   2. 把账本里的修正写回图（写回后引擎的排程/曲线立刻用新 S）；
 *   3. 把结果讲成人话，包括"这些证据到底能把 S 定多准"的诚实刻度。
 *
 * 独立文件的原因：主壳 app.js 已经很大，而且这个面板与扩散/控制层没有耦合，
 * 只需要外面给它 4 个回调（当前图 / 当前选中 / 当前时间 / 写回后重绘）。
 */
(function () {
  'use strict';

  const FB = globalThis.MindNet && globalThis.MindNet.feedback;
  const memoryDsr = globalThis.MindNet && globalThis.MindNet.memoryDsr;
  const STORE_KEY = 'mindnet.feedback.v1';
  const OVERRIDE_KEY = 'mindnet.overrides';
  const $ = (id) => document.getElementById(id);

  const el = {};
  let ctx = null;
  let log = null;
  let lastBefore = null;

  function fmt(x, n) {
    if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
    return Number(x).toFixed(n === undefined ? 2 : n);
  }

  function hoursToHuman(h) {
    const v = Number(h);
    if (!Number.isFinite(v)) return '—';
    if (v < 1) return `${Math.round(v * 60)} 分钟`;
    if (v < 48) return `${v.toFixed(1)} 小时`;
    return `${(v / 24).toFixed(1)} 天`;
  }

  function targetRetention() {
    try {
      const raw = globalThis.localStorage && localStorage.getItem(OVERRIDE_KEY);
      const o = raw ? JSON.parse(raw) : null;
      const t = o && Number(o['calibration.target_retention']);
      if (Number.isFinite(t) && t > 0 && t < 1) return t;
    } catch (err) { /* 忽略：用默认 */ }
    return 0.85;
  }

  function load() {
    try {
      const raw = globalThis.localStorage && localStorage.getItem(STORE_KEY);
      if (!raw) return new FB.FeedbackLog();
      return FB.FeedbackLog.fromJSON(JSON.parse(raw));
    } catch (err) {
      return new FB.FeedbackLog();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(log.toJSON()));
    } catch (err) { /* file:// 或隐私模式：本次会话仍然可用 */ }
  }

  /** 图里新出现的节点补进账本（起点 = 它现在的记忆状态） */
  function harvestMissing() {
    const graph = ctx.getGraph();
    if (!graph) return 0;
    const tmp = new FB.FeedbackLog();
    tmp.harvest(graph);
    let added = 0;
    for (const [id, ledger] of Object.entries(tmp.nodes)) {
      if (!log.nodes[id]) {
        log.nodes[id] = ledger;
        added += 1;
      }
    }
    return added;
  }

  function ledgerOf(id) {
    return log && id ? log.nodes[id] : null;
  }

  /** 从账本造一个桩节点，用来问模型"下次该什么时候复习" */
  function stubFromLedger(id, ledger) {
    const now = ctx.getNow();
    return {
      id,
      ms: ledger.R0,
      weight: 1,
      last_review_time: now,
      m: {
        memory_dsr: {
          R0: ledger.R0, S: ledger.S, Sigma: ledger.R0, D: ledger.D, N: 0, F: 0,
          lastFail: null, lastReview: now, history: [], initializedAt: now,
        },
      },
    };
  }

  /** 现在这条线索的预测留存（用账本里的 S） */
  function predictedNow(ledger, gapHours) {
    return FB.predictedRetrievability(ledger.S, ledger.R0, gapHours);
  }

  function nextInterval(id, ledger) {
    if (!memoryDsr || typeof memoryDsr.scheduleInterval !== 'function') return null;
    const target = targetRetention();
    const node = stubFromLedger(id, ledger);
    try {
      return { target, hours: memoryDsr.scheduleInterval(node, ctx.getNow(), target, { decay_model: 'power' }) };
    } catch (err) {
      return { target, hours: null, error: err.message };
    }
  }

  // ------------------------------------------------------------------ 渲染

  function renderRows(id, ledger, before) {
    const body = el.delta;
    body.textContent = '';
    const now = ctx.getNow();
    const next = nextInterval(id, ledger);
    const rows = [
      ['稳定度 S（小时）', before === null ? ledger.origin.S : before, ledger.S, (v) => fmt(v, 1)],
      ['难度 D（1–10）', before === null ? ledger.origin.D : before.d, ledger.D, (v) => fmt(v, 2)],
      [`下一次复习（目标留存 ${fmt(next && next.target, 2)}）`, null, next && next.hours, (v) => (v ? hoursToHuman(v) : '—')],
    ];
    for (const [label, b, a, f] of rows) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = label;
      const td2 = document.createElement('td');
      td2.textContent = b === null || b === undefined ? '—' : f(b);
      const td3 = document.createElement('td');
      td3.textContent = a === null || a === undefined ? '—' : f(a);
      if (b !== null && b !== undefined && a !== null && a !== undefined && a !== b) {
        td3.className = a > b ? 'up' : 'down';
      }
      tr.append(td1, td2, td3);
      body.appendChild(tr);
    }
    // 目标留存够不到编码上限 R0 时，排程公式会返回 0 —— 说清楚原因，别让人以为坏了
    if (next && next.hours === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 3;
      td.className = 'hint';
      td.textContent = `目标留存 ${fmt(next.target, 2)} 已经高过这条线索的编码上限 R0 = ${fmt(ledger.R0, 2)}，`
        + '曲线永远够不到 ⇒ 间隔为 0。要么多提取几次把 R0 顶上去，要么把目标降到 R0 以下（标定页第 6 项）。';
      tr.appendChild(td);
      body.appendChild(tr);
    }
    el.nextAt.textContent = next && next.hours
      ? `从现在（第 ${fmt(now, 1)} 小时）起 ${hoursToHuman(next.hours)} 后复习，约在第 ${fmt(now + next.hours, 1)} 小时`
      : '';
  }

  function renderLog() {
    const body = el.logBody;
    body.textContent = '';
    const events = log.events.slice(-8).reverse();
    for (const ev of events) {
      const tr = document.createElement('tr');
      const cells = [
        ev.at === null || ev.at === undefined ? '—' : (ctx.humanTime ? ctx.humanTime(ev.at) : String(ev.at)),
        ev.node,
        `隔 ${hoursToHuman(ev.tHours)}`,
        `${ev.correct ? '对' : '错'} · ${ev.delta_ratio >= 1 ? '+' : ''}${fmt((ev.delta_ratio - 1) * 100, 1)}% → S ${fmt(ev.S, 1)}h`,
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      tr.addEventListener('click', () => select(ev.node));
      body.appendChild(tr);
    }
    el.count.textContent = String(log.events.length);
    const rep = log.report();
    el.accuracy.textContent = rep.events
      ? `共 ${rep.events} 条证据，正确率 ${fmt(rep.accuracy * 100, 0)}%；`
        + `S 的误差下界约 ±${fmt(rep.se_best_pct, 0)}%（最好情况，证据越多越小 —— 1 道题只有 1 bit 信息）`
      : '还没有记录。做一道题就点一下，模型会自己往你身上靠。';
    const sug = rep.suggestion;
    el.k.textContent = sug && sug.samples >= 3
      ? `新节点初始 k 建议 ${fmt(sug.legacy_k, 1)} 小时（默认 24，基于 ${sug.samples} 个节点）`
      : `样本还不够（${sug ? sug.samples : 0}/3），新节点继续用默认 k = 24 小时`;
  }

  function render() {
    if (!FB) {
      el.out.textContent = '反馈模块未加载：请确认 ../src/feedback.js 路径正确。';
      return;
    }
    const id = ctx.getSelected();
    const ledger = ledgerOf(id);
    if (!id || !ledger) {
      el.node.textContent = '未选中';
      el.node.className = 'pill wait';
      el.out.textContent = '先在左边点一个节点（或在节点表里选一行），再记这道题的结果。';
      el.delta.textContent = '';
      el.nextAt.textContent = '';
      el.yes.disabled = true;
      el.no.disabled = true;
      renderLog();
      return;
    }
    el.yes.disabled = false;
    el.no.disabled = false;
    el.node.textContent = id;
    el.node.className = 'pill ok';
    const gap = Number(el.gap.value);
    const p = predictedNow(ledger, Number.isFinite(gap) ? gap : 0);
    el.out.textContent = `R0 = ${fmt(ledger.R0, 2)}，S = ${fmt(ledger.S, 1)} 小时`
      + `${ledger.count ? `，已收 ${ledger.count} 条证据（对 ${ledger.correct}）` : '，还没有证据'}`
      + `。按这个估计，隔 ${fmt(gap, 1)} 小时后能想起来的概率 p ≈ ${fmt(p * 100, 0)}%。`;
    renderRows(id, ledger, lastBefore && lastBefore.id === id ? lastBefore : null);
    renderLog();
  }

  // ------------------------------------------------------------------ 行为

  function select(id) {
    if (!ctx) return;
    ctx.select(id);
  }

  function onSelect() {
    // 选中变化时把「距上次复习」默认填成 现在 − 上次复习
    const id = ctx.getSelected();
    const graph = ctx.getGraph();
    if (id && graph && graph.get_node(id)) {
      const node = graph.get_node(id);
      const bag = node.m && node.m.memory_dsr;
      const last = bag ? bag.lastReview : node.last_review_time;
      if (Number.isFinite(last)) {
        const gap = Math.max(0, ctx.getNow() - last);
        el.gap.value = String(Math.round(gap * 100) / 100);
      }
    }
    lastBefore = null;
    render();
  }

  function record(correct) {
    const id = ctx.getSelected();
    const ledger = ledgerOf(id);
    if (!id || !ledger) return;
    const tHours = Math.max(0, Number(el.gap.value) || 0);
    const before = { id, S: ledger.S, d: ledger.D };
    let rec;
    try {
      rec = log.record({ node: id, tHours, correct, at: Date.now() });
    } catch (err) {
      el.out.textContent = `记录失败：${err.message}`;
      return;
    }
    lastBefore = before;
    save();
    let applied = 0;
    if (el.auto.checked) applied = log.applyToGraph(ctx.getGraph());
    if (applied && ctx.onApplied) ctx.onApplied();
    el.out.textContent = `模型考前预测 p = ${fmt(rec.R_at_test * 100, 0)}% ⇒ ${correct ? '答对' : '答错'}：`
      + `S ${fmt(before.S, 1)} → ${fmt(rec.S, 1)} 小时（${rec.delta_ratio >= 1 ? '+' : ''}${fmt((rec.delta_ratio - 1) * 100, 1)}%，`
      + `信息量权重 ${fmt(rec.weight, 2)}、本次增益 ${fmt(rec.gain, 3)}）`
      + (applied ? '，已写回图。' : '；勾上「自动写回」或点「写回图」才会影响引擎排程。');
    render();
  }

  function undo() {
    if (!log.events.length) {
      el.out.textContent = '没有可撤销的记录。';
      return;
    }
    const gone = log.events.pop();
    const fresh = log.replay();
    log.nodes = fresh.nodes;
    log.events = fresh.events;
    lastBefore = null;
    save();
    if (el.auto.checked && log.applyToGraph(ctx.getGraph()) && ctx.onApplied) ctx.onApplied();
    el.out.textContent = `已撤销最后一条（${gone.node} · ${gone.correct ? '对' : '错'}），账本回放到撤销后的状态。`;
    render();
  }

  function applyAll() {
    const n = log.applyToGraph(ctx.getGraph());
    if (n && ctx.onApplied) ctx.onApplied();
    el.out.textContent = `已把 ${n} 个节点的修正写回图 —— 引擎的排程、遗忘曲线、控制层诊断都会用新的 S。`;
    render();
  }

  function reset() {
    if (!globalThis.confirm('清空所有反馈记录？（标定参数不受影响）')) return;
    log = new FB.FeedbackLog();
    harvestMissing();
    save();
    lastBefore = null;
    el.out.textContent = '反馈记录已清空，账本起点重新取自当前图。';
    render();
  }

  // -------------------------------------------------------------------- API

  function init(options) {
    ctx = options;
    el.node = $('fb-node');
    el.gap = $('fb-gap');
    el.yes = $('fb-yes');
    el.no = $('fb-no');
    el.undo = $('fb-undo');
    el.apply = $('fb-apply');
    el.auto = $('fb-auto');
    el.reset = $('fb-reset');
    el.out = $('fb-out');
    el.delta = $('fb-delta');
    el.nextAt = $('fb-next-at');
    el.logBody = $('fb-log');
    el.count = $('fb-count');
    el.accuracy = $('fb-accuracy');
    el.k = $('fb-k');
    if (!FB || !el.node || !el.logBody) {
      if (el.out) el.out.textContent = '反馈模块未加载：请确认 ../src/feedback.js 路径正确。';
      return null;
    }
    log = load();
    harvestMissing();
    save();
    el.yes.addEventListener('click', () => record(true));
    el.no.addEventListener('click', () => record(false));
    el.undo.addEventListener('click', undo);
    el.apply.addEventListener('click', applyAll);
    el.reset.addEventListener('click', reset);
    el.gap.addEventListener('change', render);
    render();
    return api;
  }

  const api = {
    init,
    refresh: render,
    onSelect,
    /** 图变了（载入样例/JSON）之后调用：补账本 + 重绘 */
    onGraphChanged() {
      if (!FB || !log) return 0;
      const added = harvestMissing();
      save();
      render();
      return added;
    },
    /** 供自检使用：当前账本的只读快照 */
    snapshot() {
      return log ? log.toJSON() : null;
    },
    record,
  };

  globalThis.MindNetVizFeedback = api;
})();
