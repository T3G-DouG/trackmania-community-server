// berichtLauf.js — AP15d: orchestriert einen kompletten Analyse-Lauf (laden -> rechnen ->
// texten -> kiAnalysen-Insert -> alte Laeufe aufraeumen) + baut den Telegram-Kompaktbericht.
// Wirft NIE unbehandelt (kein globaler unhandledRejection-Handler im Controller, siehe
// errungenschaften.js) -- ein Fehler hier darf nie den aufrufenden Prozess gefaehrden.
//
// Sendet selbst NICHTS per Telegram -- baut nur den Berichtstext (`telegramBericht`-Feld
// im zurueckgegebenen Dokument). Das Verschicken (und das Setzen von `telegramGesendetAm`
// nach erfolgreichem Versand) obliegt dem Aufrufer (scripts/analyse-lauf.js hier, spaeter
// controller/plugins/analyse.js in AP15e) -- unterschiedliche Kontexte nutzen dafuer
// unterschiedliche Telegram-Helfer (scripts/lib/telegram.js vs. controller/lib/telegramAlert.js).

import { Settings } from '../../settings.js';
import { logger } from '../utilities.js';
import { ladeAnalyseDaten } from './datenLaden.js';
import { berechneWochenKennzahlen, berechneMonatsKennzahlen, nurEchteMonateSortiert } from './kennzahlen.js';
import { erzeugeAbschnittsText, erzeugeGesamtzusammenfassung } from './berichtKi.js';

const MAX_LAEUFE_BEHALTEN = 30;
const COLLECTION = 'kiAnalysen';

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Deterministisches Zahlengerüst (Top-3-Highlights) fuer den woechentlichen Telegram-Kompaktbericht. */
function baueWochenHighlights(kennzahlen) {
    const zeilen = [];

    if (kennzahlen.aufsteiger.verfuegbar && kennzahlen.aufsteiger.daten.length > 0) {
        const top = kennzahlen.aufsteiger.daten[0];
        zeilen.push(`🚀 Größter Aufsteiger: <b>${escapeHtml(top.name)}</b> (Platz ${top.platzVorher} → ${top.platzJetzt})`);
    }
    if (kennzahlen.wochenAktivitaet.verfuegbar && kennzahlen.wochenAktivitaet.daten.proSpieler.length > 0) {
        const top = kennzahlen.wochenAktivitaet.daten.proSpieler[0];
        zeilen.push(`🔥 Aktivster Fahrer: <b>${escapeHtml(top.name)}</b> mit ${top.anzahl} Verbesserung(en) diese Woche`);
    }
    if (kennzahlen.naheDuelle.verfuegbar && kennzahlen.naheDuelle.daten.length > 0) {
        const top = kennzahlen.naheDuelle.daten[0];
        zeilen.push(`⚔️ Engstes Duell: <b>${escapeHtml(top.nameA)}</b> vs <b>${escapeHtml(top.nameB)}</b> (${top.abstand.toLocaleString('de-DE')} Punkte Abstand)`);
    }
    return zeilen.slice(0, 3);
}

/** Deterministisches Zahlengerüst (Top-3-Highlights) fuer den monatlichen Telegram-Kompaktbericht. */
function baueMonatsHighlights(kennzahlen) {
    const zeilen = [];

    if (kennzahlen.aufsteiger.verfuegbar && kennzahlen.aufsteiger.daten.length > 0) {
        const top = kennzahlen.aufsteiger.daten[0];
        zeilen.push(`🚀 Größter Aufsteiger: <b>${escapeHtml(top.name)}</b> (Platz ${top.platzVorher} → ${top.platzJetzt})`);
    }
    if (kennzahlen.dominanz.verfuegbar && kennzahlen.dominanz.daten.length > 0) {
        const top = kennzahlen.dominanz.daten[0];
        zeilen.push(`👑 Hausstrecke: <b>${escapeHtml(top.name)}</b> gewinnt ${top.anteilProzent}% der Fahrten auf einer Strecke`);
    }
    if (kennzahlen.rivalitaeten.verfuegbar && kennzahlen.rivalitaeten.daten.length > 0) {
        const top = kennzahlen.rivalitaeten.daten[0];
        zeilen.push(`⚔️ Engste Rivalität: <b>${escapeHtml(top.nameA)}</b> vs <b>${escapeHtml(top.nameB)}</b> (${top.anzahlMonate} Monate eng beieinander)`);
    }
    return zeilen.slice(0, 3);
}

/** Baut den kompletten Telegram-Kompaktbericht: deterministisches Gerüst + guarded KI-Text. */
function baueTelegramBericht(berichtTyp, kennzahlen, zusammenfassungText) {
    const highlights = berichtTyp === 'monat' ? baueMonatsHighlights(kennzahlen) : baueWochenHighlights(kennzahlen);
    const titel = berichtTyp === 'monat' ? 'Monats-Update' : 'Wochen-Update';
    let msg = `📊 <b>${titel}</b>\n\n`;
    msg += highlights.length > 0 ? highlights.join('\n') : 'Diesmal noch keine auffälligen Highlights.';
    if (zusammenfassungText) {
        msg += `\n\n🤖 ${escapeHtml(zusammenfassungText)}`;
    }
    return msg;
}

