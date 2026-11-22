# Influencer CRM — Read-Only System Audit

**Audit date:** 2026-11-16  
**Scope:** Source review, read-only inspection of the live SQLite database, read-only HTTP requests, and existing tests. No application, data, schema, or configuration changes were made. This new report is the only file created.

## Evidence and limits

- Live database reads used SQLite `readOnly: true` and `PRAGMA query_only=ON`. The observed checks were `PRAGMA quick_check = ok` and `PRAGMA foreign_key_check = 0 rows`.
- Existing tests ran against their own temporary databases. `npm.cmd test`: **86 tests, 86 passed, 0 failed, 0 skipped** (25.9 s). `npm.cmd run check`: **passed** (`node --check server.mjs`; contrast checks reported every tested pair at or above 4.5:1).
- A running local server was queried read-only at `127.0.0.1:8765`: `GET /api/session` returned 200 with no user session; the client page returned 200; an intentionally fake share token returned 404. No real client token or client record was accessed.
- “NOT VERIFIED” means there was no safe/available evidence for the requested claim. The actual source spreadsheet was not available. The project’s `fikratak-influencers-template-3000.xlsx` contains 3,000 data rows but **0 populated data rows**; it is a template, not the source sheet.
- The project folder is not a Git repository. The audit therefore could not verify tracked-file history, the complete secret history, or whether generated release artifacts exactly match the current source.
- To protect personal data, this report gives aggregate counts only. It does **not** print live names, handles, IDs, contacts, note contents, or phone fragments.

Read-only SQL evidence (executed on the live database; no row values containing personal data were selected):

```sql
PRAGMA quick_check;          -- result: ok
PRAGMA foreign_key_check;    -- result: 0 rows
SELECT COUNT(*) AS rows,
       SUM(archived_at IS NOT NULL) AS archived
FROM influencers;            -- result: 6052, 1

SELECT COUNT(*) AS groups
FROM (
  SELECT phone_key
  FROM influencers
  WHERE phone_key IS NOT NULL AND trim(phone_key) <> ''
  GROUP BY phone_key
  HAVING COUNT(*) > 1
);                           -- result: 0
```

The quality table in B3 was produced by one aggregate `SELECT` over `influencers` using `json_extract(record_json,...)`, `trim`, and `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` for each displayed missing-field/account condition; output: `6052,3119,3101,3098,3053,3049,3050,3050,3050,1` in the corresponding column order. No individual row values were emitted.

## A. System understanding

### A1. Stack, versions, and project map

- Runtime observed: **Node.js v24.19.0**, **npm 11.17.0**. `package.json` requires Node `>=24`; production runtime code uses Node built-ins, including `node:sqlite`. Runtime dependencies are not declared; development dependencies are Playwright and `@axe-core/playwright`.
- Frontend: server-served HTML/CSS/JavaScript, Arabic RTL and English LTR. No frontend build step is required.
- Persistence: SQLite at `data/fikratak.sqlite`, WAL and foreign keys enabled. `data/` and environment files are ignored by `.gitignore`.
- Startup: `start.cmd` is the documented Windows entry point; the HTTP server defaults to `127.0.0.1:8765`. `FIKRATAK_HOST` can override the bind address; do not expose it on a network without the documented production controls.

Important project entries:

| Path | Purpose |
|---|---|
| `server.mjs` | Node HTTP server, SQLite schema/migrations, authentication, authorization, import/export, client APIs, campaigns, backups. |
| `index.html` | Internal admin/editor/viewer dashboard and database/import UI. |
| `client.html` | Public, token-protected legacy client catalog and staged decisions. |
| `showcase.html`, `assets/showcase.js` | Authenticated client showcase; includes search and filters. |
| `portal.html`, `client-accounts.html` | Authenticated client portal and internal client-account administration. |
| `assets/follower-tiers.js` | Canonical follower parsing and tier thresholds. |
| `assets/*.css`, `assets/i18n.js`, `assets/country-locations.js` | Shared styles, translations, and location helpers. |
| `tests/*.test.mjs` | Isolated integration, browser, import, role, backup, tier, and scalability tests. |
| `scripts/` | Contrast, screenshots, release packaging, and production-admin utilities. |
| `data/` | Live SQLite file and backups; excluded from Git. |
| `deploy/` | Example systemd and nginx configuration. |
| `production-release/` | Packaged deployment tree; not compared against the running source in this audit. |
| `influencer-data-collector/` | Separate data-collection subproject; not part of the CRM request/API path audited here. |
| `follower-sync-lab/` | Separate follower-sync experiment; not treated as an approved production integration. |
| `README.md`, `DEPLOYMENT.md` | Operating rules, import behavior, security/backup guidance, and deployment instructions. |

### A2. Architecture

```text
Browser
 ├─ Internal dashboard: index.html + assets/
 │   └─ /api/* → server.mjs → role/session checks → SQLite
 ├─ Token share page: /client/:token → client.html
 │   └─ /api/client-catalog/:token[/*] → token hash lookup
 │       → selected client_catalog_items + field sanitizer → SQLite
 └─ Authenticated client pages: showcase.html / portal.html
     └─ /api/client-portal/* → client_sid session + account/catalog scoping → SQLite

Import:
 CSV/XLSX (+ optional images) → parse → preview/match/conflicts
 → short-lived user-bound preview token → confirmed transaction
 → influencer rows + follower history + audit event

Authentication:
 users/client_accounts → scrypt password hashes
 → in-memory HttpOnly sessions → per-route authorization
```

### A3. Database schema and live row counts

**Observed inventory:** 53 SQLite tables (including the five FTS5 support tables), 81 foreign-key edges, 111 indexes reported across `PRAGMA index_list`, 44 named indexes, and 5 triggers. `*` means primary-key column; `!` means `NOT NULL`. SQLite autoindexes enforce primary/unique constraints; named-index definitions are in `server.mjs` and the live database’s `sqlite_master`. FTS5 shadow tables are implementation tables, not application entities.

The following inventory records every live table and its columns/types and row count. The live schema is the result of initial DDL plus conditional migrations in `server.mjs`; defaults and checks are listed after the inventory.

