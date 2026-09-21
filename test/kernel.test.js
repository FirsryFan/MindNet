'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MechanismKernel, validateManifest, HOOK_NAMES } = require('../src/core/kernel.js');
const { createRng } = require('../src/core/rng.js');
const { Graph, Config, MindNetError } = require('../src/index.js');
const { makeGraph } = require('./helpers.js');

function dummy(overrides) {
  return Object.assign(
    {
      api: 1,
      id: 'test.dummy',
      name: '测试模块',
      layer: 'memory',
      level: 'optional',
      phenomenon: ['用于内核契约测试的假现象'],
      evidence: [{ grade: 'local', note: '测试' }],
      params: [],
      reads: [],
      writes: [],
      requires: [],
      conflicts: [],
      acceptance: [{ name: '恒真', kind: 'phenomenon', check: () => true }],
      hooks: {},
    },
    overrides
  );
}

function kernelWith(manifests, graph) {
  const k = new MechanismKernel(graph || makeGraph([['A', { ms: 0.8 }], ['B', {}]], []), new Config(), {
    seed: 7,
    hours: 0,
  });
  k.load(manifests);
  return k;
}

test('内核：合法模块可装载，槽位按依赖顺序执行', () => {
  const order = [];
  const a = dummy({ id: 'test.a', hooks: { 'round.after': () => order.push('a') } });
  const b = dummy({
    id: 'test.b',
    requires: ['test.a'],
    hooks: { 'round.after': () => order.push('b') },
  });
  const k = kernelWith([b, a]); // 故意先注册 b
  assert.deepEqual(k.enabledIds(), ['test.a', 'test.b']);
  k.run('round.after', {});
  assert.deepEqual(order, ['a', 'b'], 'requires 的模块必须先生效');
});

test('内核：manifest 校验（api / 层 / level / 槽位 / 参数标定 / 验收 / 依赖 / 冲突 / 成环）', () => {
  const bad = [
    [{ api: 2 }, /api 版本/],
    [{ layer: 'nope' }, /layer 必须是/],
    [{ level: 'nope' }, /level 必须是/],
    [{ hooks: { 'no.such.hook': () => {} } }, /未知槽位/],
    [{ params: [{ key: 'x', type: 'number', default: 1 }] }, /calibrated/],
    [{ params: [{ key: 'x', type: 'number', default: 1, calibrated: true, min: 5 }] }, /小于 min/],
    [{ acceptance: [] }, /至少一条 acceptance/],
    [{ phenomenon: [] }, /模拟什么现象/],
    [{ writes: ['m.x.y'] }, /writes 只能写/],
    [{ conflicts: ['test.dummy'] }, /不能与自己冲突/],
  ];
  for (const [override, re] of bad) {
    assert.throws(() => validateManifest(dummy(override)), (err) => {
      assert.ok(err instanceof MindNetError);
      assert.match(err.message, re);
      return true;
    }, `应拒绝：${JSON.stringify(override)}`);
  }
  // 冲突检测发生在 finalize
  const x = dummy({ id: 'test.x', conflicts: ['test.y'] });
  const y = dummy({ id: 'test.y' });
  assert.throws(() => kernelWith([x, y]), /不能同时启用/);
  // 依赖成环
  const p = dummy({ id: 'test.p', requires: ['test.q'] });
  const q = dummy({ id: 'test.q', requires: ['test.p'] });
  assert.throws(() => kernelWith([p, q]), /依赖成环/);
  assert.ok(HOOK_NAMES.includes('hours.advance'), 'hours.advance 必须是合法槽位');
});

test('内核：模块抛错 ⇒ 告警 + 停用，且不静默（不变量 I8）', () => {
  let laterRan = false;
  const boom = dummy({
    id: 'test.boom',
    hooks: {
      'round.after': () => {
        throw new Error('故意炸');
      },
    },
  });
  const later = dummy({
    id: 'test.later',
    hooks: {
      'round.after': () => {
        laterRan = true;
      },
    },
  });
  const k = kernelWith([boom, later]);
  k.run('round.after', {});
  assert.equal(laterRan, true, '其他模块不受影响');
  assert.equal(k.isEnabled('test.boom'), false, '出错模块被停用');
  const w = k.warnings.find((x) => x.kind === 'error');
  assert.ok(w && /故意炸/.test(w.message));
  k.run('round.after', {});
  assert.equal(k.warnings.filter((x) => x.kind === 'error').length, 1, '停用后不再重复报错');
});

