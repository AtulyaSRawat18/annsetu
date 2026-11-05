# AnnSetu — Grocery Store Operations

A local grocery-store workflow built on the preserved AnnSetu project: product stock, batch expiry, sales capture/import, sales baselines, surplus suggestions, approval, delivery, and impact estimates. The new API uses PostgreSQL.

## Local setup

Dependencies used by the project are installed in `.venv` and listed in `requirements.txt` (FastAPI, Uvicorn, Psycopg, pandas, scikit-learn, OR-Tools). PostgreSQL 18.6 is installed via Postgres.app.

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

All seed records are synthetic. `data/synthetic/sales_history_daily.csv` contains two years of deterministic daily data across four SKUs; `ml/generate_and_train.py` creates lagged features, a time-based holdout and compares a Random Forest with a lag-7 baseline. Current generated holdout results are MAE 1.543 units/day and WAPE 13.17% for Random Forest versus 2.225 and 18.99% for lag-7. These are synthetic-only demonstration metrics, not expected real-store performance. Economic savings use illustrative assumptions until replaced with pilot measurements. Distances are straight-line and the route optimizer remains future work.

## Database, API, and testing

- PostgreSQL schema: `database/migrations/001_initial_postgresql.sql`
- Synthetic seed: `database/seed.sql`
- Excel input workbook: `data/templates/AnnSetu_Excel_Inputs_and_ML_Data.xlsx`
- Synthetic ML history and evaluation: `data/synthetic/` and `ml/evaluation_metrics.json`
- FastAPI backend: `backend/pg_api.py`
- UI: `frontend/`
- Run the dependency-free workflow test for the legacy SQLite adapter: `.venv/bin/python -m unittest discover -s tests -v`. PostgreSQL API smoke checks are available through `/docs`.
- Backup using `pg_dump annsetu > annsetu_backup.sql`; restore into an empty database with `psql -d annsetu -f annsetu_backup.sql`.

The original PHP/MySQL implementation and its DBMS report are preserved in the repository root for reference. Do not expose this local prototype to a public network.
