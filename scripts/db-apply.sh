#!/usr/bin/env bash
# Apply SQL migrations in order using psql, as the OWNER connection.
# Usage: DIRECT_DATABASE_URL=... scripts/db-apply.sh
#
# On a networked machine you would normally use `prisma migrate deploy`
# instead. This script exists so migrations can be applied where the Prisma
# engine binaries are unavailable (e.g. an offline/egress-restricted sandbox).
set -euo pipefail

URL="${1:-${DIRECT_DATABASE_URL:?set DIRECT_DATABASE_URL or pass a URL arg}}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/prisma/migrations"

for m in "$DIR"/0*/migration.sql; do
  echo ">> applying $(basename "$(dirname "$m")")"
  psql "$URL" -v ON_ERROR_STOP=1 -q -f "$m"
done
echo ">> migrations applied"
