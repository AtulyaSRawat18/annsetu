@echo off
setlocal
set "PROJECT_DIR=%~dp0.."
if not defined XAMPP_HOME set "XAMPP_HOME=C:\xampp"
set "MYSQL_EXE=%XAMPP_HOME%\mysql\bin\mysql.exe"
set "PYTHON_EXE=%PROJECT_DIR%\.venv\Scripts\python.exe"
if not defined ANNSETU_DB_HOST set "ANNSETU_DB_HOST=127.0.0.1"
if not defined ANNSETU_DB_PORT set "ANNSETU_DB_PORT=3306"
if not defined ANNSETU_DB_NAME set "ANNSETU_DB_NAME=annsetu_python"
if not defined ANNSETU_DB_USER set "ANNSETU_DB_USER=root"
if not defined ANNSETU_HOST set "ANNSETU_HOST=127.0.0.1"
if not defined PORT set "PORT=8000"

if not exist "%MYSQL_EXE%" (
  echo XAMPP MySQL client not found at "%MYSQL_EXE%".
  echo Set XAMPP_HOME to your XAMPP folder or update this script.
  pause
  exit /b 1
)
if not exist "%PYTHON_EXE%" (
  echo Project Python environment is missing. From this folder run:
  echo py -3.12 -m venv .venv
  echo .venv\Scripts\python.exe -m pip install -r requirements.txt
  pause
  exit /b 1
)

pushd "%PROJECT_DIR%"
echo Importing the Python app schema into XAMPP MySQL/MariaDB...
"%MYSQL_EXE%" --host=%ANNSETU_DB_HOST% --port=%ANNSETU_DB_PORT% --user=%ANNSETU_DB_USER% < sql\annsetu_python_mysql.sql
if errorlevel 1 (
  echo Could not import the schema. Make sure MySQL is running in XAMPP.
  echo The default XAMPP root account has no password. If yours has one, import
  echo sql\annsetu_python_mysql.sql using phpMyAdmin or the mysql client.
  pause
  popd
  exit /b 1
)

echo Starting AnnSetu at http://127.0.0.1:%PORT%/
echo Press Ctrl+C to stop the server.
"%PYTHON_EXE%" -m backend.mysql_server
popd
pause
