// saison.js — Behandlung der historischen "season:..."-Monatstoken
// (z. B. "season:Fall2020"), die aus alten TM2020-Kampagnendateien stammen
// und einmalig von scripts/migrate.js erzeugt wurden. Nach dem Cutover
// entstehen keine neuen Season-Token mehr (scripts/monatswechsel.js liefert
// ausschließlich "YYYY-MM"). Siehe docs/SYSTEM.md, Abschnitt "Season-
// Sonderfall". PHP-Zwilling: website/lib/saison.php.

const SAISON_MONAT = { Winter: '12', Spring: '03', Summer: '06', Fall: '09' };
const SAISON_NAME = { Winter: 'Winter', Spring: 'Frühling', Summer: 'Sommer', Fall: 'Herbst' };

/**
 * Erkennt einen Season-Token und liefert Sortier-/Anzeige-Infos.
 * @param {string} monat z. B. "season:Fall2020" oder "2026-07"
 * @returns {{sortSchluessel: string, label: string, kurzLabel: string}|null}
 *          null, wenn monat kein Season-Token ist (regulärer "YYYY-MM"-Monat)
 */
export function parseSaisonToken(monat) {
    const m = /^season:(Winter|Spring|Summer|Fall)(\d{4})$/.exec(monat);
    if (!m) return null;
    const [, saison, jahr] = m;
    return {
        sortSchluessel: `${jahr}-${SAISON_MONAT[saison]}`,
        label: `Vorsaison ${SAISON_NAME[saison]} ${jahr}`,
        kurzLabel: `${SAISON_NAME[saison]} ${jahr.slice(2)}`,
    };
}

/** Chronologischer Sortierschlüssel ("YYYY-MM") — für Season-Token wie parseSaisonToken, sonst der Monat selbst. */
export function sortSchluesselFuerMonat(monat) {
    return parseSaisonToken(monat)?.sortSchluessel ?? monat;
}

/** Kurzes Anzeige-Label für Chart-Achsen/Tabellenzellen — "07" bei "YYYY-MM", "Herbst 20" bei Season-Token. */
export function kurzLabelFuerMonat(monat) {
    return parseSaisonToken(monat)?.kurzLabel ?? monat.slice(5);
}
