// monatswechselAutomatik.js -- Automatisiert den bisher manuellen CLI-Aufruf von
// scripts/monatswechsel.js: sobald ein neuer Kalendermonat beginnt, laeuft der
// Wechsel selbststaendig -- aber erst nach einem dedizierten, verifizierten
// Backup-Dump UND einer Verifikation, dass der ablaufende Monat korrekt im
// Archiv liegt (siehe controller/lib/monatswechsel/ablauf.js). Schlaegt ein
// Schritt fehl, wird die Automatik NICHT wiederholt versucht, sondern ein
// persistierter Wartungsmodus gesetzt (Collection monatswechselStatus) --
// Banner ingame + auf der Website, Admin-WebUI kann Grund einsehen und
// manuell erneut ausloesen oder den Wartungsmodus aufheben.
//
// "Controller anhalten" wird bewusst NICHT als Prozess-Kill umgesetzt: der
// AlwaysUp-Dienst wuerde einen beendeten Prozess automatisch neu starten
// (siehe docs/SYSTEM.md), und ein toter Prozess koennte weder das ingame-
// Banner an neu verbundene Spieler senden noch auf Admin-Befehle reagieren.
// Der Wartungsmodus ist stattdessen DB-persistiert (uebersteht Neustarts,
// Muster wie controller/lib/analyse/automatikTakt.js) und blockiert nur die
// Monatswechsel-Automatik selbst -- alle anderen Plugins laufen normal weiter.

import { execFile } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { logger, escapeXml, stripFormatting } from '../lib/utilities.js';
import { protokolliere } from '../lib/eventLog.js';
import { sendeTelegramWarnung } from '../lib/telegramAlert.js';
import { fuehreMonatswechselDurch } from '../lib/monatswechsel/ablauf.js';
import * as Classes from '../lib/classes.js';
import { NextControl } from '../nextcontrol.js';
import { kodiereAktion, dekodiereAktion, pruefeAdmin, schliesseMenue } from '../lib/manialinkMenu.js';

const AKTION_PRAEFIX = 'monatswechsel';

const NAECHSTER_MONAT_PFAD = 'C:/Claude/Trackmania/scripts/naechster-monat.json';
const BACKUP_SCRIPT_PFAD = 'C:/Claude/Trackmania/scripts/backup-db.js';
const BACKUP_SCRIPT_DIR = 'C:/Claude/Trackmania/scripts';
const BACKUP_OUT_DIR = 'C:/Claude/Trackmania/dumps/monatswechsel-auto';
const BACKUP_ROTATION_TAGE = '90';
const BACKUP_FRISCHE_MS = 10 * 60 * 1000; // Backup-Ordner muss juenger sein als dieser Lauf hier dauert

const STATUS_COLLECTION = 'monatswechselStatus';
const STATUS_ID = 'aktuell';

const MINUTEN_TICK_MS = 60 * 1000;
const KOMMANDO_TICK_MS = 60 * 1000;
const FRUEHESTE_UHRZEIT = '00:00';

/** Monatskennung "YYYY-MM" fuer ein Datum (Muster wie telegram.js). */
function monatsKennung(datum) {
    return `${datum.getFullYear()}-${String(datum.getMonth() + 1).padStart(2, '0')}`;
}

/** Liest + validiert scripts/naechster-monat.json gegen den erwarteten (neuen) Monat. */
function leseUndValidiereNaechstenMonat(erwarteterMonat) {
    if (!existsSync(NAECHSTER_MONAT_PFAD)) {
        return { gueltig: false, fehler: `Eingabedatei fehlt: ${NAECHSTER_MONAT_PFAD}` };
    }
    let daten;
    try {
        daten = JSON.parse(readFileSync(NAECHSTER_MONAT_PFAD, 'utf8'));
    } catch (error) {
        return { gueltig: false, fehler: `Eingabedatei ist kein gueltiges JSON: ${error.message}` };
    }
    if (!daten.monat || !Array.isArray(daten.maps) || daten.maps.length !== 6) {
        return { gueltig: false, fehler: 'Eingabedatei muss { monat: "YYYY-MM", maps: [... 6 Pfade ...] } enthalten.' };
    }
    if (daten.monat !== erwarteterMonat) {
        return { gueltig: false, fehler: `Eingabedatei ist fuer Monat ${daten.monat}, erwartet wurde ${erwarteterMonat}.` };
    }
    return { gueltig: true, daten };
}