/** Gesamtstatus aus den Einzelergebnissen ableiten: ok nur, wenn ALLES sauber war. */
function ermittleGesamtStatus(ergebnisse) {
    const versucht = ergebnisse.length;
    const ok = ergebnisse.filter((e) => e.status === 'ok').length;
    const kiFehler = ergebnisse.filter((e) => e.status === 'kiFehler').length;
    if (versucht === 0) return 'kiFehler'; // nichts zu texten (keine Kennzahl verfuegbar)
    if (ok === versucht) return 'ok';
    if (kiFehler === versucht) return 'kiFehler'; // absolut nichts hat geklappt (z.B. kein API-Key)
    return 'teilweise';
}

/**
 * Fuehrt einen kompletten Analyse-Lauf durch. Persistiert nur bei `live:true` (Muster wie
 * monatswechsel.js) -- ACHTUNG: KI-Aufrufe (mit echten API-Kosten, ausser bei
 * Settings.ki.dryRun) passieren UNABHAENGIG von `live`, da sie zur Guard-Verifikation
 * gehoeren. Wirft nie -- liefert bei einem harten Fehler `null` statt zu werfen.
 * @param {import('mongodb').Db} db
 * @param {{ausloeser?: 'automatisch'|'manuell', berichtTyp?: 'woche'|'monat', live?: boolean, modell?: string}} [opts]
 *   `berichtTyp` waehlt das Kennzahlen-Set (AP17-Nachtrag: 'woche' = nur das tatsaechliche
 *   Wochengeschehen, 'monat' = der historische Rueckblick ueber vergangene Monate -- siehe
 *   kennzahlen.js). `modell` ab AP16b optional vom Admin-Dashboard (systemSettings.analyse);
 *   Default Settings.ki.analyseModell.
 * @returns {Promise<object|null>}
 */
export async function fuehreAnalyseLaufDurch(db, { ausloeser = 'manuell', berichtTyp = 'woche', live = false, modell = Settings.ki.analyseModell } = {}) {
    try {
        const daten = await ladeAnalyseDaten(db);
        const kennzahlen = berichtTyp === 'monat' ? berechneMonatsKennzahlen(daten) : berechneWochenKennzahlen(daten);
        const alleBekanntenNamen = new Set(daten.spielerNamen.values());

        const abschnitte = [];
        for (const [schluessel, ergebnis] of Object.entries(kennzahlen)) {
            if (!ergebnis.verfuegbar) continue;
            const { text, status } = await erzeugeAbschnittsText(schluessel, ergebnis.daten, alleBekanntenNamen, modell);
            abschnitte.push({ schluessel, text, status });
        }

        const { text: zusammenfassung, status: zusammenfassungStatus } = await erzeugeGesamtzusammenfassung(kennzahlen, alleBekanntenNamen, modell);

        const textStatus = ermittleGesamtStatus([...abschnitte, { status: zusammenfassungStatus }]);

        // Zeitraum (Monatsspanne) ist nur beim Monatsbericht aussagekraeftig -- der
        // Wochenbericht bezieht sich auf die letzten ~7 Tage, nicht auf archivierte Monate.
        const echteMonate = nurEchteMonateSortiert(daten.monthlyRankings);
        const zeitraum = berichtTyp === 'monat' && echteMonate.length > 0
            ? { vonMonat: echteMonate[0].monat, bisMonat: echteMonate[echteMonate.length - 1].monat }
            : { vonMonat: null, bisMonat: null };

        const dokument = {
            erstelltAm: new Date(),
            ausloeser,
            berichtTyp,
            modell,
            zeitraum,
            kennzahlen,
            // zusammenfassungStatus wird mitpersistiert (nicht nur fuer ermittleGesamtStatus
            // verwendet), damit die Website unterscheiden kann, ob zusammenfassung ein echter
            // KI-Text ist ('ok') oder der generische Guard-Fallback-Satz ('teilweise') -- siehe
            // analysen.html, das den Fallback-Satz bewusst nicht als "KI-Einordnung" anzeigt.
            texte: { zusammenfassung, zusammenfassungStatus, abschnitte },
            textStatus,
            telegramBericht: baueTelegramBericht(berichtTyp, kennzahlen, zusammenfassungStatus === 'kiFehler' ? null : zusammenfassung),
            telegramGesendetAm: null,
        };

        if (live) {
            await db.collection(COLLECTION).insertOne(dokument);
            await raeumeAlteLaeufeAuf(db);
        }

        return dokument;
    } catch (error) {
        logger('er', `Analyse-Lauf: unerwarteter Fehler: ${error.message}`);
        return null;
    }
}

/** Behaelt nur die letzten MAX_LAEUFE_BEHALTEN Laeufe (nach erstelltAm). */
async function raeumeAlteLaeufeAuf(db) {
    const alle = await db.collection(COLLECTION).find({}, { projection: { _id: 1, erstelltAm: 1 } }).sort({ erstelltAm: -1 }).toArray();
    if (alle.length <= MAX_LAEUFE_BEHALTEN) return;
    const zuLoeschen = alle.slice(MAX_LAEUFE_BEHALTEN).map((d) => d._id);
    await db.collection(COLLECTION).deleteMany({ _id: { $in: zuLoeschen } });
}
