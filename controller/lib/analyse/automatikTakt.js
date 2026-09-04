// automatikTakt.js — Ablaufsteuerung fuer die zwei automatischen
// Analyse-Laeufe -- woechentlich (nur das Wochengeschehen) und monatlich (der historische
// Rueckblick, siehe kennzahlen.js). Pure Funktionen (kein nextcontrol-Import, Muster wie
// kennzahlen.js/berichtLauf.js) -- direkt aus Testskripten aufrufbar, ohne den Controller/
// eine Plugin-Datei zu importieren (siehe Merkregel "nie Plugins direkt importieren":
// controller/plugins/*.js importiert transitiv nextcontrol.js, das sich beim Import selbst
// mit dem Live-Server verbindet).
//
// Zwei unabhaengige Guards je Berichtstyp:
// - Zeitfenster: woechentlich nur sonntagabends ab 19:30, monatlich nur am 2. des Monats ab
//   09:00 (ein Tag Puffer NACH dem Monatswechsel-Automatik-Lauf um 00:10, siehe
//   monatswechselAutomatik.js, damit der neu archivierte Monat garantiert schon vorliegt).
// - Budget-Guard: unabhaengig vom Ausloeser/Berichtstyp darf hoechstens alle
//   BUDGET_GUARD_STUNDEN ein Lauf stattfinden -- verhindert sowohl Kosten-Explosion bei
//   wiederholten manuellen Triggern als auch einen Doppel-Lauf, falls der Controller genau
//   im Ausloese-Fenster neu startet (die kiAnalysen-Collection ist die alleinige Quelle der
//   Wahrheit, kein In-Memory-Zustand -- ueberlebt jeden Neustart).

const COLLECTION = 'kiAnalysen';

/** Budget-Guard: Mindestabstand zwischen zwei Laeufen, egal welcher Ausloeser/Berichtstyp. */
export const BUDGET_GUARD_STUNDEN = 24;

/** Mindestabstand zwischen zwei AUTOMATISCHEN woechentlichen Laeufen. */
export const AUTO_LAUF_MIN_TAGE = 6;

/** Mindestabstand zwischen zwei AUTOMATISCHEN monatlichen Laeufen. */
export const AUTO_MONATS_LAUF_MIN_TAGE = 20;

/** Fallback-Zeitplan, falls kein/ein ungueltiger Wert uebergeben wird -- identisch zum bisherigen Festwert. */
const STANDARD_WOCHENTAG = 0; // Sonntag (Date.getDay())
const STANDARD_UHRZEIT = '19:30';

/** Monatlicher Lauf: fester Tag/Uhrzeit, bewusst nicht per Dashboard konfigurierbar (Muster monatswechselAutomatik.js). */
const MONATS_LAUF_TAG = 2;
const MONATS_LAUF_UHRZEIT = '09:00';

/**
 * True, wenn `jetzt` im woechentlichen Ausloese-Fenster liegt: `wochentag` ab `uhrzeitHHMM`
 * Uhr bis Tagesende. Bewusst ein ganztaegiges Fenster (nicht nur eine Minute) -- der
 * Stunden-Tick im Plugin prueft nicht minuetlich, und der AUTO_LAUF_MIN_TAGE-Guard sorgt
 * ohnehin dafuer, dass trotz des breiten Fensters nur einmal pro Woche tatsaechlich
 * gelaufen wird. `wochentag`/`uhrzeitHHMM` kommen optional aus dem Admin-Dashboard
 * (systemSettings.analyse, siehe laufzeitEinstellungen.js) -- Default entspricht dem
 * bisherigen Festwert Sonntag 19:30.
 * @param {Date} jetzt
 * @param {number} [wochentag] 0=Sonntag .. 6=Samstag
 * @param {string} [uhrzeitHHMM] "HH:MM", z.B. "19:30"
 * @returns {boolean}
 */
