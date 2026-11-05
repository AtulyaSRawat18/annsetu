<?php
// api/audit.php
require_once __DIR__ . '/db.php';
cors();

$pdo = getDB();

try {
    $logsStmt = $pdo->query("SELECT * FROM audit_log ORDER BY log_id DESC LIMIT 60");
    $logs = $logsStmt->fetchAll();

    $mvStmt = $pdo->query("SELECT m.movement_id, m.moved_on, m.movement_type, b.batch_code, p.name AS product, m.qty, m.note
                           FROM stock_movement m
                           JOIN batch b USING(batch_id)
                           JOIN product p USING(product_id)
                           ORDER BY m.movement_id DESC LIMIT 40");
    $ledger = $mvStmt->fetchAll();

    jsonOut([
        'logs' => $logs,
        'ledger' => $ledger
    ]);
} catch (PDOException $e) {
    jsonError($e->getMessage());
}

