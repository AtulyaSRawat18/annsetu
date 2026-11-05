-- PostgreSQL 15+ target schema. Apply to a dedicated empty database.
CREATE TABLE organization (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('retailer','recipient','logistics','admin')),
  synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_user (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id bigint REFERENCES organization(id),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_role (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK(name IN ('administrator','retailer','recipient','logistics'))
);
CREATE TABLE user_role (
  user_id bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id smallint NOT NULL REFERENCES app_role(id),
  PRIMARY KEY(user_id,role_id)
);
CREATE TABLE store (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id bigint NOT NULL REFERENCES organization(id), name text NOT NULL,
  city text NOT NULL, latitude numeric(9,6), longitude numeric(9,6),
  CHECK(latitude BETWEEN -90 AND 90), CHECK(longitude BETWEEN -180 AND 180)
);
CREATE TABLE recipient_site (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id bigint NOT NULL REFERENCES organization(id), name text NOT NULL,
  city text NOT NULL, latitude numeric(9,6), longitude numeric(9,6),
  capacity_kg numeric(12,3) NOT NULL CHECK(capacity_kg>0),
  cold_storage boolean NOT NULL DEFAULT false, verified_at timestamptz,
  receiving_start time, receiving_end time
);
CREATE TABLE category (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE, storage text NOT NULL CHECK(storage IN ('ambient','chilled','frozen'))
);
CREATE TABLE product (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, store_id bigint NOT NULL REFERENCES store(id),
  sku text NOT NULL, name text NOT NULL, category_id bigint NOT NULL REFERENCES category(id),
  unit text NOT NULL, unit_mass_kg numeric(12,6), unit_price numeric(12,2) NOT NULL DEFAULT 0 CHECK(unit_price>=0),
  safety_stock numeric(12,3) NOT NULL DEFAULT 0 CHECK(safety_stock>=0),
  UNIQUE(store_id,sku), CHECK(unit_mass_kg IS NULL OR unit_mass_kg>0)
);
CREATE TABLE data_import (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id bigint NOT NULL REFERENCES organization(id),
  data_type text NOT NULL, source_name text NOT NULL, file_sha256 char(64) NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(), rows_seen integer NOT NULL DEFAULT 0 CHECK(rows_seen>=0),
  rows_imported integer NOT NULL DEFAULT 0 CHECK(rows_imported>=0), status text NOT NULL CHECK(status IN ('validated','completed','failed')),
  UNIQUE(organization_id,data_type,file_sha256)
);
CREATE TABLE batch (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, product_id bigint NOT NULL REFERENCES product(id),
  lot_code text NOT NULL, received_on date NOT NULL, manufacturing_date date, expiry_date date NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK(quantity>0), reserved numeric(12,3) NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=quantity),
  source text NOT NULL CHECK(source IN ('synthetic','imported','manual')),
  UNIQUE(product_id,lot_code), CHECK(manufacturing_date IS NULL OR expiry_date>manufacturing_date)
);
CREATE TABLE sales_observation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, product_id bigint NOT NULL REFERENCES product(id),
  sold_on date NOT NULL, quantity numeric(12,3) NOT NULL CHECK(quantity>=0), net_amount numeric(12,2),
  source text NOT NULL CHECK(source IN ('synthetic','imported','manual')),
  source_row_key text UNIQUE, import_id bigint REFERENCES data_import(id)
);
CREATE TABLE inventory_snapshot (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, store_id bigint NOT NULL REFERENCES store(id),
  product_id bigint NOT NULL REFERENCES product(id), observed_at timestamptz NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK(quantity>=0), source text NOT NULL,
  import_id bigint REFERENCES data_import(id), UNIQUE(store_id,product_id,observed_at)
);
CREATE TABLE recipient_constraint (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, recipient_id bigint NOT NULL REFERENCES recipient_site(id),
  category_id bigint NOT NULL REFERENCES category(id), max_quantity numeric(12,3) CHECK(max_quantity>0),
  storage text NOT NULL CHECK(storage IN ('ambient','chilled','frozen')), dietary_note text,
  UNIQUE(recipient_id,category_id,storage)
);
CREATE TABLE demand (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, recipient_id bigint NOT NULL REFERENCES recipient_site(id),
  category_id bigint NOT NULL REFERENCES category(id), quantity numeric(12,3) NOT NULL CHECK(quantity>0),
  unit text NOT NULL, needed_from timestamptz NOT NULL, needed_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','partially_fulfilled','fulfilled','cancelled')),
  declared boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(needed_until>=needed_from)
);
CREATE TABLE vehicle (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id bigint NOT NULL REFERENCES organization(id),
  name text NOT NULL, capacity_kg numeric(12,3) NOT NULL CHECK(capacity_kg>0), available boolean NOT NULL DEFAULT true,
  cold_storage boolean NOT NULL DEFAULT false, cost_per_km numeric(12,2) NOT NULL DEFAULT 0 CHECK(cost_per_km>=0)
);
CREATE TABLE forecast_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, model_name text NOT NULL, model_version text NOT NULL,
  data_cutoff_at timestamptz NOT NULL, generated_at timestamptz NOT NULL DEFAULT now(),
  horizon_days integer NOT NULL CHECK(horizon_days IN (1,3,7)), dataset_kind text NOT NULL CHECK(dataset_kind IN ('synthetic','real','mixed')),
  evaluation jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE forecast_value (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id bigint NOT NULL REFERENCES forecast_run(id) ON DELETE CASCADE,
  store_id bigint REFERENCES store(id), recipient_id bigint REFERENCES recipient_site(id), product_id bigint REFERENCES product(id),
  category_id bigint REFERENCES category(id), target_date date NOT NULL,
  predicted_quantity numeric(12,3) NOT NULL CHECK(predicted_quantity>=0), lower_bound numeric(12,3), upper_bound numeric(12,3),
  CHECK(product_id IS NOT NULL OR category_id IS NOT NULL)
);
CREATE TABLE allocation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, demand_id bigint NOT NULL REFERENCES demand(id),
  status text NOT NULL CHECK(status IN ('proposed','approved','delivered','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), approved_by bigint REFERENCES app_user(id),
  objective_value numeric(12,2), estimated_km numeric(10,2) NOT NULL DEFAULT 0,
  transport_cost numeric(12,2) NOT NULL DEFAULT 0, handling_cost numeric(12,2) NOT NULL DEFAULT 0
);
CREATE TABLE allocation_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, allocation_id bigint NOT NULL REFERENCES allocation(id),
  batch_id bigint NOT NULL REFERENCES batch(id), quantity numeric(12,3) NOT NULL CHECK(quantity>0),
  UNIQUE(allocation_id,batch_id)
);
CREATE TABLE route (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, vehicle_id bigint REFERENCES vehicle(id),
  status text NOT NULL CHECK(status IN ('planned','active','completed','cancelled')),
  planned_at timestamptz NOT NULL DEFAULT now(), total_km numeric(10,2), estimated_cost numeric(12,2)
);
CREATE TABLE delivery (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, allocation_id bigint NOT NULL UNIQUE REFERENCES allocation(id),
  route_id bigint REFERENCES route(id), status text NOT NULL CHECK(status IN ('pending','picked_up','delivered','failed')),
  pickup_at timestamptz, delivered_at timestamptz, confirmation_at timestamptz
);
CREATE TABLE economic_record (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, delivery_id bigint NOT NULL UNIQUE REFERENCES delivery(id),
  procurement_savings numeric(12,2) NOT NULL DEFAULT 0, avoided_disposal_cost numeric(12,2) NOT NULL DEFAULT 0,
  transport_cost numeric(12,2) NOT NULL DEFAULT 0, handling_storage_cost numeric(12,2) NOT NULL DEFAULT 0,
  platform_cost numeric(12,2) NOT NULL DEFAULT 0, retailer_recovery_revenue numeric(12,2) NOT NULL DEFAULT 0,
  assumptions_version text NOT NULL, CHECK(procurement_savings>=0 AND avoided_disposal_cost>=0 AND transport_cost>=0 AND handling_storage_cost>=0 AND platform_cost>=0 AND retailer_recovery_revenue>=0)
);
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id bigint REFERENCES app_user(id), action text NOT NULL, entity text NOT NULL, entity_id bigint,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_batch_expiry ON batch(expiry_date,product_id);
CREATE INDEX ix_sales_product_day ON sales_observation(product_id,sold_on);
CREATE INDEX ix_demand_open_due ON demand(needed_until) WHERE status IN ('open','partially_fulfilled');
CREATE INDEX ix_allocation_status ON allocation(status,created_at);
CREATE INDEX ix_forecast_run_cutoff ON forecast_run(data_cutoff_at,generated_at);
CREATE VIEW v_batch_available AS
SELECT b.id batch_id,b.product_id,b.lot_code,b.expiry_date,b.quantity,b.reserved,b.quantity-b.reserved available,
       p.store_id,p.category_id,p.name product,p.unit,p.safety_stock,c.name category,c.storage
FROM batch b JOIN product p ON p.id=b.product_id JOIN category c ON c.id=p.category_id;
