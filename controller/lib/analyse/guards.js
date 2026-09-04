// guards.js — Zahlen-/Namens-Whitelist-Guard fuer KI-generierte Analyse-Texte.
// PURE Funktionen (kein DB-Zugriff, kein nextcontrol.js-Import). Load-bearing:
// die KI darf NIEMALS eine Zahl oder einen Spielernamen nennen,
// die nicht woertlich in den gelieferten Kennzahlen stehen (Empirie aus kiEnrich.js:
// reines Prompt-Vertrauen reicht nachweislich nicht -- Claude Haiku ignorierte die
// Sprachregel dort in ~50% der Faelle trotz expliziter Anweisung). Ein Verstoss verwirft
// NUR den betroffenen Text (deterministischer Fallback) -- die Kennzahlen selbst sind
// davon nie betroffen.

/**
 * Deutsche Zahlenschreibweise: Tausenderpunkt, Dezimalkomma, optionales Vorzeichen/Prozent.
 * Negative Lookbehind (?<!\d) verhindert, dass ein Bindestrich INNERHALB eines Datums
 * ("2026-05") faelschlich als Minuszeichen einer eigenen Zahl "-05" gelesen wird.
 * Zusaetzlicher Lookbehind/Lookahead (?<!\p{L})/(?!\p{L}) verhindert, dass in Text
 * genannte Spielernamen mit Ziffern-Suffix (z.B. "ToGe88", "Snipes1503", "Baemsen85",
 * "Kniescheibe123" -- in dieser Community haeufig) faelschlich als eigene, nicht auf der
 * Whitelist stehende Zahl gelesen werden (real aufgetreten: ein echter Analyse-Lauf gegen
 * die echte API verwarf deswegen 4 von 5 Textabschnitten faelschlich).
 */
const ZAHLEN_REGEX = /(?<![\d\p{L}])-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?%?(?!\p{L})/gu;

/** Parst einen einzelnen, deutsch formatierten Zahl-Token (aus ZAHLEN_REGEX) zu einer Number. */
function parseDeutscheZahl(rohToken) {
    const ohneProzent = rohToken.replace(/%$/, '');
    const kanonisch = ohneProzent.replace(/\./g, '').replace(',', '.');
    return Number(kanonisch);
}

/** Rundet auf 2 Nachkommastellen, um Float-Vergleichsprobleme zu vermeiden ("gleich" statt "fast gleich"). */
function runde(zahl) {
    return Math.round(zahl * 100) / 100;
}

/**
 * Sammelt alle in den Kennzahlen "erlaubten" Zahlen -- rekursiv jeden Number-Wert (bei
 * negativen Werten zusaetzlich den Betrag, da eine Verlust-/Ruecksstufungs-Formulierung
 * ("verliert 200 Punkte") den Wert natuerlicherweise ohne Vorzeichen nennt, waehrend die
 * Kennzahl selbst z.B. als punkteDelta:-200 vorliegt -- ohne das wuerde jede sprachlich
 * korrekte Beschreibung eines negativen Delta/z-Scores faelschlich verworfen) plus, fuer
 * jedes durchlaufene Array, dessen Laenge (legitime Groessenangaben wie "5 Monate",
 * "3 Spieler" duerfen genannt werden) plus, fuer jeden "YYYY-MM"-Monatsstring, dessen
 * Jahres- und Monatszahl (sonst wuerde jede Datumsnennung im Text den Guard ausloesen).
 * @param {*} daten beliebiger Kennzahlen-Wert (Objekt/Array/Zahl/String, verschachtelt)
 * @returns {Set<number>}
 */
export function sammleZahlenWhitelist(daten, akkumulator = new Set()) {
    if (typeof daten === 'number' && Number.isFinite(daten)) {
        akkumulator.add(runde(daten));
        if (daten < 0) akkumulator.add(runde(-daten));
    } else if (typeof daten === 'string') {
        const m = /^(\d{4})-(\d{2})$/.exec(daten);
        if (m) {
            akkumulator.add(Number(m[1])); // Jahr, z.B. 2026
            akkumulator.add(Number(m[2])); // Monat OHNE fuehrende Null, z.B. "05" -> 5
        }
    } else if (Array.isArray(daten)) {
        akkumulator.add(daten.length);
        for (const eintrag of daten) sammleZahlenWhitelist(eintrag, akkumulator);
    } else if (daten && typeof daten === 'object') {
        for (const wert of Object.values(daten)) sammleZahlenWhitelist(wert, akkumulator);
    }
    return akkumulator;
}

