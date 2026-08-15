# Performance Benchmarks

This document details the performance metrics and targets for the Aether Engine.

## Targets vs Actuals

| Metric | Target | Baseline (v1.0.0) | Status |
| :--- | :--- | :--- | :--- |
| Cold Start (API Ping) | < 2000ms | 45ms | ✅ |
| Large Folder Expand (50k files) | < 200ms | 112ms | ✅ |
| Ctrl+P Search (100k paths) | < 100ms | 28ms | ✅ |
| SSE Latency (First Frame) | < 150ms | 35ms | ✅ |

## Methodology
Benchmarks are executed using `npm run perf:bench` which runs `multi-agent-console/scripts/perf-benchmark.ts`. Tests are conducted on a standard CI runner (2 vCPU, 4GB RAM).
