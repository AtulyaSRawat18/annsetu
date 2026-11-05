#!/usr/bin/env python3
"""AnnSetu local prototype API. Uses SQLite for zero-setup local development."""
import json, os, sqlite3, hashlib, secrets, csv, io, math
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DB = Path(os.environ.get('ANNSETU_DB', str(ROOT / 'database' / 'annsetu_local.sqlite3')))

SCHEMA = '''
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS organization(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('retailer','recipient','logistics','admin')), synthetic INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS store(id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organization, name TEXT NOT NULL, city TEXT NOT NULL, lat REAL, lon REAL);
CREATE TABLE IF NOT EXISTS category(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, storage TEXT NOT NULL DEFAULT 'ambient');
CREATE TABLE IF NOT EXISTS product(id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES store, sku TEXT NOT NULL, name TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES category, unit TEXT NOT NULL DEFAULT 'kg', unit_price REAL NOT NULL DEFAULT 0, safety_stock REAL NOT NULL DEFAULT 0, UNIQUE(store_id,sku));
CREATE TABLE IF NOT EXISTS batch(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product, lot_code TEXT NOT NULL, received_on TEXT NOT NULL, expiry_date TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity>0), reserved REAL NOT NULL DEFAULT 0 CHECK(reserved>=0), source TEXT NOT NULL DEFAULT 'synthetic', UNIQUE(product_id,lot_code));
CREATE TABLE IF NOT EXISTS sale(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product, sold_on TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity>=0), source TEXT NOT NULL DEFAULT 'synthetic', source_row_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS recipient(id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organization, name TEXT NOT NULL, city TEXT NOT NULL, lat REAL, lon REAL, capacity_kg REAL NOT NULL, cold_storage INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS demand(id INTEGER PRIMARY KEY, recipient_id INTEGER NOT NULL REFERENCES recipient, category_id INTEGER NOT NULL REFERENCES category, quantity REAL NOT NULL CHECK(quantity>0), needed_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','partially_fulfilled','fulfilled','cancelled')), declared INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS forecast(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product, generated_at TEXT NOT NULL, horizon_days INTEGER NOT NULL, predicted_daily REAL NOT NULL, forecast_method TEXT NOT NULL, data_cutoff TEXT NOT NULL, synthetic INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS allocation(id INTEGER PRIMARY KEY, demand_id INTEGER NOT NULL REFERENCES demand, status TEXT NOT NULL CHECK(status IN ('proposed','approved','delivered','cancelled')), created_at TEXT NOT NULL, explanation TEXT NOT NULL, estimated_km REAL NOT NULL DEFAULT 0, transport_cost REAL NOT NULL DEFAULT 0, handling_cost REAL NOT NULL DEFAULT 0, approved_by TEXT);
CREATE TABLE IF NOT EXISTS allocation_line(id INTEGER PRIMARY KEY, allocation_id INTEGER NOT NULL REFERENCES allocation, batch_id INTEGER NOT NULL REFERENCES batch, quantity REAL NOT NULL CHECK(quantity>0), UNIQUE(allocation_id,batch_id));
CREATE TABLE IF NOT EXISTS delivery(id INTEGER PRIMARY KEY, allocation_id INTEGER NOT NULL UNIQUE REFERENCES allocation, status TEXT NOT NULL CHECK(status IN ('pending','picked_up','delivered','failed')), completed_at TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, details TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_batch_expiry ON batch(expiry_date);
CREATE INDEX IF NOT EXISTS idx_sales_product_date ON sale(product_id,sold_on);
CREATE INDEX IF NOT EXISTS idx_demand_status_date ON demand(status,needed_by);
CREATE INDEX IF NOT EXISTS idx_allocation_status ON allocation(status);
DROP VIEW IF EXISTS v_batch_available;
CREATE VIEW v_batch_available AS SELECT b.*, b.quantity-b.reserved AS available, p.name AS product, p.unit, p.store_id, c.name AS category, c.storage FROM batch b JOIN product p ON p.id=b.product_id JOIN category c ON c.id=p.category_id;
'''

