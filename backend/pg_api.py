"""AnnSetu API backed by PostgreSQL. Local development only; no login flow."""
import os, math, csv, io, json
from datetime import date, datetime, timedelta
from pathlib import Path
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pandas as pd
import joblib

ROOT=Path(__file__).resolve().parents[1]
DSN=os.getenv('DATABASE_URL','dbname=annsetu')
app=FastAPI(title='AnnSetu Grocery Operations API',version='0.1.0')
MODEL=joblib.load(ROOT/'ml'/'synthetic_sales_random_forest.joblib')
FEATURES=['sku','unit_price','promo','holiday_flag','weekday','month','lag_1','lag_7','lag_28','rolling_7']
app.mount('/static',StaticFiles(directory=ROOT/'frontend'),name='static')
def db(): return psycopg.connect(DSN,row_factory=dict_row)
def rows(sql,args=()):
    with db() as c: return c.execute(sql,args).fetchall()
def one(sql,args=()):
    with db() as c: return c.execute(sql,args).fetchone()
def audit(c,action,entity,eid,details): c.execute('INSERT INTO audit_log(action,entity,entity_id,details) VALUES (%s,%s,%s,%s)',(action,entity,eid,Jsonb({'details':details})))

class BatchIn(BaseModel): product_id:int; lot_code:str; quantity:float=Field(gt=0); expiry_date:date
class SaleIn(BaseModel): product_id:int; quantity:float=Field(gt=0); sold_on:date=date.today()
class ProposalIn(BaseModel): demand_id:int; batch_id:int; quantity:float=Field(gt=0)
class DeliveryIn(BaseModel): allocation_id:int; status:str

@app.get('/')
def index(): return FileResponse(ROOT/'frontend'/'index.html')
@app.get('/api/health')
def health():
    try: r=one('select current_database() db, version() version'); return {'status':'ok','database':r['db'],'engine':'PostgreSQL','version':r['version'].split()[1]}
    except Exception as e: raise HTTPException(503,str(e))
@app.get('/api/dashboard')
def dashboard():
    metrics=one("""SELECT (SELECT count(*) FROM batch WHERE quantity>reserved AND expiry_date>=current_date) active_batches,
      (SELECT coalesce(sum(quantity-reserved),0) FROM batch WHERE expiry_date<=current_date+3 AND expiry_date>=current_date) near_expiry_kg,
      (SELECT coalesce(sum(quantity),0) FROM demand WHERE status in ('open','partially_fulfilled')) open_demand_kg,
      (SELECT coalesce(sum(l.quantity),0) FROM allocation_line l JOIN allocation a ON a.id=l.allocation_id WHERE a.status='delivered') delivered_kg""")
    products=rows("""SELECT p.id,p.sku,p.name,c.name category,p.unit,p.unit_price,p.safety_stock,
      coalesce(sum(b.quantity-b.reserved) FILTER(WHERE b.expiry_date>=current_date),0) stock
      FROM product p JOIN category c ON c.id=p.category_id LEFT JOIN batch b ON b.product_id=p.id
      GROUP BY p.id,c.name ORDER BY p.name""")
    batches=rows('SELECT * FROM v_batch_available WHERE available>0 ORDER BY expiry_date')
    demands=rows("""SELECT d.*,d.needed_until AS needed_by,r.name recipient,c.name category FROM demand d JOIN recipient_site r ON r.id=d.recipient_id
      JOIN category c ON c.id=d.category_id WHERE d.status IN ('open','partially_fulfilled') ORDER BY needed_until""")
    forecasts=rows('SELECT f.*,p.sku,p.name product,r.horizon_days,f.predicted_quantity/r.horizon_days AS predicted_daily FROM forecast_value f JOIN product p ON p.id=f.product_id JOIN forecast_run r ON r.id=f.run_id ORDER BY f.id DESC LIMIT 12')
    allocations=rows('SELECT a.*,d.quantity demand_kg,r.name recipient FROM allocation a JOIN demand d ON d.id=a.demand_id JOIN recipient_site r ON r.id=d.recipient_id ORDER BY a.id DESC LIMIT 10')
    econ=one("""SELECT coalesce(sum(l.quantity)*50,0) procurement_savings,coalesce(sum(l.quantity)*8,0) avoided_disposal,
      coalesce(sum(a.transport_cost+a.handling_cost),0) transport_and_handling FROM allocation a JOIN allocation_line l ON l.allocation_id=a.id WHERE a.status='delivered'""")
    econ.update({'platform_cost':0,'net_benefit':econ['procurement_savings']+econ['avoided_disposal']-econ['transport_and_handling'],'assumption':'Illustrative ₹50/kg savings + ₹8/kg disposal estimate'})
    return {'metrics':metrics,'products':products,'batches':batches,'demands':demands,'forecasts':forecasts,'allocations':allocations,'economics':econ}

