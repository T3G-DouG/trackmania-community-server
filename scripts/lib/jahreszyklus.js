// jahreszyklus.js — Jahres-Ebene zwischen Monatswertung und Hall of Fame.
//
// Der erste "echte" 12-Monats-Zyklus beginnt im August 2026 und läuft bis
// Juli 2027 ("Jahr 2026/27"), danach August 2027 - Juli 2028 ("2027/28")
// usw., immer weiter. Alle Monate VOR August 2026 (der bereits vorhandene,
// migrierte Datenbestand) werden auf ausdrücklichen Wunsch des Betreibers
// als ein einziger, fester Alt-Jahrgang "2025/26" zusammengefasst, damit
// auch die Altdaten dem gleichen Jahres-Muster folgen.

export const ZYKLUS_START_MONAT = '2026-08';
export const LEGACY_JAHR_LABEL = '2025/26';

// Monat, ab dem Aktivitaetsdaten (Spielzeit/Finishes/Checkpoints/Verbindungen)
// in den Datensatz uebernommen werden. Betreiber-Entscheidung 2026-07-18: die
// bereits vor dem Cutover (auf dem alten UND dem neuen Controller) gesammelten
// Live-Aktivitaetsdaten werden beim Umzug verworfen -- erst ab dem Umzug und
// dem Start der Saison 26/27 (== ZYKLUS_START_MONAT) erscheinen Aktivitaetsdaten
// im Datensatz. Punkte/Siege/Maps-Historie ist davon NICHT betroffen (die
// migriert AP6 vollstaendig und durchgaengig). Siehe docs/SYSTEM.md.
export const AKTIVITAET_SEIT_MONAT = ZYKLUS_START_MONAT;

/**
 * Ermittelt den Jahres-Zyklus, zu dem ein Monat ("YYYY-MM") gehört.
 * Pseudo-Monate ("season:Fall2020", "unbekannt") gehören zum Alt-Jahrgang.
 * @param {string} monat
 * @returns {{jahr: string, start: string|null, ende: string}}
 *          jahr = Anzeige-Label ("2026/27"), start/ende = erster/letzter Monat des Zyklus ("YYYY-MM")
 */
export function jahresZyklusFuerMonat(monat) {
    if (!/^\d{4}-\d{2}$/.test(monat) || monat < ZYKLUS_START_MONAT) {
        return { jahr: LEGACY_JAHR_LABEL, start: null, ende: '2026-07' };
    }
    const [zJahr, zMonat] = ZYKLUS_START_MONAT.split('-').map(Number);
    const [mJahr, mMonat] = monat.split('-').map(Number);
    const diffMonate = (mJahr - zJahr) * 12 + (mMonat - zMonat);
    const zyklusIndex = Math.floor(diffMonate / 12);
    const startJahr = zJahr + zyklusIndex;
    const endeJahr = startJahr + 1;
    return {
        jahr: `${startJahr}/${String(endeJahr % 100).padStart(2, '0')}`,
        start: `${startJahr}-08`,
        ende: `${endeJahr}-07`,
    };
}

/**
 * Fasst mehrere eingefrorene Monatsranglisten (monthlyRankings-Dokumente) zu
 * einer Jahresrangliste zusammen. Da jeder Monat eigene, noch nie zuvor
 * gespielte Maps hat, ist "Summe der Monatspunkte" exakt gleichwertig zu
 * einer Neuberechnung über alle Records des Jahres hinweg.
 * @param {Array<{monat: string, eintraege: Array<{login,name,punkte,siege,mapsGespielt}>}>} monatsRankings
 * @returns {Array<{login,name,punkte,siege,mapsGespielt}>} absteigend nach Punkten
 */
export function fasseJahrZusammen(monatsRankings) {
    const spieler = new Map();
    for (const mr of monatsRankings) {
        for (const e of mr.eintraege) {
            if (!spieler.has(e.login)) {
                spieler.set(e.login, { login: e.login, name: e.name, punkte: 0, siege: 0, mapsGespielt: 0 });
            }
            const s = spieler.get(e.login);
            s.punkte += e.punkte;
            s.siege += e.siege;
            s.mapsGespielt += e.mapsGespielt;
            s.name = e.name; // neuester bekannter Name gewinnt
        }
    }
    return [...spieler.values()].sort((a, b) => b.punkte - a.punkte);
}

/**
 * Summiert die beim Monatswechsel eingefrorenen Aktivitäts-Snapshots
 * (monthlyRankings-Dokumente mit "aktivitaet"-Array) je Spieler auf.
 * Monate ohne Snapshot (vor den Aufzeichnungen) tragen nichts bei.
 * @param {Array<{monat: string, aktivitaetErfasst?: boolean,
 *                aktivitaet?: Array<{login,timePlayed,connections,finishes,checkpoints}>}>} monatsRankings
 * @returns {{aktivitaet: Array<{login,timePlayed,connections,finishes,checkpoints}>,
 *            erfassteMonate: string[]}} erfassteMonate = sortierte Monate mit Snapshot
 */
export function fasseAktivitaetZusammen(monatsRankings) {
    const spieler = new Map();
    const erfassteMonate = [];
    for (const mr of monatsRankings) {
        if (!mr.aktivitaetErfasst || !Array.isArray(mr.aktivitaet)) continue;
        erfassteMonate.push(mr.monat);
        for (const a of mr.aktivitaet) {
            if (!spieler.has(a.login)) {
                spieler.set(a.login, { login: a.login, timePlayed: 0, connections: 0, finishes: 0, checkpoints: 0 });
            }
            const s = spieler.get(a.login);
            s.timePlayed += a.timePlayed ?? 0;
            s.connections += a.connections ?? 0;
            s.finishes += a.finishes ?? 0;
            s.checkpoints += a.checkpoints ?? 0;
        }
    }
    erfassteMonate.sort();
    return { aktivitaet: [...spieler.values()], erfassteMonate };
}
