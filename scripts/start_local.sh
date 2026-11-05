#!/bin/zsh
set -e
cd "$(dirname "$0")/.."
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"
export DATABASE_URL="${DATABASE_URL:-dbname=annsetu}"
PGDATA="$HOME/Library/Application Support/Postgres/var-18"
if ! pg_isready -q; then pg_ctl -D "$PGDATA" -l "$PWD/work-postgres.log" start; fi
exec .venv/bin/uvicorn pg_api:app --app-dir backend --host 127.0.0.1 --port 8000
