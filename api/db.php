<?php
// api/db.php - Central database connection and helper routines
$_SERVER['REQUEST_METHOD'] = $_SERVER['REQUEST_METHOD'] ?? 'GET';

function getDB(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $host = '127.0.0.1';
        $db   = 'annsetu';
        $user = 'root';
        $pass = ''; // Default XAMPP password is empty
        $port = '3306';
        $charset = 'utf8mb4';

        $dsn = "mysql:host=$host;dbname=$db;port=$port;charset=$charset";
        $options = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
            PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci",
        ];
        try {
            $pdo = new PDO($dsn, $user, $pass, $options);
            $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
        } catch (PDOException $e) {
            jsonError("Database connection failed. Make sure MySQL in XAMPP is running and 'annsetu' database is imported. Details: " . $e->getMessage(), 500);
        }
    }
    return $pdo;
}

function cors(): void {
    if (!headers_sent()) {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function jsonOut(mixed $data, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function cleanErrorMessage(string $msg): string {
    // Strip SQLSTATE error codes and trigger SIGNAL error prefixes
    if (preg_match('/SQLSTATE\[45000\]:.*?1644\s+(.*)/s', $msg, $matches)) {
        return trim($matches[1]);
    }
    if (preg_match('/SQLSTATE\[.*?\]:\s*(.*)/s', $msg, $matches)) {
        return trim($matches[1]);
    }
    return $msg;
}

function jsonError(string $msg, int $status = 400): never {
    jsonOut(['error' => cleanErrorMessage($msg)], $status);
}

function getJsonBody(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}
