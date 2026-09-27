// CRA 默认入口转发。实际逻辑在 src/web/index.tsx。
// 4.1 接入 craco 多入口配置后，CRA 将直接以 src/web/index.tsx 为 main 入口，
// 此文件可被移除（见任务 3.6 / 4.1）。
import './web/index'