@app.post('/api/forecast')
def forecast():
    out=[]
    with db() as c:
        for p in c.execute('SELECT id,sku,name,unit_price FROM product ORDER BY id').fetchall():
            history=c.execute('SELECT sold_on,sum(quantity) quantity FROM sales_observation WHERE product_id=%s AND sold_on>=current_date-28 GROUP BY sold_on ORDER BY sold_on',(p['id'],)).fetchall()
            daily={x['sold_on']:float(x['quantity']) for x in history}; series=[daily.get(date.today()-timedelta(days=i),0.0) for i in range(28,0,-1)]
            horizon=[]
            for step in range(1,8):
                target=date.today()+timedelta(days=step); feat={'sku':p['sku'],'unit_price':float(p['unit_price']),'promo':0,'holiday_flag':0,'weekday':target.weekday(),'month':target.month,'lag_1':series[-1],'lag_7':series[-7],'lag_28':series[-28],'rolling_7':sum(series[-7:])/7}
                estimate=max(0,float(MODEL.predict(pd.DataFrame([[feat[k] for k in FEATURES]],columns=FEATURES))[0]));series.append(estimate);horizon.append(estimate)
                if step in (1,3,7):
                    total=sum(horizon);run=c.execute("INSERT INTO forecast_run(model_name,model_version,data_cutoff_at,horizon_days,dataset_kind) VALUES ('Random Forest','synthetic-rf-1',now(),%s,'synthetic') RETURNING id",(step,)).fetchone()
                    c.execute('INSERT INTO forecast_value(run_id,store_id,product_id,target_date,predicted_quantity) SELECT %s,store_id,%s,%s,%s FROM product WHERE id=%s',(run['id'],p['id'],target,total,p['id']))
                    out.append({'sku':p['sku'],'product':p['name'],'horizon_days':step,'forecast_demand':round(total,1),'method':'Random Forest · synthetic-trained','kind':'prediction'})
    return {'forecasts':out,'notice':'Random Forest trained on generated synthetic history; holdout metrics do not represent real store performance.'}

@app.get('/api/ml/evaluation')
def evaluation(): return json.loads((ROOT/'ml'/'evaluation_metrics.json').read_text())

@app.post('/api/inventory/batches',status_code=201)
def receive(x:BatchIn):
    if x.expiry_date<date.today(): raise HTTPException(400,'Already expired')
    with db() as c:
        try: r=c.execute("INSERT INTO batch(product_id,lot_code,received_on,expiry_date,quantity,source) VALUES (%s,%s,%s,%s,%s,'manual') RETURNING id",(x.product_id,x.lot_code,date.today(),x.expiry_date,x.quantity)).fetchone()
        except psycopg.errors.ForeignKeyViolation: raise HTTPException(404,'Product not found')
        audit(c,'received','batch',r['id'],x.lot_code); return {'batch_id':r['id']}
@app.post('/api/sales',status_code=201)
def sale(x:SaleIn):
    with db() as c:
        r=c.execute("INSERT INTO sales_observation(product_id,sold_on,quantity,source) VALUES (%s,%s,%s,'manual') RETURNING id",(x.product_id,x.sold_on,x.quantity)).fetchone()
        audit(c,'recorded','sale',r['id'],str(x.quantity)); return {'sale_id':r['id']}
