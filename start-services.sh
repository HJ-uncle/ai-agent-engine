#!/bin/bash

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

MODE=${1:-production}

print_step() {
    echo -e "${CYAN}[Step]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[Success]${NC} $1"
}

print_error() {
    echo -e "${RED}[Error]${NC} $1"
}

print_info() {
    echo -e "${YELLOW}[Info]${NC} $1"
}

check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

kill_pid_file() {
    local pid_file=$1
    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if ps -p $pid > /dev/null 2>&1; then
            kill $pid 2>/dev/null || true
            sleep 1
        fi
        rm -f "$pid_file"
    fi
}

kill_port() {
    local port=$1
    if check_port $port; then
        print_info "Port $port is in use, killing..."
        lsof -ti :$port | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
}

stop_all() {
    print_info "Stopping all services..."
    kill_pid_file "$PROJECT_ROOT/.backend.pid"
    kill_pid_file "$PROJECT_ROOT/.frontend.pid"
    kill_pid_file "$PROJECT_ROOT/.proxy.pid"
    kill_port $BACKEND_PORT
    kill_port $FRONTEND_PORT
    kill_port $PROXY_PORT
    print_success "All services stopped"
}

PROXY_PORT=${PROXY_PORT:-8080}
BACKEND_PORT=${BACKEND_PORT:-12323}
BACKEND_PROD_PORT=${BACKEND_PROD_PORT:-8081}
FRONTEND_PORT=${FRONTEND_PORT:-3000}

case "$MODE" in
    dev|development)
        echo -e "${CYAN}========================================${NC}"
        echo -e "${CYAN}  Development Mode${NC}"
        echo -e "${CYAN}========================================${NC}"
        echo ""

        stop_all

        print_step "Step 1: Starting backend (dev mode with hot reload)..."
        cd "$PROJECT_ROOT"
        kill_port $BACKEND_PORT
        nohup env PORT=$BACKEND_PORT npm run dev > logs/backend-dev.log 2>&1 &
        BACKEND_PID=$!
        echo $BACKEND_PID > .backend.pid
        print_success "Backend started with PID $BACKEND_PID on port $BACKEND_PORT"

        sleep 3

        print_step "Step 2: Starting frontend (dev mode with hot reload)..."
        cd "$PROJECT_ROOT/multi-agent-console"
        kill_port $FRONTEND_PORT
        nohup npm start > ../logs/frontend-dev.log 2>&1 &
        FRONTEND_PID=$!
        echo $FRONTEND_PID > "$PROJECT_ROOT/.frontend.pid"
        print_success "Frontend started with PID $FRONTEND_PID on port $FRONTEND_PORT"

        sleep 5

        print_success "========================================"
        print_success "Development services started!"
        print_success "========================================"
        echo ""
        echo -e "  ${CYAN}Frontend:${NC}  http://localhost:$FRONTEND_PORT"
        echo -e "  ${CYAN}Backend:${NC}   http://localhost:$BACKEND_PORT"
        echo ""
        echo -e "Frontend dev server proxies /api/* to backend automatically"
        echo ""
        echo -e "Logs:"
        echo -e "  Backend:  $PROJECT_ROOT/logs/backend-dev.log"
        echo -e "  Frontend: $PROJECT_ROOT/logs/frontend-dev.log"
        echo ""
        echo -e "To stop: ./stop-services.sh"
        echo ""
        ;;

    prod|production)
        echo -e "${CYAN}========================================${NC}"
        echo -e "${CYAN}  Production Mode${NC}"
        echo -e "${CYAN}========================================${NC}"
        echo ""

        stop_all

        print_step "Step 1: Building backend..."
        cd "$PROJECT_ROOT"
        if npm run build 2>&1; then
            print_success "Backend built successfully"
        else
            print_error "Backend build failed"
            exit 1
        fi

        print_step "Step 2: Building frontend..."
        cd "$PROJECT_ROOT/multi-agent-console"
        if npm run build 2>&1; then
            print_success "Frontend built successfully"
        else
            print_error "Frontend build failed"
            exit 1
        fi

        cd "$PROJECT_ROOT"

        print_step "Step 3: Starting backend server (port $BACKEND_PROD_PORT)..."
        kill_port $BACKEND_PROD_PORT
        nohup env PORT=$BACKEND_PROD_PORT node dist/main.js > logs/backend.log 2>&1 &
        BACKEND_PID=$!
        echo $BACKEND_PID > .backend.pid
        print_success "Backend started with PID $BACKEND_PID"

        sleep 3

        if ! ps -p $BACKEND_PID > /dev/null 2>&1; then
            print_error "Backend failed to start. Check logs/backend.log"
            cat logs/backend.log
            exit 1
        fi

        print_step "Step 4: Starting proxy server (port $PROXY_PORT)..."
        kill_port $PROXY_PORT
        nohup env PROXY_PORT=$PROXY_PORT BACKEND_PORT=$BACKEND_PROD_PORT node proxy-server.js > logs/proxy.log 2>&1 &
        PROXY_PID=$!
        echo $PROXY_PID > .proxy.pid
        print_success "Proxy server started with PID $PROXY_PID"

        sleep 2

        print_success "========================================"
        print_success "Production services started!"
        print_success "========================================"
        echo ""
        echo -e "  ${CYAN}统一入口:${NC}  http://localhost:$PROXY_PORT"
        echo ""
        echo -e "  ${CYAN}Backend:${NC}   http://localhost:$BACKEND_PROD_PORT (internal)"
        echo ""
        echo -e "Proxy PID:   $PROXY_PID"
        echo -e "Backend PID: $BACKEND_PID"
        echo ""
        echo -e "Logs:"
        echo -e "  Proxy:   $PROJECT_ROOT/logs/proxy.log"
        echo -e "  Backend: $PROJECT_ROOT/logs/backend.log"
        echo ""
        echo -e "To stop: ./stop-services.sh"
        echo ""
        ;;

    stop)
        stop_all
        ;;

    *)
        echo -e "${RED}Usage:${NC} $0 {dev|prod|stop}"
        echo ""
        echo -e "  ${GREEN}dev${NC}    - Development mode (hot reload)"
        echo -e "  ${GREEN}prod${NC}   - Production mode (build & serve)"
        echo -e "  ${GREEN}stop${NC}   - Stop all services"
        exit 1
        ;;
esac

cd "$PROJECT_ROOT"