/**
 * Prueft, ob JEDE im Text vorkommende Zahl in der Whitelist steht.
 * @param {string} text
 * @param {Set<number>|number[]} erlaubteZahlen
 * @returns {{ok: boolean, unbekannteZahlen: string[]}}
 */
export function pruefeZahlenGuard(text, erlaubteZahlen) {
    const whitelist = erlaubteZahlen instanceof Set ? erlaubteZahlen : new Set(erlaubteZahlen);
    const gefunden = text.match(ZAHLEN_REGEX) ?? [];
    const unbekannt = [];
    for (const roh of gefunden) {
        const wert = parseDeutscheZahl(roh);
        if (!Number.isFinite(wert) || !whitelist.has(runde(wert))) unbekannt.push(roh);
    }
    return { ok: unbekannt.length === 0, unbekannteZahlen: unbekannt };
}

/**
 * Sammelt alle Spielernamen aus den Kennzahlen -- rekursiv jeder String-Wert unter den
 * Schluesseln 'name'/'nameA'/'nameB', die alle Analysen aus kennzahlen.js einheitlich
 * fuer Anzeigenamen verwenden.
 * @param {*} daten
 * @returns {Set<string>}
 */
export function sammleNamenAusDaten(daten, akkumulator = new Set()) {
    if (Array.isArray(daten)) {
        for (const eintrag of daten) sammleNamenAusDaten(eintrag, akkumulator);
    } else if (daten && typeof daten === 'object') {
        for (const [schluessel, wert] of Object.entries(daten)) {
            if ((schluessel === 'name' || schluessel === 'nameA' || schluessel === 'nameB') && typeof wert === 'string') {
                akkumulator.add(wert);
            } else {
                sammleNamenAusDaten(wert, akkumulator);
            }
        }
    }
    return akkumulator;
}

/** True, wenn `name` als eigenstaendiges Wort (Wortgrenzen) im Text vorkommt. */
function nameKommtVorInText(text, name) {
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * Prueft, dass der Text KEINEN bekannten Spielernamen erwaehnt, der nicht explizit fuer
 * diesen Abschnitt erlaubt ist (verhindert, dass die KI unbeteiligte Spieler erfindet
 * oder faelschlich in einen Vergleich hineinzieht).
 * @param {string} text
 * @param {Set<string>|string[]} erlaubteNamen Namen, die in DIESEM Abschnitt vorkommen duerfen
 * @param {Set<string>|string[]} alleBekanntenNamen alle jemals bekannten Spielernamen
 * @returns {{ok: boolean, unbekannteNamen: string[]}}
 */
export function pruefeNamenGuard(text, erlaubteNamen, alleBekanntenNamen) {
    const erlaubt = erlaubteNamen instanceof Set ? erlaubteNamen : new Set(erlaubteNamen);
    const alle = alleBekanntenNamen instanceof Set ? [...alleBekanntenNamen] : alleBekanntenNamen;
    const verletzungen = [];
    for (const name of alle) {
        if (erlaubt.has(name)) continue;
        if (nameKommtVorInText(text, name)) verletzungen.push(name);
    }
    return { ok: verletzungen.length === 0, unbekannteNamen: verletzungen };
}

/**
 * Kombinierter Guard -- ein Text besteht nur, wenn BEIDE Teilguards bestehen.
 * @param {string} text
 * @param {{erlaubteZahlen: Set<number>, erlaubteNamen: Set<string>, alleBekanntenNamen: Set<string>}} kontext
 */
export function pruefeKiText(text, { erlaubteZahlen, erlaubteNamen, alleBekanntenNamen }) {
    const zahlen = pruefeZahlenGuard(text, erlaubteZahlen);
    const namen = pruefeNamenGuard(text, erlaubteNamen, alleBekanntenNamen);
    return { ok: zahlen.ok && namen.ok, unbekannteZahlen: zahlen.unbekannteZahlen, unbekannteNamen: namen.unbekannteNamen };
}
