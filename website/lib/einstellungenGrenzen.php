<?php
// einstellungenGrenzen.php -- PHP-Zwilling der Validierungsregeln aus
// controller/lib/laufzeitEinstellungen.js (GRENZEN/MODELLE/defaults). Wird von
// admin-api.php genutzt, um systemSettings-Schreibzugriffe vom Dashboard aus
// serverseitig zu klemmen. Der Controller normalisiert beim naechsten Poll ohnehin
// nochmal (siehe laufzeitEinstellungen.js normalisiere()) -- zwei unabhaengige
// Absicherungen, damit ein Bug in einer Sprache die Kostendeckel nicht aushebelt.
//
// Bei Aenderungen an den Grenzen/Modellen: IMMER beide Seiten (hier + die JS-Datei)
// gemeinsam anpassen, wie bei scripts/lib/punkte.js <-> website/lib/punkte.php.

const ADMIN_MODELLE = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];

// AP16b: Budget-Guard-Mindestabstand zwischen zwei Analyse-Laeufen (egal ob automatisch oder
// manuell) -- Zwilling von BUDGET_GUARD_STUNDEN in controller/lib/analyse/automatikTakt.js.
// Wird hier nur fuer die "naechster Lauf erst ab..."-Anzeige im Dashboard gebraucht (Skript-
// only Wertebereichs-Pruefung, die eigentliche Durchsetzung passiert im Controller).
const ADMIN_ANALYSE_BUDGET_GUARD_STUNDEN = 24;

// Regex-Zwilling von UHRZEIT_MUSTER in controller/lib/laufzeitEinstellungen.js.
const ADMIN_UHRZEIT_MUSTER = '/^([01]\d|2[0-3]):([0-5]\d)$/';

const ADMIN_GRENZEN = [
    'rennleitung' => [
        'minAbstandMs' => ['min' => 10_000, 'max' => 5 * 60_000],
        'ambientAbstandMs' => ['min' => 60_000, 'max' => 30 * 60_000],
        'maxProStunde' => ['min' => 1, 'max' => 30],
    ],
    'nachrichtenKi' => [
        'maxProStunde' => ['min' => 1, 'max' => 300],
    ],
];

// Nur fuer die Anzeige, falls systemSettings noch kein Dokument (oder einen
// unvollstaendigen Bereich) enthaelt -- entspricht defaults() in laufzeitEinstellungen.js.
// Die tatsaechliche Autoritaet ueber "was gilt, wenn nichts gesetzt ist" bleibt beim
// Controller (controller/settings.js + laufzeitEinstellungen.js).
const ADMIN_DEFAULTS = [
    'rennleitung' => [
        'aktiv' => true,
        'modell' => 'claude-haiku-4-5',
        'minAbstandMs' => 45_000,
        'ambientAbstandMs' => 240_000,
        'maxProStunde' => 30,
    ],
    'nachrichtenKi' => [
        'aktiv' => true,
        'modell' => 'claude-haiku-4-5',
        'maxProStunde' => 300,
    ],
];

// AP16b: Zwilling von defaults().analyse in controller/lib/laufzeitEinstellungen.js. `analyse`
// hat eine andere Feldform (wochentag/uhrzeit statt der msKurr-Felder oben) und steht daher
// bewusst NICHT in ADMIN_GRENZEN -- admin-api.php validiert diesen Bereich separat ueber die
// Funktionen unten statt ueber die generische min/max-Klemmung.
const ADMIN_ANALYSE_DEFAULTS = [
    'modell' => 'claude-sonnet-5',
    'wochentag' => 0,
    'uhrzeit' => '19:30',
    'telegramBericht' => true,
];

// AP17: Zwilling von defaults().tagesreport in controller/lib/laufzeitEinstellungen.js. Kein
// LLM (rein deterministisch) -- daher nur aktiv/uhrzeit, analog zur eigenen Validierung wie
// beim analyse-Bereich statt der generischen min/max-Klemmung.
const ADMIN_TAGESREPORT_DEFAULTS = [
    'aktiv' => true,
    'uhrzeit' => '20:00',
];

/** Alle vom Dashboard beschreibbaren Bereiche -- admin-api.php prueft Anfragen dagegen. */
const ADMIN_BEREICHE = ['rennleitung', 'nachrichtenKi', 'analyse', 'tagesreport'];

/** Klemmt einen numerischen Wert auf [min,max] -- nicht-numerische Eingaben behalten den Fallback. */
function adminKlemme(array $bereichGrenze, $wert, $fallback) {
    if (!is_numeric($wert)) return $fallback;
    $wert = (float) $wert;
    return max($bereichGrenze['min'], min($bereichGrenze['max'], $wert));
}

/** 0=Sonntag .. 6=Samstag, Muster Date.getDay() (JS-Gegenstueck). */
function adminAnalyseWochentagGueltig($wert): bool {
    return is_int($wert) && $wert >= 0 && $wert <= 6;
}

function adminAnalyseUhrzeitGueltig($wert): bool {
    return is_string($wert) && preg_match(ADMIN_UHRZEIT_MUSTER, $wert) === 1;
}