test('内核：写未声明字段被拒绝，模块被停用', () => {
  const sneaky = dummy({
    id: 'test.sneaky',
    writes: ['declared'],
    hooks: {
      'round.before': (ctx) => ctx.patch('A', { undeclared: 1 }),
    },
  });
  const k = kernelWith([sneaky]);
  k.run('round.before', {});
  assert.equal(k.isEnabled('test.sneaky'), false);
  assert.match(k.warnings.find((w) => w.kind === 'error').message, /未在 writes 中声明/);
});

test('内核：不变量守卫 —— 越界被钳住、写入方被停用、告警留下', () => {
  const bad = dummy({
    id: 'test.badwriter',
    writes: ['ms'],
    hooks: {
      'round.before': (ctx) => ctx.patch('A', { ms: 5 }),
    },
  });
  const k = kernelWith([bad]);
  k.run('round.before', {});
  const node = k.graph.get_node('A');
  assert.equal(node.ms, 1, 'ms 必须被钳到 [0,1]');
  assert.equal(k.isEnabled('test.badwriter'), false);
  const w = k.warnings.find((x) => x.kind === 'invariant');
  assert.match(w.message, /ms 越界/);
});

test('内核：确定性 —— 同 seed 同操作 ⇒ 同状态指纹；RNG 序列可复现', () => {
  const moduleRun = (kernel) => {
    kernel.setHours(10);
    kernel.run('round.before', {});
    return kernel.stateHash();
  };
  const m = dummy({
    id: 'test.rng',
    writes: ['x'],
    hooks: {
      'round.before': (ctx) => {
        ctx.patch('A', { x: ctx.rng() });
      },
    },
  });
  const k1 = kernelWith([m]);
  const k2 = kernelWith([m]);
  assert.equal(moduleRun(k1), moduleRun(k2), '同 seed 必须逐位一致');

  const r1 = createRng(42);
  const r2 = createRng(42);
  const r3 = createRng(43);
  const seq1 = [r1(), r1(), r1()];
  const seq2 = [r2(), r2(), r2()];
  const seq3 = [r3(), r3(), r3()];
  assert.deepEqual(seq1, seq2);
  assert.notDeepEqual(seq1, seq3);
  assert.ok(seq1.every((v) => v >= 0 && v < 1));
});

test('内核：参数解析（默认值 + 构造时覆盖 + 未知参数报错）', () => {
  const m = dummy({
    id: 'test.params',
    params: [
      { key: 'a', type: 'number', min: 0, max: 10, default: 1, calibrated: false },
      { key: 'b', type: 'enum', options: ['x', 'y'], default: 'x', calibrated: true },
    ],
  });
  const k = new MechanismKernel(makeGraph([['A', {}]], []), new Config(), {
    overrides: { 'test.params.a': 7 },
  });
  k.load([m]);
  assert.equal(k.param('test.params.a'), 7);
  assert.equal(k.param('test.params.b'), 'x');
  assert.equal(k.param('test.params.zzz', 'fallback'), 'fallback');
  assert.throws(() => k.param('test.params.zzz'), /找不到参数/);
});

test('内核：acceptance 报告与 serialize 合并，data() 按命名空间隔离', () => {
  const m1 = dummy({
    id: 'test.one',
    writes: ['v'],
    hooks: {
      'serialize.on': (ctx) => ({ one: ctx.data('A').v }),
      'round.before': (ctx) => ctx.patch('A', { v: 1 }),
    },
    acceptance: [
      { name: '通过项', kind: 'phenomenon', check: () => true },
      { name: '失败项', kind: 'ablation', check: () => false },
      {
        name: '抛错项',
        kind: 'phenomenon',
        check: () => {
          throw new Error('炸');
        },
      },
    ],
  });
  const m2 = dummy({
    id: 'test.two',
    writes: ['v'],
    hooks: {
      'serialize.on': (ctx) => ({ two: ctx.data('A').v }),
      'round.before': (ctx) => {
        assert.equal(ctx.data('A').v, undefined, '两个模块的命名空间互不可见');
        ctx.patch('A', { v: 2 });
      },
    },
  });
  const k = kernelWith([m1, m2]);
  k.run('round.before', {});
  assert.deepEqual(k.serialize(), { one: 1, two: 2 });
  const report = k.runAcceptance();
  assert.equal(report.length, 4); // m1 三条 + m2 一条
  assert.equal(report.filter((r) => r.passed).length, 2);
  assert.match(report.find((r) => r.name === '抛错项').error, /炸/);
});
