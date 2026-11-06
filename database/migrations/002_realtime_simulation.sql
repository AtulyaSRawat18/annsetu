-- Durable, auditable workload simulator for inventory, demand, forecasting,
-- allocation concurrency, and scheduled delivery flows.
CREATE TABLE IF NOT EXISTS simulation_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scenario text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','cancelled','failed')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS simulation_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES simulation_run(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('sale','forecast','allocate','route_depart','dispatch')),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','completed','failed','skipped','cancelled')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (run_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS ix_simulation_event_due ON simulation_event(status, scheduled_at, run_id);
CREATE INDEX IF NOT EXISTS ix_simulation_run_created ON simulation_run(created_at DESC);

ALTER TABLE batch ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;
ALTER TABLE sales_observation ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;
ALTER TABLE inventory_snapshot ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;
ALTER TABLE demand ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;
ALTER TABLE forecast_run ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;
ALTER TABLE allocation ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;
ALTER TABLE route ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;
ALTER TABLE delivery ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;
ALTER TABLE economic_record ADD COLUMN IF NOT EXISTS simulation_run_id bigint REFERENCES simulation_run(id) ON DELETE SET NULL;

-- A fully distributed batch remains as a zero-stock row for audit history.
ALTER TABLE batch DROP CONSTRAINT IF EXISTS batch_quantity_check;
ALTER TABLE batch DROP CONSTRAINT IF EXISTS batch_quantity_nonnegative;
ALTER TABLE batch ADD CONSTRAINT batch_quantity_nonnegative CHECK (quantity>=0);

ALTER TABLE simulation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_event ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='annsetu_runtime') THEN
    GRANT USAGE ON SCHEMA public TO annsetu_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO annsetu_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO annsetu_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO annsetu_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO annsetu_runtime;
  END IF;
END $$;
