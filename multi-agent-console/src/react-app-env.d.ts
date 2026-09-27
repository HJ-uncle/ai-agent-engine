/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_NEW_EXPLORER: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'react-file-icon';
declare module 'highlight.js';

// 允许直接 import CSS 文件作为副作用（无返回值）
declare module '*.css';
declare module 'katex/dist/katex.min.css';
declare module 'highlight.js/styles/*.css';
declare module 'highlight.js/styles/github-dark.css';
