
import { Sentences } from '../lib/sentences.js'
import * as util from '../lib/utilities.js'
import { protokolliere } from '../lib/eventLog.js'
import { formuliereChatNachrichtUm, formuliereUm } from '../lib/kiEnrich.js'
import { Settings } from '../settings.js'
let dbtype = Settings.usedDatabase.toLocaleLowerCase();

import * as CallbackParams from '../lib/callbackparams.js'
import * as Classes from '../lib/classes.js'
import { NextControl } from '../nextcontrol.js'
import { kodiereAktion, dekodiereAktion, schliesseMenue } from '../lib/manialinkMenu.js'

const AKTION_PRAEFIX = 'rekorde';

/**
 * Local Records plugin
 */
export class LocalRecords {

    /**
     * Plugin name
     * @type {String}
     */
    name           = 'Streckenrekorde'

    /**
     * Plugin author
     * @type {String}
     */
    author         = 'dassschaf'

    /**
     * Plugin description
     * @type {String}
     */
    description    = 'Verwaltet und meldet die lokalen Streckenrekorde'

    /**
     * Local reference to the main instance
     * @type {NextControl}
     */
    nextcontrol

    /**
     * Anzahl Eintraege in der ManiaLink-Ranglistenanzeige.
     * @type {Number}
     */
    ANZAHL_RANGLISTE = 10

    /**
     * Signatur (Karten-UID+Logins+Zeiten) der zuletzt per Broadcast versendeten
     * Ranglistenanzeige, um unnoetige wiederholte SendDisplayManialinkPage-Aufrufe
     * bei unveraendertem Ergebnis zu vermeiden. Muss die Karten-UID mit einschliessen,
     * da die Anzeigetafel eine einzige globale ManiaLink-Seite ist -- ein rein
     * pro-Karte gefuehrter Cache wuerde beim Zurueckwechseln auf eine bereits zuvor
     * gezeigte, seither unveraenderte Karte faelschlich den Resend uebersprungen und
     * die zuletzt anders angezeigte Karte stehen lassen.
     * @type {?string}
     */
    letzteGesendeteSignatur = null

    /**
     * Constructor, registering the chat commands at the main class upon plugin loading
     * @param {NextControl} nextcontrol The script's brain we require to properly register the chat commands
     */
    constructor(nextcontrol) {
        nextcontrol.registerChatCommand(new Classes.ChatCommand('rekorde', this.chat_recs, 'Zeigt die Streckenrekorde der aktuellen Karte an.', this.name));

        nextcontrol.registerMenuEintrag(new Classes.MenuEintrag(
            'Allgemein', 'Streckenrekorde', kodiereAktion(AKTION_PRAEFIX, 'zeigen'), { pluginName: this.name }
        ));

        // save reference to the main instance
        this.nextcontrol = nextcontrol;

        // Anzeigetafel fuer die beim Start bereits verbundenen Spieler senden --
        // nextcontrol.status ist erst kurz nach der Konstruktion befuellt, und
        // ManiaPlanet.BeginMap feuert fuer die schon laufende Karte nie (siehe
        // Kommentar in nextcontrol.js), daher hier per Verzoegerung nachholen.
        setTimeout(() => this.sendeRanglistenAnzeige(), 1000);
    }

    /**
     * Liefert die Top-N-Streckenrekorde einer Karte (Login/Name/Zeit), sortiert nach Zeit.
     * @param {String} uid Karten-UID
     * @returns {Promise<Array<{login: String, name: String, time: Number}>>}
     */
    async holeRangliste(uid) {
        if (dbtype !== 'mongodb') return [];

        let records = await this.nextcontrol.mongoDb.collection('records').aggregate([
            { $match: { map: uid } },
            { $sort: { time: 1 } },
            { $limit: this.ANZAHL_RANGLISTE },
            { $lookup: {
                from: 'players',
                localField: 'login',
                foreignField: 'login',
                as: 'player'
            }}
        ]);

        records = await records.toArray();

        return records.map(rec => ({ login: rec.login, name: rec.player[0]?.name ?? rec.login, time: rec.time }));
    }

