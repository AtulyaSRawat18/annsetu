<?php
// api/reports.php
require_once __DIR__ . '/db.php';
cors();

$pdo = getDB();

$REPORTS = [
    [
        'sql' => "SELECT w.name AS warehouse, p.name AS product, b.batch_code, b.qty_available, b.expiry_date,
                         DATEDIFF(b.expiry_date, CURDATE()) AS days_left
                  FROM batch b
                  JOIN product   p ON p.product_id   = b.product_id
                  JOIN warehouse w ON w.warehouse_id = b.warehouse_id
                  WHERE b.qty_available > 0
                    AND b.expiry_date BETWEEN CURDATE() AND (CURDATE() + INTERVAL 7 DAY)
                  ORDER BY w.name, b.expiry_date"
    ],
    [
        'sql' => "SELECT category, COUNT(*) AS batches,
                         ROUND(SUM(qty_available), 1) AS qty_at_risk,
                         ROUND(SUM(qty_available * unit_price)) AS value_at_risk_inr
                  FROM v_batch_status
                  WHERE status IN ('Critical','Near Expiry')
                  GROUP BY category
                  HAVING SUM(qty_available) > 0
                  ORDER BY value_at_risk_inr DESC"
    ],
    [
        'sql' => "SELECT c.name AS category,
                         SUM(CASE WHEN m.movement_type = 'IN'       THEN m.qty ELSE 0 END) AS received,
                         SUM(CASE WHEN m.movement_type = 'DONATION' THEN m.qty ELSE 0 END) AS donated,
                         SUM(CASE WHEN m.movement_type = 'WASTE'    THEN m.qty ELSE 0 END) AS wasted,
                         ROUND(100.0 * SUM(CASE WHEN m.movement_type = 'WASTE' THEN m.qty ELSE 0 END)
                               / SUM(CASE WHEN m.movement_type = 'IN' THEN m.qty ELSE 0 END), 1) AS waste_pct
                  FROM stock_movement m
                  JOIN batch    b ON b.batch_id    = m.batch_id
                  JOIN product  p ON p.product_id  = b.product_id
                  JOIN category c ON c.category_id = p.category_id
                  GROUP BY c.name
                  ORDER BY waste_pct DESC"
    ],
    [
        'sql' => "SELECT RANK() OVER (ORDER BY IFNULL(SUM(d.qty),0) DESC) AS `rank`,
                         n.name, n.beneficiaries,
                         IFNULL(SUM(d.qty),0) AS kg_received,
                         FLOOR(IFNULL(SUM(d.qty),0) / 0.4) AS meals,
                         ROUND(IFNULL(SUM(d.qty),0) / n.beneficiaries, 2) AS kg_per_person
                  FROM ngo n
                  LEFT JOIN distribution d ON d.ngo_id = n.ngo_id
                  GROUP BY n.ngo_id, n.name, n.beneficiaries
                  ORDER BY `rank`"
    ],
    [
        'sql' => "SELECT p.name AS product, c.name AS category,
                         (SELECT IFNULL(SUM(qty_available),0) FROM batch WHERE product_id = p.product_id) AS in_stock
                  FROM product p
                  JOIN category c ON c.category_id = p.category_id
                  WHERE NOT EXISTS (
                    SELECT 1 FROM distribution d
                    JOIN batch b ON b.batch_id = d.batch_id
                    WHERE b.product_id = p.product_id
                  )
                  ORDER BY in_stock DESC"
    ],
    [
        'sql' => "SELECT w.name, w.capacity_kg,
                         ROUND(IFNULL(SUM(b.qty_available),0)) AS stock_kg,
                         ROUND(100.0 * IFNULL(SUM(b.qty_available),0) / w.capacity_kg, 1) AS utilisation_pct,
                         COUNT(b.batch_id) AS batches
                  FROM warehouse w
                  LEFT JOIN batch b ON b.warehouse_id = w.warehouse_id AND b.qty_available > 0
                  GROUP BY w.warehouse_id, w.name, w.capacity_kg
                  ORDER BY utilisation_pct DESC"
    ],
    [
        'sql' => "SELECT s.name AS supplier, COUNT(*) AS batches,
                         ROUND(AVG(DATEDIFF(b.expiry_date, b.received_on)), 1) AS avg_days_left_on_arrival,
                         SUM(CASE WHEN b.expiry_date < CURDATE() AND b.qty_available > 0 THEN 1 ELSE 0 END) AS expired_batches
                  FROM batch b
                  JOIN supplier s ON s.supplier_id = b.supplier_id
                  GROUP BY s.supplier_id, s.name
                  ORDER BY avg_days_left_on_arrival"
    ],
    [
        'sql' => "SELECT request_id, ngo, category, qty_needed, qty_fulfilled, qty_remaining,
                         needed_by, days_to_deadline, status
                  FROM v_request_progress
                  WHERE status IN ('Pending','Partially Fulfilled')
                    AND days_to_deadline <= 1
                  ORDER BY days_to_deadline"
    ],
    [
        'sql' => "SELECT p.name AS product, b.batch_code, b.expiry_date, b.qty_available,
                         SUM(b.qty_available) OVER (PARTITION BY p.product_id ORDER BY b.expiry_date) AS cumulative_qty,
                         ROW_NUMBER() OVER (PARTITION BY p.product_id ORDER BY b.expiry_date) AS pick_order
                  FROM batch b
                  JOIN product p ON p.product_id = b.product_id
                  WHERE b.qty_available > 0 AND b.expiry_date >= CURDATE()
                  ORDER BY p.name, pick_order"
    ],
    [
        'sql' => "SELECT name, kg_received, meals_served
                  FROM v_ngo_impact
                  WHERE kg_received > (SELECT AVG(kg_received) FROM v_ngo_impact)
                  ORDER BY kg_received DESC"
    ]
];

$id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
if ($id < 0 || $id >= count($REPORTS)) {
    jsonError("Invalid report index");
}

$sql = $REPORTS[$id]['sql'];

try {
    $t0 = microtime(true);
    $stmt = $pdo->query($sql);
    $rows = $stmt->fetchAll(PDO::FETCH_NUM);
    $colCount = $stmt->columnCount();
    $columns = [];
    for ($i = 0; $i < $colCount; $i++) {
        $meta = $stmt->getColumnMeta($i);
        $columns[] = $meta['name'] ?? ("col_" . $i);
    }
    $ms = round((microtime(true) - $t0) * 1000, 1);

    jsonOut([
        'sql' => $sql,
        'columns' => $columns,
        'values' => $rows,
        'ms' => $ms
    ]);
} catch (PDOException $e) {
    jsonError($e->getMessage());
}

