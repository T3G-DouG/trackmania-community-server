import { logger } from './utilities.js';
import { Settings } from '../settings.js';

/**
 * Laufzeit-Einstellungen fuer die KI-Features (Rennleitung, Nachrichten-KI, spaeter
 * Analyse-Modul), ueberschreibbar per Admin-Dashboard (AP16) ohne Controller-Neustart.
 *
 * Quelle der Wahrheit ist die Collection `systemSettings` (Singleton-Dokument
 * _id:"aktuell"). Fehlt sie (Erstinstallation, Rollback), gelten unveraendert die
 * statischen Defaults aus settings.js/Env -- dieses Modul ist rein additiv und nie
 * Voraussetzung fuers Booten. Wird von mehreren Plugins genutzt (rennleitung.js,
 * kiEnrich.js, spaeter analyse.js), deshalb bewusst hier zentral statt dupliziert.
 *
 * holeEinstellungen() liefert synchron den zuletzt geladenen Stand (In-Memory-Cache,
 * alle POLL_INTERVALL_MS aufgefrischt) und wirft nie. setzeEinstellungen() schreibt
 * sofort in die DB UND aktualisiert den Cache optimistisch, damit z.B. ein In-Game-
 * Admin-Befehl ohne Wartezeit auf den naechsten Poll wirkt.
 */

const POLL_INTERVALL_MS = 30 * 1000;
const COLLECTION = 'systemSettings';
const DOC_ID = 'aktuell';

const MODELLE = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];

/** Gueltige Wochentage fuer den Analyse-Zeitplan, Muster Date.getDay() (0=Sonntag). */
const UHRZEIT_MUSTER = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Harte Code-Obergrenzen. Das Dashboard/die Chat-Befehle koennen Werte nur INNERHALB
 * dieser Grenzen setzen -- niemals darueber hinaus (Kostendeckel bleiben im Code, nicht
 * nur in der DB). normalisiere() klemmt bei JEDEM Lesen/Schreiben, unabhaengig davon,
 * wie das systemSettings-Dokument zustande kam (Dashboard, Chat-Befehl, manuelle
 * DB-Bearbeitung).
 */
export const GRENZEN = {
    rennleitung: {
        minAbstandMs: { min: 10 * 1000, max: 5 * 60 * 1000 },
        ambientAbstandMs: { min: 60 * 1000, max: 30 * 60 * 1000 },
        maxProStunde: { min: 1, max: 30 },
    },
    nachrichtenKi: {
        maxProStunde: { min: 1, max: 300 },
    },
};

function defaults() {
    return {
        rennleitung: {
            aktiv: Settings.ki.aktiv,
            modell: Settings.ki.modell,
            minAbstandMs: 45 * 1000,
            ambientAbstandMs: 4 * 60 * 1000,
            maxProStunde: 30,
        },
        nachrichtenKi: {
            aktiv: Settings.nachrichtenKi.aktiv,
            modell: Settings.ki.modell,
            maxProStunde: Settings.nachrichtenKi.maxProStunde,
        },
        // AP16b: Analyse-Zeitplan/-Modell/Telegram-Toggle. Default entspricht exakt dem bisher
        // fest verdrahteten Verhalten aus automatikTakt.js (Sonntag ab 19:30, claude-sonnet-5,
        // Telegram-Bericht an) -- ohne systemSettings-Dokument aendert sich also nichts.
        analyse: {
            modell: Settings.ki.analyseModell,
            wochentag: 0,
            uhrzeit: '19:30',
            telegramBericht: true,
        },
        // AP17: Tagesreport (telegram.js, AP10) -- kein LLM (rein deterministisch), daher nur
        // Ein/Aus + Uhrzeit. Default entspricht exakt dem bisher fest verdrahteten Verhalten
        // (taeglich 20:00, sofern an dem Tag gefahren wurde).
        tagesreport: {
            aktiv: true,
            uhrzeit: '20:00',
        },
    };
}

function klemme(bereich, wert, fallback) {
    if (typeof wert !== 'number' || !Number.isFinite(wert)) return fallback;
    return Math.min(bereich.max, Math.max(bereich.min, wert));
}

