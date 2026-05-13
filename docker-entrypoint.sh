#!/bin/sh
set -e

echo "Running database migrations..."
cd /app
tsx src/storage/sqlite/migrate.ts

echo "Starting AI Agent Engine..."
exec node dist/main.js
