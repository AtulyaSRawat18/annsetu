# DBMS design notes

## Entities and cardinalities

`organization` has retailer, recipient, logistics, and administrator subtypes. One retailer organization operates stores; each store has many products; each product belongs to one category and has many dated batches and sales observations. One recipient organization manages recipient sites; each site has declared demand rows. A demand can have several allocation proposals; an allocation contains one or more batch allocation lines. An approved allocation can have one delivery. Forecast runs are recorded per SKU and horizon. Audit rows record sensitive workflow changes.

The running SQLite schema is created in `backend/server.py`. The initial PostgreSQL DDL is in `database/migrations/001_initial_postgresql.sql`. The original MySQL schema and its extensive DBMS examples remain in `sql/annsetu_mysql.sql`.

## Functional dependencies and keys

- `organization_id → name, kind, synthetic`
- `store_id → organization_id, name, city, latitude, longitude`
- `(store_id, sku) → product_id, name, category_id, unit, unit_price, safety_stock`
- `(product_id, lot_code) → batch_id, received_on, expiry_date, quantity, reserved`
- `(product_id, sold_on, source_row_key) → sale_id, quantity, source` (source row key is used for import idempotency)
- `recipient_id → organization_id, site name, location, capacity, storage, verification`
- `demand_id → recipient_id, category_id, quantity, needed_by, status, declared`
- `allocation_id → demand_id, status, created_at, approval and cost fields`
- `delivery_id → allocation_id, status, completion time`; allocation_id is unique, so a delivery has at most one delivery record.

Use surrogate primary keys for stable references, with business uniqueness on store/SKU and product/lot code. PostgreSQL migration uses `NUMERIC` for quantities and monetary values and checks on domain/status values.

## Normalisation rationale

Tables hold atomic attributes (1NF). Product/category, recipient/demand, and batch/stock details are separated so that non-key facts depend on their table key rather than a composite subset (2NF). Organization, category, and product descriptions are not copied into transaction rows; this avoids transitive dependencies (3NF). Allocation lines resolve allocation-to-batch as a many-to-many relationship. Forecasts are stored as run observations with horizon and cutoff metadata rather than overwriting a single prediction. Candidate keys include the stated business unique keys alongside generated IDs. A formal course submission should show attribute closures and minimal covers for the final chosen schema, not infer normalisation merely from surrogate IDs.

## Integrity and transactions

Foreign keys protect references; positive quantity, bounded reservation, status, and unique-key constraints protect row domains. Proposed allocations do not modify inventory. Approval begins a write transaction, rechecks the batch's expiry and unreserved quantity, reserves it, updates the allocation status, and writes audit evidence before commit. SQLite's `BEGIN IMMEDIATE` serializes writers for this local demonstration. The PostgreSQL deployment should use `SELECT ... FOR UPDATE` on eligible batch rows and an atomic reservation update, then commit the allocation and audit row together. Failed checks roll back. This is the basis for the ACID/concurrent reservation demonstration.

## Indexing and relational query examples

The local schema indexes batch expiry, sales by product/date, demand by status/date, and allocation status. The `v_batch_available` view joins batch, product, and category while deriving `available = quantity - reserved`. The dashboard demonstrates selection, projection, joins, grouping/aggregates, and a correlated stock aggregate. Compare `EXPLAIN QUERY PLAN` before and after indexes for expiry and sales history lookups. Do not assert a speed-up without measuring on the same representative dataset.

## SQL vs NoSQL

PostgreSQL is a suitable primary store because inventory, demand, allocation, and delivery have strong relationships and require constraints and transactions. NoSQL is not needed for the prototype; there is no demonstrated high-volume unstructured workload that outweighs the added consistency and operational complexity.

## Recovery, logging, access control

Back up PostgreSQL with `pg_dump` and validate restore into a separate database as part of deployment. PostgreSQL WAL provides crash recovery; retain database backups separately from the host. The local prototype writes application-level audit events and can be backed up via SQLite's backup API. Production deployment still needs managed identities, hashed passwords, session expiry, role checks, secret management, TLS, migrations, and restricted database roles. Do not expose the local role-switch demo or arbitrary SQL console publicly.