    /**
     * Baut die ManiaLink-XML fuer die dauerhafte Ranglisten-Anzeigetafel (rein informativ,
     * keine klickbaren Elemente).
     * @param {Array<{login: String, name: String, time: Number}>} rangliste
     */
    baueRanglisteManialinkXml(rangliste) {
        // Innenabstand oben/unten + Titelzeile + je eine Zeilenhoehe pro Eintrag --
        // vorherige Formel hat den Platzbedarf der Titelzeile nicht mitgerechnet,
        // wodurch der letzte Eintrag unten aus dem Hintergrund-Quad herausragte.
        const PADDING = 2, TITEL_HOEHE = 5, ZEILEN_HOEHE = 5;
        const effektiveZeilen = Math.max(rangliste.length, 1);
        const hoehe = PADDING * 2 + TITEL_HOEHE + effektiveZeilen * ZEILEN_HOEHE;

        const zeilen = rangliste.length > 0
            ? rangliste.map((rec, i) => `<label pos="2 ${-(PADDING + TITEL_HOEHE + i * ZEILEN_HOEHE)}" size="34 4" text="${util.escapeXml(`${i + 1}. ${util.stripFormatting(rec.name)} – ${util.msToString(rec.time)}`)}" textsize="1" class="text-value" />`).join('\n                ')
            : `<label pos="2 ${-(PADDING + TITEL_HOEHE)}" size="34 4" text="Noch keine Rekorde" textsize="1" class="text-value" />`;

        return `<manialink id="rekordanzeige-rangliste" version="3">
            <frame posn="122 88 5">
                <quad pos="0 0" size="38 ${hoehe}" bgcolor="000000cc" />
                <label pos="2 -${PADDING}" size="34 4" text="Top ${this.ANZAHL_RANGLISTE}" textsize="1.5" class="text-title" />
                ${zeilen}
            </frame>
        </manialink>`;
    }

