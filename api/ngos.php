<?php
// api/ngos.php
require_once __DIR__ . '/db.php';
cors();

$pdo = getDB();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $sql = "SELECT i.*, RANK() OVER (ORDER BY i.meals_served DESC) AS rnk,
                       (SELECT COUNT(*) FROM food_request r WHERE r.ngo_id = i.ngo_id AND r.status IN ('Pending','Partially Fulfilled')) AS open_req
                FROM v_ngo_impact i ORDER BY rnk";
        $stmt = $pdo->query($sql);
        jsonOut($stmt->fetchAll());
    } catch (PDOException $e) {
        jsonError($e->getMessage());
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = getJsonBody();
    $action = $data['action'] ?? 'register';

    try {
        if ($action === 'register') {
            $name = trim($data['name'] ?? '');
            $reg  = trim($data['reg'] ?? '');
            $cp   = trim($data['cp'] ?? '');
            $ph   = trim($data['ph'] ?? '');
            $city = trim($data['city'] ?? '');
            $ben  = (int)($data['ben'] ?? 0);

            if (!$name || !$reg || !$cp || !$ph || !$city || $ben <= 0) {
                jsonError("All fields are required and beneficiaries must be greater than 0");
            }

            $stmt = $pdo->prepare("INSERT INTO ngo(name, registration_no, contact_person, phone, city, beneficiaries) VALUES (?, ?, ?, ?, ?, ?)");
            $stmt->execute([$name, $reg, $cp, $ph, $city, $ben]);
            $id = $pdo->lastInsertId();

            jsonOut(['success' => true, 'ngo_id' => $id]);
        }

        jsonError("Unknown action: $action");
    } catch (PDOException $e) {
        jsonError($e->getMessage());
    }
}

