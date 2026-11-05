# AnnSetu — Smart Inventory Expiry Tracker & Food Distribution System

DBMS Project Report

---

## 1. Problem Statement

Grocery stores, hostels, canteens, caterers and food banks lose a large share of their stock simply because nobody notices it is about to expire. At the same time, NGOs, night shelters, orphanages and old-age homes struggle to get enough food.

The problem is a data problem:

- Stock is tracked per **product**, but expiry happens per **batch** (the same milk arrives every day with a different expiry date).
- Nobody knows, at a glance, which batches expire in the next 1–3 days.
- There is no structured link between surplus food and the organisations that need it.
- Waste and donations are not recorded, so the problem cannot be measured.

**AnnSetu** ("food bridge") solves this with a relational database that:

1. Tracks every batch with its own manufacturing and expiry date.
2. Computes a live expiry status (Expired / Critical / Near Expiry / Fresh / Depleted) for every batch.
3. Lets NGOs raise food requests and automatically matches them with the stock that expires first (FEFO — First Expiry, First Out).
4. Records every stock change in a ledger and keeps an automatic audit trail.
5. Reports wastage, value at risk, meals served and NGO impact.

## 2. Objectives

- Design a normalised (3NF) relational schema for inventory, NGOs and distribution.
- Enforce business rules **inside the database** using constraints and triggers, not only in application code.
- Use views for derived data (status, days left, progress) instead of storing values that go stale.
- Use transactions so a multi-batch dispatch is atomic.
- Demonstrate joins, aggregation, subqueries, CTEs (including recursive) and window functions on real data.

## 3. Technology

| Layer | Technology |
|---|---|
| Database (demo) | SQLite 3.45 compiled to WebAssembly (sql.js) — runs fully in the browser |
| Database (submission script) | MySQL 8.0 (`sql/annsetu_mysql.sql`) |
| Front end | HTML, CSS, vanilla JavaScript, Chart.js |
| Theme | Blue and white |

Every screen in the app is rendered from SQL queries. A **SQL Log** drawer shows each statement the interface sends to the database, and the **SQL Console** lets the examiner run any query live.

## 4. Modules

| Module | What it does | Main DBMS concepts |
|---|---|---|
| Dashboard | KPIs, 14-day donated vs wasted chart, expiry alerts, open requests | Scalar subqueries, recursive CTE, views |
| Inventory & Expiry | All batches with live status, search / filter, receive stock, issue, discard, donate | View, parameterised queries, INSERT, CHECK, triggers |
| Food Distribution | NGO requests, FEFO smart match, one-click dispatch, history | Window function `SUM() OVER`, transaction `BEGIN…COMMIT/ROLLBACK`, 4-table JOIN |
| NGOs | Register NGOs, impact cards ranked by meals served | `RANK() OVER`, LEFT JOIN, UNIQUE / CHECK |
| SQL Reports | 10 ready analytical queries | GROUP BY, HAVING, CASE, NOT EXISTS, nested subquery, PARTITION BY |
| SQL Console | Run any SQL; examples that deliberately trigger errors | DDL / DML / DQL |
| Schema & ER | ER diagram generated from the catalog, full DDL of tables, views, triggers, indexes | System catalog (`sqlite_master`, `PRAGMA`) |
| Audit Log | Rows written only by triggers + full stock ledger | Triggers, ledger pattern |

## 5. Database Design

### 5.1 Entities and attributes

| Table | Primary key | Important attributes | Foreign keys |
|---|---|---|---|
| category | category_id | name (UNIQUE), storage_type (Dry/Chilled/Frozen), alert_days | — |
| supplier | supplier_id | name, phone (10 digits), city | — |
| warehouse | warehouse_id | name (UNIQUE), city, capacity_kg | — |
| product | product_id | name (UNIQUE), unit, unit_price | category_id |
| batch | batch_id | batch_code (UNIQUE), mfg_date, expiry_date, qty_received, qty_available, received_on | product_id, supplier_id, warehouse_id |
| ngo | ngo_id | name, registration_no (UNIQUE), contact_person, phone, city, beneficiaries | — |
| food_request | request_id | qty_needed, needed_by, status, created_on | ngo_id (ON DELETE CASCADE), category_id |
| distribution | distribution_id | qty, distributed_on, volunteer | batch_id, ngo_id, request_id (nullable) |
| stock_movement | movement_id | movement_type (IN/ISSUE/DONATION/WASTE), qty, moved_on, note | batch_id |
| audit_log | log_id | table_name, action, record_id, details, logged_at | — |

