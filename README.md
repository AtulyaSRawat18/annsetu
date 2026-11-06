# AnnSetu — Grocery Store Operations

AnnSetu helps a local grocery store track stock and expiry, record/import sales, estimate demand, identify surplus, and coordinate food donations. The active local setup is a Python HTTP API connected to XAMPP MySQL/MariaDB.

## Run on Windows with XAMPP

Follow [XAMPP_SETUP_GUIDE.md](XAMPP_SETUP_GUIDE.md). In brief:

1. Start **MySQL** in the XAMPP Control Panel. Apache is not required for the Python app.
2. Create a local Python environment and install packages:

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

3. Import `sql/annsetu_python_mysql.sql` through phpMyAdmin.
4. Run `scripts/start_xampp.bat` and open **http://127.0.0.1:8000**.

The API health endpoint is **http://127.0.0.1:8000/api/health**. MySQL connection settings use `ANNSETU_DB_HOST`, `ANNSETU_DB_PORT`, `ANNSETU_DB_NAME`, `ANNSETU_DB_USER`, and `ANNSETU_DB_PASSWORD` environment variables.

## Application structure

- `backend/mysql_server.py`: Python API and local static-file server for XAMPP MariaDB/MySQL.
- `sql/annsetu_python_mysql.sql`: compatible schema for the Python app.
- `frontend/`: browser interface.
- `scripts/start_xampp.bat`: imports the schema and starts the local Python server.
- `backend/server.py`: preserved SQLite adapter used by the dependency-free workflow tests.
- `api/`, `sql/annsetu_mysql.sql`: preserved PHP/MySQL implementation; separate from the Python app schema.

## Store workflow

1. Record a product batch with a lot code, quantity, and expiry date.
2. Record sales or import a CSV / Excel workbook.
3. Generate demand baselines from recent sales.
4. Review stock and expiry-aware surplus suggestions.
5. Propose and approve an allocation, then confirm delivery.
6. Review estimated economic impact and the audit trail.

The scheduled concurrency simulation from the PostgreSQL edition is not part of this XAMPP backend yet, so the XAMPP interface omits that screen.

Demo records are synthetic. Forecast and savings figures are illustrative and should be replaced with measured pilot data before operational use. Map distances are estimates. The app has no authentication and binds to loopback; do not expose it to a public network.
