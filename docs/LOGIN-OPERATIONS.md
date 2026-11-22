# Login operations | تشغيل تسجيل الدخول

These commands assume Linux, systemd, the production release at `/opt/fikratak`, and the protected environment file at `/etc/fikratak/fikratak.env`. Replace the hostname and paths if your deployment differs. Never include a password, setup token, or login request body in a command, ticket, or log.

يفترض هذا الدليل Linux وsystemd ووجود إصدار الإنتاج في `/opt/fikratak` وملف البيئة المحمي في `/etc/fikratak/fikratak.env`. استبدل اسم النطاق والمسارات إذا اختلف نشرُك. لا تضع كلمة مرور أو رمز إعداد أو محتوى طلب تسجيل دخول في أمر أو تذكرة أو سجل.

## 1. Clear a login lockout | مسح قفل تسجيل الدخول

Login counters are held in server memory. Restarting clears internal and client-portal login lockouts and also ends active sessions:

عدادات الدخول محفوظة في ذاكرة الخادم. إعادة التشغيل تمسح أقفال دخول النظام وبوابة العميل، كما تنهي الجلسات النشطة:

```sh
sudo systemctl restart fikratak.service
sudo systemctl status fikratak.service --no-pager
sudo journalctl -u fikratak.service --since "5 minutes ago" --no-pager
```

There is no supported no-restart clearing script: the lockout map is private to the running process, not stored in SQLite. An admin endpoint or script would require adding a privileged live-service interface; it is intentionally not exposed.

لا توجد أداة مدعومة لمسح القفل دون إعادة التشغيل؛ خريطة الأقفال خاصة بعملية الخادم ولا تُخزّن في SQLite. يتطلب ذلك إضافة واجهة تشغيلية مقيّدة داخل الخدمة، ولذلك لم نكشفها.

## 2. Create the first admin | إنشاء المدير الأول

Use one of these methods only for a genuinely empty production database. If the host provides a private terminal, start the app once to create the empty database, then run the bundled one-time CLI utility as the service account. It prompts for the username and asks for the password twice without echoing it; it refuses to run if any user already exists and does not require a setup token:

```sh
sudo -u fikratak env \
  FIKRATAK_DATA_DIR=/var/lib/fikratak/data \
  /usr/bin/node /opt/fikratak/scripts/create-first-admin.mjs
```

For hosting without terminal access, use the protected web setup. Generate the token in a private terminal; enter the printed value into the protected environment file using the editor, not into a command argument:

هذا الإجراء لقاعدة إنتاج فارغة فعلًا فقط. أنشئ الرمز في طرفية خاصة، ثم أدخل القيمة الظاهرة في ملف البيئة المحمي باستخدام المحرر، لا كوسيط أمر:

```sh
openssl rand -hex 32
sudoedit /etc/fikratak/fikratak.env
```

Set `FIKRATAK_SETUP_TOKEN` to the generated 64-character value, save the file, and restart:

ضع القيمة ذات 64 خانة في `FIKRATAK_SETUP_TOKEN`، واحفظ الملف ثم أعد التشغيل:

```sh
sudo systemctl restart fikratak.service
```

The token's 30-minute lifetime starts when this server process starts. Open `https://crm.example.com`, submit the first-admin setup form within 30 minutes, then remove `FIKRATAK_SETUP_TOKEN` from the environment file and restart again:

تبدأ صلاحية الرمز، ومدتها 30 دقيقة، عند بدء عملية الخادم. افتح `https://crm.example.com` وأكمل نموذج المدير الأول خلال المهلة، ثم احذف `FIKRATAK_SETUP_TOKEN` من ملف البيئة وأعد التشغيل:

```sh
sudoedit /etc/fikratak/fikratak.env
sudo systemctl restart fikratak.service
```

Setup requires the configured HTTPS Origin and an empty users table. The application rejects setup after the first user exists. Do not send the setup token through chat, URLs, or logs.

يتطلب الإعداد عنوان HTTPS المسموح به وأن يكون جدول المستخدمين فارغًا. يرفض التطبيق الإعداد بعد إنشاء أول مستخدم. لا ترسل الرمز عبر المحادثات أو عناوين URL أو السجلات.

## 3. Recover access if an admin forgot the password | استعادة الدخول عند نسيان المدير كلمة المرور

The production utility adds a **second** administrator; it does not overwrite or reset the existing account. It requires an existing production SQLite database with a `users` table, at least one existing admin and influencer record, separate configured data/backup directories outside the release, Node.js 24+, network access to the public HTTPS login URL, and an interactive private terminal. It creates and validates a full SQLite backup before adding the account, then verifies HTTPS login and admin-only user access. On verification failure, it removes only the newly added account.

تضيف الأداة مديرًا ثانيًا؛ ولا تغيّر كلمة مرور الحساب الحالي. تتطلب قاعدة SQLite إنتاجية قائمة فيها جدول `users` ومدير ومؤثر واحد على الأقل، ومساري بيانات ونسخ احتياطي منفصلين خارج مجلد الإصدار، وNode.js 24+، واتصالًا بعنوان HTTPS العام، وطرفية تفاعلية خاصة. تنشئ نسخة SQLite كاملة وتتحقق منها قبل إضافة الحساب، ثم تتحقق من تسجيل الدخول وامتيازات الإدارة. إذا فشل التحقق، تحذف الحساب الجديد فقط.

Run on the production host as the service account, from a private terminal. `FIKRATAK_LOGIN_URL` must be the public HTTPS origin with no path:

شغّل الأمر على خادم الإنتاج بحساب الخدمة ومن طرفية خاصة. يجب أن يكون `FIKRATAK_LOGIN_URL` عنوان HTTPS العام دون مسار:

