import os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { Settings } from '../settings.js'
import { logger, stripFormatting } from '../lib/utilities.js'
import { Sentences } from '../lib/sentences.js'
import { protokolliere } from '../lib/eventLog.js'
import { sendeTelegramWarnung } from '../lib/telegramAlert.js'
import { formuliereUm } from '../lib/kiEnrich.js'
import { NextControl } from '../nextcontrol.js'

const AKTUALISIERUNGS_INTERVALL_MS = 5000;

/**
 * Hält einen serverStatus-Snapshot (aktuelle Map, Online-Spieler, Server- und
 * Hardware-Auslastung) in MongoDB aktuell, damit die Website ein echtes
 * Live-Dashboard anzeigen kann, ohne selbst mit dem Dedicated Server oder dem
 * Betriebssystem zu sprechen -- die Website liest nur aus der Datenbank.
 */
export class LiveStatus {
    name = 'Live Status'
    author = 'system'
    description = 'Hält einen Live-Status-Snapshot (Map, Online-Spieler, Server-/Hardware-Auslastung) für die Website aktuell'
    version = '1.2.0'

    /** @type {NextControl} */
    nextcontrol

    /** @type {number|null} Maximale Spieleranzahl, einmalig beim Start abgefragt */
    maxSpieler = null

    /** Zeitpunkt, seit dem der Controller läuft (für "Controller aktiv seit") */
    startZeit = new Date();

    /** Letzter os.cpus()-Snapshot, um CPU-Auslastung per Delta zu berechnen */
    letzterCpuSnapshot = null;

    /** Root-Verzeichnis des Laufwerks, auf dem der Controller laeuft (z.B. "C:\\"), fuer die Plattenauslastung. */
    plattenPfad = path.parse(process.cwd()).root;

    /** True, solange der letzte Mongo-Zugriff fehlgeschlagen ist (fuer Erholungs-Erkennung) */
    mongoWarAusgefallen = false;

    constructor(nextcontrol) {
        this.nextcontrol = nextcontrol;
        // Initialer Snapshot kurz nach dem Start (Status ist zu diesem Zeitpunkt schon initialisiert)
        setTimeout(async () => {
            try {
                const info = await this.nextcontrol.client.query('GetMaxPlayers');
                this.maxSpieler = info?.CurrentValue ?? null;
            } catch (error) {
                logger('er', `LiveStatus: GetMaxPlayers fehlgeschlagen: ${error.message}`);
            }
            await this.aktualisieren();
        }, 1000);

        // Periodische Aktualisierung, damit CPU/RAM auch ohne Spieler-Events aktuell bleiben
        setInterval(() => this.aktualisieren(), AKTUALISIERUNGS_INTERVALL_MS);
    }

    /** Berechnet die CPU-Auslastung in Prozent seit dem letzten Aufruf (Delta über alle Kerne). */
    berechneCpuProzent() {
        const kerne = os.cpus();
        const summe = kerne.reduce((acc, kern) => {
            const { user, nice, sys, idle, irq } = kern.times;
            acc.gesamt += user + nice + sys + idle + irq;
            acc.idle += idle;
            return acc;
        }, { gesamt: 0, idle: 0 });

        let prozent = 0;
        if (this.letzterCpuSnapshot) {
            const deltaGesamt = summe.gesamt - this.letzterCpuSnapshot.gesamt;
            const deltaIdle = summe.idle - this.letzterCpuSnapshot.idle;
            prozent = deltaGesamt > 0 ? Math.round((1 - deltaIdle / deltaGesamt) * 1000) / 10 : 0;
        }
        this.letzterCpuSnapshot = summe;
        return prozent;
    }

    /** Liest die Plattenauslastung von plattenPfad (fs.statfs, seit Node 18.15 plattformuebergreifend
     * inkl. Windows verfuegbar). Wirft nie -- liefert null bei Nichtverfuegbarkeit (alte Node-Version,
     * exotisches Dateisystem), damit ein fehlendes Feature nie den ganzen Status-Schreibvorgang killt. */
    async liesPlattenAuslastung() {
        try {
            const s = await fs.promises.statfs(this.plattenPfad);
            const totalBytes = s.blocks * s.bsize;
            const freiBytes = s.bfree * s.bsize;
            const belegtBytes = totalBytes - freiBytes;
            return {
                platteUsedGb: Math.round((belegtBytes / 1024 / 1024 / 1024) * 10) / 10,
                platteTotalGb: Math.round((totalBytes / 1024 / 1024 / 1024) * 10) / 10,
                plattePercent: totalBytes > 0 ? Math.round((belegtBytes / totalBytes) * 1000) / 10 : 0,
            };
        } catch (error) {
            logger('er', `LiveStatus: Plattenauslastung nicht lesbar (${this.plattenPfad}): ${error.message}`);
            return null;
        }
    }