| Table | Rows | Columns (`*` PK, `!` NOT NULL) |
|---|---:|---|
| `app_settings` | 4 | `key TEXT*`, `value TEXT!`, `updated_at TEXT!` |
| `audit_events` | 140 | `id TEXT*`, `actor_user_id TEXT`, `actor_username TEXT!`, `actor_role TEXT!`, `action TEXT!`, `section TEXT!`, `entity_type TEXT!`, `entity_id TEXT!`, `entity_label TEXT!`, `outcome TEXT!`, `http_status INTEGER!`, `old_values_json TEXT!`, `new_values_json TEXT!`, `occurred_at TEXT!` |
| `campaign_advertiser_notes` | 0 | `id TEXT*`, `campaign_id TEXT!`, `client_account_id TEXT`, `advertiser_key TEXT!`, `advertiser_name TEXT!`, `note_text TEXT!`, `updated_by TEXT`, `updated_at TEXT!` |
| `campaign_briefs` | 1 | `id TEXT*`, `campaign_id TEXT!`, `client_account_id TEXT`, `advertiser_name TEXT!`, `content_json TEXT!`, `archived INTEGER!`, `created_at TEXT!`, `updated_at TEXT!` |
| `campaign_checkin_history` | 0 | `id TEXT*`, `campaign_id TEXT!`, `influencer_id TEXT!`, `action_type TEXT!`, `actor_user_id TEXT`, `actor_username TEXT!`, `created_at TEXT!` |
| `campaign_influencer_notes` | 0 | `campaign_id TEXT*!`, `influencer_id TEXT*!`, `note_text TEXT!`, `updated_by TEXT`, `updated_at TEXT!` |
| `campaign_internal_files` | 0 | `id TEXT*`, `campaign_id TEXT!`, `kind TEXT!`, `platform TEXT`, `phase TEXT`, `capture_date TEXT`, `note TEXT!`, `file_name TEXT!`, `mime_type TEXT!`, `file_data BLOB!`, `created_by TEXT`, `created_at TEXT!` |
| `campaign_presentation_display_options` | 0 | `presentation_id TEXT*!`, `show_influencer_details INTEGER!`, `show_social_accounts INTEGER!`, `show_followers INTEGER!`, `show_additional_details INTEGER!`, `show_company_work INTEGER!` |
| `campaign_presentation_targets` | 0 | `presentation_id TEXT*!`, `campaign_id TEXT!`, `influencer_id TEXT*!`, `position INTEGER!` |
| `campaign_presentation_videos` | 0 | `id TEXT*`, `presentation_id TEXT!`, `youtube_video_id TEXT!`, `video_url TEXT!`, `title TEXT!`, `position INTEGER!` |
| `campaign_presentation_work_videos` | 0 | `presentation_id TEXT*!`, `video_id TEXT*!`, `position INTEGER!` |
| `campaign_presentations` | 0 | `id TEXT*`, `campaign_id TEXT!`, `client_account_id TEXT!`, `token_hash TEXT!`, `fields_json TEXT!`, `active INTEGER!`, `created_by TEXT`, `created_at TEXT!`, `updated_at TEXT!`, `brand_id TEXT!`, `brand_snapshot_json TEXT!` |
| `campaign_schedule` | 0 | `id TEXT*`, `campaign_id TEXT!`, `scheduled_at TEXT!`, `position INTEGER!` |
| `campaign_target_decisions` | 0 | `id TEXT*`, `campaign_id TEXT!`, `influencer_id TEXT!`, `client_account_id TEXT!`, `decision TEXT!`, `created_at TEXT!`, `updated_at TEXT!` |
| `campaign_targets` | 5 | `campaign_id TEXT*!`, `influencer_id TEXT*!`, `position INTEGER!`, `visit_date TEXT`, `shipping_status TEXT!`, `coverage_status TEXT!`, `checkin_token TEXT`, `visited_at TEXT`, `visit_location TEXT`, `visit_time TEXT`, `visit_city TEXT`, `visit_branch TEXT`, `visit_address TEXT`, `visit_status TEXT!`, `visit_notes TEXT`, `coverage_notes TEXT`, `delivery_recipient_name TEXT`, `delivery_recipient_phone TEXT`, `delivery_courier_contact TEXT`, `delivery_city TEXT`, `delivery_district TEXT`, `delivery_address TEXT`, `delivery_map_link TEXT`, `delivery_order_details TEXT`, `delivery_notes TEXT`, `shipping_carrier TEXT`, `tracking_number TEXT`, `delivery_date TEXT`, `execution_type TEXT!`, `contact_status TEXT!`, `participation_status TEXT!`, `campaign_price TEXT!`, `operations_notes TEXT!`, `after_confirmation TEXT!` |
| `campaign_workspaces` | 1 | `campaign_id TEXT*!`, `content_json TEXT!`, `updated_by TEXT`, `updated_at TEXT!` |
| `campaigns` | 1 | `id TEXT*`, `campaign_name TEXT!`, `company_name TEXT!`, `campaign_type TEXT!`, `created_at TEXT!`, `updated_at TEXT!`, `service_type TEXT!`, `start_date TEXT`, `end_date TEXT`, `field_visibility TEXT!`, `execution_mode TEXT!`, `qr_enabled INTEGER!` |
| `client_account_activity` | 2 | `id TEXT*`, `account_id TEXT!`, `actor_user_id TEXT`, `actor_username TEXT!`, `event_type TEXT!`, `detail_json TEXT!`, `created_at TEXT!` |
| `client_account_campaigns` | 0 | `account_id TEXT*!`, `campaign_id TEXT*!`, `created_at TEXT!` |
| `client_account_catalogs` | 0 | `account_id TEXT*!`, `catalog_id TEXT*!`, `created_at TEXT!` |
| `client_accounts` | 2 | `id TEXT*`, `username TEXT!`, `client_name TEXT!`, `company_name TEXT!`, `salt TEXT!`, `password_hash TEXT!`, `active INTEGER!`, `portal_config TEXT!`, `portal_status TEXT!`, `created_at TEXT!`, `updated_at TEXT!`, `client_type TEXT!`, `email TEXT`, `internal_notes TEXT!`, `display_mode TEXT!` |
| `client_campaign_actions` | 0 | `id TEXT*`, `campaign_id TEXT!`, `influencer_id TEXT!`, `client_account_id TEXT!`, `action_type TEXT!`, `details TEXT!`, `created_at TEXT!` |
| `client_catalog_account_visibility` | 0 | `catalog_id TEXT*!`, `influencer_id TEXT*!`, `platform TEXT*!`, `visible INTEGER!` |
| `client_catalog_decision_history` | 19 | `id TEXT*`, `catalog_id TEXT!`, `influencer_id TEXT!`, `client_account_id TEXT`, `actor_label TEXT!`, `event_type TEXT!`, `previous_decision TEXT`, `decision TEXT`, `created_at TEXT!` |
| `client_catalog_decisions` | 9 | `id TEXT*`, `catalog_id TEXT!`, `influencer_id TEXT!`, `decision TEXT!`, `created_at TEXT!` |
| `client_catalog_items` | 9 | `catalog_id TEXT*!`, `influencer_id TEXT*!`, `position INTEGER!` |
| `client_catalog_work_videos` | 4 | `catalog_id TEXT*!`, `video_id TEXT*!`, `position INTEGER!` |
| `client_catalogs` | 2 | `id TEXT*`, `token_hash TEXT!`, `client_name TEXT!`, `company_name TEXT!`, `active INTEGER!`, `created_at TEXT!`, `show_city INTEGER!`, `show_category INTEGER!`, `show_details INTEGER!`, `offer_name TEXT!`, `offer_status TEXT!`, `portal_linked INTEGER!`, `updated_at TEXT`, `show_company_work INTEGER!`, `brand_id TEXT!`, `brand_snapshot_json TEXT!` |
| `client_decision_history` | 0 | `id TEXT*`, `campaign_id TEXT!`, `influencer_id TEXT!`, `client_account_id TEXT`, `event_type TEXT!`, `previous_decision TEXT`, `decision TEXT`, `created_at TEXT!` |
| `client_decision_requests` | 0 | `client_account_id TEXT*!`, `request_id TEXT*!`, `campaign_id TEXT!`, `influencer_id TEXT!`, `result_decision TEXT!`, `created_at TEXT!` |
| `client_inquiries` | 0 | `id TEXT*`, `catalog_id TEXT!`, `influencer_id TEXT!`, `customer_name TEXT!`, `customer_contact TEXT!`, `created_at TEXT!` |
| `client_portal_templates` | 0 | `id TEXT*`, `name TEXT!`, `config_json TEXT!`, `created_by TEXT`, `created_at TEXT!`, `updated_at TEXT!` |
| `client_showcase_feedback` | 0 | `account_id TEXT*!`, `catalog_id TEXT*!`, `influencer_id TEXT*!`, `is_favorite INTEGER!`, `comment TEXT!`, `updated_at TEXT!` |
| `client_visit_schedules` | 0 | `id TEXT*`, `client_account_id TEXT!`, `status TEXT!`, `created_at TEXT!`, `updated_at TEXT!`, `published_at TEXT` |
| `client_visits` | 0 | `id TEXT*`, `schedule_id TEXT!`, `influencer_id TEXT!`, `visit_date TEXT!`, `visit_time TEXT!`, `city TEXT!`, `branch TEXT!`, `created_at TEXT!`, `updated_at TEXT!` |
| `company_brand_settings` | 2 | `brand_id TEXT*`, `configuration_json TEXT!`, `updated_at TEXT!` |
| `company_work_videos` | 4 | `id TEXT*`, `youtube_video_id TEXT!`, `video_url TEXT!`, `title TEXT!`, `active INTEGER!`, `created_by TEXT`, `created_at TEXT!`, `updated_at TEXT!` |
| `coverage_videos` | 0 | `id TEXT*`, `youtube_video_id TEXT!`, `video_url TEXT!`, `title TEXT!`, `description TEXT!`, `influencer_id TEXT`, `campaign_id TEXT`, `created_by TEXT`, `created_at TEXT!`, `updated_at TEXT!` |
| `influencer_advertiser_note_history` | 0 | `id TEXT*`, `note_id TEXT!`, `influencer_id TEXT!`, `action TEXT!`, `previous_text TEXT!`, `note_text TEXT!`, `actor_user_id TEXT`, `actor_username TEXT!`, `changed_at TEXT!` |
| `influencer_advertiser_notes` | 0 | `id TEXT*`, `influencer_id TEXT!`, `note_text TEXT!`, `created_by_user_id TEXT`, `created_by_username TEXT!`, `created_at TEXT!`, `updated_by_user_id TEXT`, `updated_by_username TEXT!`, `updated_at TEXT!`, `deleted_at TEXT`, `deleted_by_user_id TEXT` |
| `influencer_follower_history` | 0 | `id TEXT*`, `influencer_id TEXT!`, `platform TEXT!`, `followers_count INTEGER!`, `previous_count INTEGER`, `source TEXT!`, `actor_username TEXT!`, `recorded_at TEXT!` |
| `influencer_profile_images` | 0 | `influencer_id TEXT*`, `mime_type TEXT!`, `image_data BLOB!`, `content_hash TEXT!`, `source_url TEXT`, `updated_at TEXT!` |
| `influencer_search` | 6,052 | FTS5 virtual table: `influencer_id`, `search_text` |
| `influencer_search_config` | 1 | FTS5 support: `k`, `v` |
| `influencer_search_content` | 6,052 | FTS5 support: `id`, `c0`, `c1` |
| `influencer_search_data` | 1,100 | FTS5 support: `id`, `block` |
| `influencer_search_docsize` | 6,052 | FTS5 support: `id`, `sz` |
| `influencer_search_idx` | 629 | FTS5 support: `segid`, `term`, `pgno` |
| `influencer_status_history` | 1 | `id TEXT*`, `influencer_id TEXT!`, `previous_status TEXT!`, `status TEXT!`, `reason TEXT!`, `actor_user_id TEXT`, `actor_username TEXT!`, `changed_at TEXT!` |
| `influencers` | 6,052 | `id TEXT*`, `record_json TEXT!`, `phone_key TEXT`, `archived_at TEXT`, `archived_by TEXT`, `archive_previous_status TEXT!`, `archive_previous_workflow TEXT!` |
| `interest_catalog` | 15 | `id TEXT*`, `name TEXT!`, `normalized_name TEXT!`, `created_at TEXT!`, `updated_at TEXT!` |
| `password_reset_tokens` | 1 | `id TEXT*`, `user_id TEXT!`, `code_hash TEXT!`, `expires_at TEXT!`, `used INTEGER!`, `created_at TEXT!` |
| `users` | 2 | `id TEXT*`, `username TEXT!`, `salt TEXT!`, `password_hash TEXT!`, `role TEXT!`, `active INTEGER!`, `created_at TEXT!`, `email TEXT`, `updated_at TEXT` |

