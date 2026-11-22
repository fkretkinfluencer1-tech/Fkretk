# FKRETK Influencer CRM — Production Deployment

For the bilingual copy/paste launch checklist and current GO/NO-GO verdict, see [`docs/DEPLOYMENT_RUNBOOK.md`](./docs/DEPLOYMENT_RUNBOOK.md).
For login lockout recovery, first-admin setup, forgotten-admin recovery, safe log review, and proxy trust details, see [`docs/LOGIN-OPERATIONS.md`](./docs/LOGIN-OPERATIONS.md).

This application uses Node.js built-ins and SQLite (`node:sqlite`); it has no runtime npm dependencies. Use Node.js 24 or newer. The app serves only an explicit allowlist of pages and assets; do not configure a web server to expose the release directory as a document root.

## Required deployment decisions

Before provisioning, choose the server OS, public HTTPS hostname, TLS termination point, persistent data volume, backup volume, and a tested backup retention policy. The examples under `deploy/` assume a Linux host with systemd and Nginx; adapt them for other platforms. `start-production.cmd` is provided for Windows, but service supervision, ACLs, and TLS must be configured using the server’s approved Windows service and web-server tools. No public deployment, DNS change, or TLS certificate is performed by this project.

Use one application process and one persistent local filesystem for SQLite. Sessions and rate limits are held in memory, so multiple workers/instances are not supported. The Node process should remain bound to loopback behind a reverse proxy unless a separate private network and firewall are deliberately configured.

## Provision and configure

1. Install Node.js 24+ and copy only `production-release/` to a non-public application directory such as `/opt/fikratak`.
2. Create dedicated OS user/group `fikratak`. Create persistent data and backup directories outside the application directory (example: `/var/lib/fikratak/data` and `/var/backups/fikratak`) with `install -d -o fikratak -g fikratak -m 0700 /var/lib/fikratak/data /var/backups/fikratak`. The database and backup files must be mode `0600`; keep the backup volume encrypted and separately monitored.
3. Copy `.env.example` to a protected environment file such as `/etc/fikratak/fikratak.env`; replace the example hostname and paths. Set mode `0600`, owner `fikratak`, and do not commit the file. Node does not automatically load `.env`; systemd or the hosting platform must inject these variables.
4. Configure TLS at the reverse proxy. Keep `FIKRATAK_HOST=127.0.0.1` for a same-host proxy. If the proxy is on a different private host/container, bind only to its private interface and firewall the port.
5. Start with a **new, empty database**. Do not copy or restore the local database. The release builder and ZIP exclude `data/` and database files. On first start the application creates the SQLite file, schema, indexes, triggers, and code-defined default catalogs in `FIKRATAK_DATA_DIR`; it does not transfer local users or business data. Before upload, run `npm run verify:release` from the development checkout; it tests the generated release using temporary data. The verifier is not included in production.
6. Create the first production administrator using either the one-time web setup or the terminal utility:
   - With a private terminal, after the first start creates the empty database, run `sudo -u fikratak env FIKRATAK_DATA_DIR=/var/lib/fikratak/data node /opt/fikratak/scripts/create-first-admin.mjs`. It prompts for the username and hidden password twice, and refuses if any user already exists. No setup token is needed.
   - Generate at least 32 cryptographically random bytes (for example, `openssl rand -hex 32`) using a private terminal.
   - Put it in the protected service environment as `FIKRATAK_SETUP_TOKEN`, restart the service, then enter that same token in the setup screen over HTTPS within 30 minutes.
   - Setup attempts are limited to five per source address in 15 minutes. If the token expires, replace it and restart. After the first admin is created, `/api/setup` returns HTTP 409 even if the token is still set; remove the variable and restart immediately. Do not send the token in URLs, logs, or shared chat.
   - In production, setup also requires an exact HTTPS `Origin` in `FIKRATAK_ALLOWED_ORIGINS`. The endpoint checks that the users table is still empty both before password hashing and again inside a write transaction. Without the token, a stranger cannot claim the admin account.
