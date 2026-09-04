<?php
// api.php -- Gehaertete API der neuen Website. Ersetzt halloffame.php,
// trackmania_data.php, playerstats.php, trackmania_records.php.
//
// Wichtig: Liefert NIEMALS rohe Ubisoft-Logins an den Client -- nur
// Anzeigenamen und eine anonymisierte oeffentliche ID (siehe lib/punkte.php).
//
// Aktionen: ?action=hof | monate | monat&m=YYYY-MM | jahre | jahr&j=<jahr> | maps | liveRecords
//           | live[&uid=] | spieler&id=<publicId> | alleSpielerStats | voting | serverLog[&seitId=][&typ=]
//           | analysen[&lauf=<id>] | analysenHistorie (AP15f, siehe controller/lib/analyse/)
//           | tagesberichteKalender[&jahr=YYYY] | tagesbericht&datum=YYYY-MM-DD (AP17, Jahres-
//             Heatmap auf analysen.html, siehe controller/plugins/telegram.js sendeTagesReport)
//           | mapInfo&uid=<mapUid> (TMX-Map-Info-Widget, rein informativ, gecacht in tmxMapInfo)
//           | cup | cupLive | cupHistorie | cupDetail&id=<turnierId> (Cup-Turniersystem,
//             Beta-Feature -- cup.html ist bewusst NOCH NICHT in der Navigation verlinkt)

require_once __DIR__ . '/lib/punkte.php';
require_once __DIR__ . '/lib/saison.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache, must-revalidate');

$config = require __DIR__ . '/config.php';

