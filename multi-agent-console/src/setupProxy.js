const { createProxyMiddleware } = require('http-proxy-middleware');
const os = require('os');

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

module.exports = function(app) {
  const proxyPort = process.env.REACT_APP_PROXY_PORT || 12323;
  const localIp = process.env.REACT_APP_PROXY_HOST || getLocalIpAddress();
  app.use(
    createProxyMiddleware({
      pathFilter: '/api',
      target: `http://${localIp}:${proxyPort}`,
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