**Foreign keys (81 edges):** these are the exact live `PRAGMA foreign_key_list` mappings; arrows show `child-column → parent-table.column (ON DELETE)`:

```text
campaign_advertiser_notes: updated_by→users.id (SET NULL); client_account_id→client_accounts.id (SET NULL); campaign_id→campaigns.id (CASCADE)
campaign_briefs: client_account_id→client_accounts.id (SET NULL); campaign_id→campaigns.id (CASCADE)
campaign_checkin_history: actor_user_id→users.id (SET NULL); influencer_id→influencers.id (CASCADE); campaign_id→campaigns.id (CASCADE)
campaign_influencer_notes: updated_by→users.id (SET NULL); campaign_id→campaign_targets.campaign_id (CASCADE); influencer_id→campaign_targets.influencer_id (CASCADE)
campaign_internal_files: created_by→users.id (SET NULL); campaign_id→campaigns.id (CASCADE)
campaign_presentation_display_options: presentation_id→campaign_presentations.id (CASCADE)
campaign_presentation_targets: campaign_id→campaign_targets.campaign_id (CASCADE); influencer_id→campaign_targets.influencer_id (CASCADE); presentation_id→campaign_presentations.id (CASCADE)
campaign_presentation_videos: presentation_id→campaign_presentations.id (CASCADE)
campaign_presentation_work_videos: video_id→company_work_videos.id (CASCADE); presentation_id→campaign_presentations.id (CASCADE)
campaign_presentations: created_by→users.id (SET NULL); client_account_id→client_accounts.id (CASCADE); campaign_id→campaigns.id (CASCADE)
campaign_schedule: campaign_id→campaigns.id (CASCADE)
campaign_target_decisions: campaign_id→campaign_targets.campaign_id (CASCADE); influencer_id→campaign_targets.influencer_id (CASCADE); client_account_id→client_accounts.id (CASCADE)
campaign_targets: influencer_id→influencers.id (CASCADE); campaign_id→campaigns.id (CASCADE)
campaign_workspaces: updated_by→users.id (SET NULL); campaign_id→campaigns.id (CASCADE)
client_account_activity: actor_user_id→users.id (SET NULL); account_id→client_accounts.id (CASCADE)
client_account_campaigns: campaign_id→campaigns.id (CASCADE); account_id→client_accounts.id (CASCADE)
client_account_catalogs: catalog_id→client_catalogs.id (CASCADE); account_id→client_accounts.id (CASCADE)
client_campaign_actions: campaign_id→campaign_targets.campaign_id (CASCADE); influencer_id→campaign_targets.influencer_id (CASCADE); client_account_id→client_accounts.id (CASCADE); influencer_id→influencers.id (CASCADE); campaign_id→campaigns.id (CASCADE)
client_catalog_account_visibility: catalog_id→client_catalog_items.catalog_id (CASCADE); influencer_id→client_catalog_items.influencer_id (CASCADE)
client_catalog_decision_history: client_account_id→client_accounts.id (SET NULL); influencer_id→influencers.id (CASCADE); catalog_id→client_catalogs.id (CASCADE)
client_catalog_decisions: influencer_id→influencers.id (CASCADE); catalog_id→client_catalogs.id (CASCADE)
client_catalog_items: influencer_id→influencers.id (CASCADE); catalog_id→client_catalogs.id (CASCADE)
client_catalog_work_videos: video_id→company_work_videos.id (CASCADE); catalog_id→client_catalogs.id (CASCADE)
client_decision_history: influencer_id→influencers.id (CASCADE); campaign_id→campaigns.id (CASCADE); client_account_id→client_accounts.id (SET NULL)
client_decision_requests: client_account_id→client_accounts.id (CASCADE)
client_inquiries: influencer_id→influencers.id (CASCADE); catalog_id→client_catalogs.id (CASCADE)
client_portal_templates: created_by→users.id (SET NULL)
client_showcase_feedback: influencer_id→influencers.id (CASCADE); catalog_id→client_catalogs.id (CASCADE); account_id→client_accounts.id (CASCADE)
client_visit_schedules: client_account_id→client_accounts.id (CASCADE)
client_visits: influencer_id→influencers.id (CASCADE); schedule_id→client_visit_schedules.id (CASCADE)
company_work_videos: created_by→users.id (SET NULL)
coverage_videos: created_by→users.id (SET NULL); campaign_id→campaigns.id (SET NULL); influencer_id→influencers.id (SET NULL)
influencer_advertiser_note_history: actor_user_id→users.id (SET NULL); influencer_id→influencers.id (CASCADE)
influencer_advertiser_notes: deleted_by_user_id→users.id (SET NULL); updated_by_user_id→users.id (SET NULL); created_by_user_id→users.id (SET NULL); influencer_id→influencers.id (CASCADE)
influencer_follower_history: influencer_id→influencers.id (CASCADE)
influencer_profile_images: influencer_id→influencers.id (CASCADE)
influencer_status_history: actor_user_id→users.id (SET NULL); influencer_id→influencers.id (CASCADE)
password_reset_tokens: user_id→users.id (CASCADE)
```

Other tables have no declared foreign keys. Exact non-NULL defaults from live `PRAGMA table_info`: `audit_events` entity fields and JSON snapshots `''`; advertiser-note names/text and brief advertiser name `''`; `campaign_briefs.content_json='{}'`, `archived=0`; check-in actor `''`; campaign influencer note text `''`; internal-file note `''`; presentation display flags `1,1,1,1,0`; presentation video title `''`; presentation `fields_json='[]'`, `active=1`, `brand_id='fkretk'`, brand snapshot `{}`; campaign-target shipping `not_shipped`, coverage `pending`, visit status `pending_confirmation`, execution `visit`, contact `not_contacted`, participation `pending`, price/operations/after-confirmation text `''`; workspace JSON `{}`; campaign service `influencer`, field visibility `{}`, execution mode `visit`, QR enabled; account activity actor `''`/details `{}`; client account active `1`, portal config `{}`, portal status `published`, client type `current`, internal notes `''`, display mode `selecting`; client action details `''`; catalog-history actor `''`; catalogs active `1`, show-city/category `1`, show-details `0`, offer name `''`, offer status `published`, portal-linked `0`, show-company-work `0`, brand `fkretk`, brand snapshot `{}`; showcase favorite `0`/comment `''`; visit schedule `draft`, visit city/branch `''`; company video active `1`/title `''`; coverage title/description `''`; influencer archive prior status `Active` and workflow `new`; note-history text and status reason `''`; password reset `used=0`; user `active=1`. All other nullable columns default to NULL. Initial DDL and conditional migrations are in `server.mjs`.

**Keys, indexes, triggers, and checks:**