/** Stoesst scripts/backup-db.js als Kindprozess an (asynchron -- blockiert den Controller nicht). */
function fuehreBackupAus() {
    return new Promise((resolve) => {
        execFile(
            'node',
            [BACKUP_SCRIPT_PFAD, '--db', 'nextcontrol', '--out', BACKUP_OUT_DIR, '--tage', BACKUP_ROTATION_TAGE],
            { cwd: BACKUP_SCRIPT_DIR, timeout: 5 * 60 * 1000 },
            (error) => resolve(error ? { erfolgreich: false, fehler: error.message } : { erfolgreich: true })
        );
    });
}

/** Prueft, dass der soeben erzeugte Backup-Ordner frisch ist und die wichtigsten Collections enthaelt. */
function verifiziereBackup() {
    if (!existsSync(BACKUP_OUT_DIR)) return { erfolgreich: false, fehler: 'Backup-Ordner existiert nicht.' };

    const eintraege = readdirSync(BACKUP_OUT_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('nextcontrol-'))
        .map((e) => ({ pfad: join(BACKUP_OUT_DIR, e.name), mtime: statSync(join(BACKUP_OUT_DIR, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    if (eintraege.length === 0) return { erfolgreich: false, fehler: 'Kein Backup-Ordner gefunden.' };
    const neuester = eintraege[0];
    if (Date.now() - neuester.mtime > BACKUP_FRISCHE_MS) {
        return { erfolgreich: false, fehler: `Neuester Backup-Ordner ist nicht frisch genug (${neuester.pfad}).` };
    }
    for (const datei of ['records.json', 'maps.json', 'players.json', 'monthlyRankings.json']) {
        if (!existsSync(join(neuester.pfad, datei))) {
            return { erfolgreich: false, fehler: `Backup unvollstaendig: ${datei} fehlt in ${neuester.pfad}.` };
        }
    }
    return { erfolgreich: true, ordner: neuester.pfad };
}

/**
 * Automatischer monatlicher Wechsel bei Monatsbeginn, mit Backup-Gate und
 * Wartungsmodus bei Fehlern. Duenn: die eigentliche Ablauflogik steckt in
 * controller/lib/monatswechsel/ablauf.js, dieses Plugin ist Zeitsteuerung +
 * Backup-Gate + Wartungsmodus-Verwaltung + manueller Admin-Trigger.
 */
export class MonatswechselAutomatik {
    name = 'Monatswechsel-Automatik'
    author = 'system'
    description = 'Automatischer monatlicher Wechsel bei Monatsbeginn (Backup-Gate + Wartungsmodus bei Fehlern) + manueller Trigger per Admin-Befehl/Dashboard'
    version = '1.0.0'

    /** @type {NextControl} */
    nextcontrol

    /** Verhindert ueberlappende Laeufe (Tick waehrend eines laufenden manuellen Triggers oder umgekehrt). */
    laeuftGerade = false

    constructor(nextcontrol) {
        this.nextcontrol = nextcontrol;

        // WICHTIG: kein .bind(this) -- nextcontrol.js ruft Befehle per plugin[name](...) auf.
        nextcontrol.registerAdminCommand(new Classes.ChatCommand(
            'monatswechsel', this.commandAdminMonatswechsel,
            'Monatswechsel steuern: /admin monatswechsel jetzt|status|wartungAus', this.name
        ));

        // AP17e: Menue-Eintraege
        const eintrag = (label, wert) => new Classes.MenuEintrag(
            'Admin · Server', label, kodiereAktion(AKTION_PRAEFIX, wert), { adminOnly: true, pluginName: this.name }
        );
        nextcontrol.registerMenuEintrag(eintrag('Monatswechsel: Status', 'status'));
        nextcontrol.registerMenuEintrag(eintrag('Monatswechsel jetzt auslösen', 'jetzt'));
        nextcontrol.registerMenuEintrag(eintrag('Wartungsmodus aufheben', 'wartungAus'));

        this.tickTimer = setInterval(() => this.minutenTick(), MINUTEN_TICK_MS);
        this.kommandoTimer = setInterval(
            () => this.pruefeAdminKommando().catch((e) => logger('er', `MonatswechselAutomatik: Tick-Fehler (Dashboard-Trigger): ${e.message}`)),
            KOMMANDO_TICK_MS
        );

        logger('dg', 'MonatswechselAutomatik: Automatik registriert (Trigger: 1. des Monats ab 00:00, Backup-Gate + Wartungsmodus bei Fehlern, Dashboard-Trigger-Polling 60s).');
    }

    minutenTick() {
        this.pruefeUndFuehreAus('automatisch').catch((e) => logger('er', `MonatswechselAutomatik: Tick-Fehler: ${e.message}`));
    }

    /** Liefert den aktuellen Status (Defaults, falls noch nie geschrieben) -- wirft nie NICHT ab, DB-Fehler werden durchgereicht. */
    async holeStatus() {
        const doc = await this.nextcontrol.mongoDb.collection(STATUS_COLLECTION).findOne({ _id: STATUS_ID });
        return doc ?? {
            _id: STATUS_ID, wartungsmodus: false, grund: null, schritt: null, seit: null,
            letzterVersuch: null, letzterErfolgreicherMonatswechsel: null, automatischVersuchtFuerMonat: null,
        };
    }

    async setzeLetztenVersuch(monat, ausloeser) {
        await this.nextcontrol.mongoDb.collection(STATUS_COLLECTION).updateOne(
            { _id: STATUS_ID },
            { $set: { automatischVersuchtFuerMonat: monat, letzterVersuch: { monat, ausloeser, gestartetAm: new Date() } } },
            { upsert: true }
        );
    }

    /** Fehlerfall: Wartungsmodus setzen + Banner ausrollen + Gruppe warnen. */
    async setzeWartungsmodus({ grund, schritt }) {
        await this.nextcontrol.mongoDb.collection(STATUS_COLLECTION).updateOne(
            { _id: STATUS_ID },
            { $set: { wartungsmodus: true, grund, schritt, seit: new Date() } },
            { upsert: true }
        );
        await this.sendeWartungsBanner();
        await protokolliere(this.nextcontrol, 'wartung', `🔧 Wartungsmodus aktiviert (${schritt}): ${grund}`);
        await sendeTelegramWarnung(`🔧 <b>Wartungsmodus aktiviert</b>\n\nMonatswechsel-Automatik fehlgeschlagen (Schritt: ${escapeXml(schritt)}):\n${escapeXml(grund)}\n\nBitte im Admin-Dashboard prüfen -- der reguläre Spielbetrieb läuft normal weiter.`);
    }

    /** Erfolgsfall (automatisch oder manuell): Wartungsmodus IMMER loeschen -- ein erfolgreicher Lauf beweist, dass das Problem behoben ist. */
    async hebeWartungsmodusAuf(wer = 'automatisch') {
        await this.nextcontrol.mongoDb.collection(STATUS_COLLECTION).updateOne(
            { _id: STATUS_ID },
            { $set: { wartungsmodus: false, grund: null, schritt: null, seit: null } },
            { upsert: true }
        );
        await this.sendeWartungsBanner();
        await protokolliere(this.nextcontrol, 'wartung', `✅ Wartungsmodus aufgehoben (${wer}).`);
    }

    async setzeLetztenErfolgreichenWechsel(monat) {
        await this.nextcontrol.mongoDb.collection(STATUS_COLLECTION).updateOne(
            { _id: STATUS_ID },
            { $set: { letzterErfolgreicherMonatswechsel: { monat, am: new Date() } } },
            { upsert: true }
        );
    }

    /**
     * Fuehrt -- sofern die Guards das erlauben -- den Monatswechsel durch. Wirft nie
     * unbehandelt (kein globaler unhandledRejection-Handler im Controller).
     * @param {'automatisch'|'manuell'} ausloeser
     * @param {String} [angefordertVon] Login des Admins bei manuellem Trigger, nur fuers Logging
     * @returns {Promise<{gestartet:boolean, grund?:string, erfolgreich?:boolean}>}
     */
    async pruefeUndFuehreAus(ausloeser, angefordertVon) {
        if (this.laeuftGerade) return { gestartet: false, grund: 'laeuftBereits' };

        const jetzt = new Date();
        let status;
        try {
            status = await this.holeStatus();
        } catch (error) {
            logger('er', `MonatswechselAutomatik: Status konnte nicht gelesen werden (Datenbank nicht erreichbar?): ${error.message}`);
            return { gestartet: false, grund: 'fehler' };
        }

        const erwarteterMonat = monatsKennung(jetzt);

        if (ausloeser === 'automatisch') {
            // Wartungsmodus blockiert nur die AUTOMATIK -- ein manueller Retry (Chat/Dashboard)
            // muss waehrend des Wartungsmodus weiterhin moeglich sein (das ist der Recovery-Pfad).
            if (status.wartungsmodus) return { gestartet: false, grund: 'wartungsmodus' };

            const hhmm = `${String(jetzt.getHours()).padStart(2, '0')}:${String(jetzt.getMinutes()).padStart(2, '0')}`;
            if (!(jetzt.getDate() === 1 && hhmm >= FRUEHESTE_UHRZEIT)) return { gestartet: false, grund: 'ausserhalbZeitfenster' };
            if (status.automatischVersuchtFuerMonat === erwarteterMonat) return { gestartet: false, grund: 'bereitsVersuchtDiesenMonat' };
        }

        this.laeuftGerade = true;
        try {
            logger('dg', `MonatswechselAutomatik: Lauf gestartet (${ausloeser}${angefordertVon ? `, angefordert von ${angefordertVon}` : ''}).`);

            // Guard SOFORT markieren (vor dem eigentlichen Ablauf) -- ein Absturz mitten im
            // Lauf darf im selben 00:10-00:xx-Fenster nicht zu einem zweiten automatischen
            // Versuch fuehren (der Fehler soll im Wartungsmodus landen, nicht in einer Schleife).
            if (ausloeser === 'automatisch') await this.setzeLetztenVersuch(erwarteterMonat, ausloeser);

            const eingabe = leseUndValidiereNaechstenMonat(erwarteterMonat);
            if (!eingabe.gueltig) {
                await this.setzeWartungsmodus({ grund: eingabe.fehler, schritt: 'eingabedatei' });
                return { gestartet: true, erfolgreich: false };
            }

            logger('dg', 'MonatswechselAutomatik: Backup-Gate wird geprueft ...');
            const backupLauf = await fuehreBackupAus();
            if (!backupLauf.erfolgreich) {
                await this.setzeWartungsmodus({ grund: `Backup fehlgeschlagen: ${backupLauf.fehler}`, schritt: 'backup' });
                return { gestartet: true, erfolgreich: false };
            }
            const backupCheck = verifiziereBackup();
            if (!backupCheck.erfolgreich) {
                await this.setzeWartungsmodus({ grund: `Backup-Verifikation fehlgeschlagen: ${backupCheck.fehler}`, schritt: 'backup' });
                return { gestartet: true, erfolgreich: false };
            }
            logger('ok', `MonatswechselAutomatik: Backup verifiziert (${backupCheck.ordner}).`);

            const ergebnis = await fuehreMonatswechselDurch({
                db: this.nextcontrol.mongoDb,
                naechsterMonat: eingabe.daten,
                live: true,
                query: (methode, methodenArgs) => this.nextcontrol.client.query(methode, methodenArgs),
                telegramSenden: (text) => sendeTelegramWarnung(text),
            });

            if (!ergebnis.erfolgreich) {
                // Sonderfall: der Monatswechsel selbst (Archiv/Ranking/Server) war zu diesem
                // Zeitpunkt bereits vollstaendig erfolgreich, nur die Telegram-Ankuendigung
                // schlug fehl -- das rechtfertigt keinen Wartungsmodus, nur eine Warnung.
                if (ergebnis.schritt === 'telegram') {
                    logger('er', `MonatswechselAutomatik: ${ergebnis.fehler}`);
                    await protokolliere(this.nextcontrol, 'wartung', `⚠️ ${ergebnis.fehler}`);
                    await this.setzeLetztenErfolgreichenWechsel(ergebnis.monat);
                    return { gestartet: true, erfolgreich: true };
                }
                await this.setzeWartungsmodus({ grund: ergebnis.fehler, schritt: ergebnis.schritt });
                return { gestartet: true, erfolgreich: false };
            }

            await this.setzeLetztenErfolgreichenWechsel(ergebnis.monat);
            if (status.wartungsmodus) await this.hebeWartungsmodusAuf(angefordertVon ?? ausloeser);
            logger('ok', `MonatswechselAutomatik: Monatswechsel erfolgreich abgeschlossen (${ergebnis.monat}).`);
            return { gestartet: true, erfolgreich: true };
        } catch (error) {
            logger('er', `MonatswechselAutomatik: unerwarteter Fehler waehrend des Laufs: ${error.message}`);
            try {
                await this.setzeWartungsmodus({ grund: `Unerwarteter Fehler: ${error.message}`, schritt: 'unerwartet' });
            } catch (innerError) {
                logger('er', `MonatswechselAutomatik: Wartungsmodus konnte nach Fehler nicht gesetzt werden: ${innerError.message}`);
            }
            return { gestartet: true, erfolgreich: false };
        } finally {
            this.laeuftGerade = false;
        }
    }

    /** Kleines, nicht-blockierendes ManiaLink-Banner -- Muster wie localRecords.js. */
    baueWartungsBannerXml(grund) {
        const text = stripFormatting(grund ?? 'Unbekannter Fehler').slice(0, 100);
        return `<manialink id="wartungsmodus-banner" version="3">
            <frame posn="-160 -84 5">
                <quad pos="0 0" size="75 14" bgcolor="6b0000cc" />
                <label pos="2 -2" size="71 4" text="🔧 Wartungsmodus (Monatswechsel)" textsize="1.3" class="text-title" />
                <label pos="2 -7.5" size="71 5" text="${escapeXml(text)}" textsize="1" class="text-value" />
            </frame>
        </manialink>`;
    }

    /** Leere Seite mit derselben ID loescht das zuvor angezeigte Banner. */
    baueLeeresBannerXml() {
        return `<manialink id="wartungsmodus-banner" version="3"></manialink>`;
    }

    /**
     * Sendet (oder loescht) das Wartungsbanner -- an alle (Broadcast) oder gezielt an
     * einen einzelnen, neu verbundenen Login.
     * @param {{nurAnLogin?: String}} [optionen]
     */
    async sendeWartungsBanner({ nurAnLogin } = {}) {
        let status;
        try {
            status = await this.holeStatus();
        } catch (error) {
            logger('er', `MonatswechselAutomatik: Banner-Status konnte nicht gelesen werden: ${error.message}`);
            return;
        }
        const xml = status.wartungsmodus ? this.baueWartungsBannerXml(status.grund) : this.baueLeeresBannerXml();
        if (nurAnLogin) {
            await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [nurAnLogin, xml, 0, false]);
        } else {
            await this.nextcontrol.client.query('SendDisplayManialinkPage', [xml, 0, false]);
        }
    }

    /**
     * Function run, when a player connects -- zeigt das Wartungsbanner, falls aktiv.
     * @param {Classes.PlayerInfo} p
     * @param {Boolean} isSpectator
     */
    async onPlayerConnect(p, isSpectator) {
        try {
            const status = await this.holeStatus();
            if (status.wartungsmodus) await this.sendeWartungsBanner({ nurAnLogin: p.login });
        } catch (error) {
            logger('er', `MonatswechselAutomatik: Banner bei Connect fehlgeschlagen: ${error.message}`);
        }
    }

    /**
     * Prueft auf einen ausstehenden manuellen Trigger aus dem Admin-Dashboard
     * (Collection adminKommandos, {typ:'monatswechselJetzt'|'monatswechselWartungAus', erledigtAm:null})
     * und fuehrt ihn aus. Markiert den Eintrag ATOMAR ueber den updateOne-Filter
     * erledigtAm:null als bearbeitet, BEVOR er ausgefuehrt wird (Muster wie analyse.js).
     * @private
     */
    async pruefeAdminKommando() {
        let treffer;
        try {
            treffer = await this.nextcontrol.mongoDb.collection('adminKommandos')
                .find({ typ: { $in: ['monatswechselJetzt', 'monatswechselWartungAus'] }, erledigtAm: null })
                .sort({ angefordertAm: 1 })
                .limit(1)
                .toArray();
        } catch (error) {
            logger('er', `MonatswechselAutomatik: adminKommandos-Abfrage fehlgeschlagen: ${error.message}`);
            return;
        }
        if (!treffer.length) return;
        const kommando = treffer[0];

        let beansprucht;
        try {
            beansprucht = await this.nextcontrol.mongoDb.collection('adminKommandos').updateOne(
                { _id: kommando._id, erledigtAm: null },
                { $set: { erledigtAm: new Date() } }
            );
        } catch (error) {
            logger('er', `MonatswechselAutomatik: adminKommandos-Markierung fehlgeschlagen: ${error.message}`);
            return;
        }
        if (beansprucht.modifiedCount === 0) return; // von einem anderen Tick bereits beansprucht

        let ergebnis;
        if (kommando.typ === 'monatswechselWartungAus') {
            logger('dg', 'MonatswechselAutomatik: manuelles "Wartungsmodus aufheben" vom Admin-Dashboard erkannt.');
            await this.hebeWartungsmodusAuf('dashboard');
            ergebnis = { gestartet: true, erfolgreich: true };
        } else {
            logger('dg', 'MonatswechselAutomatik: manueller Trigger vom Admin-Dashboard erkannt.');
            ergebnis = await this.pruefeUndFuehreAus('manuell', 'dashboard');
        }

        try {
            await this.nextcontrol.mongoDb.collection('adminKommandos').updateOne(
                { _id: kommando._id },
                { $set: { ergebnis: ergebnis.gestartet ? (ergebnis.erfolgreich ? 'erfolgreich' : 'fehlgeschlagen') : ergebnis.grund } }
            );
        } catch (error) {
            logger('er', `MonatswechselAutomatik: adminKommandos-Ergebnis konnte nicht gespeichert werden: ${error.message}`);
        }
    }

    /**
     * /admin monatswechsel jetzt|status|wartungAus
     * @param {String} login
     * @param {Array<String>} params
     */
    async commandAdminMonatswechsel(login, params) {
        const antworten = (msg) => this.nextcontrol.client.query('ChatSendServerMessageToLogin', [msg, login]);
        const arg = (params[0] ?? 'status').toLowerCase();

        if (arg === 'jetzt') {
            antworten('$fffMonatswechsel wird geprueft ...');
            const ergebnis = await this.pruefeUndFuehreAus('manuell', login);
            if (!ergebnis.gestartet) {
                antworten(`$f00Monatswechsel abgelehnt: ${ergebnis.grund}.`);
                return;
            }
            antworten(ergebnis.erfolgreich
                ? '$0f0Monatswechsel abgeschlossen.'
                : '$f00Monatswechsel fehlgeschlagen -- Wartungsmodus aktiv (siehe /admin monatswechsel status).');
            return;
        }

        if (arg === 'wartungaus') {
            await this.hebeWartungsmodusAuf(login);
            antworten('$0f0Wartungsmodus aufgehoben.');
            return;
        }

        let status;
        try {
            status = await this.holeStatus();
        } catch (error) {
            logger('er', `MonatswechselAutomatik: Status lesen fehlgeschlagen: ${error.message}`);
            antworten('$f00Status konnte nicht geladen werden (Datenbank nicht erreichbar?).');
            return;
        }
        if (status.wartungsmodus) {
            antworten(`$f00Wartungsmodus AKTIV seit ${new Date(status.seit).toLocaleString('de-DE')} (Schritt: ${status.schritt}): ${status.grund}`);
        } else {
            const letzter = status.letzterErfolgreicherMonatswechsel;
            antworten(`$fffKein Wartungsmodus aktiv. Letzter erfolgreicher Monatswechsel: `
                + `${letzter ? `${letzter.monat} (${new Date(letzter.am).toLocaleString('de-DE')})` : '-'}. `
                + `Nutzung: /admin monatswechsel jetzt|status|wartungAus`);
        }
    }

    /**
     * Function run, when a player clicks a Monatswechsel-Menue-Knopf.
     * @param {CallbackParams.ManialinkPageAnswer} params
     */
    async onManialinkPageAnswer(params) {
        const { namespace, teile } = dekodiereAktion(params.answer);
        if (namespace !== AKTION_PRAEFIX) return;

        const login = params.login;
        if (!pruefeAdmin(this.nextcontrol, login)) return;

        await this.commandAdminMonatswechsel(login, [teile[0]]);
        await schliesseMenue(this.nextcontrol, login);
    }
}
