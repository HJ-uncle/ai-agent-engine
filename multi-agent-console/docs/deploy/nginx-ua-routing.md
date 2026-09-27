# Nginx 移动端 UA 自动分流配置

## 原理

根据 `User-Agent` 判断访客是否来自移动设备，自动内部跳转到 `/m.html`，桌面访客继续使用 `/index.html`。

## 基础配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /var/www/multi-agent-console;

    # ── UA 分流变量 ──────────────────────────────────────────────────────
    set $mobile_redirect 0;
    if ($http_user_agent ~* "(android|iphone|ipod|blackberry|webos|windows phone|iemobile|opera mini|mobile)") {
        set $mobile_redirect 1;
    }
    # iPad 按需分流（可选，取消注释则 iPad 走移动端）
    # if ($http_user_agent ~* "ipad") {
    #     set $mobile_redirect 1;
    # }

    # ── 根路径分流 ───────────────────────────────────────────────────────
    location = / {
        if ($mobile_redirect = 1) {
            # 内部重写到 m.html（不改浏览器地址栏）
            rewrite ^ /m.html last;
        }
        try_files /index.html =404;
    }

    # ── 桌面 SPA fallback ────────────────────────────────────────────────
    location / {
        # 移动端通过 /m/ 前缀访问，交给 m.html
        if ($request_uri ~* "^/m(/|$)") {
            rewrite ^ /m.html last;
        }
        try_files $uri $uri/ /index.html;
    }

    # ── 静态资源缓存 ─────────────────────────────────────────────────────
    location /static/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # ── 单独暴露 m.html 入口（方便分享直链） ────────────────────────────
    location = /m.html {
        add_header X-Frame-Options SAMEORIGIN;
        try_files /m.html =404;
    }
}
```

## HTTPS 强制跳转版本

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/ssl/certs/your-domain.crt;
    ssl_certificate_key /etc/ssl/private/your-domain.key;

    root /var/www/multi-agent-console;

    set $mobile_redirect 0;
    if ($http_user_agent ~* "(android|iphone|ipod|blackberry|webos|windows phone|iemobile|opera mini|mobile)") {
        set $mobile_redirect 1;
    }

    location = / {
        if ($mobile_redirect = 1) {
            rewrite ^ /m.html last;
        }
        try_files /index.html =404;
    }

    location / {
        if ($request_uri ~* "^/m(/|$)") {
            rewrite ^ /m.html last;
        }
        try_files $uri $uri/ /index.html;
    }

    location /static/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

## 本地开发访问方式

| 端   | 地址                            | 说明                    |
|------|---------------------------------|-------------------------|
| 桌面 | `http://localhost:3000/`        | 走 `index.html`          |
| 移动 | `http://localhost:3000/m.html`  | 直接访问移动入口         |
| 移动 | `http://localhost:3000/m/chat`  | devServer historyFallback 重写到 `/m.html` |

> 在 Chrome DevTools → 切换 iPhone 12 仿真后刷新即可模拟移动端体验。

## 构建产物结构

```
build/
├── index.html          ← 桌面入口（引用 main.*.js + vendor.*.js + core.*.js）
├── m.html              ← 移动入口（引用 mobile.*.js + core.*.js）
└── static/
    └── js/
        ├── main.*.js       ← 桌面专属（含 Monaco、xterm）
        ├── mobile.*.js     ← 移动专属（antd-mobile UI）
        ├── core.*.js       ← 共享核心（store、api、hooks）
        └── vendor.*.js     ← node_modules 公共依赖
```
