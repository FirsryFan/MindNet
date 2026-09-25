/**
 * MindNet 参数标定页逻辑
 *
 * 设计要点：
 *   - 纯前端、零依赖、file:// 可直接打开；
 *   - 每个实验只产出"能用一条闭式公式变成参数"的数据；
 *   - 进度存在 localStorage，所以「过几小时回来做延迟回忆」这件事真的可行；
 *   - 结果既给参数，也给"这对你意味着什么"的人话解释。
 */
(function () {
  'use strict';

  const M = globalThis.MindNet;
  const cal = M && M.calibration;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'mindnet.calibration.v1';
  const OVERRIDE_KEY = 'mindnet.overrides';

  if (!cal) {
    document.body.innerHTML = '<p style="padding:24px;color:#ff6b6b">标定核心未加载：请确认 ../src/calibration.js 路径正确。</p>';
    return;
  }

  const WORD_POOL = [
    '苹果', '钥匙', '河流', '灯塔', '铅笔', '森林', '窗户', '吉他',
    '面包', '轮胎', '草原', '螺丝', '茶杯', '地图', '钟表', '竹子',
    '雨伞', '铁轨', '信封', '蜡烛', '沙丘', '镜子', '铜铃', '芦苇',
  ];

  // ------------------------------------------------------------ 状态与存取

  const defaultState = () => ({
    t1: { trials: [], n: 3, phase: 'idle', current: [] },
    t2: { samples: [], phase: 'idle' },
    t3: { words: [], phase: 'idle', learnedAt: null, R0: null, Rt: null, tHours: null, S: null, testMode: null },
    t4: { learnedAt: null, phase: 'idle', R0_assumed: null, S_reread: null, S_retrieval: null, ratio: null },
    t5: { items: [], index: 0, phase: 'idle', shownAt: null, pending: null },
    t6: null,
  });

  function load() {
    try {
      const raw = globalThis.localStorage && localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultState(), parsed);
    } catch (err) {
      return defaultState();
    }
  }

  let state = load();

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      /* file:// 或隐私模式下可能不可用；不影响本次会话 */
    }
    renderSide();
  }

  function pick(n, exclude) {
    const pool = WORD_POOL.filter((w) => !(exclude || []).includes(w));
    const out = [];
    while (out.length < n && pool.length) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
  }

  function parseAnswer(text) {
    return String(text || '')
      .split(/[\s,，、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function hits(words, answer) {
    const set = new Set(parseAnswer(answer));
    return words.filter((w) => set.has(w)).length;
  }

  function fmt(x, n) {
    return Number(x).toFixed(n === undefined ? 2 : n);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------------------------------------------------------------- 参数表

  const PARAM_ROWS = [
    ['attention.capacity.W_DAR', '意识容量（能拿住几个）', () => M.attentionCapacity && M.attentionCapacity.DEFAULTS.W_DAR, 't1', 'W_DAR'],
    ['rhythm.gate.duty', '专注占比（在的时间比例）', () => M.rhythmGate && M.rhythmGate.DEFAULTS.duty, 't2', 'duty'],
    ['rhythm.gate.p_off', '转入走神概率 /tick', () => M.rhythmGate && M.rhythmGate.DEFAULTS.p_off, 't2', 'p_off'],
    ['rhythm.gate.p_on', '转回专注概率 /tick', () => M.rhythmGate && M.rhythmGate.DEFAULTS.p_on, 't2', 'p_on'],
    ['rhythm.gate.tau_vig_minutes', '警觉衰减时间常数（分钟）', () => M.rhythmGate && M.rhythmGate.DEFAULTS.tau_vig_minutes, 't2', 'tau_vig_minutes'],
    ['memory.dsr.legacy_k', '初始稳定度系数 k（小时）', () => M.memoryDsr && M.memoryDsr.DEFAULTS.legacy_k, 't3', 'legacy_k'],
    ['memory.dsr.kappa_reread_ratio', '再读增益 / 主动回忆增益', () => M.memoryDsr && M.memoryDsr.DEFAULTS.kappa_reread_ratio, 't4', 'kappa_reread_ratio'],
    ['metacognition.belief.b0', '自信偏置', () => M.metacognitionBelief && M.metacognitionBelief.DEFAULTS.b0, 't5', 'b0'],
    ['metacognition.belief.delta', '危险区阈值 δ', () => M.metacognitionBelief && M.metacognitionBelief.DEFAULTS.delta, 't5', 'delta'],
    ['control.planner.cost_link', '补一条连接的成本', () => M.controlPlanner && M.controlPlanner.DEFAULTS.cost_link, 't6', 'cost_link'],
    ['control.planner.cost_offload', '写下来的成本', () => M.controlPlanner && M.controlPlanner.DEFAULTS.cost_offload, 't6', 'cost_offload'],
  ];

  /** 汇总所有实验产出的估计值 */
  function estimates() {
    const e = {};
    if (state.t1.W_DAR !== undefined) e.W_DAR = state.t1.W_DAR;
    Object.assign(e, state.t2.estimate || {});
    if (state.t3.S !== null) {
      e.S_hours = state.t3.S;
      e.R0 = state.t3.R0;
      e.legacy_k = state.t3.legacy_k;
    }
    if (state.t4.ratio !== null) e.kappa_reread_ratio = state.t4.ratio;
    Object.assign(e, state.t5.estimate || {});
    Object.assign(e, state.t6 || {});
    return e;
  }

  function renderSide() {
    const e = estimates();
    const body = $('param-body');
    body.textContent = '';
    let done = 0;
    const seen = new Set();
    for (const row of PARAM_ROWS) {
      const [key, label, defFn, task, field] = row;
      const val = field === 'legacy_k' ? e.legacy_k : e[field];
      const def = defFn();
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = label;
      td1.title = key;
      const td2 = document.createElement('td');
      td2.textContent = def === undefined || def === null ? '—' : String(def);
      const td3 = document.createElement('td');
      if (val === undefined || val === null) {
        td3.textContent = '待做';
        td3.className = 'pending';
      } else {
        td3.textContent = fmt(val, 3);
        td3.className = 'est';
        if (!seen.has(field)) { done += 1; seen.add(field); }
      }
      const td4 = document.createElement('td');
      td4.innerHTML = `<span class="pill ${val === undefined || val === null ? 'wait' : 'ok'}">T${task.slice(1)}</span>`;
      tr.append(td1, td2, td3, td4);
      body.appendChild(tr);
    }
    $('done-count').textContent = String([state.t1.W_DAR !== undefined, !!state.t2.estimate, state.t3.S !== null,
      state.t4.ratio !== null, !!state.t5.estimate, !!state.t6].filter(Boolean).length);

    const effects = cal.describeEffects(e);
    const ul = $('effects');
    ul.textContent = '';
    if (!effects.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = '做完实验后这里会用人话解释。';
      ul.appendChild(li);
    }
    for (const line of effects) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }

    const overrides = cal.buildOverrides(e);
    $('overrides').value = JSON.stringify(overrides, null, 2);
    return overrides;
  }

  function msg(text, isError) {
    const el = $('cal-msg');
    el.textContent = text || '';
    el.className = isError ? 'msg error' : 'msg';
  }

  function showResult(id, text) {
    const el = $(id);
    el.style.display = 'block';
    el.innerHTML = text;
  }

  // ------------------------------------------------------------------ T1 容量

  (function initT1() {
    const stage = $('t1-stage');
    const startBtn = $('t1-start');
    const nLabel = $('t1-n');
    let timer = null;

    function flash(words) {
      let i = 0;
      stage.innerHTML = '<div class="flash">准备…</div>';
      timer = setInterval(() => {
        if (i >= words.length) {
          clearInterval(timer);
          stage.innerHTML = '<span class="hint">闪完了，写下你记住的词。</span>';
          $('t1-answer-row').style.display = 'flex';
          $('t1-answer').value = '';
          $('t1-answer').focus();
          return;
        }
        stage.innerHTML = `<div class="flash">${escapeHtml(words[i])}</div>`;
        i += 1;
      }, 1200);
    }

    startBtn.addEventListener('click', () => {
      const n = state.t1.n;
      state.t1.current = pick(n, state.t1.trials.flatMap((t) => t.words));
      state.t1.phase = 'flashing';
      save();
      flash(state.t1.current);
      startBtn.disabled = true;
      nLabel.textContent = String(n);
    });

    $('t1-submit').addEventListener('click', () => {
      const n = state.t1.current.length;
      const h = hits(state.t1.current, $('t1-answer').value);
      state.t1.trials.push({ n, hits: h, accuracy: n ? h / n : 0 });
      state.t1.phase = 'idle';
      $('t1-answer-row').style.display = 'none';
      $('t1-progress').textContent = state.t1.trials.map((t) => `${t.n}个→${t.hits}/${t.n}`).join('  ');
      if (state.t1.n < 7) {
        state.t1.n += 1;
        nLabel.textContent = String(state.t1.n);
        startBtn.disabled = false;
        stage.innerHTML = '<span class="hint">点「开始」继续下一档。</span>';
      } else {
        const est = cal.estimateCapacity(state.t1.trials);
        state.t1.W_DAR = est.W_DAR;
        startBtn.disabled = true;
        stage.innerHTML = '<span class="hint">测完了。</span>';
        showResult('t1-result', `<b>意识容量 ≈ ${fmt(est.W_DAR, 2)} 个项目</b><br>${escapeHtml(est.note)}`);
      }
      save();
    });
  })();

  // ------------------------------------------------------------ T2 走神与专注

  (function initT2() {
    const SAMPLES = 9;      // 9 × 20 秒 = 3 分钟
    const WINDOW_MS = 20000;
    const stage = $('t2-stage');
    const clock = $('t2-clock');
    let timer = null;
    let tick = 0;
    let offInWindow = false;
    let startedAt = 0;

    function renderDots() {
      stage.innerHTML = state.t2.samples
        .map((s) => `<span class="pill ${s.focused ? 'ok' : ''}">${s.focused ? '在' : '走神'}</span>`)
        .join(' ');
    }

    $('t2-off').addEventListener('click', () => {
      offInWindow = true;
      clock.textContent = '记下了';
    });

    $('t2-start').addEventListener('click', () => {
      state.t2 = { samples: [], phase: 'running' };
      tick = 0;
      offInWindow = false;
      startedAt = Date.now();
      $('t2-off').disabled = false;
      $('t2-start').disabled = true;
      renderDots();
      timer = setInterval(() => {
        const elapsedMinutes = (Date.now() - startedAt) / 60000;
        state.t2.samples.push({ tMinutes: elapsedMinutes, focused: !offInWindow });
        offInWindow = false;
        renderDots();
        tick += 1;
        clock.textContent = `第 ${tick}/${SAMPLES} 段`;
        if (tick >= SAMPLES) {
          clearInterval(timer);
          $('t2-off').disabled = true;
          $('t2-start').disabled = false;
          state.t2.phase = 'done';
          const est = cal.estimateRhythm(state.t2.samples, { tickMs: 250, sampleMinutes: 0.3333 });
          state.t2.estimate = { duty: est.duty, p_off: est.p_off, p_on: est.p_on, tau_vig_minutes: est.tau_vig_minutes };
          showResult('t2-result', `<b>专注占比 ${fmt(est.duty, 2)}</b><br>${escapeHtml(est.note)}`);
          save();
        }
      }, WINDOW_MS);
      clock.textContent = '第 0/' + SAMPLES + ' 段';
    });

    if (state.t2.samples && state.t2.samples.length) renderDots();
  })();

  // ------------------------------------------------------------ T3 遗忘速度

  (function initT3() {
    const stage = $('t3-stage');
    const clock = $('t3-clock');
    let pendingMode = null;
    let timer = null;

    function updateClock() {
      if (!state.t3.learnedAt) { clock.textContent = '—'; return; }
      const hours = (Date.now() - state.t3.learnedAt) / 3600000;
      clock.textContent = `距上次学习 ${fmt(hours, 1)} 小时`;
    }
    updateClock();
    setInterval(updateClock, 30000);

    if (state.t3.S !== null) {
      showResult('t3-result', `<b>S ≈ ${fmt(state.t3.S, 1)} 小时</b>（R0 = ${fmt(state.t3.R0, 2)}，${fmt(state.t3.tHours, 1)} 小时后留存比 ${fmt(state.t3.Rt / state.t3.R0, 2)}）`);
    }
    if (state.t3.learnedAt) {
      $('t3-test-later').disabled = false;
      $('t3-stage').innerHTML = '<span class="hint">已经学过一遍了 —— 过几小时回来点「延迟回忆」。</span>';
    }

    $('t3-learn').addEventListener('click', () => {
      const words = parseAnswer($('t3-words').value);
      if (words.length < 4) { msg('至少填 4 个词', true); return; }
      state.t3 = { words, phase: 'learning', learnedAt: null, R0: null, Rt: null, tHours: null, S: null, testMode: null };
      save();
      let i = 0;
      stage.innerHTML = '<div class="flash">准备…</div>';
      timer = setInterval(() => {
        if (i >= words.length) {
          clearInterval(timer);
          stage.innerHTML = '<span class="hint">学完了。点「立即回忆」写下你记得的。</span>';
          $('t3-test-now').disabled = false;
          return;
        }
        stage.innerHTML = `<div class="flash">${escapeHtml(words[i])}</div>`;
        i += 1;
      }, 3000);
    });

    function openAnswer(mode) {
      pendingMode = mode;
      $('t3-answer-row').style.display = 'flex';
      $('t3-answer').value = '';
      $('t3-answer').focus();
      stage.innerHTML = `<span class="hint">${mode === 'now' ? '立即回忆' : '延迟回忆'}：写出你记得的词，空格分隔。</span>`;
    }

    $('t3-test-now').addEventListener('click', () => openAnswer('now'));
    $('t3-test-later').addEventListener('click', () => openAnswer('later'));

    $('t3-submit').addEventListener('click', () => {
      const total = state.t3.words.length;
      const h = hits(state.t3.words, $('t3-answer').value);
      const R = total ? h / total : 0;
      $('t3-answer-row').style.display = 'none';
      if (pendingMode === 'now') {
        state.t3.R0 = R;
        state.t3.learnedAt = Date.now();
        $('t3-test-now').disabled = true;
        $('t3-test-later').disabled = false;
        stage.innerHTML = `<span class="hint">R0 = ${fmt(R, 2)}（${h}/${total}）。过几小时回来点「延迟回忆」。</span>`;
        msg('已记录立即回忆，过几小时回来做延迟回忆');
      } else {
        if (!state.t3.learnedAt) { msg('请先做立即回忆', true); return; }
        const tHours = (Date.now() - state.t3.learnedAt) / 3600000;
        state.t3.Rt = R;
        state.t3.tHours = tHours;
        try {
          const est = cal.estimateStability({ R0: state.t3.R0, Rt: R, tHours });
          state.t3.S = est.S;
          state.t3.legacy_k = est.S / Math.max(0.05, state.t3.R0);
          showResult('t3-result', `<b>S ≈ ${fmt(est.S, 1)} 小时</b><br>${escapeHtml(est.note)}`
            + `<br>顺带：你的初始稳定度系数 k = S / R0 ≈ ${fmt(state.t3.legacy_k, 1)} 小时（默认 24）`);
        } catch (err) {
          showResult('t3-result', `<span class="warn">${escapeHtml(err.message)}</span>`);
        }
      }
      updateClock();
      save();
    });
  })();

  // -------------------------------------------------- T4 再读 vs 主动回忆

  (function initT4() {
    const stage = $('t4-stage');
    const clock = $('t4-clock');

    function updateClock() {
      if (!state.t4.learnedAt) { clock.textContent = '—'; return; }
      clock.textContent = `距学习 ${fmt((Date.now() - state.t4.learnedAt) / 3600000, 1)} 小时`;
    }
    updateClock();
    setInterval(updateClock, 30000);
    if (state.t4.learnedAt) {
      $('t4-test').disabled = false;
      stage.innerHTML = '<span class="hint">两组都学过了 —— 第二天点「测试两组」。</span>';
    }

    $('t4-learn').addEventListener('click', () => {
      const all = parseAnswer($('t4-words').value);
      if (all.length < 10) { msg('T4 需要 10 个词（两组各 5 个）', true); return; }
      const A = all.slice(0, 5);
      const B = all.slice(5, 10);
      let i = 0;
      const seq = [];
      for (const w of A) { seq.push({ w, label: 'A 组·再读', ms: 3000 }); seq.push({ w, label: 'A 组·再看一遍', ms: 2000 }); }
      for (const w of B) { seq.push({ w, label: 'B 组·看一遍', ms: 3000 }); seq.push({ w: '合上材料，在心里回忆它', label: 'B 组·主动回忆', ms: 5000 }); }
      stage.innerHTML = '<div class="flash">准备…</div>';
      const timer = setInterval(() => {
        if (i >= seq.length) {
          clearInterval(timer);
          state.t4 = Object.assign({}, state.t4, {
            learnedAt: Date.now(), phase: 'learned',
            R0_assumed: state.t3.R0 || 0.8,
            S_reread: null, S_retrieval: null, ratio: null,
          });
          $('t4-test').disabled = false;
          stage.innerHTML = '<span class="hint">两组学完。第二天点「测试两组」。</span>';
          updateClock();
          save();
          return;
        }
        const step = seq[i];
        stage.innerHTML = `<div class="flash" style="font-size:${step.label.includes('回忆') ? '18px' : '34px'}">${escapeHtml(step.w)}</div>`
          + `<div class="hint" style="text-align:center">${escapeHtml(step.label)}</div>`;
        setTimeout(() => { i += 1; }, step.ms);
      }, 100);
    });

    $('t4-test').addEventListener('click', () => {
      $('t4-answer-row').style.display = 'flex';
    });

    $('t4-submit').addEventListener('click', () => {
      if (!state.t4.learnedAt) { msg('请先做两组学习', true); return; }
      const tHours = (Date.now() - state.t4.learnedAt) / 3600000;
      const RA = Math.max(0.001, Number($('t4-a').value) / 5);
      const RB = Math.max(0.001, Number($('t4-b').value) / 5);
      const R0 = state.t4.R0_assumed || 0.8;
      const legacyK = state.t3.legacy_k || 24;
      const S_before = legacyK * R0;
      try {
        const sa = cal.estimateStability({ R0, Rt: Math.min(RA, R0), tHours });
        const sb = cal.estimateStability({ R0, Rt: Math.min(RB, R0), tHours });
        const est = cal.estimateReviewTypeRatio({ S_before, S_reread: sa.S, S_retrieval: sb.S });
        state.t4.S_reread = sa.S;
        state.t4.S_retrieval = sb.S;
        state.t4.ratio = est.kappa_reread_ratio;
        state.t4.tHours = tHours;
        showResult('t4-result', `A 组（再读）S ≈ ${fmt(sa.S, 1)} h　B 组（主动回忆）S ≈ ${fmt(sb.S, 1)} h<br>`
          + `<b>再读的增益只有主动回忆的 ${fmt(est.kappa_reread_ratio * 100, 0)}%</b><br>${escapeHtml(est.note)}`
          + `<br><span class="hint">注：S_before 用初值 k×R0 近似（k 来自 T3，缺省 24）；这个比例只关心两组之差，对近似不敏感。</span>`);
      } catch (err) {
        showResult('t4-result', `<span class="warn">${escapeHtml(err.message)}</span>`);
      }
      save();
    });
  })();

  // ------------------------------------------------------------ T5 自信校准

  (function initT5() {
    const stage = $('t5-stage');
    const N = 12;
    let phase = 'belief';

    function showWord() {
      const item = state.t5.items[state.t5.index];
      if (!item) return;
      phase = 'belief';
      state.t5.shownAt = Date.now();
      stage.innerHTML = `<div class="flash">${escapeHtml(item.word)}</div>`
        + '<div class="hint" style="text-align:center">如果现在考你这个，你能想起来的把握有多大？</div>';
      $('t5-belief-row').style.display = 'flex';
      $('t5-recall-row').style.display = 'none';
      $('t5-progress').textContent = `${state.t5.index + 1}/${N}`;
    }

    $('t5-belief').addEventListener('input', () => {
      $('t5-belief-val').textContent = $('t5-belief').value;
    });

    $('t5-start').addEventListener('click', () => {
      state.t5 = { items: pick(N, []).map((w) => ({ word: w, belief: null, recalled: null, rtMs: null })), index: 0, phase: 'run', shownAt: null, pending: null };
      $('t5-start').disabled = true;
      showWord();
      save();
    });

    $('t5-next').addEventListener('click', () => {
      const item = state.t5.items[state.t5.index];
      if (!item) return;
      item.belief = Number($('t5-belief').value) / 100;
      item.rtMs = Date.now() - state.t5.shownAt;
      $('t5-belief-row').style.display = 'none';
      $('t5-recall-row').style.display = 'flex';
    });

    function finishItem(recalled) {
      const item = state.t5.items[state.t5.index];
      item.recalled = recalled;
      state.t5.index += 1;
      $('t5-recall-row').style.display = 'none';
      if (state.t5.index >= state.t5.items.length) {
        finish();
        return;
      }
      showWord();
      save();
    }

    function finish() {
      $('t5-start').disabled = false;
      stage.innerHTML = '<span class="hint">测完了。</span>';
      const items = state.t5.items
        .filter((x) => x.belief !== null && x.recalled !== null)
        .map((x) => ({
          belief: x.belief,
          recalled: x.recalled,
          // 流畅度代理：反应越快越"顺"（上限 6 秒）
          fluency: Math.max(0, Math.min(1, 1 - (x.rtMs || 3000) / 6000)),
          R0: state.t3.R0 || 0.8,
        }));
      const est = cal.fitBeliefBias({ items, beliefOf: M.metacognitionBelief.beliefOf });
      state.t5.estimate = { b0: est.b0, delta: est.delta, calibration: est.calibration, bias: est.bias };
      showResult('t5-result', `<b>自信偏置 b0 ≈ ${fmt(est.b0, 2)}，危险区阈值 δ ≈ ${fmt(est.delta, 2)}</b><br>`
        + `${escapeHtml(est.note)}<br>校准度（平均 |自信−实际|）≈ ${fmt(est.calibration, 2)}`);
      save();
    }

    $('t5-yes').addEventListener('click', () => finishItem(true));
    $('t5-no').addEventListener('click', () => finishItem(false));

    if (state.t5.estimate) {
      showResult('t5-result', `<b>自信偏置 b0 ≈ ${fmt(state.t5.estimate.b0, 2)}</b>（上次结果，可重做）`);
    }
  })();

  // ------------------------------------------------------------ T6 成本与目标

  (function initT6() {
    for (const key of ['retrieval', 'link', 'offload']) {
      const el = $(`t6-${key}`);
      el.addEventListener('input', () => { $(`t6-${key}-v`).textContent = el.value; });
    }
    $('t6-acc').addEventListener('input', updateAccHint);
    function updateAccHint() {
      const acc = Number($('t6-acc').value) / 100;
      $('t6-acc-hint').textContent = acc >= 0.9
        ? '偏易：挑战不够，学不到新东西'
        : acc <= 0.6 ? '偏难：失败太多，可能只是挫败' : '接近合意难度（85% 规则）';
    }
    updateAccHint();

    $('t6-submit').addEventListener('click', () => {
      const costs = cal.estimateCosts({
        retrieval: Number($('t6-retrieval').value),
        link: Number($('t6-link').value),
        offload: Number($('t6-offload').value),
      });
      state.t6 = {
        cost_retrieval: costs.cost_retrieval,
        cost_link: costs.cost_link,
        cost_offload: costs.cost_offload,
        target_retention: Number($('t6-target').value),
        accuracy: Number($('t6-acc').value) / 100,
      };
      showResult('t6-result', `<b>成本比：回忆 1.00 / 补连接 ${fmt(costs.cost_link, 2)} / 写下来 ${fmt(costs.cost_offload, 2)}</b><br>`
        + `目标留存 ${state.t6.target_retention}；平时正确率 ${fmt(state.t6.accuracy, 2)}`);
      save();
    });

    if (state.t6) {
      showResult('t6-result', `上次结果：成本比 回忆 1.00 / 补连接 ${fmt(state.t6.cost_link, 2)} / 写下来 ${fmt(state.t6.cost_offload, 2)}，目标留存 ${state.t6.target_retention}`);
    }
  })();

  // -------------------------------------------------------- 反馈闭环小演示

  (function initRefine() {
    function run(correct) {
      const s = Number($('refine-s').value);
      const t = Number($('refine-t').value);
      const next = cal.refineStability(s, { tHours: t, correct });
      $('refine-out').textContent = `${correct ? '答对' : '答错'} ⇒ S：${fmt(s, 1)} → ${fmt(next, 1)} 小时（单条证据只移动约 4%）`;
      $('refine-s').value = String(next);
    }
    $('refine-yes').addEventListener('click', () => run(true));
    $('refine-no').addEventListener('click', () => run(false));
  })();

  // -------------------------------------------------------------- 顶部按钮

  $('btn-apply').addEventListener('click', () => {
    const overrides = renderSide();
    try {
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify(overrides));
      msg(`已保存 ${Object.keys(overrides).length} 个参数到本机（键名 ${OVERRIDE_KEY}）。打开 index.html 时会自动用上。`);
    } catch (err) {
      msg('本机存储不可用（file:// 或隐私模式）；请手动复制右侧 JSON。', true);
    }
  });

  $('btn-clear').addEventListener('click', () => {
    if (!globalThis.confirm('清空所有标定进度？')) return;
    state = defaultState();
    try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
    globalThis.location.reload();
  });

  $('btn-copy').addEventListener('click', () => {
    const ta = $('overrides');
    ta.select();
    try {
      document.execCommand('copy');
      msg('已复制到剪贴板');
    } catch (err) {
      msg('复制失败，请手动选中复制', true);
    }
  });

  // 下载
  (function initDownload() {
    const link = $('download-link');
    const overrides = renderSide();
    const blob = new Blob([JSON.stringify(overrides, null, 2)], { type: 'application/json' });
    link.href = URL.createObjectURL(blob);
    link.download = 'mindnet_overrides.json';
    link.style.display = 'inline-block';
  })();

  renderSide();
  msg('进度会自动保存；T3 / T4 需要过几小时回来做第二次。');

  // ------------------------------------------------ 自动化自检（?selfcheck=1）
  if (/[?&]selfcheck=1/.test(location.search)) {
    const lines = [];
    try {
      lines.push(`param_rows=${document.querySelectorAll('#param-body tr').length}`);
      lines.push(`tasks=${document.querySelectorAll('.task').length}`);
      const overridesText = $('overrides').value;
      const parsed = JSON.parse(overridesText);
      lines.push(`overrides_keys=${Object.keys(parsed).length}`);
      // 估计器端到端：造一组数据跑一遍，确认能产出参数
      const cap = cal.estimateCapacity([{ n: 3, accuracy: 1 }, { n: 4, accuracy: 0.9 }, { n: 5, accuracy: 0.6 }, { n: 6, accuracy: 0.3 }]);
      const rhy = cal.estimateRhythm(Array.from({ length: 30 }, (_, i) => ({ tMinutes: i * 0.5, focused: i % 3 !== 0 })));
      const stab = cal.estimateStability({ R0: 0.8, Rt: 0.5, tHours: 8 });
      lines.push(`estimate_capacity=${cap.W_DAR}`);
      lines.push(`estimate_rhythm_duty=${rhy.duty}`);
      lines.push(`estimate_stability_S=${stab.S}`);
      lines.push(`effects_lines=${cal.describeEffects({ S_hours: stab.S, W_DAR: cap.W_DAR, duty: rhy.duty }).length}`);
      lines.push(`localStorage_ok=${(() => { try { localStorage.setItem('mindnet.probe', '1'); localStorage.removeItem('mindnet.probe'); return true; } catch (e) { return false; } })()}`);
      lines.push('CALIBRATE_OK');
    } catch (err) {
      lines.push(`CALIBRATE_FAIL ${err && err.message}`);
    }
    const pre = document.createElement('pre');
    pre.id = 'selfcheck';
    pre.textContent = lines.join('\n');
    pre.style.display = 'none';
    document.body.appendChild(pre);
  }
})();
