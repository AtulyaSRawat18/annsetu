"""Generate labelled synthetic grocery sales and evaluate an ML baseline/model."""
import csv, json, math, random
from datetime import date, timedelta
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
import joblib

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'/'synthetic'; DATA.mkdir(parents=True,exist_ok=True)
PRODUCTS=[('PRD-101','Tomatoes','Produce','kg',20,35),('PRD-102','Milk 1L','Dairy','litre',14,58),('PRD-103','Bread loaves','Bakery','loaf',11,32),('PRD-104','Rice 5kg','Grains','bag',4,280)]
END=date.today(); START=END-timedelta(days=729); rng=random.Random(271828)
rows=[]; day=START
while day<=END:
    for sku,name,category,unit,base,price in PRODUCTS:
        seasonal=1+0.14*math.sin(2*math.pi*day.timetuple().tm_yday/365.25)
        weekend=1.22 if day.weekday()>=5 else 1.0
        promo=1 if rng.random()<0.09 else 0
        holiday=1 if day.month in (10,11,12) and day.day in (1,15,25) else 0
        qty=max(0,round(base*seasonal*weekend*(1+0.3*promo+0.22*holiday)+rng.gauss(0,max(1,base*.13))))
        stock=max(0,round(base*3.2+base*.35*math.sin(day.toordinal()/9)+rng.gauss(0,base*.2)))
        rows.append({'record_type':'SYNTHETIC','store_id':'STORE-DEMO-01','date':day.isoformat(),'sku':sku,'product':name,'category':category,'unit':unit,'unit_price':price,'promo':promo,'holiday_flag':holiday,'weekday':day.weekday(),'units_sold':qty,'stock_snapshot':stock})
    day+=timedelta(days=1)
path=DATA/'sales_history_daily.csv'
with path.open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=rows[0].keys());w.writeheader();w.writerows(rows)

df=pd.DataFrame(rows); df['date']=pd.to_datetime(df.date); df=df.sort_values(['sku','date'])
for lag in (1,7,28): df[f'lag_{lag}']=df.groupby('sku').units_sold.shift(lag)
df['rolling_7']=df.groupby('sku').units_sold.transform(lambda s:s.shift(1).rolling(7,min_periods=7).mean())
df['month']=df.date.dt.month; df['weekday']=df.date.dt.weekday
df=df.dropna().reset_index(drop=True)
cutoff=df.date.max()-pd.Timedelta(days=29); train=df[df.date<cutoff]; test=df[df.date>=cutoff]
features=['sku','unit_price','promo','holiday_flag','weekday','month','lag_1','lag_7','lag_28','rolling_7']
prep=ColumnTransformer([('sku',OneHotEncoder(handle_unknown='ignore'),['sku'])],remainder='passthrough')
model=make_pipeline(prep,RandomForestRegressor(n_estimators=180,min_samples_leaf=2,max_features=.9,random_state=271828,n_jobs=-1))
model.fit(train[features],train.units_sold); pred=np.maximum(0,model.predict(test[features]))
naive=np.maximum(0,test.lag_7.to_numpy()); actual=test.units_sold.to_numpy()
def metrics(y,p): return {'mae':round(float(mean_absolute_error(y,p)),3),'wape_pct':round(float(np.abs(y-p).sum()/max(1,y.sum())*100),2)}
result={'dataset':'synthetic','seed':271828,'date_start':str(df.date.min().date()),'date_end':str(df.date.max().date()),'rows':int(len(df)),'sku_count':int(df.sku.nunique()),'train_rows':int(len(train)),'test_rows':int(len(test)),'split':'chronological: final 30 days held out','target':'daily units sold','features':features,'baseline_lag_7':metrics(actual,naive),'random_forest':metrics(actual,pred),'limitations':'Entire dataset is deterministic synthetic data; these scores do not represent retail performance.'}
(ROOT/'ml'/'evaluation_metrics.json').write_text(json.dumps(result,indent=2))
joblib.dump(model,ROOT/'ml'/'synthetic_sales_random_forest.joblib')
print(json.dumps(result,indent=2))
