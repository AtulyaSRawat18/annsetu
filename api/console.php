<?php
// api/console.php
require_once __DIR__ . '/db.php';
cors();

$pdo = getDB();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = getJsonBody();
    $sql = trim($data['sql'] ?? '');

    if (!$sql) {
        jsonError("SQL statement cannot be empty");
    }

    try {
        $t0 = microtime(true);
        $firstWord = strtoupper(strtok($sql, " \t\n\r"));

        $isSelect = in_array($firstWord, ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);

        if ($isSelect) {
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
                'columns' => $columns,
                'values'  => $rows,
                'ms'      => $ms
            ]);
        } else {
            $affected = $pdo->exec($sql);
            $ms = round((microtime(true) - $t0) * 1000, 1);
            jsonOut([
                'affected' => $affected !== false ? $affected : 0,
                'ms'       => $ms
            ]);
        }
    } catch (PDOException $e) {
        jsonError($e->getMessage());
    }
} else {
    // Return tables list for console quick chips
    try {
        $stmt = $pdo->query("SELECT TABLE_NAME as name, TABLE_TYPE as type 
                             FROM INFORMATION_SCHEMA.TABLES 
                             WHERE TABLE_SCHEMA = 'annsetu' 
                             ORDER BY TABLE_TYPE, TABLE_NAME");
        jsonOut($stmt->fetchAll());
    } catch (PDOException $e) {
        jsonError($e->getMessage());
    }
}

