/**
 * MindNet I/O · 存档（append-only，零 fs 依赖）
 *
 * 为什么是"即时存档"而不是"先问要不要采纳"：
 *   模型不大，每条动作生效后立刻落一条记录，出问题靠**回退**解决，而不是靠事前拦截。
 *   你自己操作也会出错 —— 那就让"错了"变成"退回去"，而不是"当时被拦住了"。
 *
 * 这一层只负责顺序、指纹与回放；写文件的部分在 tools/ 里（本文件浏览器也能用）。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? require('../config.js') : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const PROTOCOL = 'mindnet.archive/1';

  class RunArchive {
    constructor(options) {
      const o = options || {};
      this.protocol = PROTOCOL;
      this.entries = [];
      this.seq = 0;
      this.clock = typeof o.clock === 'function' ? o.clock : null;   // 返回真实时间戳（浏览器里是 Date.now）
    }

    /**
     * 追加一条。entry 至少要有 kind；before/after 是"这次动作前后"的可读快照。
     * @returns {object} 落盘后的条目（含 entry_id / seq）
     */
    append(entry) {
      const e = entry || {};
      if (typeof e.kind !== 'string' || !e.kind) throw new MindNetError('存档条目必须带 kind');
      this.seq += 1;
      const rec = {
        protocol: PROTOCOL,
        entry_id: `e${String(this.seq).padStart(6, '0')}`,
        seq: this.seq,
        at: e.at === undefined ? (this.clock ? this.clock() : null) : e.at,
        run_id: e.run_id === undefined ? null : e.run_id,
        kind: e.kind,
        action_index: e.action_index === undefined ? null : e.action_index,
        action: e.action === undefined ? null : e.action,
        before: e.before === undefined ? null : e.before,
        after: e.after === undefined ? null : e.after,
        state_hash_before: e.state_hash_before === undefined ? null : e.state_hash_before,
        state_hash_after: e.state_hash_after === undefined ? null : e.state_hash_after,
        note: e.note === undefined ? null : e.note,
      };
      this.entries.push(rec);
      return rec;
    }

    /** 某个 run 已经存档过了吗（幂等用） */
    findRun(runId) {
      if (!runId) return null;
      for (let i = this.entries.length - 1; i >= 0; i -= 1) {
        if (this.entries[i].run_id === runId && this.entries[i].kind === 'run') return this.entries[i];
      }
      return null;
    }

    /** 某个 run 的第一条存档条目下标（回退用） */
    indexOfRun(runId) {
      for (let i = 0; i < this.entries.length; i += 1) {
        if (this.entries[i].run_id === runId) return i;
      }
      return -1;
    }

    /**
     * 回退到某个 run 之前：返回"要保留的条目"与"被丢掉"的条数。
     * 真正的回退方式是把保留下来的条目从头重放（见 docs/IO_PROTOCOL.md §5），
     * 因为只有重放才能保证与在线路径逐位一致。
     */
    rewindPlan(runId) {
      const idx = this.indexOfRun(runId);
      if (idx < 0) throw new MindNetError(`存档里找不到 run "${runId}"`);
      return {
        run_id: runId,
        keep: this.entries.slice(0, idx).map((e) => e.entry_id),
        drop: this.entries.slice(idx).map((e) => e.entry_id),
        target_state_hash: idx === 0 ? null : this.entries[idx - 1].state_hash_after,
      };
    }

    get lastEntryId() {
      return this.entries.length ? this.entries[this.entries.length - 1].entry_id : null;
    }

    toJSON() {
      return { protocol: PROTOCOL, seq: this.seq, entries: this.entries };
    }

    static fromJSON(obj) {
      const a = new RunArchive();
      if (obj && Array.isArray(obj.entries)) {
        a.entries = JSON.parse(JSON.stringify(obj.entries));
        a.seq = obj.seq === undefined ? a.entries.length : obj.seq;
      }
      return a;
    }

    /** JSONL：一行一条（append-only 的文件形态） */
    toJSONL() {
      return this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : '');
    }

    static fromJSONL(text) {
      const a = new RunArchive();
      // 去掉可能的 BOM（Windows 编辑器常见），否则第一行 JSON.parse 会炸
      const lines = String(text || '').replace(/^\uFEFF/, '').split('\n').filter((l) => l.trim() !== '');
      for (const line of lines) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch (err) {
          throw new MindNetError(`存档第 ${a.entries.length + 1} 行不是合法 JSON：${err.message}`);
        }
        a.entries.push(rec);
        a.seq = Math.max(a.seq, rec.seq === undefined ? a.entries.length : rec.seq);
      }
      return a;
    }
  }

  const api = { PROTOCOL, RunArchive };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { ioArchive: api });
})();
