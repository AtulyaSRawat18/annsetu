<?php
// api/inventory.php
require_once __DIR__ . '/db.php';
cors();

$pdo = getDB();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        if (!empty($_GET['categories'])) {
            $stmt = $pdo->query("SELECT category_id, name FROM category ORDER BY name");
            jsonOut($stmt->fetchAll());
        }

        if (!empty($_GET['counts'])) {
            $stmt = $pdo->query("SELECT status, COUNT(*) AS n FROM v_batch_status GROUP BY status");
            jsonOut($stmt->fetchAll());
        }

        if (!empty($_GET['meta'])) {
            $prods = $pdo->query("SELECT p.product_id, p.name, c.name AS cat, c.alert_days FROM product p JOIN category c USING(category_id) ORDER BY p.name")->fetchAll();
            $sups = $pdo->query("SELECT supplier_id, name FROM supplier ORDER BY name")->fetchAll();
            $whs = $pdo->query("SELECT warehouse_id, name FROM warehouse ORDER BY name")->fetchAll();
            $next = $pdo->query("SELECT CONCAT('B-', COALESCE(MAX(CAST(SUBSTRING(batch_code, 3) AS UNSIGNED)), 1000) + 1) AS c, CURDATE() AS today, (CURDATE() + INTERVAL 7 DAY) AS exp FROM batch")->fetch() ?: [];
            jsonOut([
                'products' => $prods,
                'suppliers' => $sups,
                'warehouses' => $whs,
                'next' => $next
            ]);
        }

        if (!empty($_GET['batch_id'])) {
            $stmt = $pdo->prepare("SELECT * FROM v_batch_status WHERE batch_id = ?");
            $stmt->execute([(int)$_GET['batch_id']]);
            $batch = $stmt->fetch();
            if (!$batch) jsonError("Batch not found", 404);

            $ngos = $pdo->query("SELECT ngo_id, name FROM ngo ORDER BY name")->fetchAll();
            $reqsStmt = $pdo->prepare("SELECT request_id, qty_remaining, ngo_id FROM v_request_progress WHERE category_id = ? AND status IN ('Pending','Partially Fulfilled')");
            $reqsStmt->execute([$batch['category_id']]);
            $reqs = $reqsStmt->fetchAll();

            jsonOut([
                'batch' => $batch,
                'ngos' => $ngos,
                'requests' => $reqs
            ]);
        }

        // Query batches with filters
        $status = $_GET['status'] ?? 'All';
        $cat = !empty($_GET['cat']) ? (int)$_GET['cat'] : null;
        $q = trim($_GET['q'] ?? '');

        $sql = "SELECT * FROM v_batch_status";
        $where = [];
        $params = [];

        if ($status !== 'All') {
            $where[] = "status = ?";
            $params[] = $status;
        }
        if ($cat) {
            $where[] = "category_id = ?";
            $params[] = $cat;
        }
        if ($q !== '') {
            $where[] = "(product LIKE ? OR batch_code LIKE ?)";
            $params[] = "%$q%";
            $params[] = "%$q%";
        }

        if ($where) {
            $sql .= " WHERE " . implode(" AND ", $where);
        }
        $sql .= " ORDER BY expiry_date, batch_id";

        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $batches = $stmt->fetchAll();

        // Also fetch status counts for the chips
        $counts = $pdo->query("SELECT status, COUNT(*) AS n FROM v_batch_status GROUP BY status")->fetchAll();

        jsonOut([
            'batches' => $batches,
            'counts' => $counts
        ]);
    } catch (PDOException $e) {
        jsonError($e->getMessage());
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = getJsonBody();
    $action = $data['action'] ?? '';

    try {
        if ($action === 'add_batch') {
            $code = trim($data['code'] ?? '');
            $prod = (int)($data['prod'] ?? 0);
            $sup  = (int)($data['sup'] ?? 0);
            $wh   = (int)($data['wh'] ?? 0);
            $qty  = (float)($data['qty'] ?? 0);
            $mfg  = $data['mfg'] ?? '';
            $exp  = $data['exp'] ?? '';

            if (!$code || !$prod || !$sup || !$wh || $qty <= 0 || !$mfg || !$exp) {
                jsonError("All fields are required and quantity must be greater than 0");
            }

            $stmt = $pdo->prepare("INSERT INTO batch(batch_code, product_id, supplier_id, warehouse_id, mfg_date, expiry_date, qty_received, qty_available) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->execute([$code, $prod, $sup, $wh, $mfg, $exp, $qty, $qty]);
            jsonOut(['success' => true, 'batch_id' => $pdo->lastInsertId()]);
        }

        if ($action === 'movement') {
            $batchId = (int)($data['batch_id'] ?? 0);
            $type = $data['type'] ?? 'ISSUE';
            $qty = (float)($data['qty'] ?? 0);
            $note = trim($data['note'] ?? '');

            if (!$batchId || $qty <= 0) {
                jsonError("Invalid batch or quantity");
            }

            $stmt = $pdo->prepare("INSERT INTO stock_movement(batch_id, movement_type, qty, note) VALUES (?, ?, ?, ?)");
            $stmt->execute([$batchId, $type, $qty, $note]);
            jsonOut(['success' => true]);
        }

        if ($action === 'donate') {
            $batchId = (int)($data['batch_id'] ?? 0);
            $ngoId = (int)($data['ngo_id'] ?? 0);
            $reqId = !empty($data['request_id']) ? (int)$data['request_id'] : null;
            $qty = (float)($data['qty'] ?? 0);
            $vol = trim($data['volunteer'] ?? 'Volunteer');

            if (!$batchId || !$ngoId || $qty <= 0) {
                jsonError("Invalid donation details");
            }

            $stmt = $pdo->prepare("INSERT INTO distribution(batch_id, ngo_id, request_id, qty, volunteer) VALUES (?, ?, ?, ?, ?)");
            $stmt->execute([$batchId, $ngoId, $reqId, $qty, $vol]);
            jsonOut(['success' => true]);
        }

        if ($action === 'discard_all') {
            $stmt = $pdo->query("CALL sp_discard_expired()");
            $res = $stmt->fetch() ?: [];
            $discarded = $res['batches_discarded'] ?? 0;
            // Free results from call
            $stmt->closeCursor();
            jsonOut(['success' => true, 'batches_discarded' => $discarded]);
        }

        if ($action === 'reqs_for_ngo_cat') {
            $ngoId = (int)($data['ngo_id'] ?? 0);
            $catId = (int)($data['category_id'] ?? 0);
            $stmt = $pdo->prepare("SELECT request_id, qty_remaining FROM v_request_progress WHERE ngo_id = ? AND category_id = ? AND status IN ('Pending','Partially Fulfilled')");
            $stmt->execute([$ngoId, $catId]);
            jsonOut($stmt->fetchAll());
        }

        jsonError("Unknown action: $action");
    } catch (PDOException $e) {
        jsonError($e->getMessage());
    }
}

