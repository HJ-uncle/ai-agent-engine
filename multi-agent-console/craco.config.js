const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin')

module.exports = {
  webpack: {
    plugins: {
      add: [
        new MonacoWebpackPlugin({
          // 仅打包 top-50 常用语言，减少体积
          languages: [
            'typescript', 'javascript', 'json', 'html', 'css', 'scss',
            'less', 'markdown', 'python', 'java', 'csharp', 'cpp', 'c',
            'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala',
            'shell', 'bash', 'powershell', 'sql', 'xml', 'yaml', 'toml',
            'dockerfile', 'graphql', 'plaintext', 'ini', 'r', 'julia',
            'lua', 'perl', 'elixir', 'erlang', 'haskell', 'clojure',
            'fsharp', 'vb', 'dart', 'groovy', 'objective-c', 'coffeescript',
            'handlebars', 'pug', 'razor', 'twig', 'proto', 'apex'
          ],
          filename: 'static/js/[name].worker.js',
        }),
      ],
    },
  },
}
