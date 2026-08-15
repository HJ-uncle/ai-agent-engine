#!/bin/bash

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${RED}[Stop]${NC} Stopping Aether Engine services..."

if [ -f .proxy.pid ]; then
    PROXY_PID=$(cat .proxy.pid)
    if ps -p $PROXY_PID > /dev/null 2>&1; then
        kill $PROXY_PID 2>/dev/null || true
        echo -e "${GREEN}[Stop]${NC} Proxy (PID $PROXY_PID) stopped"
    else
        echo -e "${RED}[Stop]${NC} Proxy process not found"
    fi
    rm -f .proxy.pid
fi

if [ -f .backend.pid ]; then
    BACKEND_PID=$(cat .backend.pid)
    if ps -p $BACKEND_PID > /dev/null 2>&1; then
        kill $BACKEND_PID 2>/dev/null || true
        echo -e "${GREEN}[Stop]${NC} Backend (PID $BACKEND_PID) stopped"
    else
        echo -e "${RED}[Stop]${NC} Backend process not found"
    fi
    rm -f .backend.pid
fi

PROXY_PORT=${PROXY_PORT:-8080}
BACKEND_PORT=${BACKEND_PORT:-12323}
BACKEND_PROD_PORT=${BACKEND_PROD_PORT:-8081}

echo -e "${RED}[Stop]${NC} Checking for any remaining processes on ports $PROXY_PORT, $BACKEND_PORT, $BACKEND_PROD_PORT..."
lsof -ti :$PROXY_PORT | xargs kill -9 2>/dev/null || true
lsof -ti :$BACKEND_PORT | xargs kill -9 2>/dev/null || true
lsof -ti :$BACKEND_PROD_PORT | xargs kill -9 2>/dev/null || true

echo -e "${GREEN}[Done]${NC} All services stopped"