```sh
sudo -u fikratak env \
  FIKRATAK_DATA_DIR=/var/lib/fikratak/data \
  FIKRATAK_BACKUP_DIR=/var/backups/fikratak \
  FIKRATAK_LOGIN_URL=https://crm.example.com \
  /usr/bin/node /opt/fikratak/scripts/create-production-admin.mjs
```

Type `ADD-ADMIN` at the confirmation prompt. On success, the utility prints a verification summary, the backup path, generated username, temporary password, and login URL to its terminal. It does not write these values to the app's journal; never redirect or capture the output. Errors are written to stderr. Deliver credentials privately and change the temporary password after sign-in. Existing accounts remain enabled.

اكتب `ADD-ADMIN` عند التأكيد. عند النجاح تعرض الطرفية ملخص التحقق ومسار النسخة الاحتياطية واسم المستخدم وكلمة المرور المؤقتة وعنوان الدخول. لا تكتب الأداة هذه القيم في سجل الخدمة؛ لا تعِد توجيه المخرجات ولا تلتقطها. تُكتب الأخطاء إلى stderr. سلّم بيانات الدخول عبر قناة خاصة وغيّر كلمة المرور المؤقتة بعد الدخول. تبقى الحسابات الحالية مفعّلة.

## 4. Diagnose a failed login without exposing passwords | تشخيص فشل الدخول دون كشف كلمات المرور

Application auth events contain only the channel (`internal` or `client-portal`), outcome, source IP, and—on bad credentials—the attempt count and configured limit. They never include usernames, passwords, or request bodies. IP addresses are operational data; restrict log access and retention.

تحتوي أحداث المصادقة في سجل التطبيق على القناة (`internal` أو `client-portal`) والنتيجة وعنوان المصدر، وعند بيانات الدخول الخاطئة عدد المحاولات والحد المضبوط فقط. لا تحتوي على أسماء المستخدمين أو كلمات المرور أو أجسام الطلبات. عناوين IP بيانات تشغيلية؛ قيّد الوصول إلى السجلات ومدة الاحتفاظ بها.

```sh
sudo journalctl -u fikratak.service --since "30 minutes ago" --no-pager -o cat \
  | grep '"event":"auth.login"'
sudo journalctl -u nginx.service --since "30 minutes ago" --no-pager
```

Interpret `bad_credentials` as a rejected username/password, `locked` as an active lockout (with `retryAfter` seconds), and `no_users` as an empty internal users table requiring setup. Nginx can independently return HTTP 429; inspect its access/error logs if the request never reaches the app. Do not enable request-body logging or use `curl -v` with credentials.

تعني `bad_credentials` رفض اسم المستخدم/كلمة المرور، وتعني `locked` وجود قفل فعّال (وتظهر معه قيمة `retryAfter` بالثواني)، وتعني `no_users` أن جدول المستخدمين الداخلي فارغ ويتطلب الإعداد. قد يعيد Nginx الحالة 429 بصورة مستقلة؛ راجع سجلات الوصول/الأخطاء لديه إذا لم يصل الطلب إلى التطبيق. لا تفعّل تسجيل محتوى الطلبات ولا تستخدم `curl -v` مع بيانات الدخول.

## 5. User-facing login errors | رسائل الخطأ للمستخدم

- Wrong credentials: **“Incorrect username or password.”** / **«اسم المستخدم أو كلمة المرور غير صحيحة.»** This stays the same whether the username is unknown or the password is wrong.
- Active lockout: **“Locked, try again in N minutes.”** / **«تم قفل الدخول. حاول مرة أخرى خلال N دقيقة.»** `N` is rounded up from the remaining seconds.
- Empty internal users table only: **“No users exist yet. Run setup.”** / **«لا يوجد مستخدمون بعد، شغّل الإعداد الأولي.»** The API returns this only while the internal users table is empty; it does not reveal account existence after setup. Client-portal login always keeps the generic wrong-credentials response.

## 6. Lockout configuration and trusted proxy | إعداد القفل والوكيل الموثوق

`FIKRATAK_LOGIN_MAX_ATTEMPTS` defaults to `6`; `FIKRATAK_LOGIN_LOCKOUT_MINUTES` defaults to `10`. Both apply to internal and client-portal login. Configure them in the protected service environment and restart the service. Login counters are per source IP and remain separated between internal and client-portal endpoints.

القيمة الافتراضية لـ `FIKRATAK_LOGIN_MAX_ATTEMPTS` هي `6`، ولـ `FIKRATAK_LOGIN_LOCKOUT_MINUTES` هي `10`. ينطبق الإعدادان على دخول النظام وبوابة العميل. غيّرهما في بيئة الخدمة المحمية ثم أعد التشغيل. العدّاد لكل عنوان مصدر، مع فصل مساري النظام وبوابة العميل.

The included Nginx config overwrites `X-Forwarded-For` with `$remote_addr`. The app uses that header only when the direct socket peer is exactly `127.0.0.1` and that address is listed in `FIKRATAK_TRUSTED_PROXIES`; it accepts one valid IP only. Never expose the Node port publicly or configure a proxy to preserve client-supplied forwarding headers.

يضبط ملف Nginx المرفق `X-Forwarded-For` على `$remote_addr` مباشرةً. لا يعتمد التطبيق على هذا الترويس إلا إذا كان النظير المباشر للمقبس هو `127.0.0.1` بالضبط وكان العنوان ضمن `FIKRATAK_TRUSTED_PROXIES`، كما يقبل عنوان IP صحيحًا واحدًا فقط. لا تكشف منفذ Node للعامة ولا تضبط الوكيل لتمرير ترويسات العميل كما هي.