    /**
     * Sendet die Ranglisten-Anzeigetafel fuer die aktuelle Karte -- entweder an alle
     * Spieler (Broadcast) oder gezielt an einen einzelnen, neu verbundenen Login.
     * Sendet nur erneut, wenn sich die Rangliste seit dem letzten Broadcast fuer diese
     * Karte tatsaechlich geaendert hat.
     * @param {{nurAnLogin?: String}} [optionen]
     */
    async sendeRanglistenAnzeige({ nurAnLogin } = {}) {
        const map = this.nextcontrol.status.map;
        if (!map) return;

        const rangliste = await this.holeRangliste(map.uid);
        const signatur = `${map.uid}|${JSON.stringify(rangliste.map(rec => [rec.login, rec.time]))}`;

        if (!nurAnLogin && this.letzteGesendeteSignatur === signatur) return;

        const xml = this.baueRanglisteManialinkXml(rangliste);

        if (nurAnLogin) {
            await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [nurAnLogin, xml, 0, false]);
        } else {
            await this.nextcontrol.client.query('SendDisplayManialinkPage', [xml, 0, false]);
            this.letzteGesendeteSignatur = signatur;
        }
    }

    /**
     * Function run, when a new map begins -- aktualisiert die Ranglisten-Anzeigetafel fuer die neue Karte.
     * @param {Classes.Map} map
     */
    async onBeginMap(map) {
        await this.sendeRanglistenAnzeige();
    }

    /**
     * Function run, when a player connects -- sendet die aktuelle Ranglisten-Anzeigetafel
     * gezielt an den neu verbundenen Spieler, damit er nicht bis zum naechsten
     * Kartenwechsel warten muss.
     * @param {Classes.PlayerInfo} p
     * @param {Boolean} isSpectator
     */
    async onPlayerConnect(p, isSpectator) {
        await this.sendeRanglistenAnzeige({ nurAnLogin: p.login });
    }

    /**
     * Chat command, to display local recs on current map
     * @param {String} login Login of the player calling this command
     * @param {Array<String>} params Parameters passed by the player after the command (seperated by space)
     */
    async chat_recs(login, params) {
        let map = this.nextcontrol.status.map;

        // print local records to chat
        if (dbtype === 'mongodb') {
            if ((await this.nextcontrol.mongoDb.collection('records').countDocuments({map : map.uid})) < 1) {
                this.nextcontrol.client.query("ChatSendServerMessageToLogin", [util.format(Sentences.localRecords.noneYet, { when: Sentences.localRecords.rightnow, map: map.name}), login]);

            } else {
                let msg = util.format(Sentences.localRecords.listBegin, {map: map.name, when: Sentences.localRecords.rightnow});

                let records = await this.nextcontrol.mongoDb.collection('records').aggregate([
                    { $match: { map: map.uid } },
                    { $sort: { time: 1 }},
                    { $lookup: {
                        from: 'players',
                        localField: 'login',
                        foreignField: 'login',
                        as: 'player'
                    }}]);

                records = await records.toArray();

                records.forEach((rec, i) => {
                    msg += '\n' + util.format(Sentences.localRecords.listItem, {pos: i+1, name: rec.player[0].name, time: util.msToString(rec.time)});
                })

                await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [msg, login]);
            }
        } else if (dbtype === 'mysql') {
            // TODO
        }
    }

    /**
     * Function run, when a player clicks the "Streckenrekorde"-Menue-Knopf.
     * @param {CallbackParams.ManialinkPageAnswer} params
     */
    async onManialinkPageAnswer(params) {
        const { namespace, teile } = dekodiereAktion(params.answer);
        if (namespace !== AKTION_PRAEFIX) return;

        if (teile[0] === 'zeigen') await this.chat_recs(params.login, []);

        await schliesseMenue(this.nextcontrol, params.login);
    }

    /**
     * Function run, when a new match begins
     */
    async onBeginMatch() {

        let map = this.nextcontrol.status.map;

        // print local records to chat
        if (dbtype === 'mongodb') {
            if ((await this.nextcontrol.mongoDb.collection('records').countDocuments({map : map.uid})) < 1) {
                this.nextcontrol.client.query('ChatSendServerMessage', [util.format(Sentences.localRecords.noneYet, { when: Sentences.localRecords.before, map: map.name})]);
            } else {
                let msg = util.format(Sentences.localRecords.listBegin, {map: map.name, when: Sentences.localRecords.before});

                let records = await this.nextcontrol.mongoDb.collection('records').aggregate([
                    { $match: { map: map.uid } },
                    { $sort: { time: 1 }},
                    { $lookup: {
                        from: 'players',
                        localField: 'login',
                        foreignField: 'login',
                        as: 'player'
                    }}]);

                records = await records.toArray();

                //console.log(JSON.stringify(records));

                records.forEach((rec, i) => {
                    msg += '\n' + util.format(Sentences.localRecords.listItem, {pos: i+1, name: rec.player[0].name, time: util.msToString(rec.time)});
                })

                await this.nextcontrol.client.query('ChatSendServerMessage', [msg]);
            }
        } else if (dbtype === 'mysql') {
            // TODO
        }
    }

    /**
     * Function run, when a map ends
     * @param {CallbackParams.MatchResults} map Callback parameters
     */
    async onEndMatch(results) {
        let map = this.nextcontrol.status.map;

        // print local records to chat
        if (dbtype === 'mongodb') {
            if ((await this.nextcontrol.mongoDb.collection('records').countDocuments({map : map.uid})) < 1) {
                this.nextcontrol.client.query('ChatSendServerMessage', [util.format(Sentences.localRecords.noneYet, { when: Sentences.localRecords.after, map: map.name})]);
            
            } else {
                let msg = util.format(Sentences.localRecords.listBegin, {map: map.name, when: Sentences.localRecords.after});

                let records = await this.nextcontrol.mongoDb.collection('records').aggregate([
                    { $match: { map: map.uid } },
                    { $sort: { time: 1 }},
                    { $lookup: {
                        from: 'players',
                        localField: 'login',
                        foreignField: 'login',
                        as: 'player'
                    }}]);

                records = await records.toArray();

                records.forEach((rec, i) => {
                    msg += '\n' + util.format(Sentences.localRecords.listItem, {pos: i+1, name: rec.player[0].name, time: util.msToString(rec.time)});
                })

                await this.nextcontrol.client.query('ChatSendServerMessage', [msg]);
            }
        } else if (dbtype === 'mysql') {
            // TODO
        }
    }

    /**
     * Function run, whenever a player passes a waypoint (finish, multilap, checkpoint, ...)
     * @param {Classes.WaypointInfo} waypointInfo
     */
    async onWaypoint(waypointInfo) {

        if (waypointInfo.isEndRace == true) this.onFinish(waypointInfo.login, waypointInfo.raceTime);

    }

    /**
     * Function run, when a player passes the finish line and finishes their run
     * @param {String} login
     * @param {Number} timeOrScore
     */
    async onFinish(login, timeOrScore) {

        let uid = this.nextcontrol.status.map.uid;

        let timeString = util.msToString(timeOrScore);

        if (dbtype === 'mongodb') {
            // get current local record and determine whether improvement
            if ((await this.nextcontrol.mongoDb.collection('records').countDocuments({ map: uid, login: login })) == 0) {
                // no record exists yet
                // insert new record document
                let rec = new Classes.LocalRecord(login, timeOrScore, uid);

                await this.nextcontrol.mongoDb.collection('records').insertOne(rec);

                let pos = util.nth((await this.nextcontrol.mongoDb.collection('records').countDocuments({map: uid, time: {$lt: rec.time}})) + 1),
                    name = this.nextcontrol.status.getPlayer(login).name;

                const nameSauber = util.stripFormatting(name), mapSauber = util.stripFormatting(this.nextcontrol.status.map.name);
                const pruefWoerter = [nameSauber, pos, timeString];

                let msg = util.format(Sentences.localRecords.claimed, {player: name, pos: pos, time: timeString});
                msg = await formuliereChatNachrichtUm(msg, { pruefWoerter, sprache: 'en' });

                await this.nextcontrol.client.query('ChatSendServerMessage', [msg]);

                util.logger('r', `${nameSauber} claimed ${pos} local record (${timeString}) on ${mapSauber}`);
                const logText = await formuliereUm(`🏆 ${nameSauber} hat den ${pos} Rekord auf ${mapSauber} aufgestellt (${timeString})`, { pruefWoerter: [...pruefWoerter, mapSauber, '🏆'] });
                await protokolliere(this.nextcontrol, 'rekord', logText);

            } else {
                let rec = new Classes.LocalRecord(login, timeOrScore, uid);

                // there is already an existing, matching record:
                let currentRecord = await this.nextcontrol.mongoDb.collection('records').findOne({ map: uid, login: login });

                // if improvement, update record and determine position
                if (currentRecord.time > timeOrScore) { 
                    // improvement!

                    // save new new time to database
                    await this.nextcontrol.mongoDb.collection('records').updateOne({login: login, map: uid}, {$set: rec});

                    // send improvement message:
                    let improvement = - (currentRecord.time - rec.time) / 1000,
                        pos = util.nth((await this.nextcontrol.mongoDb.collection('records').countDocuments({map: uid, time: {$lt: rec.time}})) + 1),
                        name = this.nextcontrol.status.getPlayer(login).name;

                    const nameSauber = util.stripFormatting(name), mapSauber = util.stripFormatting(this.nextcontrol.status.map.name);
                    const pruefWoerter = [nameSauber, pos, timeString];
                    // Vorzeichenbehaftet, 3 Nachkommastellen -- gleiche Praezision wie die Rundenzeit
                    // selbst (Millisekunden), Format wie in Trackmania ueblich, z.B. "-0.025".
                    const deltaText = improvement.toFixed(3);

                    let msg = util.format(Sentences.localRecords.improved, {player: name, pos: pos, time: timeString, imp: improvement});
                    msg = await formuliereChatNachrichtUm(msg, { pruefWoerter, sprache: 'en' });

                    await this.nextcontrol.client.query('ChatSendServerMessage', [msg]);
                    util.logger('r', `${nameSauber} improved to ${pos} local record (${timeString}) on ${mapSauber}`);
                    const logText = await formuliereUm(`🏆 ${nameSauber} hat seinen Rekord auf ${mapSauber} auf Platz ${pos} verbessert (${timeString}, ${deltaText})`, { pruefWoerter: [...pruefWoerter, mapSauber, '🏆', deltaText] });
                    await protokolliere(this.nextcontrol, 'rekord', logText);

                } else if (currentRecord.time == timeOrScore) {
                    let pos = util.nth((await this.nextcontrol.mongoDb.collection('records').countDocuments({map: uid, time: {$lt: rec.time}})) + 1),
                        name = this.nextcontrol.status.getPlayer(login).name;

                    const nameSauber = util.stripFormatting(name), mapSauber = util.stripFormatting(this.nextcontrol.status.map.name);
                    const pruefWoerter = [nameSauber, pos, timeString];

                    let msg = util.format(Sentences.localRecords.equalled, {player: name, pos: pos, time: timeString});
                    msg = await formuliereChatNachrichtUm(msg, { pruefWoerter, sprache: 'en' });

                    await this.nextcontrol.client.query('ChatSendServerMessage', [msg]);
                    util.logger('r', `${nameSauber} equalled their ${pos} local record (${timeString}) on ${mapSauber}`);
                    const logText = await formuliereUm(`🏆 ${nameSauber} hat den ${pos} Rekord auf ${mapSauber} egalisiert (${timeString})`, { pruefWoerter: [...pruefWoerter, mapSauber, '🏆'] });
                    await protokolliere(this.nextcontrol, 'rekord', logText);

                } // else: currentRecord.time < timeOrScore, no improvement, ignore this
            } // else, ignore.
        } else if (dbtype === 'mysql') {
            // TODO
        }

        await this.sendeRanglistenAnzeige();
    }

}