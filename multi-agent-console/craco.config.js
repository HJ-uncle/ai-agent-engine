const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin')

const PUBLIC_PATH = path.resolve(__dirname, 'public')

module.exports = {
  webpack: {
    alias: {
      '@core':   path.resolve(__dirname, 'src/core'),
      '@web':    path.resolve(__dirname, 'src/web'),
      '@mobile': path.resolve(__dirname, 'src/mobile'),
    },
    plugins: {
      add: [
        // Monaco workers（仅桌面入口实际加载；MonacoWebpackPlugin 会在 entry 里
        // 注入 globals，移动入口不 import Monaco 也就不会加载 worker）
        new MonacoWebpackPlugin({
          languages: [
            'typescript', 'javascript', 'json', 'html', 'css', 'scss',
            'less', 'markdown', 'python', 'java', 'csharp', 'cpp', 'c',
            'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala',
            'shell', 'bash', 'powershell', 'sql', 'xml', 'yaml', 'toml',
            'dockerfile', 'graphql', 'plaintext', 'ini', 'r', 'julia',
            'lua', 'perl', 'elixir', 'erlang', 'haskell', 'clojure',
            'fsharp', 'vb', 'dart', 'groovy', 'objective-c', 'coffeescript',
            'handlebars', 'pug', 'razor', 'twig', 'proto', 'apex',
          ],
          filename: 'static/js/[name].worker.js',
        }),
      ],
    },
    configure: (webpackConfig, { env }) => {
      const isProd = env === 'production'

      // ── 1. 多入口 ────────────────────────────────────────────────
      // CRA 默认 entry 是 src/index.tsx；我们改成 web + mobile 两个。
      webpackConfig.entry = {
        main:   path.resolve(__dirname, 'src/web/index.tsx'),
        mobile: path.resolve(__dirname, 'src/mobile/index.tsx'),
      }

      // 修改默认输出命名，避免 mobile chunk 与 main 冲突
      if (webpackConfig.output) {
        webpackConfig.output.filename = isProd
          ? 'static/js/[name].[contenthash:8].js'
          : 'static/js/[name].bundle.js'
      }

      // ── 2. 修正已存在的 HtmlWebpackPlugin 实例（main/index.html）──
      const existingHtmlPlugin = webpackConfig.plugins.find(
        (p) => p.constructor && p.constructor.name === 'HtmlWebpackPlugin',
      )
      if (existingHtmlPlugin) {
        // 原 CRA 注入所有 chunk，改成只注入 main
        existingHtmlPlugin.userOptions = {
          ...existingHtmlPlugin.userOptions,
          chunks: ['main'],
          template: path.join(PUBLIC_PATH, 'index.html'),
          filename: 'index.html',
        }
        // 兼容 html-webpack-plugin v5 内部字段
        existingHtmlPlugin.options = {
          ...existingHtmlPlugin.options,
          chunks: ['main'],
          template: path.join(PUBLIC_PATH, 'index.html'),
          filename: 'index.html',
        }
      }

      // ── 3. 追加 mobile 的 HtmlWebpackPlugin 实例 ─────────────────
      webpackConfig.plugins.push(
        new HtmlWebpackPlugin({
          inject: true,
          template: path.join(PUBLIC_PATH, 'm.html'),
          filename: 'm.html',
          chunks: ['mobile'],
          ...(isProd && {
            minify: {
              removeComments: true,
              collapseWhitespace: true,
              removeRedundantAttributes: true,
              useShortDoctype: true,
              removeEmptyAttributes: true,
              removeStyleLinkTypeAttributes: true,
              keepClosingSlash: true,
              minifyJS: true,
              minifyCSS: true,
              minifyURLs: true,
            },
          }),
        }),
      )

      // ── 4. splitChunks：共享 core chunk ──────────────────────────
      webpackConfig.optimization = webpackConfig.optimization || {}
      webpackConfig.optimization.splitChunks = {
        chunks: 'all',
        cacheGroups: {
          core: {
            test: /[\\/]src[\\/]core[\\/]/,
            name: 'core',
            priority: 30,
            enforce: true,
            reuseExistingChunk: true,
          },
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendor',
            priority: 20,
            reuseExistingChunk: true,
          },
          default: {
            minChunks: 2,
            priority: 10,
            reuseExistingChunk: true,
          },
        },
      }

      // CRA 默认 runtimeChunk: 'single' 会把 runtime 合并成单个 chunk，
      // 这会导致 index.html / m.html 都需要同一个 runtime。改为 per-entry
      // 让每个入口拥有独立 runtime，避免两端相互干扰。
      webpackConfig.optimization.runtimeChunk = {
        name: (entrypoint) => `runtime-${entrypoint.name}`,
      }

      return webpackConfig
    },
  },

  // ── dev server：自动在 /m.html 下服务移动入口 ─────────────────
  devServer: (devServerConfig) => {
    // CRA 默认 historyApiFallback 只指向 /index.html；我们改成根据路径选择。
    devServerConfig.historyApiFallback = {
      rewrites: [
        { from: /^\/m(\/|$)/, to: '/m.html' },
        { from: /./,           to: '/index.html' },
      ],
    }
    return devServerConfig
  },
}
