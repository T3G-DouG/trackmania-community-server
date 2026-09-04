<?php
// saison.php -- Behandlung der historischen "season:..."-Monatstoken (identische
// Logik zu scripts/lib/saison.js). Siehe docs/SYSTEM.md, Abschnitt "Season-Sonderfall".

const SAISON_MONAT = ['Winter' => '12', 'Spring' => '03', 'Summer' => '06', 'Fall' => '09'];
const SAISON_NAME = ['Winter' => 'Winter', 'Spring' => 'Frühling', 'Summer' => 'Sommer', 'Fall' => 'Herbst'];

/**
 * Erkennt einen Season-Token und liefert Sortier-/Anzeige-Infos.
 * @return array{sortSchluessel:string,label:string,kurzLabel:string}|null
 *         null, wenn $monat kein Season-Token ist (regulaerer "YYYY-MM"-Monat)
 */
function parseSaisonToken(string $monat): ?array {
    if (!preg_match('/^season:(Winter|Spring|Summer|Fall)(\d{4})$/', $monat, $m)) return null;
    [, $saison, $jahr] = $m;
    return [
        'sortSchluessel' => "$jahr-" . SAISON_MONAT[$saison],
        'label' => 'Vorsaison ' . SAISON_NAME[$saison] . " $jahr",
        'kurzLabel' => SAISON_NAME[$saison] . ' ' . substr($jahr, 2),
    ];
}

/** Chronologischer Sortierschluessel ("YYYY-MM") -- fuer Season-Token via parseSaisonToken, sonst der Monat selbst. */
function sortSchluesselFuerMonat(string $monat): string {
    return parseSaisonToken($monat)['sortSchluessel'] ?? $monat;
}
