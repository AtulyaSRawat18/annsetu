#!/usr/bin/env python3
"""AnnSetu local API backed by XAMPP MariaDB/MySQL."""
import json, os, hashlib, csv, io, math, mimetypes
from decimal import Decimal
from email.parser import BytesParser
from email.policy import default as email_policy
from openpyxl import load_workbook
from io import BytesIO
import mysql.connector
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
class HybridRow(dict):
    def __getitem__(self, key):
        if isinstance(key, int):
            return tuple(self.values())[key]
        return super().__getitem__(key)

def json_default(value):
    if isinstance(value, (date, datetime)): return value.isoformat()
    if isinstance(value, Decimal): return float(value)
    raise TypeError(f'Cannot serialize {type(value).__name__}')

class Statement:
    def __init__(self, cursor): self.cursor = cursor
    @property
    def lastrowid(self): return self.cursor.lastrowid
    def fetchone(self):
        row = self.cursor.fetchone()
        return HybridRow(row) if row is not None else None
    def fetchall(self): return [HybridRow(row) for row in self.cursor.fetchall()]
    def __iter__(self): return iter(self.fetchall())

class Connection:
    def __init__(self, raw): self.raw = raw
    def _sql(self, sql):
        sql = sql.replace('INSERT OR IGNORE INTO', 'INSERT IGNORE INTO').replace('BEGIN IMMEDIATE', 'START TRANSACTION').replace('SELECT changes()', 'SELECT ROW_COUNT()')
        return sql.replace('?', '%s')
    def execute(self, sql, args=()):
        cur = self.raw.cursor(dictionary=True)
        cur.execute(self._sql(sql), args)
        return Statement(cur)
    def executemany(self, sql, args):
        cur = self.raw.cursor(dictionary=True)
        cur.executemany(self._sql(sql), args)
        return Statement(cur)
    def commit(self): self.raw.commit()
    def rollback(self): self.raw.rollback()
    def close(self): self.raw.close()

