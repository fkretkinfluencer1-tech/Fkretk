# دليل الإطلاق والتشغيل | Deployment Runbook

## الحكم الحالي | Current verdict

**NO-GO للإطلاق العام حتى اجتياز فحوص الخادم الفعلية أدناه.** لم يُنشر التطبيق ولم تُستخدم بيانات إنتاجية. اختبارات المصدر والحزمة المحلية لا تثبت إعداد Nginx الفعلي أو صلاحيات الخادم أو النقل المشفر إلى وجهة يملكها المستخدم. لا تنتقل إلى GO قبل نجاح `nginx -t` وفحوص TLS والصلاحيات والنسخ والاستعادة على بيئة الاستضافة الفعلية.

**NO-GO for public launch until the actual host checks below pass.** Nothing was deployed and no production data was used. Local source/package tests cannot prove the live Nginx configuration, server permissions, or encrypted transfer to an owner-controlled destination. Do not change this verdict to GO until TLS, `nginx -t`, permissions, backup, restore, and the launch checklist pass on the real host.

## 1. قبل رفع الإصدار | Before uploading

### العربية

- [ ] استخدم إصدارًا مُراجعًا من `production-release.zip` فقط؛ لا ترفع مجلد التطوير أو `node_modules`.
- [ ] تأكد أن حزمة الإصدار لا تحتوي `data/` أو SQLite أو ملفات نسخ احتياطية أو `.env` أو سجلات أو ملفات source map.
- [ ] افحص `SHA256SUMS.txt` مقابل بصمة الإصدار المسلّمة عبر قناة موثوقة.
- [ ] جهّز اسم نطاق HTTPS وشهادة TLS، ومستخدم النظام `fikratak`، ومساري البيانات والنسخ خارج مجلد التطبيق.
- [ ] جهّز وجهة نسخ خارج الخادم، ومفتاح `age` العام للنسخ، وهوية فك التشفير خارج الخادم. لا تضع المفتاح الخاص على الخادم.
- [ ] راجع حدود الصلاحيات المطلوبة، والمسؤول التشغيلي، وخطة استعادة مجرّبة.
- [ ] من مجلد التطوير، نفّذ `npm run verify:release`؛ المدقق يعمل على نسخة الإصدار وقواعد مؤقتة، ولا يُرفع إلى الخادم.

### English

- [ ] Upload only the reviewed `production-release.zip`; do not upload the development tree or `node_modules`.
- [ ] Confirm the release contains no `data/`, SQLite database, backup, `.env`, log, or source-map files.
- [ ] Verify `SHA256SUMS.txt` against the release checksum received through a trusted channel.
- [ ] Prepare the HTTPS hostname/certificate, the `fikratak` OS account, and data/backup paths outside the app directory.
- [ ] Prepare an off-server destination, an `age` public recipient key, and a decryption identity kept off the app server.
- [ ] Review role assignments, the operations owner, and a tested restore plan.
- [ ] Run `npm run verify:release` from the development checkout; it verifies the generated package with temporary databases and is not uploaded.

## 2. على الخادم | On the server

### Linux provisioning (copy/paste after replacing the hostname)

```sh
sudo useradd --system --home-dir /var/lib/fikratak --create-home --shell /usr/sbin/nologin fikratak
sudo install -d -o fikratak -g fikratak -m 0700 /opt/fikratak /var/lib/fikratak/data /var/backups/fikratak
sudo install -d -o fikratak -g fikratak -m 0700 /var/lib/fikratak/.ssh
sudo chown -R fikratak:fikratak /opt/fikratak
sudo chmod 0700 /var/lib/fikratak/data /var/backups/fikratak
```

Unpack the release into `/opt/fikratak`; do not copy any local `data/` directory. First start creates a new SQLite database and schema. The verifier is development-only and is not present in the release.

Create `/etc/fikratak/fikratak.env` with mode `0600`, owned by root and readable by the service group. Set at least:

```text
NODE_ENV=production
FIKRATAK_HOST=127.0.0.1
PORT=8765
FIKRATAK_DATA_DIR=/var/lib/fikratak/data
FIKRATAK_BACKUP_DIR=/var/backups/fikratak
FIKRATAK_ALLOWED_ORIGINS=https://crm.example.com
FIKRATAK_IMPORT_ENABLED=0
FIKRATAK_SETUP_TOKEN=<one-time-random-token>
FIKRATAK_AGE_RECIPIENT=<off-host-age-public-key>
FIKRATAK_OFFSITE_TARGET=<restricted-user@backup-host:/dedicated/path>
```