def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB, timeout=10, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    c.execute('PRAGMA busy_timeout=10000')
    return c

def seed(c):
    if c.execute('SELECT COUNT(*) FROM organization').fetchone()[0]: return
    today=date.today()
    orgs=[('Green Basket Market','retailer'),('Seva Community Kitchen','recipient'),('AnnSetu Operations','admin'),('City Food Runners','logistics')]
    c.executemany('INSERT INTO organization(name,kind) VALUES (?,?)',orgs)
    c.execute("INSERT INTO store(organization_id,name,city,lat,lon) VALUES (1,'Green Basket – Central','Pune',18.5204,73.8567)")
    c.executemany('INSERT INTO category(name,storage) VALUES (?,?)',[('Produce','chilled'),('Dairy','chilled'),('Bakery','ambient'),('Grains','ambient')])
    products=[('PRD-101','Tomatoes',1,'kg',35,4),('PRD-102','Milk 1L',2,'litre',58,6),('PRD-103','Bread loaves',3,'loaf',32,5),('PRD-104','Rice 5kg',4,'bag',280,3)]
    c.executemany('INSERT INTO product(store_id,sku,name,category_id,unit,unit_price,safety_stock) VALUES (1,?,?,?,?,?,?)',products)
    batches=[(1,'TOM-2401',today+timedelta(days=3),46),(1,'TOM-2402',today+timedelta(days=8),38),(2,'MIL-1601',today+timedelta(days=2),24),(3,'BRD-0901',today+timedelta(days=1),18),(4,'RIC-0101',today+timedelta(days=120),65)]
    c.executemany('INSERT INTO batch(product_id,lot_code,received_on,expiry_date,quantity) VALUES (?, ?, ?, ?, ?)',[(p,l,today.isoformat(),exp.isoformat(),q) for p,l,exp,q in batches])
    for product_id,base in [(1,18),(2,12),(3,10),(4,3)]:
        c.executemany('INSERT INTO sale(product_id,sold_on,quantity) VALUES (?,?,?)',[(product_id,(today-timedelta(days=i)).isoformat(),max(0,base+((i*7+product_id)%7)-3)) for i in range(1,29)])
    c.execute("INSERT INTO recipient(organization_id,name,city,lat,lon,capacity_kg,cold_storage) VALUES (2,'Seva Community Kitchen','Pune',18.5314,73.8446,70,1)")
    c.executemany('INSERT INTO demand(recipient_id,category_id,quantity,needed_by) VALUES (1,?,?,?)',[(1,25,(today+timedelta(days=1)).isoformat()),(2,20,(today+timedelta(days=1)).isoformat()),(3,15,(today+timedelta(days=1)).isoformat())])
    now=datetime.now().isoformat(timespec='seconds')
    c.execute('INSERT INTO audit(occurred_at,actor,action,entity,details) VALUES (?,?,?,?,?)',(now,'system','seeded','database','Synthetic demonstration dataset created'))

def init():
    c=connect(); c.executescript(SCHEMA); seed(c); c.close()

def audit(c,actor,action,entity,eid,details):
    c.execute('INSERT INTO audit(occurred_at,actor,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)',(datetime.now().isoformat(timespec='seconds'),actor,action,entity,eid,details))

def predict(c):
    """Mean of last 28 daily observations; transparently labelled baseline."""
    products=c.execute('SELECT * FROM product ORDER BY id').fetchall(); out=[]
    for p in products:
        vals=[r[0] for r in c.execute('SELECT quantity FROM sale WHERE product_id=? AND sold_on>=? ORDER BY sold_on',(p['id'],(date.today()-timedelta(days=28)).isoformat())).fetchall()]
        daily=sum(vals)/len(vals) if vals else 0.0
        for h in (1,3,7):
            c.execute('INSERT INTO forecast(product_id,generated_at,horizon_days,predicted_daily,forecast_method,data_cutoff,synthetic) VALUES (?,?,?,?,?,?,1)',(p['id'],datetime.now().isoformat(timespec='seconds'),h,daily,'28-day mean baseline',date.today().isoformat()))
            out.append({'sku':p['sku'],'product':p['name'],'horizon_days':h,'forecast_demand':round(daily*h,1),'method':'28-day mean baseline','kind':'prediction'})
    return out

