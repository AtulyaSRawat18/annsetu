-- =====================================================================
--  AnnSetu : Smart Inventory Expiry Tracker & Food Distribution System
--  MySQL 8.0+ script  (schema + constraints + triggers + views +
--  stored procedures + event + sample data + report queries)
--  Run:  mysql -u root -p < annsetu_mysql.sql
-- =====================================================================

DROP DATABASE IF EXISTS annsetu;
CREATE DATABASE annsetu CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE annsetu;

-- ---------------------------------------------------------------------
-- 1. TABLES  (normalised to 3NF)
-- ---------------------------------------------------------------------
CREATE TABLE category (
  category_id   INT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(60) NOT NULL UNIQUE,
  storage_type  ENUM('Dry','Chilled','Frozen') NOT NULL,
  alert_days    INT NOT NULL DEFAULT 7,
  CONSTRAINT chk_alert_days CHECK (alert_days > 0)
);

CREATE TABLE supplier (
  supplier_id   INT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(100) NOT NULL,
  phone         CHAR(10),
  city          VARCHAR(60) NOT NULL,
  CONSTRAINT chk_sup_phone CHECK (CHAR_LENGTH(phone) = 10)
);

CREATE TABLE warehouse (
  warehouse_id  INT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(80) NOT NULL UNIQUE,
  city          VARCHAR(60) NOT NULL,
  capacity_kg   DECIMAL(10,2) NOT NULL,
  CONSTRAINT chk_capacity CHECK (capacity_kg > 0)
);

CREATE TABLE product (
  product_id    INT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(100) NOT NULL UNIQUE,
  category_id   INT NOT NULL,
  unit          VARCHAR(10) NOT NULL DEFAULT 'kg',
  unit_price    DECIMAL(10,2) NOT NULL,
  CONSTRAINT chk_price CHECK (unit_price >= 0),
  FOREIGN KEY (category_id) REFERENCES category(category_id)
);