- Primary keys are shown by `*` in the inventory. Composite primary keys are present on campaign/client association tables and on the `campaign_id`/`influencer_id` target pairs.
- Non-primary-key unique constraints/indexes are: `users(username)`, `client_accounts(username)`, `client_accounts(email)` (partial, nonblank), `influencers(phone_key)`, `client_catalogs(token_hash)`, `campaign_presentations(token_hash)`, `company_work_videos(youtube_video_id)`, `client_portal_templates(name)`, `interest_catalog(normalized_name)`, `client_account_catalogs(catalog_id)`, and `campaign_targets(checkin_token)` (partial, non-NULL); plus `campaign_advertiser_notes(campaign_id,advertiser_key)`, `campaign_checkin_history(campaign_id,influencer_id,action_type)`, `campaign_presentation_videos(presentation_id,position)`, `campaign_presentation_work_videos(presentation_id,position)`, `campaign_target_decisions(client_account_id,campaign_id,influencer_id)`, `client_catalog_decisions(catalog_id,influencer_id)`, `client_catalog_work_videos(catalog_id,position)`, `client_visit_schedules(client_account_id)`, and `client_visits(schedule_id,influencer_id)`. Remaining unique indexes are the primary/composite-primary keys shown in the inventory. Social-account ownership has **no declarative UNIQUE index**.
- The 44 named indexes and indexed columns are: audit: `idx_audit_events_action(action,occurred_at DESC)`, `idx_audit_events_actor(actor_username COLLATE NOCASE,occurred_at DESC)`, `idx_audit_events_occurred(occurred_at DESC,id)`, `idx_audit_events_section(section,occurred_at DESC)`; campaign: `idx_campaign_advertiser_notes_campaign(campaign_id,updated_at)`, `idx_campaign_briefs_campaign(campaign_id,created_at)`, `idx_campaign_internal_files_campaign(campaign_id,kind,created_at)`, `idx_campaign_presentation_videos_presentation(presentation_id,position)`, `idx_campaign_presentations_campaign(campaign_id,created_at)`, `idx_campaign_targets_checkin(checkin_token)` (unique, partial); client: `idx_client_account_activity_account(account_id,created_at)`, `idx_client_account_campaigns_campaign(campaign_id,account_id)`, `idx_client_account_catalogs_catalog(catalog_id,account_id)`, `idx_client_accounts_email_unique(email COLLATE NOCASE)` (unique, partial), `idx_client_campaign_actions_target(campaign_id,influencer_id,created_at)`, `idx_client_catalog_decision_history_target(catalog_id,influencer_id,created_at)`, `idx_client_decision_history_target(campaign_id,influencer_id,created_at)`, `idx_client_showcase_feedback_account(account_id,updated_at)`, `idx_client_visits_schedule_date(schedule_id,visit_date,visit_time)`; media: `idx_company_work_videos_active(active,created_at)`, `idx_coverage_videos_campaign(campaign_id,updated_at DESC)`, `idx_coverage_videos_influencer(influencer_id,updated_at DESC)`; influencer: `idx_follower_history_lookup(influencer_id,platform,recorded_at DESC)`, `idx_influencer_advertiser_note_history(influencer_id,changed_at DESC)`, `idx_influencer_advertiser_notes(influencer_id,created_at DESC)`, `idx_influencer_status_history(influencer_id,changed_at DESC)`, `idx_influencers_archived(archived_at)`, `idx_influencers_area(lower(trim(json_extract(record_json,'Area'))))`, `idx_influencers_city(lower(trim(json_extract(record_json,'City'))))`, `idx_influencers_country(country_iso(json_extract(record_json,'Country')))`, `idx_influencers_face_appearance(normalized_filter('Face Appearance',…))`, `idx_influencers_gender(normalized_filter('Gender',…))`, `idx_influencers_instagram_username(account_username(json_extract(record_json,'Username I')))`, `idx_influencers_mawthouq(normalized_filter('Mawthouq',…))`, `idx_influencers_name(json_extract(record_json,'Name') COLLATE NOCASE)`, `idx_influencers_paid_or_voucher(normalized_filter('Paid or Voucher',…))`, `idx_influencers_phone(phone_key)`, `idx_influencers_snapchat_username(account_username(json_extract(record_json,'Username')))`, `idx_influencers_speak(normalized_filter('Speak',…))`, `idx_influencers_status(json_extract(record_json,'Influencer Status'))`, `idx_influencers_tiktok_username(account_username(json_extract(record_json,'Username T')))`, `idx_influencers_verified(normalized_filter('Verified',…))`, `idx_influencers_workflow(workflow_status(json_extract(record_json,'Workflow Status')))`, and `idx_reset_tokens_user(user_id,expires_at)`. Ellipses in expression names above only abbreviate the `json_extract(record_json,...)` argument; exact DDL is in the live schema.
- Five triggers: `influencers_account_owner_insert_guard`, `influencers_account_owner_update_guard`, `influencers_search_insert`, `influencers_search_update`, and `influencers_search_delete`. The first two compare normalized `Username I`, `Username T`, and `Username` values when inserting/updating. The other three maintain the FTS5 index.
- Schema `CHECK` rules include `users.role` (`admin|editor|viewer`); profile-image MIME (`image/jpeg|image/png|image/webp`); follower-history platform and nonnegative current/previous counts; advertiser-note history action; client catalog and campaign decision/history event values; check-in action (`visit|coverage`); client request result (`accepted|rejected|pending`); client campaign action type (`visit_confirmed|visit_change_requested|shipping_followup`); visit-schedule status (`draft|published`); brief archived, presentation active/display flags, work-video active, showcase favorite and client account-catalog visibility values (platform enum and Boolean flag); internal-file kind (`attachment|evidence`); campaign type (`visit|delivery`); and client account type/display/portal status enums. `campaigns.qr_enabled` is an integer default, not protected by a SQLite `CHECK`. Other status fields are validated in API code rather than SQLite `CHECK` constraints. Conditional migrations add columns without dropping historical columns.

### A4. Route/API inventory

Roles: **Public** means no logged-in account, but an active share token or scoped random token is still required; catalog tokens have no built-in expiry (see D2). **C** means an authenticated client account, with assignment scoping; **A/E/V** means internal admin/editor/viewer. Mutating permission is checked server-side, not only in the UI. The route families below are parameterized (`:id` means the corresponding ID/token segment).