### 5.2 Relationships (cardinality)

- category 1 — N product
- product 1 — N batch
- supplier 1 — N batch
- warehouse 1 — N batch
- batch 1 — N stock_movement
- batch 1 — N distribution
- ngo 1 — N food_request
- ngo 1 — N distribution
- food_request 1 — N distribution (optional; walk-in donations have no request)
- category 1 — N food_request

`distribution` is the associative entity that resolves the **many-to-many** relationship between batch and ngo.

### 5.3 ER diagram (text form)

```
category ──< product ──< batch >── supplier
   │                      │  │
   │                      │  └──< stock_movement
   │                      │
   └──< food_request      └──< distribution >── ngo
             │                     │             │
             └─────────────────────┘             │
             └──────────────────────────────────>┘ (ngo 1—N food_request)
audit_log  (written by triggers)
```

The app's **Schema & ER Diagram** page draws the full diagram live from the database catalog.

### 5.4 Normalisation

- **1NF** — every column holds one atomic value; no repeating groups (each delivery is its own batch row, each donation its own distribution row).
- **2NF** — every table has a single-column surrogate key, so no partial dependencies exist.
- **3NF** — no transitive dependencies: product name / category / price are not repeated in `batch`; supplier and warehouse details live in their own tables; NGO details are not repeated in `food_request` or `distribution`.
- **Derived data is not stored** — `days_left` and `status` change every day, so they are computed by the view `v_batch_status`. The request status is the only derived value stored, and it is maintained exclusively by a trigger.

## 6. Integrity Constraints

| Constraint | Rule |
|---|---|
| `CHECK (expiry_date > mfg_date)` | A batch cannot expire before it is made |
| `CHECK (qty_available >= 0 AND qty_available <= qty_received)` | Stock can never be negative or exceed what was received |
| `CHECK (qty > 0)` | No zero / negative movements or donations |
| `CHECK (length(phone) = 10)` | Valid Indian mobile numbers |
| `CHECK (storage_type IN (...))`, `CHECK (status IN (...))` | Domain constraints (ENUM in MySQL) |
| `UNIQUE (batch_code)`, `UNIQUE (registration_no)` | No duplicate batches or NGO registrations |
| `FOREIGN KEY … ON DELETE CASCADE` | Deleting an NGO removes its requests |

## 7. Triggers

| # | Trigger | Event | Purpose |
|---|---|---|---|
| T1 | trg_batch_in | AFTER INSERT ON batch | Writes an `IN` movement and an audit row for every new batch |
| T2 | trg_check_stock | BEFORE INSERT ON stock_movement | Aborts with *"Insufficient stock in this batch"* if qty > available |
| T3 | trg_reduce_stock | AFTER INSERT ON stock_movement | Deducts ISSUE / DONATION / WASTE from `batch.qty_available` |
| T4 | trg_no_expired_donation | BEFORE INSERT ON distribution | Aborts with *"Cannot distribute expired food"* |
| T5 | trg_after_distribution | AFTER INSERT ON distribution | Creates a DONATION movement (which fires T2 + T3), updates the request to Partially Fulfilled / Fulfilled, writes audit |
| T6 | trg_audit_waste | AFTER INSERT ON stock_movement | Audits every wastage entry |
| T7 | trg_audit_ngo | AFTER INSERT ON ngo | Audits new NGO registrations |

Triggers are **chained**: one `INSERT INTO distribution` causes T4 → T5 → T2 → T3 → audit, all inside one statement. If any step fails, the whole statement is rolled back.

## 8. Views

- **v_batch_status** — joins batch, product, category, warehouse, supplier; computes `days_left` and `status` with a CASE expression using each category's `alert_days`.
- **v_request_progress** — each request with quantity fulfilled, remaining and days to deadline (LEFT JOIN + GROUP BY).
- **v_ngo_impact** — donations, kg received and meals served per NGO (1 meal ≈ 0.4 kg).

