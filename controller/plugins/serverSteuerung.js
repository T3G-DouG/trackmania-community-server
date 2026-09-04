import { logger, stripFormatting, format } from '../lib/utilities.js'
import { protokolliere } from '../lib/eventLog.js'
import { formuliereUm } from '../lib/kiEnrich.js'
import * as Classes from '../lib/classes.js'
import { TMX } from '../lib/tmx.js'
import { NextControl } from '../nextcontrol.js'

import * as fs from 'fs';
import got from 'got';

/** Wie oft auf einen ausstehenden Dashboard-Serverbefehl geprueft wird -- kurz getaktet,
 * damit ein Knopfdruck im Dashboard (Strecke ueberspringen o.ae.) sich sofort anfuehlt. */
const KOMMANDO_TICK_MS = 10 * 1000;

/** Maximales Alter eines Befehls, bevor er noch ausgefuehrt wird. Ein Dashboard-Klick soll sich
 * sofort anfuehlen -- alles Aeltere ist mit hoher Wahrscheinlichkeit ein Leichen-Eintrag aus einer
 * Testsitzung (Controller war beim Klick nicht erreichbar) und wuerde sonst beim naechsten
 * Controller-Boot ueberraschend nachgetriggert. */
const KOMMANDO_MAX_ALTER_MS = 5 * 60 * 1000;

/**
 * Fuehrt Serversteuerungs-Befehle aus, die bisher nur als In-Game-/Telegram-`/admin`-
 * Befehle existierten (admin.js, jukebox.js), jetzt auch vom Website-Dashboard aus -- ueber
 * denselben adminKommandos-Mechanismus wie der Analyse-Trigger (Muster:
 * controller/plugins/analyse.js pruefeAdminKommando()). Bewusst ein EIGENES Plugin statt
 * Erweiterung von admin.js: dessen Methoden sind fest an einen echten eingeloggten Spieler
 * (login/getPlayer(login).name) gebunden, ein Dashboard-Trigger hat keinen.
 */
export class ServerSteuerung {
    name = 'Server-Steuerung (Dashboard)'
    author = 'system'
    description = 'Fuehrt vom Admin-Dashboard ausgeloeste Serverbefehle aus (Strecke ueberspringen/neustarten, Zeit verlaengern, Jukebox leeren, MatchSettings, Karten hinzufuegen/entfernen, Shutdown)'
    version = '1.0.0'

    /** @type {NextControl} */
    nextcontrol

    constructor(nextcontrol) {
        this.nextcontrol = nextcontrol;

        this.kommandoTimer = setInterval(
            () => this.pruefeAdminKommando().catch((e) => logger('er', `ServerSteuerung: Tick-Fehler: ${e.message}`)),
            KOMMANDO_TICK_MS
        );
        logger('dg', 'ServerSteuerung: Dashboard-Serverbefehle aktiv (Polling alle 10s).');
    }

