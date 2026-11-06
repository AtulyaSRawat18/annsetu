"""AnnSetu API backed by PostgreSQL. Local development only; no login flow."""
import os, math, csv, io, json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
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
def db(): return psycopg.connect(DSN,row_factory=dict_row,connect_timeout=10,application_name='annsetu-api',prepare_threshold=None)
def rows(sql,args=()):
    with db() as c: return c.execute(sql,args).fetchall()
def one(sql,args=()):
    with db() as c: return c.execute(sql,args).fetchone()
def audit(c,action,entity,eid,details): c.execute('INSERT INTO audit_log(action,entity,entity_id,details) VALUES (%s,%s,%s,%s)',(action,entity,eid,Jsonb({'details':details})))

class BatchIn(BaseModel): product_id:int; lot_code:str; quantity:float=Field(gt=0); expiry_date:date
class SaleIn(BaseModel): product_id:int; quantity:float=Field(gt=0); sold_on:date=date.today()
class ProposalIn(BaseModel): demand_id:int; batch_id:int; quantity:float=Field(gt=0)
class DeliveryIn(BaseModel): allocation_id:int; status:str
class SimulationIn(BaseModel):
    demand_kg:float=Field(default=20,gt=0,le=500)
    sale_events:int=Field(default=16,ge=4,le=64)
    allocation_attempts:int=Field(default=8,ge=2,le=32)
    recipient_id:Optional[int]=None
class SimulatedDemandIn(BaseModel):
    recipient_id:int
    category_id:int
    quantity:float=Field(gt=0,le=500)

@app.get('/')
def index(): return FileResponse(ROOT/'frontend'/'index.html')
@app.get('/data/templates/sales.csv')
def sales_template(): return FileResponse(ROOT/'data'/'templates'/'sales.csv',media_type='text/csv',filename='sales.csv')
@app.get('/api/health')
def health():
    try: r=one('select current_database() db, version() version'); return {'status':'ok','database':r['db'],'engine':'PostgreSQL','version':r['version'].split()[1]}
    except Exception as e: raise HTTPException(503,str(e))

