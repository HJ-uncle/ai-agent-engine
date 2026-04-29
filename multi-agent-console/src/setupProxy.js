const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  app.use(
    createProxyMiddleware({
      pathFilter: '/api',
      target: 'http://localhost:12323',
      changeOrigin: true,
      ws: true,          // ← 代理 WebSocket upgrade（终端功能必须）
      onProxyReq: (proxyReq, req, res) => {
        res.setHeader('X-Accel-Buffering', 'no');
      },
      onProxyRes: (proxyRes) => {
        proxyRes.headers['Cache-Control'] = 'no-cache';
        proxyRes.headers['X-Accel-Buffering'] = 'no';
      }
    })
  );
};