    /**
     * Prueft auf einen ausstehenden Serverbefehl (Collection adminKommandos, {typ:'serverBefehl',
     * erledigtAm:null}), beansprucht ihn ATOMAR (identisches Muster wie analyse.js) und fuehrt
     * ihn aus. Wirft nie unbehandelt.
     * @private
     */
    async pruefeAdminKommando() {
        let treffer;
        try {
            treffer = await this.nextcontrol.mongoDb.collection('adminKommandos')
                .find({ typ: 'serverBefehl', erledigtAm: null })
                .sort({ angefordertAm: 1 })
                .limit(1)
                .toArray();
        } catch (error) {
            logger('er', `ServerSteuerung: adminKommandos-Abfrage fehlgeschlagen: ${error.message}`);
            return;
        }
        if (!treffer.length) return;
        const kommando = treffer[0];

        const alterMs = Date.now() - new Date(kommando.angefordertAm).getTime();
        if (alterMs > KOMMANDO_MAX_ALTER_MS) {
            try {
                await this.nextcontrol.mongoDb.collection('adminKommandos').updateOne(
                    { _id: kommando._id, erledigtAm: null },
                    { $set: { erledigtAm: new Date(), ergebnis: `abgelaufen: zu alt fuer automatische Ausfuehrung (${Math.round(alterMs / 1000)}s seit Anforderung)` } }
                );
            } catch (error) {
                logger('er', `ServerSteuerung: Verwerfen des abgelaufenen Befehls fehlgeschlagen: ${error.message}`);
            }
            logger('w', `ServerSteuerung: Befehl '${kommando.befehl}' verworfen -- zu alt (${Math.round(alterMs / 1000)}s seit Anforderung).`);
            return;
        }

        let beansprucht;
        try {
            beansprucht = await this.nextcontrol.mongoDb.collection('adminKommandos').updateOne(
                { _id: kommando._id, erledigtAm: null },
                { $set: { erledigtAm: new Date() } }
            );
        } catch (error) {
            logger('er', `ServerSteuerung: adminKommandos-Markierung fehlgeschlagen: ${error.message}`);
            return;
        }
        if (beansprucht.modifiedCount === 0) return; // von einem anderen Tick bereits beansprucht

        logger('dg', `ServerSteuerung: Befehl '${kommando.befehl}' vom Admin-Dashboard erkannt.`);
        let ergebnis;
        try {
            ergebnis = await this.fuehreBefehlAus(kommando.befehl, kommando.parameter ?? {});
        } catch (error) {
            logger('er', `ServerSteuerung: Befehl '${kommando.befehl}' fehlgeschlagen: ${error.message}`);
            ergebnis = { erfolgreich: false, meldung: error.message };
        }

        try {
            await this.nextcontrol.mongoDb.collection('adminKommandos').updateOne(
                { _id: kommando._id },
                { $set: { ergebnis: ergebnis.erfolgreich ? 'erfolgreich' : `fehlgeschlagen: ${ergebnis.meldung ?? ''}` } }
            );
        } catch (error) {
            logger('er', `ServerSteuerung: adminKommandos-Ergebnis konnte nicht gespeichert werden: ${error.message}`);
        }
    }

