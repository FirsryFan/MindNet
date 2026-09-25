/**
 * 本文件由 viz/build_mechanisms.js 自动生成，请勿手改。
 * 生成时间 2026-09-25T02:27:13.671Z
 */
(function () {
  'use strict';
  const manifest = {
    profiles: {
  "v2": [
    "memory.dsr",
    "context.goal",
    "rhythm.gate",
    "dynamics.shunting",
    "attention.capacity",
    "attention.ignition",
    "metacognition.belief",
    "diagnosis.bottleneck",
    "control.planner"
  ],
  "memory": [
    "memory.dsr"
  ],
  "legacy": [
    "memory.dsr",
    "legacy_v1"
  ],
  "extras": [
    "attention.capacity",
    "attention.inhibition"
  ]
},
    globals: {
  "attention.capacity": "attentionCapacity",
  "attention.ignition": "attentionIgnition",
  "attention.inhibition": "attentionInhibition",
  "context.goal": "contextGoal",
  "control.planner": "controlPlanner",
  "diagnosis.bottleneck": "diagnosisBottleneck",
  "dynamics.shunting": "dynamicsShunting",
  "legacy_v1": "legacyV1",
  "memory.dsr": "memoryDsr",
  "metacognition.belief": "metacognitionBelief",
  "rhythm.gate": "rhythmGate"
},
    files: {
  "attention.capacity": "../mechanisms/attention.capacity.js",
  "attention.ignition": "../mechanisms/attention.ignition.js",
  "attention.inhibition": "../mechanisms/attention.inhibition.js",
  "context.goal": "../mechanisms/context.goal.js",
  "control.planner": "../mechanisms/control.planner.js",
  "diagnosis.bottleneck": "../mechanisms/diagnosis.bottleneck.js",
  "dynamics.shunting": "../mechanisms/dynamics.shunting.js",
  "legacy_v1": "../mechanisms/legacy_v1.js",
  "memory.dsr": "../mechanisms/memory.dsr.js",
  "metacognition.belief": "../mechanisms/metacognition.belief.js",
  "rhythm.gate": "../mechanisms/rhythm.gate.js"
},
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
  else globalThis.MindNetMechanisms = manifest;
})();
