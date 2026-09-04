
import { Sentences } from '../lib/sentences.js'
import { logger, format, stripFormatting, escapeXml } from '../lib/utilities.js'
import { protokolliere } from '../lib/eventLog.js'
import { formuliereChatNachrichtUm, formuliereUm } from '../lib/kiEnrich.js'
import { Settings } from '../settings.js'
let dbtype = Settings.usedDatabase.toLocaleLowerCase();

import * as CallbackParams from '../lib/callbackparams.js'
import * as Classes from '../lib/classes.js'
import { NextControl } from '../nextcontrol.js'
import { kodiereAktion, schliesseMenue } from '../lib/manialinkMenu.js'

/** Praefix der Menue-Aktion "Aktuelle Karte bewerten" (Hauptmenue) -- getrennt von
 *  VOTE_AKTION_PRAEFIX, damit die Klick-Behandlung der Bewertungsknoepfe unangetastet bleibt. */
const MENU_AKTION_PRAEFIX = 'karmamenu';

/**
 * Karma-Plugin: Spieler bewerten die aktuelle Strecke von 1 (schlecht) bis 10 (super).
 * Die Bewertungen fliessen als Geschmacksprofil in die Kandidatenauswahl fuers
 * naechste Monats-Voting ein (siehe telegram.js: starteMapAbstimmung()).
 */
export class KarmaPlugin {

    name           = 'Karma'
    author         = 'dassschaf'
    description    = 'Ermöglicht Spielern, Strecken von 1 bis 10 zu bewerten.'

    /**
     * @type {NextControl}
     */
    nextcontrol

    /**
     * ManiaLink-ID der Voting-Anzeige -- dieselbe ID mit leerem Inhalt erneut gesendet
     * loescht die zuvor angezeigte Seite (Muster wie monatswechselAutomatik.js).
     * @type {String}
     */
    VOTING_MANIALINK_ID = 'karma-voting'

    /**
     * Praefix der Klick-Aktionen der Bewertungsknoepfe. Vollstaendige Aktion:
     * "<PRAEFIX>|<mapUid>|<wert>" -- die Map-UID wird mitgeschickt (statt beim Klick
     * auf die *aktuell* laufende Karte zu schliessen), da die Voting-Anzeige ueber den
     * Kartenwechsel hinweg sichtbar bleiben kann und der Server bis zum naechsten
     * onBeginMap laengst auf der naechsten Karte stehen kann.
     * @type {String}
     */
    VOTE_AKTION_PRAEFIX = 'karma_vote'

    /**
     * @param {NextControl} nextcontrol
     */
    constructor(nextcontrol) {
        nextcontrol.registerChatCommand(new Classes.ChatCommand(
            'karma',
            this.commandKarma,
            'Strecke von 1-10 bewerten (/karma <wert>) oder aktuelle Bewertung anzeigen (/karma).',
            this.name
        ));

        // Nachtrag (Betreiber-Wunsch 2026-09-01): Karma-Bewertung der AKTUELL
        // laufenden Karte auch jederzeit ueber das Hauptmenue erreichbar, nicht nur
        // automatisch bei Kartenende.
        nextcontrol.registerMenuEintrag(new Classes.MenuEintrag(
            'Allgemein', 'Aktuelle Karte bewerten', kodiereAktion(MENU_AKTION_PRAEFIX, 'oeffnen'), { pluginName: this.name }
        ));

        this.nextcontrol = nextcontrol;
    }

    /**
     * Karma chat command
     * @param {String} login Login of the player calling this command
     * @param {Array<String>} params Parameters passed by the player after the command (seperated by space)
     */
    async commandKarma(login, params) {
        if (dbtype !== 'mongodb') return; // MySQL-Codepfad nicht angefasst

        const uid = this.nextcontrol.status.map.uid;
        const mapName = this.nextcontrol.status.map.name;

        if (params.length === 0) {
            await this.zeigeKarma(login, uid, mapName);
            return;
        }

        const score = Number(params[0]);
        if (!Number.isInteger(score) || score < 1 || score > 10) {
            await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [Sentences.karma.ungueltigeEingabe, login]);
            return;
        }

        await this.nextcontrol.mongoDb.collection('karma').updateOne(
            { login, map: uid },
            { $set: { login, map: uid, score } },
            { upsert: true }
        );