export function istWochenLaufZeitfenster(jetzt, wochentag = STANDARD_WOCHENTAG, uhrzeitHHMM = STANDARD_UHRZEIT) {
    const passt = /^([01]\d|2[0-3]):([0-5]\d)$/.test(uhrzeitHHMM);
    const [stunde, minute] = passt ? uhrzeitHHMM.split(':').map(Number) : [19, 30];
    const tag = Number.isInteger(wochentag) && wochentag >= 0 && wochentag <= 6 ? wochentag : STANDARD_WOCHENTAG;

    const minutenSeitMitternacht = jetzt.getHours() * 60 + jetzt.getMinutes();
    return jetzt.getDay() === tag && minutenSeitMitternacht >= stunde * 60 + minute;
}

/** Neuesten kiAnalysen-Lauf liefern (optional gefiltert, z.B. nach ausloeser/berichtTyp), oder null. */
async function letzterLauf(db, filter = {}) {
    const treffer = await db.collection(COLLECTION)
        .find(filter, { projection: { erstelltAm: 1, ausloeser: 1, berichtTyp: 1 } })
        .sort({ erstelltAm: -1 })
        .limit(1)
        .toArray();
    return treffer[0] ?? null;
}

function stundenSeit(datum, jetzt) {
    return (jetzt.getTime() - new Date(datum).getTime()) / (60 * 60 * 1000);
}

/**
 * Budget-Guard: egal ob Auto- oder manueller Lauf, innerhalb von BUDGET_GUARD_STUNDEN seit
 * dem letzten Lauf (jeglicher Art) ist kein neuer erlaubt.
 * @param {import('mongodb').Db} db
 * @param {Date} [jetzt]
 * @returns {Promise<{erlaubt: boolean, grund?: string, naechsterErlaubterZeitpunkt?: Date}>}
 */
export async function pruefeBudgetGuard(db, jetzt = new Date()) {
    const letzter = await letzterLauf(db);
    if (!letzter) return { erlaubt: true };
    if (stundenSeit(letzter.erstelltAm, jetzt) < BUDGET_GUARD_STUNDEN) {
        const naechsterErlaubterZeitpunkt = new Date(new Date(letzter.erstelltAm).getTime() + BUDGET_GUARD_STUNDEN * 60 * 60 * 1000);
        return { erlaubt: false, grund: 'budget', naechsterErlaubterZeitpunkt };
    }
    return { erlaubt: true };
}

/**
 * True, wenn `jetzt` im monatlichen Ausloese-Fenster liegt: `tagDesMonats` ab `uhrzeitHHMM`
 * Uhr bis Tagesende. Bewusst der Tag NACH dem Monatswechsel-Automatik-Fenster (00:10 am 1.,
 * siehe monatswechselAutomatik.js), damit der neu archivierte Monat garantiert schon vorliegt --
 * selbst wenn der Monatswechsel an dem Tag in den Wartungsmodus lief und erst spaeter manuell
 * nachgeholt wird, zeigt der Monatsbericht dann eben noch den vorherigen Stand (kein Fehlerfall).
 * @param {Date} jetzt
 * @param {number} [tagDesMonats] 1..31
 * @param {string} [uhrzeitHHMM] "HH:MM"
 * @returns {boolean}
 */
export function istMonatsLaufZeitfenster(jetzt, tagDesMonats = MONATS_LAUF_TAG, uhrzeitHHMM = MONATS_LAUF_UHRZEIT) {
    const passt = /^([01]\d|2[0-3]):([0-5]\d)$/.test(uhrzeitHHMM);
    const [stunde, minute] = passt ? uhrzeitHHMM.split(':').map(Number) : [9, 0];
    const tag = Number.isInteger(tagDesMonats) && tagDesMonats >= 1 && tagDesMonats <= 31 ? tagDesMonats : MONATS_LAUF_TAG;

    const minutenSeitMitternacht = jetzt.getHours() * 60 + jetzt.getMinutes();
    return jetzt.getDate() === tag && minutenSeitMitternacht >= stunde * 60 + minute;
}