def connect():
    return Connection(mysql.connector.connect(
        host=os.environ.get('ANNSETU_DB_HOST', '127.0.0.1'),
        port=int(os.environ.get('ANNSETU_DB_PORT', '3306')),
        user=os.environ.get('ANNSETU_DB_USER', 'root'),
        password=os.environ.get('ANNSETU_DB_PASSWORD', ''),
        database=os.environ.get('ANNSETU_DB_NAME', 'annsetu_python'),
        connection_timeout=10, autocommit=True, charset='utf8mb4', collation='utf8mb4_unicode_ci'))

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
    c=connect()
    try:
        c.execute('SELECT 1 FROM organization LIMIT 1').fetchone()
        seed(c)
    finally:
        c.close()

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
        body=obj if isinstance(obj,bytes) else (json.dumps(obj,ensure_ascii=False,default=json_default).encode() if ctype=='application/json' else obj.encode())
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
            return self.send(200,f.read_bytes(),mimetypes.guess_type(f.name)[0] or 'application/octet-stream') if f.exists() else self.send(404,{'error':'not found'})
        if path=='/data/templates/sales.csv': return self.send(200,(ROOT/'data'/'templates'/'sales.csv').read_bytes(),'text/csv')
        if path=='/api/map/config': return self.send(200,{'tile_url':os.environ.get('MAP_TILE_URL','https://tile.openstreetmap.org/{z}/{x}/{y}.png'),'attribution':'© OpenStreetMap contributors'})
        if path=='/api/ml/evaluation':
            f=ROOT/'ml'/'evaluation_metrics.json'
            return self.send(200,json.loads(f.read_text(encoding='utf-8')) if f.exists() else {'available':False})
        try: c=connect()
        except mysql.connector.Error as e: return self.send(503,{'error':f'Database unavailable. Start XAMPP MySQL and check its connection settings: {e}'})
        try:
            if path=='/api/health': return self.send(200,{'status':'ok','database':c.execute('SELECT DATABASE() name').fetchone()['name'],'engine':'MariaDB/MySQL','synthetic_seed':True})
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
            if path=='/api/map':
                stores=[dict(r) for r in c.execute('SELECT s.id,s.name,s.city,s.lat latitude,s.lon longitude,COALESCE(SUM(b.quantity-b.reserved),0) available_kg FROM store s LEFT JOIN product p ON p.store_id=s.id LEFT JOIN batch b ON b.product_id=p.id AND b.expiry_date>=CURDATE() GROUP BY s.id,s.name,s.city,s.lat,s.lon ORDER BY s.name')]
                recipients=[dict(r) for r in c.execute('SELECT id,name,city,lat latitude,lon longitude,capacity_kg,cold_storage FROM recipient ORDER BY name')]
                categories=[dict(r) for r in c.execute("SELECT id,name,storage,COALESCE((SELECT unit FROM product p WHERE p.category_id=category.id ORDER BY (p.unit='kg') DESC,p.id LIMIT 1),'kg') unit FROM category ORDER BY name")]
                demands=[dict(r) for r in c.execute("SELECT d.id,d.quantity,'kg' unit,d.status,d.needed_by needed_until,r.id recipient_id,r.name recipient,r.lat latitude,r.lon longitude,c.name category FROM demand d JOIN recipient r ON r.id=d.recipient_id JOIN category c ON c.id=d.category_id WHERE d.status IN ('open','partially_fulfilled') ORDER BY d.needed_by")]
                return self.send(200,{'stores':stores,'recipients':recipients,'categories':categories,'demands':demands})
            return self.send(404,{'error':'route not found'})
        except Exception as e: return self.send(500,{'error':str(e)})
        finally: c.close()
    def do_POST(self):
        path=urlparse(self.path).path
        if path=='/api/import/excel':
            try:
                content_type=self.headers.get('Content-Type','')
                raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
                message=BytesParser(policy=email_policy).parsebytes((f'Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n').encode()+raw)
                upload=next((part.get_payload(decode=True) for part in message.iter_parts() if part.get_param('name',header='content-disposition')=='file'),None)
                if not upload: return self.send(400,{'error':'Choose an .xlsx workbook to import'})
                workbook=load_workbook(BytesIO(upload),read_only=True,data_only=True)
                sheet=workbook['Sales Import'] if 'Sales Import' in workbook.sheetnames else workbook.active
                rows=list(sheet.iter_rows(values_only=True))
                if not rows: return self.send(400,{'error':'The workbook has no sales rows'})
                output=io.StringIO(); writer=csv.writer(output); writer.writerows(rows); d={'csv':output.getvalue()}; path='/api/import/sales'
            except Exception as e: return self.send(400,{'error':f'Could not read Excel workbook: {e}'})
        else:
            try: d=self.body()
            except Exception as e: return self.send(400,{'error':f'Invalid JSON request: {e}'})
        try: c=connect()
        except mysql.connector.Error as e: return self.send(503,{'error':f'Database unavailable. Start XAMPP MySQL and check its connection settings: {e}'})
        try:
            if path=='/api/forecast': return self.send(200,{'forecasts':predict(c),'notice':'Statistical baseline; synthetic seed data. Not measured model accuracy.'})
            if path=='/api/map/simulated-demand':
                rid=int(d.get('recipient_id',0)); cid=int(d.get('category_id',0)); qty=float(d.get('quantity',0))
                if qty<=0 or not c.execute('SELECT id FROM recipient WHERE id=?',(rid,)).fetchone() or not c.execute('SELECT id FROM category WHERE id=?',(cid,)).fetchone(): return self.send(400,{'error':'Choose a valid recipient and category and enter a positive quantity'})
                cur=c.execute("INSERT INTO demand(recipient_id,category_id,quantity,needed_by,declared) VALUES (?,?,?,?,0)",(rid,cid,qty,(date.today()+timedelta(days=1)).isoformat()))
                return self.send(201,{'demand_id':cur.lastrowid,'recipient_id':rid,'category_id':cid,'quantity':qty,'unit':'kg','synthetic':True})
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
                a=c.execute("SELECT * FROM allocation WHERE id=? AND status='proposed' FOR UPDATE",(aid,)).fetchone()
                if not a: c.rollback(); return self.send(404,{'error':'Proposed allocation not found'})
                lines=c.execute('SELECT * FROM allocation_line WHERE allocation_id=?',(aid,)).fetchall()
                for line in lines:
                    b=c.execute('SELECT quantity,reserved,expiry_date FROM batch WHERE id=? FOR UPDATE',(line['batch_id'],)).fetchone()
                    if not b or b['quantity']-b['reserved']<line['quantity'] or b['expiry_date']<date.today().isoformat(): c.rollback(); return self.send(409,{'error':'Stock changed or batch expired; refresh recommendations'})
                for line in lines: c.execute('UPDATE batch SET reserved=reserved+? WHERE id=?',(line['quantity'],line['batch_id']))
                c.execute("UPDATE allocation SET status='approved',approved_by=? WHERE id=?",(self.actor(),aid)); audit(c,self.actor(),'approved','allocation',aid,'Reserved matching inventory'); c.commit(); return self.send(200,{'status':'approved','allocation_id':aid})
            if path=='/api/allocations/propose':
                demand_id=int(d.get('demand_id',0)); batch_id=int(d.get('batch_id',0)); qty=float(d.get('quantity',0))
                if qty<=0: return self.send(400,{'error':'Quantity must be positive'})
                c.execute('BEGIN IMMEDIATE')
                row=c.execute("SELECT b.quantity-b.reserved available,b.expiry_date,d.quantity need,d.needed_by,r.lat recipient_lat,r.lon recipient_lon,s.lat store_lat,s.lon store_lon FROM batch b JOIN product p ON p.id=b.product_id JOIN store s ON s.id=p.store_id JOIN demand d ON d.id=? JOIN recipient r ON r.id=d.recipient_id WHERE b.id=? AND p.category_id=d.category_id AND p.unit='kg' AND d.status IN ('open','partially_fulfilled') FOR UPDATE",(demand_id,batch_id)).fetchone()
                if not row or row['expiry_date']<date.today().isoformat() or qty>row['available'] or qty>row['need']: c.rollback(); return self.send(409,{'error':'Infeasible proposal: check category, expiry, available stock, and demand'})
                km=haversine(row['store_lat'],row['store_lon'],row['recipient_lat'],row['recipient_lon']); transport=km*12; handling=qty*2
                cur=c.execute("INSERT INTO allocation(demand_id,status,created_at,explanation,estimated_km,transport_cost,handling_cost) VALUES (?,'proposed',?,'Reviewer selected an expiry-safe category match; distance and costs are estimates.',?,?,?)",(demand_id,datetime.now().isoformat(timespec='seconds'),km,transport,handling)); aid=cur.lastrowid
                c.execute('INSERT INTO allocation_line(allocation_id,batch_id,quantity) VALUES (?,?,?)',(aid,batch_id,qty)); audit(c,self.actor(),'proposed','allocation',aid,'Waiting for human approval'); c.commit(); return self.send(201,{'allocation_id':aid,'status':'proposed'})
            if path=='/api/deliveries':
                aid=int(d.get('allocation_id',0)); status=d.get('status')
                if status not in ('picked_up','delivered','failed'): return self.send(400,{'error':'Invalid delivery status'})
                c.execute('BEGIN IMMEDIATE'); a=c.execute("SELECT * FROM allocation WHERE id=? AND status='approved' FOR UPDATE",(aid,)).fetchone()
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
        except mysql.connector.IntegrityError as e: c.rollback(); return self.send(409,{'error':str(e)})
        except Exception as e: c.rollback(); return self.send(400,{'error':str(e)})
        finally: c.close()

if __name__=='__main__':
    init(); host=os.environ.get('ANNSETU_HOST','127.0.0.1'); port=int(os.environ.get('PORT','8000'))
    print('AnnSetu listening at http://%s:%s (XAMPP MariaDB; synthetic demo data)'%(host,port),flush=True)
    ThreadingHTTPServer((host,port),Handler).serve_forever()