Generate the one-time setup token in a private terminal (`openssl rand -hex 32`); do not paste it in chat or command history. Install the systemd app unit and start it:

```sh
sudo install -o root -g root -m 0644 deploy/fikratak.service.example /etc/systemd/system/fikratak.service
sudo systemctl daemon-reload
sudo systemctl enable --now fikratak.service
curl -fsS https://crm.example.com/health
```

The health response is only `{"status":"ok"}`. Create the first admin either from a private terminal with `sudo -u fikratak env FIKRATAK_DATA_DIR=/var/lib/fikratak/data node /opt/fikratak/scripts/create-first-admin.mjs` (hidden password input; no setup token), or by opening the HTTPS site and entering a username, a 12–128 character password, and the environment setup token. The terminal utility refuses if any user exists. After web setup, remove `FIKRATAK_SETUP_TOKEN` from the service environment and restart. Setup then returns HTTP 409 because an admin already exists; the setup token is not an ongoing credential.

Configure `deploy/nginx.conf.example` with the actual domain and certificate paths, then run `sudo nginx -t` before reloading. The sample config redirects HTTP to HTTPS, enables TLS 1.2/1.3 and gzip, caps request bodies at **45 MiB** (the UI limit for `.xlsx` is **3 MiB**; the import API accepts at most 40 MiB), rate-limits `/api/login` (5/min), `/api/setup` (2/min), `/api/password-reset-*` (2/min), and `/api/client-portal/login` (5/min), and blocks data/backups, dotfiles, docs, source maps, scripts, tests, and source files. Keep Node bound to `127.0.0.1`.

### Empty-database inventory — recreate in production

No local database is transferred. Recreate:

- Admin/editor/viewer users, passwords, and role assignments.
- Influencer records, personal contact data, social accounts, profile images, follower history, notes, status/workflow history, unknown imported columns, and import batches/undo history.
- Client accounts, portal credentials/settings, catalogs and share links, selected influencers, inquiries, decisions, feedback, and access history.
- Campaigns, schedules, targets, campaign materials, uploaded files, check-ins, notes, and campaign histories.
- Custom interest catalog entries, brand/company settings, customized system identity, application settings, and audit history.

Code-defined defaults and bundled static brand assets ship with the application; database-backed customizations do not.

### First-day admin checklist

1. Create the first admin from a private terminal or with the one-time web setup token.
2. If using web setup, remove the token and restart; verify a second setup request is rejected.
3. Configure company/system identity, brands, default catalogs, and custom interests.
4. Create named users with least privilege; verify viewer/editor/admin behavior.
5. Configure off-host encrypted backup and prove a restore from a synthetic database.
6. Rehearse the import flow with the packaged synthetic file; take a fresh backup before the first real import.
7. Import only after preview review; save batch ID and counts; turn importing off after the window.
8. Verify the health endpoint, HTTPS redirect, blocked paths, logs, timer, and client-share expiry.

## 3. Daily encrypted backup and monthly restore drill

The service uses SQLite's online backup API, not a live-file copy. `scripts/backup-offsite.sh` creates a consistent SQLite snapshot, validates it, encrypts it with `age`, copies ciphertext with SSH/rsync, uses 30-day local/remote retention, and restricts files to mode `0600`. Data and backup directories must be mode `0700` and owned by the app user.

```sh
sudo install -o root -g root -m 0644 deploy/fikratak-backup.service.example /etc/systemd/system/fikratak-backup.service
sudo install -o root -g root -m 0644 deploy/fikratak-backup.timer.example /etc/systemd/system/fikratak-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now fikratak-backup.timer
sudo systemctl status fikratak-backup.timer --no-pager
sudo systemctl start fikratak-backup.service
sudo journalctl -u fikratak-backup.service --no-pager
```

The remote SSH account must be restricted to a dedicated directory and pinned `known_hosts`; keep the `age` private identity off-host. An off-host destination may be another VPS, an S3-compatible bucket via a separately reviewed uploader/lifecycle rule, or an administrator computer reachable over a private VPN/SSH connection. Do not send plaintext backups.