| Method and path | Required role | Purpose |
|---|---|---|
| `GET /api/session`; `POST /api/setup`, `/api/login`, `/api/logout`, `/api/password-reset-request`, `/api/password-reset-confirm` | Public for setup/login/reset; session-bound for logout | Internal authentication and password recovery. |
| `GET /api/client-portal/session`, `POST /api/client-portal/login`, `/api/client-portal/logout` | Public login; C session/logout | Client account authentication. |
| `GET /api/client-catalog/:token`, `POST /api/client-catalog/:token/decisions`, `/decision`, `/inquiries` | Public token | Read the selected catalog; submit decision, revert, or inquiry. |
| `GET /api/campaign-presentations/:token` | Public token | Read configured campaign presentation. |
| `GET /campaign-checkin/:token`; `POST /api/campaign-checkin/:token` | Public page; A/E session for action | Render QR confirmation page; authenticated staff confirms visit/coverage. |
| `GET /api/client-portal/showcases`, `/showcases/:catalogId`, `/campaigns`, `/visits` | C | Read only assigned catalogs/campaigns/visits, with field sanitization. |
| `PUT /api/client-portal/showcases/:catalogId/feedback/:influencerId` | C, assigned catalog | Save client shortlist feedback. |
| `POST /api/client-portal/offers/:catalogId/targets/:influencerId/decision`, `/api/client-portal/campaigns/:campaignId/targets/:influencerId/{action,decision}` | C, assigned resource | Record client actions/decisions. |
| `GET /api/influencers`, `/api/influencers/meta`, `/api/influencers/filter-options`, `/api/interests` | A/E/V | Paginated/searchable database, aggregate counts, filter options, and interest catalog. |
| `GET /api/influencers/:id/follower-history`; `POST /api/influencers/:id/follower-updates` | A/E | Read and record platform follower history. |
| `POST /api/influencers`, `PUT /api/influencers/:id`, `PATCH /api/influencers/:id/status`, `POST /api/influencers/:id/follower-updates` | A/E | Add/edit records, change status, record follower update. |
| `DELETE /api/influencers/:id`, `POST /api/influencers/:id/restore`, `GET /api/influencers/:id/relationships` | A | Archive, restore, or inspect linked records. `DELETE` archives; it does not physically delete. |
| `GET /api/influencers/:id/status-history`, `GET|POST /api/influencers/:id/advertiser-notes`, `PUT|DELETE /api/influencers/:id/advertiser-notes/:noteId` | A/E; deleting a note is A-only | Status and advertiser-note history. |
| `POST /api/influencers/by-ids` | A/E | Retrieve a bounded set of selected internal records. |
| `GET /api/influencer-photos/template`, `POST /api/influencer-photos/preview`, `POST /api/influencer-photos/upload`, `GET /api/influencer-photos/preview/:hash/:n` | A/E | Preview/template/upload profile photos. |
| `GET /api/import/status`, `POST /api/import/preview`, `POST /api/import` | A/E | Check import availability, preview and confirm main import. |
| `GET /api/account-conflicts`, `POST /api/account-conflicts/export` | A; export also requires password confirmation | Review/export shared account groups. |
| `POST /api/export`, `/api/influencers/export`, `/api/legacy-export` | A plus fresh password confirmation for data export | Export influencer data. |
| `GET|POST /api/campaigns`, `PATCH|DELETE /api/campaigns/:campaignId` | GET A/E/V; create/edit A/E; delete A | Manage campaigns. |
| `PATCH /api/campaigns/:campaignId/targets/:influencerId`, `POST .../qr-export`, `POST /api/campaigns/:campaignId/export` | A/E for target management; A plus fresh password for exports/QR | Manage targets, export campaign and QR. |
| `PUT|DELETE /api/campaigns/:campaignId/influencer-notes/:influencerId`; `/advertiser-notes` GET/POST and `/:noteId` PATCH; `/briefs` GET/POST and `/:briefId` PATCH/DELETE; `/workspace[/files|evidence[/fileId]]`; `/presentations` GET/POST and `/:presentationId` PATCH/DELETE, `/:presentationId/reissue` POST | A/E; presentation deletion is A-only | Campaign notes, briefs, workspace files, and client presentations. |
| `GET /api/coverage`, `GET /api/company-work-videos` | A/E/V | Read coverage-video and company-work libraries. |
| `POST /api/coverage`, `PATCH /api/coverage/:videoId`, `POST /api/company-work-videos`, `PATCH /api/company-work-videos/:videoId` | A/E | Create/update library entries. |
| `DELETE /api/coverage/:videoId`, `DELETE /api/company-work-videos/:videoId` | A | Delete library entries. |
| `GET /api/client-accounts`, `POST /api/client-accounts`, `PATCH|PUT /api/client-accounts/:id`, `PATCH /api/client-accounts/:id/display-mode`, `GET /api/client-accounts/:id/workspace`, `GET /api/client-accounts/:id/preview` | A/E for list/workspace/display-mode; A for create/account changes/admin preview | Client-account administration and internal workspace/preview. |
| `GET /api/client-accounts/:id/visits`, `/visits/influencer-search`; `POST /api/client-accounts/:id/visits`, `/visits/import-preview`, `/visits/import-confirm`, `/visits/publish`, `/visits/unpublish`; `PATCH|DELETE /api/client-accounts/:id/visits/:visitId` | A/E, scoped to the named client account | Manage, import, publish, and edit its visit schedule. Client users read their own published schedules through `GET /api/client-portal/visits`. |
| `GET|POST /api/client-portal-templates` | A | Manage reusable client-portal templates. |
| `GET|POST /api/client-catalogs`, `POST /import-preview`, `/import-confirm`, `GET|POST /:catalogId/influencers`, `POST /:catalogId/export`, `GET /:catalogId/showcase-preview`, `GET /:catalogId/client-preview`, `PATCH|DELETE /:catalogId`, `POST /:catalogId/link` | A for catalog setup/member/links; A/E for import and showcase preview; export requires A plus fresh password | Create and manage selected client catalogs and their links. |
| `GET /api/client-inquiries` | A | Review client inquiries. |
| `GET /api/system-identity`, `PUT /api/system-identity`; `GET /api/brands`, `GET|PUT /api/brands/:brandId` | A/E/V for reads; A for changes | Company and brand identity. |
| `GET /api/audit`, `/api/audit/:eventId`; `GET|PUT /api/settings/follower-tiers` | A for audit; A/E/V for tier read; A for write request (the server returns 409 because boundaries are fixed) | Audit and fixed tier settings. |
| `GET /api/backups`, `POST /api/backups/create`, `/api/backups/influencers/create` | A plus fresh password confirmation for creating/downloading protected data | SQLite and Excel backup operations. |
| `GET|POST /api/interests`, `PUT /api/interests/:id` | A/E for list/add; A for rename | Manage normalized interest taxonomy. |
| `GET /api/users`, `POST /api/users`, `PUT /api/users/:id` | A | User and role administration. |
| `GET /profile-images/:influencerId` | Public by opaque ID | Serve a profile image or neutral fallback; the client catalog API remains separately scoped. |

**Role evidence:** the server uses `requireRole` and explicit admin checks throughout the route handlers; tests named `admin/editor/viewer permissions protect account management and shipping/visit edits`, `every data export requires admin role and password confirmation on that request`, and `CSV and Excel imports preserve record ownership and reject account-based identity conflicts` exercise role boundaries. The full route source is `server.mjs` around API dispatch and the handler ranges cited below. Routes not covered by a named test are code-reviewed, not exhaustively penetration-tested.

### A5. Data-flow walkthroughs

1. **Manual influencer:** browser posts `/api/influencers` → A/E check → `normalizeRecord` and phone/account checks → `saveInfluencer` derives applicable fields and writes `record_json` plus `phone_key` → FTS trigger updates search. Admin/editor can edit via `PUT /api/influencers/:id`; owner conflicts return 409. See `server.mjs` around 2382, 8550, 9609.
2. **Sheet import:** UI parses CSV or server parses XLSX → `POST /api/import/preview` → `previewInfluencerImport` matches by supplied ID, phone key, and normalized platform account, counts creates/updates/unchanged/conflicts → a random user-bound preview ID/fingerprint expires after 10 minutes → confirmed `POST /api/import` rechecks the preview and processes rows in one DB transaction with per-row savepoints, ownership checks, and post-save validation. New rows get a random 16-byte hex ID; updates merge nonempty provided values and preserve unknown fields. Follower changes write `influencer_follower_history`. See `server.mjs` around 2382, 3464–3635, 8774–9140.
3. **Create public client link:** admin creates a `client_catalogs` row and selected `client_catalog_items`; token is random and only its SHA-256 hash is stored. The public page loads `/api/client-catalog/:token`; the server selects the catalog’s items and creates a sanitized presentation. See `server.mjs` around 4719 and 9372–9588.
4. **Approve/reject/undo/confirm:** client stages a local decision in `client.html`; submission posts the selected IDs to `/decisions`. Server verifies each ID belongs to that catalog, writes current state to `client_catalog_decisions`, and appends dated rows to `client_catalog_decision_history`. Revert removes current state but preserves a dated history event. Admin catalog summaries read accepted/rejected decisions. See `server.mjs` 5716–5790 and 4728–4885; `client.html` 844–880.
5. **Delete influencer:** admin-only `DELETE /api/influencers/:id` archives the record, changes its workflow/status, stores the prior state and history; the record and relationships remain and admin can restore it. See `server.mjs` 9609–9709.
6. **Login/roles:** passwords are `scrypt`-derived; `issueSession` creates a random 32-byte opaque token stored in an in-memory session map; cookie is `HttpOnly; SameSite=Strict`, 8-hour expiry, and `Secure` in production. Every request reloads active user and role from SQLite; route handlers enforce authorization. See `server.mjs` 1755–1837, 3404–3448, 6478–6561.

### A6. Influencer identity and computed fields

- One `influencers` row is the person record; social accounts are **not** a separate table. TikTok, Instagram, and Snapchat handles/followers/tier values are separate keys embedded in `record_json`; aliases are normalized on import. The stable internal key is a random 32-hex-character `influencers.id`. Phone is a unique `phone_key` when available, but is mutable and is not the internal record ID.
- Follower tiers are independently calculated per account: Nano `<10K` (zero included), Micro `10K–<100K`, Macro `100K–<500K`, Semi Mega `500K–<1M`, Mega `>=1M`; no tier is assigned to missing/unparseable counts. `Overall Influencer Type` uses the highest account tier. `100K` as the start of Macro remains the practical interpretation documented by the project.
- **Conflict:** current code and README derive `Main_Username` and `Best Platform` from the account with the most valid followers (tie order documented as TikTok, Instagram, Snapchat). The standing project instruction says `Main_Username` must remain independent of social usernames and `Best Platform`. See the dedicated conflict section.
- `Full Classification` is derived from the central interest list; other legacy classification/category fields remain record data. `Paid or Voucher`, `Verified`, `Mawthouq`, `Speak`, `language`, and notes are stored values, not follower-derived outputs. Current live values include `Voucher` and `paid`; blanks are not inferred.

## B. Data integrity

### B1. Reconciliation of 6,052 rows

Read-only comparison of current `influencers.id` values with `data/backups/fikratak-2026-11-15.sqlite`:

| Measure | Result |
|---|---:|
| IDs in older snapshot | 3,004 |
| Those IDs still present in current DB | 3,004 |
| IDs present now but absent from snapshot | 3,048 |
| Current `influencers` rows | 6,052 |
| Current archived rows | 1 |

Among the 3,048 additional IDs, **3,047 have no usable identity fields** (no name, phone key, or social account); one is a separately archived manual record. `audit_events` has a successful import event on 2026-11-15 with `created=3047`, `updated=0`, `unchanged=3`, `failed=0`; a preview event precedes it. This is strong evidence that the large blank cohort came from that import, but an exact source file/hash and per-row batch ID are not stored, so exact source-to-row attribution is **NOT VERIFIED**.

The user-supplied source count of 3,051 is not corroborated by the available snapshot (3,004). The only available similarly named workbook is a 3,000-row blank template. No actual 3,051-row source sheet or independent source IDs were provided. Therefore the exact count of genuine extras versus legitimate source records is **NOT VERIFIED**.

### B2. Matching and duplicate classification

