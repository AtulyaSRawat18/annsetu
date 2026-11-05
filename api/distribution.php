<?php
// api/distribution.php
require_once __DIR__ . '/db.php';
cors();

$pdo = getDB();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $action = $_GET['action'] ?? 'requests';

    try {
        if ($action === 'requests') {
            $filter = $_GET['filter'] ?? 'open';
            $sql = "SELECT * FROM v_request_progress";
            if ($filter === 'open') {
                $sql .= " WHERE status IN ('Pending','Partially Fulfilled')";
            }
            $sql .= " ORDER BY CASE WHEN status IN ('Pending','Partially Fulfilled') THEN 0 ELSE 1 END, days_to_deadline";
            $stmt = $pdo->query($sql);
            jsonOut($stmt->fetchAll());
        }

        if ($action === 'fefo') {
            $reqId = (int)($_GET['request_id'] ?? 0);
            $reqStmt = $pdo->prepare("SELECT * FROM v_request_progress WHERE request_id = ?");
            $reqStmt->execute([$reqId]);
            $request = $reqStmt->fetch();

            if (!$request) jsonError("Request not found", 404);

            $fefoSql = "WITH candidates AS (
              SELECT b.batch_id, b.batch_code, p.name AS product, w.name AS warehouse,
                     b.expiry_date, b.qty_available,
                     DATEDIFF(b.expiry_date, CURDATE()) AS days_left,
                     SUM(b.qty_available) OVER (ORDER BY b.expiry_date, b.batch_id) AS running_total
              FROM batch b
              JOIN product   p ON p.product_id   = b.product_id
              JOIN warehouse w ON w.warehouse_id = b.warehouse_id
              WHERE p.category_id = :cat
                AND b.qty_available > 0
                AND b.expiry_date >= CURDATE()
            )
            SELECT batch_id, batch_code, product, warehouse, expiry_date, days_left, qty_available,
                   LEAST(qty_available, :need1 - (running_total - qty_available)) AS allocate
            FROM candidates
            WHERE running_total - qty_available < :need2
            ORDER BY expiry_date, batch_id";

            $stmt = $pdo->prepare($fefoSql);
            $stmt->execute([
                ':cat'   => (int)$request['category_id'],
                ':need1' => (float)$request['qty_remaining'],
                ':need2' => (float)$request['qty_remaining']
            ]);
            $plan = $stmt->fetchAll();

            jsonOut([
                'request' => $request,
                'plan'    => $plan
            ]);
        }

        if ($action === 'history') {
            $sql = "SELECT d.distribution_id, d.distributed_on, n.name AS ngo, p.name AS product,
                           b.batch_code, d.qty, p.unit, d.request_id, d.volunteer
                    FROM distribution d
                    JOIN batch   b ON b.batch_id   = d.batch_id
                    JOIN product p ON p.product_id = b.product_id
                    JOIN ngo     n ON n.ngo_id     = d.ngo_id
                    ORDER BY d.distributed_on DESC, d.distribution_id DESC LIMIT 25";
            $stmt = $pdo->query($sql);
            jsonOut($stmt->fetchAll());
        }

        if ($action === 'new_request_meta') {
            $ngos = $pdo->query("SELECT ngo_id, name FROM ngo ORDER BY name")->fetchAll();
            $cats = $pdo->query("SELECT category_id, name FROM category ORDER BY name")->fetchAll();
            $dateStmt = $pdo->query("SELECT CURDATE() + INTERVAL 2 DAY AS d");
            $defaultDate = $dateStmt->fetchColumn();

            jsonOut([
                'ngos' => $ngos,
                'categories' => $cats,
                'default_date' => $defaultDate
            ]);
        }

        jsonError("Unknown GET action: $action");
    } catch (PDOException $e) {
        jsonError($e->getMessage());
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = getJsonBody();
    $action = $data['action'] ?? '';

    try {
        if ($action === 'new_request') {
            $ngoId = (int)($data['ngo_id'] ?? 0);
            $catId = (int)($data['category_id'] ?? 0);
            $qty   = (float)($data['qty'] ?? 0);
            $neededBy = $data['needed_by'] ?? '';

            if (!$ngoId || !$catId || $qty <= 0 || !$neededBy) {
                jsonError("All fields are required and quantity must be greater than 0");
            }

            $stmt = $pdo->prepare("INSERT INTO food_request(ngo_id, category_id, qty_needed, needed_by) VALUES (?, ?, ?, ?)");
            $stmt->execute([$ngoId, $catId, $qty, $neededBy]);
            $id = $pdo->lastInsertId();

            jsonOut(['success' => true, 'request_id' => $id]);
        }

        if ($action === 'dispatch') {
            $reqId = (int)($data['request_id'] ?? 0);
            $volunteer = trim($data['volunteer'] ?? 'Auto-FEFO');

            if (!$reqId) jsonError("Invalid request ID");

            $stmt = $pdo->prepare("CALL sp_fefo_dispatch(?, ?)");
            $stmt->execute([$reqId, $volunteer]);
            $updated = $stmt->fetch();
            $stmt->closeCursor();

            jsonOut(['success' => true, 'updated' => $updated]);
        }

        if ($action === 'cancel') {
            $reqId = (int)($data['request_id'] ?? 0);
            if (!$reqId) jsonError("Invalid request ID");

            $stmt = $pdo->prepare("UPDATE food_request SET status = 'Cancelled' WHERE request_id = ?");
            $stmt->execute([$reqId]);

            jsonOut(['success' => true]);
        }

        jsonError("Unknown POST action: $action");
    } catch (PDOException $e) {
        jsonError($e->getMessage());
    }
}

