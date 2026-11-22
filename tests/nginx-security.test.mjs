import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = await readFile(new URL('../deploy/nginx.conf.example', import.meta.url), 'utf8');

test('Nginx example enforces HTTPS, gzip, import body limits, and auth rate limits', () => {
  assert.match(config, /listen 80;[\s\S]*?return 301 https:\/\/\$host\$request_uri;/);
  assert.match(config, /listen 443 ssl;/);
  assert.match(config, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.match(config, /gzip on;/);
  assert.match(config, /client_max_body_size 45m;/);
  assert.match(config, /zone=fikratak_login:[^;]+rate=5r\/m/);
  assert.match(config, /zone=fikratak_setup:[^;]+rate=2r\/m/);
  assert.match(config, /zone=fikratak_password_reset:[^;]+rate=2r\/m/);
  assert.match(config, /zone=fikratak_client_login:[^;]+rate=5r\/m/);
  assert.match(config, /location = \/api\/login/);
  assert.match(config, /location = \/api\/setup/);
  assert.match(config, /location ~ \^\/api\/password-reset-/);
  assert.match(config, /location = \/api\/client-portal\/login/);
  assert.match(config, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(config, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
});

test('Nginx example blocks private, documentation, and source-map paths', () => {
  for (const fragment of [
    'data|backups',
    'docs?|tests|scripts|deploy|data-access',
    'server\\.mjs',
    '|map|',
    '\\.(?:env|sqlite'
  ]) assert.ok(config.includes(fragment), `Missing Nginx deny rule fragment: ${fragment}`);
});