7. Leave production importing disabled (`FIKRATAK_IMPORT_ENABLED=0`) until the backup destination and first-import rehearsal are ready. See “First production data load” below; enable it only for the planned import window.
8. Configure `deploy/nginx.conf.example` for the real hostname and certificate paths, then enable the site. Set `FIKRATAK_ALLOWED_ORIGINS` to the exact public HTTPS origin opened in the browser, for example `https://crm.example.com` (no path or trailing application route). Origins with and without `www` are different; list both explicitly, comma-separated, only if both are intentionally served. Nginx must proxy the original Host and overwrite `X-Forwarded-For` with `$remote_addr`. Only list its actual source IPs in `FIKRATAK_TRUSTED_PROXIES`; never trust client-provided forwarding headers.
9. On Linux, install `deploy/fikratak.service.example` as a systemd unit after changing its paths/user to match the server. Enable restart-on-failure and review `journalctl -u fikratak` after startup. On Windows, run `start-production.cmd` under a dedicated service account and configure the approved service manager to restart on failure.

`FIKRATAK_DATA_DIR` and `FIKRATAK_BACKUP_DIR` must be absolute paths outside the application directory. The production process uses umask `077`; the application creates data and backup directories with mode `0700`. Explicitly apply owner `fikratak:fikratak`, directory mode `0700`, and file mode `0600` to any pre-existing paths.

### What a fresh server does not inherit

The package contains application code, static defaults, and blank templates only. A fresh SQLite database does **not** carry over any local database contents:

- User accounts, roles, password hashes, and existing sessions.
- Influencer records, contact details, social accounts, profile images, unknown imported columns, follower history, status history, notes, and import batches/undo history.
- Client accounts, client catalog records/tokens/items, portal configuration, inquiries, decisions, activity, feedback, and client-side files.
- Campaigns, schedules, targets, campaign workspaces/briefs, advertiser and influencer notes, presentations, uploaded campaign files, check-ins, and related histories.
- User-added interest catalog entries, custom app settings, company/brand settings, saved identity customizations, audit history, and password-reset data. Code-defined default interest choices and static brand assets are shipped with the release.

Recreate user accounts and all business records/settings in production. Code-defined system identity, application defaults, and shipped brand assets remain in the release; any customized database-backed versions do not.

First-day production admin checklist: (1) create the first admin with the one-time setup token; (2) remove the setup token and restart; (3) sign in and set production brand/company identity and catalogs; (4) create users with least privilege; (5) configure off-host encrypted backups and verify one backup; (6) rehearse import with synthetic records; (7) take a fresh backup and perform the first real import; (8) disable imports again and review audit/import counts.

## Updates, migrations, backup, and restore

The app applies compatible schema migrations at startup. Before every release that may migrate the schema:

1. While the current service is running, create a consistent SQLite backup using the application’s authenticated backup action. Confirm it completed and validate the resulting file with `PRAGMA quick_check`.
2. Enable maintenance at the reverse proxy and stop the service cleanly. Never copy a live SQLite database or remove its `-wal`/`-shm` sidecars while the service is running.
3. Preserve the old release and backup separately. Deploy the new release, start one process, and inspect startup logs and application health.
4. If rollback is needed, stop the service first, preserve the failed data directory for diagnosis, and restore the pre-update SQLite backup to `FIKRATAK_DATA_DIR/fikratak.sqlite`. Restore only while stopped; do not combine a database from one release with a partially migrated database from another.

The app also retains up to 30 dated local SQLite snapshots. For independent encrypted off-host backups, install `deploy/fikratak-backup.service.example` and `deploy/fikratak-backup.timer.example` as `fikratak-backup.service` and `fikratak-backup.timer`, adjust paths, then enable the timer. `scripts/backup-offsite.sh` uses the SQLite online backup API via `scripts/sqlite-backup.mjs` (not a live-file copy), encrypts with `age`, copies only the ciphertext using SSH/rsync, and prunes matching local and remote archives older than 30 days. Configure `FIKRATAK_AGE_RECIPIENT` with the off-host public key and `FIKRATAK_OFFSITE_TARGET` as a dedicated `user@host:/path`; provision the remote directory for the service account. Set the service account home to `/var/lib/fikratak`, create `/var/lib/fikratak/.ssh` mode `0700`, and install a restricted SSH key plus pinned `known_hosts` there. Protect the private age identity away from the application server.

Off-host destinations:

- **Another VPS:** the included rsync transport is ready for a dedicated SSH account/key, restricted destination directory, and pinned `known_hosts`.
- **Your computer:** use the same rsync target to a machine reachable over a private VPN/SSH path; daily jobs fail visibly when it is offline, while the encrypted local copy remains for retry.
- **Object storage:** use a managed S3-compatible bucket with server-side access controls and a 30-day lifecycle rule, or adapt the uploader to `rclone`; keep age encryption before upload and never store the decryption identity in the bucket or on the app server.

