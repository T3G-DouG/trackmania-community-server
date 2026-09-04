// manialinkMenu.js -- Gemeinsame Bau-Helfer fuer die ManiaLink-Menueoberflaeche (AP17c+).
//
// Reine Funktionsbibliothek ohne eigenen XML-RPC-Zugriff -- jedes Plugin sendet/empfaengt
// selbst per SendDisplayManialinkPage(ToLogin) / onManialinkPageAnswer, wie schon bei
// karma.js/localRecords.js. Diese Datei liefert nur XML-Bausteine + die Aktions-Kodierung.
//
// WICHTIG (Lehre aus karma.js): Aktionen kodieren NIE freien Spieler-/DB-Text, nur feste
// Schluesselwoerter oder kleine Indizes in nextcontrol.lists.maps/.players. Freitext kommt
// ausschliesslich ueber <entry>+params.entries (siehe baueEingabeXml), nie ueber die Aktion.

import { escapeXml } from './utilities.js';
import { Settings } from '../settings.js';

/** ManiaLink-ID der Menue-Anzeige (Hauptmenue, Kategorien, Eingabeformulare, Bestaetigungen). */
export const MENU_MANIALINK_ID = 'tm-menu';

/** ManiaLink-ID des dauerhaft eingeblendeten Einstiegs-Knopfes. */
export const MENU_EINSTIEG_ID = 'tm-menu-einstieg';

const PADDING = 2, TITEL_HOEHE = 6, ZEILEN_HOEHE = 6, KNOPF_HOEHE = 6;

/** True, wenn der Login in der Admin-Liste steht (Settings.admins). */
export function istAdmin(login) {
    return Settings.admins.includes(login);
}

/**
 * Verteidigung in der Tiefe: das Hauptmenue zeigt Admin-Eintraege Nicht-Admins zwar gar
 * nicht erst an, aber onManialinkPageAnswer-Handler bekommen JEDE Aktion aller Plugins
 * durchgereicht (siehe nextcontrol.js-Rundruf) -- eine von Hand nachgebaute Aktion wuerde
 * sonst am Chat-Dispatcher (und damit auch am Security-Fix in nextcontrol.js) vorbeigehen.
 * Jeder Admin-Menue-Handler MUSS dies vor der eigentlichen Aktion pruefen.
 * @param {NextControl} nextcontrol
 * @param {String} login
 * @returns {Boolean} true, wenn admin -- sonst wird bereits eine Ablehnung verschickt
 */
export function pruefeAdmin(nextcontrol, login) {
    if (!istAdmin(login)) {
        nextcontrol.client.query('ChatSendServerMessageToLogin', ['$f00Du hast keine Rechte für diese Aktion.', login]);
        return false;
    }
    return true;
}

/** Aktion des "« Zurück"/Abbrechen-Knopfes -- oeffnet wieder das Hauptmenue (menu.js). */
export const ZURUECK_AKTION = kodiereAktion('menu', 'offen');

/** Schliesst die Menue-Anzeige fuer einen einzelnen Spieler (nach erledigter Aktion). */
export async function schliesseMenue(nextcontrol, login) {
    await nextcontrol.client.query('SendDisplayManialinkPageToLogin', [login, leereManialinkXml(MENU_MANIALINK_ID), 0, false]);
}

/**
 * Kodiert eine Klick-Aktion als "<namespace>|<teil1>|<teil2>...". Teile duerfen NIE freien
 * Text enthalten (siehe Datei-Kopfkommentar) -- nur feste Schluesselwoerter oder Indizes.
 */
export function kodiereAktion(namespace, ...teile) {
    return [namespace, ...teile].join('|');
}

/** Zerlegt eine per kodiereAktion() gebaute Aktion wieder in Namespace + Teile. */
export function dekodiereAktion(answer) {
    const teile = String(answer ?? '').split('|');
    return { namespace: teile[0], teile: teile.slice(1) };
}

/** Leere Seite mit derselben ID loescht die zuvor angezeigte Anzeige (Muster wie karma.js). */
export function leereManialinkXml(id) {
    return `<manialink id="${id}" version="3"></manialink>`;
}

