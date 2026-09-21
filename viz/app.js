/**
 * MindNet 可视化壳（浏览器端）
 *
 * 只依赖 ../src/*.js 里的引擎，不依赖任何前端库、不发网络请求，
 * 因此可以直接双击 index.html 打开（file:// 也能用）。
 */
(function () {
  'use strict';

  const M = globalThis.MindNet;
  const door = document.getElementById('graph-svg');

  if (!M) {
    document.body.innerHTML =
      '<p style="padding:24px;font:14px sans-serif;color:#ff6b6b">' +
      '引擎未加载：请确认 viz/index.html 里 ../src/*.js 的相对路径仍然正确。</p>';
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const R = 26;            // 节点半径
  const VIEW_W = 1000;
  const VIEW_H = 660;
  const CURVE_HOURS = 168; // 遗忘曲线横轴：7 天

  const $ = (id) => document.getElementById(id);
  const el = {
    svg: door,
    layerEdges: $('layer-edges'),
    layerNodes: $('layer-nodes'),
    badgeRound: $('badge-round'),
    badgeStop: $('badge-stop'),
    kcGap: $('kc-gap'),
    kcPenalty: $('kc-penalty'),
    infoTargets: $('info-targets'),
    infoSteps: $('info-steps'),
    infoReached: $('info-reached'),
    infoCounts: $('info-counts'),
    msg: $('msg'),
    nodeDetail: $('node-detail'),
    btnStart: $('btn-start'),
    btnStep: $('btn-step'),
    btnRun: $('btn-run'),
    btnPlay: $('btn-play'),
    btnReset: $('btn-reset'),
    btnAppend: $('btn-append'),
    btnRoleStart: $('btn-role-start'),
    btnRoleTarget: $('btn-role-target'),
    btnRoleClear: $('btn-role-clear'),
    speed: $('speed'),
    nowInput: $('now-input'),
    btnNowReset: $('btn-now-reset'),
    btnFocusReview: $('btn-focus-review'),
    hoursAgo: $('hours-ago'),
    btnSetAgo: $('btn-set-ago'),
    btnMemoryUpdate: $('btn-memory-update'),
    memoryMsg: $('memory-msg'),
    curve: $('curve-canvas'),
    curveCaption: $('curve-caption'),
    gapBody: $('gap-body'),
    deadBody: $('dead-body'),
    sampleSelect: $('sample-select'),
    btnLoadSample: $('btn-load-sample'),
    btnLoadJson: $('btn-load-json'),
    jsonInput: $('json-input'),
    btnExport: $('btn-export'),
    jsonOutput: $('json-output'),
    downloadLink: $('download-link'),
    nodeTable: $('node-table'),
  };

  const ui = {
    input: null,
    graph: null,
    model: null,
    config: new M.Config(),
    starts: new Set(),
    targets: new Set(),
    pos: new Map(),
    nodeEls: new Map(),
    edgeEls: new Map(),
    selected: null,
    playing: false,
    timer: null,
    lastActivated: new Set(),
    flashTimer: null,
    now: M.now_hours(),
    downloadUrl: null,
  };

  // ------------------------------------------------------------------ 工具

  function setMsg(text, isError) {
    el.msg.textContent = text || '';
    el.msg.className = isError ? 'msg error' : 'msg';
  }

  function stopText(reason) {
    if (reason === 'all_targets_reached') return '所有目标已激活';
    if (reason === 'cooling') return '思维冷却（连续两轮无变化）';
    if (reason === 'max_rounds') return '达到最大轮次';
    if (!reason) return '未开始';
    return String(reason);
  }

  function stateClass(state) {
    return `state-${state}`;
  }

  function short(text, n) {
    const s = String(text);
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  function clientToSvg(ev) {
    const ctm = el.svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    return node;
  }

  // -------------------------------------------------------------- 载入与布局

  function circularLayout(graph) {
    const ids = graph.node_ids().slice().sort();
    const pos = new Map();
    const n = ids.length;
    if (n === 0) return pos;
    if (n === 1) {
      pos.set(ids[0], { x: VIEW_W / 2, y: VIEW_H / 2 });
      return pos;
    }
    const radius = Math.min(280, 110 + n * 16);
    ids.forEach((id, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      pos.set(id, {
        x: VIEW_W / 2 + Math.cos(angle) * radius,
        y: VIEW_H / 2 + Math.sin(angle) * radius * 0.86,
      });
    });
    return pos;
  }

  function loadInput(input) {
    stopPlaying();
    let graph;
    try {
      graph = M.Graph.load_from_json(input, ui.now);
    } catch (err) {
      setMsg(`载入失败：${err.message}`, true);
      return false;
    }
    ui.input = input;
    ui.graph = graph;
    ui.model = new M.CognitiveModel(graph, ui.config);
    ui.starts = new Set(Array.isArray(input.initial_nodes) ? input.initial_nodes : []);
    ui.targets = new Set(Array.isArray(input.target_nodes) ? input.target_nodes : []);
    ui.pos = circularLayout(graph);
    ui.selected = null;
    ui.lastActivated = new Set();
    el.jsonInput.value = JSON.stringify(input, null, 2);
    buildScene();
    updateAll();
    setMsg(`已载入：${graph.size} 个节点 / ${graph.edges.length} 条边`);
    return true;
  }

  function buildScene() {
    el.layerEdges.textContent = '';
    el.layerNodes.textContent = '';
    ui.nodeEls = new Map();
    ui.edgeEls = new Map();
    if (!ui.graph) return;

    for (const edge of ui.graph.edges) {
      const path = svgEl('path', { class: 'edge', 'marker-end': 'url(#arrow)' });
      path.style.strokeWidth = (1 + edge.ls * 4).toFixed(2);
      path.style.strokeOpacity = (0.35 + edge.ls * 0.65).toFixed(2);
      path.appendChild(svgEl('title')).textContent =
        `${edge.id}：${edge.from} → ${edge.to}　ls=${edge.ls}`;
      el.layerEdges.appendChild(path);
      ui.edgeEls.set(edge.id, path);
    }

    for (const node of ui.graph.nodes.values()) {
      const g = svgEl('g', { class: 'node', 'data-id': node.id });
      const body = svgEl('circle', { class: 'body', r: R });
      const ring = svgEl('circle', { class: 'ring', r: R + 7 });
      const label = svgEl('text', { class: 'label', y: R + 34 });
      const sub = svgEl('text', { class: 'sub', y: R + 48 });
      const inner = svgEl('text', { class: 'sub', y: 4, style: 'font-size:11px' });
      const title = svgEl('title');
      g.append(body, ring, label, sub, inner, title);
      el.layerNodes.appendChild(g);
      ui.nodeEls.set(node.id, { g, ring, label, sub, inner, title });
      attachNodeEvents(g, node);
    }
  }

  function attachNodeEvents(g, node) {
    g.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      select(node.id);
      const start = ui.pos.get(node.id) || { x: 0, y: 0 };
      const pt = clientToSvg(ev);
      const offset = { x: start.x - pt.x, y: start.y - pt.y };
      let moved = false;

      const move = (e) => {
        const p = clientToSvg(e);
        ui.pos.set(node.id, { x: p.x + offset.x, y: p.y + offset.y });
        moved = true;
        applyPositions();
      };
      const up = (e) => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
        try {
          g.releasePointerCapture(ev.pointerId);
        } catch (ignored) {
          /* 指针已被释放 */
        }
        if (moved) applyPositions();
      };
      try {
        g.setPointerCapture(ev.pointerId);
      } catch (ignored) {
        /* 某些环境下不支持捕获，仍可拖动 */
      }
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    });
  }

  function select(id) {
    ui.selected = id;
    updateScene();
    updatePanels();
  }

  // ------------------------------------------------------------------ 渲染

  function applyPositions() {
    if (!ui.graph) return;
    for (const node of ui.graph.nodes.values()) {
      const p = ui.pos.get(node.id);
      const entry = ui.nodeEls.get(node.id);
      if (!entry || !p) continue;
      entry.g.setAttribute('transform', `translate(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
    }
    for (const edge of ui.graph.edges) {
      const path = ui.edgeEls.get(edge.id);
      if (!path) continue;
      const a = ui.pos.get(edge.from);
      const b = ui.pos.get(edge.to);
      if (!a || !b) continue;
      path.setAttribute('d', edgePath(edge, a, b));
    }
  }

  function edgePath(edge, a, b) {
    if (edge.from === edge.to) {
      // 自环：画一个位于节点上方的小环，避免静默隐藏边
      const x = a.x;
      const y = a.y - R - 10;
      return `M ${x - 12} ${y + 6} C ${x - 34} ${y - 34}, ${x + 34} ${y - 34}, ${x + 12} ${y + 6}`;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    return (
      `M ${(a.x + ux * R).toFixed(2)} ${(a.y + uy * R).toFixed(2)} ` +
      `L ${(b.x - ux * (R + 5)).toFixed(2)} ${(b.y - uy * (R + 5)).toFixed(2)}`
    );
  }

  function updateScene() {
    if (!ui.graph) return;
    for (const node of ui.graph.nodes.values()) {
      const entry = ui.nodeEls.get(node.id);
      if (!entry) continue;
      const classes = ['node', stateClass(node.state)];
      if (node.id === ui.selected) classes.push('selected');
      if (ui.lastActivated.has(node.id)) classes.push('flash');
      entry.g.setAttribute('class', classes.join(' '));

      const isStart = ui.starts.has(node.id);
      const isTarget = ui.targets.has(node.id);
      entry.ring.style.display = isStart || isTarget ? '' : 'none';
      entry.ring.setAttribute('class', isStart ? 'ring start' : 'ring');

      entry.label.textContent = short(node.name, 10);
      entry.sub.textContent = `ms ${node.ms.toFixed(2)}${node.visit_count ? ` · visit ${node.visit_count}` : ''}`;
      entry.inner.textContent = short(node.id, 8);

      entry.title.textContent =
        `${node.id}（${node.name}）\n` +
        `类型 ${node.type}　状态 ${node.state}　al ${node.al}\n` +
        `ms ${node.ms}　weight ${node.weight}　visit ${node.visit_count}\n` +
        `CT ${node.ct_of(ui.config)}　ST ${node.st_of(ui.config)}` +
        `${isStart ? '\n角色：起点' : ''}${isTarget ? '\n角色：目标' : ''}`;
    }
    applyPositions();
  }

  function updatePanels() {
    const model = ui.model;
    const graph = ui.graph;
    el.badgeRound.textContent = model ? model.rounds : 0;
    el.badgeStop.textContent = model ? stopText(model.stop_reason) : '未开始';

    if (!model || !graph) {
      el.kcGap.textContent = '0';
      el.kcPenalty.textContent = '0';
      return;
    }

    const kc = model.get_kc();
    el.kcGap.textContent = kc.gap;
    el.kcPenalty.textContent = kc.penalty;

    const targets = model.running ? model.targets : Array.from(ui.targets);
    el.infoTargets.textContent = targets.length ? targets.join(', ') : '（无）';
    const steps = model.target_steps();
    const stepKeys = Object.keys(steps);
    el.infoSteps.textContent = stepKeys.length
      ? stepKeys.map((k) => `${k}=第${steps[k]}轮`).join('，')
      : '（无）';
    el.infoReached.textContent = model.targets_all_reached ? '是' : '否';

    let conscious = 0;
    let sub = 0;
    let inactive = 0;
    for (const node of graph.nodes.values()) {
      if (node.state === M.STATE.CONSCIOUS) conscious += 1;
      else if (node.state === M.STATE.SUBCONSCIOUS) sub += 1;
      else inactive += 1;
    }
    el.infoCounts.textContent = `${conscious} / ${sub} / ${inactive}`;

    renderBreakdown(model.kc_breakdown());
    renderNodeTable();
    renderNodeDetail();
    renderCurve();
  }

  function renderBreakdown(breakdown) {
    el.gapBody.textContent = '';
    if (breakdown.gap.length === 0) {
      el.gapBody.appendChild(emptyRow(5));
    }
    for (const r of breakdown.gap) {
      el.gapBody.appendChild(
        row([r.name, r.state, r.impact, (1.2 * r.ct).toFixed(3), r.contribution], r.id)
      );
    }
    el.deadBody.textContent = '';
    if (breakdown.penalty.length === 0) {
      el.deadBody.appendChild(emptyRow(4));
    }
    for (const r of breakdown.penalty) {
      el.deadBody.appendChild(row([r.name, r.weight, r.visit_count, r.contribution], r.id));
    }
  }

  function emptyRow(columns) {
    const tr = row(new Array(columns).fill(''));
    tr.firstChild.textContent = '（无）';
    tr.classList.add('empty');
    return tr;
  }

  function row(cells, id) {
    const tr = document.createElement('tr');
    if (id && id === ui.selected) tr.className = 'selected';
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    if (id) tr.addEventListener('click', () => select(id));
    return tr;
  }

  function renderNodeTable() {
    el.nodeTable.textContent = '';
    for (const node of ui.graph.nodes.values()) {
      const tr = document.createElement('tr');
      if (node.id === ui.selected) tr.className = 'selected';
      const cells = [
        node.id,
        node.name,
        node.state,
        node.al,
        node.ms.toFixed(2),
        node.weight,
        node.visit_count,
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = String(c);
        if (i === 2) td.className = stateClass(node.state);
        tr.appendChild(td);
      });
      tr.addEventListener('click', () => select(node.id));
      el.nodeTable.appendChild(tr);
    }
  }

  function renderNodeDetail() {
    el.nodeDetail.textContent = '';
    const node = ui.selected ? ui.graph.get_node(ui.selected) : null;
    if (!node) {
      addKv('—', '未选中');
    } else {
      const elapsed = node.last_review_time === null || node.last_review_time === undefined
        ? null
        : ui.now - node.last_review_time;
      addKv('id / 名称', `${node.id}　${node.name}`);
      addKv('类型', node.type);
      addKv('状态 / al', `${node.state}　/　${node.al}`);
      addKv('ms 记忆强度', `${round4(node.ms)}`);
      addKv('weight 重要性', String(node.weight));
      addKv('CT / ST', `${node.ct_of(ui.config)} / ${node.st_of(ui.config)}${node.ct === null ? '（全局默认）' : '（节点自定义）'}`);
      addKv('visit_count', String(node.visit_count));
      addKv('stm（预留）', String(node.stm));
      addKv('上次复习', node.last_review_time === null ? '（未记录）' : `距现在 ${round4(elapsed)} 小时`);
      addKv('角色', `${ui.starts.has(node.id) ? '起点 ' : ''}${ui.targets.has(node.id) ? '目标' : ''}` || '无');
    }
  }

  function addKv(key, value) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    el.nodeDetail.append(dt, dd);
  }

  function round4(x) {
    return Math.round(x * 1e4) / 1e4;
  }

  function renderCurve() {
    const ctx = el.curve.getContext('2d');
    const w = el.curve.width;
    const h = el.curve.height;
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 52, r: 12, t: 14, b: 26 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const node = ui.selected ? ui.graph.get_node(ui.selected) : null;
    const ms0 = node ? node.ms : 0.8;
    const k = ui.config.forgetting_k;
    const elapsed = node && node.last_review_time ? Math.max(0, ui.now - node.last_review_time) : null;

    ctx.strokeStyle = '#26313d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, pad.t + plotH);
    ctx.lineTo(pad.l + plotW, pad.t + plotH);
    ctx.stroke();

    const xOf = (t) => pad.l + (t / CURVE_HOURS) * plotW;
    const yOf = (ms) => pad.t + (1 - ms) * plotH;

    ctx.strokeStyle = '#3a4a5c';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, yOf(0.5));
    ctx.lineTo(pad.l + plotW, yOf(0.5));
    ctx.moveTo(xOf(24), pad.t);
    ctx.lineTo(xOf(24), pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#7fd4ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let px = 0; px <= plotW; px += 1) {
      const t = (px / plotW) * CURVE_HOURS;
      const ms = M.apply_forgetting(ms0, t, ui.config);
      const x = pad.l + px;
      const y = yOf(ms);
      if (px === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (elapsed !== null) {
      const t = Math.min(elapsed, CURVE_HOURS);
      const ms = M.apply_forgetting(ms0, elapsed, ui.config);
      ctx.fillStyle = '#ffc53d';
      ctx.beginPath();
      ctx.arc(xOf(t), yOf(ms), 4, 0, Math.PI * 2);
      ctx.fill();
      el.curveCaption.textContent =
        `选中节点 ms0=${round4(ms0)}，已过 ${round4(elapsed)} 小时 → 现在 ms=${round4(ms)}` +
        (elapsed > CURVE_HOURS ? '（点画在 7 天处）' : '');
    } else {
      el.curveCaption.textContent = `未选中节点时按 ms0=${ms0} 画曲线；k=${k}，S=k×ms0`;
    }

    ctx.fillStyle = '#8797a8';
    ctx.font = '11px sans-serif';
    ctx.fillText('ms', 6, pad.t + 4);
    ctx.fillText('1.0', 30, yOf(1) + 4);
    ctx.fillText('0.5', 30, yOf(0.5) + 4);
    ctx.fillText('0', 40, yOf(0) + 4);
    ctx.fillText('0h', pad.l - 6, h - 8);
    ctx.fillText('24h', xOf(24) - 10, h - 8);
    ctx.fillText('7天', xOf(CURVE_HOURS) - 14, h - 8);
  }

  function updateAll() {
    updateScene();
    updatePanels();
  }

  // -------------------------------------------------------------- 扩散控制

  function startDiffusion() {
    if (!ui.model) return;
    stopPlaying();
    try {
      ui.model.start_diffusion(Array.from(ui.starts), Array.from(ui.targets));
      ui.lastActivated = new Set();
      updateAll();
      if (ui.model.stopped) {
        setMsg('起点即目标：目标一开始就算达成（target_steps = 0）');
      } else {
        setMsg(`扩散已开始：起点 ${ui.starts.size} 个，目标 ${ui.targets.size} 个`);
      }
    } catch (err) {
      setMsg(`开始失败：${err.message}`, true);
    }
  }

  function doStep() {
    if (!ui.model) {
      setMsg('请先载入图数据', true);
      return;
    }
    if (!ui.model.running) {
      startDiffusion();
      if (!ui.model.running) return;
    }
    if (ui.model.stopped) {
      stopPlaying();
      setMsg(`扩散已停止（${stopText(ui.model.stop_reason)}）；点「重置」可以重跑`, true);
      return;
    }
    const status = ui.model.step();
    markActivated(status.activated);
    updateAll();
    if (status.stopped) {
      stopPlaying();
      setMsg(`扩散停止：${stopText(status.stop_reason)}`);
    }
  }

  function runAll() {
    if (!ui.model) {
      setMsg('请先载入图数据', true);
      return;
    }
    if (!ui.model.running) {
      startDiffusion();
      if (!ui.model.running) return;
    }
    let guard = 0;
    let last = [];
    while (!ui.model.stopped && guard < 100000) {
      last = ui.model.step().activated;
      guard += 1;
    }
    markActivated(last);
    stopPlaying();
    updateAll();
    setMsg(`扩散跑完：共 ${ui.model.rounds} 轮，停止原因「${stopText(ui.model.stop_reason)}」`);
  }

  function markActivated(activated) {
    ui.lastActivated = new Set((activated || []).map((a) => a.id));
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.flashTimer = setTimeout(() => {
      ui.lastActivated = new Set();
      updateScene();
    }, 700);
  }

  function togglePlay() {
    if (ui.playing) {
      stopPlaying();
      return;
    }
    if (!ui.model) {
      setMsg('请先载入图数据', true);
      return;
    }
    if (!ui.model.running) {
      startDiffusion();
      if (!ui.model.running) return;
    }
    if (ui.model.stopped) {
      setMsg('扩散已停止；点「重置」可以重跑', true);
      return;
    }
    ui.playing = true;
    el.btnPlay.textContent = '暂停';
    const delay = Number(el.speed.value) || 600;
    ui.timer = setInterval(() => {
      if (!ui.model || ui.model.stopped) {
        stopPlaying();
        setMsg(`扩散停止：${stopText(ui.model && ui.model.stop_reason)}`);
        return;
      }
      const status = ui.model.step();
      markActivated(status.activated);
      updateAll();
    }, delay);
  }

  function stopPlaying() {
    ui.playing = false;
    el.btnPlay.textContent = '自动播放';
    if (ui.timer) clearInterval(ui.timer);
    ui.timer = null;
  }

  function appendStarts() {
    if (!ui.model || !ui.model.running) {
      setMsg('请先「开始扩散」，再追加起点', true);
      return;
    }
    const applied = new Set(ui.model.starts);
    const pending = Array.from(ui.starts).filter((id) => !applied.has(id));
    if (pending.length === 0) {
      setMsg('没有新的起点可追加：先用「设为起点」标记节点', true);
      return;
    }
    try {
      const result = ui.model.add_initial_nodes(pending);
      const parts = [];
      if (result.queued.length) parts.push(`${result.queued.join(', ')}（下一轮生效）`);
      if (result.skipped.length) parts.push(`${result.skipped.join(', ')}（已激活或已是起点，跳过）`);
      setMsg(`追加起点：${parts.join('；') || '无可追加的节点'}`);
      updateAll();
    } catch (err) {
      setMsg(`追加失败：${err.message}`, true);
    }
  }

  // ------------------------------------------------------------ 角色与记忆

  function setRole(role) {
    if (!ui.selected) {
      setMsg('请先选中一个节点', true);
      return;
    }
    ui.starts.delete(ui.selected);
    ui.targets.delete(ui.selected);
    if (role === 'start') ui.starts.add(ui.selected);
    if (role === 'target') ui.targets.add(ui.selected);
    updateAll();
    setMsg(
      role === 'clear'
        ? `已清除 ${ui.selected} 的角色`
        : `${ui.selected} 已设为${role === 'start' ? '起点' : '目标'}（下次「开始扩散 / 重置」生效）`
    );
  }

  function focusReview() {
    if (!ui.model || !ui.selected) {
      setMsg('请先选中一个节点', true);
      return;
    }
    ui.model.update_memory(ui.selected, { review_type: 'focused', current_real_time: ui.now });
    updateAll();
    el.memoryMsg.textContent = `${ui.selected}：专注复习 → ms = 1.0`;
  }

  function setHoursAgo() {
    if (!ui.graph || !ui.selected) {
      setMsg('请先选中一个节点', true);
      return;
    }
    const hours = Number(el.hoursAgo.value);
    if (!Number.isFinite(hours)) {
      setMsg('「小时前」需要一个数字', true);
      return;
    }
    const node = ui.graph.get_node(ui.selected);
    node.last_review_time = ui.now - hours;
    updateAll();
    el.memoryMsg.textContent = `${node.id}：上次复习时间设为 ${hours} 小时前`;
  }

  function globalMemoryUpdate() {
    if (!ui.model) return;
    const report = ui.model.update_global_memory(ui.now);
    updateAll();
    el.memoryMsg.textContent =
      `衰减 ${report.updated.length} 个节点，补时间 ${report.filled_missing.length} 个` +
      (report.updated.length
        ? `（${report.updated.map((u) => `${u.id}: ${round4(u.ms_before)}→${round4(u.ms_after)}`).join('，')}）`
        : '');
  }

  // -------------------------------------------------------------- 输入输出

  function loadSample() {
    const key = el.sampleSelect.value;
    const samples = globalThis.MindNetSamples || {};
    if (!samples[key]) {
      setMsg(`没有找到示例「${key}」`, true);
      return;
    }
    ui.now = M.now_hours();
    el.nowInput.value = ui.now.toFixed(3);
    loadInput(JSON.parse(JSON.stringify(samples[key])));
  }

  function loadFromTextarea() {
    let parsed;
    try {
      parsed = JSON.parse(el.jsonInput.value);
    } catch (err) {
      setMsg(`JSON 解析失败：${err.message}`, true);
      return;
    }
    ui.now = M.now_hours();
    el.nowInput.value = ui.now.toFixed(3);
    if (loadInput(parsed)) setMsg('已按文本框内容载入');
  }

  function exportState() {
    if (!ui.model) {
      setMsg('还没有可导出的状态', true);
      return;
    }
    const state = ui.model.export_state();
    const text = JSON.stringify(state, null, 2);
    el.jsonOutput.value = text;
    if (ui.downloadUrl) URL.revokeObjectURL(ui.downloadUrl);
    ui.downloadUrl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    el.downloadLink.href = ui.downloadUrl;
    el.downloadLink.download = 'mindnet_state.json';
    el.downloadLink.style.display = 'inline-block';
    setMsg('已生成输出（可下载 state.json）');
  }

  // -------------------------------------------------------------- 自动化自检

  /**
   * 自动化验证钩子：用 index.html?selfcheck=1 打开时，脚本会把整条交互链路跑一遍
   * （角色 → 开始 → 单步 → 追加起点 → 跑到底 → 复习/遗忘 → 导出），
   * 并把结果写进页面底部的 <pre id="selfcheck">，供无头浏览器 dump-dom 抓取。
   * 平时正常打开页面不会触发。
   */
  function runSelfCheck() {
    const lines = [];
    try {
      lines.push(`graph_nodes=${ui.graph.size} graph_edges=${ui.graph.edges.length}`);
      lines.push(`svg_nodes=${el.layerNodes.childElementCount} svg_edges=${el.layerEdges.childElementCount}`);
      lines.push(`table_rows=${el.nodeTable.childElementCount}`);

      ui.selected = 'area_formula';
      setRole('start');
      startDiffusion();
      doStep();
      ui.selected = 'coordinate';
      setRole('start');
      appendStarts();
      const appendMsg = el.msg.textContent;
      runAll();

      lines.push(`rounds=${ui.model.rounds} stop=${ui.model.stop_reason}`);
      lines.push(`kc_gap=${el.kcGap.textContent} kc_penalty=${el.kcPenalty.textContent}`);
      lines.push(`info_steps=${el.infoSteps.textContent}`);
      lines.push(`reached=${el.infoReached.textContent} counts=${el.infoCounts.textContent}`);
      lines.push(
        `gap_rows=${el.gapBody.querySelectorAll('tr:not(.empty)').length} ` +
          `dead_rows=${el.deadBody.querySelectorAll('tr:not(.empty)').length}`
      );
      lines.push(`append=${appendMsg}`);
      lines.push(
        `transforms_ok=${Array.from(el.layerNodes.children).every((g) =>
          /^translate\(/.test(g.getAttribute('transform') || '')
        )}`
      );
      const mismatched = Array.from(ui.graph.nodes.values()).filter(
        (n) => !(ui.nodeEls.get(n.id).g.getAttribute('class') || '').includes(n.state)
      );
      lines.push(`class_mismatch=${mismatched.length}`);

      ui.selected = 'trig_func';
      focusReview();
      ui.selected = 'polar';
      el.hoursAgo.value = '10';
      setHoursAgo();
      globalMemoryUpdate();
      exportState();
      lines.push(`focus_ms=${ui.graph.get_node('trig_func').ms}`);
      lines.push(`memory=${el.memoryMsg.textContent}`);
      lines.push(`curve=${el.curveCaption.textContent}`);
      lines.push(`json_output_len=${el.jsonOutput.value.length}`);
      lines.push(`download_ready=${el.downloadLink.style.display !== 'none'}`);
      lines.push('SELFCHECK_OK');
    } catch (err) {
      lines.push(`SELFCHECK_FAIL ${err && err.message}`);
    }
    const pre = document.createElement('pre');
    pre.id = 'selfcheck';
    pre.textContent = lines.join('\n');
    document.body.appendChild(pre);
  }

  // ------------------------------------------------------------------ 启动

  function bind() {
    el.btnStart.addEventListener('click', startDiffusion);
    el.btnStep.addEventListener('click', doStep);
    el.btnRun.addEventListener('click', runAll);
    el.btnPlay.addEventListener('click', togglePlay);
    el.btnReset.addEventListener('click', startDiffusion);
    el.btnAppend.addEventListener('click', appendStarts);
    el.btnRoleStart.addEventListener('click', () => setRole('start'));
    el.btnRoleTarget.addEventListener('click', () => setRole('target'));
    el.btnRoleClear.addEventListener('click', () => setRole('clear'));
    el.btnNowReset.addEventListener('click', () => {
      ui.now = M.now_hours();
      el.nowInput.value = ui.now.toFixed(3);
      updateAll();
      el.memoryMsg.textContent = '已取当前现实时间';
    });
    el.nowInput.addEventListener('change', () => {
      const v = Number(el.nowInput.value);
      if (Number.isFinite(v)) ui.now = v;
      updateAll();
    });
    el.btnFocusReview.addEventListener('click', focusReview);
    el.btnSetAgo.addEventListener('click', setHoursAgo);
    el.btnMemoryUpdate.addEventListener('click', globalMemoryUpdate);
    el.btnLoadSample.addEventListener('click', loadSample);
    el.btnLoadJson.addEventListener('click', loadFromTextarea);
    el.btnExport.addEventListener('click', exportState);
    el.speed.addEventListener('change', () => {
      if (ui.playing) {
        stopPlaying();
        togglePlay();
      }
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.target && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
      if (ev.key === ' ') {
        ev.preventDefault();
        doStep();
      }
      if (ev.key === 'Enter') runAll();
      if (ev.key === 'r' || ev.key === 'R') startDiffusion();
    });
  }

  function boot() {
    const samples = globalThis.MindNetSamples || {};
    const keys = Object.keys(samples);
    for (const key of keys) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = key;
      el.sampleSelect.appendChild(option);
    }
    if (samples.demo_learning) el.sampleSelect.value = 'demo_learning';
    else if (keys.length) el.sampleSelect.value = keys[0];

    el.nowInput.value = ui.now.toFixed(3);
    bind();
    if (keys.length) loadSample();
    else setMsg('没有内置示例，请在下方粘贴输入 JSON 后点「载入文本框」');
    if (/[?&]selfcheck=1/.test(location.search)) runSelfCheck();
  }

  boot();
})();
