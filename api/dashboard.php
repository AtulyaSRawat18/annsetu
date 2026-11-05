<?php
// api/dashboard.php
require_once __DIR__ . '/db.php';
cors();

$pdo = getDB();

try {
    $kpisStmt = $pdo->query("SELECT
      (SELECT ROUND(SUM(qty_available)) FROM v_batch_status WHERE status NOT IN ('Expired','Depleted')) AS usable_kg,
      (SELECT COUNT(*) FROM v_batch_status WHERE status IN ('Critical','Near Expiry')) AS at_risk,
      (SELECT ROUND(SUM(qty_available * unit_price)) FROM v_batch_status WHERE status IN ('Critical','Near Expiry')) AS value_at_risk,
      (SELECT IFNULL(SUM(qty),0) FROM distribution) AS donated,
      (SELECT IFNULL(SUM(meals_served),0) FROM v_ngo_impact) AS meals,
      (SELECT IFNULL(SUM(qty),0) FROM stock_movement WHERE movement_type = 'WASTE') AS wasted,
      (SELECT COUNT(*) FROM food_request WHERE status IN ('Pending','Partially Fulfilled')) AS open_req");
    $kpis = $kpisStmt->fetch() ?: [];

    $statusStmt = $pdo->query("SELECT status, COUNT(*) AS batches, ROUND(SUM(qty_available)) AS qty
      FROM v_batch_status WHERE status <> 'Depleted'
      GROUP BY status ORDER BY CASE status WHEN 'Expired' THEN 1 WHEN 'Critical' THEN 2 WHEN 'Near Expiry' THEN 3 ELSE 4 END");
    $byStatus = $statusStmt->fetchAll();

    $trendStmt = $pdo->query("WITH RECURSIVE days(d) AS (
        SELECT CURDATE() - INTERVAL 13 DAY
        UNION ALL SELECT d + INTERVAL 1 DAY FROM days WHERE d < CURDATE()
      )
      SELECT d,
        IFNULL((SELECT SUM(qty) FROM distribution WHERE distributed_on = d),0) AS donated,
        IFNULL((SELECT SUM(qty) FROM stock_movement WHERE movement_type='WASTE' AND moved_on = d),0) AS wasted
      FROM days");
    $trend = $trendStmt->fetchAll();

    $alertsStmt = $pdo->query("SELECT batch_id, batch_code, product, warehouse, category, qty_available, unit, days_left, status
      FROM v_batch_status
      WHERE status IN ('Critical','Near Expiry','Expired')
      ORDER BY days_left LIMIT 7");
    $alerts = $alertsStmt->fetchAll();

    $reqsStmt = $pdo->query("SELECT request_id, ngo, category, qty_remaining, days_to_deadline, status
      FROM v_request_progress WHERE status IN ('Pending','Partially Fulfilled')
      ORDER BY days_to_deadline LIMIT 5");
    $openReqs = $reqsStmt->fetchAll();

    jsonOut([
        'kpis' => $kpis,
        'byStatus' => $byStatus,
        'trend' => $trend,
        'alerts' => $alerts,
        'open_requests' => $openReqs
    ]);
} catch (PDOException $e) {
    jsonError($e->getMessage());
}
