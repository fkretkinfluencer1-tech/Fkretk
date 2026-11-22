#!/bin/sh
set -eu

: "${FIKRATAK_DATA_DIR:?Set FIKRATAK_DATA_DIR to an absolute path outside the application directory}"
: "${FIKRATAK_BACKUP_DIR:?Set FIKRATAK_BACKUP_DIR to an absolute path outside the application directory}"
: "${FIKRATAK_ALLOWED_ORIGINS:?Set FIKRATAK_ALLOWED_ORIGINS to the HTTPS application origin}"

export NODE_ENV=production
exec node "$(dirname "$0")/server.mjs"
