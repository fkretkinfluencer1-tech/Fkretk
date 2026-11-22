#!/usr/bin/env bash
set -uo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
failures=0
work_dir=''
remote=''
remote_dir=''
archive_name=''

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }

cleanup() {
  if [[ -n "$remote" && -n "$remote_dir" && -n "$archive_name" ]]; then
    ssh "$remote" "rm -f -- '$remote_dir/$archive_name'; rmdir -- '$remote_dir' 2>/dev/null || true" >/dev/null 2>&1 || true
  fi
  if [[ -n "$work_dir" ]]; then rm -rf -- "$work_dir"; fi
}
trap cleanup EXIT

if [[ "$(uname -s)" == Linux ]]; then pass 'Linux host'; else fail 'Linux host required'; exit 1; fi

missing_command=0
for command in age bash cmp find flock node realpath rsync ssh stat systemctl; do
  if command -v "$command" >/dev/null 2>&1; then pass "command: $command"; else fail "missing command: $command"; missing_command=1; fi
done
if [[ "$missing_command" -ne 0 ]]; then exit 1; fi

if node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"; then
  pass 'Node.js 24 or newer'
else
  fail 'Node.js 24 or newer required'
  exit 1
fi

if [[ -n "${FIKRATAK_AGE_RECIPIENT:-}" ]]; then pass 'age recipient configured'; else fail 'set FIKRATAK_AGE_RECIPIENT'; exit 1; fi
if [[ -n "${FIKRATAK_AGE_IDENTITY_FILE:-}" && -f "$FIKRATAK_AGE_IDENTITY_FILE" ]]; then
  pass 'age identity file available for this isolated restore test'
else
  fail 'set FIKRATAK_AGE_IDENTITY_FILE to the protected restore identity'
  exit 1
fi

verify_target="${FIKRATAK_VERIFY_REMOTE_TARGET:-}"
if [[ "$verify_target" =~ ^([A-Za-z0-9._-]+@[A-Za-z0-9.-]+):(/[A-Za-z0-9._/-]+)$ ]]; then
  remote="${BASH_REMATCH[1]}"
  base_remote_dir="${BASH_REMATCH[2]}"
  if [[ "$base_remote_dir" == "/" || "$base_remote_dir" =~ (^|/)\.\.?(/|$) ]]; then
    fail 'remote verification path must be a dedicated absolute path without dot segments'
    exit 1
  fi
  pass 'dedicated off-host verification target configured'
else
  fail 'set FIKRATAK_VERIFY_REMOTE_TARGET as user@host:/dedicated/test/path'
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/fikratak-linux-verify.XXXXXX")" || {
  fail 'could not create isolated temporary workspace'
  exit 1
}
data_dir="$work_dir/data"
backup_dir="$work_dir/backups"
mkdir -m 700 -- "$data_dir" "$backup_dir"
synthetic_db="$data_dir/fikratak.sqlite"

if node --input-type=module - "$synthetic_db" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[2]);
database.exec('CREATE TABLE synthetic_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
database.prepare('INSERT INTO synthetic_probe (label) VALUES (?)').run('synthetic-only-backup-check');
database.close();
NODE
then
  pass 'created a synthetic-only SQLite database'
else
  fail 'could not create a synthetic SQLite database'
  exit 1
fi

if [[ "$(stat -c '%a' "$data_dir")" == 700 ]]; then pass 'synthetic data directory mode 700'; else fail 'synthetic data directory mode is not 700'; fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
remote_dir="$base_remote_dir/fikratak-verify-$stamp"
offsite_target="$remote:$remote_dir"
if FIKRATAK_DATA_DIR="$data_dir" FIKRATAK_BACKUP_DIR="$backup_dir" \
  FIKRATAK_AGE_RECIPIENT="$FIKRATAK_AGE_RECIPIENT" FIKRATAK_OFFSITE_TARGET="$offsite_target" \
  bash "$script_dir/backup-offsite.sh"; then
  pass 'SQLite online backup, age encryption, and off-host rsync'
else
  fail 'backup-offsite.sh did not complete successfully'
fi

archive_path="$(find "$backup_dir" -maxdepth 1 -type f -name 'fikratak-sqlite-*.sqlite.age' -print -quit)"
if [[ -n "$archive_path" ]]; then
  archive_name="${archive_path##*/}"
  pass 'encrypted synthetic backup file exists'
  if [[ "$(stat -c '%a' "$archive_path")" == 600 ]]; then pass 'encrypted backup file mode 600'; else fail 'encrypted backup file mode is not 600'; fi
else
  fail 'encrypted backup file was not created'
fi

if [[ -n "$archive_name" ]] && ssh "$remote" "test -s '$remote_dir/$archive_name'"; then
  pass 'encrypted backup is present at the off-host target'
else
  fail 'encrypted backup was not verified at the off-host target'
fi

remote_copy="$work_dir/off-host-copy.sqlite.age"
if [[ -n "$archive_name" ]] && rsync --archive --protect-args -e ssh "$remote:$remote_dir/$archive_name" "$remote_copy"; then
  pass 'retrieved the encrypted archive from the off-host target'
else
  fail 'could not retrieve the encrypted archive from the off-host target'
fi

plain="$work_dir/decrypted.sqlite"
if [[ -f "$remote_copy" ]] && age --decrypt --identity "$FIKRATAK_AGE_IDENTITY_FILE" --output "$plain" "$remote_copy"; then
  pass 'age decryption succeeded'
  if node "$script_dir/sqlite-backup.mjs" validate "$plain"; then pass 'decrypted SQLite integrity checks'; else fail 'decrypted SQLite integrity check failed'; fi
else
  fail 'could not decrypt the off-host archive'
fi

restore_dir="$work_dir/restored-data"
if [[ -f "$remote_copy" ]] && FIKRATAK_DATA_DIR="$data_dir" FIKRATAK_BACKUP_DIR="$backup_dir" \
  FIKRATAK_AGE_IDENTITY_FILE="$FIKRATAK_AGE_IDENTITY_FILE" \
  FIKRATAK_RESTORE_DATA_DIR="$restore_dir" FIKRATAK_RESTORE_BACKUP_DIR="$work_dir/restore-backups" \
  bash "$script_dir/restore-offsite.sh" "$remote_copy"; then
  pass 'restore-offsite.sh restored the off-host synthetic archive'
  if node --input-type=module - "$restore_dir/fikratak.sqlite" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[2], { readOnly: true });
const value = database.prepare('SELECT label FROM synthetic_probe WHERE id = 1').get()?.label;
database.close();
if (value !== 'synthetic-only-backup-check') process.exit(1);
NODE
  then pass 'restored database contains the expected synthetic row'; else fail 'restored synthetic row did not match'; fi
else
  fail 'restore-offsite.sh failed'
fi

if systemctl is-enabled --quiet fikratak-backup.timer && systemctl is-active --quiet fikratak-backup.timer; then
  pass 'systemd backup timer is enabled and active'
else
  fail 'systemd backup timer is not both enabled and active'
fi
if systemctl list-timers --all --no-pager fikratak-backup.timer 2>/dev/null | grep -q 'fikratak-backup.timer'; then
  pass 'systemd reports the backup timer schedule'
else
  fail 'systemd did not report the backup timer schedule'
fi

if [[ "$failures" -eq 0 ]]; then
  printf 'RESULT: PASS (all Linux operational checks passed)\n'
else
  printf 'RESULT: FAIL (%s check(s) failed)\n' "$failures"
  exit 1
fi
