INSERT INTO organization(name,kind,synthetic) VALUES
 ('Green Basket Market','retailer',true),('Seva Community Kitchen','recipient',true),('City Food Runners','logistics',true)
ON CONFLICT DO NOTHING;
INSERT INTO store(organization_id,name,city,latitude,longitude)
SELECT id,'Green Basket – Central','Pune',18.5204,73.8567 FROM organization WHERE name='Green Basket Market'
ON CONFLICT DO NOTHING;
INSERT INTO recipient_site(organization_id,name,city,latitude,longitude,capacity_kg,cold_storage,verified_at)
SELECT id,'Seva Community Kitchen','Pune',18.5314,73.8446,70,true,now() FROM organization WHERE name='Seva Community Kitchen'
ON CONFLICT DO NOTHING;
INSERT INTO category(name,storage) VALUES ('Produce','chilled'),('Dairy','chilled'),('Bakery','ambient'),('Grains','ambient') ON CONFLICT(name) DO NOTHING;
INSERT INTO product(store_id,sku,name,category_id,unit,unit_mass_kg,unit_price,safety_stock)
SELECT s.id,v.sku,v.name,c.id,v.unit,v.mass,v.price,v.safety FROM (VALUES
 ('PRD-101','Tomatoes','Produce','kg',1::numeric,35::numeric,4::numeric),
 ('PRD-102','Milk 1L','Dairy','litre',1::numeric,58::numeric,6::numeric),
 ('PRD-103','Bread loaves','Bakery','loaf',0.4::numeric,32::numeric,5::numeric),
 ('PRD-104','Rice 5kg','Grains','bag',5::numeric,280::numeric,3::numeric)
) AS v(sku,name,category,unit,mass,price,safety) JOIN store s ON s.name='Green Basket – Central' JOIN category c ON c.name=v.category
ON CONFLICT(store_id,sku) DO NOTHING;
INSERT INTO batch(product_id,lot_code,received_on,expiry_date,quantity,reserved,source)
SELECT p.id,v.lot,current_date,v.expiry,v.qty,0,'synthetic' FROM (VALUES
 ('PRD-101','TOM-2401',current_date+3,46::numeric),('PRD-101','TOM-2402',current_date+8,38::numeric),
 ('PRD-102','MIL-1601',current_date+2,24::numeric),('PRD-103','BRD-0901',current_date+1,18::numeric),
 ('PRD-104','RIC-0101',current_date+120,65::numeric)
) v(sku,lot,expiry,qty) JOIN product p ON p.sku=v.sku ON CONFLICT(product_id,lot_code) DO NOTHING;
INSERT INTO sales_observation(product_id,sold_on,quantity,source,source_row_key)
SELECT p.id,current_date-g.i, greatest(0,v.base+((g.i*7+p.id)%7)-3),'synthetic',p.sku||':'||(current_date-g.i)::text
FROM product p JOIN (VALUES ('PRD-101',18),('PRD-102',12),('PRD-103',10),('PRD-104',3)) v(sku,base) ON p.sku=v.sku
CROSS JOIN generate_series(1,28) g(i) ON CONFLICT(source_row_key) DO NOTHING;
INSERT INTO demand(recipient_id,category_id,quantity,unit,needed_from,needed_until,status,declared)
SELECT r.id,c.id,v.qty,'kg',now(),now()+interval '1 day','open',true FROM (VALUES ('Produce',25::numeric),('Dairy',20::numeric),('Bakery',15::numeric)) v(cat,qty)
JOIN recipient_site r ON r.name='Seva Community Kitchen' JOIN category c ON c.name=v.cat
WHERE NOT EXISTS(SELECT 1 FROM demand d WHERE d.recipient_id=r.id AND d.category_id=c.id AND d.status='open');
