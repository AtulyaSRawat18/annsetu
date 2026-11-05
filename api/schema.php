<?php
// api/schema.php
require_once __DIR__ . '/db.php';
cors();

$pdo = getDB();

try {
    $tablesList = ['category', 'supplier', 'warehouse', 'product', 'batch', 'ngo', 'food_request', 'distribution', 'stock_movement', 'audit_log'];
    $viewsList = ['v_batch_status', 'v_request_progress', 'v_ngo_impact'];
    $triggersList = ['trg_batch_in', 'trg_check_stock', 'trg_reduce_stock', 'trg_no_expired_donation', 'trg_after_distribution', 'trg_audit_ngo'];

    $tableData = [];
    $ddl = [];

    // Table schemas and ER data
    foreach ($tablesList as $tbl) {
        $colStmt = $pdo->prepare("SELECT COLUMN_NAME as name, COLUMN_TYPE as type, COLUMN_KEY as col_key 
                                  FROM INFORMATION_SCHEMA.COLUMNS 
                                  WHERE TABLE_SCHEMA = 'annsetu' AND TABLE_NAME = ? 
                                  ORDER BY ORDINAL_POSITION");
        $colStmt->execute([$tbl]);
        $cols = [];
        foreach ($colStmt->fetchAll() as $c) {
            $cols[] = [
                'name' => $c['name'],
                'type' => $c['type'],
                'pk'   => ($c['col_key'] === 'PRI') ? 1 : 0
            ];
        }

        $fkStmt = $pdo->prepare("SELECT COLUMN_NAME as `from`, REFERENCED_TABLE_NAME as `table`, REFERENCED_COLUMN_NAME as `to`
                                 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
                                 WHERE TABLE_SCHEMA = 'annsetu' AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL");
        $fkStmt->execute([$tbl]);
        $fks = $fkStmt->fetchAll();

        $tableData[$tbl] = [
            'cols' => $cols,
            'fks'  => $fks
        ];

        // DDL
        try {
            $createStmt = $pdo->query("SHOW CREATE TABLE `$tbl`");
            $res = $createStmt->fetch(PDO::FETCH_NUM);
            if (!empty($res[1])) {
                $ddl[] = [
                    'type' => 'table',
                    'name' => $tbl,
                    'sql'  => $res[1]
                ];
            }
        } catch (Exception $e) {}
    }

    // Views DDL
    foreach ($viewsList as $vw) {
        try {
            $viewStmt = $pdo->query("SHOW CREATE VIEW `$vw`");
            $res = $viewStmt->fetch(PDO::FETCH_NUM);
            if (!empty($res[1])) {
                $ddl[] = [
                    'type' => 'view',
                    'name' => $vw,
                    'sql'  => $res[1]
                ];
            }
        } catch (Exception $e) {}
    }

    // Triggers DDL
    foreach ($triggersList as $trg) {
        try {
            $trgStmt = $pdo->query("SHOW CREATE TRIGGER `$trg`");
            $res = $trgStmt->fetch();
            if (!empty($res['SQL Original Statement'])) {
                $ddl[] = [
                    'type' => 'trigger',
                    'name' => $trg,
                    'sql'  => $res['SQL Original Statement']
                ];
            }
        } catch (Exception $e) {}
    }

    // Indexes
    $idxStmt = $pdo->query("SELECT DISTINCT INDEX_NAME, TABLE_NAME 
                           FROM INFORMATION_SCHEMA.STATISTICS 
                           WHERE TABLE_SCHEMA = 'annsetu' AND INDEX_NAME NOT IN ('PRIMARY')");
    $indexes = $idxStmt->fetchAll();
    foreach ($indexes as $idx) {
        $ddl[] = [
            'type' => 'index',
            'name' => $idx['INDEX_NAME'],
            'sql'  => "CREATE INDEX `{$idx['INDEX_NAME']}` ON `{$idx['TABLE_NAME']}` (...);"
        ];
    }

    $counts = [
        'table'   => count($tablesList),
        'view'    => count($viewsList),
        'trigger' => count($triggersList),
        'index'   => count($indexes)
    ];

    jsonOut([
        'counts' => $counts,
        'tables' => $tableData,
        'ddl'    => $ddl
    ]);
} catch (PDOException $e) {
    jsonError($e->getMessage());
}

