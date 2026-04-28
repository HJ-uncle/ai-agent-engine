#!/bin/bash

# OIDC客户端注册脚本
# 用于在email-otp-oidc-auth-portal中注册multi-agent-console客户端

set -e

# 配置
OIDC_URL="${OIDC_URL:-http://localhost:3000}"
ADMIN_TOKEN="${ADMIN_TOKEN:-please-change-to-a-long-random-string}"
CLIENT_ID="${CLIENT_ID:-multi-agent-console}"
REDIRECT_URI="${REDIRECT_URI:-http://localhost:3001}"

echo "=========================================="
echo "OIDC客户端注册脚本"
echo "=========================================="
echo "OIDC服务地址: $OIDC_URL"
echo "客户端ID: $CLIENT_ID"
echo "回调地址: $REDIRECT_URI/callback"
echo "=========================================="

# 检查OIDC服务是否运行
echo "检查OIDC服务状态..."
if ! curl -s "$OIDC_URL/health" > /dev/null 2>&1; then
    echo "❌ OIDC服务未运行，请先启动email-otp-oidc-auth-portal"
    echo "   cd email-otp-oidc-auth-portal && npm run dev"
    exit 1
fi
echo "✅ OIDC服务运行正常"

# 注册客户端
echo ""
echo "注册客户端..."
RESPONSE=$(curl -s -X POST "$OIDC_URL/admin/clients" \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d "{
    \"id\": \"$CLIENT_ID\",
    \"name\": \"Multi-Agent Console\",
    \"redirectUris\": [\"$REDIRECT_URI/callback\"],
    \"scopes\": [\"openid\", \"email\"],
    \"enabled\": true
  }")

if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "✅ 客户端注册成功"
else
    echo "⚠️  客户端可能已存在，尝试更新..."
    curl -s -X PUT "$OIDC_URL/admin/clients/$CLIENT_ID" \
      -H "content-type: application/json" \
      -H "x-admin-token: $ADMIN_TOKEN" \
      -d "{
        \"name\": \"Multi-Agent Console\",
        \"redirectUris\": [\"$REDIRECT_URI/callback\"],
        \"scopes\": [\"openid\", \"email\"],
        \"enabled\": true
      }" > /dev/null
    echo "✅ 客户端更新成功"
fi

# 验证客户端
echo ""
echo "验证客户端..."
CLIENT_INFO=$(curl -s "$OIDC_URL/admin/clients" \
  -H "x-admin-token: $ADMIN_TOKEN")

if echo "$CLIENT_INFO" | grep -q "$CLIENT_ID"; then
    echo "✅ 客户端验证成功"
    echo ""
    echo "=========================================="
    echo "配置完成！"
    echo "=========================================="
    echo ""
    echo "下一步："
    echo "1. 启动后端服务："
    echo "   cd /Users/project/my/ai-agent-engine"
    echo "   npm run dev"
    echo ""
    echo "2. 启动前端服务："
    echo "   cd /Users/project/my/ai-agent-engine/multi-agent-console"
    echo "   npm start"
    echo ""
    echo "3. 访问前端：http://localhost:3001"
    echo ""
else
    echo "❌ 客户端验证失败"
    exit 1
fi