@app.get('/api/map/config')
def map_config():
    return {
      'tile_url':os.getenv('MAP_TILE_URL','https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
      'attribution':os.getenv('MAP_ATTRIBUTION','© OpenStreetMap contributors'),
    }

@app.get('/api/map')
def map_data():
    stores=rows("""SELECT s.id,s.name,s.city,s.latitude,s.longitude,
      coalesce(sum(b.quantity-b.reserved) FILTER(WHERE b.expiry_date>=current_date),0) available_kg
      FROM store s LEFT JOIN product p ON p.store_id=s.id LEFT JOIN batch b ON b.product_id=p.id
      GROUP BY s.id ORDER BY s.name""")
    recipients=rows("SELECT id,name,city,latitude,longitude,capacity_kg,cold_storage FROM recipient_site ORDER BY name")
    categories=rows("""SELECT c.id,c.name,c.storage,coalesce((SELECT p.unit FROM product p WHERE p.category_id=c.id ORDER BY (p.unit='kg') DESC,p.id LIMIT 1),'kg') unit
      FROM category c ORDER BY c.name""")
    demands=rows("""SELECT d.id,d.quantity,d.unit,d.status,d.needed_until,d.simulation_run_id,
      r.id recipient_id,r.name recipient,r.latitude,r.longitude,c.name category
      FROM demand d JOIN recipient_site r ON r.id=d.recipient_id JOIN category c ON c.id=d.category_id
      WHERE d.status IN ('open','partially_fulfilled') ORDER BY d.needed_until""")
    return {'stores':stores,'recipients':recipients,'categories':categories,'demands':demands}

@app.post('/api/map/simulated-demand',status_code=201)
def simulated_demand(x:SimulatedDemandIn):
    with db() as c:
        recipient=c.execute('SELECT id FROM recipient_site WHERE id=%s',(x.recipient_id,)).fetchone()
        category=c.execute('SELECT id FROM category WHERE id=%s',(x.category_id,)).fetchone()
        if not recipient or not category: raise HTTPException(404,'Recipient or category not found')
        d=c.execute("""INSERT INTO demand(recipient_id,category_id,quantity,unit,needed_from,needed_until,status,declared)
          SELECT %s,%s,%s,CASE WHEN EXISTS(SELECT 1 FROM product p WHERE p.category_id=%s AND p.unit='kg') THEN 'kg' ELSE 'unit' END,
            now(),now()+interval '1 day','open',false RETURNING id,quantity,unit,needed_until""",(x.recipient_id,x.category_id,x.quantity,x.category_id)).fetchone()
        audit(c,'simulated','demand',d['id'],f"Map demand signal · {x.quantity} {d['unit']}")
        return {'demand_id':d['id'],'recipient_id':x.recipient_id,'category_id':x.category_id,'quantity':d['quantity'],'unit':d['unit'],'needed_until':d['needed_until'],'synthetic':True}
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
        committed=c.execute("""SELECT coalesce(sum(l.quantity),0) quantity FROM allocation_line l JOIN allocation a ON a.id=l.allocation_id
          WHERE a.demand_id=%s AND a.status IN ('proposed','approved','delivered')""",(x.demand_id,)).fetchone()['quantity']
        if not b or not d or b['category_id']!=d['category_id'] or b['unit']!='kg' or b['expiry_date']<date.today() or x.quantity>b['available'] or x.quantity>d['quantity']-committed: raise HTTPException(409,'Infeasible proposal; refresh inventory and demand')
        c.execute('UPDATE batch SET reserved=reserved+%s WHERE id=%s',(x.quantity,x.batch_id))
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
            if not b or b['quantity']<l['quantity'] or b['reserved']<l['quantity'] or b['expiry_date']<date.today(): raise HTTPException(409,'Stock reservation changed or expired')
        c.execute("UPDATE allocation SET status='approved' WHERE id=%s",(aid,)); audit(c,'approved','allocation',aid,'Stock reserved'); return {'status':'approved'}

@app.post('/api/allocations/{allocation_id}/cancel')
def cancel_allocation(allocation_id:int):
    with db() as c:
        allocation=c.execute("SELECT id FROM allocation WHERE id=%s AND status='proposed' FOR UPDATE",(allocation_id,)).fetchone()
        if not allocation: raise HTTPException(409,'Only a proposed allocation can be cancelled')
        for line in c.execute('SELECT batch_id,quantity FROM allocation_line WHERE allocation_id=%s',(allocation_id,)).fetchall():
            c.execute('UPDATE batch SET reserved=reserved-%s WHERE id=%s AND reserved>=%s',(line['quantity'],line['batch_id'],line['quantity']))
        c.execute("UPDATE allocation SET status='cancelled' WHERE id=%s",(allocation_id,))
        audit(c,'cancelled','allocation',allocation_id,'Reservation released')
        return {'allocation_id':allocation_id,'status':'cancelled'}

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

def _forecast_records(c, simulation_run_id=None):
    generated=[]
    for p in c.execute('SELECT id,sku,name,unit_price,store_id FROM product ORDER BY id').fetchall():
        history=c.execute('SELECT sold_on,sum(quantity) quantity FROM sales_observation WHERE product_id=%s AND sold_on>=current_date-28 GROUP BY sold_on ORDER BY sold_on',(p['id'],)).fetchall()
        daily={x['sold_on']:float(x['quantity']) for x in history}
        series=[daily.get(date.today()-timedelta(days=i),0.0) for i in range(28,0,-1)]
        horizon=[]
        for step in range(1,8):
            target=date.today()+timedelta(days=step)
            feat={'sku':p['sku'],'unit_price':float(p['unit_price']),'promo':0,'holiday_flag':0,'weekday':target.weekday(),'month':target.month,'lag_1':series[-1],'lag_7':series[-7],'lag_28':series[-28],'rolling_7':sum(series[-7:])/7}
            estimate=max(0,float(MODEL.predict(pd.DataFrame([[feat[k] for k in FEATURES]],columns=FEATURES))[0]))
            series.append(estimate); horizon.append(estimate)
            if step in (1,3,7):
                total=sum(horizon)
                run=c.execute("""INSERT INTO forecast_run(model_name,model_version,data_cutoff_at,horizon_days,dataset_kind,simulation_run_id)
                  VALUES ('Random Forest','synthetic-rf-1',now(),%s,'synthetic',%s) RETURNING id""",(step,simulation_run_id)).fetchone()
                c.execute('INSERT INTO forecast_value(run_id,store_id,product_id,target_date,predicted_quantity) VALUES (%s,%s,%s,%s,%s)',(run['id'],p['store_id'],p['id'],target,total))
                generated.append({'sku':p['sku'],'horizon_days':step,'forecast_demand':round(total,1)})
    return generated

@app.post('/api/simulations',status_code=201)
def start_simulation(x:SimulationIn):
    """Create a tagged synthetic workload and schedule live transactional events."""
    now_utc=datetime.now(timezone.utc)
    with db() as c:
        products=c.execute("""SELECT p.id,p.sku,p.name,p.unit,p.category_id,p.store_id,p.unit_price
          FROM product p JOIN store s ON s.id=p.store_id
          WHERE p.unit='kg' ORDER BY CASE WHEN p.name ILIKE '%tomato%' THEN 0 ELSE 1 END,p.id""").fetchall()
        recipients=c.execute('SELECT id,organization_id,name FROM recipient_site WHERE (%s::bigint IS NULL OR id=%s) ORDER BY id LIMIT 1',(x.recipient_id,x.recipient_id)).fetchone()
        if not products or not recipients: raise HTTPException(409,'Seed at least one kg product and recipient site before running a simulation')
        product=products[0]
        product_rows=c.execute('SELECT id,sku FROM product WHERE store_id=%s ORDER BY id',(product['store_id'],)).fetchall()
        store=c.execute('SELECT id,organization_id,latitude,longitude FROM store WHERE id=%s',(product['store_id'],)).fetchone()
        recipient=c.execute('SELECT latitude,longitude,capacity_kg FROM recipient_site WHERE id=%s',(recipients['id'],)).fetchone()
        logistics=c.execute("SELECT id FROM organization WHERE kind='logistics' ORDER BY id LIMIT 1").fetchone()
        run=c.execute("""INSERT INTO simulation_run(scenario,status,config,started_at)
          VALUES ('live-surplus-demand','running',%s,now()) RETURNING id,created_at""",
          (Jsonb({'demand_kg':x.demand_kg,'sale_events':x.sale_events,'allocation_attempts':x.allocation_attempts,'recipient_id':recipients['id'],'product_id':product['id'],'store_id':store['id']}),)).fetchone()
        run_id=run['id']
        batch=c.execute("""INSERT INTO batch(product_id,lot_code,received_on,expiry_date,quantity,reserved,source,simulation_run_id)
          VALUES (%s,%s,current_date,current_date+2,%s,0,'synthetic',%s) RETURNING id""",(product['id'],f'SIM-{run_id}',x.demand_kg,run_id)).fetchone()
        demand=c.execute("""INSERT INTO demand(recipient_id,category_id,quantity,unit,needed_from,needed_until,status,declared,simulation_run_id)
          VALUES (%s,%s,%s,'kg',now(),now()+interval '1 day','open',false,%s) RETURNING id""",(recipients['id'],product['category_id'],x.demand_kg,run_id)).fetchone()
        vehicle_org=logistics['id'] if logistics else recipients['organization_id']
        vehicle=c.execute("""INSERT INTO vehicle(organization_id,name,capacity_kg,available,cold_storage,cost_per_km,simulation_run_id)
          VALUES (%s,%s,100,true,true,12,%s) RETURNING id""",(vehicle_org,f'Simulation van {run_id}',run_id)).fetchone()
        km=0.0
        if None not in (store['latitude'],store['longitude'],recipient['latitude'],recipient['longitude']):
            la1,lo1,la2,lo2=map(math.radians,(float(store['latitude']),float(store['longitude']),float(recipient['latitude']),float(recipient['longitude'])))
            km=6371*2*math.asin(math.sqrt(math.sin((la2-la1)/2)**2+math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2))
        route=c.execute("""INSERT INTO route(vehicle_id,status,planned_at,total_km,estimated_cost,simulation_run_id)
          VALUES (%s,'planned',now(),%s,%s,%s) RETURNING id""",(vehicle['id'],round(km,2),round(km*12,2),run_id)).fetchone()
        c.execute("""INSERT INTO inventory_snapshot(store_id,product_id,observed_at,quantity,source,simulation_run_id)
          VALUES (%s,%s,now(),%s,'synthetic',%s)""",(store['id'],product['id'],x.demand_kg,run_id))
        c.execute('UPDATE simulation_run SET config=config || %s WHERE id=%s',(Jsonb({'batch_id':batch['id'],'demand_id':demand['id'],'vehicle_id':vehicle['id'],'route_id':route['id'],'recipient_name':recipients['name'],'product_name':product['name'],'store_id':store['id']}),run_id))
        seq=0
        first_due=now_utc+timedelta(seconds=0.5)
        for i in range(x.sale_events):
            sale_product=product_rows[i%len(product_rows)]
            sold_on=date.today()-timedelta(days=(i%28)+1)
            qty=round(2.0+(i%7)*0.7,3)
            due=first_due+timedelta(seconds=i*0.14)
            c.execute("""INSERT INTO simulation_event(run_id,sequence_no,event_type,scheduled_at,payload)
              VALUES (%s,%s,'sale',%s,%s)""",(run_id,seq,due,Jsonb({'product_id':sale_product['id'],'sku':sale_product['sku'],'sold_on':sold_on.isoformat(),'quantity':qty,'source_row_key':f'sim:{run_id}:{sale_product["sku"]}:{sold_on.isoformat()}:{i}'})))
            seq+=1
        forecast_due=first_due+timedelta(seconds=x.sale_events*0.14+0.4)
        forecast_event=c.execute("""INSERT INTO simulation_event(run_id,sequence_no,event_type,scheduled_at,payload)
          VALUES (%s,%s,'forecast',%s,%s) RETURNING id""",(run_id,seq,forecast_due,Jsonb({'model':'synthetic-rf-1'}))).fetchone()
        seq+=1
        allocation_due=forecast_due+timedelta(seconds=0.6)
        allocation_events=[]
        request_kg=min(5.0,x.demand_kg)
        for i in range(x.allocation_attempts):
            e=c.execute("""INSERT INTO simulation_event(run_id,sequence_no,event_type,scheduled_at,payload)
              VALUES (%s,%s,'allocate',%s,%s) RETURNING id""",(run_id,seq,allocation_due,Jsonb({'demand_id':demand['id'],'batch_id':batch['id'],'requested_kg':request_kg,'attempt':i+1}))).fetchone()
            allocation_events.append(e['id']); seq+=1
        c.execute("""INSERT INTO simulation_event(run_id,sequence_no,event_type,scheduled_at,payload)
          VALUES (%s,%s,'route_depart',%s,%s)""",(run_id,seq,allocation_due+timedelta(seconds=1),Jsonb({'route_id':route['id']})))
        seq+=1
        for allocation_event_id in allocation_events:
            c.execute("""INSERT INTO simulation_event(run_id,sequence_no,event_type,scheduled_at,payload)
              VALUES (%s,%s,'dispatch',%s,%s)""",(run_id,seq,allocation_due+timedelta(seconds=2),Jsonb({'allocation_event_id':allocation_event_id,'route_id':route['id']})))
            seq+=1
        audit(c,'started','simulation',run_id,f'{x.sale_events} sales, {x.allocation_attempts} concurrent allocations')
        return {'run_id':run_id,'scenario':'live-surplus-demand','status':'running','scheduled_events':seq,'workers':4,
          'demand_id':demand['id'],'batch_id':batch['id'],'allocation_attempts':x.allocation_attempts,'sale_events':x.sale_events}

def _apply_simulation_event(c,event):
    payload=event['payload'] or {}
    run_id=event['run_id']
    if event['event_type']=='sale':
        sale=c.execute("""INSERT INTO sales_observation(product_id,sold_on,quantity,source,source_row_key,simulation_run_id)
          VALUES (%s,%s,%s,'synthetic',%s,%s) ON CONFLICT(source_row_key) DO NOTHING RETURNING id""",
          (payload['product_id'],date.fromisoformat(payload['sold_on']),payload['quantity'],payload['source_row_key'],run_id)).fetchone()
        return {'inserted':bool(sale),'sku':payload['sku'],'quantity':payload['quantity']}
    if event['event_type']=='forecast':
        forecast_rows=_forecast_records(c,run_id)
        return {'model':'Random Forest','forecast_rows':len(forecast_rows),'forecasts':forecast_rows}
    if event['event_type']=='allocate':
        demand=c.execute('SELECT quantity,category_id FROM demand WHERE id=%s FOR UPDATE',(payload['demand_id'],)).fetchone()
        batch=c.execute("""SELECT b.quantity,b.reserved,b.expiry_date,p.category_id,p.unit
          FROM batch b JOIN product p ON p.id=b.product_id WHERE b.id=%s FOR UPDATE OF b""",(payload['batch_id'],)).fetchone()
        if not demand or not batch: return {'allocated_kg':0,'reason':'Demand or batch was removed'}
        allocated=c.execute("""SELECT coalesce(sum(l.quantity),0) amount FROM allocation_line l JOIN allocation a ON a.id=l.allocation_id
          WHERE a.demand_id=%s AND a.status IN ('approved','delivered')""",(payload['demand_id'],)).fetchone()['amount']
        remaining=float(demand['quantity']-allocated)
        available=float(batch['quantity']-batch['reserved'])
        amount=min(float(payload['requested_kg']),remaining,available)
        if amount<=0 or batch['category_id']!=demand['category_id'] or batch['unit']!='kg' or batch['expiry_date']<date.today():
            return {'allocated_kg':0,'reason':'Demand or safe stock limit reached'}
        c.execute('UPDATE batch SET reserved=reserved+%s WHERE id=%s',(amount,payload['batch_id']))
        allocation=c.execute("""INSERT INTO allocation(demand_id,status,created_at,estimated_km,transport_cost,handling_cost,simulation_run_id)
          VALUES (%s,'approved',now(),0,0,%s,%s) RETURNING id""",(payload['demand_id'],amount*2,run_id)).fetchone()
        c.execute('INSERT INTO allocation_line(allocation_id,batch_id,quantity) VALUES (%s,%s,%s)',(allocation['id'],payload['batch_id'],amount))
        audit(c,'allocated','allocation',allocation['id'],f'Simulation concurrency attempt {payload["attempt"]}')
        return {'allocation_id':allocation['id'],'allocated_kg':round(amount,3),'attempt':payload['attempt']}
    if event['event_type']=='route_depart':
        c.execute("UPDATE route SET status='active' WHERE id=%s AND status='planned'",(payload['route_id'],))
        return {'route_id':payload['route_id'],'status':'active'}
    if event['event_type']=='dispatch':
        linked=c.execute('SELECT result FROM simulation_event WHERE id=%s AND run_id=%s',(payload['allocation_event_id'],run_id)).fetchone()
        allocation_id=(linked['result'] or {}).get('allocation_id') if linked else None
        if not allocation_id: return {'skipped':True,'reason':'Allocation attempt could not secure stock'}
        allocation=c.execute("SELECT * FROM allocation WHERE id=%s AND status='approved' FOR UPDATE",(allocation_id,)).fetchone()
        if not allocation: return {'skipped':True,'reason':'Allocation is no longer dispatchable'}
        lines=c.execute('SELECT * FROM allocation_line WHERE allocation_id=%s',(allocation_id,)).fetchall()
        total=0.0
        for line in lines:
            locked=c.execute('SELECT quantity,reserved FROM batch WHERE id=%s FOR UPDATE',(line['batch_id'],)).fetchone()
            amount=float(line['quantity']); total+=amount
            if not locked or float(locked['reserved'])<amount or float(locked['quantity'])<amount:
                raise ValueError('Reserved batch changed before dispatch')
            c.execute('UPDATE batch SET quantity=quantity-%s,reserved=reserved-%s WHERE id=%s',(amount,amount,line['batch_id']))
        c.execute("UPDATE allocation SET status='delivered' WHERE id=%s",(allocation_id,))
        delivery=c.execute("""INSERT INTO delivery(allocation_id,route_id,status,pickup_at,delivered_at,confirmation_at,simulation_run_id)
          VALUES (%s,%s,'delivered',now(),now(),now(),%s) RETURNING id""",(allocation_id,payload['route_id'],run_id)).fetchone()
        km=c.execute('SELECT total_km FROM route WHERE id=%s',(payload['route_id'],)).fetchone()['total_km'] or 0
        cost=float(km)*12
        c.execute("""INSERT INTO economic_record(delivery_id,procurement_savings,avoided_disposal_cost,transport_cost,
          handling_storage_cost,platform_cost,retailer_recovery_revenue,assumptions_version,simulation_run_id)
          VALUES (%s,%s,%s,%s,%s,0,0,'simulation-v1',%s)""",(delivery['id'],total*50,total*8,cost,total*2,run_id))
        demand_id=allocation['demand_id']
        delivered=c.execute("""SELECT coalesce(sum(l.quantity),0) amount FROM allocation_line l JOIN allocation a ON a.id=l.allocation_id
          WHERE a.demand_id=%s AND a.status='delivered'""",(demand_id,)).fetchone()['amount']
        needed=c.execute('SELECT quantity FROM demand WHERE id=%s',(demand_id,)).fetchone()['quantity']
        c.execute('UPDATE demand SET status=%s WHERE id=%s',('fulfilled' if delivered>=needed else 'partially_fulfilled',demand_id))
        audit(c,'delivered','delivery',delivery['id'],f'Simulation · {total:.1f} kg')
        return {'delivery_id':delivery['id'],'allocation_id':allocation_id,'delivered_kg':round(total,3),'status':'delivered'}
    raise ValueError('Unsupported simulation event')

def _process_simulation_event(run_id):
    with db() as c:
        event=c.execute("""SELECT * FROM simulation_event WHERE run_id=%s AND status='queued' AND scheduled_at<=now()
          ORDER BY scheduled_at,sequence_no FOR UPDATE SKIP LOCKED LIMIT 1""",(run_id,)).fetchone()
        if not event: return None
        c.execute('UPDATE simulation_event SET started_at=now() WHERE id=%s',(event['id'],))
        try:
            with c.transaction():
                result=_apply_simulation_event(c,event)
            status='skipped' if result.get('skipped') else 'completed'
            error=None
        except Exception as exc:
            result={}; status='failed'; error=str(exc)[:500]
        c.execute('UPDATE simulation_event SET status=%s,result=%s,error=%s,completed_at=now() WHERE id=%s',
          (status,Jsonb(result),error,event['id']))
        c.execute("""UPDATE simulation_run SET status='running',started_at=coalesce(started_at,now())
          WHERE id=%s AND status='queued'""",(run_id,))
        pending=c.execute("SELECT count(*) n FROM simulation_event WHERE run_id=%s AND status='queued'",(run_id,)).fetchone()['n']
        if pending==0:
            failures=c.execute("SELECT count(*) n FROM simulation_event WHERE run_id=%s AND status='failed'",(run_id,)).fetchone()['n']
            c.execute('UPDATE simulation_run SET status=%s,completed_at=now() WHERE id=%s',('failed' if failures else 'completed',run_id))
            run=c.execute('SELECT config FROM simulation_run WHERE id=%s',(run_id,)).fetchone()
            route_id=(run['config'] or {}).get('route_id')
            if route_id:
                deliveries=c.execute('SELECT count(*) n FROM delivery WHERE simulation_run_id=%s',(run_id,)).fetchone()['n']
                c.execute('UPDATE route SET status=%s WHERE id=%s',('completed' if deliveries else 'cancelled',route_id))
        return {'event_id':event['id'],'event_type':event['event_type'],'status':status,'result':result,'error':error}

def _simulation_detail(c,run_id):
    run=c.execute('SELECT * FROM simulation_run WHERE id=%s',(run_id,)).fetchone()
    if not run: return None
    events=c.execute('SELECT id,sequence_no,event_type,scheduled_at,status,payload,result,error,started_at,completed_at FROM simulation_event WHERE run_id=%s ORDER BY sequence_no',(run_id,)).fetchall()
    stats=c.execute("""SELECT count(*) total,count(*) FILTER(WHERE status='completed') completed,
      count(*) FILTER(WHERE status='failed') failed,count(*) FILTER(WHERE status='skipped') skipped,
      count(*) FILTER(WHERE event_type='allocate') allocation_attempts,
      count(*) FILTER(WHERE event_type='allocate' AND coalesce((result->>'allocated_kg')::numeric,0)>0) allocations_won,
      coalesce(sum((result->>'allocated_kg')::numeric) FILTER(WHERE event_type='allocate'),0) allocated_kg,
      coalesce(sum((result->>'delivered_kg')::numeric) FILTER(WHERE event_type='dispatch'),0) delivered_kg,
      count(*) FILTER(WHERE event_type='forecast' AND status='completed') forecasts
      FROM simulation_event WHERE run_id=%s""",(run_id,)).fetchone()
    return {'run':run,'events':events,'metrics':stats}

def _finalize_simulation(c,run_id):
    """Serialize the final queue check after a concurrent worker batch drains."""
    run=c.execute('SELECT status,config FROM simulation_run WHERE id=%s FOR UPDATE',(run_id,)).fetchone()
    if not run or run['status'] not in ('queued','running'):
        return
    pending=c.execute("SELECT count(*) n FROM simulation_event WHERE run_id=%s AND status='queued'",(run_id,)).fetchone()['n']
    if pending:
        return
    failures=c.execute("SELECT count(*) n FROM simulation_event WHERE run_id=%s AND status='failed'",(run_id,)).fetchone()['n']
    deliveries=c.execute('SELECT count(*) n FROM delivery WHERE simulation_run_id=%s',(run_id,)).fetchone()['n']
    metrics=c.execute("""SELECT count(*) FILTER(WHERE event_type='allocate' AND coalesce((result->>'allocated_kg')::numeric,0)>0) wins,
      coalesce(sum((result->>'delivered_kg')::numeric) FILTER(WHERE event_type='dispatch'),0) delivered_kg
      FROM simulation_event WHERE run_id=%s""",(run_id,)).fetchone()
    final_status='failed' if failures else 'completed'
    c.execute('UPDATE simulation_run SET status=%s,completed_at=now(),summary=%s WHERE id=%s',
      (final_status,Jsonb({'allocation_wins':metrics['wins'],'delivered_kg':float(metrics['delivered_kg'])}),run_id))
    route_id=(run['config'] or {}).get('route_id')
    if route_id:
        c.execute('UPDATE route SET status=%s WHERE id=%s',('completed' if deliveries else 'cancelled',route_id))

@app.get('/api/simulations')
def latest_simulation():
    run=one('SELECT id FROM simulation_run ORDER BY id DESC LIMIT 1')
    if not run: return {'simulation':None}
    with db() as c: return {'simulation':_simulation_detail(c,run['id'])}

@app.get('/api/simulations/{run_id}')
def simulation_detail(run_id:int):
    with db() as c:
        result=_simulation_detail(c,run_id)
        if not result: raise HTTPException(404,'Simulation not found')
        return result

@app.post('/api/simulations/{run_id}/tick')
def tick_simulation(run_id:int,workers:int=4):
    if workers<1 or workers>8: raise HTTPException(400,'workers must be between 1 and 8')
    if not one('SELECT id FROM simulation_run WHERE id=%s',(run_id,)): raise HTTPException(404,'Simulation not found')
    with ThreadPoolExecutor(max_workers=workers) as pool:
        processed=[x for x in pool.map(lambda _: _process_simulation_event(run_id),range(workers)) if x]
    with db() as c:
        _finalize_simulation(c,run_id)
        return {'processed':processed,'simulation':_simulation_detail(c,run_id)}

@app.post('/api/simulations/{run_id}/cancel')
def cancel_simulation(run_id:int):
    with db() as c:
        run=c.execute('SELECT status FROM simulation_run WHERE id=%s FOR UPDATE',(run_id,)).fetchone()
        if not run: raise HTTPException(404,'Simulation not found')
        if run['status'] in ('completed','failed','cancelled'): return {'status':run['status']}
        c.execute("UPDATE simulation_event SET status='cancelled',completed_at=now() WHERE run_id=%s AND status='queued'",(run_id,))
        c.execute("UPDATE simulation_run SET status='cancelled',completed_at=now() WHERE id=%s",(run_id,))
        return {'status':'cancelled'}

@app.delete('/api/simulations/{run_id}')
def delete_simulation(run_id:int):
    """Remove only tagged records created by a finished synthetic run."""
    with db() as c:
        run=c.execute('SELECT status FROM simulation_run WHERE id=%s FOR UPDATE',(run_id,)).fetchone()
        if not run: raise HTTPException(404,'Simulation not found')
        if run['status'] in ('queued','running'): raise HTTPException(409,'Stop or finish the simulation before clearing it')
        for table in ('economic_record','delivery','allocation_line','allocation','route','vehicle','forecast_value','forecast_run','sales_observation','inventory_snapshot','demand','batch'):
            if table=='allocation_line':
                c.execute('DELETE FROM allocation_line WHERE allocation_id IN (SELECT id FROM allocation WHERE simulation_run_id=%s)',(run_id,))
            elif table=='forecast_value':
                c.execute('DELETE FROM forecast_value WHERE run_id IN (SELECT id FROM forecast_run WHERE simulation_run_id=%s)',(run_id,))
            else:
                c.execute(f'DELETE FROM {table} WHERE simulation_run_id=%s',(run_id,))
        c.execute('DELETE FROM simulation_run WHERE id=%s',(run_id,))
        return {'deleted':True,'run_id':run_id}

@app.get('/api/audit')
def audit_rows(): return rows('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100')