try {
    $manager = new MongoDB\Driver\Manager($config['mongodb']['uri']);
    $db = $config['mongodb']['database'];

    function alle(MongoDB\Driver\Manager $manager, string $db, string $collection, array $filter = []): array {
        // typeMap erzwingt reine PHP-Arrays (statt stdClass/BSONDocument), damit
        // im ganzen Skript einheitlich mit [...] auf Felder zugegriffen werden kann.
        $query = new MongoDB\Driver\Query($filter);
        $cursor = $manager->executeQuery("$db.$collection", $query);
        $cursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);
        return $cursor->toArray();
    }

    // Kleiner Upsert-Helfer fuers TMX-Map-Info-Caching (Muster wie admin-api.php).
    function upsertEins(MongoDB\Driver\Manager $manager, string $db, string $collection, $id, array $doc): void {
        $bulk = new MongoDB\Driver\BulkWrite();
        $bulk->update(['_id' => $id], ['$set' => $doc], ['upsert' => true]);
        $manager->executeBulkWrite("$db.$collection", $bulk);
    }

    // Fragt die TMX-API (trackmania.exchange) fuer eine Map-UID ab und reduziert die
    // Antwort auf die im Widget benoetigten Felder. Wirft NIE -- liefert bei jedem
    // Fehler ['fehler' => true], damit ein TMX-Ausfall die Live-Seite nie mitreisst.
    function tmxMapInfoAbrufen(string $uid): array {
        $felder = 'MapId,Name,GbxMapName,Authors,Tags,Medals.Author,AwardCount,Length,Difficulty,UploadedAt,UpdatedAt,Images';
        $url = 'https://trackmania.exchange/api/maps?uid=' . urlencode($uid) . '&fields=' . urlencode($felder);
        $context = stream_context_create(['http' => [
            'method' => 'GET',
            'timeout' => 5,
            'ignore_errors' => true,
            'header' => "User-Agent: NextControl-LAN-Website/1.0 (privater LAN-Server)\r\nAccept: application/json\r\n",
        ]]);

        $body = @file_get_contents($url, false, $context);
        if ($body === false) return ['gefunden' => false, 'fehler' => true, 'daten' => null];

        $statusZeile = $http_response_header[0] ?? '';
        if (!preg_match('#\s(\d{3})\s#', $statusZeile, $m) || $m[1] !== '200') {
            return ['gefunden' => false, 'fehler' => true, 'daten' => null];
        }

        $json = json_decode($body, true);
        if (!is_array($json) || !isset($json['Results']) || !is_array($json['Results'])) {
            return ['gefunden' => false, 'fehler' => true, 'daten' => null];
        }

        $treffer = $json['Results'][0] ?? null;
        if ($treffer === null) return ['gefunden' => false, 'fehler' => false, 'daten' => null];

        $autoren = [];
        foreach (($treffer['Authors'] ?? []) as $a) {
            // TMX liefert den Namen verschachtelt unter Authors[].User.Name (nicht direkt auf $a).
            $name = $a['User']['Name'] ?? null;
            if (!empty($name)) $autoren[] = (string) $name;
        }
        $tags = [];
        foreach (($treffer['Tags'] ?? []) as $t) {
            $farbe = $t['Color'] ?? null;
            $tags[] = [
                'name' => (string) ($t['Name'] ?? ''),
                'farbe' => (is_string($farbe) && preg_match('/^[0-9a-fA-F]{6}$/', $farbe)) ? $farbe : null,
            ];
        }

        $daten = [
            'mapId' => (int) ($treffer['MapId'] ?? 0),
            'name' => (string) ($treffer['Name'] ?? $treffer['GbxMapName'] ?? ''),
            'autoren' => $autoren,
            'tags' => $tags,
            'schwierigkeit' => isset($treffer['Difficulty']) ? (int) $treffer['Difficulty'] : null,
            'laenge' => $treffer['Length'] ?? null,
            'autorenzeitTmx' => isset($treffer['Medals']['Author']) ? (int) $treffer['Medals']['Author'] : null,
            'awards' => isset($treffer['AwardCount']) ? (int) $treffer['AwardCount'] : null,
            'hochgeladenAm' => $treffer['UploadedAt'] ?? null,
            'hatBild' => !empty($treffer['Images']),
        ];

        return ['gefunden' => true, 'fehler' => false, 'daten' => $daten];
    }

    $action = $_GET['action'] ?? '';

    // Namens-Lookup ueber players + archivPlayers (aktuelle Namen haben Vorrang).
    // Fallback bei fehlendem Namen: anonymisierte ID statt rohem Ubisoft-Login
    // (der darf laut Projektkonvention niemals im Klartext an den Client gehen).
    function spielerNamenIndex(MongoDB\Driver\Manager $manager, string $db): array {
        $namen = [];
        foreach (alle($manager, $db, 'archivPlayers') as $p) $namen[$p['login']] = $p['name'] ?? ('Spieler-' . oeffentlicheId($p['login']));
        foreach (alle($manager, $db, 'players') as $p) $namen[$p['login']] = $p['name'] ?? ('Spieler-' . oeffentlicheId($p['login']));
        return $namen;
    }

    // AP15f: kiAnalysen.kennzahlen enthaelt an vielen, unterschiedlich tief verschachtelten
    // Stellen rohe Logins (login/loginA/loginB, siehe controller/lib/analyse/kennzahlen.js) --
    // die duerfen laut Projektkonvention NIE an den Client. Statt pro Analyse-Kategorie einen
    // eigenen, fehleranfaelligen Sonderfall zu pflegen, laeuft hier EIN generischer rekursiver
    // Ersetzer ueber die komplette Struktur (Muster: anonymisieren-Closure bei action=monat,
    // nur rekursiv statt nur oberste Ebene).
    function anonymisiereLogins($wert) {
        if (!is_array($wert)) return $wert;
        if (!array_is_list($wert)) {
            foreach (['login' => 'id', 'loginA' => 'idA', 'loginB' => 'idB'] as $rohFeld => $idFeld) {
                if (array_key_exists($rohFeld, $wert)) {
                    $wert[$idFeld] = is_string($wert[$rohFeld]) ? oeffentlicheId($wert[$rohFeld]) : null;
                    unset($wert[$rohFeld]);
                }
            }
        }
        foreach ($wert as $k => $v) {
            $wert[$k] = anonymisiereLogins($v);
        }
        return $wert;
    }

    // Monats-Statistik des LAUFENDEN Monats je Spieler: Ranking aus "records",
    // Aktivitaet aus den playerStats-Monatszaehlern. Liefert ROHE Logins --
    // nur serverseitig verwenden, vor der Ausgabe anonymisieren!
    // "eintraege" = Spieler mit mindestens einem Record, "weitereAktive" =
    // Spieler mit Aktivitaet, aber ohne gefahrene Zeit.
    function monatsStatsLive(MongoDB\Driver\Manager $manager, string $db): array {
        $namen = spielerNamenIndex($manager, $db);
        $records = alle($manager, $db, 'records');
        $ranking = berechneRanking($records, $namen);

        $mapsProLogin = [];
        foreach ($records as $r) {
            if (empty($r['login']) || empty($r['map'])) continue;
            $mapsProLogin[$r['login']][$r['map']] = true;
        }
        $statsByLogin = [];
        foreach (alle($manager, $db, 'playerStats') as $s) {
            if (empty($s['login'])) continue;
            $statsByLogin[$s['login']] = $s;
        }

        $eintraege = array_map(function ($r) use ($namen, $mapsProLogin, $statsByLogin) {
            $s = $statsByLogin[$r['login']] ?? null;
            return [
                'login' => $r['login'],
                'name' => $namen[$r['login']] ?? ('Spieler-' . oeffentlicheId($r['login'])),
                'punkte' => $r['punkte'],
                'siege' => $r['siege'],
                'mapsGespielt' => $r['mapsGespielt'],
                'mapsGefahren' => array_keys($mapsProLogin[$r['login']] ?? []),
                'timePlayed' => $s['timePlayedMonat'] ?? 0,
                'finishes' => $s['finishesMonat'] ?? 0,
                'checkpoints' => $s['checkpointsMonat'] ?? 0,
                'connections' => $s['connectionsMonat'] ?? 0,
            ];
        }, $ranking);

        $mitRanking = array_column($ranking, 'login');
        $weitereAktive = [];
        foreach ($statsByLogin as $login => $s) {
            if (in_array($login, $mitRanking, true)) continue;
            $aktiv = ($s['timePlayedMonat'] ?? 0) > 0 || ($s['connectionsMonat'] ?? 0) > 0
                || ($s['finishesMonat'] ?? 0) > 0 || ($s['checkpointsMonat'] ?? 0) > 0;
            if (!$aktiv) continue;
            $weitereAktive[] = [
                'login' => $login,
                'name' => $namen[$login] ?? ('Spieler-' . oeffentlicheId($login)),
                'timePlayed' => $s['timePlayedMonat'] ?? 0,
                'finishes' => $s['finishesMonat'] ?? 0,
                'checkpoints' => $s['checkpointsMonat'] ?? 0,
                'connections' => $s['connectionsMonat'] ?? 0,
            ];
        }

        return ['eintraege' => $eintraege, 'weitereAktive' => $weitereAktive];
    }

    switch ($action) {

        case 'hof': {
            // Allzeit-Rangliste + Lifetime-Aktivitaet aus playerStats. Die
            // Aktivitaets-Zaehler existieren erst seit AKTIVITAET_SEIT_MONAT --
            // die Seite zeigt dazu eine permanente Fussnote.
            $namen = spielerNamenIndex($manager, $db);
            $records = array_merge(alle($manager, $db, 'archivRecords'), alle($manager, $db, 'records'));
            $ranking = berechneRanking($records, $namen);
            $statsByLogin = [];
            foreach (alle($manager, $db, 'playerStats') as $s) {
                if (empty($s['login'])) continue;
                $statsByLogin[$s['login']] = $s;
            }
            echo json_encode([
                'eintraege' => array_map(function ($s) use ($statsByLogin) {
                    $st = $statsByLogin[$s['login']] ?? null;
                    return [
                        'id' => oeffentlicheId($s['login']),
                        'name' => $s['name'],
                        'punkte' => $s['punkte'],
                        'siege' => $s['siege'],
                        'mapsGespielt' => $s['mapsGespielt'],
                        'timePlayed' => $st['timePlayed'] ?? 0,
                        'finishes' => $st['finishes'] ?? 0,
                        'checkpoints' => $st['checkpoints'] ?? 0,
                        'connections' => $st['connections'] ?? 0,
                    ];
                }, $ranking),
                'aktivitaetSeit' => AKTIVITAET_SEIT_MONAT,
            ]);
            break;
        }

        case 'monate': {
            // Fuer die Zeitleiste des Monatsarchivs: jeder Monat mit seinem
            // Zyklusjahr (Aug-Jul, "2026/27"; Alt-/Pseudo-Monate -> "2025/26").
            $monate = array_map(fn($m) => [
                'monat' => $m['monat'],
                'jahr' => jahresZyklusFuerMonat($m['monat'])['jahr'],
                'aktivitaetErfasst' => !empty($m['aktivitaetErfasst']),
            ], alle($manager, $db, 'monthlyRankings'));
            usort($monate, fn($a, $b) => strcmp(sortSchluesselFuerMonat($a['monat']), sortSchluesselFuerMonat($b['monat'])));
            echo json_encode($monate);
            break;
        }

        case 'monat': {
            $monat = $_GET['m'] ?? '';
            if ($monat === '') { http_response_code(400); echo json_encode(['error' => 'Parameter m fehlt']); break; }

            $eingefroren = alle($manager, $db, 'monthlyRankings', ['monat' => $monat]);
            if (!empty($eingefroren)) {
                $doc = $eingefroren[0];
                $aktivitaetErfasst = !empty($doc['aktivitaetErfasst']);
                $aktByLogin = [];
                foreach (($doc['aktivitaet'] ?? []) as $a) $aktByLogin[$a['login']] = $a;

                $eintraege = array_map(function ($e) use ($aktivitaetErfasst, $aktByLogin) {
                    $a = $aktByLogin[$e['login']] ?? null;
                    $eintrag = [
                        'login' => $e['login'],
                        'name' => $e['name'],
                        'punkte' => $e['punkte'],
                        'siege' => $e['siege'],
                        'mapsGespielt' => $e['mapsGespielt'],
                    ];
                    if (isset($e['mapsGefahren'])) $eintrag['mapsGefahren'] = $e['mapsGefahren'];
                    if ($aktivitaetErfasst) {
                        $eintrag['timePlayed'] = $a['timePlayed'] ?? 0;
                        $eintrag['finishes'] = $a['finishes'] ?? 0;
                        $eintrag['checkpoints'] = $a['checkpoints'] ?? 0;
                        $eintrag['connections'] = $a['connections'] ?? 0;
                    }
                    return $eintrag;
                }, $doc['eintraege']);

                // Aktive Spieler ohne Ranking-Eintrag (verbunden, aber keine Zeit gefahren)
                $namen = spielerNamenIndex($manager, $db);
                $mitRanking = array_column($doc['eintraege'], 'login');
                $weitereAktive = [];
                foreach (($doc['aktivitaet'] ?? []) as $a) {
                    if (in_array($a['login'], $mitRanking, true)) continue;
                    $weitereAktive[] = [
                        'login' => $a['login'],
                        'name' => $namen[$a['login']] ?? ('Spieler-' . oeffentlicheId($a['login'])),
                        'timePlayed' => $a['timePlayed'] ?? 0,
                        'finishes' => $a['finishes'] ?? 0,
                        'checkpoints' => $a['checkpoints'] ?? 0,
                        'connections' => $a['connections'] ?? 0,
                    ];
                }

                $mapDocs = alle($manager, $db, 'archivMaps', ['monat' => $monat]);
            } else {
                // Noch nicht eingefroren -> vermutlich der laufende Monat, live berechnen
                $liveDaten = monatsStatsLive($manager, $db);
                $eintraege = $liveDaten['eintraege'];
                $weitereAktive = $liveDaten['weitereAktive'];
                $aktivitaetErfasst = true;
                $mapDocs = alle($manager, $db, 'maps');
            }

            $anonymisieren = function ($e) {
                $e['id'] = oeffentlicheId($e['login']);
                unset($e['login']);
                return $e;
            };
            echo json_encode([
                'monat' => $monat,
                'aktivitaetErfasst' => $aktivitaetErfasst,
                'eintraege' => array_map($anonymisieren, $eintraege),
                'weitereAktive' => array_map($anonymisieren, $weitereAktive),
                'maps' => array_map(fn($m) => ['uid' => $m['uid'], 'name' => $m['name'] ?? ''], $mapDocs),
            ]);
            break;
        }

        case 'jahre': {
            $jahre = array_map(fn($j) => $j['jahr'], alle($manager, $db, 'yearlyRankings'));
            // Laufendes Jahr (noch nicht in yearlyRankings) ergaenzen, falls Monatsdaten dafuer existieren
            $heute = jahresZyklusFuerMonat(date('Y-m'));
            if (!in_array($heute['jahr'], $jahre, true)) {
                $hatDaten = !empty(alle($manager, $db, 'records'))
                    || !empty(alle($manager, $db, 'monthlyRankings', ['monat' => ['$gte' => $heute['start'] ?? '0000-00', '$lte' => $heute['ende']]]));
                if ($hatDaten) $jahre[] = $heute['jahr'];
            }
            sort($jahre);
            echo json_encode($jahre);
            break;
        }

        case 'jahr': {
            $jahr = $_GET['j'] ?? '';
            if ($jahr === '') { http_response_code(400); echo json_encode(['error' => 'Parameter j fehlt']); break; }

            $eingefroren = alle($manager, $db, 'yearlyRankings', ['jahr' => $jahr]);
            if (!empty($eingefroren)) {
                $eintraege = $eingefroren[0]['eintraege'];
                $jahresAktivitaet = $eingefroren[0]['aktivitaet'] ?? [];
                $aktivitaetMonate = $eingefroren[0]['aktivitaetMonate'] ?? [];
            } else {
                // Laufendes Jahr, noch nicht abgeschlossen -> live aus den vorhandenen Monaten zusammensetzen
                $zyklus = jahresZyklusFuerMonat(date('Y-m'));
                $monateDesZyklus = $zyklus['start'] === null
                    ? []
                    : alle($manager, $db, 'monthlyRankings', ['monat' => ['$gte' => $zyklus['start'], '$lte' => $zyklus['ende']]]);
                $eintraege = fasseJahrZusammen($monateDesZyklus);

                // Laufenden, noch nicht eingefrorenen Monat live dazuzaehlen
                $namen = spielerNamenIndex($manager, $db);
                $laufenderMonat = berechneRanking(alle($manager, $db, 'records'), $namen);
                if (!empty($laufenderMonat)) {
                    $eintraege = fasseJahrZusammen(array_merge(
                        [['eintraege' => $eintraege]],
                        [['eintraege' => $laufenderMonat]]
                    ));
                }

                // Aktivitaet: eingefrorene Monats-Snapshots + laufender Monat live
                $liveAktivitaet = [];
                foreach (alle($manager, $db, 'playerStats') as $s) {
                    if (empty($s['login'])) continue;
                    if (($s['timePlayedMonat'] ?? 0) > 0 || ($s['connectionsMonat'] ?? 0) > 0
                        || ($s['finishesMonat'] ?? 0) > 0 || ($s['checkpointsMonat'] ?? 0) > 0) {
                        $liveAktivitaet[] = [
                            'login' => $s['login'],
                            'timePlayed' => $s['timePlayedMonat'] ?? 0,
                            'connections' => $s['connectionsMonat'] ?? 0,
                            'finishes' => $s['finishesMonat'] ?? 0,
                            'checkpoints' => $s['checkpointsMonat'] ?? 0,
                        ];
                    }
                }
                $akt = fasseAktivitaetZusammen(array_merge($monateDesZyklus, [[
                    'monat' => date('Y-m'),
                    'aktivitaetErfasst' => !empty($liveAktivitaet),
                    'aktivitaet' => $liveAktivitaet,
                ]]));
                $jahresAktivitaet = $akt['aktivitaet'];
                $aktivitaetMonate = $akt['erfassteMonate'];
            }

            $aktByLogin = [];
            foreach ($jahresAktivitaet as $a) $aktByLogin[$a['login']] = $a;
            $hatAktivitaet = !empty($aktivitaetMonate);

            // Aktive Spieler ohne Ranking-Eintrag im Jahr
            $mitRanking = array_column($eintraege, 'login');
            $namenIndex = spielerNamenIndex($manager, $db);
            $weitereAktive = [];
            foreach ($jahresAktivitaet as $a) {
                if (in_array($a['login'], $mitRanking, true)) continue;
                $weitereAktive[] = [
                    'id' => oeffentlicheId($a['login']),
                    'name' => $namenIndex[$a['login']] ?? ('Spieler-' . oeffentlicheId($a['login'])),
                    'timePlayed' => $a['timePlayed'] ?? 0,
                    'finishes' => $a['finishes'] ?? 0,
                    'checkpoints' => $a['checkpoints'] ?? 0,
                    'connections' => $a['connections'] ?? 0,
                ];
            }

            echo json_encode([
                'jahr' => $jahr,
                'aktivitaetMonate' => $aktivitaetMonate,
                'eintraege' => array_map(function ($s) use ($hatAktivitaet, $aktByLogin) {
                    $eintrag = [
                        'id' => oeffentlicheId($s['login']),
                        'name' => $s['name'],
                        'punkte' => $s['punkte'],
                        'siege' => $s['siege'],
                        'mapsGespielt' => $s['mapsGespielt'],
                    ];
                    if ($hatAktivitaet) {
                        $a = $aktByLogin[$s['login']] ?? null;
                        $eintrag['timePlayed'] = $a['timePlayed'] ?? 0;
                        $eintrag['finishes'] = $a['finishes'] ?? 0;
                        $eintrag['checkpoints'] = $a['checkpoints'] ?? 0;
                        $eintrag['connections'] = $a['connections'] ?? 0;
                    }
                    return $eintrag;
                }, $eintraege),
                'weitereAktive' => $weitereAktive,
            ]);
            break;
        }

        case 'maps': {
            $namen = spielerNamenIndex($manager, $db);
            $maps = alle($manager, $db, 'maps');
            $records = alle($manager, $db, 'records');
            $proMap = [];
            foreach ($records as $r) $proMap[$r['map']][] = $r;

            $ergebnis = array_map(function ($map) use ($proMap, $namen) {
                $recs = $proMap[$map['uid']] ?? [];
                usort($recs, fn($a, $b) => $a['time'] <=> $b['time']);
                $top3 = array_slice(array_map(fn($r) => [
                    'name' => $namen[$r['login']] ?? ('Spieler-' . oeffentlicheId($r['login'])),
                    'zeit' => $r['time'],
                ], $recs), 0, 3);
                return [
                    'uid' => $map['uid'],
                    'name' => $map['name'] ?? '',
                    'author' => $map['author'] ?? '',
                    'medals' => $map['medals'] ?? null,
                    'anzahlRecords' => count($recs),
                    'top3' => $top3,
                ];
            }, $maps);
            echo json_encode($ergebnis);
            break;
        }

        case 'liveRecords': {
            $namen = spielerNamenIndex($manager, $db);
            $records = alle($manager, $db, 'records');
            echo json_encode(array_map(fn($r) => [
                'name' => $namen[$r['login']] ?? ('Spieler-' . oeffentlicheId($r['login'])),
                'map' => $r['map'],
                'zeit' => $r['time'],
            ], $records));
            break;
        }

        case 'live': {
            // Aktuelle Map + Online-Spieler kommen vom NextControl-Plugin
            // liveStatus.js (serverStatus._id="live") -- die Website spricht
            // nie direkt mit dem Dedicated Server.
            // Optionaler Parameter "uid": zeigt die Rangliste einer BELIEBIGEN
            // Map dieses Monats (z.B. per Klick im Map-Auswahlraster), auch
            // wenn sie gerade nicht die live geladene Map ist.
            $status = alle($manager, $db, 'serverStatus', ['_id' => 'live']);
            $namen = spielerNamenIndex($manager, $db);
            $s = $status[0] ?? ['map' => null, 'spieler' => []];
            $liveMapUid = $s['map']['uid'] ?? null;

            // Frische-Pruefung: controller/plugins/liveStatus.js schreibt diesen Snapshot
            // alle 5s neu. Laenger als 3 Ticks kein Update mehr -> Server und/oder Controller
            // sind nicht (mehr) erreichbar. Ohne diese Pruefung wuerde die Website veraltete
            // Daten (z.B. "online"-Spieler von vor Stunden) unveraendert als aktuell anzeigen.
            $aktualisiertAm = ($s['updatedAt'] ?? null) instanceof MongoDB\BSON\UTCDateTime ? $s['updatedAt']->toDateTime() : null;
            $aktuell = $aktualisiertAm !== null && (time() - $aktualisiertAm->getTimestamp()) <= 15;
            $zuletztAktualisiert = $aktualisiertAm?->format(DATE_ATOM);

            // Hardware-/Server-Status (siehe controller/plugins/liveStatus.js) --
            // controllerLaeuftSeit kommt als BSON-Datum und muss fuer JSON aufbereitet werden.
            $system = $s['system'] ?? null;
            $serverInfo = $s['server'] ?? null;
            if ($serverInfo && ($serverInfo['controllerLaeuftSeit'] ?? null) instanceof MongoDB\BSON\UTCDateTime) {
                $serverInfo['controllerLaeuftSeit'] = $serverInfo['controllerLaeuftSeit']->toDateTime()->format(DATE_ATOM);
            }

            $angefragteUid = $_GET['uid'] ?? $liveMapUid;
            if ($angefragteUid === null) {
                echo json_encode(['map' => null, 'istLiveMap' => false, 'onlineSpieler' => [], 'leaderboard' => [], 'system' => $system, 'server' => $serverInfo, 'aktuell' => $aktuell, 'zuletztAktualisiert' => $zuletztAktualisiert]);
                break;
            }

            $mapDoc = alle($manager, $db, 'maps', ['uid' => $angefragteUid])[0] ?? null;
            $mapInfo = $angefragteUid === $liveMapUid
                ? ['name' => $s['map']['name'] ?? '', 'author' => $s['map']['author'] ?? '']
                : ['name' => $mapDoc['name'] ?? '', 'author' => $mapDoc['author'] ?? ''];

            // Autorenzeit (Millisekunden) -- rein informativ fuer den Zeitstrahl (dezenter
            // "AT"-Marker), fliesst NICHT in Rangliste/Punkte/Logging ein. Nur eine positive
            // Medaillenzeit gilt als vorhanden (0/-1 = "keine Medaille hinterlegt").
            $authorTime = (is_array($mapDoc['medals'] ?? null) && ($mapDoc['medals']['author'] ?? 0) > 0)
                ? $mapDoc['medals']['author'] : null;

            $onlineLogins = array_column($s['spieler'] ?? [], 'login');
            $records = alle($manager, $db, 'records', ['map' => $angefragteUid]);
            usort($records, fn($a, $b) => $a['time'] <=> $b['time']);
            $leaderZeit = $records[0]['time'] ?? null;

            $leaderboard = array_map(fn($r) => [
                'id' => oeffentlicheId($r['login']), // stabiler Schluessel fuer keyed Rendering/Animationen + Profil-Link
                'name' => $namen[$r['login']] ?? ('Spieler-' . oeffentlicheId($r['login'])),
                'zeit' => $r['time'],
                'gapMs' => $leaderZeit === null ? 0 : $r['time'] - $leaderZeit,
                'online' => in_array($r['login'], $onlineLogins, true),
            ], $records);

            echo json_encode([
                'map' => ['uid' => $angefragteUid, 'name' => $mapInfo['name'], 'author' => $mapInfo['author'], 'authorTime' => $authorTime],
                'istLiveMap' => $angefragteUid === $liveMapUid,
                'onlineSpieler' => array_map(fn($p) => $namen[$p['login']] ?? $p['name'] ?? ('Spieler-' . oeffentlicheId($p['login'])), $s['spieler'] ?? []),
                'leaderboard' => $leaderboard,
                'system' => $system,
                'server' => $serverInfo,
                'aktuell' => $aktuell,
                'zuletztAktualisiert' => $zuletztAktualisiert,
            ]);
            break;
        }

        case 'wartungsstatus': {
            // Oeffentlicher Wartungsmodus-Status (controller/plugins/monatswechselAutomatik.js
            // schreibt monatswechselStatus bei einem fehlgeschlagenen automatischen
            // Monatswechsel). Bewusst NUR wartungsmodus/grund/seit -- die technischen Details
            // ("schritt") bleiben dem Admin-Dashboard vorbehalten.
            $status = alle($manager, $db, 'monatswechselStatus', ['_id' => 'aktuell'])[0] ?? null;
            $seit = ($status['seit'] ?? null) instanceof MongoDB\BSON\UTCDateTime ? $status['seit']->toDateTime()->format(DATE_ATOM) : null;
            echo json_encode([
                'wartungsmodus' => $status['wartungsmodus'] ?? false,
                'grund' => $status['wartungsmodus'] ?? false ? ($status['grund'] ?? null) : null,
                'seit' => $seit,
            ]);
            break;
        }

        case 'cup': {
            // Cup-Turniersystem (Beta-Feature): naechstes/anstehendes Turnier + Anmeldestand -- fuer den
            // laufenden Cup siehe 'cupLive', fuer beendete 'cupHistorie'. Nie rohe Logins:
            // aus teilnehmer[] wird nur der Anzeigename ausgeliefert.
            $query = new MongoDB\Driver\Query(
                ['status' => ['$in' => ['angekuendigt', 'anmeldung']]],
                ['sort' => ['erstelltAm' => -1], 'limit' => 1]
            );
            $cursor = $manager->executeQuery("$db.cupTurniere", $query);
            $cursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);
            $turnier = $cursor->toArray()[0] ?? null;

            if ($turnier === null) { echo json_encode(['turnier' => null]); break; }

            echo json_encode(['turnier' => [
                'id' => (string) $turnier['_id'],
                'name' => $turnier['name'],
                'format' => $turnier['format'],
                'status' => $turnier['status'],
                // erstelltAm/geplanterStart sind in cupTurniere bereits ISO-Strings
                // (cupEngine.js ist eine reine Funktion ohne BSON-Bezug, siehe erzeugeTurnier()).
                'geplanterStart' => $turnier['geplanterStart'] ?? null,
                'teilnehmerAnzahl' => count($turnier['teilnehmer'] ?? []),
                'teilnehmer' => array_map(fn($t) => $t['name'] ?? '', $turnier['teilnehmer'] ?? []),
            ]]);
            break;
        }

        case 'cupLive': {
            // AP14f: Live-Snapshot des laufenden Turniers aus cupStatus (Muster wie
            // action=live -- Frischepruefung, da der Cup-Controller ein separater Prozess
            // ist, der auch mal nicht laufen kann). rangliste/letzteRunde kommen aus dem
            // internen Engine-Zustand und enthalten rohe Logins -- vor der Ausgabe entfernt.
            $status = alle($manager, $db, 'cupStatus', ['_id' => 'cup'])[0] ?? null;
            if ($status === null || !in_array($status['status'] ?? null, ['laeuft', 'siegerehrung'], true)) {
                echo json_encode(['aktiv' => false]);
                break;
            }

            $aktualisiertAmDt = ($status['updatedAt'] ?? null) instanceof MongoDB\BSON\UTCDateTime
                ? $status['updatedAt']->toDateTime() : null;
            $aktuell = $aktualisiertAmDt !== null && (time() - $aktualisiertAmDt->getTimestamp()) <= 15;
            if (!$aktuell) { echo json_encode(['aktiv' => false]); break; }

            $namen = spielerNamenIndex($manager, $db);
            $turnierDoc = !empty($status['turnierId'])
                ? (alle($manager, $db, 'cupTurniere', ['_id' => $status['turnierId']])[0] ?? null)
                : null;

            $letzteRunde = $status['letzteRunde'] ?? null;
            if ($letzteRunde !== null) {
                $letzteRunde = [
                    'rundenNr' => $letzteRunde['rundenNr'] ?? null,
                    'ergebnisse' => array_map(fn($e) => [
                        'name' => $namen[$e['login']] ?? ('Spieler-' . oeffentlicheId($e['login'])),
                        'platz' => $e['platz'],
                    ], $letzteRunde['ergebnisse'] ?? []),
                ];
            }

            echo json_encode([
                'aktiv' => true,
                'name' => $turnierDoc['name'] ?? '',
                'format' => $turnierDoc['format'] ?? null,
                'status' => $status['status'],
                'phaseName' => $status['phaseName'] ?? null,
                'teilnehmer' => $status['teilnehmer'] ?? [], // bereits Anzeigenamen, siehe cup.js sendeCupStatusSnapshot()
                'rangliste' => array_map(fn($r) => ['name' => $r['name'] ?? '', 'wert' => $r['wert'] ?? 0], $status['rangliste'] ?? []),
                'letzteRunde' => $letzteRunde,
            ]);
            break;
        }

        case 'cupHistorie': {
            // AP14f: beendete/abgebrochene Turniere fuer die Historie-Ansicht. Podium nur
            // die ersten 3 Endstand-Plaetze, nie rohe Logins.
            $query = new MongoDB\Driver\Query(
                ['status' => ['$in' => ['beendet', 'abgebrochen']]],
                ['sort' => ['abgeschlossenAm' => -1], 'limit' => 20]
            );
            $cursor = $manager->executeQuery("$db.cupTurniere", $query);
            $cursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);

            echo json_encode(array_map(fn($t) => [
                'id' => (string) $t['_id'],
                'name' => $t['name'],
                'format' => $t['format'],
                'status' => $t['status'],
                'abgeschlossenAm' => $t['abgeschlossenAm'] ?? null,
                'teilnehmerAnzahl' => count($t['teilnehmer'] ?? []),
                'podium' => array_map(fn($e) => ['platz' => $e['platz'], 'name' => $e['name']], array_slice($t['endstand'] ?? [], 0, 3)),
            ], $cursor->toArray()));
            break;
        }

        case 'cupDetail': {
            // AP14f: Detailansicht eines einzelnen Turniers (Endstand + Verlaufslog).
            $id = $_GET['id'] ?? '';
            try {
                $filter = ['_id' => new MongoDB\BSON\ObjectId($id)];
            } catch (Exception $e) {
                http_response_code(400); echo json_encode(['error' => 'Ungueltige Turnier-ID']); break;
            }
            $turnier = alle($manager, $db, 'cupTurniere', $filter)[0] ?? null;
            if ($turnier === null) { http_response_code(404); echo json_encode(['error' => 'Turnier nicht gefunden']); break; }

            // Ein paar ereignisLog-Texte in cupEngine.js betten den rohen Login direkt ein
            // (spielerGetrennt/-Verbunden, admin spielerEntfernen/-Reinholen) -- vor der
            // Ausgabe durch den Anzeigenamen ersetzen (nie roh an den Client).
            $namen = spielerNamenIndex($manager, $db);
            $ereignisLog = array_map(function ($e) use ($namen) {
                $text = $e['text'] ?? '';
                foreach ($namen as $login => $name) {
                    if (str_contains($text, $login)) $text = str_replace($login, $name, $text);
                }
                return ['zeit' => $e['zeit'] ?? null, 'text' => $text];
            }, $turnier['ereignisLog'] ?? []);

            echo json_encode([
                'id' => (string) $turnier['_id'],
                'name' => $turnier['name'],
                'format' => $turnier['format'],
                'status' => $turnier['status'],
                'erstelltAm' => $turnier['erstelltAm'] ?? null,
                'geplanterStart' => $turnier['geplanterStart'] ?? null,
                'abgeschlossenAm' => $turnier['abgeschlossenAm'] ?? null,
                'teilnehmerAnzahl' => count($turnier['teilnehmer'] ?? []),
                'endstand' => array_map(fn($e) => ['platz' => $e['platz'], 'name' => $e['name']], $turnier['endstand'] ?? []),
                'ereignisLog' => $ereignisLog,
            ]);
            break;
        }

        case 'serverLog': {
            // Live-Ereignis-Log fuers Dashboard (index.html). Cursor-basiertes Delta-Polling
            // ueber die _id (monoton), robuster als ueber Zeitstempel (keine Uhrzeit-Ungenauigkeiten).
            // Optionaler typ-Filter (whitelisted) fuer den separaten "Zuletzt verbessert"-Ticker,
            // damit dieser unabhaengig vom ungefilterten Gaming-Log pollen kann.
            $seitId = $_GET['seitId'] ?? null;
            $typWhitelist = ['rekord'];
            $typ = $_GET['typ'] ?? null;
            $filter = [];
            if ($typ !== null && in_array($typ, $typWhitelist, true)) {
                $filter['typ'] = $typ;
            }
            if ($seitId) {
                try {
                    $filter['_id'] = ['$gt' => new MongoDB\BSON\ObjectId($seitId)];
                } catch (Exception $e) {
                    // ungueltige seitId ignorieren, restlichen Filter (z.B. typ) beibehalten
                }
            }

            $query = new MongoDB\Driver\Query($filter, ['sort' => ['zeit' => $seitId ? 1 : -1], 'limit' => 50]);
            $cursor = $manager->executeQuery("$db.serverEvents", $query);
            $cursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);
            $eintraege = $cursor->toArray();
            if (!$seitId) $eintraege = array_reverse($eintraege);

            echo json_encode(array_map(fn($e) => [
                'id' => (string) $e['_id'],
                'typ' => $e['typ'],
                'text' => $e['text'],
                'zeit' => $e['zeit'] instanceof MongoDB\BSON\UTCDateTime ? $e['zeit']->toDateTime()->format(DATE_ATOM) : null,
            ], $eintraege));
            break;
        }

        case 'spieler': {
            $id = $_GET['id'] ?? '';
            if ($id === '') { http_response_code(400); echo json_encode(['error' => 'Parameter id fehlt']); break; }

            $namen = spielerNamenIndex($manager, $db);
            $login = null;
            $name = null;
            foreach ($namen as $l => $n) {
                if (oeffentlicheId($l) === $id) { $login = $l; $name = $n; break; }
            }
            if ($login === null) { http_response_code(404); echo json_encode(['error' => 'Spieler nicht gefunden']); break; }

            // Monatsperformance: NUR eingefrorene (abgeschlossene) Monate aus monthlyRankings --
            // der laufende Monat gehoert zu "live" (siehe unten), nicht in diese Historie.
            $verlauf = [];
            foreach (alle($manager, $db, 'monthlyRankings') as $mr) {
                foreach ($mr['eintraege'] as $i => $e) {
                    if ($e['login'] === $login) {
                        // eintraege ist bereits absteigend nach Punkten sortiert -> Index+1 = Platz
                        $verlauf[] = ['monat' => $mr['monat'], 'punkte' => $e['punkte'], 'siege' => $e['siege'], 'mapsGespielt' => $e['mapsGespielt'], 'platz' => $i + 1, 'teilnehmer' => count($mr['eintraege'])];
                        break;
                    }
                }
            }
            usort($verlauf, fn($a, $b) => strcmp(sortSchluesselFuerMonat($a['monat']), sortSchluesselFuerMonat($b['monat'])));

            // Live: aktueller, noch NICHT eingefrorener Monat (aus "records", live berechnet)
            $laufenderMonat = date('Y-m');
            $live = null;
            $liveRanking = berechneRanking(alle($manager, $db, 'records'), $namen);
            foreach ($liveRanking as $i => $e) {
                if ($e['login'] === $login) {
                    $live = ['monat' => $laufenderMonat, 'punkte' => $e['punkte'], 'siege' => $e['siege'], 'mapsGespielt' => $e['mapsGespielt'], 'platz' => $i + 1, 'teilnehmer' => count($liveRanking)];
                    break;
                }
            }

            // Jahres-Verlauf aus yearlyRankings
            $jahresVerlauf = [];
            foreach (alle($manager, $db, 'yearlyRankings') as $yr) {
                foreach ($yr['eintraege'] as $i => $e) {
                    if ($e['login'] === $login) {
                        $jahresVerlauf[] = ['jahr' => $yr['jahr'], 'punkte' => $e['punkte'], 'siege' => $e['siege'], 'mapsGespielt' => $e['mapsGespielt'], 'platz' => $i + 1, 'teilnehmer' => count($yr['eintraege'])];
                        break;
                    }
                }
            }
            usort($jahresVerlauf, fn($a, $b) => strcmp($a['jahr'], $b['jahr']));

            // Overall / Hall of Fame -- gleiche Berechnung wie action=hof
            $alleRecords = array_merge(alle($manager, $db, 'archivRecords'), alle($manager, $db, 'records'));
            $hofRanking = berechneRanking($alleRecords, $namen);
            $hof = null;
            foreach ($hofRanking as $i => $e) {
                if ($e['login'] === $login) {
                    $hof = ['rang' => $i + 1, 'teilnehmer' => count($hofRanking), 'punkte' => $e['punkte'], 'siege' => $e['siege'], 'mapsGespielt' => $e['mapsGespielt']];
                    break;
                }
            }

            $stats = alle($manager, $db, 'playerStats', ['login' => $login]);
            $stat = $stats[0] ?? null;

            // Errungenschaften: Katalog kommt vom Controller (errungenschaftenKatalog, siehe
            // controller/plugins/errungenschaften.js -- seedKatalog()), damit die Texte nicht
            // dupliziert gepflegt werden muessen. Geheime, noch nicht erreichte Abzeichen duerfen
            // NIE Name/Beschreibung/Icon/ID an den Client geben (der Slug wuerde den Namen verraten).
            $katalog = alle($manager, $db, 'errungenschaftenKatalog');
            usort($katalog, fn($a, $b) => ($a['reihenfolge'] ?? 0) <=> ($b['reihenfolge'] ?? 0));
            $eigeneVergaben = [];
            foreach (alle($manager, $db, 'errungenschaften', ['login' => $login]) as $v) {
                $eigeneVergaben[$v['errungenschaft']] = $v;
            }
            $errungenschaften = array_map(function ($e) use ($eigeneVergaben) {
                $vergabe = $eigeneVergaben[$e['id']] ?? null;
                if ($vergabe === null && !empty($e['geheim'])) {
                    return ['geheim' => true, 'erreicht' => false];
                }
                $erreichtAm = $vergabe['erreichtAm'] ?? null;
                return [
                    'id' => $e['id'],
                    'name' => $e['name'],
                    'beschreibung' => $e['beschreibung'],
                    'icon' => $e['icon'] ?? '',
                    'geheim' => !empty($e['geheim']),
                    'erreicht' => $vergabe !== null,
                    'erreichtAm' => $erreichtAm instanceof MongoDB\BSON\UTCDateTime ? $erreichtAm->toDateTime()->format(DATE_ATOM) : null,
                ];
            }, $katalog);

            echo json_encode([
                'id' => $id,
                'name' => $name,
                'live' => $live,
                'verlauf' => $verlauf,
                'jahresVerlauf' => $jahresVerlauf,
                'hof' => $hof,
                // Hinweis: "Siege" kommt bewusst NICHT von hier, sondern aus hof.siege/verlauf[].siege
                // (Hall-of-Fame-Rangberechnung). playerStats.wins wird von NextControl im TimeAttack-
                // Modus nie befuellt (kein "Match-Gewinner"-Callback in diesem Spielmodus) und waere immer 0.
                'stats' => $stat ? [
                    'timePlayed' => $stat['timePlayed'] ?? 0,
                    'finishes' => $stat['finishes'] ?? 0,
                    'checkpoints' => $stat['checkpoints'] ?? 0,
                    'connections' => $stat['connections'] ?? 0,
                ] : null,
                'errungenschaften' => $errungenschaften,
                'errungenschaftenGesamt' => count($katalog),
            ]);
            break;
        }

        case 'alleSpielerStats': {
            // Fuer die Spielerstats-UEBERSICHTSSEITE: bewusst NUR Daten des laufenden Monats,
            // keine Hall-of-Fame-Vermischung -- Punkte/Siege/Maps kommen aus "records" (laufender
            // Monat, wie index.html "Punkte-Rangliste diesen Monat"), NICHT aus archivRecords.
            // Spielzeit/Finishes/Checkpoints/Verbindungen kommen aus den Monats-Zaehlern in
            // playerStats (timePlayedMonat/finishesMonat/checkpointsMonat/connectionsMonat, werden
            // bei jedem Monatswechsel auf 0 gesetzt, siehe scripts/monatswechsel.js). Sie werden
            // bewusst unter den kurzen Feldnamen ausgeliefert, weil auf DIESER Seite alles
            // monatsbezogen ist. Nur Spieler MIT mindestens einer gefahrenen Zeit in diesem Monat
            // werden gelistet (kein Karteileichen-Rauschen).
            // Die kumulierten Allzeit-/HOF-Werte gehoeren auf die Einzelspielerseite
            // (spieler.html: Live -> Monat -> Jahr -> Hall of Fame).
            // Datenaufbereitung: monatsStatsLive() (gemeinsam mit action=monat).
            $liveDaten = monatsStatsLive($manager, $db);
            echo json_encode(array_map(function ($e) {
                $e['id'] = oeffentlicheId($e['login']);
                unset($e['login']);
                return $e;
            }, $liveDaten['eintraege']));
            break;
        }

        case 'voting': {
            // Aktueller Voting-Status (aus telegram.js: starteMapAbstimmung()/schliesseMapAbstimmung())
            // + Karma-Uebersicht der Maps des laufenden Monats.
            $statusDocs = alle($manager, $db, 'abstimmungStatus', ['_id' => 'aktuell']);
            $status = $statusDocs[0] ?? null;

            $maps = alle($manager, $db, 'maps');
            $karmaProMap = [];
            foreach (alle($manager, $db, 'karma') as $k) {
                if (!isset($karmaProMap[$k['map']])) $karmaProMap[$k['map']] = ['summe' => 0, 'anzahl' => 0];
                $karmaProMap[$k['map']]['summe'] += $k['score'];
                $karmaProMap[$k['map']]['anzahl'] += 1;
            }
            $karmaUebersicht = array_map(function ($m) use ($karmaProMap) {
                $k = $karmaProMap[$m['uid']] ?? null;
                return [
                    'name' => $m['name'] ?? '',
                    'schnitt' => $k ? round($k['summe'] / $k['anzahl'], 1) : null,
                    'stimmen' => $k['anzahl'] ?? 0,
                ];
            }, $maps);
            usort($karmaUebersicht, fn($a, $b) => ($b['schnitt'] ?? -1) <=> ($a['schnitt'] ?? -1));

            echo json_encode([
                'abstimmung' => $status ? [
                    'aktiv' => (bool)($status['aktiv'] ?? false),
                    'monat' => $status['monat'] ?? null,
                    'gestartetAm' => $status['gestartetAm'] ?? null,
                    'geplantesEnde' => $status['geplantesEnde'] ?? null,
                    'kandidaten' => array_map(fn($k) => [
                        'name' => $k['name'] ?? '',
                        'beschreibung' => $k['beschreibung'] ?? null,
                        'aehnlich' => (bool)($k['aehnlich'] ?? false),
                        'stimmen' => $k['stimmen'] ?? 0,
                    ], $status['kandidaten'] ?? []),
                    'gewinner' => $status['gewinner'] ?? null,
                    'abgeschlossenAm' => $status['abgeschlossenAm'] ?? null,
                ] : null,
                'karma' => array_values($karmaUebersicht),
            ]);
            break;
        }

        case 'tagesberichteKalender': {
            // AP17-Nachtrag: Jahres-Heatmap statt Liste -- liefert nur die schlanken Zaehlwerte
            // je Tag (fuer die Zellenfarbe), der volle Bericht kommt erst bei Klick ueber
            // action=tagesbericht. Enthaelt nur Spielernamen, keine Logins.
            $jahrParam = $_GET['jahr'] ?? '';
            $jahrHeute = (int) date('Y');
            $jahr = preg_match('/^\d{4}$/', $jahrParam) ? (int) $jahrParam : $jahrHeute;

            $tageQuery = new MongoDB\Driver\Query(
                ['datum' => ['$gte' => "$jahr-01-01", '$lte' => "$jahr-12-31"]],
                ['sort' => ['datum' => 1]]
            );
            $tageCursor = $manager->executeQuery("$db.tagesberichte", $tageQuery);
            $tageCursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);
            $tage = $tageCursor->toArray();

            // Min-Jahr mit Daten fuer die Vor/Zurueck-Navigation im Frontend -- eine
            // 1-Dokument-Abfrage statt eines vollen distinct-Scans.
            $minSortQuery = new MongoDB\Driver\Query([], ['sort' => ['datum' => 1], 'limit' => 1]);
            $minCursor = $manager->executeQuery("$db.tagesberichte", $minSortQuery);
            $minCursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);
            $minDoc = $minCursor->toArray()[0] ?? null;
            $minJahr = $minDoc !== null ? (int) substr($minDoc['datum'], 0, 4) : $jahrHeute;

            echo json_encode([
                'jahr' => $jahr,
                'minJahr' => min($minJahr, $jahrHeute),
                'maxJahr' => $jahrHeute,
                'tage' => array_map(fn($t) => [
                    'datum' => $t['datum'] ?? null,
                    'anzahlSpieler' => $t['anzahlSpieler'] ?? 0,
                    'anzahlVerbesserungen' => $t['anzahlVerbesserungen'] ?? 0,
                ], $tage),
            ]);
            break;
        }

        case 'tagesbericht': {
            $datum = $_GET['datum'] ?? '';
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $datum)) {
                http_response_code(400); echo json_encode(['error' => 'Parameter datum fehlt oder ungueltig (erwartet YYYY-MM-DD)']); break;
            }

            $treffer = alle($manager, $db, 'tagesberichte', ['datum' => $datum]);
            $t = $treffer[0] ?? null;
            if ($t === null) {
                http_response_code(404); echo json_encode(['error' => 'Kein Tagesbericht fuer dieses Datum']); break;
            }

            echo json_encode([
                'id' => (string) $t['_id'],
                'datum' => $t['datum'] ?? null,
                'erstelltAm' => ($t['erstelltAm'] ?? null) instanceof MongoDB\BSON\UTCDateTime ? $t['erstelltAm']->toDateTime()->format(DATE_ATOM) : null,
                'anzahlSpieler' => $t['anzahlSpieler'] ?? 0,
                'anzahlVerbesserungen' => $t['anzahlVerbesserungen'] ?? 0,
                'verbesserungen' => array_map(fn($v) => [
                    'name' => $v['name'] ?? '',
                    'anzahl' => $v['anzahl'] ?? 0,
                ], $t['verbesserungen'] ?? []),
                'monatstabelle' => array_map(fn($s) => [
                    'name' => $s['name'] ?? '',
                    'punkte' => $s['punkte'] ?? 0,
                    'position' => $s['position'] ?? 0,
                    'trend' => $s['trend'] ?? '',
                ], $t['monatstabelle'] ?? []),
            ]);
            break;
        }

        case 'analysenHistorie': {
            // Fuer die Lauf-Auswahl in analysen.html -- nur die Kopfdaten, keine Kennzahlen/Texte.
            $query = new MongoDB\Driver\Query([], [
                'sort' => ['erstelltAm' => -1],
                'limit' => 30,
                'projection' => ['erstelltAm' => 1, 'ausloeser' => 1, 'berichtTyp' => 1, 'textStatus' => 1, 'modell' => 1],
            ]);
            $cursor = $manager->executeQuery("$db.kiAnalysen", $query);
            $cursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);
            echo json_encode(array_map(fn($l) => [
                'id' => (string) $l['_id'],
                'erstelltAm' => ($l['erstelltAm'] ?? null) instanceof MongoDB\BSON\UTCDateTime ? $l['erstelltAm']->toDateTime()->format(DATE_ATOM) : null,
                'ausloeser' => $l['ausloeser'] ?? null,
                // AP17-Nachtrag: Laeufe vor der Wochen-/Monats-Trennung haben kein berichtTyp-Feld --
                // sie waren inhaltlich alle vom bisherigen (jetzt "woche" genannten) Typ.
                'berichtTyp' => $l['berichtTyp'] ?? 'woche',
                'textStatus' => $l['textStatus'] ?? null,
                'modell' => $l['modell'] ?? null,
            ], $cursor->toArray()));
            break;
        }

        case 'analysen': {
            // Ohne "lauf"-Parameter: neuester Lauf. Mit: genau dieser (Lauf-Auswahl im Frontend).
            $laufId = $_GET['lauf'] ?? null;
            if ($laufId !== null) {
                try {
                    $filter = ['_id' => new MongoDB\BSON\ObjectId($laufId)];
                } catch (Exception $e) {
                    http_response_code(400);
                    echo json_encode(['error' => 'Ungueltige Lauf-ID']);
                    break;
                }
                $query = new MongoDB\Driver\Query($filter);
            } else {
                $query = new MongoDB\Driver\Query([], ['sort' => ['erstelltAm' => -1], 'limit' => 1]);
            }
            $cursor = $manager->executeQuery("$db.kiAnalysen", $query);
            $cursor->setTypeMap(['root' => 'array', 'document' => 'array', 'array' => 'array']);
            $lauf = $cursor->toArray()[0] ?? null;

            if ($lauf === null) {
                echo json_encode(['lauf' => null]);
                break;
            }

            echo json_encode([
                'lauf' => [
                    'id' => (string) $lauf['_id'],
                    'erstelltAm' => ($lauf['erstelltAm'] ?? null) instanceof MongoDB\BSON\UTCDateTime ? $lauf['erstelltAm']->toDateTime()->format(DATE_ATOM) : null,
                    'ausloeser' => $lauf['ausloeser'] ?? null,
                    'berichtTyp' => $lauf['berichtTyp'] ?? 'woche',
                    'modell' => $lauf['modell'] ?? null,
                    'zeitraum' => $lauf['zeitraum'] ?? null,
                    // Logins NIEMALS im Klartext an den Client -- siehe anonymisiereLogins() oben.
                    'kennzahlen' => anonymisiereLogins($lauf['kennzahlen'] ?? []),
                    'texte' => $lauf['texte'] ?? null,
                    'textStatus' => $lauf['textStatus'] ?? null,
                    'telegramGesendetAm' => ($lauf['telegramGesendetAm'] ?? null) instanceof MongoDB\BSON\UTCDateTime
                        ? $lauf['telegramGesendetAm']->toDateTime()->format(DATE_ATOM)
                        : null,
                ],
            ]);
            break;
        }

        case 'mapInfo': {
            // TMX-Map-Info-Widget (Live-Seite): rein informativ, Cache in tmxMapInfo
            // (7 Tage bei Treffer/echtem Nicht-Fund, 1h Negativ-Cache bei TMX-Ausfall,
            // damit trackmania.exchange nicht bei jedem 5s-Poll angefragt wird).
            $uid = $_GET['uid'] ?? '';
            if (!preg_match('/^[A-Za-z0-9_-]{10,40}$/', $uid)) {
                echo json_encode(['gefunden' => false, 'daten' => null]);
                break;
            }

            $cacheDoc = alle($manager, $db, 'tmxMapInfo', ['_id' => $uid])[0] ?? null;
            $geladenAmDt = ($cacheDoc['geladenAm'] ?? null) instanceof MongoDB\BSON\UTCDateTime
                ? $cacheDoc['geladenAm']->toDateTime() : null;

            $frisch = false;
            if ($cacheDoc !== null && $geladenAmDt !== null) {
                $alterSekunden = time() - $geladenAmDt->getTimestamp();
                $frisch = !empty($cacheDoc['fehler']) ? ($alterSekunden < 3600) : ($alterSekunden < 7 * 86400);
            }

            if (!$frisch) {
                $neuesErgebnis = tmxMapInfoAbrufen($uid);
                // TMX gerade nicht erreichbar, aber ein alter Treffer vorhanden: lieber
                // veraltete Daten zeigen als das Widget leer zu lassen (stale-while-error).
                if ($neuesErgebnis['fehler'] && $cacheDoc !== null && !empty($cacheDoc['gefunden'])) {
                    $neuesErgebnis['daten'] = $cacheDoc['daten'];
                    $neuesErgebnis['gefunden'] = true;
                }
                upsertEins($manager, $db, 'tmxMapInfo', $uid, [
                    'geladenAm' => new MongoDB\BSON\UTCDateTime(),
                    'gefunden' => $neuesErgebnis['gefunden'],
                    'fehler' => $neuesErgebnis['fehler'],
                    'daten' => $neuesErgebnis['daten'],
                ]);
                $cacheDoc = ['gefunden' => $neuesErgebnis['gefunden'], 'daten' => $neuesErgebnis['daten']];
            }

            echo json_encode(['gefunden' => (bool) ($cacheDoc['gefunden'] ?? false), 'daten' => $cacheDoc['daten'] ?? null]);
            break;
        }

        default:
            http_response_code(400);
            echo json_encode(['error' => 'Unbekannte oder fehlende action']);
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