Check `systemctl status fikratak-backup.timer` and `journalctl -u fikratak-backup.service` after installing. If cron is used instead, schedule `/bin/bash /opt/fikratak/scripts/backup-offsite.sh` daily as user `fikratak` with the same protected environment, `umask 077`, and a lock (the script uses `flock`). The encrypted archives and backup directories are private data: directories mode `0700`, files mode `0600`.

Restore only during a monthly drill or incident window. Keep the age private identity in an offline administrator vault; stage it temporarily with mode `0600` for a restore, then remove it. For a monthly drill, select an isolated directory and run `FIKRATAK_RESTORE_DATA_DIR=/tmp/fikratak-restore-drill FIKRATAK_RESTORE_BACKUP_DIR=/tmp/fikratak-restore-drill/backups /bin/bash scripts/restore-offsite.sh <encrypted-archive.age>` as the service operator. The restore script decrypts and validates the archive, then installs it only in that isolated directory; set `FIKRATAK_DATA_DIR` to the same directory and start a separate temporary app process to verify login, counts, and key linked records. For a production restore, omit `FIKRATAK_RESTORE_DATA_DIR`; the script refuses an active systemd service, validates the decrypted file, creates a pre-restore online backup, preserves the old database, and installs the restored database. Record the date, archive identifier, `quick_check`, `foreign_key_check`, and results without recording personal data. Never remove live `-wal`/`-shm` files.

The release verification runs a synthetic database backup/restore test as part of the project test suite; it also runs the exact release package through a clean-start and 3,000-row import rehearsal. This does not replace the scheduled production restore drill.

The interest-catalog migration creates and validates a full SQLite backup before normalizing existing classification values. Keep that migration backup until the updated database has passed `PRAGMA quick_check` and record counts and representative interests have been verified.

## Adding a replacement administrator

The deployment includes `scripts/create-production-admin.mjs` for an existing populated production database when the current administrator cannot sign in. It refuses to initialize a new database, requires an existing administrator and influencer records, writes a full SQLite backup to the separately configured backup directory, adds a second active `admin` account with an `scrypt` password hash, and verifies login against the configured HTTPS application URL. Existing accounts are not disabled or changed. If login verification fails, the new account is removed and the prior accounts and records remain unchanged.

Run the command interactively on the production host under the service account (or another account with tightly scoped access to the data and backup directories). Set `FIKRATAK_DATA_DIR`, `FIKRATAK_BACKUP_DIR`, and `FIKRATAK_LOGIN_URL` in that private shell from the production service configuration; do not put credentials in command arguments, scripts, or shell history. Then run:

```sh
node scripts/create-production-admin.mjs
```

Confirm by typing `ADD-ADMIN`. The command prints the generated username and temporary password only after the HTTPS login succeeds. Deliver them through an approved private channel, sign in, and change the password immediately. Do not redirect or capture terminal output in service logs. Keep the old administrator enabled until the new account and its full admin permissions have been confirmed manually.

## First production data load

The production import API is disabled by default. Schedule a short import window and follow this sequence:

1. Confirm the off-host backup timer is healthy. Create and validate an immediate backup before enabling import; do not rely only on a backup taken before the release.
2. In the protected service environment set `FIKRATAK_IMPORT_ENABLED=1` and restart the app. Sign in as an admin or editor. The server still enforces role permissions and the same preview/confirmation gates in production.
3. Use the **preview**, not direct commit. Review total rows, account matches, new, unchanged, updates, and the review list. A clear username match to exactly one record is updated only after the user confirms the preview. Conflicted rows are blocked from writing and listed for review: accounts on one row pointing to different records, an account repeated across rows, or a changed phone for a matched username. Non-conflicted rows in the same file may still be committed. Only non-empty input cells update existing values.
4. Fix any identity or duplicate conflict before retrying. Unknown columns stop the import; rename/remove them using the original workbook field names before previewing again. There is no unknown-column acknowledgement step.
5. Commit only the approved preview. Save the batch ID and counts; sample-check a few records and verify the batch appears in import history.
6. If the batch is wrong and no later edits/relationships have been made, use **Undo batch** immediately and confirm the report shows every row undone and zero skipped. Undo is intentionally conditional: rows subsequently changed or linked are skipped rather than destructively reverted. If the batch cannot be fully undone, stop writes and restore the pre-import backup only after assessing whether doing so would discard any later legitimate changes.
7. Set `FIKRATAK_IMPORT_ENABLED=0` and restart after import. Keep the batch report and pre-import backup according to the retention policy.