Matching outcomes from read-only aggregate queries:

| Category | Result | Interpretation |
|---|---:|---|
| Exact duplicate `phone_key` groups | 0 | Does not prove phone-format variants represent distinct people. |
| Platform/normalized-username collisions | 7 groups; 14 memberships; 10 distinct influencer rows | Shared account ownership needs human review. Groups by platform: Instagram 4, TikTok 2, Snapchat 1. This is not proof of same person. |
| Exact normalized `Name` + `City` candidate groups | 62 groups / 143 rows | Candidate pairs only, not confirmed duplicates. |
| Name/city candidates outside shared-account rows | 61 groups / 141 rows | Additional review candidates. |
| Rows meeting minimum identity completeness (`Name` + `phone_key` + ≥1 account) | 2,926 | Completeness measure only. |
| Complete rows outside observed shared-account and name/city groups | 2,775 | Conservative “unflagged” candidate count, **not** confirmed clean/unique. |
| Truly unique people / confirmed duplicate count | **NOT VERIFIED** | No authoritative source mapping or reviewed identity decisions. |

The requested 10 real duplicate pairs are **NOT INCLUDED**: the project instruction prohibits putting real influencer records in documentation, and the available records do not establish person-level ground truth. Aggregate collision counts above are the safe evidence. The 7 shared-account groups should be reviewed in the admin conflict report without automatic merge, deletion, or account transfer.

Phone normalization removes non-digits and normalizes Arabic digits, but the key path does not canonicalize a national `05…` representation to an international `9665…` representation unless the separate country-code/number fields are supplied and normalized. Thus zero exact phone-key collisions does **not** establish that the Saudi/Gulf phone variants are duplicate-free.

### B3. Quality checks

Queries against the current `influencers` table (count-only; no values emitted):

| Check | Result |
|---|---:|
| Rows | 6,052 |
| Missing `Name` | 3,119 |
| Missing `City` | 3,101 |
| Missing `Area` | 3,098 |
| Missing normalized phone key | 3,053 |
| No social accounts | 3,049 |
| Missing `Full Classification` | 3,050 |
| Missing `Date` | 3,050 |
| Missing `Added By` | 3,050 |
| Parseable follower values | 4,136 |
| Stored zero follower values | 5 |
| Parseable account-tier mismatches | 0 |
| Stored `Main_Username` mismatches under derivation rule | 1 |
| Stored `Best Platform` mismatches under derivation rule | 165 |
| `Paid or Voucher` = `Voucher` / `paid` / blank | 2,629 / 373 / 3,050 |

No evidence was collected for a canonical spelling dictionary, so inconsistent spellings are **NOT VERIFIED**. Counts of empty versus syntactically invalid phones were not separately established; the reported 3,053 is missing/invalid `phone_key` together. “Illogical follower count” needs an agreed upper-bound rule; no such business limit was asserted. The observed five zeros are valid Nano cases under project rules.

### B4. Cleanup recommendation (not executed)

Do not delete or merge from name similarity. Preserve a verified pre-cleanup backup; stage the 3,047 identity-empty rows for review/quarantine; compare every source row against a source snapshot; review the 7 account-collision groups; then select a canonical row only with human confirmation and linked-record review. Keep source values and field-level before/after evidence. Never automatically transfer a social account. No cleanup was executed.

## C. Import pipeline

### C1. Current behavior and root cause

- Current main importer has a preview and requires a fresh, user-bound preview token before commit. It uses a normalized full phone key, supplied internal ID, and normalized account handle keyed by platform; detects multiple identities pointing to different rows; rejects repeated in-file accounts; rejects identity-empty rows (`no-account`); and retains unknown columns.
- Current code therefore blocks the observed blank-row failure mechanism: a row without any social account is rejected before insert. The 2026-11-15 audit event indicates an earlier import created 3,047 rows in that blank cohort; the exact historical code version/source file was not preserved.
- The fix does **not** close all duplicate risk. Username matching can automatically select an existing record when no phone match exists. This conflicts with the project rule “phone only for automatic duplicate detection,” and it can attach data to an account owner when the phone changed or was omitted. Phone key normalization also does not unify all national/international formats. The account trigger prevents new cross-owner duplicate handles at write time but cannot clean existing collisions.
- Each commit is transactional, with row savepoints and rollback on fatal errors. It is not a persistent staging/batch system. There is no whole-batch undo endpoint, durable preview record, source file hash, import batch ID, or detailed import-history table.

### C2. Existing tests that exercise requested scenarios

These are synthetic fixtures in isolated test DBs, not tests against the live database:

| Scenario | Evidence/result |
|---|---|
| Same XLSX uploaded twice | `CSV and Excel imports preserve record ownership and reject account-based identity conflicts`: first upload `created=1`; repeat `created=0, updated=0, unchanged=1, failed=0`. |
| Existing unchanged + changed + new + two sharing an account | `import preview classifies unchanged, changed, new, and shared-account rows before execution`: preview `creates=1, updates=1, unchanged=1, conflicts=2`; commit created 1 and updated 1, with the two repeated-account rows failed as conflicts. |
| `@`, uppercase, and embedded spaces in usernames | Same import test and manual duplicate test normalize handles and reject or match the owner; synthetic cases include `@ Qa_…` and uppercase variations. |
| One row has TikTok, Instagram, Snapchat | `Valid Sparse Row` import test verifies all three platform handles remain on one influencer record. |
| Account shared by two different influencers | Preview reports both rows as `duplicate-account-in-file`; existing-owner conflicts are also rejected by manual/import tests. |
| Missing account row | Existing import test verifies `no-account` and zero created/updated. |
| Same person with different phone formats | **NOT VERIFIED** as an identity-match import scenario. A separate manual normalization test covers `00966`/country-code fields but does not prove that `05…` and `+9665…` merge/match safely. |
| 3,000+ row upload time and memory | **NOT VERIFIED**. `tests/scalability.test.mjs` tests 4,000/5,000/10,000-record databases and imports 2,000 rows (1,000 new + 1,000 unchanged); no 3,000+ upload memory measurement. |

The specifically requested experiment against a **copy of the live database** was **NOT RUN**. The scenarios above are covered by existing tests on synthetic isolated databases; no production-derived copy was made, and no import was run against the live database.

### C3. Preview/history/undo

- Preview before commit: **Yes**, proven by `/api/import/preview` and tests.
- Commit authorization and preview freshness: **Yes**, current code binds preview to user/input and expires after 10 minutes.
- Whole-import undo: **No endpoint or import-batch rollback after commit found**.
- Import history: only generic `audit_events` counts/action records; no durable batch ID, source filename/hash, row-by-row match report, or add/update/skip history table. Full source-to-import audit is not available.

## D. Client showcase

### D1. Visibility, fields, and client routes

- Legacy public token page `client.html` has no search or filter controls. Its API response is constructed from selected `client_catalog_items`, catalog-specific field switches, account visibility, and `sanitizeClientRecord`; no influencer phone field is included. `tests/client-portal.test.mjs` verifies outsider catalog access is 404, direct decision submission with an influencer not in the offer is 400, invalid batches do not change saved decisions, and private fields (including phone/note/price examples) are absent.
- This is **not true of every client-facing surface**: authenticated `showcase.html` and `portal.html` include search/filter controls; `/api/client-portal/showcases/:id` accepts filter parameters. That conflicts with the user’s broader “no filter/search in client view” decision. The no-filter claim is valid only for the legacy public share page.
- `client.html` public API exposes selected records through the token, but the selected IDs are validated before decisions are persisted. Guessing an influencer ID does not add it to the response or allow a decision for an unselected item. A live test using an invalid fake token returned 404; real-token API behavior was not probed to avoid accessing real client data.

### D2. Link security and access tracking

- Public catalog token: 32 random bytes, URL-safe; SHA-256 hash stored, with only active/published catalogs served. Admin can deactivate or reissue the token. This is unguessable by design and revocable.
- Expiration: **No catalog-token expiry field or expiry check found.** A link remains available until deactivated/reissued or offer status changes.
- Access logging: decision history records submissions and timestamps; audit middleware skips GETs. Public catalog reads are not logged as accesses. No per-token public read history was found.

### D3. Decision lifecycle and UI verification

- Current decisions are in `client_catalog_decisions`; dated transitions are in `client_catalog_decision_history`; admin catalog summaries expose accepted/rejected counts and selected influencer summaries.
- A client can change/undo a decision and resubmit; “reverted” removes the current decision but preserves history. Admin can reopen/reissue or reactivate a catalog through its management API.
- Existing Playwright test `public client decisions confirm together, keep their history dates, and greet the client by name` verifies saved decisions and timestamps. `client showcase stays readable across languages, themes, and screen sizes and submits staged decisions` verifies welcome text, clean client-name line, readable progress percentage, no filters on the public page, “تغيير القرار” undo, success toast, saved outcomes, Arabic/English, light/dark, 1440px desktop and 390px mobile with no horizontal overflow.
- `presentation-brand-theme.test.mjs` verifies client print suppression/no PDF export. The legacy public catalog’s header counts are derived from that catalog’s selected influencers in `catalogClientPresentation`; no evidence was collected that unrelated database rows feed those counts.
- Direct current-server check: `GET /client/<fake-token>` returned 200 and contained the expected page template/button text; the corresponding fake-token API returned 404. Dynamic rendering against a real catalog was **NOT VERIFIED** on the running app; synthetic browser tests provide the verified behavioral evidence.

