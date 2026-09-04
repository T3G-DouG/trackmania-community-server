<?php
// adminAuth.php -- Session-/Brute-Force-Hilfsfunktionen fuer das Admin-Dashboard.
// Eigenes Passwort (config.php: admin.passwort_hash, aus secrets.env
// ADMIN_DASHBOARD_PASSWORT_HASH) -- explizit NICHT das SuperAdmin-Passwort des
// Spielservers. Die Website ist typischerweise oeffentlich erreichbar, daher hier
// bewusst eine eigene, moeglichst simple Brute-Force-Bremse (Collection
// adminLoginVersuche, Key = Client-IP).

const ADMIN_MAX_VERSUCHE = 5;
const ADMIN_SPERR_MINUTEN = 15;

/** Startet die PHP-Session mit sicheren Cookie-Parametern -- idempotent aufrufbar. */
function starteAdminSession(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => !empty($_SERVER['HTTPS']), // lokal ohne TLS (Dev-Server) sonst kein Cookie
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_start();
}

function istAdminEingeloggt(): bool {
    return !empty($_SESSION['admin_eingeloggt']);
}

/** Liefert (und erzeugt bei Bedarf) das CSRF-Token der aktuellen Session. */
function adminCsrfToken(): string {
    if (empty($_SESSION['admin_csrf'])) {
        $_SESSION['admin_csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['admin_csrf'];
}

function pruefeAdminCsrf(?string $eingereicht): bool {
    return is_string($eingereicht) && !empty($_SESSION['admin_csrf']) && hash_equals($_SESSION['admin_csrf'], $eingereicht);
}

/** Erzwingt eine gueltige Admin-Session -- sonst HTTP 401 + JSON-Fehler, Skriptende. */
function erzwingeAdminSession(): void {
    starteAdminSession();
    if (!istAdminEingeloggt()) {
        http_response_code(401);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'Nicht angemeldet.']);
        exit;
    }
}

// -- Brute-Force-Bremse (Collection adminLoginVersuche, Key = Client-IP) -----------

function adminClientIp(): string {
    return $_SERVER['REMOTE_ADDR'] ?? 'unbekannt';
}

/** @return array{gesperrt: bool, verbleibendeMinuten: int} */
function adminLoginGesperrt(MongoDB\Driver\Manager $manager, string $db): array {
    $query = new MongoDB\Driver\Query(['_id' => adminClientIp()]);
    $cursor = $manager->executeQuery("$db.adminLoginVersuche", $query);
    $cursor->setTypeMap(['root' => 'array', 'document' => 'array']);
    $docs = $cursor->toArray();
    if (empty($docs) || empty($docs[0]['gesperrtBis'])) {
        return ['gesperrt' => false, 'verbleibendeMinuten' => 0];
    }

    $gesperrtBis = $docs[0]['gesperrtBis']->toDateTime();
    $jetzt = new DateTime('now', new DateTimeZone('UTC'));
    if ($gesperrtBis <= $jetzt) return ['gesperrt' => false, 'verbleibendeMinuten' => 0];

    $verbleibend = (int) ceil(($gesperrtBis->getTimestamp() - $jetzt->getTimestamp()) / 60);
    return ['gesperrt' => true, 'verbleibendeMinuten' => max(1, $verbleibend)];
}

function adminLoginFehlversuchZaehlen(MongoDB\Driver\Manager $manager, string $db): void {
    $ip = adminClientIp();
    $query = new MongoDB\Driver\Query(['_id' => $ip]);
    $cursor = $manager->executeQuery("$db.adminLoginVersuche", $query);
    $cursor->setTypeMap(['root' => 'array', 'document' => 'array']);
    $docs = $cursor->toArray();
    $neu = ($docs[0]['versuche'] ?? 0) + 1;

    $update = ['versuche' => $neu, 'letzterVersuch' => new MongoDB\BSON\UTCDateTime()];
    if ($neu >= ADMIN_MAX_VERSUCHE) {
        $update['gesperrtBis'] = new MongoDB\BSON\UTCDateTime((time() + ADMIN_SPERR_MINUTEN * 60) * 1000);
    }

    $bulk = new MongoDB\Driver\BulkWrite();
    $bulk->update(['_id' => $ip], ['$set' => $update], ['upsert' => true]);
    $manager->executeBulkWrite("$db.adminLoginVersuche", $bulk);
}

function adminLoginErfolgReset(MongoDB\Driver\Manager $manager, string $db): void {
    $bulk = new MongoDB\Driver\BulkWrite();
    $bulk->delete(['_id' => adminClientIp()]);
    $manager->executeBulkWrite("$db.adminLoginVersuche", $bulk);
}