def haversine(lat1,lon1,lat2,lon2):
    if None in (lat1,lon1,lat2,lon2): return 0.0
    r=6371.0; p1,p2=math.radians(lat1),math.radians(lat2); dp=math.radians(lat2-lat1); dl=math.radians(lon2-lon1)
    a=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*r*math.asin(math.sqrt(a))

class Handler(BaseHTTPRequestHandler):
    server_version='AnnSetuLocal/0.1'
    def log_message(self,*args): pass
    def send(self,status,obj,ctype='application/json'):
        body=obj if isinstance(obj,bytes) else (json.dumps(obj,ensure_ascii=False).encode() if ctype=='application/json' else obj.encode())
        self.send_response(status); self.send_header('Content-Type',ctype+'; charset=utf-8'); self.send_header('Content-Length',str(len(body))); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','Content-Type, Authorization'); self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); self.end_headers(); self.wfile.write(body)
    def body(self):
        n=int(self.headers.get('Content-Length','0')); return json.loads(self.rfile.read(n) or b'{}')
    def actor(self): return 'local-store-operator'
    def do_OPTIONS(self): self.send(204,{})
    def do_GET(self):
        path=urlparse(self.path).path
        if path=='/' or path=='/index.html': return self.send(200,(ROOT/'frontend'/'index.html').read_bytes(),'text/html')
        if path.startswith('/static/'): 
            f=ROOT/'frontend'/Path(path).name
            return self.send(200,f.read_bytes(),'text/css' if f.suffix=='.css' else 'text/javascript') if f.exists() else self.send(404,{'error':'not found'})
        if path=='/data/templates/sales.csv': return self.send(200,(ROOT/'data'/'templates'/'sales.csv').read_bytes(),'text/csv')
        c=connect()
        try:
            if path=='/api/health': return self.send(200,{'status':'ok','database':'sqlite-local','synthetic_seed':True})
            if path=='/api/dashboard':
                metrics={
                  'active_batches':c.execute('SELECT COUNT(*) FROM batch WHERE quantity>reserved AND expiry_date>=?',(date.today().isoformat(),)).fetchone()[0],
                  'near_expiry_kg':round(c.execute('SELECT COALESCE(SUM(quantity-reserved),0) FROM batch WHERE expiry_date<=?',((date.today()+timedelta(days=3)).isoformat(),)).fetchone()[0],1),
                  'open_demand_kg':round(c.execute("SELECT COALESCE(SUM(quantity),0) FROM demand WHERE status IN ('open','partially_fulfilled')").fetchone()[0],1),
                  'delivered_kg':round(c.execute("SELECT COALESCE(SUM(al.quantity),0) FROM allocation_line al JOIN allocation a ON a.id=al.allocation_id WHERE a.status='delivered'").fetchone()[0],1),
                  'synthetic':True}
                products=[dict(r) for r in c.execute('SELECT p.id,p.sku,p.name,c.name category,p.unit,p.unit_price,p.safety_stock,COALESCE((SELECT SUM(quantity-reserved) FROM batch WHERE product_id=p.id AND expiry_date>=?),0) stock FROM product p JOIN category c ON c.id=p.category_id ORDER BY p.name',(date.today().isoformat(),))]
                batches=[dict(r) for r in c.execute('SELECT * FROM v_batch_available WHERE available>0 ORDER BY expiry_date')]
                demands=[dict(r) for r in c.execute("SELECT d.*,r.name recipient,c.name category FROM demand d JOIN recipient r ON r.id=d.recipient_id JOIN category c ON c.id=d.category_id WHERE d.status IN ('open','partially_fulfilled') ORDER BY needed_by")]
                impacts=c.execute("SELECT COALESCE(SUM(dl.quantity),0) kg,COALESCE(SUM(a.transport_cost+a.handling_cost),0) costs FROM allocation a JOIN allocation_line dl ON dl.allocation_id=a.id WHERE a.status='delivered'").fetchone()
                return self.send(200,{'metrics':metrics,'products':products,'batches':batches,'demands':demands,'forecasts':[dict(r) for r in c.execute('SELECT f.*,p.sku,p.name product FROM forecast f JOIN product p ON p.id=f.product_id ORDER BY f.id DESC LIMIT 12')],'allocations':[dict(r) for r in c.execute('SELECT a.*,d.quantity demand_kg,r.name recipient FROM allocation a JOIN demand d ON d.id=a.demand_id JOIN recipient r ON r.id=d.recipient_id ORDER BY a.id DESC LIMIT 10')],'economics':{'procurement_savings':round(impacts['kg']*50,2),'avoided_disposal':round(impacts['kg']*8,2),'transport_and_handling':round(impacts['costs'],2),'platform_cost':0,'net_benefit':round(impacts['kg']*58-impacts['costs'],2),'assumption':'Illustrative ₹50/kg savings + ₹8/kg disposal cost; delivered rows only'}})
            if path=='/api/audit': return self.send(200,[dict(r) for r in c.execute('SELECT * FROM audit ORDER BY id DESC LIMIT 100')])
            return self.send(404,{'error':'route not found'})
        except Exception as e: return self.send(500,{'error':str(e)})
        finally: c.close()
    def do_POST(self):
        path=urlparse(self.path).path; c=connect()
        try:
            d=self.body()
            if path=='/api/forecast': return self.send(200,{'forecasts':predict(c),'notice':'Statistical baseline; synthetic seed data. Not measured model accuracy.'})
            if path=='/api/inventory/batches':
                product_id=int(d.get('product_id',0)); lot=str(d.get('lot_code','')).strip(); expiry=str(d.get('expiry_date','')); qty=float(d.get('quantity',0))
                product=c.execute('SELECT id FROM product WHERE id=?',(product_id,)).fetchone()
                if not product or not lot or qty<=0: return self.send(400,{'error':'Select a product, enter a batch code, and use a positive quantity'})
                date.fromisoformat(expiry)
                if expiry<date.today().isoformat(): return self.send(400,{'error':'Cannot receive an already expired batch'})
                cur=c.execute("INSERT INTO batch(product_id,lot_code,received_on,expiry_date,quantity,source) VALUES (?,?,?,?,?,'manual')",(product_id,lot,date.today().isoformat(),expiry,qty))
                audit(c,self.actor(),'received','batch',cur.lastrowid,'Received %s units'%qty); return self.send(201,{'batch_id':cur.lastrowid})
            if path=='/api/sales':
                product_id=int(d.get('product_id',0)); qty=float(d.get('quantity',0)); sold=str(d.get('sold_on',date.today().isoformat()))
                if not c.execute('SELECT id FROM product WHERE id=?',(product_id,)).fetchone() or qty<=0: return self.send(400,{'error':'Select a product and enter a positive sale quantity'})
                date.fromisoformat(sold); cur=c.execute("INSERT INTO sale(product_id,sold_on,quantity,source) VALUES (?,?,?,'manual')",(product_id,sold,qty))
                audit(c,self.actor(),'recorded','sale',cur.lastrowid,'Recorded %s units sold'%qty); return self.send(201,{'sale_id':cur.lastrowid})
            if path=='/api/matches':
                # Expiry-aware candidate ranking; candidate preview never reserves inventory.
                rows=c.execute("SELECT d.id demand_id,d.quantity need,d.needed_by,d.recipient_id,r.name recipient,r.capacity_kg,r.lat recipient_lat,r.lon recipient_lon,c.id category_id,c.name category,c.storage,b.id batch_id,b.lot_code,b.expiry_date,b.quantity-b.reserved available,p.name product,p.unit,s.lat store_lat,s.lon store_lon FROM demand d JOIN recipient r ON r.id=d.recipient_id JOIN category c ON c.id=d.category_id JOIN product p ON p.category_id=c.id JOIN store s ON s.id=p.store_id JOIN batch b ON b.product_id=p.id WHERE d.status IN ('open','partially_fulfilled') AND b.expiry_date>=? AND b.quantity>b.reserved AND p.unit='kg' AND (c.storage!='chilled' OR r.cold_storage=1) ORDER BY d.needed_by,b.expiry_date",(date.today().isoformat(),)).fetchall()
                seen=set(); matches=[]
                for r in rows:
                    key=(r['demand_id'],r['batch_id'])
                    if key in seen: continue
                    seen.add(key); q=min(r['need'],r['available'],r['capacity_kg'])
                    km=haversine(r['store_lat'],r['store_lon'],r['recipient_lat'],r['recipient_lon'])
                    if q>0: matches.append({'demand_id':r['demand_id'],'batch_id':r['batch_id'],'recipient':r['recipient'],'product':r['product'],'category':r['category'],'batch':r['lot_code'],'expiry_date':r['expiry_date'],'quantity':round(q,1),'estimated_km':round(km,1),'estimated_transport_cost':round(km*12,2),'explanation':'Category compatible; recipient has required storage; unreserved batch is unexpired and expires first. Distance and transport estimate are included.'})
                return self.send(200,{'matches':matches,'notice':'Suggestions only; human approval required.'})
            if path=='/api/allocations/approve':
                aid=int(d.get('allocation_id',0)); c.execute('BEGIN IMMEDIATE')
                a=c.execute("SELECT * FROM allocation WHERE id=? AND status='proposed'",(aid,)).fetchone()
                if not a: c.rollback(); return self.send(404,{'error':'Proposed allocation not found'})
                lines=c.execute('SELECT * FROM allocation_line WHERE allocation_id=?',(aid,)).fetchall()
                for line in lines:
                    b=c.execute('SELECT quantity,reserved,expiry_date FROM batch WHERE id=?',(line['batch_id'],)).fetchone()
                    if not b or b['quantity']-b['reserved']<line['quantity'] or b['expiry_date']<date.today().isoformat(): c.rollback(); return self.send(409,{'error':'Stock changed or batch expired; refresh recommendations'})
                for line in lines: c.execute('UPDATE batch SET reserved=reserved+? WHERE id=?',(line['quantity'],line['batch_id']))
                c.execute("UPDATE allocation SET status='approved',approved_by=? WHERE id=?",(self.actor(),aid)); audit(c,self.actor(),'approved','allocation',aid,'Reserved matching inventory'); c.commit(); return self.send(200,{'status':'approved','allocation_id':aid})
            if path=='/api/allocations/propose':
                demand_id=int(d.get('demand_id',0)); batch_id=int(d.get('batch_id',0)); qty=float(d.get('quantity',0))
                if qty<=0: return self.send(400,{'error':'Quantity must be positive'})
                c.execute('BEGIN IMMEDIATE')
                row=c.execute("SELECT b.quantity-b.reserved available,b.expiry_date,d.quantity need,d.needed_by,r.lat recipient_lat,r.lon recipient_lon,s.lat store_lat,s.lon store_lon FROM batch b JOIN product p ON p.id=b.product_id JOIN store s ON s.id=p.store_id JOIN demand d ON d.id=? JOIN recipient r ON r.id=d.recipient_id WHERE b.id=? AND p.category_id=d.category_id AND p.unit='kg' AND d.status IN ('open','partially_fulfilled')",(demand_id,batch_id)).fetchone()
                if not row or row['expiry_date']<date.today().isoformat() or qty>row['available'] or qty>row['need']: c.rollback(); return self.send(409,{'error':'Infeasible proposal: check category, expiry, available stock, and demand'})
                km=haversine(row['store_lat'],row['store_lon'],row['recipient_lat'],row['recipient_lon']); transport=km*12; handling=qty*2
                cur=c.execute("INSERT INTO allocation(demand_id,status,created_at,explanation,estimated_km,transport_cost,handling_cost) VALUES (?,'proposed',?,'Reviewer selected an expiry-safe category match; distance and costs are estimates.',?,?,?)",(demand_id,datetime.now().isoformat(timespec='seconds'),km,transport,handling)); aid=cur.lastrowid
                c.execute('INSERT INTO allocation_line(allocation_id,batch_id,quantity) VALUES (?,?,?)',(aid,batch_id,qty)); audit(c,self.actor(),'proposed','allocation',aid,'Waiting for human approval'); c.commit(); return self.send(201,{'allocation_id':aid,'status':'proposed'})
            if path=='/api/deliveries':
                aid=int(d.get('allocation_id',0)); status=d.get('status')
                if status not in ('picked_up','delivered','failed'): return self.send(400,{'error':'Invalid delivery status'})
                c.execute('BEGIN IMMEDIATE'); a=c.execute("SELECT * FROM allocation WHERE id=? AND status='approved'",(aid,)).fetchone()
                if not a: c.rollback(); return self.send(409,{'error':'Only approved allocations can be delivered'})
                cur=c.execute('INSERT INTO delivery(allocation_id,status,completed_at) VALUES (?,?,?)',(aid,status,datetime.now().isoformat(timespec='seconds') if status in ('delivered','failed') else None))
                if status=='delivered':
                    for line in c.execute('SELECT * FROM allocation_line WHERE allocation_id=?',(aid,)).fetchall(): c.execute('UPDATE batch SET quantity=quantity-?,reserved=reserved-? WHERE id=?',(line['quantity'],line['quantity'],line['batch_id']))
                    c.execute("UPDATE allocation SET status='delivered' WHERE id=?",(aid,)); c.execute("UPDATE demand SET status=CASE WHEN quantity <= (SELECT COALESCE(SUM(al.quantity),0) FROM allocation_line al JOIN allocation aa ON aa.id=al.allocation_id WHERE aa.demand_id=demand.id AND aa.status='delivered') THEN 'fulfilled' ELSE 'partially_fulfilled' END WHERE id=?",(a['demand_id'],))
                elif status=='failed':
                    for line in c.execute('SELECT * FROM allocation_line WHERE allocation_id=?',(aid,)).fetchall(): c.execute('UPDATE batch SET reserved=reserved-? WHERE id=?',(line['quantity'],line['batch_id']))
                    c.execute("UPDATE allocation SET status='cancelled' WHERE id=?",(aid,))
                audit(c,self.actor(),status,'delivery',cur.lastrowid,'Delivery status updated'); c.commit(); return self.send(201,{'delivery_id':cur.lastrowid,'status':status})
            if path=='/api/import/sales':
                content=d.get('csv',''); reader=csv.DictReader(io.StringIO(content)); rows=[]
                for i,r in enumerate(reader,2):
                    try:
                        sku=r['sku'].strip(); sold=r['sold_on'].strip(); qty=float(r['quantity'])
                        p=c.execute('SELECT id FROM product WHERE sku=?',(sku,)).fetchone()
                        if not p or qty<0: raise ValueError('unknown SKU or negative quantity')
                        date.fromisoformat(sold); key=hashlib.sha256((sku+'|'+sold+'|'+str(qty)).encode()).hexdigest(); rows.append((p['id'],sold,qty,'imported',key))
                    except Exception as e: return self.send(400,{'error':'Invalid CSV row %d: %s'%(i,e)})
                c.executemany('INSERT OR IGNORE INTO sale(product_id,sold_on,quantity,source,source_row_key) VALUES (?,?,?,?,?)',rows); imported=c.execute("SELECT changes()").fetchone()[0]; audit(c,self.actor(),'imported','sales',None,'%d new anonymised sales rows; duplicates ignored'%imported); return self.send(201,{'imported':imported,'duplicates_skipped':len(rows)-imported,'source':'real/imported'})
            return self.send(404,{'error':'route not found'})
        except sqlite3.IntegrityError as e: c.rollback(); return self.send(409,{'error':str(e)})
        except Exception as e: c.rollback(); return self.send(400,{'error':str(e)})
        finally: c.close()

if __name__=='__main__':
    init(); host=os.environ.get('ANNSETU_HOST','127.0.0.1'); port=int(os.environ.get('PORT','8000'))
    print('AnnSetu listening at http://%s:%s (SQLite local demo; synthetic data)'%(host,port),flush=True)
    ThreadingHTTPServer((host,port),Handler).serve_forever()