/**
 * Generisches vertikales Knopf-Menue (Kategorie-Liste, Befehlsliste, Listen-Picker, ...).
 * Quad+Label je Zeile teilen sich denselben (Standard-)Anker oben-links -- bewusst OHNE
 * halign/valign, siehe karma.js-Erkenntnis: dort verschob halign/valign nur auf dem Label
 * dessen Anker gegenueber dem Quad, wodurch Kaestchen und Text auseinanderdrifteten.
 * @param {{titel:string, zeilen: Array<{label:string, aktion:string}>, breite?:number}} opts
 */
export function baueListenMenuXml({ titel, zeilen, breite = 70 }) {
    const hoehe = PADDING * 2 + TITEL_HOEHE + Math.max(zeilen.length, 1) * ZEILEN_HOEHE;

    const eintraegeXml = zeilen.length > 0
        ? zeilen.map((z) => {
            const idx = zeilen.indexOf(z);
            const y = PADDING + TITEL_HOEHE + idx * ZEILEN_HOEHE;
            const aktion = escapeXml(z.aktion);
            return `<quad pos="${PADDING} -${y}" size="${breite - 2 * PADDING} ${KNOPF_HOEHE - 0.6}" bgcolor="2a2a2acc" action="${aktion}" />
                <label pos="${PADDING + 1.5} -${y + 1.3}" size="${breite - 2 * PADDING - 3} ${KNOPF_HOEHE - 2}" text="${escapeXml(z.label)}" textsize="1.1" class="text-value" action="${aktion}" />`;
        }).join('\n                ')
        : `<label pos="${PADDING} -${PADDING + TITEL_HOEHE}" size="${breite - 2 * PADDING} 4" text="Keine Eintraege." textsize="1" class="text-value" />`;

    return `<manialink id="${MENU_MANIALINK_ID}" version="3">
            <frame posn="-95 70 5">
                <quad pos="0 0" size="${breite} ${hoehe}" bgcolor="000000cc" />
                <label pos="${PADDING} -${PADDING}" size="${breite - 2 * PADDING} 4" text="${escapeXml(titel)}" textsize="1.6" class="text-title" />
                ${eintraegeXml}
            </frame>
        </manialink>`;
}

/**
 * Bestaetigungsdialog (Ja/Abbrechen) fuer destruktive Aktionen (z.B. //beenden).
 * @param {{titel:string, frage:string, jaAktion:string, neinAktion:string, breite?:number}} opts
 */
export function baueBestaetigungsXml({ titel, frage, jaAktion, neinAktion, breite = 70 }) {
    const hoehe = PADDING * 2 + TITEL_HOEHE + 6 + KNOPF_HOEHE + 2;
    const ja = escapeXml(jaAktion), nein = escapeXml(neinAktion);

    return `<manialink id="${MENU_MANIALINK_ID}" version="3">
            <frame posn="-95 70 5">
                <quad pos="0 0" size="${breite} ${hoehe}" bgcolor="5a1a1acc" />
                <label pos="${PADDING} -${PADDING}" size="${breite - 2 * PADDING} 4" text="${escapeXml(titel)}" textsize="1.6" class="text-title" />
                <label pos="${PADDING} -${PADDING + 6}" size="${breite - 2 * PADDING} 5" text="${escapeXml(frage)}" textsize="1.1" class="text-value" />
                <quad pos="${PADDING} -${PADDING + 12}" size="30 ${KNOPF_HOEHE}" bgcolor="2a5a2acc" action="${ja}" />
                <label pos="${PADDING + 1.5} -${PADDING + 13.3}" size="27 ${KNOPF_HOEHE - 2}" text="Ja, wirklich" textsize="1.1" class="text-value" action="${ja}" />
                <quad pos="${PADDING + 32} -${PADDING + 12}" size="30 ${KNOPF_HOEHE}" bgcolor="2a2a2acc" action="${nein}" />
                <label pos="${PADDING + 33.5} -${PADDING + 13.3}" size="27 ${KNOPF_HOEHE - 2}" text="Abbrechen" textsize="1.1" class="text-value" action="${nein}" />
            </frame>
        </manialink>`;
}