CREATE TABLE batch (
  batch_id      INT PRIMARY KEY AUTO_INCREMENT,
  batch_code    VARCHAR(20) NOT NULL UNIQUE,
  product_id    INT NOT NULL,
  supplier_id   INT NOT NULL,
  warehouse_id  INT NOT NULL,
  mfg_date      DATE NOT NULL,
  expiry_date   DATE NOT NULL,
  qty_received  DECIMAL(10,2) NOT NULL,
  qty_available DECIMAL(10,2) NOT NULL,
  received_on   DATE NOT NULL DEFAULT (CURRENT_DATE),
  CONSTRAINT chk_qty_recv  CHECK (qty_received > 0),
  CONSTRAINT chk_qty_avail CHECK (qty_available >= 0 AND qty_available <= qty_received),
  CONSTRAINT chk_dates     CHECK (expiry_date > mfg_date),
  FOREIGN KEY (product_id)   REFERENCES product(product_id),
  FOREIGN KEY (supplier_id)  REFERENCES supplier(supplier_id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouse(warehouse_id)
);

CREATE TABLE ngo (
  ngo_id          INT PRIMARY KEY AUTO_INCREMENT,
  name            VARCHAR(120) NOT NULL,
  registration_no VARCHAR(30) NOT NULL UNIQUE,
  contact_person  VARCHAR(80) NOT NULL,
  phone           CHAR(10),
  city            VARCHAR(60) NOT NULL,
  beneficiaries   INT NOT NULL,
  CONSTRAINT chk_ngo_phone CHECK (CHAR_LENGTH(phone) = 10),
  CONSTRAINT chk_benef     CHECK (beneficiaries > 0)
);

CREATE TABLE food_request (
  request_id    INT PRIMARY KEY AUTO_INCREMENT,
  ngo_id        INT NOT NULL,
  category_id   INT NOT NULL,
  qty_needed    DECIMAL(10,2) NOT NULL,
  needed_by     DATE NOT NULL,
  status        ENUM('Pending','Partially Fulfilled','Fulfilled','Cancelled') NOT NULL DEFAULT 'Pending',
  created_on    DATE NOT NULL DEFAULT (CURRENT_DATE),
  CONSTRAINT chk_need CHECK (qty_needed > 0),
  FOREIGN KEY (ngo_id)      REFERENCES ngo(ngo_id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES category(category_id)
);

CREATE TABLE distribution (
  distribution_id INT PRIMARY KEY AUTO_INCREMENT,
  batch_id        INT NOT NULL,
  ngo_id          INT NOT NULL,
  request_id      INT NULL,
  qty             DECIMAL(10,2) NOT NULL,
  distributed_on  DATE NOT NULL DEFAULT (CURRENT_DATE),
  volunteer       VARCHAR(60),
  CONSTRAINT chk_dist_qty CHECK (qty > 0),
  FOREIGN KEY (batch_id)   REFERENCES batch(batch_id),
  FOREIGN KEY (ngo_id)     REFERENCES ngo(ngo_id),
  FOREIGN KEY (request_id) REFERENCES food_request(request_id)
);

CREATE TABLE stock_movement (
  movement_id   INT PRIMARY KEY AUTO_INCREMENT,
  batch_id      INT NOT NULL,
  movement_type ENUM('IN','ISSUE','DONATION','WASTE') NOT NULL,
  qty           DECIMAL(10,2) NOT NULL,
  moved_on      DATE NOT NULL DEFAULT (CURRENT_DATE),
  note          VARCHAR(200),
  CONSTRAINT chk_move_qty CHECK (qty > 0),
  FOREIGN KEY (batch_id) REFERENCES batch(batch_id)
);

CREATE TABLE audit_log (
  log_id      INT PRIMARY KEY AUTO_INCREMENT,
  table_name  VARCHAR(40) NOT NULL,
  action      VARCHAR(20) NOT NULL,
  record_id   INT,
  details     VARCHAR(255),
  logged_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_batch_expiry  ON batch(expiry_date);
CREATE INDEX idx_batch_product ON batch(product_id);
CREATE INDEX idx_dist_ngo      ON distribution(ngo_id);
CREATE INDEX idx_move_batch    ON stock_movement(batch_id, movement_type);

-- ---------------------------------------------------------------------
-- 2. TRIGGERS  (business rules enforced inside the database)
-- ---------------------------------------------------------------------
DELIMITER $$

-- T1: every new batch is logged as an IN movement + audit row
CREATE TRIGGER trg_batch_in AFTER INSERT ON batch
FOR EACH ROW
BEGIN
  INSERT INTO stock_movement(batch_id, movement_type, qty, moved_on, note)
  VALUES (NEW.batch_id, 'IN', NEW.qty_received, NEW.received_on, 'Stock received');
  INSERT INTO audit_log(table_name, action, record_id, details)
  VALUES ('batch','INSERT',NEW.batch_id, CONCAT('Received ',NEW.qty_received,' of batch ',NEW.batch_code));
END$$

-- T2: block outgoing movement larger than available stock
CREATE TRIGGER trg_check_stock BEFORE INSERT ON stock_movement
FOR EACH ROW
BEGIN
  IF NEW.movement_type <> 'IN' AND
     NEW.qty > (SELECT qty_available FROM batch WHERE batch_id = NEW.batch_id) THEN
     SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Insufficient stock in this batch';
  END IF;
END$$

-- T3 + T6: reduce stock for outgoing movements, audit wastage
CREATE TRIGGER trg_reduce_stock AFTER INSERT ON stock_movement
FOR EACH ROW
BEGIN
  IF NEW.movement_type <> 'IN' THEN
    UPDATE batch SET qty_available = qty_available - NEW.qty WHERE batch_id = NEW.batch_id;
  END IF;
  IF NEW.movement_type = 'WASTE' THEN
    INSERT INTO audit_log(table_name, action, record_id, details)
    VALUES ('stock_movement','WASTE',NEW.batch_id, CONCAT(NEW.qty,' discarded: ',IFNULL(NEW.note,'')));
  END IF;
END$$

-- T4: never donate expired food
CREATE TRIGGER trg_no_expired_donation BEFORE INSERT ON distribution
FOR EACH ROW
BEGIN
  IF (SELECT expiry_date FROM batch WHERE batch_id = NEW.batch_id) < NEW.distributed_on THEN
     SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot distribute expired food';
  END IF;
END$$

-- T5: distribution -> DONATION movement, request status, audit
CREATE TRIGGER trg_after_distribution AFTER INSERT ON distribution
FOR EACH ROW
BEGIN
  INSERT INTO stock_movement(batch_id, movement_type, qty, moved_on, note)
  VALUES (NEW.batch_id, 'DONATION', NEW.qty, NEW.distributed_on, CONCAT('Donated to NGO #',NEW.ngo_id));

  IF NEW.request_id IS NOT NULL THEN
    UPDATE food_request r
       SET r.status = IF((SELECT SUM(qty) FROM distribution WHERE request_id = NEW.request_id) >= r.qty_needed,
                         'Fulfilled','Partially Fulfilled')
     WHERE r.request_id = NEW.request_id;
  END IF;

  INSERT INTO audit_log(table_name, action, record_id, details)
  VALUES ('distribution','INSERT',NEW.distribution_id,
          CONCAT(NEW.qty,' donated from batch #',NEW.batch_id,' to NGO #',NEW.ngo_id));
END$$

-- T7: audit NGO registration
CREATE TRIGGER trg_audit_ngo AFTER INSERT ON ngo
FOR EACH ROW
BEGIN
  INSERT INTO audit_log(table_name, action, record_id, details)
  VALUES ('ngo','INSERT',NEW.ngo_id, CONCAT('Registered ',NEW.name));
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 3. VIEWS
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_batch_status AS
SELECT b.batch_id, b.batch_code, p.name AS product, c.name AS category, c.category_id,
       w.name AS warehouse, s.name AS supplier, b.mfg_date, b.expiry_date,
       b.qty_received, b.qty_available, p.unit, p.unit_price,
       DATEDIFF(b.expiry_date, CURDATE()) AS days_left,
       CASE
         WHEN b.qty_available = 0                              THEN 'Depleted'
         WHEN b.expiry_date < CURDATE()                         THEN 'Expired'
         WHEN DATEDIFF(b.expiry_date, CURDATE()) <= 2           THEN 'Critical'
         WHEN DATEDIFF(b.expiry_date, CURDATE()) <= c.alert_days THEN 'Near Expiry'
         ELSE 'Fresh'
       END AS status
FROM batch b
JOIN product   p ON p.product_id   = b.product_id
JOIN category  c ON c.category_id  = p.category_id
JOIN warehouse w ON w.warehouse_id = b.warehouse_id
JOIN supplier  s ON s.supplier_id  = b.supplier_id;

CREATE OR REPLACE VIEW v_request_progress AS
SELECT r.request_id, n.name AS ngo, n.ngo_id, c.name AS category, r.category_id,
       r.qty_needed, IFNULL(SUM(d.qty),0) AS qty_fulfilled,
       r.qty_needed - IFNULL(SUM(d.qty),0) AS qty_remaining,
       r.needed_by, r.status, DATEDIFF(r.needed_by, CURDATE()) AS days_to_deadline
FROM food_request r
JOIN ngo n      ON n.ngo_id = r.ngo_id
JOIN category c ON c.category_id = r.category_id
LEFT JOIN distribution d ON d.request_id = r.request_id
GROUP BY r.request_id, n.name, n.ngo_id, c.name, r.category_id, r.qty_needed, r.needed_by, r.status;

CREATE OR REPLACE VIEW v_ngo_impact AS
SELECT n.ngo_id, n.name, n.city, n.beneficiaries,
       COUNT(d.distribution_id)          AS donations,
       IFNULL(SUM(d.qty),0)              AS kg_received,
       FLOOR(IFNULL(SUM(d.qty),0) / 0.4) AS meals_served      -- 1 meal ~ 0.4 kg
FROM ngo n LEFT JOIN distribution d ON d.ngo_id = n.ngo_id
GROUP BY n.ngo_id, n.name, n.city, n.beneficiaries;

-- ---------------------------------------------------------------------
-- 4. STORED PROCEDURES
-- ---------------------------------------------------------------------
DELIMITER $$

-- FEFO dispatch: fulfil a request from the earliest-expiring usable batches,
-- atomically (all allocations commit together or roll back together).
CREATE PROCEDURE sp_fefo_dispatch(IN p_request_id INT, IN p_volunteer VARCHAR(60))
BEGIN
  DECLARE v_need, v_take, v_avail DECIMAL(10,2);
  DECLARE v_cat, v_ngo, v_batch INT;
  DECLARE done INT DEFAULT 0;
  DECLARE cur CURSOR FOR
     SELECT b.batch_id, b.qty_available
     FROM batch b JOIN product p ON p.product_id = b.product_id
     WHERE p.category_id = v_cat AND b.qty_available > 0 AND b.expiry_date >= CURDATE()
     ORDER BY b.expiry_date, b.batch_id;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;

  SELECT category_id, ngo_id, qty_remaining INTO v_cat, v_ngo, v_need
  FROM v_request_progress WHERE request_id = p_request_id;

  START TRANSACTION;
  OPEN cur;
  pick: LOOP
    FETCH cur INTO v_batch, v_avail;
    IF done = 1 OR v_need <= 0 THEN LEAVE pick; END IF;
    SET v_take = LEAST(v_avail, v_need);
    INSERT INTO distribution(batch_id, ngo_id, request_id, qty, volunteer)
    VALUES (v_batch, v_ngo, p_request_id, v_take, p_volunteer);
    SET v_need = v_need - v_take;
  END LOOP;
  CLOSE cur;
  COMMIT;

  SELECT * FROM v_request_progress WHERE request_id = p_request_id;
END$$

-- Discard every expired batch that still has stock
CREATE PROCEDURE sp_discard_expired()
BEGIN
  -- copy to a temp table first: MySQL forbids a trigger from updating `batch`
  -- while the invoking statement is still reading `batch` (error 1442)
  DROP TEMPORARY TABLE IF EXISTS tmp_expired;
  CREATE TEMPORARY TABLE tmp_expired AS
    SELECT batch_id, qty_available FROM batch
    WHERE expiry_date < CURDATE() AND qty_available > 0;
  INSERT INTO stock_movement(batch_id, movement_type, qty, note)
  SELECT batch_id, 'WASTE', qty_available, 'Auto-discard: expired' FROM tmp_expired;
  SELECT ROW_COUNT() AS batches_discarded;
  DROP TEMPORARY TABLE tmp_expired;
END$$

-- Expiry alert list for the next N days
CREATE PROCEDURE sp_expiry_alerts(IN p_days INT)
BEGIN
  SELECT batch_code, product, warehouse, qty_available, expiry_date, days_left, status
  FROM v_batch_status
  WHERE qty_available > 0 AND days_left BETWEEN 0 AND p_days
  ORDER BY days_left;
END$$

DELIMITER ;

-- Optional: run the discard job every night (needs SET GLOBAL event_scheduler = ON;)
-- CREATE EVENT IF NOT EXISTS ev_nightly_discard
--   ON SCHEDULE EVERY 1 DAY STARTS (CURRENT_DATE + INTERVAL 1 DAY + INTERVAL 1 HOUR)
--   DO CALL sp_discard_expired();

-- ---------------------------------------------------------------------
-- 5. SAMPLE DATA  (dates are relative to today, so statuses stay realistic)
-- ---------------------------------------------------------------------
INSERT INTO category VALUES
  (1,'Dairy','Chilled',3),(2,'Bakery','Dry',2),(3,'Fruits & Vegetables','Chilled',3),
  (4,'Grains & Pulses','Dry',30),(5,'Packaged Foods','Dry',20),(6,'Cooked Meals','Chilled',1),
  (7,'Frozen Foods','Frozen',15),(8,'Beverages','Dry',20);

INSERT INTO supplier VALUES
  (1,'Yamuna Dairy Co-op','9811000001','Delhi'),(2,'Golden Crust Bakers','9811000002','Noida'),
  (3,'Azadpur Fresh Traders','9811000003','Delhi'),(4,'Punjab Grain Merchants','9811000004','Ludhiana'),
  (5,'Metro FMCG Wholesale','9811000005','Gurugram');

INSERT INTO warehouse VALUES
  (1,'Okhla Hub','New Delhi',5000),(2,'Rohini Store','Delhi',3000),(3,'Dwarka Cold Store','Delhi',2500);

INSERT INTO product VALUES
  (1,'Toned Milk',1,'L',54),(2,'Paneer',1,'kg',380),(3,'Curd',1,'kg',90),
  (4,'Whole Wheat Bread',2,'kg',110),(5,'Pav Buns',2,'kg',95),
  (6,'Bananas',3,'kg',50),(7,'Tomatoes',3,'kg',40),(8,'Spinach',3,'kg',35),
  (9,'Basmati Rice',4,'kg',95),(10,'Toor Dal',4,'kg',140),(11,'Wheat Atta',4,'kg',42),
  (12,'Biscuits',5,'kg',160),(13,'Instant Noodles',5,'kg',220),
  (14,'Veg Biryani',6,'kg',150),(15,'Dal Khichdi',6,'kg',110),
  (16,'Frozen Peas',7,'kg',120),(17,'Mango Juice',8,'L',99);

INSERT INTO batch(batch_code,product_id,supplier_id,warehouse_id,mfg_date,expiry_date,qty_received,qty_available,received_on) VALUES
  ('B-1001',1,1,1,CURDATE() - INTERVAL 3 DAY,CURDATE() + INTERVAL 1 DAY,120,120,CURDATE() - INTERVAL 3 DAY),
  ('B-1002',1,1,2,CURDATE() - INTERVAL 1 DAY,CURDATE() + INTERVAL 4 DAY,150,150,CURDATE() - INTERVAL 1 DAY),
  ('B-1003',2,1,1,CURDATE() - INTERVAL 6 DAY,CURDATE() - INTERVAL 1 DAY,25,25,CURDATE() - INTERVAL 6 DAY),
  ('B-1004',3,1,3,CURDATE() - INTERVAL 2 DAY,CURDATE() + INTERVAL 2 DAY,40,40,CURDATE() - INTERVAL 2 DAY),
  ('B-1005',4,2,1,CURDATE() - INTERVAL 2 DAY,CURDATE(),60,60,CURDATE() - INTERVAL 2 DAY),
  ('B-1006',5,2,2,CURDATE() - INTERVAL 1 DAY,CURDATE() + INTERVAL 2 DAY,45,45,CURDATE() - INTERVAL 1 DAY),
  ('B-1007',6,3,1,CURDATE() - INTERVAL 4 DAY,CURDATE() + INTERVAL 3 DAY,200,200,CURDATE() - INTERVAL 4 DAY),
  ('B-1008',7,3,2,CURDATE() - INTERVAL 5 DAY,CURDATE() - INTERVAL 2 DAY,80,80,CURDATE() - INTERVAL 5 DAY),
  ('B-1009',8,3,3,CURDATE() - INTERVAL 1 DAY,CURDATE() + INTERVAL 2 DAY,35,35,CURDATE() - INTERVAL 1 DAY),
  ('B-1010',9,4,1,CURDATE() - INTERVAL 60 DAY,CURDATE() + INTERVAL 300 DAY,500,500,CURDATE() - INTERVAL 14 DAY),
  ('B-1011',9,4,2,CURDATE() - INTERVAL 200 DAY,CURDATE() + INTERVAL 20 DAY,300,300,CURDATE() - INTERVAL 14 DAY),
  ('B-1012',10,4,1,CURDATE() - INTERVAL 90 DAY,CURDATE() + INTERVAL 180 DAY,250,250,CURDATE() - INTERVAL 14 DAY),
  ('B-1013',10,4,3,CURDATE() - INTERVAL 300 DAY,CURDATE() + INTERVAL 12 DAY,120,120,CURDATE() - INTERVAL 14 DAY),
  ('B-1014',11,4,2,CURDATE() - INTERVAL 40 DAY,CURDATE() + INTERVAL 45 DAY,400,400,CURDATE() - INTERVAL 14 DAY),
  ('B-1015',11,4,1,CURDATE() - INTERVAL 150 DAY,CURDATE() - INTERVAL 3 DAY,90,90,CURDATE() - INTERVAL 14 DAY),
  ('B-1016',12,5,1,CURDATE() - INTERVAL 120 DAY,CURDATE() + INTERVAL 15 DAY,180,180,CURDATE() - INTERVAL 14 DAY),
  ('B-1017',12,5,3,CURDATE() - INTERVAL 30 DAY,CURDATE() + INTERVAL 150 DAY,220,220,CURDATE() - INTERVAL 14 DAY),
  ('B-1018',13,5,2,CURDATE() - INTERVAL 100 DAY,CURDATE() + INTERVAL 60 DAY,160,160,CURDATE() - INTERVAL 14 DAY),
  ('B-1019',13,5,1,CURDATE() - INTERVAL 200 DAY,CURDATE() + INTERVAL 6 DAY,70,70,CURDATE() - INTERVAL 14 DAY),
  ('B-1020',14,2,1,CURDATE() - INTERVAL 1 DAY,CURDATE() + INTERVAL 1 DAY,50,50,CURDATE() - INTERVAL 1 DAY),
  ('B-1021',15,2,3,CURDATE() - INTERVAL 1 DAY,CURDATE() + INTERVAL 1 DAY,40,40,CURDATE() - INTERVAL 1 DAY),
  ('B-1022',16,3,2,CURDATE() - INTERVAL 100 DAY,CURDATE() + INTERVAL 200 DAY,140,140,CURDATE() - INTERVAL 14 DAY),
  ('B-1023',16,3,1,CURDATE() - INTERVAL 300 DAY,CURDATE() + INTERVAL 10 DAY,60,60,CURDATE() - INTERVAL 14 DAY),
  ('B-1024',17,5,3,CURDATE() - INTERVAL 150 DAY,CURDATE() + INTERVAL 18 DAY,110,110,CURDATE() - INTERVAL 14 DAY),
  ('B-1025',17,5,2,CURDATE() - INTERVAL 20 DAY,CURDATE() + INTERVAL 160 DAY,200,200,CURDATE() - INTERVAL 14 DAY),
  ('B-1026',1,1,3,CURDATE() - INTERVAL 10 DAY,CURDATE() - INTERVAL 4 DAY,30,30,CURDATE() - INTERVAL 10 DAY);

INSERT INTO ngo VALUES
  (1,'Annapurna Seva Trust','DL-NGO-2011-0451','Ritu Sharma','9899000011','Delhi',320),
  (2,'Hope Kitchen Foundation','DL-NGO-2015-1187','Imran Khan','9899000012','Delhi',210),
  (3,'Sahara Night Shelter','DL-NGO-2009-0332','Pooja Verma','9899000013','Delhi',150),
  (4,'Little Hands Orphanage','UP-NGO-2013-0874','Fr. Thomas','9899000014','Noida',95),
  (5,'Asha Old Age Home','HR-NGO-2017-0219','Sunita Rao','9899000015','Gurugram',60),
  (6,'Feeding Futures','DL-NGO-2019-1502','Arjun Mehta','9899000016','Delhi',410);

INSERT INTO food_request(request_id,ngo_id,category_id,qty_needed,needed_by,created_on) VALUES
  (1,1,1,80,CURDATE() + INTERVAL 1 DAY,CURDATE() - INTERVAL 1 DAY),(2,2,2,50,CURDATE() + INTERVAL 1 DAY,CURDATE() - INTERVAL 1 DAY),(3,3,4,200,CURDATE() + INTERVAL 5 DAY,CURDATE() - INTERVAL 2 DAY),
  (4,4,3,120,CURDATE() + INTERVAL 2 DAY,CURDATE()),(5,5,6,60,CURDATE(),CURDATE()),(6,6,5,100,CURDATE() + INTERVAL 7 DAY,CURDATE() - INTERVAL 1 DAY),
  (7,1,4,150,CURDATE() - INTERVAL 8 DAY,CURDATE() - INTERVAL 12 DAY);

-- Triggers automatically create DONATION movements and update stock/request status
INSERT INTO distribution(batch_id,ngo_id,request_id,qty,distributed_on,volunteer) VALUES
  (10,1,7,100,CURDATE() - INTERVAL 10 DAY,'Rahul'),
  (12,1,7,50,CURDATE() - INTERVAL 9 DAY,'Rahul'),
  (17,2,NULL,40,CURDATE() - INTERVAL 12 DAY,'Neha'),
  (14,3,NULL,60,CURDATE() - INTERVAL 8 DAY,'Vikas'),
  (18,4,NULL,30,CURDATE() - INTERVAL 6 DAY,'Neha'),
  (22,5,NULL,25,CURDATE() - INTERVAL 5 DAY,'Aman'),
  (11,6,NULL,70,CURDATE() - INTERVAL 4 DAY,'Vikas'),
  (25,2,NULL,35,CURDATE() - INTERVAL 3 DAY,'Aman'),
  (16,3,NULL,30,CURDATE() - INTERVAL 2 DAY,'Neha'),
  (13,4,NULL,20,CURDATE() - INTERVAL 1 DAY,'Rahul'),
  (7,5,NULL,40,CURDATE(),'Aman'),
  (1,1,1,30,CURDATE(),'Rahul'),
  (10,6,NULL,80,CURDATE() - INTERVAL 13 DAY,'Vikas'),
  (14,6,NULL,55,CURDATE() - INTERVAL 11 DAY,'Neha'),
  (12,2,NULL,45,CURDATE() - INTERVAL 7 DAY,'Aman');

INSERT INTO stock_movement(batch_id,movement_type,qty,moved_on,note) VALUES
  (8,'WASTE',30,CURDATE() - INTERVAL 1 DAY,'Spoiled in transit'),(26,'WASTE',20,CURDATE() - INTERVAL 3 DAY,'Expired'),
  (15,'WASTE',40,CURDATE() - INTERVAL 2 DAY,'Expired - pest damage'),(9,'ISSUE',5,CURDATE(),'Staff canteen'),
  (19,'ISSUE',10,CURDATE() - INTERVAL 3 DAY,'Retail sale');

-- ---------------------------------------------------------------------
-- 6. DEMO: constraint / trigger tests (uncomment to see them fail)
-- ---------------------------------------------------------------------
-- INSERT INTO stock_movement(batch_id,movement_type,qty) VALUES (10,'ISSUE',99999);   -- T2: Insufficient stock
-- INSERT INTO distribution(batch_id,ngo_id,qty) VALUES (3,1,5);                         -- T4: expired food
-- INSERT INTO batch(batch_code,product_id,supplier_id,warehouse_id,mfg_date,expiry_date,qty_received,qty_available)
--   VALUES ('B-BAD',1,1,1,CURDATE(),CURDATE() - INTERVAL 1 DAY,10,10);                  -- CHECK chk_dates
-- CALL sp_fefo_dispatch(4,'Rahul');                                                      -- FEFO dispatch
-- CALL sp_expiry_alerts(3);

-- ---------------------------------------------------------------------
-- 7. REPORT QUERIES
-- ---------------------------------------------------------------------
-- R1 Near-expiry stock by warehouse (JOIN + date filter)
SELECT w.name AS warehouse, p.name AS product, b.batch_code, b.qty_available, b.expiry_date,
       DATEDIFF(b.expiry_date, CURDATE()) AS days_left
FROM batch b
JOIN product p   ON p.product_id = b.product_id
JOIN warehouse w ON w.warehouse_id = b.warehouse_id
WHERE b.qty_available > 0 AND b.expiry_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY
ORDER BY w.name, b.expiry_date;

-- R2 Value at risk by category (GROUP BY + HAVING)
SELECT category, COUNT(*) AS batches, SUM(qty_available) AS qty_at_risk,
       ROUND(SUM(qty_available * unit_price)) AS value_at_risk_inr
FROM v_batch_status WHERE status IN ('Critical','Near Expiry')
GROUP BY category HAVING SUM(qty_available) > 0
ORDER BY value_at_risk_inr DESC;

-- R3 Wastage % by category (conditional aggregation)
SELECT c.name AS category,
       SUM(CASE WHEN m.movement_type='IN'       THEN m.qty ELSE 0 END) AS received,
       SUM(CASE WHEN m.movement_type='DONATION' THEN m.qty ELSE 0 END) AS donated,
       SUM(CASE WHEN m.movement_type='WASTE'    THEN m.qty ELSE 0 END) AS wasted,
       ROUND(100 * SUM(CASE WHEN m.movement_type='WASTE' THEN m.qty ELSE 0 END)
                 / SUM(CASE WHEN m.movement_type='IN'    THEN m.qty ELSE 0 END), 1) AS waste_pct
FROM stock_movement m
JOIN batch b    ON b.batch_id = m.batch_id
JOIN product p  ON p.product_id = b.product_id
JOIN category c ON c.category_id = p.category_id
GROUP BY c.name ORDER BY waste_pct DESC;

-- R4 NGO leaderboard (window function RANK)
SELECT RANK() OVER (ORDER BY kg_received DESC) AS rnk, name, beneficiaries, kg_received, meals_served
FROM v_ngo_impact;

-- R5 Products never donated (NOT EXISTS)
SELECT p.name FROM product p
WHERE NOT EXISTS (SELECT 1 FROM distribution d JOIN batch b ON b.batch_id = d.batch_id
                  WHERE b.product_id = p.product_id);

-- R6 Warehouse utilisation
SELECT w.name, w.capacity_kg, IFNULL(SUM(b.qty_available),0) AS stock_kg,
       ROUND(100 * IFNULL(SUM(b.qty_available),0) / w.capacity_kg, 1) AS utilisation_pct
FROM warehouse w LEFT JOIN batch b ON b.warehouse_id = w.warehouse_id AND b.qty_available > 0
GROUP BY w.warehouse_id, w.name, w.capacity_kg;

-- R7 FEFO pick list with running total (window SUM ... PARTITION BY)
SELECT p.name AS product, b.batch_code, b.expiry_date, b.qty_available,
       SUM(b.qty_available) OVER (PARTITION BY p.product_id ORDER BY b.expiry_date) AS cumulative_qty
FROM batch b JOIN product p ON p.product_id = b.product_id
WHERE b.qty_available > 0 AND b.expiry_date >= CURDATE();

-- R8 NGOs above average (nested subquery)
SELECT name, kg_received FROM v_ngo_impact
WHERE kg_received > (SELECT AVG(kg_received) FROM v_ngo_impact);
