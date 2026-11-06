# AnnSetu — Grocery Store Operations

A local grocery-store workflow built on the preserved AnnSetu project: product stock, batch expiry, sales capture/import, sales baselines, surplus suggestions, approval, delivery, and impact estimates. The new API uses PostgreSQL.

## Local setup

Dependencies used by the project are installed in `.venv` and listed in `requirements.txt` (FastAPI, Uvicorn, Psycopg, pandas, scikit-learn, and openpyxl). PostgreSQL 18.6 is installed via Postgres.app.

The current machine has a local database named `annsetu`, owned by the macOS account. The migration and clearly synthetic seed data have already been applied.

```bash
cd "DBMS project"
./scripts/start_local.sh
```

Open **http://127.0.0.1:8000**. API health: **http://127.0.0.1:8000/api/health**. Swagger docs: **http://127.0.0.1:8000/docs**. The application intentionally has no authentication flow and binds to loopback for local development.

To recreate the database from scratch, stop the app and run:

```bash
 dropdb annsetu
 createdb annsetu
 psql -v ON_ERROR_STOP=1 -d annsetu -f database/migrations/001_initial_postgresql.sql
 psql -v ON_ERROR_STOP=1 -d annsetu -f database/migrations/002_realtime_simulation.sql
 psql -v ON_ERROR_STOP=1 -d annsetu -f database/seed.sql
```

Postgres.app command line tools are in `/Applications/Postgres.app/Contents/Versions/latest/bin`.

## Store workflow

1. Receive a product batch with a lot code, quantity, and expiry date.
2. Record individual sales or import CSV / Excel (`Sales Import` sheet) using `data/templates/AnnSetu_Excel_Inputs_and_ML_Data.xlsx`.
3. Generate 1, 3, and 7-day demand baselines from the previous 28 days.
4. Review inventory and expiry-aware surplus candidates.
5. Propose an allocation, approve to reserve inventory transactionally, then confirm delivery.
6. View estimated economic impact from delivered records.
7. Use the network map to view stores, recipient sites, and open needs; add synthetic demand or request the browser's current location.
8. Run a scheduled simulation to exercise sales, Random Forest forecasts, competing allocations, row locks, deliveries, and the audit trail.

All seed records are synthetic. `data/synthetic/sales_history_daily.csv` contains two years of deterministic daily data across four SKUs; `ml/generate_and_train.py` creates lagged features, a time-based holdout and compares a Random Forest with a lag-7 baseline. Current generated holdout results are MAE 1.543 units/day and WAPE 13.17% for Random Forest versus 2.225 and 18.99% for lag-7. These are synthetic-only demonstration metrics, not expected real-store performance. Economic savings use illustrative assumptions until replaced with pilot measurements. Distances are straight-line and the route optimizer remains future work.

## Database, API, and testing

- PostgreSQL schema: `database/migrations/001_initial_postgresql.sql` and `database/migrations/002_realtime_simulation.sql`
- Synthetic seed: `database/seed.sql`
- Excel input workbook: `data/templates/AnnSetu_Excel_Inputs_and_ML_Data.xlsx`
- Synthetic ML history and evaluation: `data/synthetic/` and `ml/evaluation_metrics.json`
- FastAPI backend: `backend/pg_api.py`
- UI: `frontend/`
- Run the dependency-free workflow test for the legacy SQLite adapter: `.venv/bin/python -m unittest discover -s tests -v`. PostgreSQL API smoke checks are available through `/docs`.
- Backup using `pg_dump annsetu > annsetu_backup.sql`; restore into an empty database with `psql -d annsetu -f annsetu_backup.sql`.

The original PHP/MySQL implementation and its DBMS report are preserved in the repository root for reference. Do not expose this local prototype to a public network.

## Vercel + Supabase deployment preparation

The active FastAPI app has a root `index.py` entry point for Vercel. `vercel.json` places its Python function in Mumbai (`bom1`) to match the chosen Supabase database region and adds baseline security response headers. Runtime dependencies stay in `requirements.txt`; the unused OR-Tools package is excluded from the deploy build.

Apply both migrations in order, then load the intended synthetic seed data from `database/seed.sql`. In Vercel, set `DATABASE_URL` to Supabase's shared pooler in transaction mode with `sslmode=require`; use the exact connection details shown in Supabase. Never store the connection string in Git. Protect all Vercel deployments with Vercel Authentication while the app has no in-app authentication. The Vercel preview/production setting must be enabled in the account dashboard.

The simulation writes an event queue to PostgreSQL and processes due events from the open Simulation screen. Work is resumable after revisiting that screen; it does not run as an always-on background worker when no client is open. The map uses the OpenStreetMap tile service and attribution. Its public tile servers are best-effort; replace the configured tile URL with a commercial provider before scaling traffic.

The current app is a local prototype with write-capable routes and no authentication. Do not make its production domain public until access protection is enabled or application authentication and authorization are added. The free Supabase tier is suitable for a demo, but may pause projects after inactivity and does not include automatic database backups; configure a paid tier and backups before relying on persistent operational data.