## E. Security and permissions

### E1. Roles and authentication

- Live active users: **1 admin, 1 editor, 0 viewer**. Existing tests create synthetic viewers and verify denied writes; a live viewer account was not present for a live API attempt.
- Admin: user/role administration, archive/restore/delete, account-conflict report/export, selected catalog administration, backup and protected data exports, and other admin-only settings.
- Editor: reads, adds/edits, imports/exports where permitted by endpoint, campaigns, notes, and client workflows; cannot delete/archive influencers or administer users.
- Viewer: read-only internal access; server routes reject protected mutations. UI hiding is supplementary, not the permission boundary.
- Passwords use Node `scrypt` with N=16384, r=8, p=1, 16-byte random salt, 64-byte derived hash; password comparisons use constant-time comparison. Client-account passwords use the same path.
- Internal and client sessions are opaque in-memory 32-byte tokens, 8-hour expiry, HttpOnly/SameSite Strict cookies, Secure in production. Restarting the process invalidates sessions. Single-process operation is documented.
- Login locks a source IP after 5 failed attempts for 15 minutes; reset/setup/export attempts have additional in-memory per-IP limits. Limits reset on process restart and are not distributed across workers.

### E2. Web security review

- CSRF: non-GET API requests use same-origin verification. Production requires HTTPS origin and configured/host-matched origin. No complete browser-origin fuzzing was performed.
- CSP and headers: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and `Permissions-Policy` are set. Some app pages allow inline script/style; no CSP bypass test was performed.
- XSS: public UI uses text assignment/escaping in the reviewed flows; no systematic payload scan was performed. **NOT VERIFIED** as a full XSS guarantee.
- SQL injection: reviewed route SQL uses SQLite prepared statements for values and static/allowlisted columns; no injection payload campaign was run. **NOT VERIFIED** by exploit testing.
- Influencer phone fields: public catalog sanitizer excludes them; existing client test confirms absence. Audit redaction removes `Number`, `Country Code`, and `Full_Mobile_Number`; the audit test checks this. Other personal record fields can still be retained in internal audit snapshots, so access and retention should be limited.
- Secrets/repository: **NOT VERIFIED**. There is no `.git` directory, so no complete tracked-file/history scan was possible. Root inspection found `.env.example` but no `.env`; `.gitignore` excludes `data/` and `.env`. This does not prove release archives or other subprojects contain no secret.
- SQLite is not application-encrypted. Protect `data/`, backups, and the host volume with filesystem permissions and disk encryption.

### E3. Backup/restore

`tests/backup-restore.test.mjs`, test `a full SQLite backup restores records and campaign relationships on an isolated server`, creates a backup, checks `quick_check`, restores to a second isolated server, and verifies records/relationships. **Passed** as part of the 86-test suite. A restore of the live database/backups was not attempted because this is a read-only audit. README documents daily SQLite backups and 30-file retention; external/offsite recovery and current backup availability were **NOT VERIFIED**.

## F. UX, performance, and test coverage

- Brand tokens `#2D82C4` and `#F78E1E` are documented in README and the shared design CSS. `npm.cmd run check` passed its contrast checks; this does not establish accessibility of every state/widget.
- Public legacy client showcase: tests verify bilingual layout, RTL/LTR, dark/light, 1440px and 390px widths, decisions and success feedback. Other authenticated client pages include filters. Not every page was manually browsed at every viewport.
- Admin database uses server-side search/filter/pagination and FTS5. Tests verify 4,000-row paging/filter/search, 5,000-row totals/search, and 10,000-row paging/search/export/details/import/campaign linking. The 10,000+ tests use synthetic data, not live query latency.
- `tests/scalability.test.mjs` includes a 2,000-row import (1,000 creates + 1,000 unchanged); the audit run’s test diagnostic reported about **784 ms** for that bulk import on this machine. A 3,000+ row upload plus memory profile is **NOT VERIFIED**.
- Test coverage includes tiers, import ownership/preview, account collisions, client selection and decisions, role checks, security headers/setup, backup/restore, brand/theme and contrast, and synthetic scale. It does not establish correctness against the missing source sheet, fully test national/international phone equivalence, or perform a penetration test.
- Existing prior UI changes are verified by synthetic Playwright coverage. The current running server’s fake-token checks verified static serving only, not a live real-client rendering.

## G. Recommendations

| Recommendation | Why / impact | Effort | Risk |
|---|---|---:|---|
| Preserve a verified backup and reconcile against the authoritative 3,051-row sheet; quarantine the 3,047 identity-empty rows before any cleanup | Establishes source truth; prevents destructive “cleanup by guess.” | M | High if rows are deleted/merged without review; keep the work staged. |
| Review the 7 shared-account groups manually and decide ownership; do not auto-merge | Existing account collision guard does not resolve historical ambiguity. | S–M | High if handles are transferred automatically. |
| Normalize phone identity explicitly to E.164 with original source fields retained; use phone alone for automatic matching, with username matches shown as review candidates | Resolves format drift and aligns import policy with project rule. | M | Medium: erroneous phone canonicalization can link different people. |
| Move platform accounts to `influencer_accounts(influencer_id, platform, normalized_username, followers, verified, tier, source)` with unique `(platform, normalized_username)` after staged conflict cleanup | Enforces ownership structurally and makes multi-platform data/querying safer. | L | High migration risk; require dual-read validation and rollback. |
| Persist imports as staged batches: upload → parse → match → preview → confirmed commit → reversible batch; store source hash, actor, timestamps, per-row result and undo data | Prevents repeat-import ambiguity and enables traceable recovery. | L | Medium/high: undo must not erase later edits or client/campaign links. |
| Redact/minimize audit snapshot fields; retain structured, explicitly permitted fields and apply retention/access policy | Reduces personal-data exposure while retaining useful accountability. | M | Low/medium; retain enough evidence for investigations. |
| Add client-link expiry, explicit reissue/revoke workflow, rate limits, and access-event logging that does not record token/PII | Current links have no expiry and GET access is not logged. | M | Low/medium; expiry can interrupt client work if defaults are too short. |
| Apply the no-filter/no-search product rule consistently or explicitly scope it to the public link; review authenticated `showcase.html`/`portal.html` behavior | Current client surfaces disagree with the user decision. | S–M | Low. |
| Keep archive/restore; make duplicate review and identity-link auditing visible to admins | Existing archive is reversible; a review queue avoids direct destructive cleanup. | M | Low/medium. |
| Keep SQLite for local single-process use. Decide on PostgreSQL only after concurrency/hosting requirements, migration rehearsal, TLS, backups and recovery are defined | Current documented model is local and single-worker; PostgreSQL adds operations but supports hosted multi-user concurrency. | M–L | Medium/high migration and operational risk. |
| Do not enable the separate collector or automatic follower sync until official APIs, scopes, platform terms, and authorization are validated | No approved integration is part of the current CRM. | S for policy review; L for integration | High compliance/account risk if bypassed. |

**Phased plan**

1. **Data cleanup and duplicate prevention:** freeze destructive cleanup; back up; obtain source sheet; compute source-to-record match report; quarantine blank rows; human-review account/name candidates; document phone canonicalization. Keep all unresolved matches visible.
2. **Import rewrite:** durable staged batch and explicit confirmation; phone-only automatic identity matching; username/account conflicts as review items; persistent import history; idempotency/source fingerprint; safe reversible batch operation; tests including phone-format variants and 3,000+ rows with memory.
3. **Client portal hardening:** align all client surfaces to no-search/no-filter if confirmed; verify field allowlists; add expiry, revocation, rate limits, access logging, and direct API scoping tests.
4. **UX polish:** resolve the `Main_Username` policy conflict; test all admin/client pages at mobile/desktop in both languages and themes; run accessibility checks on real interactive pages.
5. **Hosting readiness:** keep loopback during review; decide deployment topology; add TLS/proxy configuration, secret handling, encrypted/offsite backups, monitoring and restore drills; migrate to PostgreSQL only if concurrency/hosting needs justify it.

## H. Verdict

**Ready for real operational use: NO.**

Minimum before relying on this database for decisions:

