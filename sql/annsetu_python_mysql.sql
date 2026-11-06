-- AnnSetu Python app schema for XAMPP MySQL/MariaDB.
-- Import into phpMyAdmin or run: mysql -u root < sql/annsetu_python_mysql.sql
-- Keep the Python app separate from the legacy PHP database named `annsetu`.
CREATE DATABASE IF NOT EXISTS annsetu_python CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE annsetu_python;

CREATE TABLE IF NOT EXISTS organization (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  synthetic TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS store (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  city VARCHAR(100) NOT NULL,
  lat DECIMAL(9,6), lon DECIMAL(9,6),
  CONSTRAINT fk_store_org FOREIGN KEY (organization_id) REFERENCES organization(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS category (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  storage VARCHAR(20) NOT NULL DEFAULT 'ambient'
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS product (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_id BIGINT UNSIGNED NOT NULL,
  sku VARCHAR(40) NOT NULL,
  name VARCHAR(150) NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  unit VARCHAR(20) NOT NULL DEFAULT 'kg',
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  safety_stock DECIMAL(12,3) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_product_store_sku (store_id,sku),
  CONSTRAINT fk_product_store FOREIGN KEY (store_id) REFERENCES store(id),
  CONSTRAINT fk_product_category FOREIGN KEY (category_id) REFERENCES category(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS batch (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  lot_code VARCHAR(60) NOT NULL,
  received_on DATE NOT NULL,
  expiry_date DATE NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  reserved DECIMAL(12,3) NOT NULL DEFAULT 0,
  source VARCHAR(20) NOT NULL DEFAULT 'synthetic',
  UNIQUE KEY uq_batch_product_lot (product_id,lot_code),
  KEY idx_batch_expiry (expiry_date),
  CONSTRAINT fk_batch_product FOREIGN KEY (product_id) REFERENCES product(id),
  CONSTRAINT chk_batch_quantity CHECK (quantity >= 0),
  CONSTRAINT chk_batch_reserved CHECK (reserved >= 0 AND reserved <= quantity)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sale (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  sold_on DATE NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'synthetic',
  source_row_key CHAR(64) NULL UNIQUE,
  KEY idx_sales_product_date (product_id,sold_on),
  CONSTRAINT fk_sale_product FOREIGN KEY (product_id) REFERENCES product(id),
  CONSTRAINT chk_sale_quantity CHECK (quantity >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recipient (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  city VARCHAR(100) NOT NULL,
  lat DECIMAL(9,6), lon DECIMAL(9,6),
  capacity_kg DECIMAL(12,3) NOT NULL,
  cold_storage TINYINT(1) NOT NULL DEFAULT 0,
  verified TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_recipient_org FOREIGN KEY (organization_id) REFERENCES organization(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS demand (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  recipient_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  needed_by DATE NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  declared TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_demand_status_date (status,needed_by),
  CONSTRAINT fk_demand_recipient FOREIGN KEY (recipient_id) REFERENCES recipient(id),
  CONSTRAINT fk_demand_category FOREIGN KEY (category_id) REFERENCES category(id),
  CONSTRAINT chk_demand_quantity CHECK (quantity > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS forecast (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  generated_at DATETIME NOT NULL,
  horizon_days INT NOT NULL,
  predicted_daily DECIMAL(12,4) NOT NULL,
  forecast_method VARCHAR(100) NOT NULL,
  data_cutoff DATE NOT NULL,
  synthetic TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_forecast_product FOREIGN KEY (product_id) REFERENCES product(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS allocation (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  demand_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at DATETIME NOT NULL,
  explanation TEXT NOT NULL,
  estimated_km DECIMAL(12,3) NOT NULL DEFAULT 0,
  transport_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  handling_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  approved_by VARCHAR(100),
  KEY idx_allocation_status (status),
  CONSTRAINT fk_allocation_demand FOREIGN KEY (demand_id) REFERENCES demand(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS allocation_line (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  allocation_id BIGINT UNSIGNED NOT NULL,
  batch_id BIGINT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  UNIQUE KEY uq_allocation_batch (allocation_id,batch_id),
  CONSTRAINT fk_line_allocation FOREIGN KEY (allocation_id) REFERENCES allocation(id),
  CONSTRAINT fk_line_batch FOREIGN KEY (batch_id) REFERENCES batch(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS delivery (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  allocation_id BIGINT UNSIGNED NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL,
  completed_at DATETIME NULL,
  CONSTRAINT fk_delivery_allocation FOREIGN KEY (allocation_id) REFERENCES allocation(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  occurred_at DATETIME NOT NULL,
  actor VARCHAR(100) NOT NULL,
  action VARCHAR(80) NOT NULL,
  entity VARCHAR(80) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  details TEXT NOT NULL
) ENGINE=InnoDB;

CREATE OR REPLACE VIEW v_batch_available AS
SELECT b.*, b.quantity-b.reserved AS available, p.name AS product, p.unit, p.store_id,
       c.name AS category, c.storage
FROM batch b JOIN product p ON p.id=b.product_id JOIN category c ON c.id=p.category_id;
