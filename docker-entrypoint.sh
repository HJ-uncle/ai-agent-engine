#!/bin/sh
set -e

echo "Running database migrations..."
cd /app
tsx src/storage/sqlite/migrate.ts

echo "Starting Aether Engine..."
exec node dist/main.js