1. Obtain and validate the actual 3,051-row source sheet and map its rows to the 3,004-row snapshot/current records.
2. Quarantine/review the 3,047 identity-empty records and manually resolve the 7 shared-account groups; do not bulk-delete or merge.
3. Decide the conflicting `Main_Username` and identity-match policies; implement one agreed policy and test it with realistic synthetic phone-format cases.
4. Add durable import batch history and a safe post-commit recovery strategy; verify 3,000+ row behavior.
5. Resolve the client-surface filter mismatch and add link expiry/access controls before broad client distribution.
6. Confirm live backup availability and conduct a separately approved restore drill; protect personal data and review audit-log retention.
7. Keep hosting blocked until the local data and security review is approved.

## Conflicts requiring product-owner decision

1. **`Main_Username`:** the audit subject’s standing project rule says it is independent from social usernames/`Best Platform`; the user’s audit context says it must always be derived from the highest-follower platform. Current code/README derive it. These requirements cannot both hold.
2. **Automatic matching:** the standing project rule permits phone only for automatic duplicate detection; the user’s audit context requests phone first and username second. Current importer automatically matches normalized platform usernames. Choose the policy before changing identity resolution.
3. **Real duplicate examples in documentation:** the user requested real duplicate pairs; the project instruction forbids real records in documentation. This report follows the privacy rule and supplies aggregate evidence only.

## Key evidence references

- Schema, migrations, triggers and indexes: [`server.mjs` (schema setup)](../server.mjs#L930) and [`server.mjs` (conditional migrations)](../server.mjs#L350).
- Tier logic: [`assets/follower-tiers.js`](../assets/follower-tiers.js); derivation in [`server.mjs`](../server.mjs#L223).
- Import matching and normalization: [`server.mjs`](../server.mjs#L2382), [`server.mjs`](../server.mjs#L3464), [`server.mjs`](../server.mjs#L8774), [`server.mjs`](../server.mjs#L8821).
- Password/session/origin controls: [`server.mjs`](../server.mjs#L1755), [`server.mjs`](../server.mjs#L1837), [`server.mjs`](../server.mjs#L1877), [`server.mjs`](../server.mjs#L3404).
- Public catalog and decision validation: [`server.mjs`](../server.mjs#L4719), [`server.mjs`](../server.mjs#L5708), [`server.mjs`](../server.mjs#L5716).
- Import repeat/conflict tests: [`tests/client-portal.test.mjs`](../tests/client-portal.test.mjs#L2143), [`tests/client-portal.test.mjs`](../tests/client-portal.test.mjs#L2411).
- Public decision/UI tests: [`tests/client-portal.test.mjs`](../tests/client-portal.test.mjs#L1007), [`tests/client-portal.test.mjs`](../tests/client-portal.test.mjs#L1060).
- Scoped client sanitizer/filter evidence: [`tests/client-portal.test.mjs`](../tests/client-portal.test.mjs#L1896).
- Scale/restore/security: [`tests/scalability.test.mjs`](../tests/scalability.test.mjs#L147), [`tests/backup-restore.test.mjs`](../tests/backup-restore.test.mjs#L55), [`tests/audit-export-security.test.mjs`](../tests/audit-export-security.test.mjs#L113).
- Operation and project rules: [`README.md`](../README.md), [`DEPLOYMENT.md`](../DEPLOYMENT.md).

---

### الملخص التنفيذي

النظام لا يزال غير جاهز للاعتماد التشغيلي قبل مراجعة السجلات ومجموعات الحسابات المشتركة وتوفير ملف المصدر الأصلي. بعد التدقيق، أُضيفت معاينة استيراد مع بوابات تأكيد وسجل دفعات وتراجع آمن، وطُبّع الهاتف إلى E.164؛ لكن الحساب المطابق وحده لا يُحدّث تلقائيًا بسبب تعارض سياسة لم يُحسم، كما أن سياسة `Main_Username` متعارضة. لم تتغير بيانات قاعدة الإنتاج ولم يُنفذ استيراد حي. نتائج الاختبارات والتجربة الاصطناعية على نسخة موضحة في قسم المتابعة.

## Implementation follow-up — 2026-11-16

This section records changes made after the read-only audit above. The original audit sections describe the state observed during that audit and are not a claim that the source code remains unchanged. No live database rows, schema, or configuration were changed in this follow-up.

### Changes made

- `server.mjs` now normalizes Saudi/Gulf phone identity keys to E.164, including Arabic digits, while preserving imported source phone fields. Phone is the only implicit identity match; account-only matches and identity conflicts are routed to review rather than automatically attached or updated. Archived phone matches require explicit restore confirmation.
- Import headers now use case- and whitespace-tolerant English and Arabic aliases, including `Username Tiktok`, `Username Snapchat`, and `Username Instagram`. Unknown columns are listed in preview and block commit until acknowledged. A file with no identity fields (name, phone, or account) is rejected with Arabic and English messaging. An all-new import into a nonempty database requires explicit confirmation.
- `import_batches` records file name, SHA-256, actor/timestamps, counts, per-row results, and undo snapshots. Undo is conservative: rows changed since import or linked to data are skipped rather than erased.
- `influencer_accounts` provides a database-level unique constraint on `(platform, normalized_username)` and synchronization triggers. Historical duplicate groups are not silently reassigned or merged during index population.
- Import preview, approval gates, and batch undo controls were added to `index.html`; related styles and workflow documentation were updated.
- Focused isolated-database tests were added/updated in `tests/import-pipeline.test.mjs` and related test files.

### Verification evidence

Commands executed:

```text
node --test --test-name-pattern="dashboard import acknowledgements" tests/import-pipeline.test.mjs
1 test passed, 0 failed.

npm.cmd test
89 tests, 89 passed, 0 failed, 0 skipped.

npm.cmd run check
Passed: node --check server.mjs; all reported contrast pairs met WCAG AA (4.5:1).
```

The focused test `header aliases, approval gates, E.164 matching, conflicts, batch undo, and account uniqueness` passed against an isolated SQLite database. It verifies normalized phone variants, review routing for account-only identity, batch SHA-256 and guarded undo, and rejection of duplicate account keys by the database constraint.

The test `3,051-row synthetic import, exact repeat, and 100 updates plus 50 new rows` passed. Its output reported 3,051 synthetic rows; first import 4,256 ms; identical repeat 1,564 ms with 0 created; mixed import exactly 100 updated and 50 created. The memory figure from the separate copy experiment below is a single end-of-run sample, **not peak memory**.

### Copy-only wipe and re-import experiment

The experiment used a temporary copy of the pre-existing backup at `C:\Users\hp\AppData\Local\Temp\fikratak-reimport-copy-2Ba5qZ\data\fikratak.sqlite`. That temporary copy and synthetic records were removed after the experiment. No live database mutation was performed.

Before wipe, the copy contained 6,052 influencer rows. Direct influencer references observed before wipe were: `client_catalog_items` 9; `client_inquiries` 0; `client_catalog_decisions` 9; `campaign_targets` 5; `client_decision_history` 0; `client_campaign_actions` 0; `client_catalog_decision_history` 19; `campaign_checkin_history` 0; `client_visits` 0; `client_showcase_feedback` 0; `influencer_follower_history` 0; `influencer_status_history` 1; `influencer_advertiser_notes` 0; `influencer_advertiser_note_history` 0; `influencer_profile_images` 0; `coverage_videos` 0. `influencer_search` held 6,052 rows. Two audit-event references remained after the wipe.

On the copy, influencer count changed 6,052 → 0; `influencer_search` changed 6,052 → 0; those direct-link tables had 0 rows after wipe; audit references remained 2. Post-wipe checks reported `PRAGMA quick_check = ok` and `PRAGMA foreign_key_check = 0 rows`.

The synthetic replacement import created 3,051 influencers/accounts, with 3,051 distinct non-null phone keys and 0 duplicate account groups. Re-importing the same file created 0 and left all 3,051 unchanged. The subsequent mixed file produced 100 updates, 50 additions, and 0 failures, for 3,101 final influencers/accounts. The account uniqueness indexes were present. The sampled end-of-run process memory was 230,678,528 working-set bytes and 232,824,832 private bytes; peak memory was **NOT VERIFIED**.

### Policy conflicts and items not verified

1. The latest product direction permits matching automatically by `(platform, normalized handle)` after phone matching. The standing project rule allows automatic identity matching by phone only. To honor that higher-priority project rule, account-only matches remain `needs review`; automatic account matching was **NOT IMPLEMENTED**. Please resolve this conflict before the real source import.
2. The product direction says `Main_Username` must always derive from the highest-follower platform, while the standing project rule says it is independent and must not be changed by platform-account edits. Existing derivation logic was not changed; the import changes do not guarantee that every imported record has a derived `Main_Username`. The policy conflict remains unresolved.
3. The actual authoritative complete source spreadsheet and its exact headers were not available, so mapping coverage and import results on the real file are **NOT VERIFIED**. The project template is not a substitute.
4. No live import, live wipe, or live schema migration was performed. No hosting or Phase 2 work was started.

Before any live change, copy the existing backup off-device: it remains on the same device as the database.
