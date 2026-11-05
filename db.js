/* ==========================================================
   AnnSetu — Database definition (SQLite dialect, runs in-browser)
   Tables are in 3NF. Business rules are enforced INSIDE the
   database using CHECK constraints, FOREIGN KEYs and TRIGGERS.
   ========================================================== */

window.SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

-- 1. Food category with storage rule & alert window
CREATE TABLE category (
  category_id      INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL UNIQUE,
  storage_type     TEXT    NOT NULL CHECK (storage_type IN ('Dry','Chilled','Frozen')),
  alert_days       INTEGER NOT NULL DEFAULT 7 CHECK (alert_days > 0)
);

-- 2. Suppliers who deliver stock
CREATE TABLE supplier (
  supplier_id      INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  phone            TEXT CHECK (length(phone) = 10),
  city             TEXT NOT NULL
);

-- 3. Storage locations
CREATE TABLE warehouse (
  warehouse_id     INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  city             TEXT NOT NULL,
  capacity_kg      REAL NOT NULL CHECK (capacity_kg > 0)
);

-- 4. Product master
CREATE TABLE product (
  product_id       INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  category_id      INTEGER NOT NULL REFERENCES category(category_id),
  unit             TEXT NOT NULL DEFAULT 'kg',
  unit_price       REAL NOT NULL CHECK (unit_price >= 0)
);

-- 5. Batch / lot: every delivery has its own expiry date
CREATE TABLE batch (
  batch_id         INTEGER PRIMARY KEY,
  batch_code       TEXT NOT NULL UNIQUE,
  product_id       INTEGER NOT NULL REFERENCES product(product_id),
  supplier_id      INTEGER NOT NULL REFERENCES supplier(supplier_id),
  warehouse_id     INTEGER NOT NULL REFERENCES warehouse(warehouse_id),
  mfg_date         DATE NOT NULL,
  expiry_date      DATE NOT NULL,
  qty_received     REAL NOT NULL CHECK (qty_received > 0),
  qty_available    REAL NOT NULL CHECK (qty_available >= 0),
  received_on      DATE NOT NULL DEFAULT (date('now')),
  CHECK (expiry_date > mfg_date),
  CHECK (qty_available <= qty_received)
);

-- 6. Registered NGOs / shelters receiving food
CREATE TABLE ngo (
  ngo_id           INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  registration_no  TEXT NOT NULL UNIQUE,
  contact_person   TEXT NOT NULL,
  phone            TEXT CHECK (length(phone) = 10),
  city             TEXT NOT NULL,
  beneficiaries    INTEGER NOT NULL CHECK (beneficiaries > 0)
);

-- 7. Food requests raised by NGOs
CREATE TABLE food_request (
  request_id       INTEGER PRIMARY KEY,
  ngo_id           INTEGER NOT NULL REFERENCES ngo(ngo_id) ON DELETE CASCADE,
  category_id      INTEGER NOT NULL REFERENCES category(category_id),
  qty_needed       REAL NOT NULL CHECK (qty_needed > 0),
  needed_by        DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Pending'
                   CHECK (status IN ('Pending','Partially Fulfilled','Fulfilled','Cancelled')),
  created_on       DATE NOT NULL DEFAULT (date('now'))
);

-- 8. Each donation dispatched from a batch to an NGO
CREATE TABLE distribution (
  distribution_id  INTEGER PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES batch(batch_id),
  ngo_id           INTEGER NOT NULL REFERENCES ngo(ngo_id),
  request_id       INTEGER REFERENCES food_request(request_id),
  qty              REAL NOT NULL CHECK (qty > 0),
  distributed_on   DATE NOT NULL DEFAULT (date('now')),
  volunteer        TEXT
);

-- 9. Ledger of every stock change (IN / ISSUE / DONATION / WASTE)
CREATE TABLE stock_movement (
  movement_id      INTEGER PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES batch(batch_id),
  movement_type    TEXT NOT NULL CHECK (movement_type IN ('IN','ISSUE','DONATION','WASTE')),
  qty              REAL NOT NULL CHECK (qty > 0),
  moved_on         DATE NOT NULL DEFAULT (date('now')),
  note             TEXT
);