    /**
     * Fuehrt einen einzelnen Befehl aus. Jeder Zweig meldet chat + Ereignis-Log, analog zu den
     * entsprechenden In-Game-Befehlen in admin.js/jukebox.js, nur ohne Bezug auf einen Spieler.
     * @param {string} befehl
     * @param {object} parameter
     * @returns {Promise<{erfolgreich: boolean, meldung?: string}>}
     * @private
     */
    async fuehreBefehlAus(befehl, parameter) {
        const q = (methode, args) => this.nextcontrol.client.query(methode, args);
        const broadcast = (text) => q('ChatSendServerMessage', [text]);
        const log = (typ, text) => protokolliere(this.nextcontrol, typ, text);

        switch (befehl) {
            case 'skip': {
                await q('NextMap');
                await broadcast('$ff0Dashboard:$z$s$fff die Strecke wird übersprungen.');
                await log('admin', '⏭️ Strecke per Dashboard übersprungen');
                return { erfolgreich: true };
            }

            case 'restart': {
                await q('RestartMap');
                await broadcast('$ff0Dashboard:$z$s$fff die Strecke wird neu gestartet.');
                await log('admin', '🔁 Strecke per Dashboard neu gestartet');
                return { erfolgreich: true };
            }

            case 'extend': {
                const sekunden = Number(parameter.sekunden);
                if (!Number.isFinite(sekunden) || sekunden <= 0) return { erfolgreich: false, meldung: 'ungültige Sekundenzahl' };
                if (!this.nextcontrol.modeSettings.isTimeExtendable()) {
                    return { erfolgreich: false, meldung: 'Spielmodus unterstützt keine Zeitverlängerung' };
                }
                const ok = await this.nextcontrol.modeSettings.extendTime(sekunden);
                if (!ok) return { erfolgreich: false, meldung: 'ExtendTime fehlgeschlagen' };
                await broadcast(`$ff0Dashboard:$z$s$fff die Spielzeit wurde um ${sekunden}s verlängert.`);
                await log('admin', `⏱️ Spielzeit per Dashboard um ${sekunden}s verlängert`);
                return { erfolgreich: true };
            }

            case 'jukeboxClear': {
                this.nextcontrol.jukebox.reset();
                await broadcast('$ff0Dashboard:$z$s$fff die Jukebox wurde geleert.');
                await log('admin', '🎵 Jukebox per Dashboard geleert');
                return { erfolgreich: true };
            }

            case 'modeSave': {
                await this.nextcontrol.modeSettings.saveSettingsToFile();
                await log('admin', '💾 MatchSettings per Dashboard gespeichert');
                return { erfolgreich: true };
            }

            case 'modeRead': {
                await this.nextcontrol.modeSettings.readMatchSettings();
                await log('admin', '📖 MatchSettings per Dashboard neu eingelesen');
                return { erfolgreich: true };
            }

            case 'modeReset': {
                await this.nextcontrol.modeSettings.resetSettings();
                await log('admin', '↩️ MatchSettings per Dashboard zurückgesetzt');
                return { erfolgreich: true };
            }

            case 'mapTmx': {
                const tmxId = Number(parameter.tmxId);
                if (!Number.isFinite(tmxId) || tmxId <= 0) return { erfolgreich: false, meldung: 'ungültige TMX-ID' };

                const directory = this.nextcontrol.status.directories.maps + '/TMX/';
                const filename = tmxId + '.Map.Gbx';
                if (!fs.existsSync(directory)) fs.mkdirSync(directory);

                const url = TMX.site + '/maps/download/' + tmxId;
                const request = await got(url, { headers: TMX.headers, encoding: 'binary' });
                fs.writeFileSync(directory + filename, request.rawBody);

                const map = new Classes.Map(await q('GetMapInfo', [directory + filename]));
                map.setTMXId(tmxId);

                await q('InsertMap', [directory + filename]);
                await this.nextcontrol.mongoDb.collection('maps').insertOne(map);

                // volle TMX-Signale sofort cachen statt erst bei Bedarf (Karma-Voting) --
                // fire-and-forget, blockiert die Dashboard-Aktion nicht.
                TMX.aktualisiereCache(this.nextcontrol.mongoDb, map.uid);

                const nameSauber = stripFormatting(map.name);
                await broadcast(format('$ff0Dashboard:$z$s$fff Karte $ff0%map%$fff von TMX hinzugefügt.', { map: map.name }));
                const logText = await formuliereUm(`➕ Karte "${nameSauber}" per Dashboard von TMX hinzugefügt`, { pruefWoerter: [nameSauber, '➕'] });
                await log('admin', logText);
                return { erfolgreich: true };
            }

            case 'mapEntfernen': {
                const uid = parameter.uid;
                if (!uid || typeof uid !== 'string') return { erfolgreich: false, meldung: 'ungültige Karten-UID' };

                const map = await this.nextcontrol.mongoDb.collection('maps').findOne({ uid });
                if (!map) return { erfolgreich: false, meldung: 'Karte nicht gefunden' };

                await q('RemoveMap', [map.file]);
                await this.nextcontrol.mongoDb.collection('maps').deleteOne({ uid });

                const nameSauber = stripFormatting(map.name);
                await broadcast(format('$ff0Dashboard:$z$s$fff Karte $ff0%map%$fff entfernt.', { map: map.name }));
                const logText = await formuliereUm(`➖ Karte "${nameSauber}" per Dashboard entfernt`, { pruefWoerter: [nameSauber, '➖'] });
                await log('admin', logText);
                return { erfolgreich: true };
            }

            case 'shutdown': {
                if (parameter.bestaetigt !== true) return { erfolgreich: false, meldung: 'nicht bestätigt' };
                await broadcast('$z$s$ff0~~ $fffController wird über das Dashboard heruntergefahren...');
                await log('admin', '⛔ Controller per Dashboard heruntergefahren');
                logger('w', 'ServerSteuerung: Shutdown ueber Admin-Dashboard ausgeloest!');
                // Verzoegert beenden, damit Chat-Nachricht + Log-/Ergebnis-Schreibvorgaenge
                // (siehe pruefeAdminKommando()) sicher vor dem Prozessende abgeschlossen sind.
                setTimeout(() => process.exit(0), 1500);
                return { erfolgreich: true };
            }

            default:
                return { erfolgreich: false, meldung: `unbekannter Befehl '${befehl}'` };
        }
    }
}