@app.post('/api/import/sales')
def import_sales(payload:dict):
    data=payload.get('csv',''); reader=csv.DictReader(io.StringIO(data)); count=0
    with db() as c:
        for i,r in enumerate(reader,2):
            try:
                p=c.execute('SELECT id FROM product WHERE sku=%s',(r['sku'].strip(),)).fetchone(); d=date.fromisoformat(r['sold_on']); q=float(r['quantity'])
                if not p or q<0: raise ValueError('SKU or quantity invalid')
                key=f"{r['sku']}|{d}|{q}"
                c.execute("INSERT INTO sales_observation(product_id,sold_on,quantity,source,source_row_key) VALUES (%s,%s,%s,'imported',%s) ON CONFLICT(source_row_key) DO NOTHING",(p['id'],d,q,key)); count+=c.execute('SELECT 1').rowcount
            except Exception as e: raise HTTPException(400,f'CSV row {i}: {e}')
    return {'imported':count,'source':'imported CSV'}

@app.post('/api/import/excel')
async def import_excel(file:UploadFile=File(...),sheet_name:str='Sales Import'):
    try: frame=pd.read_excel(io.BytesIO(await file.read()),sheet_name=sheet_name,header=3 if sheet_name=='Sales Import' else 0)
    except Exception as e: raise HTTPException(400,f'Could not read worksheet {sheet_name}: {e}')
    needed={'sku','sold_on','quantity'}
    if not needed.issubset({str(x).strip().lower() for x in frame.columns}): raise HTTPException(400,'Worksheet needs sku, sold_on, quantity columns')
    frame.columns=[str(x).strip().lower() for x in frame.columns]; count=0
    with db() as c:
        for i,row in frame.iterrows():
            try:
                sku=str(row['sku']).strip(); sold=pd.to_datetime(row['sold_on']).date(); qty=float(row['quantity'])
                if qty<0 or not math.isfinite(qty): raise ValueError('quantity must be finite and nonnegative')
                p=c.execute('SELECT id FROM product WHERE sku=%s',(sku,)).fetchone()
                if not p: raise ValueError('unknown SKU '+sku)
                key=f"excel:{sku}:{sold}:{qty}"
                cur=c.execute("INSERT INTO sales_observation(product_id,sold_on,quantity,source,source_row_key) VALUES (%s,%s,%s,'imported',%s) ON CONFLICT(source_row_key) DO NOTHING",(p['id'],sold,qty,key));count+=cur.rowcount
            except Exception as e: raise HTTPException(400,f'Excel row {i+2}: {e}')
    return {'imported':count,'source':'Excel worksheet: '+sheet_name}

@app.post('/api/matches')
def matches():
    candidates=rows("""SELECT d.id demand_id,d.quantity need,d.needed_until,r.name recipient,r.capacity_kg,r.latitude rl,r.longitude ro,
      c.name category,c.storage,b.id batch_id,b.lot_code,b.expiry_date,b.quantity-b.reserved available,p.name product,s.latitude sl,s.longitude so
      FROM demand d JOIN recipient_site r ON r.id=d.recipient_id JOIN category c ON c.id=d.category_id
      JOIN product p ON p.category_id=c.id JOIN store s ON s.id=p.store_id JOIN batch b ON b.product_id=p.id
      WHERE d.status IN ('open','partially_fulfilled') AND b.expiry_date>=current_date AND b.quantity>b.reserved AND p.unit='kg'
      AND (c.storage='ambient' OR r.cold_storage) ORDER BY d.needed_until,b.expiry_date""")
    out=[]
    for x in candidates:
        km=0 if None in (x['sl'],x['so'],x['rl'],x['ro']) else 6371*2*math.asin(math.sqrt(math.sin(math.radians(x['rl']-x['sl'])/2)**2+math.cos(math.radians(x['sl']))*math.cos(math.radians(x['rl']))*math.sin(math.radians(x['ro']-x['so'])/2)**2))
        out.append({'demand_id':x['demand_id'],'batch_id':x['batch_id'],'recipient':x['recipient'],'product':x['product'],'category':x['category'],'batch':x['lot_code'],'expiry_date':x['expiry_date'],'quantity':min(x['need'],x['available'],x['capacity_kg']),'estimated_km':round(km,1),'explanation':'Category and storage compatible; unexpired, available batch ranked by expiry.'})
    return {'matches':out,'notice':'Suggestions only; review before approval.'}

