import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '8081', 10);
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${BACKEND_PORT}`;
const FRONTEND_BUILD = path.join(__dirname, 'multi-agent-console', 'build');

function serveStatic(req, res) {
    let filePath = path.join(FRONTEND_BUILD, req.url === '/' ? 'index.html' : req.url);

    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                fs.readFile(path.join(FRONTEND_BUILD, 'index.html'), (err2, data2) => {
                    if (err2) {
                        res.writeHead(404);
                        res.end('Not Found');
                    } else {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(data2);
                    }
                });
            } else {
                res.writeHead(500);
                res.end('Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
}

function proxyRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PROXY_PORT}`);

    const proxyReq = http.request(
        BACKEND_URL + url.pathname + url.search,
        {
            method: req.method,
            headers: { ...req.headers, host: new URL(BACKEND_URL).host },
        },
        (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        }
    );

    proxyReq.on('error', () => {
        res.writeHead(502);
        res.end('Bad Gateway');
    });

    req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PROXY_PORT}`);

    if (url.pathname.startsWith('/api')) {
        proxyRequest(req, res);
    } else {
        serveStatic(req, res);
    }
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`Proxy server running at http://localhost:${PROXY_PORT}`);
    console.log(`  -> /api/* proxy to ${BACKEND_URL}`);
    console.log(`  -> /* served from ${FRONTEND_BUILD}`);
});
