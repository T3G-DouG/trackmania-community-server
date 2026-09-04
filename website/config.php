<?php
// config.php -- Zentrale Konfiguration der Website.
// Secrets kommen aus einer zentralen secrets.env ausserhalb des Webroots
// (siehe SETUP.md), niemals hier im Webroot hardcoden.

function ladeSecrets(string $pfad): array {
    if (!file_exists($pfad)) {
        throw new RuntimeException("Secrets-Datei nicht gefunden: $pfad");
    }
    $werte = [];
    foreach (file($pfad, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $zeile) {
        $zeile = trim($zeile);
        if ($zeile === '' || $zeile[0] === '#') continue;
        $pos = strpos($zeile, '=');
        if ($pos === false) continue;
        $werte[trim(substr($zeile, 0, $pos))] = trim(substr($zeile, $pos + 1));
    }
    return $werte;
}

$secrets = ladeSecrets(getenv('TRACKMANIA_SECRETS_PATH') ?: 'C:/LAN/trackma2020/secrets.env');

// MONGO_DB erlaubt Umschalten auf eine Test-DB waehrend der Entwicklung --
// im Live-Betrieb ueblicherweise "nextcontrol".
$mongoDatabase = getenv('MONGO_DB') ?: 'nextcontrol';

// MONGO_HOST erlaubt den Betrieb gegen einen externen/containerisierten Mongo-
// Dienst (z.B. Docker-Compose-Service "mongo") -- Default bleibt 'localhost'.
$mongoHost = getenv('MONGO_HOST') ?: 'localhost';

return [
    'mongodb' => [
        'uri' => 'mongodb://' . $mongoHost . ':27017',
        'database' => $mongoDatabase,
    ],
    'telegram' => [
        'bot_token' => $secrets['TELEGRAM_TOKEN'] ?? '',
        'chat_id' => $secrets['TELEGRAM_CHAT_ID'] ?? '',
    ],
    // Admin-Dashboard: eigenes Passwort, NICHT das SuperAdmin-Passwort des
    // Spielservers. Erwartet einen password_hash()-Wert (nie Klartext) in secrets.env,
    // z.B. erzeugt per: php -r "echo password_hash('...', PASSWORD_DEFAULT);"
    'admin' => [
        'passwort_hash' => $secrets['ADMIN_DASHBOARD_PASSWORT_HASH'] ?? '',
    ],
];