/**
 * Erlaubnis fuer den automatischen woechentlichen Lauf: Zeitfenster + Budget-Guard +
 * Mindestabstand seit dem letzten AUTOMATISCHEN woechentlichen Lauf.
 * Der `$or` in der Mindestabstands-Abfrage erkennt neben dem aktuellen Schema
 * ({berichtTyp:'woche', ausloeser:'automatisch'}) auch aeltere, vor dieser Schema-Aenderung
 * geschriebene Laeufe (ausloeser:'woche' ohne berichtTyp-Feld, damals gleichbedeutend mit
 * "automatisch woechentlich") -- ohne das wuerde der Guard direkt nach dem Deploy dieser Aenderung
 * faelschlich "noch nie automatisch gelaufen" annehmen.
 * @param {import('mongodb').Db} db
 * @param {Date} [jetzt]
 * @param {number} [wochentag] siehe istWochenLaufZeitfenster()
 * @param {string} [uhrzeitHHMM] siehe istWochenLaufZeitfenster()
 * @returns {Promise<{erlaubt: boolean, grund?: string, naechsterErlaubterZeitpunkt?: Date}>}
 */
export async function pruefeAutoLaufErlaubnis(db, jetzt = new Date(), wochentag = STANDARD_WOCHENTAG, uhrzeitHHMM = STANDARD_UHRZEIT) {
    if (!istWochenLaufZeitfenster(jetzt, wochentag, uhrzeitHHMM)) return { erlaubt: false, grund: 'ausserhalbZeitfenster' };

    const budget = await pruefeBudgetGuard(db, jetzt);
    if (!budget.erlaubt) return budget;

    const letzterAuto = await letzterLauf(db, { $or: [{ berichtTyp: 'woche', ausloeser: 'automatisch' }, { ausloeser: 'woche' }] });
    if (letzterAuto && stundenSeit(letzterAuto.erstelltAm, jetzt) < AUTO_LAUF_MIN_TAGE * 24) {
        return { erlaubt: false, grund: 'zuFrueh' };
    }
    return { erlaubt: true };
}

/**
 * Erlaubnis fuer den automatischen monatlichen Lauf: Zeitfenster + Budget-Guard +
 * Mindestabstand seit dem letzten AUTOMATISCHEN monatlichen Lauf.
 * @param {import('mongodb').Db} db
 * @param {Date} [jetzt]
 * @param {number} [tagDesMonats] siehe istMonatsLaufZeitfenster()
 * @param {string} [uhrzeitHHMM] siehe istMonatsLaufZeitfenster()
 * @returns {Promise<{erlaubt: boolean, grund?: string, naechsterErlaubterZeitpunkt?: Date}>}
 */
export async function pruefeAutoMonatsLaufErlaubnis(db, jetzt = new Date(), tagDesMonats = MONATS_LAUF_TAG, uhrzeitHHMM = MONATS_LAUF_UHRZEIT) {
    if (!istMonatsLaufZeitfenster(jetzt, tagDesMonats, uhrzeitHHMM)) return { erlaubt: false, grund: 'ausserhalbZeitfenster' };

    const budget = await pruefeBudgetGuard(db, jetzt);
    if (!budget.erlaubt) return budget;

    const letzterAuto = await letzterLauf(db, { berichtTyp: 'monat', ausloeser: 'automatisch' });
    if (letzterAuto && stundenSeit(letzterAuto.erstelltAm, jetzt) < AUTO_MONATS_LAUF_MIN_TAGE * 24) {
        return { erlaubt: false, grund: 'zuFrueh' };
    }
    return { erlaubt: true };
}

/**
 * Erlaubnis fuer den manuellen Trigger (/admin analyse jetzt): nur der Budget-Guard gilt --
 * kein Zeitfenster, kein Wochen-Mindestabstand, da es sich um eine bewusste Admin-Aktion handelt.
 * @param {import('mongodb').Db} db
 * @param {Date} [jetzt]
 * @returns {Promise<{erlaubt: boolean, grund?: string, naechsterErlaubterZeitpunkt?: Date}>}
 */
export async function pruefeManuellenLaufErlaubnis(db, jetzt = new Date()) {
    return pruefeBudgetGuard(db, jetzt);
}
