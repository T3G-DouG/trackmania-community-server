<?php
// admin-api.php -- Authentifizierte API des Admin-Dashboards (AP16). Bewusst getrennt
// von api.php: die öffentliche, unauthentifizierte API bleibt frei von Auth-Logik.
//
// Aktionen: ?action=lesen (GET, Session-Pflicht)
//           ?action=schreiben (POST, JSON-Body {bereich, werte, csrf}, Session+CSRF-Pflicht)
//           ?action=analyseTrigger (POST, JSON-Body {csrf}, Session+CSRF-Pflicht, AP16b) --
//               stößt den manuellen Analyse-Lauf über adminKommandos an (Website → Controller,
//               siehe docs/ADMIN-DASHBOARD-PLAN.md "Neues Richtungsmuster").
//           ?action=serverBefehl (POST, JSON-Body {befehl, parameter, csrf}, Session+CSRF-Pflicht,
//               AP16c) -- fuehrt einen der bisherigen /admin-Chatbefehle (skip/restart/extend/
//               jukeboxClear/modeSave/modeRead/modeReset/mapTmx/mapEntfernen/shutdown) über
//               denselben adminKommandos-Mechanismus aus (siehe controller/plugins/serverSteuerung.js).
//           ?action=telegramVerknuepfungen (GET, Session-Pflicht, AP16c) -- listet alle
//               bestehenden Spieler<->Telegram-Verknuepfungen (Collection telegramLinks).
//               Bewusst NICHT ueber die oeffentliche api.php: Telegram-Username/-User-ID sind
//               personenbezogen, anders als System-Status/Log.
//           ?action=telegramLoesen (POST, JSON-Body {id, csrf}, Session+CSRF-Pflicht, AP16c) --
//               loescht eine Verknuepfung direkt aus der DB (kein Controller-Umweg noetig,
//               telegramLinks wird vom Controller bei jeder Aktion frisch gelesen, kein Cache).
//
// Schreibt/liest ausschließlich die Collections systemSettings (Singleton _id:"aktuell"),
// die der Controller alle 30s pollt (siehe controller/lib/laufzeitEinstellungen.js), sowie
// -- nur lesend bzw. für den Trigger -- kiAnalysen/adminKommandos. Wertebereiche werden hier
// serverseitig geklemmt (einstellungenGrenzen.php) -- das Dashboard kann Kostendeckel/
// Mindestabstände nur INNERHALB der Code-Grenzen ändern, nie darüber hinaus.
//
// System-/Hardwareauslastung (CPU/RAM/Platte) und das Ereignis-Log (serverEvents) sind bereits
// über die öffentliche, unauthentifizierte api.php (action=live, action=serverLog) verfügbar --
// dieselben Daten stehen ohnehin schon auf index.html öffentlich. Das Dashboard fragt dafür
// bewusst DIREKT api.php ab statt einer Dopplung hier.

require_once __DIR__ . '/lib/adminAuth.php';
require_once __DIR__ . '/lib/einstellungenGrenzen.php';

erzwingeAdminSession();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$config = require __DIR__ . '/config.php';