/** Erzwingt Typen + Wertebereiche fuer ein (ggf. unvollstaendiges/fremdes) Rohdokument. */
function normalisiere(doc) {
    const d = defaults();
    if (!doc) return d;
    return {
        rennleitung: {
            aktiv: typeof doc.rennleitung?.aktiv === 'boolean' ? doc.rennleitung.aktiv : d.rennleitung.aktiv,
            modell: MODELLE.includes(doc.rennleitung?.modell) ? doc.rennleitung.modell : d.rennleitung.modell,
            minAbstandMs: klemme(GRENZEN.rennleitung.minAbstandMs, doc.rennleitung?.minAbstandMs, d.rennleitung.minAbstandMs),
            ambientAbstandMs: klemme(GRENZEN.rennleitung.ambientAbstandMs, doc.rennleitung?.ambientAbstandMs, d.rennleitung.ambientAbstandMs),
            maxProStunde: klemme(GRENZEN.rennleitung.maxProStunde, doc.rennleitung?.maxProStunde, d.rennleitung.maxProStunde),
        },
        nachrichtenKi: {
            aktiv: typeof doc.nachrichtenKi?.aktiv === 'boolean' ? doc.nachrichtenKi.aktiv : d.nachrichtenKi.aktiv,
            modell: MODELLE.includes(doc.nachrichtenKi?.modell) ? doc.nachrichtenKi.modell : d.nachrichtenKi.modell,
            maxProStunde: klemme(GRENZEN.nachrichtenKi.maxProStunde, doc.nachrichtenKi?.maxProStunde, d.nachrichtenKi.maxProStunde),
        },
        analyse: {
            modell: MODELLE.includes(doc.analyse?.modell) ? doc.analyse.modell : d.analyse.modell,
            wochentag: Number.isInteger(doc.analyse?.wochentag) && doc.analyse.wochentag >= 0 && doc.analyse.wochentag <= 6
                ? doc.analyse.wochentag
                : d.analyse.wochentag,
            uhrzeit: UHRZEIT_MUSTER.test(doc.analyse?.uhrzeit) ? doc.analyse.uhrzeit : d.analyse.uhrzeit,
            telegramBericht: typeof doc.analyse?.telegramBericht === 'boolean' ? doc.analyse.telegramBericht : d.analyse.telegramBericht,
        },
        tagesreport: {
            aktiv: typeof doc.tagesreport?.aktiv === 'boolean' ? doc.tagesreport.aktiv : d.tagesreport.aktiv,
            uhrzeit: UHRZEIT_MUSTER.test(doc.tagesreport?.uhrzeit) ? doc.tagesreport.uhrzeit : d.tagesreport.uhrzeit,
        },
    };
}

let db = null;
let cache = defaults();
let pollTimer = null;

async function aktualisiere() {
    if (!db) return;
    const doc = await db.collection(COLLECTION).findOne({ _id: DOC_ID });
    cache = normalisiere(doc);
}

/**
 * Einmalig beim ersten Plugin-Start aufzurufen (idempotent -- mehrere Plugins duerfen
 * das gefahrlos alle in ihrem Konstruktor tun). Startet das Polling und laedt sofort
 * einmal, damit der Cache nicht erst nach POLL_INTERVALL_MS befuellt ist.
 * @param {import('mongodb').Db} mongoDb
 */
export function initialisiereLaufzeitEinstellungen(mongoDb) {
    if (db) return; // schon initialisiert
    db = mongoDb;
    aktualisiere().catch((error) => logger('er', `laufzeitEinstellungen: initialer Ladefehler: ${error.message}`));
    pollTimer = setInterval(
        () => aktualisiere().catch((error) => logger('er', `laufzeitEinstellungen: Poll-Fehler: ${error.message}`)),
        POLL_INTERVALL_MS
    );
    // unref(): dieser Hintergrund-Poll soll den Prozess nie allein am Leben halten (z.B. in
    // kurzlebigen Testskripten) -- im echten Controller laeuft der Prozess ohnehin dauerhaft
    // wegen der XML-RPC-/Mongo-Verbindungen.
    pollTimer.unref?.();
}

/** Liefert synchron den zuletzt geladenen Stand -- wirft nie, liefert Defaults vor der Initialisierung. */
export function holeEinstellungen() {
    return cache;
}

/**
 * Schreibt ein Teil-Update fuer einen Bereich nach systemSettings und aktualisiert den
 * Cache sofort optimistisch (kein Warten auf den naechsten Poll noetig).
 * @param {'rennleitung'|'nachrichtenKi'} bereich
 * @param {object} teilupdate
 * @param {string} [wer] Login/Kennung der Quelle (Chat-Login oder 'dashboard'), fuer aktualisiertVon
 * @returns {Promise<object>} der neue, geklemmte Gesamtstand
 */
export async function setzeEinstellungen(bereich, teilupdate, wer = 'unbekannt') {
    if (!db) throw new Error('laufzeitEinstellungen: noch nicht initialisiert (initialisiereLaufzeitEinstellungen fehlt)');
    const vorhandenesDoc = await db.collection(COLLECTION).findOne({ _id: DOC_ID });
    const vorhandenNormalisiert = normalisiere(vorhandenesDoc);
    const gemerged = { ...vorhandenNormalisiert, [bereich]: { ...vorhandenNormalisiert[bereich], ...teilupdate } };
    const geklemmt = normalisiere(gemerged);

    await db.collection(COLLECTION).replaceOne(
        { _id: DOC_ID },
        { _id: DOC_ID, ...geklemmt, aktualisiertAm: new Date(), aktualisiertVon: wer },
        { upsert: true }
    );

    cache = geklemmt;
    return geklemmt;
}

export { MODELLE };
