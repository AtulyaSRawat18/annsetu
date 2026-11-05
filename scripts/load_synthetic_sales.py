"""Load labelled generated sales into PostgreSQL without duplicating seeded dates."""
import csv
from pathlib import Path
import psycopg

root=Path(__file__).resolve().parents[1]
dsn=__import__('os').getenv('DATABASE_URL','dbname=annsetu')
count=0
with (root/'data/synthetic/sales_history_daily.csv').open() as f, psycopg.connect(dsn) as conn:
    reader=csv.DictReader(f)
    for row in reader:
        p=conn.execute('SELECT id FROM product WHERE sku=%s',(row['sku'],)).fetchone()
        key=f"ml:{row['sku']}:{row['date']}"
        inserted=conn.execute("""INSERT INTO sales_observation(product_id,sold_on,quantity,source,source_row_key)
          SELECT %s,%s,%s,'synthetic',%s WHERE NOT EXISTS
          (SELECT 1 FROM sales_observation WHERE product_id=%s AND sold_on=%s AND source='synthetic')
          ON CONFLICT(source_row_key) DO NOTHING""",(p[0],row['date'],float(row['units_sold']),key,p[0],row['date']))
        count+=inserted.rowcount
print(f'Loaded {count} synthetic daily rows; existing seeded dates were preserved.')