Canonical template: `influencer-template.csv` and `fikratak-influencers-template-3000.xlsx` ship in the production package. The header row is:

```text
Name,Gender,Country,Area,City,Country Code,Number,Full_Mobile_Number,Username I,Followers Count I,Influencer Type I,Username T,Followers Count T,Influencer Type T,Username,Followers Count S,Influencer Type S,Best Platform,Main_Username,Verified,Mawthouq,Speak,language,Classification,Face Appearance,Hijab,Categories 1,Categories 2,Categories 3,Categories 4,Full Classification,Date,Confrmation Source,Paid or Voucher,Added By,Note
```

`Name` is recommended, but each row must have at least one usable phone number or social username to be saved. Put one influencer per row and all of that influencer’s Instagram, TikTok, and Snapchat accounts in their respective columns on that same row. Keep `Country Code` and `Number` as text so spreadsheet software does not strip leading zeros; `Full_Mobile_Number` is an alternative full number. Empty cells stay blank for a new record and do not clear existing fields during a matched update. Do not change the original spelling `Confrmation Source`. The importer also recognizes the common aliases `Username Tiktok`, `Username Snapchat`, and `Username Instagram`.

Before launch, run `npm run verify:release` from the development checkout. It rebuilds the release and tests it in isolated temporary directories. The synthetic rehearsal checks first import and exact repeat behavior, clear username matches, updates and undo, duplicate usernames, unknown-column blocking, template parsing, and the unique account constraint. The verifier and test credentials are generated/used only in development and are not shipped.

## Security and operations

- Production mutations require an HTTPS Origin that exactly matches `FIKRATAK_ALLOWED_ORIGINS`; configure the one public app origin (comma-separated exact origins only when explicitly required). A “request origin is not trusted” response means the browser's Origin is missing, is not HTTPS, or does not exactly match this allowlist; check the browser address (including `www`) and hosting configuration, then restart. Do not use wildcard origins or disable the check. CORS is not enabled.
- Session cookies are `Secure`, `HttpOnly`, and `SameSite=Strict` in production. Sessions are memory-only and expire after eight hours; a restart invalidates sessions.
- There is no static session-signing secret: session IDs are cryptographically random opaque tokens held server-side in memory. Uploaded profile images are stored inside the protected SQLite database; the app has no public upload directory.
- Password reset is intentionally disabled in production until a secure delivery channel is implemented. An administrator can set a new password through the existing user-management workflow.
- Login throttling defaults to six failed attempts followed by a 10-minute lockout; configure `FIKRATAK_LOGIN_MAX_ATTEMPTS` and `FIKRATAK_LOGIN_LOCKOUT_MINUTES` in the protected service environment. Both internal and client-portal login use these settings, with separate per-IP counters. Behind the included Nginx config, the app trusts one valid `X-Forwarded-For` address only when the direct peer is `127.0.0.1` and that address is explicitly listed in `FIKRATAK_TRUSTED_PROXIES`. Nginx must overwrite the header with `$remote_addr`; never preserve a client-supplied forwarding chain.
- Terminate TLS at the reverse proxy and enable HSTS there only after HTTPS is fully working. Do not expose the Node port publicly.
- `start-production.sh` requires explicit data, backup, and allowed-origin variables. Use a supervisor such as systemd for restart-on-failure and logs; do not run multiple Node workers against this SQLite database.
- Review Nginx, service, and OS logs without recording passwords, reset tokens, phone numbers, or database contents.

## Verification

From the development checkout, run `npm test`, `npm run check`, and `npm run verify:release`. The release generator copies a reviewed allowlist and excludes development databases, backups, tests, verifiers, experiments, `.git`, dependencies, and credentials. `npm run verify:release` rebuilds the package and runs the development-only verifier against it using random credentials and temporary databases. Deploy only the generated application files; preserve the server's existing external data and backup directories.

The project cannot choose your production OS, hostname, certificate authority, proxy topology, filesystem/volume, backup destination, or operational owner. Confirm these and establish a restore drill before public exposure.