Run a monthly restore drill with synthetic data using the hosting provider's documented tools and a separate, isolated destination. Confirm the restored database opens and passes SQLite integrity checks before considering the drill successful. No Linux verification script is included in the production package.

## 4. First production data load

### Safe procedure

1. Confirm production is empty and the off-host timer is healthy. Take and validate an immediate backup before enabling import.
2. Set `FIKRATAK_IMPORT_ENABLED=1` only for the approved import window; sign in as admin/editor.
3. Upload the real sheet and run **Preview**. Review total rows, matched by phone, exact-account matches, new, unchanged, update, conflict/needs-review counts, and unknown-column warnings.
4. Fix unexplained conflicts and duplicate accounts in the source sheet. Unknown columns stop the import; remove or correct them before retrying.
5. A clear username match to one record is updated only after confirmation of the Dry Run preview. Conflicted rows are not written and appear in the review list: accounts on one row resolving to different records, the same username on multiple rows, or a changed phone for a matched username. Other valid rows may proceed. Only non-empty input cells update existing values.
6. Commit the reviewed batch, save its batch ID and counts, and spot-check records. If wrong, use **Undo batch** before later edits or links; undo reports any rows it safely cannot revert. If the whole batch cannot be undone, stop writes and assess restoring the pre-import backup.
7. Disable import again by setting `FIKRATAK_IMPORT_ENABLED=0` and restarting the service.

### Workbook guide

Use the bundled `influencer-template.csv` or `fikratak-influencers-template-3000.xlsx`. Exact canonical header order:

```text
Name,Gender,Country,Area,City,Country Code,Number,Full_Mobile_Number,Username I,Followers Count I,Influencer Type I,Username T,Followers Count T,Influencer Type T,Username,Followers Count S,Influencer Type S,Best Platform,Main_Username,Verified,Mawthouq,Speak,language,Classification,Face Appearance,Hijab,Categories 1,Categories 2,Categories 3,Categories 4,Full Classification,Date,Confrmation Source,Paid or Voucher,Added By,Note
```

`Name` is recommended, but each row needs at least one usable phone or social account to be saved. Use one influencer per row and place that influencer's Instagram, TikTok, and Snapchat accounts on that same row. Keep country codes and local numbers as text to preserve leading zeros. `Full_Mobile_Number` is an alternative full number. Empty cells remain empty for new records and do not clear existing fields on updates. Unknown columns stop the import and must be corrected before continuing. Do not rename `Confrmation Source`; aliases `Username Tiktok`, `Username Snapchat`, and `Username Instagram` are accepted.

The development-only package verifier checks 3,000 synthetic rows, an exact repeat with no changes, 100 matched-account updates and batch undo, additional field updates, duplicate usernames, unknown-column blocking, and database uniqueness. Do not launch if `npm run verify:release` fails.

## 5. Backup data and first-import behavior in the shipped release

The release starts against an empty database. It must not include any `.sqlite`, WAL/SHM sidecar, `data/`, backup, production credential, verifier, test, or real row. The development-only verifier checks the generated package—not only the development source—for template parsing, unique `(platform, normalized_username)` account constraints, import batches, undo, preview, direct clear matches, conflicts, and unknown-column blocking.

The share-link expiry is optional. When selected, the link is valid through the end of that date in UTC; public reads return HTTP 410 after expiry. Access logs store catalog ID, event type, and timestamp only—no IP, user agent, phone, email, or share token.

## 6. Local verification and unresolved items

The source suite is `npm test`; package creation and verification are `npm run verify:release`. The verifier stays in the development checkout and runs against the generated production package with temporary data. The release ZIP and SHA-256 checksums are generated separately; verify that the archive matches the release directory before upload.

Before GO, verify on the actual host: (1) TLS certificate/redirect, `nginx -t` and blocked paths if using Nginx; (2) app/data/backup ownership and permissions; (3) scheduled backup service; (4) synthetic encrypted off-host backup and restore; (5) destination permissions/retention; (6) monthly restore drill ownership. The exact commands depend on the selected hosting provider and operating system. Windows development cannot validate Linux services, Nginx, `age`, SSH/rsync, or systemd.