-- 10. Audit trail written only by triggers
CREATE TABLE audit_log (
  log_id           INTEGER PRIMARY KEY,
  table_name       TEXT NOT NULL,
  action           TEXT NOT NULL,
  record_id        INTEGER,
  details          TEXT,
  logged_at        DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Indexes for the most frequent lookups
CREATE INDEX idx_batch_expiry   ON batch(expiry_date);
CREATE INDEX idx_batch_product  ON batch(product_id);
CREATE INDEX idx_dist_ngo       ON distribution(ngo_id);
CREATE INDEX idx_move_batch     ON stock_movement(batch_id, movement_type);

/* ---------------- TRIGGERS ---------------- */

-- T1: every new batch is logged as an IN movement + audit
CREATE TRIGGER trg_batch_in AFTER INSERT ON batch
BEGIN
  INSERT INTO stock_movement(batch_id, movement_type, qty, moved_on, note)
  VALUES (NEW.batch_id, 'IN', NEW.qty_received, NEW.received_on, 'Stock received');
  INSERT INTO audit_log(table_name, action, record_id, details)
  VALUES ('batch','INSERT',NEW.batch_id, 'Received '||NEW.qty_received||' of batch '||NEW.batch_code);
END;

-- T2: block any outgoing movement larger than available stock
CREATE TRIGGER trg_check_stock BEFORE INSERT ON stock_movement
WHEN NEW.movement_type <> 'IN'
BEGIN
  SELECT RAISE(ABORT, 'Insufficient stock in this batch')
  WHERE NEW.qty > (SELECT qty_available FROM batch WHERE batch_id = NEW.batch_id);
END;

-- T3: outgoing movement automatically reduces batch quantity
CREATE TRIGGER trg_reduce_stock AFTER INSERT ON stock_movement
WHEN NEW.movement_type <> 'IN'
BEGIN
  UPDATE batch SET qty_available = qty_available - NEW.qty WHERE batch_id = NEW.batch_id;
END;

-- T4: never donate expired food
CREATE TRIGGER trg_no_expired_donation BEFORE INSERT ON distribution
BEGIN
  SELECT RAISE(ABORT, 'Cannot distribute expired food')
  WHERE (SELECT expiry_date FROM batch WHERE batch_id = NEW.batch_id) < NEW.distributed_on;
END;

-- T5: a distribution creates a DONATION movement, updates the request and the audit log
CREATE TRIGGER trg_after_distribution AFTER INSERT ON distribution
BEGIN
  INSERT INTO stock_movement(batch_id, movement_type, qty, moved_on, note)
  VALUES (NEW.batch_id, 'DONATION', NEW.qty, NEW.distributed_on, 'Donated to NGO #'||NEW.ngo_id);

  UPDATE food_request
     SET status = CASE
         WHEN (SELECT SUM(qty) FROM distribution WHERE request_id = NEW.request_id) >= qty_needed
              THEN 'Fulfilled' ELSE 'Partially Fulfilled' END
   WHERE request_id = NEW.request_id;

  INSERT INTO audit_log(table_name, action, record_id, details)
  VALUES ('distribution','INSERT',NEW.distribution_id,
          NEW.qty||' donated from batch #'||NEW.batch_id||' to NGO #'||NEW.ngo_id);
END;

-- T6: audit every wastage entry
CREATE TRIGGER trg_audit_waste AFTER INSERT ON stock_movement
WHEN NEW.movement_type = 'WASTE'
BEGIN
  INSERT INTO audit_log(table_name, action, record_id, details)
  VALUES ('stock_movement','WASTE',NEW.batch_id, NEW.qty||' discarded: '||IFNULL(NEW.note,''));
END;

-- T7: audit new NGO registrations
CREATE TRIGGER trg_audit_ngo AFTER INSERT ON ngo
BEGIN
  INSERT INTO audit_log(table_name, action, record_id, details)
  VALUES ('ngo','INSERT',NEW.ngo_id,'Registered '||NEW.name);
END;

/* ---------------- VIEWS ---------------- */

-- V1: live status of every batch (the heart of the expiry tracker)
CREATE VIEW v_batch_status AS
SELECT b.batch_id, b.batch_code, p.name AS product, c.name AS category, c.category_id,
       w.name AS warehouse, s.name AS supplier, b.mfg_date, b.expiry_date,
       b.qty_received, b.qty_available, p.unit, p.unit_price,
       CAST(julianday(b.expiry_date) - julianday(date('now')) AS INTEGER) AS days_left,
       CASE
         WHEN b.qty_available = 0                                       THEN 'Depleted'
         WHEN b.expiry_date <  date('now')                              THEN 'Expired'
         WHEN julianday(b.expiry_date) - julianday(date('now')) <= 2    THEN 'Critical'
         WHEN julianday(b.expiry_date) - julianday(date('now')) <= c.alert_days THEN 'Near Expiry'
         ELSE 'Fresh'
       END AS status
FROM batch b
JOIN product   p ON p.product_id   = b.product_id
JOIN category  c ON c.category_id  = p.category_id
JOIN warehouse w ON w.warehouse_id = b.warehouse_id
JOIN supplier  s ON s.supplier_id  = b.supplier_id;

-- V2: request progress
CREATE VIEW v_request_progress AS
SELECT r.request_id, n.name AS ngo, n.ngo_id, c.name AS category, r.category_id,
       r.qty_needed, IFNULL(SUM(d.qty),0) AS qty_fulfilled,
       r.qty_needed - IFNULL(SUM(d.qty),0) AS qty_remaining,
       r.needed_by, r.status,
       CAST(julianday(r.needed_by) - julianday(date('now')) AS INTEGER) AS days_to_deadline
FROM food_request r
JOIN ngo n      ON n.ngo_id = r.ngo_id
JOIN category c ON c.category_id = r.category_id
LEFT JOIN distribution d ON d.request_id = r.request_id
GROUP BY r.request_id;

-- V3: NGO impact (1 meal ≈ 0.4 kg of food)
CREATE VIEW v_ngo_impact AS
SELECT n.ngo_id, n.name, n.city, n.beneficiaries,
       COUNT(d.distribution_id)            AS donations,
       IFNULL(SUM(d.qty),0)                AS kg_received,
       CAST(IFNULL(SUM(d.qty),0)/0.4 AS INTEGER) AS meals_served
FROM ngo n LEFT JOIN distribution d ON d.ngo_id = n.ngo_id
GROUP BY n.ngo_id;
`;

/* ---------------- SEED DATA ---------------- */
(function () {
  const d = (n) => `date('now','${n >= 0 ? '+' : ''}${n} day')`;
  const rows = [];
  rows.push(`INSERT INTO category VALUES
    (1,'Dairy','Chilled',3),(2,'Bakery','Dry',2),(3,'Fruits & Vegetables','Chilled',3),
    (4,'Grains & Pulses','Dry',30),(5,'Packaged Foods','Dry',20),(6,'Cooked Meals','Chilled',1),
    (7,'Frozen Foods','Frozen',15),(8,'Beverages','Dry',20);`);
  rows.push(`INSERT INTO supplier VALUES
    (1,'Yamuna Dairy Co-op','9811000001','Delhi'),(2,'Golden Crust Bakers','9811000002','Noida'),
    (3,'Azadpur Fresh Traders','9811000003','Delhi'),(4,'Punjab Grain Merchants','9811000004','Ludhiana'),
    (5,'Metro FMCG Wholesale','9811000005','Gurugram');`);
  rows.push(`INSERT INTO warehouse VALUES
    (1,'Okhla Hub','New Delhi',5000),(2,'Rohini Store','Delhi',3000),(3,'Dwarka Cold Store','Delhi',2500);`);
  rows.push(`INSERT INTO product VALUES
    (1,'Toned Milk',1,'L',54),(2,'Paneer',1,'kg',380),(3,'Curd',1,'kg',90),
    (4,'Whole Wheat Bread',2,'kg',110),(5,'Pav Buns',2,'kg',95),
    (6,'Bananas',3,'kg',50),(7,'Tomatoes',3,'kg',40),(8,'Spinach',3,'kg',35),
    (9,'Basmati Rice',4,'kg',95),(10,'Toor Dal',4,'kg',140),(11,'Wheat Atta',4,'kg',42),
    (12,'Biscuits',5,'kg',160),(13,'Instant Noodles',5,'kg',220),
    (14,'Veg Biryani',6,'kg',150),(15,'Dal Khichdi',6,'kg',110),
    (16,'Frozen Peas',7,'kg',120),(17,'Mango Juice',8,'L',99);`);
  // code, product, supplier, warehouse, mfg offset, expiry offset, qty
  const batches = [
    ['B-1001',1,1,1,-3,1,120],['B-1002',1,1,2,-1,4,150],['B-1003',2,1,1,-6,-1,25],
    ['B-1004',3,1,3,-2,2,40],['B-1005',4,2,1,-2,0,60],['B-1006',5,2,2,-1,2,45],
    ['B-1007',6,3,1,-4,3,200],['B-1008',7,3,2,-5,-2,80],['B-1009',8,3,3,-1,2,35],
    ['B-1010',9,4,1,-60,300,500],['B-1011',9,4,2,-200,20,300],['B-1012',10,4,1,-90,180,250],
    ['B-1013',10,4,3,-300,12,120],['B-1014',11,4,2,-40,45,400],['B-1015',11,4,1,-150,-3,90],
    ['B-1016',12,5,1,-120,15,180],['B-1017',12,5,3,-30,150,220],['B-1018',13,5,2,-100,60,160],
    ['B-1019',13,5,1,-200,6,70],['B-1020',14,2,1,-1,1,50],['B-1021',15,2,3,-1,1,40],
    ['B-1022',16,3,2,-100,200,140],['B-1023',16,3,1,-300,10,60],['B-1024',17,5,3,-150,18,110],
    ['B-1025',17,5,2,-20,160,200],['B-1026',1,1,3,-10,-4,30]
  ];
  batches.forEach((b, i) => {
    rows.push(`INSERT INTO batch(batch_id,batch_code,product_id,supplier_id,warehouse_id,mfg_date,expiry_date,qty_received,qty_available,received_on)
      VALUES (${i + 1},'${b[0]}',${b[1]},${b[2]},${b[3]},${d(b[4])},${d(b[5])},${b[6]},${b[6]},${d(Math.max(b[4], -14))});`);
  });
  rows.push(`INSERT INTO ngo VALUES
    (1,'Annapurna Seva Trust','DL-NGO-2011-0451','Ritu Sharma','9899000011','Delhi',320),
    (2,'Hope Kitchen Foundation','DL-NGO-2015-1187','Imran Khan','9899000012','Delhi',210),
    (3,'Sahara Night Shelter','DL-NGO-2009-0332','Pooja Verma','9899000013','Delhi',150),
    (4,'Little Hands Orphanage','UP-NGO-2013-0874','Fr. Thomas','9899000014','Noida',95),
    (5,'Asha Old Age Home','HR-NGO-2017-0219','Sunita Rao','9899000015','Gurugram',60),
    (6,'Feeding Futures','DL-NGO-2019-1502','Arjun Mehta','9899000016','Delhi',410);`);
  rows.push(`INSERT INTO food_request(request_id,ngo_id,category_id,qty_needed,needed_by,created_on) VALUES
    (1,1,1,80,${d(1)},${d(-1)}),(2,2,2,50,${d(1)},${d(-1)}),(3,3,4,200,${d(5)},${d(-2)}),
    (4,4,3,120,${d(2)},${d(0)}),(5,5,6,60,${d(0)},${d(0)}),(6,6,5,100,${d(7)},${d(-1)}),
    (7,1,4,150,${d(-8)},${d(-12)});`);
  // batch, ngo, request, qty, day offset, volunteer
  const dist = [
    [10,1,7,100,-10,'Rahul'],[12,1,7,50,-9,'Rahul'],[17,2,'NULL',40,-12,'Neha'],
    [14,3,'NULL',60,-8,'Vikas'],[18,4,'NULL',30,-6,'Neha'],[22,5,'NULL',25,-5,'Aman'],
    [11,6,'NULL',70,-4,'Vikas'],[25,2,'NULL',35,-3,'Aman'],[16,3,'NULL',30,-2,'Neha'],
    [13,4,'NULL',20,-1,'Rahul'],[7,5,'NULL',40,0,'Aman'],[1,1,1,30,0,'Rahul'],
    [10,6,'NULL',80,-13,'Vikas'],[14,6,'NULL',55,-11,'Neha'],[12,2,'NULL',45,-7,'Aman']
  ];
  dist.forEach((x) => {
    rows.push(`INSERT INTO distribution(batch_id,ngo_id,request_id,qty,distributed_on,volunteer)
      VALUES (${x[0]},${x[1]},${x[2]},${x[3]},${d(x[4])},'${x[5]}');`);
  });
  rows.push(`INSERT INTO stock_movement(batch_id,movement_type,qty,moved_on,note) VALUES
    (8,'WASTE',30,${d(-1)},'Spoiled in transit'),(26,'WASTE',20,${d(-3)},'Expired'),
    (15,'WASTE',40,${d(-2)},'Expired - pest damage'),(9,'ISSUE',5,${d(0)},'Staff canteen'),
    (19,'ISSUE',10,${d(-3)},'Retail sale');`);
  window.SEED_SQL = rows.join('\n');
})();
