const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  app.use(
    createProxyMiddleware({
      pathFilter: '/api',
      target: 'http://localhost:3000',
      changeOrigin: true,
      onProxyReq: (proxyReq, req, res) => {
        // Disable proxy buffering for Nginx/other reverse proxies
        res.setHeader('X-Accel-Buffering', 'no');
      },
      onProxyRes: (proxyRes) => {
        // Set headers for SSE to not buffer in development server
        proxyRes.headers['Cache-Control'] = 'no-cache';
        proxyRes.headers['X-Accel-Buffering'] = 'no';
      }
    })
  );
};