@app.post('/api/allocations/propose',status_code=201)
def propose(x:ProposalIn):
    with db() as c:
        c.execute('BEGIN')
        b=c.execute('SELECT b.quantity-b.reserved available,b.expiry_date,p.category_id,p.unit FROM batch b JOIN product p ON p.id=b.product_id WHERE b.id=%s FOR UPDATE',(x.batch_id,)).fetchone()
        d=c.execute("SELECT category_id,quantity FROM demand WHERE id=%s AND status IN ('open','partially_fulfilled') FOR UPDATE",(x.demand_id,)).fetchone()
        if not b or not d or b['category_id']!=d['category_id'] or b['unit']!='kg' or b['expiry_date']<date.today() or x.quantity>b['available'] or x.quantity>d['quantity']: raise HTTPException(409,'Infeasible proposal; refresh inventory and demand')
        a=c.execute("INSERT INTO allocation(demand_id,status,estimated_km,transport_cost,handling_cost) VALUES (%s,'proposed',0,0,%s) RETURNING id",(x.demand_id,x.quantity*2)).fetchone()
        c.execute('INSERT INTO allocation_line(allocation_id,batch_id,quantity) VALUES (%s,%s,%s)',(a['id'],x.batch_id,x.quantity)); audit(c,'proposed','allocation',a['id'],'Awaiting review'); return {'allocation_id':a['id'],'status':'proposed'}

@app.post('/api/allocations/approve')
def approve(data:dict):
    aid=int(data['allocation_id'])
    with db() as c:
        a=c.execute("SELECT * FROM allocation WHERE id=%s AND status='proposed' FOR UPDATE",(aid,)).fetchone()
        if not a: raise HTTPException(404,'Proposal not found')
        for l in c.execute('SELECT * FROM allocation_line WHERE allocation_id=%s',(aid,)).fetchall():
            b=c.execute('SELECT quantity,reserved,expiry_date FROM batch WHERE id=%s FOR UPDATE',(l['batch_id'],)).fetchone()
            if b['quantity']-b['reserved']<l['quantity'] or b['expiry_date']<date.today(): raise HTTPException(409,'Stock changed or expired')
            c.execute('UPDATE batch SET reserved=reserved+%s WHERE id=%s',(l['quantity'],l['batch_id']))
        c.execute("UPDATE allocation SET status='approved' WHERE id=%s",(aid,)); audit(c,'approved','allocation',aid,'Stock reserved'); return {'status':'approved'}

@app.post('/api/deliveries')
def delivery(x:DeliveryIn):
    if x.status not in ('delivered','failed','picked_up'): raise HTTPException(400,'Invalid delivery status')
    with db() as c:
        a=c.execute("SELECT * FROM allocation WHERE id=%s AND status='approved' FOR UPDATE",(x.allocation_id,)).fetchone()
        if not a: raise HTTPException(409,'Only approved proposals can move to delivery')
        d=c.execute('INSERT INTO delivery(allocation_id,status,confirmation_at) VALUES (%s,%s,CASE WHEN %s IN (\'delivered\',\'failed\') THEN now() END) RETURNING id',(x.allocation_id,x.status,x.status)).fetchone()
        if x.status in ('delivered','failed'):
            for l in c.execute('SELECT * FROM allocation_line WHERE allocation_id=%s',(x.allocation_id,)).fetchall():
                if x.status=='delivered': c.execute('UPDATE batch SET quantity=quantity-%s,reserved=reserved-%s WHERE id=%s',(l['quantity'],l['quantity'],l['batch_id']))
                else: c.execute('UPDATE batch SET reserved=reserved-%s WHERE id=%s',(l['quantity'],l['batch_id']))
            c.execute("UPDATE allocation SET status=%s WHERE id=%s",('delivered' if x.status=='delivered' else 'cancelled',x.allocation_id))
        audit(c,x.status,'delivery',d['id'],'Delivery state updated'); return {'delivery_id':d['id'],'status':x.status}

@app.get('/api/audit')
def audit_rows(): return rows('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100')