## 9. Smart FEFO Matching (core algorithm)

```sql
WITH candidates AS (
  SELECT b.batch_id, b.batch_code, b.expiry_date, b.qty_available,
         SUM(b.qty_available) OVER (ORDER BY b.expiry_date, b.batch_id) AS running_total
  FROM batch b JOIN product p ON p.product_id = b.product_id
  WHERE p.category_id = :cat AND b.qty_available > 0 AND b.expiry_date >= date('now')
)
SELECT batch_id, batch_code, expiry_date, qty_available,
       MIN(qty_available, :need - (running_total - qty_available)) AS allocate
FROM candidates
WHERE running_total - qty_available < :need
ORDER BY expiry_date;
```

The running total (window function) picks the earliest-expiring batches until the requested quantity is covered. The dispatch then runs inside a transaction:

```sql
BEGIN TRANSACTION;
INSERT INTO distribution(batch_id, ngo_id, request_id, qty, volunteer) VALUES (...);
INSERT INTO distribution(batch_id, ngo_id, request_id, qty, volunteer) VALUES (...);
COMMIT;      -- or ROLLBACK if any trigger raises an error
```

In MySQL the same logic is provided as the stored procedure `sp_fefo_dispatch(request_id, volunteer)` using a cursor, `START TRANSACTION` and an `EXIT HANDLER` that rolls back.

## 10. Sample Report Queries

1. Near-expiry stock by warehouse — JOIN + date range
2. Value at risk by category — GROUP BY, SUM, HAVING
3. Wastage % by category — conditional aggregation with CASE
4. NGO leaderboard — LEFT JOIN + RANK() window
5. Products never donated — NOT EXISTS correlated subquery
6. Warehouse utilisation — LEFT JOIN with join-condition filter
7. Supplier freshness score — AVG of julianday difference
8. Overdue & urgent requests — querying a view
9. Running stock per product — SUM() OVER (PARTITION BY … ORDER BY …), ROW_NUMBER()
10. Above-average NGOs — nested aggregate subquery

Plus a **recursive CTE** on the dashboard that generates a 14-day date series so days with zero donations still appear on the chart.

## 11. How to Run

**Web app (no installation):** open the app link. The database is created in the browser with sample data each time; use **Reset database** in the sidebar to start over.

**MySQL:**

```bash
mysql -u root -p < sql/annsetu_mysql.sql
mysql -u root -p annsetu -e "CALL sp_expiry_alerts(3);"
mysql -u root -p annsetu -e "CALL sp_fefo_dispatch(4, 'Rahul');"
```

## 12. Demo Script for the Viva (5 minutes)

1. **Dashboard** — explain the KPIs and expiry alerts; open the SQL Log to show the queries behind them.
2. **Inventory** — filter by *Critical*; explain that status is computed by a view.
3. **Receive stock** with expiry before manufacturing date → the CHECK constraint rejects it.
4. **Donate** more than available → trigger T2 rejects it.
5. **Food Distribution** → *Smart match* on Little Hands Orphanage → show the FEFO plan and its SQL → *Dispatch*. The request becomes Fulfilled and stock drops — all by triggers.
6. **Audit Log** — show the rows the triggers wrote.
7. **SQL Console** → run "Donate expired food?" example → trigger T4 blocks it.
8. **Schema** — ER diagram, DDL of triggers and views, normalisation notes.

## 13. Future Scope

- SMS / WhatsApp alerts to NGOs when critical stock appears near them.
- Barcode / QR scanning for batches.
- Location-based matching (nearest NGO) using latitude/longitude.
- Role-based login (store manager, NGO, volunteer) with GRANT / REVOKE privileges.
- Demand forecasting from historical requests.

## 14. Conclusion

AnnSetu shows how a well-designed relational database can directly reduce food waste. Business rules live in the database itself — constraints, triggers, views and transactions — so the data stays correct no matter which application uses it, and the system turns soon-to-expire stock into meals for people who need them.