try {
    $manager = new MongoDB\Driver\Manager($config['mongodb']['uri']);
    $db = $config['mongodb']['database'];

    function leseSystemSettingsRoh(MongoDB\Driver\Manager $manager, string $db): ?array {
        $query = new MongoDB\Driver\Query(['_id' => 'aktuell']);
        $cursor = $manager->executeQuery("$db.systemSettings", $query);
        $cursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);
        $docs = $cursor->toArray();
        return $docs[0] ?? null;
    }

    /** Neuester kiAnalysen-Lauf (nur die fürs Dashboard relevanten Felder), oder null. */
    function leseLetztenAnalyseLauf(MongoDB\Driver\Manager $manager, string $db): ?array {
        $query = new MongoDB\Driver\Query([], [
            'sort' => ['erstelltAm' => -1],
            'limit' => 1,
            'projection' => ['erstelltAm' => 1, 'ausloeser' => 1, 'berichtTyp' => 1, 'textStatus' => 1, 'modell' => 1],
        ]);
        $cursor = $manager->executeQuery("$db.kiAnalysen", $query);
        $cursor->setTypeMap(['root' => 'array', 'document' => 'array']);
        $docs = $cursor->toArray();
        return $docs[0] ?? null;
    }

    /** Jüngster adminKommandos-Eintrag vom Typ analyseJetzt (egal ob schon erledigt), oder null. */
    function leseLetztesAdminKommando(MongoDB\Driver\Manager $manager, string $db): ?array {
        $query = new MongoDB\Driver\Query(['typ' => 'analyseJetzt'], ['sort' => ['angefordertAm' => -1], 'limit' => 1]);
        $cursor = $manager->executeQuery("$db.adminKommandos", $query);
        $cursor->setTypeMap(['root' => 'array', 'document' => 'array']);
        $docs = $cursor->toArray();
        return $docs[0] ?? null;
    }

    /** Aktueller Monatswechsel-Status (monatswechselAutomatik.js), oder Default falls noch nie geschrieben. */
    function leseMonatswechselStatus(MongoDB\Driver\Manager $manager, string $db): array {
        $query = new MongoDB\Driver\Query(['_id' => 'aktuell']);
        $cursor = $manager->executeQuery("$db.monatswechselStatus", $query);
        $cursor->setTypeMap(['root' => 'array', 'document' => 'array']);
        $doc = $cursor->toArray()[0] ?? [];
        return [
            'wartungsmodus' => $doc['wartungsmodus'] ?? false,
            'grund' => $doc['grund'] ?? null,
            'schritt' => $doc['schritt'] ?? null,
            'seit' => adminIsoOderNull($doc['seit'] ?? null),
            'letzterErfolgreicherMonatswechsel' => isset($doc['letzterErfolgreicherMonatswechsel']) ? [
                'monat' => $doc['letzterErfolgreicherMonatswechsel']['monat'] ?? null,
                'am' => adminIsoOderNull($doc['letzterErfolgreicherMonatswechsel']['am'] ?? null),
            ] : null,
        ];
    }

    /** Juengster adminKommandos-Eintrag vom Typ monatswechselJetzt/monatswechselWartungAus, oder null. */
    function leseLetztesMonatswechselKommando(MongoDB\Driver\Manager $manager, string $db): ?array {
        $query = new MongoDB\Driver\Query(
            ['typ' => ['$in' => ['monatswechselJetzt', 'monatswechselWartungAus']]],
            ['sort' => ['angefordertAm' => -1], 'limit' => 1]
        );
        $cursor = $manager->executeQuery("$db.adminKommandos", $query);
        $cursor->setTypeMap(['root' => 'array', 'document' => 'array']);
        $docs = $cursor->toArray();
        return $docs[0] ?? null;
    }

    /** ISO-String des Budget-Guard-Endes, oder null falls schon abgelaufen/kein Lauf bekannt. */
    function adminAnalyseNaechsterErlaubterZeitpunkt(?array $letzterLauf): ?string {
        if (!$letzterLauf || !(($letzterLauf['erstelltAm'] ?? null) instanceof MongoDB\BSON\UTCDateTime)) {
            return null;
        }
        $grenze = $letzterLauf['erstelltAm']->toDateTime();
        $grenze->modify('+' . ADMIN_ANALYSE_BUDGET_GUARD_STUNDEN . ' hours');
        $jetzt = new DateTime('now', new DateTimeZone('UTC'));
        return $grenze > $jetzt ? $grenze->format(DATE_ATOM) : null;
    }

    /** ISO-String oder null -- Muster wie an anderer Stelle in dieser Datei/api.php. */
    function adminIsoOderNull($wert): ?string {
        return $wert instanceof MongoDB\BSON\UTCDateTime ? $wert->toDateTime()->format(DATE_ATOM) : null;
    }

    /** Alle abgeschlossenen Telegram-Verknuepfungen (login gesetzt) inkl. aktuellem Spielernamen. */
    function leseTelegramVerknuepfungen(MongoDB\Driver\Manager $manager, string $db): array {
        $query = new MongoDB\Driver\Query(['login' => ['$ne' => null]], ['sort' => ['linkedAt' => -1]]);
        $cursor = $manager->executeQuery("$db.telegramLinks", $query);
        $cursor->setTypeMap(['root' => 'array', 'document' => 'array']);
        $links = $cursor->toArray();
        if (!$links) return [];

        // Namens-Lookup wie spielerNamenIndex() in api.php (players + archivPlayers,
        // players hat Vorrang) -- hier bewusst dupliziert statt geteilt, admin-api.php
        // hat keine gemeinsame lib-Datei mit api.php fuer sowas Kleines.
        $namen = [];
        foreach (['archivPlayers', 'players'] as $coll) {
            $q = new MongoDB\Driver\Query([]);
            $c = $manager->executeQuery("$db.$coll", $q);
            $c->setTypeMap(['root' => 'array', 'document' => 'array']);
            foreach ($c->toArray() as $p) $namen[$p['login']] = $p['name'] ?? $p['login'];
        }

        return array_map(fn($l) => [
            'id' => (string) $l['_id'],
            'login' => $l['login'],
            'name' => $namen[$l['login']] ?? $l['login'],
            'telegramUsername' => $l['telegramUsername'] ?? null,
            'linkedAt' => adminIsoOderNull($l['linkedAt'] ?? null),
        ], $links);
    }

    $action = $_GET['action'] ?? ($_POST['action'] ?? '');

    if ($action === 'lesen') {
        $doc = leseSystemSettingsRoh($manager, $db) ?? [];
        $letzterLauf = leseLetztenAnalyseLauf($manager, $db);
        $letztesKommando = leseLetztesAdminKommando($manager, $db);
        $letztesMonatswechselKommando = leseLetztesMonatswechselKommando($manager, $db);

        echo json_encode([
            'einstellungen' => [
                'rennleitung' => array_merge(ADMIN_DEFAULTS['rennleitung'], $doc['rennleitung'] ?? []),
                'nachrichtenKi' => array_merge(ADMIN_DEFAULTS['nachrichtenKi'], $doc['nachrichtenKi'] ?? []),
                'analyse' => array_merge(ADMIN_ANALYSE_DEFAULTS, $doc['analyse'] ?? []),
                'tagesreport' => array_merge(ADMIN_TAGESREPORT_DEFAULTS, $doc['tagesreport'] ?? []),
            ],
            'grenzen' => ADMIN_GRENZEN,
            'modelle' => ADMIN_MODELLE,
            // ISO-String statt rohem BSON-Objekt (Muster wie api.php: toDateTime()->format(DATE_ATOM)) --
            // sonst liefert json_encode() die kanonische Extended-JSON-Form {"$date":{"$numberLong":"..."}},
            // die new Date(...) im Frontend nicht versteht ("Invalid Date").
            'aktualisiertAm' => adminIsoOderNull($doc['aktualisiertAm'] ?? null),
            'aktualisiertVon' => $doc['aktualisiertVon'] ?? null,
            'analyseStatus' => [
                'letzterLauf' => $letzterLauf ? [
                    'erstelltAm' => adminIsoOderNull($letzterLauf['erstelltAm'] ?? null),
                    'ausloeser' => $letzterLauf['ausloeser'] ?? null,
                    'textStatus' => $letzterLauf['textStatus'] ?? null,
                    'modell' => $letzterLauf['modell'] ?? null,
                ] : null,
                'naechsterErlaubterZeitpunkt' => adminAnalyseNaechsterErlaubterZeitpunkt($letzterLauf),
                'ausstehenderTrigger' => (bool) ($letztesKommando && empty($letztesKommando['erledigtAm'])),
                'letztesTriggerErgebnis' => (!empty($letztesKommando['erledigtAm']) && isset($letztesKommando['ergebnis']))
                    ? $letztesKommando['ergebnis']
                    : null,
            ],
            'monatswechsel' => array_merge(leseMonatswechselStatus($manager, $db), [
                'ausstehenderTrigger' => (bool) ($letztesMonatswechselKommando && empty($letztesMonatswechselKommando['erledigtAm'])),
            ]),
            'csrf' => adminCsrfToken(),
        ]);
        exit;
    }

    if ($action === 'schreiben') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['error' => 'POST erforderlich.']);
            exit;
        }

        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        if (!pruefeAdminCsrf($body['csrf'] ?? null)) {
            http_response_code(403);
            echo json_encode(['error' => 'Ungültiges CSRF-Token -- Seite neu laden und erneut versuchen.']);
            exit;
        }

        $bereich = $body['bereich'] ?? '';
        if (!in_array($bereich, ADMIN_BEREICHE, true)) {
            http_response_code(400);
            echo json_encode(['error' => 'Unbekannter Bereich.']);
            exit;
        }

        $vorhandenesDoc = leseSystemSettingsRoh($manager, $db) ?? [];
        $eingabe = $body['werte'] ?? [];

        if ($bereich === 'analyse') {
            // AP16b: eigene Feldform (wochentag/uhrzeit statt min/max-Zahlenfeldern) --
            // deshalb nicht ueber die generische ADMIN_GRENZEN-Klemmung unten, sondern die
            // dedizierten Pruef-Funktionen aus einstellungenGrenzen.php.
            $aktuellerBereich = array_merge(ADMIN_ANALYSE_DEFAULTS, $vorhandenesDoc['analyse'] ?? []);
            $neuerBereich = $aktuellerBereich;
            if (array_key_exists('modell', $eingabe) && in_array($eingabe['modell'], ADMIN_MODELLE, true)) {
                $neuerBereich['modell'] = $eingabe['modell'];
            }
            if (array_key_exists('wochentag', $eingabe) && is_numeric($eingabe['wochentag'])) {
                $wochentag = (int) $eingabe['wochentag'];
                if (adminAnalyseWochentagGueltig($wochentag)) {
                    $neuerBereich['wochentag'] = $wochentag;
                }
            }
            if (array_key_exists('uhrzeit', $eingabe) && adminAnalyseUhrzeitGueltig($eingabe['uhrzeit'])) {
                $neuerBereich['uhrzeit'] = $eingabe['uhrzeit'];
            }
            if (array_key_exists('telegramBericht', $eingabe)) {
                $neuerBereich['telegramBericht'] = (bool) $eingabe['telegramBericht'];
            }
        } elseif ($bereich === 'tagesreport') {
            // AP17: eigene Feldform (aktiv/uhrzeit, kein Modell) -- analog zum analyse-Zweig
            // oben nicht ueber die generische ADMIN_GRENZEN-Klemmung.
            $aktuellerBereich = array_merge(ADMIN_TAGESREPORT_DEFAULTS, $vorhandenesDoc['tagesreport'] ?? []);
            $neuerBereich = $aktuellerBereich;
            if (array_key_exists('aktiv', $eingabe)) {
                $neuerBereich['aktiv'] = (bool) $eingabe['aktiv'];
            }
            if (array_key_exists('uhrzeit', $eingabe) && adminAnalyseUhrzeitGueltig($eingabe['uhrzeit'])) {
                $neuerBereich['uhrzeit'] = $eingabe['uhrzeit'];
            }
        } else {
            $aktuellerBereich = array_merge(ADMIN_DEFAULTS[$bereich], $vorhandenesDoc[$bereich] ?? []);
            $neuerBereich = $aktuellerBereich;
            if (array_key_exists('aktiv', $eingabe)) {
                $neuerBereich['aktiv'] = (bool) $eingabe['aktiv'];
            }
            if (array_key_exists('modell', $eingabe) && in_array($eingabe['modell'], ADMIN_MODELLE, true)) {
                $neuerBereich['modell'] = $eingabe['modell'];
            }
            foreach (ADMIN_GRENZEN[$bereich] as $feld => $bereichGrenze) {
                if (array_key_exists($feld, $eingabe)) {
                    $neuerBereich[$feld] = adminKlemme($bereichGrenze, $eingabe[$feld], $aktuellerBereich[$feld] ?? null);
                }
            }
        }

        $bulk = new MongoDB\Driver\BulkWrite();
        $bulk->update(
            ['_id' => 'aktuell'],
            ['$set' => [
                $bereich => $neuerBereich,
                'aktualisiertAm' => new MongoDB\BSON\UTCDateTime(),
                'aktualisiertVon' => 'dashboard',
            ]],
            ['upsert' => true]
        );
        $manager->executeBulkWrite("$db.systemSettings", $bulk);

        echo json_encode(['ok' => true, 'bereich' => $bereich, 'werte' => $neuerBereich]);
        exit;
    }

    if ($action === 'analyseTrigger') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['error' => 'POST erforderlich.']);
            exit;
        }

        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        if (!pruefeAdminCsrf($body['csrf'] ?? null)) {
            http_response_code(403);
            echo json_encode(['error' => 'Ungültiges CSRF-Token -- Seite neu laden und erneut versuchen.']);
            exit;
        }

        // Vorabprüfung, damit "Jetzt auslösen" nie als stiller No-op wirkt (auch wenn der
        // Controller selbst denselben Budget-Guard ohnehin nochmal hart durchsetzt, siehe
        // pruefeManuellenLaufErlaubnis in automatikTakt.js -- diese Prüfung hier ist nur für
        // eine sofortige, verständliche Rückmeldung an den Betreiber).
        $letztesKommando = leseLetztesAdminKommando($manager, $db);
        if ($letztesKommando && empty($letztesKommando['erledigtAm'])) {
            echo json_encode(['ok' => false, 'grund' => 'laeuftBereits']);
            exit;
        }

        $letzterLauf = leseLetztenAnalyseLauf($manager, $db);
        $naechsterErlaubterZeitpunkt = adminAnalyseNaechsterErlaubterZeitpunkt($letzterLauf);
        if ($naechsterErlaubterZeitpunkt !== null) {
            echo json_encode(['ok' => false, 'grund' => 'budget', 'naechsterErlaubterZeitpunkt' => $naechsterErlaubterZeitpunkt]);
            exit;
        }

        $berichtTyp = ($body['berichtTyp'] ?? 'woche') === 'monat' ? 'monat' : 'woche';

        $bulk = new MongoDB\Driver\BulkWrite();
        $bulk->insert([
            'typ' => 'analyseJetzt',
            'berichtTyp' => $berichtTyp,
            'angefordertAm' => new MongoDB\BSON\UTCDateTime(),
            'erledigtAm' => null,
            'angefordertVon' => 'dashboard',
        ]);
        $manager->executeBulkWrite("$db.adminKommandos", $bulk);

        echo json_encode(['ok' => true, 'gestartet' => true]);
        exit;
    }

    if ($action === 'monatswechselTrigger') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['error' => 'POST erforderlich.']);
            exit;
        }

        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        if (!pruefeAdminCsrf($body['csrf'] ?? null)) {
            http_response_code(403);
            echo json_encode(['error' => 'Ungültiges CSRF-Token -- Seite neu laden und erneut versuchen.']);
            exit;
        }

        // Vorabprüfung gegen einen stillen No-op (Muster wie analyseTrigger) -- der
        // eigentliche laeuftGerade-Schutz sitzt ohnehin im Controller (monatswechselAutomatik.js).
        $letztesKommando = leseLetztesMonatswechselKommando($manager, $db);
        if ($letztesKommando && empty($letztesKommando['erledigtAm'])) {
            echo json_encode(['ok' => false, 'grund' => 'laeuftBereits']);
            exit;
        }

        $bulk = new MongoDB\Driver\BulkWrite();
        $bulk->insert([
            'typ' => 'monatswechselJetzt',
            'angefordertAm' => new MongoDB\BSON\UTCDateTime(),
            'erledigtAm' => null,
            'angefordertVon' => 'dashboard',
        ]);
        $manager->executeBulkWrite("$db.adminKommandos", $bulk);

        echo json_encode(['ok' => true, 'gestartet' => true]);
        exit;
    }

    if ($action === 'monatswechselWartungAus') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['error' => 'POST erforderlich.']);
            exit;
        }

        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        if (!pruefeAdminCsrf($body['csrf'] ?? null)) {
            http_response_code(403);
            echo json_encode(['error' => 'Ungültiges CSRF-Token -- Seite neu laden und erneut versuchen.']);
            exit;
        }

        $bulk = new MongoDB\Driver\BulkWrite();
        $bulk->insert([
            'typ' => 'monatswechselWartungAus',
            'angefordertAm' => new MongoDB\BSON\UTCDateTime(),
            'erledigtAm' => null,
            'angefordertVon' => 'dashboard',
        ]);
        $manager->executeBulkWrite("$db.adminKommandos", $bulk);

        echo json_encode(['ok' => true]);
        exit;
    }

    if ($action === 'serverBefehl') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['error' => 'POST erforderlich.']);
            exit;
        }

        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        if (!pruefeAdminCsrf($body['csrf'] ?? null)) {
            http_response_code(403);
            echo json_encode(['error' => 'Ungültiges CSRF-Token -- Seite neu laden und erneut versuchen.']);
            exit;
        }

        $befehl = $body['befehl'] ?? '';
        $eingabe = $body['parameter'] ?? [];

        // Whitelist + serverseitige Parameterpruefung -- Zwilling der switch-Verzweigung in
        // controller/plugins/serverSteuerung.js::fuehreBefehlAus(). Nur hier valide zusammengebaute
        // Parameter werden in adminKommandos geschrieben, der Controller vertraut dem nicht blind
        // (z.B. mapEntfernen loest die Datei ausschliesslich serverseitig über die UID auf).
        $parameter = [];
        switch ($befehl) {
            case 'skip': case 'restart': case 'jukeboxClear':
            case 'modeSave': case 'modeRead': case 'modeReset':
                break;

            case 'extend':
                $sekunden = $eingabe['sekunden'] ?? null;
                if (!is_numeric($sekunden) || (int) $sekunden < 10 || (int) $sekunden > 3600) {
                    http_response_code(400);
                    echo json_encode(['error' => 'Sekunden muss zwischen 10 und 3600 liegen.']);
                    exit;
                }
                $parameter = ['sekunden' => (int) $sekunden];
                break;

            case 'mapTmx':
                $tmxId = $eingabe['tmxId'] ?? null;
                if (!is_numeric($tmxId) || (int) $tmxId <= 0) {
                    http_response_code(400);
                    echo json_encode(['error' => 'Ungültige TMX-ID.']);
                    exit;
                }
                $parameter = ['tmxId' => (int) $tmxId];
                break;

            case 'mapEntfernen':
                $uid = $eingabe['uid'] ?? null;
                if (!is_string($uid) || $uid === '') {
                    http_response_code(400);
                    echo json_encode(['error' => 'Ungültige Karten-UID.']);
                    exit;
                }
                $parameter = ['uid' => $uid];
                break;

            case 'shutdown':
                if (($eingabe['bestaetigt'] ?? false) !== true) {
                    http_response_code(400);
                    echo json_encode(['error' => 'Shutdown erfordert Bestätigung.']);
                    exit;
                }
                $parameter = ['bestaetigt' => true];
                break;

            default:
                http_response_code(400);
                echo json_encode(['error' => 'Unbekannter Befehl.']);
                exit;
        }

        $bulk = new MongoDB\Driver\BulkWrite();
        $bulk->insert([
            'typ' => 'serverBefehl',
            'befehl' => $befehl,
            'parameter' => $parameter,
            'angefordertAm' => new MongoDB\BSON\UTCDateTime(),
            'erledigtAm' => null,
            'angefordertVon' => 'dashboard',
        ]);
        $manager->executeBulkWrite("$db.adminKommandos", $bulk);

        echo json_encode(['ok' => true]);
        exit;
    }

    if ($action === 'telegramVerknuepfungen') {
        echo json_encode(leseTelegramVerknuepfungen($manager, $db));
        exit;
    }

    if ($action === 'telegramLoesen') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['error' => 'POST erforderlich.']);
            exit;
        }

        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        if (!pruefeAdminCsrf($body['csrf'] ?? null)) {
            http_response_code(403);
            echo json_encode(['error' => 'Ungültiges CSRF-Token -- Seite neu laden und erneut versuchen.']);
            exit;
        }

        $id = $body['id'] ?? '';
        try {
            $objectId = new MongoDB\BSON\ObjectId($id);
        } catch (Exception $e) {
            http_response_code(400);
            echo json_encode(['error' => 'Ungültige ID.']);
            exit;
        }

        $bulk = new MongoDB\Driver\BulkWrite();
        $bulk->delete(['_id' => $objectId]);
        $result = $manager->executeBulkWrite("$db.telegramLinks", $bulk);

        echo json_encode(['ok' => true, 'geloescht' => $result->getDeletedCount() > 0]);
        exit;
    }

    http_response_code(400);
    echo json_encode(['error' => 'Unbekannte Aktion.']);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
