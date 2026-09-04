<?php
// punkte.php -- FIXIERTE Punkteformel (identisch zu scripts/lib/punkte.js).
// Aenderungen nur auf ausdruecklichen Wunsch des Betreibers.

function calculatePoints(int $rank): int {
    if ($rank === 1) return 1000;
    if ($rank === 2) return 800;
    if ($rank === 3) return 600;
    if ($rank <= 5) return 500;
    if ($rank <= 10) return 400;
    if ($rank <= 20) return 300;
    if ($rank <= 50) return 200;
    if ($rank <= 100) return 100;
    if ($rank <= 200) return 50;
    return max(10, intdiv(1000, $rank));
}

/**
 * @param array $records Liste von ['login'=>string,'time'=>int,'map'=>string]
 * @param array $spielerNamen login => Anzeigename
 * @return array sortiert nach Punkten absteigend: [['login','name','punkte','siege','mapsGespielt']]
 */
function berechneRanking(array $records, array $spielerNamen): array {
    $proMap = [];
    foreach ($records as $r) {
        if (empty($r['map']) || empty($r['login'])) continue;
        $proMap[$r['map']][] = $r;
    }

    $spieler = [];
    foreach ($proMap as $mapRecords) {
        usort($mapRecords, fn($a, $b) => $a['time'] <=> $b['time']);
        $gezaehlt = [];
        foreach ($mapRecords as $i => $r) {
            $rank = $i + 1;
            $login = $r['login'];
            if (!isset($spieler[$login])) {
                $spieler[$login] = [
                    'login' => $login,
                    'name' => $spielerNamen[$login] ?? $login,
                    'punkte' => 0,
                    'siege' => 0,
                    'mapsGespielt' => 0,
                ];
            }
            $spieler[$login]['punkte'] += calculatePoints($rank);
            if ($rank === 1) $spieler[$login]['siege']++;
            if (!isset($gezaehlt[$login])) {
                $spieler[$login]['mapsGespielt']++;
                $gezaehlt[$login] = true;
            }
        }
    }

    $ergebnis = array_values($spieler);
    usort($ergebnis, fn($a, $b) => $b['punkte'] <=> $a['punkte']);
    return $ergebnis;
}

/** Oeffentliche, stabile Spieler-ID ohne den rohen Ubisoft-Login preiszugeben. */
function oeffentlicheId(string $login): string {
    return substr(hash('sha256', $login), 0, 12);
}

// -- Jahres-Ebene (siehe scripts/lib/jahreszyklus.js -- identische Logik) ----

const ZYKLUS_START_MONAT = '2026-08';
const LEGACY_JAHR_LABEL = '2025/26';

// Monat, ab dem Aktivitaetsdaten in den Datensatz uebernommen werden.
// Betreiber-Entscheidung 2026-07-18: siehe scripts/lib/jahreszyklus.js.
const AKTIVITAET_SEIT_MONAT = ZYKLUS_START_MONAT;

/** Jahres-Zyklus ("YYYY/YY") fuer einen Monat ("YYYY-MM"). Siehe scripts/lib/jahreszyklus.js.
 *  Pseudo-Monate ("season:Fall2020", "unbekannt") gehoeren zum Alt-Jahrgang. */
function jahresZyklusFuerMonat(string $monat): array {
    if (!preg_match('/^\d{4}-\d{2}$/', $monat) || $monat < ZYKLUS_START_MONAT) {
        return ['jahr' => LEGACY_JAHR_LABEL, 'start' => null, 'ende' => '2026-07'];
    }
    [$zJahr, $zMonat] = array_map('intval', explode('-', ZYKLUS_START_MONAT));
    [$mJahr, $mMonat] = array_map('intval', explode('-', $monat));
    $diffMonate = ($mJahr - $zJahr) * 12 + ($mMonat - $zMonat);
    $zyklusIndex = intdiv($diffMonate, 12);
    $startJahr = $zJahr + $zyklusIndex;
    $endeJahr = $startJahr + 1;
    return [
        'jahr' => sprintf('%d/%02d', $startJahr, $endeJahr % 100),
        'start' => sprintf('%d-08', $startJahr),
        'ende' => sprintf('%d-07', $endeJahr),
    ];
}

/** Fasst mehrere monthlyRankings-Eintraege zu einer Jahresrangliste zusammen. */
function fasseJahrZusammen(array $monatsRankings): array {
    $spieler = [];
    foreach ($monatsRankings as $mr) {
        foreach ($mr['eintraege'] as $e) {
            if (!isset($spieler[$e['login']])) {
                $spieler[$e['login']] = ['login' => $e['login'], 'name' => $e['name'], 'punkte' => 0, 'siege' => 0, 'mapsGespielt' => 0];
            }
            $spieler[$e['login']]['punkte'] += $e['punkte'];
            $spieler[$e['login']]['siege'] += $e['siege'];
            $spieler[$e['login']]['mapsGespielt'] += $e['mapsGespielt'];
            $spieler[$e['login']]['name'] = $e['name'];
        }
    }
    $ergebnis = array_values($spieler);
    usort($ergebnis, fn($a, $b) => $b['punkte'] <=> $a['punkte']);
    return $ergebnis;
}

/**
 * Summiert die eingefrorenen Aktivitaets-Snapshots (monthlyRankings-Dokumente
 * mit "aktivitaet"-Array) je Spieler auf. Identische Logik zu
 * fasseAktivitaetZusammen() in scripts/lib/jahreszyklus.js.
 * @return array ['aktivitaet' => [['login','timePlayed','connections','finishes','checkpoints']],
 *                'erfassteMonate' => ['YYYY-MM', ...]]
 */
function fasseAktivitaetZusammen(array $monatsRankings): array {
    $spieler = [];
    $erfassteMonate = [];
    foreach ($monatsRankings as $mr) {
        if (empty($mr['aktivitaetErfasst']) || !is_array($mr['aktivitaet'] ?? null)) continue;
        $erfassteMonate[] = $mr['monat'];
        foreach ($mr['aktivitaet'] as $a) {
            $login = $a['login'];
            if (!isset($spieler[$login])) {
                $spieler[$login] = ['login' => $login, 'timePlayed' => 0, 'connections' => 0, 'finishes' => 0, 'checkpoints' => 0];
            }
            $spieler[$login]['timePlayed'] += $a['timePlayed'] ?? 0;
            $spieler[$login]['connections'] += $a['connections'] ?? 0;
            $spieler[$login]['finishes'] += $a['finishes'] ?? 0;
            $spieler[$login]['checkpoints'] += $a['checkpoints'] ?? 0;
        }
    }
    sort($erfassteMonate);
    return ['aktivitaet' => array_values($spieler), 'erfassteMonate' => $erfassteMonate];
}
