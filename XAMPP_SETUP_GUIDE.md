# AnnSetu — XAMPP Setup & Run Guide

AnnSetu has been upgraded from an in-browser mock database (`sql.js`) to a persistent **MySQL 8.0 / MariaDB** database with a **PHP backend**.

The project is linked to your XAMPP installation at:
`C:\xampp\htdocs\annsetu`

---

## 3 Simple Steps to Run

### Step 1: Start XAMPP
1. Open the **XAMPP Control Panel** from your Start menu or `C:\xampp\xampp-control.exe`.
2. Click **Start** next to **Apache**.
3. Click **Start** next to **MySQL**.

Both should show green status.

---

### Step 2: Import the Database
You can import the database using either **phpMyAdmin** or the **terminal**.

#### Option A: Using phpMyAdmin (Visual)
1. Open your browser and go to [http://localhost/phpmyadmin](http://localhost/phpmyadmin).
2. Click on the **Import** tab at the top.
3. Click **Choose File** and select:
   `c:\Users\ANSHU\OneDrive\Desktop\Inventory expiry project\sql\annsetu_mysql.sql`
4. Scroll down and click **Import** (or **Go**).
5. The database `annsetu` will be created with all 10 tables, 7 triggers, 3 views, stored procedures, and initial seed data.

#### Option B: Using Command Line (One Command)
Run this command in PowerShell:
```powershell
Get-Content "c:\Users\ANSHU\OneDrive\Desktop\Inventory expiry project\sql\annsetu_mysql.sql" | C:\xampp\mysql\bin\mysql.exe -u root
```

---

### Step 3: Open the Web Application
Open your browser and navigate to:
👉 **[http://localhost/annsetu/](http://localhost/annsetu/)**

---

## What Was Built & Upgraded

### 1. Dedicated PHP REST API (`/api`)
- [`api/db.php`](file:///c:/Users/ANSHU/OneDrive/Desktop/Inventory%20expiry%20project/api/db.php): Centralized PDO connection with utf8mb4 and CORS.
- [`api/dashboard.php`](file:///c:/Users/ANSHU/OneDrive/Desktop/Inventory%20expiry%20project/api/dashboard.php): Aggregates KPIs, 14-day recursive CTE trend, expiry alerts, and open requests.
- [`api/inventory.php`](file:///c:/Users/ANSHU/OneDrive/Desktop/Inventory%20expiry%20project/api/inventory.php): Search/filter stock, add batches, record usage/waste movements, and call `sp_discard_expired()`.
- [`api/distribution.php`](file:///c:/Users/ANSHU/OneDrive/Desktop/Inventory%20expiry%20project/api/distribution.php): Smart FEFO matching with window functions, atomic dispatch via `sp_fefo_dispatch()`, and request management.
- [`api/ngos.php`](file:///c:/Users/ANSHU/OneDrive/Desktop/Inventory%20expiry%20project/api/ngos.php): Register partner NGOs and rank them by meals served with `RANK() OVER`.
- [`api/reports.php`](file:///c:/Users/ANSHU/OneDrive/Desktop/Inventory%20expiry%20project/api/reports.php): Executes 10 analytical SQL queries against live MySQL.
- [`api/audit.php`](file:///c:/Users/ANSHU/OneDrive/Desktop/Inventory%20expiry%20project/api/audit.php): Live stock movement ledger and trigger-written audit trail.
- [`api/schema.php`](file:///c:/Users/ANSHU/OneDrive/Desktop/Inventory%20expiry%20project/api/schema.php): Extracts real MySQL table, view, trigger, and index definitions, plus foreign key relationships for the ER diagram.
- [`api/console.php`](file:///c:/Users/ANSHU/OneDrive/Desktop/Inventory%20expiry%20project/api/console.php): Executes arbitrary SQL queries and statements directly against MySQL.

### 2. Frontend Re-architecture (`app.js` & `index.html`)
- All in-browser WebAssembly SQLite scripts (`sql.js`, `db.js`) have been removed.
- Replaced with an asynchronous `fetch()` API client with network logging in the **API Log** drawer.
- Data persistence is now active: changes made in the app are permanently stored in MySQL across page reloads and browser sessions.

