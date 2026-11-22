@echo off
setlocal
if not defined FIKRATAK_DATA_DIR (
  echo Set FIKRATAK_DATA_DIR to an absolute path outside the application directory.
  exit /b 1
)
if not defined FIKRATAK_BACKUP_DIR (
  echo Set FIKRATAK_BACKUP_DIR to an absolute path outside the application directory.
  exit /b 1
)
if not defined FIKRATAK_ALLOWED_ORIGINS (
  echo Set FIKRATAK_ALLOWED_ORIGINS to the HTTPS application origin.
  exit /b 1
)
set "NODE_ENV=production"
node "%~dp0server.mjs"
exit /b %errorlevel%
