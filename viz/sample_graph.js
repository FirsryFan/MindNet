/**
 * 本文件由 viz/build_samples.js 自动生成，请勿手改。
 * 数据来源：mindnet/example/*.json —— 生成时间 2026-09-19T13:28:10.329Z
 */
(function () {
  'use strict';
  const samples = {
  "demo_learning": {
    "graph": {
      "nodes": [
        {
          "id": "trig_func",
          "name": "三角函数定义",
          "type": "knowledge",
          "weight": 0.9,
          "ms": 0.9,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "unit_circle",
          "name": "单位圆",
          "type": "knowledge",
          "weight": 0.7,
          "ms": 0.8,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "radian",
          "name": "弧度制",
          "type": "knowledge",
          "weight": 0.6,
          "ms": 0.75,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "sine_law",
          "name": "正弦定理",
          "type": "knowledge",
          "weight": 0.8,
          "ms": 0.7,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "cosine_law",
          "name": "余弦定理",
          "type": "knowledge",
          "weight": 0.8,
          "ms": 0.65,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "area_formula",
          "name": "面积公式",
          "type": "knowledge",
          "weight": 0.5,
          "ms": 0.5,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "solve_triangle",
          "name": "解三角形",
          "type": "logic",
          "weight": 0.9,
          "ms": 0.55,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "vector",
          "name": "向量法",
          "type": "technique",
          "weight": 0.6,
          "ms": 0.35,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "coordinate",
          "name": "坐标法",
          "type": "technique",
          "weight": 0.5,
          "ms": 0.3,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "polar",
          "name": "极坐标（死角）",
          "type": "technique",
          "weight": 0.4,
          "ms": 0.15,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        }
      ],
      "edges": [
        {
          "id": "e1",
          "from": "trig_func",
          "to": "unit_circle",
          "ls": 0.9
        },
        {
          "id": "e2",
          "from": "trig_func",
          "to": "radian",
          "ls": 0.8
        },
        {
          "id": "e3",
          "from": "trig_func",
          "to": "cosine_law",
          "ls": 0.7
        },
        {
          "id": "e4",
          "from": "unit_circle",
          "to": "sine_law",
          "ls": 0.8
        },
        {
          "id": "e5",
          "from": "radian",
          "to": "sine_law",
          "ls": 0.6
        },
        {
          "id": "e6",
          "from": "sine_law",
          "to": "solve_triangle",
          "ls": 0.9
        },
        {
          "id": "e7",
          "from": "cosine_law",
          "to": "solve_triangle",
          "ls": 0.85
        },
        {
          "id": "e8",
          "from": "sine_law",
          "to": "area_formula",
          "ls": 0.7
        },
        {
          "id": "e9",
          "from": "cosine_law",
          "to": "vector",
          "ls": 0.5
        },
        {
          "id": "e10",
          "from": "vector",
          "to": "coordinate",
          "ls": 0.6
        },
        {
          "id": "e11",
          "from": "coordinate",
          "to": "polar",
          "ls": 0.3
        }
      ]
    },
    "initial_nodes": [
      "trig_func"
    ],
    "target_nodes": [
      "solve_triangle",
      "polar"
    ]
  },
  "graph": {
    "graph": {
      "nodes": [
        {
          "id": "node_1",
          "name": "三角函数",
          "type": "knowledge",
          "weight": 0.9,
          "ms": 0.8,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        },
        {
          "id": "node_2",
          "name": "正弦定理",
          "type": "knowledge",
          "weight": 0.7,
          "ms": 0.6,
          "ct": 0.3,
          "st": 0.05,
          "last_review_time": 0
        }
      ],
      "edges": [
        {
          "id": "edge_1",
          "from": "node_1",
          "to": "node_2",
          "ls": 0.8
        }
      ]
    },
    "initial_nodes": [
      "node_1"
    ],
    "target_nodes": [
      "node_2"
    ]
  }
};
  if (typeof module !== 'undefined' && module.exports) module.exports = samples;
  else globalThis.MindNetSamples = samples;
})();