        await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [
            format(Sentences.karma.voteErfolgreich, { score, map: mapName }), login
        ]);
    }

    /**
     * Zeigt die aktuelle Durchschnittsbewertung einer Map im Chat an.
     * @param {String} login Empfaenger (leer/null = an alle)
     * @param {String} uid Map-UID
     * @param {String} mapName Anzeigename der Map
     */
    async zeigeKarma(login, uid, mapName) {
        const ergebnis = await this.nextcontrol.mongoDb.collection('karma').aggregate([
            { $match: { map: uid } },
            { $group: { _id: '$map', schnitt: { $avg: '$score' }, stimmen: { $sum: 1 } } }
        ]).toArray();

        if (ergebnis.length === 0) {
            const msg = format(Sentences.karma.nochKeineStimmen, { map: mapName });
            if (login) await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [msg, login]);
            else await this.nextcontrol.client.query('ChatSendServerMessage', [msg]);
            return;
        }

        const { schnitt, stimmen } = ergebnis[0];
        const msg = format(Sentences.karma.currentKarma, { map: mapName, avg: schnitt.toFixed(1), stimmen });
        if (login) await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [msg, login]);
        else await this.nextcontrol.client.query('ChatSendServerMessage', [msg]);
    }

    /**
     * Baut die ManiaLink-XML fuer die klickbare Karma-Abstimmung (1-10) der gerade
     * beendeten Strecke. Layout-Formel analog localRecords.js/monatswechselAutomatik.js.
     * @param {String} uid Map-UID der gerade beendeten Strecke
     * @param {String} mapName Anzeigename der Map (kann TM-Formatierungscodes enthalten)
     */
    baueVotingManialinkXml(uid, mapName) {
        const PADDING = 2, KNOPF_GROESSE = 12, KNOPF_ABSTAND = 1.4, KNOPF_Y = 15;
        const BREITE = PADDING * 2 + 10 * KNOPF_GROESSE + 9 * KNOPF_ABSTAND;
        const HOEHE = KNOPF_Y + KNOPF_GROESSE + PADDING;

        const knoepfe = Array.from({ length: 10 }, (_, i) => {
            const wert = i + 1;
            // halign/valign="center" verschieben den Anker von "pos" auf die Mitte des
            // Elements -- quad und label muessen daher BEIDE denselben (Mittelpunkt-)pos
            // und dieselben halign/valign bekommen, sonst driften Kaestchen (quad, Anker
            // oben-links) und Ziffer (label, Anker Mitte) sichtbar auseinander.
            const mitteX = PADDING + i * (KNOPF_GROESSE + KNOPF_ABSTAND) + KNOPF_GROESSE / 2;
            const mitteY = -(KNOPF_Y + KNOPF_GROESSE / 2);
            const aktion = escapeXml(`${this.VOTE_AKTION_PRAEFIX}|${uid}|${wert}`);
            return `<quad pos="${mitteX} ${mitteY}" size="${KNOPF_GROESSE} ${KNOPF_GROESSE}" halign="center" valign="center" bgcolor="2a2a2acc" action="${aktion}" />
                <label pos="${mitteX} ${mitteY}" size="${KNOPF_GROESSE} ${KNOPF_GROESSE}" halign="center" valign="center" text="${wert}" textsize="1.8" class="text-value" action="${aktion}" />`;
        }).join('\n                ');

        return `<manialink id="${this.VOTING_MANIALINK_ID}" version="3">
            <frame posn="${-BREITE / 2} -55 5">
                <quad pos="0 0" size="${BREITE} ${HOEHE}" bgcolor="000000cc" />
                <label pos="${PADDING} -${PADDING}" size="${BREITE - 2 * PADDING} 4" text="${escapeXml(`Wie fandest du "${stripFormatting(mapName)}"?`)}" textsize="1.6" class="text-title" />
                <label pos="${PADDING} -${PADDING + 5}" size="${BREITE - 2 * PADDING} 3" text="1 = schlecht, 10 = super -- klick eine Zahl" textsize="1" class="text-value" />
                ${knoepfe}
            </frame>
        </manialink>`;
    }

    /**
     * Leere Seite mit derselben ID loescht die zuvor angezeigte Voting-Anzeige.
     */
    baueLeereVotingXml() {
        return `<manialink id="${this.VOTING_MANIALINK_ID}" version="3"></manialink>`;
    }

    /**
     * Anzeigedauer der Voting-Anzeige in Millisekunden, danach blendet der Client sie
     * selbststaendig aus (SendDisplayManialinkPage-Timeout-Parameter). Wichtig: bei
     * TimeAttack kann der Kartenwechsel (ManiaPlanet.EndMap -> ManiaPlanet.BeginMap)
     * praktisch uebergangslos passieren (in der Praxis < 1s, siehe Trainings-Server-Test
     * am 2026-09-01) -- ein Loeschen bei onBeginMap wuerde die Anzeige daher meist schon
     * wieder entfernen, bevor sie ueberhaupt gesehen werden kann. Der eingebaute
     * Timeout laesst sie stattdessen unabhaengig vom Kartenwechsel fuer diese Dauer stehen.
     * @type {Number}
     */
    VOTING_ANZEIGEDAUER_MS = 20000

    /**
     * Sendet die Karma-Voting-Anzeige -- entweder an alle Spieler (Broadcast, Kartenende)
     * oder gezielt an einen einzelnen Login (Hauptmenue-Aufruf "Aktuelle Karte bewerten").
     * @param {Classes.Map} map Die zu bewertende Karte
     * @param {{nurAnLogin?: String}} [optionen]
     */
    async sendeVotingManialink(map, { nurAnLogin } = {}) {
        const xml = this.baueVotingManialinkXml(map.uid, map.name);
        if (nurAnLogin) {
            await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [nurAnLogin, xml, this.VOTING_ANZEIGEDAUER_MS, false]);
        } else {
            await this.nextcontrol.client.query('SendDisplayManialinkPage', [xml, this.VOTING_ANZEIGEDAUER_MS, false]);
        }
    }

    /**
     * Function run, when a player clicks one of the Karma-Bewertungsknoepfe ODER den
     * "Aktuelle Karte bewerten"-Menue-Knopf.
     * @param {CallbackParams.ManialinkPageAnswer} params Callback parameters
     */
    async onManialinkPageAnswer(params) {
        if (dbtype !== 'mongodb') return;

        if (String(params.answer ?? '').startsWith(MENU_AKTION_PRAEFIX + '|')) {
            const map = this.nextcontrol.status.map;
            if (map) await this.sendeVotingManialink(map, { nurAnLogin: params.login });
            await schliesseMenue(this.nextcontrol, params.login);
            return;
        }

        const teile = String(params.answer ?? '').split('|');
        if (teile.length !== 3 || teile[0] !== this.VOTE_AKTION_PRAEFIX) return;

        const [, uid, wertText] = teile;
        const score = Number(wertText);
        if (!Number.isInteger(score) || score < 1 || score > 10) return;

        await this.nextcontrol.mongoDb.collection('karma').updateOne(
            { login: params.login, map: uid },
            { $set: { login: params.login, map: uid, score } },
            { upsert: true }
        );

        await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [
            format(Sentences.karma.voteErfolgreichManialink, { score }), params.login
        ]);

        // Voting-Anzeige nur fuer diesen Spieler ausblenden (nicht fuer alle anderen,
        // die evtl. noch nicht abgestimmt haben).
        await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [
            params.login, this.baueLeereVotingXml(), 0, false
        ]);
    }

    /**
     * Function run, when a map ends: Voting-Anzeige senden + Karma-Ergebnis der gerade
     * beendeten Strecke ansagen.
     * @param {Classes.Map} map Callback parameters
     */
    async onEndMap(map) {
        if (dbtype !== 'mongodb') return;

        await this.sendeVotingManialink(map);

        const ergebnis = await this.nextcontrol.mongoDb.collection('karma').aggregate([
            { $match: { map: map.uid } },
            { $group: { _id: '$map', schnitt: { $avg: '$score' }, stimmen: { $sum: 1 } } }
        ]).toArray();

        if (ergebnis.length === 0) return; // niemand hat bewertet -> keine Ansage

        const { schnitt, stimmen } = ergebnis[0];
        const mapSauber = stripFormatting(map.name), schnittText = schnitt.toFixed(1);
        const pruefWoerter = [mapSauber, schnittText, String(stimmen)];

        const ansage = await formuliereChatNachrichtUm(
            format(Sentences.karma.rundenendeAnsage, { map: map.name, avg: schnittText, stimmen }),
            { pruefWoerter }
        );
        await this.nextcontrol.client.query('ChatSendServerMessage', [ansage]);

        // Nur AUSSERGEWOEHNLICHE Karma-Ergebnisse ins Gaming-Log schreiben (Ausreisser mit
        // genug Stimmen), damit der KI-Kommentator (rennleitung.js) sie gelegentlich aufgreifen
        // kann. Mittelmaessige Bewertungen sind keine Besonderheit -> kein Event.
        if (stimmen >= 3 && (schnitt >= 8 || schnitt <= 3)) {
            const wertung = schnitt >= 8 ? 'ein Publikumsliebling' : 'kommt gar nicht gut an';
            const logText = await formuliereUm(
                `⭐ "${mapSauber}" endet mit Karma ${schnittText}/10 aus ${stimmen} Stimmen — ${wertung}.`,
                { pruefWoerter: [...pruefWoerter, '⭐'] }
            );
            await protokolliere(this.nextcontrol, 'karma', logText);
        }
    }
}
