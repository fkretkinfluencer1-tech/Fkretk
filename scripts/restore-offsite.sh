#!/usr/bin/env bash
set -euo pipefail
umask 077

archive="${1:-}"
: "${FIKRATAK_DATA_DIR:?Set FIKRATAK_DATA_DIR}"
: "${FIKRATAK_BACKUP_DIR:?Set FIKRATAK_BACKUP_DIR}"
: "${FIKRATAK_AGE_IDENTITY_FILE:?Set FIKRATAK_AGE_IDENTITY_FILE to the protected age private identity file}"
[[ -n "$archive" && -f "$archive" ]] || { echo "Usage: scripts/restore-offsite.sh <encrypted-backup.age>" >&2; exit 1; }
[[ -f "$FIKRATAK_AGE_IDENTITY_FILE" ]] || { echo "age identity file not found." >&2; exit 1; }
data_dir="${FIKRATAK_RESTORE_DATA_DIR:-$FIKRATAK_DATA_DIR}"
production_data_dir="$(realpath -m -- "$FIKRATAK_DATA_DIR")"
target_data_dir="$(realpath -m -- "$data_dir")"
if [[ "$target_data_dir" == "$production_data_dir" ]]; then
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required for a production restore." >&2; exit 1; }
  if systemctl is-active --quiet fikratak; then
    echo "Stop fikratak.service before restoring." >&2
    exit 1
  fi
fi
backup_dir="${FIKRATAK_RESTORE_BACKUP_DIR:-$FIKRATAK_BACKUP_DIR}"
if [[ "$target_data_dir" != "$production_data_dir" && -z "${FIKRATAK_RESTORE_BACKUP_DIR:-}" ]]; then
  backup_dir="$target_data_dir/backups"
fi
database="$target_data_dir/fikratak.sqlite"
mkdir -p -- "$target_data_dir" "$backup_dir"
chmod 700 -- "$target_data_dir" "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
plain="$target_data_dir/.fikratak-restore-$stamp.$$.sqlite"
stage="$target_data_dir/.fikratak-restored-$stamp.$$.sqlite"
previous="$target_data_dir/fikratak.sqlite.pre-restore-$stamp"
pre_restore="$backup_dir/fikratak-before-restore-$stamp.sqlite"
cleanup() { rm -f -- "$plain" "$stage"; }
trap cleanup EXIT

if [[ -e "$database-wal" || -e "$database-shm" ]]; then
  echo "SQLite sidecar files exist. Investigate them before restoring; do not delete them blindly." >&2
  exit 1
fi
age --decrypt --identity "$FIKRATAK_AGE_IDENTITY_FILE" --output "$plain" "$archive"
node "$(dirname "$0")/sqlite-backup.mjs" validate "$plain"
if [[ -f "$database" ]]; then
  node "$(dirname "$0")/sqlite-backup.mjs" create "$database" "$pre_restore"
fi
node "$(dirname "$0")/sqlite-backup.mjs" restore "$plain" "$stage"
chmod 600 -- "$stage"
if [[ -f "$database" ]]; then mv -- "$database" "$previous"; fi
if ! mv -- "$stage" "$database"; then
  if [[ -f "$previous" ]]; then mv -- "$previous" "$database"; fi
  exit 1
fi
echo "Restore complete and validated: $database"
if [[ -f "$previous" ]]; then echo "Previous database preserved at: $previous"; fi
if [[ -f "$pre_restore" ]]; then echo "Pre-restore backup preserved at: $pre_restore"; fi