    /** Schreibt den aktuellen Map-/Spieler-/System-Status nach serverStatus._id="live". */
    async aktualisieren() {
        try {
            const map = this.nextcontrol.status?.map;
            const spieler = (this.nextcontrol.status?.players ?? []).map((p) => ({ login: p.login, name: p.name }));

            const ramTotal = os.totalmem();
            const ramFrei = os.freemem();
            const ramBelegt = ramTotal - ramFrei;
            const platte = await this.liesPlattenAuslastung();

            await this.nextcontrol.mongoDb.collection('serverStatus').replaceOne(
                { _id: 'live' },
                {
                    _id: 'live',
                    map: map ? { uid: map.uid, name: map.name, author: map.author } : null,
                    spieler,
                    system: {
                        cpuPercent: this.berechneCpuProzent(),
                        ramUsedMb: Math.round(ramBelegt / 1024 / 1024),
                        ramTotalMb: Math.round(ramTotal / 1024 / 1024),
                        ramPercent: Math.round((ramBelegt / ramTotal) * 1000) / 10,
                        ...(platte ?? {}),
                    },
                    server: {
                        spielerAnzahl: spieler.length,
                        maxSpieler: this.maxSpieler,
                        controllerLaeuftSeit: this.startZeit,
                    },
                    updatedAt: new Date(),
                },
                { upsert: true }
            );

            // Erholt sich die DB gerade von einem Aussetzer? Einmalig warnen, dass
            // Zeiten aus dem Ausfallzeitraum evtl. nicht gespeichert wurden.
            if (this.mongoWarAusgefallen) {
                this.mongoWarAusgefallen = false;
                logger('w', 'LiveStatus: MongoDB wieder erreichbar nach Aussetzer -- warne Spieler.');
                await this.nextcontrol.client.query('ChatSendServerMessage', [Sentences.system.datenbankAussetzer]).catch(() => {});
                await sendeTelegramWarnung('⚠️ Der Server hatte kurz einen Datenbank-Aussetzer (MongoDB nicht erreichbar). Zeiten aus diesem Zeitraum wurden möglicherweise nicht gespeichert. Betroffene Spieler sollten sich neu verbinden und ggf. betroffene Zeiten nochmal fahren.');
                await protokolliere(this.nextcontrol, 'admin', '⚠️ Datenbank-Aussetzer erkannt, Spieler wurden gewarnt (Zeiten evtl. nicht gespeichert)');
            }
        } catch (error) {
            this.mongoWarAusgefallen = true;
            logger('er', `LiveStatus: Fehler beim Aktualisieren: ${error.message}`);
        }
    }

    async onBeginMap(map) {
        // Streckenwechsel wird bewusst NICHT mehr im Gaming-Log gezeigt -- reiner
        // Leerlauf-Spam bei automatischer Rotation ohne Spieler (Betreiber-Wunsch).
        await this.aktualisieren();
    }

    async onPlayerConnect(player, isSpectator) {
        await this.aktualisieren();
        const name = stripFormatting(player.name);
        const original = `🟢 ${name} ist beigetreten${isSpectator ? ' (Zuschauer)' : ''}`;
        const text = await formuliereUm(original, { pruefWoerter: [name, '🟢'] });
        await protokolliere(this.nextcontrol, 'verbindung', text);
    }

    async onPlayerDisconnect(player, reason) {
        await this.aktualisieren();
        const name = stripFormatting(player.name);
        const original = `🔴 ${name} hat den Server verlassen`;
        const text = await formuliereUm(original, { pruefWoerter: [name, '🔴'] });
        await protokolliere(this.nextcontrol, 'verbindung', text);
    }

    // Alle anderen Event-Handler bleiben leer
    async onWaypoint(waypointInfo) {}
    async onChat(login, text) {}
    async onEndMap(params) {}
    async onBeginMatch() {}
    async onBillUpdate(params) {}
    async onEndMatch(params) {}
    async onMaplistChange(params) {}
    async onModeScriptCallback(params) {}
    async onPlayersAlliesChange(login) {}
    async onPlayerInfoChange(params) {}
    async onManialinkPageAnswer(params) {}
    async onStatusChange(params) {}
    async onTunnelDataReceived(params) {}
    async onVoteUpdate(params) {}
    async onCheckpoint(params) {}
    async onIncoherence(params) {}
}
