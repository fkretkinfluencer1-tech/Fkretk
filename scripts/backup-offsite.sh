#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${FIKRATAK_DATA_DIR:?Set FIKRATAK_DATA_DIR}"
: "${FIKRATAK_BACKUP_DIR:?Set FIKRATAK_BACKUP_DIR}"
: "${FIKRATAK_AGE_RECIPIENT:?Set FIKRATAK_AGE_RECIPIENT to the off-host age public key}"
: "${FIKRATAK_OFFSITE_TARGET:?Set FIKRATAK_OFFSITE_TARGET to user@host:/dedicated/backup/path}"

for command in age flock node rsync ssh find; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command not found: $command" >&2; exit 1; }
done

if [[ ! "$FIKRATAK_OFFSITE_TARGET" =~ ^([A-Za-z0-9._-]+@[A-Za-z0-9.-]+):(/[A-Za-z0-9._/-]+)$ ]]; then
  echo "FIKRATAK_OFFSITE_TARGET must be user@host:/absolute/dedicated/path." >&2
  exit 1
fi
remote="${BASH_REMATCH[1]}"
remote_dir="${BASH_REMATCH[2]}"
if [[ "$remote_dir" =~ (^|/)\.\.?(/|$) ]]; then
  echo "The offsite path must not contain dot segments." >&2
  exit 1
fi

database="$FIKRATAK_DATA_DIR/fikratak.sqlite"
[[ -f "$database" ]] || { echo "SQLite database not found: $database" >&2; exit 1; }
mkdir -p -- "$FIKRATAK_BACKUP_DIR"
chmod 700 -- "$FIKRATAK_BACKUP_DIR"
exec 9>"$FIKRATAK_BACKUP_DIR/.offsite-backup.lock"
flock -n 9 || { echo "An offsite backup is already running." >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
plain="$FIKRATAK_BACKUP_DIR/.fikratak-sqlite-$stamp.$$.sqlite"
encrypted_tmp="$FIKRATAK_BACKUP_DIR/.fikratak-sqlite-$stamp.$$.age.tmp"
encrypted="$FIKRATAK_BACKUP_DIR/fikratak-sqlite-$stamp.sqlite.age"
cleanup() { rm -f -- "$plain" "$encrypted_tmp"; }
trap cleanup EXIT

node "$(dirname "$0")/sqlite-backup.mjs" create "$database" "$plain"
age --recipient "$FIKRATAK_AGE_RECIPIENT" --output "$encrypted_tmp" "$plain"
chmod 600 -- "$encrypted_tmp"
mv -- "$encrypted_tmp" "$encrypted"
ssh "$remote" "umask 077; mkdir -p -- '$remote_dir'; chmod 700 -- '$remote_dir'"
rsync --archive --protect-args -e ssh "$encrypted" "$FIKRATAK_OFFSITE_TARGET/"
ssh "$remote" "find '$remote_dir' -maxdepth 1 -type f -name 'fikratak-sqlite-*.sqlite.age' -mmin +43200 -delete"
find "$FIKRATAK_BACKUP_DIR" -maxdepth 1 -type f -name 'fikratak-sqlite-*.sqlite.age' -mmin +43200 -delete
echo "Encrypted SQLite backup copied off-host; 30-day retention applied."