/**
 * Ein-Eingabefeld-Formular fuer die wenigen echten Freitext-Faelle (/link-Code,
 * Telegram-Broadcast, Kartensuche). Der eingegebene Wert kommt NIE ueber die Aktion,
 * sondern wird im onManialinkPageAnswer-Handler aus params.entries gelesen (siehe
 * CallbackParams.ManialinkPageAnswer.entries, controller/lib/callbackparams.js).
 * @param {{titel:string, hinweistext:string, entryName:string, submitAktion:string, zurueckAktion:string, breite?:number}} opts
 */
export function baueEingabeXml({ titel, hinweistext, entryName, submitAktion, zurueckAktion, breite = 80 }) {
    const hoehe = PADDING * 2 + TITEL_HOEHE + 5 + 8 + KNOPF_HOEHE + 2;
    const entryY = PADDING + TITEL_HOEHE + 6;
    const knopfY = entryY + 9;
    const submit = escapeXml(submitAktion), zurueck = escapeXml(zurueckAktion);

    return `<manialink id="${MENU_MANIALINK_ID}" version="3">
            <frame posn="-95 70 5">
                <quad pos="0 0" size="${breite} ${hoehe}" bgcolor="000000cc" />
                <label pos="${PADDING} -${PADDING}" size="${breite - 2 * PADDING} 4" text="${escapeXml(titel)}" textsize="1.6" class="text-title" />
                <label pos="${PADDING} -${PADDING + 5}" size="${breite - 2 * PADDING} 4" text="${escapeXml(hinweistext)}" textsize="1" class="text-value" />
                <entry name="${escapeXml(entryName)}" pos="${PADDING} -${entryY}" size="${breite - 2 * PADDING} 6" default="" />
                <quad pos="${PADDING} -${knopfY}" size="30 ${KNOPF_HOEHE}" bgcolor="2a5a2acc" action="${submit}" />
                <label pos="${PADDING + 1.5} -${knopfY + 1.3}" size="27 ${KNOPF_HOEHE - 2}" text="Absenden" textsize="1.1" class="text-value" action="${submit}" />
                <quad pos="${PADDING + 32} -${knopfY}" size="30 ${KNOPF_HOEHE}" bgcolor="2a2a2acc" action="${zurueck}" />
                <label pos="${PADDING + 33.5} -${knopfY + 1.3}" size="27 ${KNOPF_HOEHE - 2}" text="Zurueck" textsize="1.1" class="text-value" action="${zurueck}" />
            </frame>
        </manialink>`;
}

/** Dauerhaft eingeblendeter, dezenter Einstiegs-Knopf oben rechts (ueber der Top-10-Anzeigetafel). */
export function baueEinstiegsKnopfXml(aktion) {
    const BREITE = 28, HOEHE = 5.5;
    const a = escapeXml(aktion);

    // Links neben der Top-10-Anzeigetafel (localRecords.js, posn "122 88 5", Breite 38) statt
    // darueber -- die Tafel liegt bereits nah am oberen Bildschirmrand, ein Platz "darueber"
    // lag ausserhalb des sichtbaren Bereichs (Betreiber-Rueckmeldung 2026-09-01, seitdem
    // gefixt). Gleiche y-Position wie die Tafel (nachweislich sichtbar), nur nach links
    // versetzt -- die Tafel wird dadurch nie ueberlappt (feste Breite 38). Bewusst OHNE
    // Icon/Symbol -- weder ein Icons64x64_1-Substyle-Versuch ("Windows") noch ein Emoji im
    // Label-Text wurden im ManiaLink-Font angezeigt (nur ein leeres Kaestchen, Betreiber-
    // Rueckmeldungen 2026-09-01), reiner Text ist zuverlaessiger.
    return `<manialink id="${MENU_EINSTIEG_ID}" version="3">
            <frame posn="88 88 5">
                <quad pos="0 0" size="${BREITE} ${HOEHE}" bgcolor="1a1a2acc" action="${a}" />
                <label pos="1.5 -1.5" size="${BREITE - 3} 3" text="Menü" textsize="1.05" class="text-title" action="${a}" />
            </frame>
        </manialink>`;
}

/** Leere Seite fuer den Einstiegs-Knopf (falls er mal ausgeblendet werden muss). */
export function leererEinstiegsKnopfXml() {
    return leereManialinkXml(MENU_EINSTIEG_ID);
}
