# AnnSetu on Windows with XAMPP and Python

The Python app uses XAMPP's MySQL/MariaDB service for storage and serves the web UI and API from Python. **Apache is not needed** for this setup. The older `sql/annsetu_mysql.sql` and `api/*.php` files belong to the preserved PHP version; use `sql/annsetu_python_mysql.sql` for the Python app.

## First-time setup

1. Install XAMPP and Python 3.12 or newer. The project files can stay in their current folder; they do not need to be copied into `htdocs`.
2. Open the XAMPP Control Panel and start **MySQL**. Leave Apache stopped unless you separately use the legacy PHP app.
3. From PowerShell, change to the project folder and create the Python environment:

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

   If your installed launcher only has Python 3.13, replace `-3.12` with `-3.13`.

4. Import the Python app schema in phpMyAdmin at [http://localhost/phpmyadmin](http://localhost/phpmyadmin): choose **Import**, select `sql/annsetu_python_mysql.sql`, then click **Import**. The script creates a separate `annsetu_python` database and its tables, leaving the legacy PHP `annsetu` database untouched. It is safe to import again; it does not delete application data.
5. Double-click `scripts/start_xampp.bat`, or run it from PowerShell:

   ```powershell
   .\scripts\start_xampp.bat
   ```

   The first launch creates synthetic demonstration records if the database is empty. Keep the console open while using the app.

Open **http://127.0.0.1:8000**. Check **http://127.0.0.1:8000/api/health** for the API and database connection.

## XAMPP configuration

The defaults match a standard XAMPP installation: XAMPP at `C:\xampp`, MySQL on port `3306`, database `annsetu_python`, user `root` with an empty password. If XAMPP is installed elsewhere, set `XAMPP_HOME` before starting the batch file. For a non-default database server, set `ANNSETU_DB_HOST`, `ANNSETU_DB_PORT`, `ANNSETU_DB_NAME`, `ANNSETU_DB_USER`, and `ANNSETU_DB_PASSWORD` in the environment. Import the schema using phpMyAdmin if the MySQL root account has a password, since the included starter script assumes XAMPP's default empty password.

The API binds to `127.0.0.1` by default. It has no login flow, so keep it on the local computer and do not expose it to a public network.

## Features and data

- Inventory batches, expiry-aware recommendations, approvals, and delivery records
- Manual sales and CSV / Excel sales import
- Demand baselines and store / recipient map
- Synthetic demonstration data created automatically on first startup

The scheduled concurrency simulation remains in the PostgreSQL edition and is not included in this XAMPP backend.

The records seeded by the Python app are synthetic. Map tiles use OpenStreetMap. For project notes and the old database/report material, see `README.md` and `PROJECT_REPORT.md`.
