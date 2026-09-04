import { Sentences } from '../lib/sentences.js'
import { logger, format, stripFormatting } from '../lib/utilities.js'
import { Settings } from '../settings.js'
import * as CallbackParams from '../lib/callbackparams.js'
import * as Classes from '../lib/classes.js'
import { NextControl } from '../nextcontrol.js'
import https from 'https'
import querystring from 'querystring'
import { writeFileSync } from 'fs'
import { berechneRanking } from '../../scripts/lib/punkte.js'
import { normalisierePfad } from '../../scripts/lib/matchsettings.js'
import { listeAlleMapDateien } from '../lib/mapVoting.js'
import { berechneGeschmacksprofil, bewerteKandidat, erzeugeKompakteBeschreibung, erzeugeAusfuehrlicheBeschreibung, ermittleBeliebteMapUids } from '../../scripts/lib/kandidatenAuswahl.js'
import { holeTmxDatenFuerUids } from '../../scripts/lib/tmxCache.js'
import { protokolliere } from '../lib/eventLog.js'
import { initialisiereLaufzeitEinstellungen, holeEinstellungen } from '../lib/laufzeitEinstellungen.js'
import {
    kodiereAktion, dekodiereAktion, pruefeAdmin, schliesseMenue, ZURUECK_AKTION,
    baueEingabeXml
} from '../lib/manialinkMenu.js'
import { fileURLToPath } from 'url'

const AKTION_PRAEFIX = 'tg';

// Default relativ zum Repo (funktioniert unveraendert lokal wie in einem Docker-
// Image, da scripts/ und controller/ immer zusammen ausgeliefert werden). Per
// TM_NAECHSTER_MONAT_PFAD uebersteuerbar fuer Sonderfaelle.
const NAECHSTER_MONAT_PFAD = process.env.TM_NAECHSTER_MONAT_PFAD
    || fileURLToPath(new URL('../../scripts/naechster-monat.json', import.meta.url))

/** Zufaelliger 6-stelliger Code fuer die Telegram<->Login-Verknuepfung. */
function erzeugeCode() {
    const zeichen = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // ohne verwechselbare Zeichen (0/O, 1/I)
    let code = ''
    for (let i = 0; i < 6; i++) code += zeichen[Math.floor(Math.random() * zeichen.length)]
    return code
}

/** Monatskennung "YYYY-MM" fuer ein Datum. */
function monatsKennung(datum) {
    return `${datum.getFullYear()}-${String(datum.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Telegram bot integration - Database Records Only
 */
export class TelegramBot {
    name = 'Telegram-Anbindung'
    author = 'nextcontrol-community'
    description = 'Verbindet den TM-Server mit der Telegram-Gruppe (nur Datenbank-Rekorde)'
    version = "2.0.0"

    /**
     * Local reference to the main class instance
     * @type {NextControl}
     */
    nextcontrol

    /**
     * Telegram Bot Token (aus settings.js / secrets.env)
     * @type {String}
     * @private
     */
    telegramToken = Settings.telegram.token

    /**
     * Telegram Chat ID (aus settings.js / secrets.env)
     * @type {String}
     * @private
     */
    chatId = Settings.telegram.chatId

    /**
     * Trockenlauf: Nachrichten werden nur geloggt statt tatsächlich gesendet
     * @type {Boolean}
     * @private
     */
    dryRun = Settings.telegram.dryRun

    /**
     * Cup-Turniersystem (Beta): Turnier-IDs, fuer die die Start-Erinnerung schon raus ist --
     * bewusst nur im Speicher (kein Schreibzugriff dieses Plugins auf cupTurniere,
     * das bleibt allein Aufgabe von controller/plugins/cup.js). Ueberlebt einen
     * Neustart nicht, im schlimmsten Fall geht eine Erinnerung doppelt raus.
     * @type {Set<String>}
     * @private
     */
    cupErinnerungGesendetFuer = new Set()

    /**
     * Settings that will be detected
     * @type {Object}
     * @private
     */
    settings = {
        enableLogChannel: true,
        enableChatChannel: true,
        enableRecordNotifications: true,
        recordNotificationTopLimit: 10,
        enablePersonalBestNotifications: false,  // Einzelne PB-Nachrichten deaktiviert
        enableMapChangeSummary: true             // Private Digest-DMs bei Map-Wechsel an registrierte Nutzer
    }

    /**
     * Message queue to prevent spam
     * @type {Array}
     * @private
     */
    messageQueue = []

    /**
     * Queue processing flag
     * @type {Boolean}
     * @private
     */
    isProcessingQueue = false

    /**
     * Polling offset for Telegram updates
     * @type {Number}
     * @private
     */
    updateOffset = 0

    /**
     * Current leaderboard leader tracking
     * @type {Object}
     * @private
     */
    currentLeader = {
        login: null,
        name: null,
        time: null,
        mapUid: null
    }

    /**
     * Personal best improvements tracking for map change summary
     * @type {Array}
     * @private
     */
    personalBestImprovements = []

    /**
     * Überhol-Ereignisse der laufenden Map: wer ist in der Map-Rekordliste nach
     * hinten gerutscht, weil jemand anderes eine bessere Zeit gefahren hat?
     * Elemente: {login, map, altePos, neuePos, durch}
     * @type {Array}
     * @private
     */
    ueberholEreignisse = []

    /** Monats-Punktetabelle zum Zeitpunkt des letzten Map-Beginns (für den Rangwechsel-Diff). @private */
    monatsRankingSnapshot = null

    /**
     * Name der aktuell laufenden Map. Eigenes Tracking, weil status.map beim
     * onBeginMap-Hook bereits die NEUE Map enthält -- für den Digest brauchen
     * wir aber den Namen der gerade beendeten Map.
     * @private
     */
    aktuelleMapName = null

    /** Hall-of-Fame-Ranking (archivRecords + records) zum Zeitpunkt des letzten Map-Beginns. @private */
    hofRankingSnapshot = null

    /**
     * Verbesserungen seit dem letzten Tagesreport -- deckt die letzten ~24 Stunden ab,
     * unabhaengig von der konfigurierten Uhrzeit (systemSettings.tagesreport).
     * @type {Array}
     * @private
     */
    tagesVerbesserungen = []

    /** Datum (YYYY-MM-DD) des zuletzt versendeten Tagesreports, verhindert Doppelversand. */
    letzterTagesReport = null

    /** Kalenderwoche (Jahr-KW) des zuletzt versendeten Wochenrueckblicks. */
    letzterWochenRueckblick = null

    /** Monat (YYYY-MM), fuer den die Map-Abstimmung bereits gestartet wurde. */
    abstimmungGestartetFuerMonat = null

    /** Ob gerade eine Map-Abstimmung laeuft. */
    abstimmungAktiv = false

    /** Telegram poll_id der laufenden Abstimmung. */
    abstimmungPollId = null

    /** Telegram message_id der Poll-Nachricht (für stopPoll). */
    abstimmungPollMessageId = null

    /** Kandidaten-Map-Dateien der laufenden Abstimmung (Index = Poll-Options-Index). */
    abstimmungKandidaten = []

    /** Aktuelle Stimmen der laufenden Abstimmung: telegramUserId -> Array von Options-Indizes. */
    abstimmungAntworten = new Map()

    /** Anzeige-Details je Kandidat (Index = Poll-Options-Index), fuer Vorschau + persistierten Status. */
    abstimmungKandidatenDetails = []

    /** Zielmonat (YYYY-MM) der laufenden/letzten Abstimmung. */
    abstimmungZielMonat = null

    /** ISO-Zeitpunkt, an dem die laufende Abstimmung gestartet wurde. */
    abstimmungGestartetAm = null

    /** ISO-Zeitpunkt, an dem die laufende Abstimmung voraussichtlich endet. */
    abstimmungGeplantesEnde = null

    /** Ob stelleAbstimmungWiederHer() beim Boot bereits durchgelaufen ist -- verhindert,
     * dass der 60s-Tick vor Abschluss des DB-Reads faelschlich eine neue Abstimmung startet. */
    abstimmungWiederherstellungAbgeschlossen = false

    /**
     * Monats-Endspurt: die letzten 5 Tage vor Monatsende (gleiches Fenster wie
     * die Map-Abstimmung). In dieser Phase gehen Server-Rekorde und
     * Tabellen-Updates zusätzlich in den Gruppenchat.
     * ENDSPURT_TEST=true erzwingt den Endspurt (nur für Tests, nie in Produktion).
     * @returns {Boolean}
     * @private
     */
    istEndspurt() {
        if (process.env.ENDSPURT_TEST === 'true') return true;
        const jetzt = new Date();
        const letzterTagDesMonats = new Date(jetzt.getFullYear(), jetzt.getMonth() + 1, 0).getDate();
        return letzterTagDesMonats - jetzt.getDate() <= 5;
    }

    /**
     * Integrate your TM server with your Telegram chat
     * @param {NextControl} nextcontrol The script's brain we require to properly register the chat commands
     */
    constructor(nextcontrol) {
        if (!this.telegramToken || this.telegramToken == "") {
            logger('er', 'Telegram: No token provided');
            return false;
        }

        // Register chat commands
        // WICHTIG: kein .bind(this) hier -- nextcontrol.js ruft Befehle über
        // plugin[commandHandler.name](...) auf, was durch .bind() erzeugte
        // Funktionsnamen ("bound xyz") nicht mehr auf dem Plugin findet (Absturz).
        nextcontrol.registerChatCommand(new Classes.ChatCommand(
            'telegram',
            this.commandTelegram,
            'Sendet eine Nachricht an Telegram',
            this.name
        ));

        // Register admin commands
        nextcontrol.registerAdminCommand(new Classes.ChatCommand(
            'telegram',
            this.commandAdminTelegram,
            'Admin-Telegram-Kommandos',
            this.name
        ));

        // In-Game-Befehl zum Verknuepfen mit Telegram
        nextcontrol.registerChatCommand(new Classes.ChatCommand(
            'link',
            this.commandLink,
            'Verknüpft deinen Spieler-Account mit Telegram (Code aus /link in Telegram)',
            this.name
        ));

        // Menue-Eintraege
        nextcontrol.registerMenuEintrag(new Classes.MenuEintrag(
            'Allgemein', 'Telegram-Bot-Status', kodiereAktion(AKTION_PRAEFIX, 'status'), { pluginName: this.name }
        ));
        nextcontrol.registerMenuEintrag(new Classes.MenuEintrag(
            'Telegram (Link)', 'Mit Telegram verknüpfen (/link)', kodiereAktion(AKTION_PRAEFIX, 'link_form'), { pluginName: this.name }
        ));
        nextcontrol.registerMenuEintrag(new Classes.MenuEintrag(
            'Admin · Telegram', 'Nachricht an Telegram senden', kodiereAktion(AKTION_PRAEFIX, 'broadcast_form'), { adminOnly: true, pluginName: this.name }
        ));

        // save the reference to the main class instance
        this.nextcontrol = nextcontrol;

        // Tagesreport-Zeitplan (Ein/Aus + Uhrzeit) per Admin-Dashboard konfigurierbar --
        // initialisiereLaufzeitEinstellungen() ist idempotent (siehe rennleitung.js/nachrichtenKi.js).
        initialisiereLaufzeitEinstellungen(nextcontrol.mongoDb);

        // Zeitgesteuerte Aufgaben (Tagesreport, Wochenrückblick, Map-Abstimmung): jede Minute prüfen
        this.zeitgesteuerteAufgabenTimer = setInterval(() => this.pruefeZeitgesteuerteAufgaben(), 60 * 1000);

        // Falls beim letzten Neustart eine Abstimmung lief: Zustand aus Mongo wiederherstellen,
        // BEVOR der obige Tick zum ersten Mal prueft -- sonst wuerde ein Neustart waehrend einer
        // laufenden Abstimmung eine zweite, parallele starten (siehe Vorfall, abstimmungAktiv etc.
        // sind reine In-Memory-Felder). Setzt am Ende abstimmungWiederherstellungAbgeschlossen,
        // an dem der Tick sich seinerseits gegen die Race Condition absichert.
        this.stelleAbstimmungWiederHer();

        // Test Telegram connection and send startup message
        this.testConnection().then(success => {
            if (success) {
                logger('ok', 'Telegram: Bot connected successfully');
                if (this.settings.enableLogChannel) {
                    const spieler = this.nextcontrol.status.players?.length ?? 0;
                    const map = this.nextcontrol.status.map;
                    this.sendMessage(
                        `🚀 Trackmania Server gestartet!\n\n` +
                        `👥 Spieler online: ${spieler}\n` +
                        (map
                            ? `🗺️ Aktuelle Map: ${stripFormatting(map.name)}\n👤 Autor: ${map.author}`
                            : `🗺️ Aktuelle Map: wird geladen …`)
                    );
                    if (map) this.aktuelleMapName = map.name;
                }

                // Bot-Menü ("/"-Button in Telegram) mit Kurzbeschreibungen registrieren
                this.registriereBotMenu().catch((e) => logger('er', `Telegram: registriereBotMenu fehlgeschlagen: ${e.message}`));

                // Start polling for incoming messages
                this.startPolling();
            } else {
                logger('er', 'Telegram: Failed to connect to Telegram API');
                Settings.admins.forEach(adminLogin => {
                    nextcontrol.client.query('ChatSendServerMessageToLogin', ['$f00Verbindung zum Telegram-Bot fehlgeschlagen!', adminLogin]);
                });
            }
        });
    }

    /**
     * Initialize current leader for the map
     * @param {String} mapUid Map UID
     * @private
     */
    async initializeCurrentLeader(mapUid) {
        try {
            const dbtype = Settings.usedDatabase.toLowerCase();
            let records = [];

            if (dbtype === 'mongodb') {
                records = await this.nextcontrol.mongoDb.collection('records')
                    .find({ map: mapUid })
                    .sort({ time: 1 })
                    .limit(1)
                    .toArray();
            } else if (dbtype === 'mysql') {
                const result = await this.nextcontrol.mysql.query(
                    'SELECT * FROM records WHERE map = ? ORDER BY time ASC LIMIT 1',
                    [mapUid]
                );
                records = result;
            }

            if (records.length > 0) {
                const leader = records[0];
                const playerName = await this.getPlayerNameFromDatabase(leader.login);
                
                this.currentLeader = {
                    login: leader.login,
                    name: playerName,
                    time: leader.time,
                    mapUid: mapUid
                };
            } else {
                this.currentLeader = {
                    login: null,
                    name: null,
                    time: null,
                    mapUid: mapUid
                };
            }
        } catch (error) {
            logger('er', `Telegram: Error initializing current leader: ${error.message}`);
        }
    }

    /**
     * Get player name from database by login
     * @param {String} login Player login
     * @returns {Promise} Player name
     * @private
     */
    async getPlayerNameFromDatabase(login) {
        try {
            const dbtype = Settings.usedDatabase.toLowerCase();
            if (dbtype === 'mongodb') {
                const player = await this.nextcontrol.mongoDb.collection('players')
                    .findOne({ login: login });
                return player ? player.name : login;
            } else if (dbtype === 'mysql') {
                const result = await this.nextcontrol.mysql.query(
                    'SELECT name FROM players WHERE login = ? LIMIT 1',
                    [login]
                );
                return result.length > 0 ? result[0].name : login;
            }
            return login;
        } catch (error) {
            return login; // Fallback to login if database query fails
        }
    }

    /**
     * Telegram chat command
     * @param {String} login Login of the player calling this command
     * @param {Array} params Parameters passed by the player after the command
     */
    async commandTelegram(login, params) {
        this.nextcontrol.client.query('ChatSendServerMessageToLogin', ['$0f0Telegram-Bot ist aktiv!', login]);
    }

    /**
     * In-Game-Chatbefehl /link <code> — verknüpft den aufrufenden Spieler mit
     * einem zuvor in Telegram per /link erzeugten Code.
     * @param {String} login Login of the player calling this command
     * @param {Array} params Parameters passed by the player after the command
     */
    async commandLink(login, params) {
        const antwortenAnSpieler = (msg) =>
            this.nextcontrol.client.query('ChatSendServerMessageToLogin', [msg, login]);

        const code = (params[0] || '').trim().toUpperCase();
        if (!code) {
            antwortenAnSpieler('$f00Nutzung: /link <code> — den Code bekommst du, wenn du in Telegram (Gruppe oder privat an den Bot) /link schreibst.');
            return;
        }

        const eintrag = await this.nextcontrol.mongoDb.collection('telegramLinks').findOne({ code });
        if (!eintrag) {
            antwortenAnSpieler('$f00Unbekannter Code. Schreibe zuerst /link in der Telegram-Gruppe.');
            return;
        }
        if (eintrag.login) {
            antwortenAnSpieler('$f00Dieser Code wurde bereits verwendet. Schreibe erneut /link in Telegram für einen neuen Code.');
            return;
        }
        const alterMs = Date.now() - new Date(eintrag.createdAt).getTime();
        if (alterMs > 15 * 60 * 1000) {
            antwortenAnSpieler('$f00Dieser Code ist abgelaufen (15 Minuten gültig). Schreibe erneut /link in Telegram.');
            return;
        }

        await this.nextcontrol.mongoDb.collection('telegramLinks').updateOne(
            { code },
            { $set: { login, linkedAt: new Date() } }
        );

        antwortenAnSpieler('$0f0Erfolgreich mit Telegram verknüpft! Du bekommst jetzt private Zusammenfassungen — /abo in Telegram zum Anpassen.');

        const name = this.nextcontrol.status.getPlayer(login)?.name ?? login;
        this.sendMessage(`🔗 ${this.escapeHtml(stripFormatting(name))} hat sich mit Telegram verknüpft.`);
    }

    /**
     * Ermittelt den verknüpften Spieler-Login für einen Telegram-User.
     * @param {Number} telegramUserId
     * @returns {Promise<String|null>}
     * @private
     */
    async loginFuerTelegramUser(telegramUserId) {
        const eintrag = await this.nextcontrol.mongoDb.collection('telegramLinks').findOne({
            telegramUserId,
            login: { $ne: null },
        });
        return eintrag?.login ?? null;
    }

    /**
     * Gegenstück zu loginFuerTelegramUser: liefert den telegramLinks-Eintrag
     * (inkl. telegramUserId und Abo-Einstellungen) für einen Spieler-Login.
     * @param {String} login
     * @returns {Promise<Object|null>}
     * @private
     */
    async linkFuerLogin(login) {
        return this.nextcontrol.mongoDb.collection('telegramLinks').findOne({
            login,
            telegramUserId: { $ne: null },
        });
    }

    /**
     * Prüft, ob eine Benachrichtigungs-Kategorie für einen Link-Eintrag abonniert
     * ist. Ohne abos-Feld (Altbestand) ist alles abonniert (Opt-out-Modell).
     * @param {Object} link telegramLinks-Dokument
     * @param {String} kategorie 'digest' | 'ueberholt' | 'rekordVerlust' | 'errungenschaften'
     * @private
     */
    hatAbo(link, kategorie) {
        return link?.abos?.[kategorie] !== false;
    }

    /**
     * Schickt eine private Nachricht an den mit `login` verknüpften Telegram-Nutzer,
     * sofern verknüpft und die Kategorie nicht per /abo abbestellt wurde.
     * Kein Gruppen-Fallback: nicht registrierte Spieler bekommen schlicht nichts.
     * @param {String} login
     * @param {String} text
     * @param {String} kategorie Abo-Kategorie (siehe hatAbo)
     * @returns {Promise<Boolean>} true, wenn zugestellt
     * @private
     */
    async sendeDmAnLogin(login, text, kategorie) {
        const link = await this.linkFuerLogin(login);
        if (!link || !this.hatAbo(link, kategorie)) return false;
        const erfolg = await this.sendeDirekteNachricht(link.telegramUserId, text);
        if (!erfolg) logger('r', `Telegram: DM an ${login} (${kategorie}) nicht zustellbar`);
        return erfolg;
    }

    /**
     * Telegram /link — erzeugt einen Verknüpfungscode für den anfragenden Telegram-User.
     * @param {Object} from Telegram user object
     * @private
     */
    async telegramCommandLink(from, zielChatId) {
        const code = erzeugeCode();
        await this.nextcontrol.mongoDb.collection('telegramLinks').insertOne({
            code,
            telegramUserId: from.id,
            telegramUsername: from.username ?? null,
            login: null,
            createdAt: new Date(),
            linkedAt: null,
        });

        // WICHTIG: Der Code darf NIE in die Gruppe gepostet werden (sonst könnte
        // ihn jemand anderes zuerst im Spiel einlösen) -- immer per Privatnachricht.
        const erfolg = await this.sendeDirekteNachricht(
            from.id,
            `🔗 Dein Code: <b>${code}</b>\n\n` +
            `Gib im Spiel <code>/link ${code}</code> ein, um deinen Account zu verknüpfen (15 Minuten gültig).`
        );

        if (!erfolg) {
            const hinweis = this.botUsername
                ? `Starte zuerst einen privaten Chat mit @${this.botUsername} (in Telegram nach dem Namen suchen und "Start" drücken) und schreibe dann hier erneut /link.`
                : `Starte zuerst einen privaten Chat mit mir und schreibe dann hier erneut /link.`;
            this.antworte(zielChatId, `⚠️ Ich konnte dir keine private Nachricht schicken. ${hinweis}`);
        }
    }

    /**
     * Sendet eine private Telegram-Nachricht an einen bestimmten Chat (z.B.
     * einen einzelnen Nutzer, unabhängig von der Gruppen-chatId) und meldet
     * per Rückgabewert, ob die Zustellung erfolgreich war.
     * @param {Number|String} chatId
     * @param {String} text
     * @returns {Promise<Boolean>}
     * @private
     */
    sendeDirekteNachricht(chatId, text) {
        if (this.dryRun) {
            logger('r', `Telegram (Trockenlauf, privat an ${chatId}): ${text}`);
            return Promise.resolve(true);
        }
        const postData = querystring.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'api.telegram.org', port: 443, path: `/bot${this.telegramToken}/sendMessage`, method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
            }, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data).ok === true); } catch { resolve(false); }
                });
            });
            req.setTimeout(15000, () => req.destroy(new Error('Timeout bei sendeDirekteNachricht')));
            req.on('error', () => resolve(false));
            req.write(postData);
            req.end();
        });
    }

    /**
     * Telegram /mystats — eigene Punkte/Rang im aktuellen Monat + Delta zum Vormonat.
     * @param {Object} from Telegram user object
     * @private
     */
    async telegramCommandMystats(from, zielChatId) {
        const login = await this.loginFuerTelegramUser(from.id);
        if (!login) {
            this.antworte(zielChatId, '❌ Noch nicht verknüpft. Schreibe /link, um einen Code zu erhalten, und gib ihn im Spiel mit /link <code> ein.');
            return;
        }

        const namen = await this.spielerNamenIndex();
        const records = await this.nextcontrol.mongoDb.collection('records').find({}).toArray();
        const ranking = berechneRanking(records, namen);
        const rang = ranking.findIndex((s) => s.login === login);

        if (rang === -1) {
            this.antworte(zielChatId, `📊 ${namen[login] ?? login}: Noch keine Zeiten diesen Monat gefahren.`);
            return;
        }
        const eintrag = ranking[rang];

        // Delta zum Vormonat aus monthlyRankings
        const vormonat = monatsKennung(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1));
        const vormonatDoc = await this.nextcontrol.mongoDb.collection('monthlyRankings').findOne({ monat: vormonat });
        const vormonatEintrag = vormonatDoc?.eintraege?.find((e) => e.login === login);

        let msg = `📊 <b>${this.escapeHtml(stripFormatting(eintrag.name))}</b>\n\n`;
        msg += `🏆 Rang #${rang + 1} · ${eintrag.punkte.toLocaleString('de-DE')} Punkte\n`;
        msg += `🥇 ${eintrag.siege} Siege · 🗺️ ${eintrag.mapsGespielt} Maps gefahren`;
        if (vormonatEintrag) {
            const delta = eintrag.punkte - vormonatEintrag.punkte;
            msg += `\n\n📈 Vormonat (${vormonat}): ${vormonatEintrag.punkte.toLocaleString('de-DE')} Punkte (${delta >= 0 ? '+' : ''}${delta.toLocaleString('de-DE')})`;
        }
        this.antworte(zielChatId, msg);
    }

    /**
     * Telegram /monat — aktuelles Ranking als Tabelle.
     * @private
     */
    async telegramCommandMonat(zielChatId) {
        const namen = await this.spielerNamenIndex();
        const records = await this.nextcontrol.mongoDb.collection('records').find({}).toArray();
        const ranking = berechneRanking(records, namen);

        if (!ranking.length) {
            this.antworte(zielChatId, '📅 Noch keine Zeiten diesen Monat gefahren.');
            return;
        }

        let msg = `📅 <b>Ranking ${monatsKennung(new Date())}</b>\n\n`;
        ranking.slice(0, 15).forEach((s, i) => {
            const medaille = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            msg += `${medaille} ${this.escapeHtml(stripFormatting(s.name))} — ${s.punkte.toLocaleString('de-DE')} Punkte\n`;
        });
        this.antworte(zielChatId, msg);
    }

    /**
     * Telegram /gap — Rückstand des verknüpften Spielers auf Platz 1 je Map.
     * @param {Object} from Telegram user object
     * @private
     */
    async telegramCommandGap(from, zielChatId) {
        const login = await this.loginFuerTelegramUser(from.id);
        if (!login) {
            this.antworte(zielChatId, '❌ Noch nicht verknüpft. Schreibe /link, um einen Code zu erhalten, und gib ihn im Spiel mit /link <code> ein.');
            return;
        }

        const namen = await this.spielerNamenIndex();
        const maps = await this.nextcontrol.mongoDb.collection('maps').find({}).toArray();
        const records = await this.nextcontrol.mongoDb.collection('records').find({}).toArray();

        let msg = `📏 <b>Rückstand auf Platz 1</b>\n\n`;
        for (const map of maps) {
            const mapRecords = records.filter((r) => r.map === map.uid).sort((a, b) => a.time - b.time);
            if (!mapRecords.length) continue;
            const eigener = mapRecords.find((r) => r.login === login);
            const name = stripFormatting(map.name ?? map.uid);
            if (!eigener) {
                msg += `🗺️ ${this.escapeHtml(name)}: noch keine Zeit\n`;
            } else if (eigener === mapRecords[0]) {
                msg += `🗺️ ${this.escapeHtml(name)}: 🥇 Platz 1!\n`;
            } else {
                const gapMs = eigener.time - mapRecords[0].time;
                const fuehrenderName = namen[mapRecords[0].login] ?? mapRecords[0].login;
                msg += `🗺️ ${this.escapeHtml(name)}: -${this.formatTime(gapMs)} hinter ${this.escapeHtml(stripFormatting(fuehrenderName))}\n`;
            }
        }
        this.antworte(zielChatId, msg || 'Keine Maps verfügbar.');
    }

    /**
     * Telegram /abo — Benachrichtigungs-Einstellungen des verknüpften Nutzers
     * anzeigen oder umschalten: /abo <kategorie> an|aus
     * Kategorien: digest, ueberholt, rekordverlust, errungenschaften
     * @param {Object} from Telegram user object
     * @param {Array<String>} args Argumente nach /abo
     * @param {String} zielChatId
     * @private
     */
    async telegramCommandAbo(from, args, zielChatId) {
        const login = await this.loginFuerTelegramUser(from.id);
        if (!login) {
            this.antworte(zielChatId, '❌ Noch nicht verknüpft. Schreibe /link, um einen Code zu erhalten, und gib ihn im Spiel mit /link <code> ein.');
            return;
        }

        const kategorien = {
            digest:          { feld: 'digest',          name: 'Map-Zusammenfassung (private Bilanz nach jeder Map)' },
            ueberholt:       { feld: 'ueberholt',       name: 'Überholt-Meldungen (Teil der Map-Zusammenfassung)' },
            rekordverlust:   { feld: 'rekordVerlust',   name: 'Rekord-Verlust (dein Platz 1 wurde geschlagen)' },
            errungenschaften:{ feld: 'errungenschaften',name: 'Errungenschaften (neues Abzeichen freigeschaltet)' },
        };

        const link = await this.linkFuerLogin(login);

        if (args.length === 0) {
            let msg = `🔔 <b>Deine Benachrichtigungen</b>\n\n`;
            for (const [schluessel, k] of Object.entries(kategorien)) {
                const an = this.hatAbo(link, k.feld);
                msg += `${an ? '✅' : '🔕'} <b>${schluessel}</b> — ${k.name}\n`;
            }
            msg += `\nUmschalten mit: /abo &lt;kategorie&gt; an|aus`;
            this.antworte(zielChatId, msg);
            return;
        }

        const kategorie = kategorien[(args[0] || '').toLowerCase()];
        const schalter = (args[1] || '').toLowerCase();
        if (!kategorie || !['an', 'aus'].includes(schalter)) {
            this.antworte(zielChatId, `❌ Nutzung: /abo &lt;kategorie&gt; an|aus\nKategorien: ${Object.keys(kategorien).join(', ')}`);
            return;
        }

        // updateMany: durch wiederholtes /link kann derselbe Login mehrere
        // Link-Dokumente haben -- die Abos müssen auf allen konsistent sein.
        await this.nextcontrol.mongoDb.collection('telegramLinks').updateMany(
            { login, telegramUserId: { $ne: null } },
            { $set: { [`abos.${kategorie.feld}`]: schalter === 'an' } }
        );
        this.antworte(zielChatId, `${schalter === 'an' ? '✅' : '🔕'} ${kategorie.name}: ${schalter === 'an' ? 'aktiviert' : 'deaktiviert'}.`);
    }

    /**
     * Telegram /cup ... -- Cup-Turniersystem (Beta-Feature, siehe README). Bewusst per
     * Settings.cup.aktiv abschaltbar (Default AUS, siehe settings.js) -- diese
     * Funktion laeuft im normal-live Haupt-Controller (kein CUP_MODUS-Gate wie beim
     * separaten Cup-Controller-Prozess moeglich) und darf vor der expliziten
     * Freigabe des Betreibers unter keinen Umstaenden auf echte Nutzer reagieren.
     * Schreibt NIE direkt in cupTurniere -- immer ueber die cupKommandos-Bruecke
     * (derselbe Mechanismus wie die In-Game-Admin-Befehle in cup.js), damit der
     * Cup-Controller der einzige Schreiber bleibt.
     * @param {Array<String>} args Argumente nach /cup
     * @param {Object} from Telegram user object
     * @param {String} zielChatId
     * @private
     */
    async telegramCommandCup(args, from, zielChatId) {
        if (!Settings.cup.aktiv) {
            // Wie ein unbekannter Befehl behandeln -- solange die Funktion aus ist,
            // darf sich fuer echte Nutzer nichts vom bisherigen Verhalten unterscheiden.
            if (zielChatId === this.chatId) {
                logger('r', 'Telegram: Unbekannter Gruppen-Befehl /cup ignoriert');
            } else {
                this.antworte(zielChatId, '❌ Unbekannter Befehl. Verwende /help für eine Liste der verfügbaren Befehle.');
            }
            return;
        }

        const unterbefehl = (args[0] || 'status').toLowerCase();

        if (unterbefehl === 'status') {
            await this.cupStatusAnzeigen(zielChatId);
            return;
        }

        const login = await this.loginFuerTelegramUser(from.id);
        if (!login) {
            this.antworte(zielChatId, '❌ Noch nicht verknüpft. Schreibe /link, um einen Code zu erhalten, und gib ihn im Spiel mit /link <code> ein.');
            return;
        }

        const adminBefehle = ['start', 'pause', 'weiter', 'abbruch', 'kick', 'add'];
        if (adminBefehle.includes(unterbefehl) && !Settings.admins.includes(login)) {
            this.antworte(zielChatId, '❌ Dieser Befehl ist nur für Admins.');
            return;
        }

        const turnier = (await this.nextcontrol.mongoDb.collection('cupTurniere')
            .find({ status: { $in: ['angekuendigt', 'anmeldung', 'laeuft', 'siegerehrung'] } })
            .sort({ erstelltAm: -1 }).limit(1).toArray())[0];

        if (!turnier) {
            this.antworte(zielChatId, '🏆 Kein offenes Cup-Turnier.');
            return;
        }

        let kommando, params = {};
        switch (unterbefehl) {
            case 'anmelden': {
                if (turnier.status !== 'anmeldung') {
                    this.antworte(zielChatId, `❌ Anmeldung für "${turnier.name}" ist nicht offen (Status: ${turnier.status}).`);
                    return;
                }
                const spieler = await this.nextcontrol.mongoDb.collection('players').findOne({ login });
                kommando = 'anmelden';
                params = { login, name: spieler?.name ?? login };
                break;
            }
            case 'abmelden':
                kommando = 'abmelden';
                params = { login };
                break;
            case 'start':
                // Admin-Override wie im In-Game-Befehl "//cup start erzwingen"
                // (cup.js::cupAdminCommand) -- startet trotz <3 Teilnehmern.
                kommando = args[1]?.toLowerCase() === 'erzwingen' ? 'startErzwingen' : 'start';
                break;
            case 'pause':
                kommando = 'pause';
                break;
            case 'weiter':
                kommando = 'weiter';
                break;
            case 'abbruch':
                kommando = 'abbruch';
                break;
            case 'kick':
                if (!args[1]) { this.antworte(zielChatId, 'Nutzung: /cup kick <login>'); return; }
                kommando = 'spielerEntfernen';
                params = { login: args[1] };
                break;
            case 'add':
                if (!args[1]) { this.antworte(zielChatId, 'Nutzung: /cup add <login>'); return; }
                kommando = 'spielerReinholen';
                params = { login: args[1] };
                break;
            default:
                this.antworte(zielChatId, 'Nutzung: /cup anmelden|abmelden|status|start [erzwingen]|pause|weiter|abbruch|kick <login>|add <login>');
                return;
        }

        const eingereiht = await this.nextcontrol.mongoDb.collection('cupKommandos').insertOne({
            turnierId: turnier._id, kommando, params, von: `telegram:${from.id}`, erstelltAm: new Date(), verarbeitetAm: null,
        });

        const ergebnis = await this.warteAufCupKommando(eingereiht.insertedId);
        if (ergebnis === null) {
            this.antworte(zielChatId, '⏳ Befehl wurde eingereiht, Bestätigung dauert etwas länger.');
        } else if (ergebnis === 'erfolgreich') {
            this.antworte(zielChatId, `✅ Erledigt (${unterbefehl}).`);
        } else {
            this.antworte(zielChatId, `❌ Fehlgeschlagen: ${ergebnis}`);
        }
    }

    /**
     * Wartet kurz (max. ~3s, 300ms-Takt) auf die Verarbeitung eines cupKommandos
     * durch den separaten Cup-Controller-Prozess, fuer sofortige Rueckmeldung im Chat.
     * @param {*} kommandoId
     * @param {Number} [timeoutMs]
     * @returns {Promise<String|null>} `doc.ergebnis` oder null bei Timeout (noch nicht verarbeitet)
     * @private
     */
    async warteAufCupKommando(kommandoId, timeoutMs = 3000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const doc = await this.nextcontrol.mongoDb.collection('cupKommandos').findOne({ _id: kommandoId });
            if (doc?.verarbeitetAm) return doc.ergebnis ?? 'erfolgreich';
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return null;
    }

    /**
     * Telegram /cup status -- liest den vom Cup-Controller gepflegten Snapshot
     * (cupStatus, siehe cup.js), rein lesend.
     * @param {String} zielChatId
     * @private
     */
    async cupStatusAnzeigen(zielChatId) {
        const status = await this.nextcontrol.mongoDb.collection('cupStatus').findOne({ _id: 'cup' });
        if (!status || status.status === 'keins') {
            this.antworte(zielChatId, '🏆 Kein aktives Cup-Turnier.');
            return;
        }
        let msg = `🏆 <b>${status.status}</b>${status.phaseName ? ` — ${this.escapeHtml(status.phaseName)}` : ''}\n`;
        if (status.status === 'anmeldung') {
            msg += status.teilnehmer?.length
                ? `${status.teilnehmer.length} angemeldet:\n${status.teilnehmer.map((n) => `- ${this.escapeHtml(n)}`).join('\n')}`
                : 'Noch niemand angemeldet.';
        } else if (status.rangliste?.length) {
            msg += status.rangliste.slice(0, 10).map((r, i) => `${i + 1}. ${this.escapeHtml(r.name)} (${r.wert})`).join('\n');
        }
        this.antworte(zielChatId, msg);
    }

    /**
     * Erinnerungs-Ankuendigung X Minuten vor dem geplanten Start eines Turniers in
     * Anmeldung (Settings.cup.erinnerungMinutenVorher). Nur aktiv, wenn Settings.cup.aktiv.
     * @param {Date} jetzt
     * @private
     */
    async pruefeCupErinnerung(jetzt) {
        const turnier = await this.nextcontrol.mongoDb.collection('cupTurniere')
            .findOne({ status: 'anmeldung', geplanterStart: { $ne: null } });
        if (!turnier?.geplanterStart) return;

        const id = turnier._id.toString();
        if (this.cupErinnerungGesendetFuer.has(id)) return;

        const minutenBis = (new Date(turnier.geplanterStart).getTime() - jetzt.getTime()) / 60000;
        if (minutenBis > 0 && minutenBis <= Settings.cup.erinnerungMinutenVorher) {
            this.cupErinnerungGesendetFuer.add(id);
            this.antworte(this.chatId, `⏰ Der Cup "${this.escapeHtml(turnier.name)}" startet in ca. ${Math.round(minutenBis)} Minuten! Jetzt mit /cup anmelden anmelden.`);
        }
    }

    /**
     * Namens-Index login -> Anzeigename (players + archivPlayers), fuer die Telegram-Befehle.
     * @private
     */
    async spielerNamenIndex() {
        const namen = {};
        const archiv = await this.nextcontrol.mongoDb.collection('archivPlayers').find({}).toArray();
        archiv.forEach((p) => { namen[p.login] = p.name ?? p.login; });
        const aktuelle = await this.nextcontrol.mongoDb.collection('players').find({}).toArray();
        aktuelle.forEach((p) => { namen[p.login] = p.name ?? p.login; });
        return namen;
    }

    /**
     * Admin Telegram command
     * @param {String} login Login of the player calling this command
     * @param {Array} params Parameters passed by the player after the command
     */
    async commandAdminTelegram(login, params) {
        if (params.length > 0) {
            const message = params.join(' ');
            this.sendMessage(`📢 Admin-Nachricht:\n${this.escapeHtml(message)}`);
            this.nextcontrol.client.query('ChatSendServerMessageToLogin', ['$0f0Nachricht an Telegram gesendet!', login]);
        } else {
            this.nextcontrol.client.query('ChatSendServerMessageToLogin', ['$f00Verwendung: /admin telegram <Nachricht>', login]);
        }
    }

    /**
     * Test Telegram API connection
     * @returns {Promise}
     * @private
     */
    async testConnection() {
        return new Promise((resolve) => {
            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${this.telegramToken}/getMe`,
                method: 'GET'
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.ok) this.botUsername = response.result.username;
                        resolve(response.ok);
                    } catch (error) {
                        resolve(false);
                    }
                });
            });

            req.setTimeout(15000, () => req.destroy(new Error('Timeout bei testConnection')));
            req.on('error', () => resolve(false));
            req.end();
        });
    }

    /**
     * Registriert das Telegram-Bot-Menü (der "/"-Button neben dem Eingabefeld)
     * mit Kurzbeschreibungen je Befehl -- getrennt für Gruppe und private Chats,
     * weil /link, /mystats, /gap und /abo dort ihren eigentlichen Sinn ergeben.
     * Wird einmalig beim Start aufgerufen; Telegram überschreibt bei jedem Aufruf,
     * daher unproblematisch idempotent.
     * @private
     */
    async registriereBotMenu() {
        const oeffentlich = [
            { command: 'status', description: 'Server-Status anzeigen' },
            { command: 'players', description: 'Online-Spieler auflisten' },
            { command: 'map', description: 'Aktuelle Map anzeigen' },
            { command: 'records', description: 'Rekorde der aktuellen Map' },
            { command: 'monat', description: 'Monats-Rangliste anzeigen' },
            { command: 'help', description: 'Hilfe anzeigen' },
        ];
        const privat = [
            ...oeffentlich,
            { command: 'link', description: 'Account mit Spieler-Login verknüpfen' },
            { command: 'mystats', description: 'Eigene Punkte & Rang' },
            { command: 'gap', description: 'Rückstand auf Platz 1 je Map' },
            { command: 'abo', description: 'Private Benachrichtigungen verwalten' },
        ];
        // /cup nur im Bot-Menü zeigen, wenn das Feature ueberhaupt aktiv ist
        // (Settings.cup.aktiv, Default AUS) -- sonst bliebe ein totes Menue-Item stehen.
        if (Settings.cup.aktiv) {
            oeffentlich.push({ command: 'cup', description: 'Cup: Status/Anmeldung' });
            privat.push({ command: 'cup', description: 'Cup: Status/Anmeldung/Admin' });
        }
        await this.setzeBotCommands(privat, { type: 'all_private_chats' });
        await this.setzeBotCommands(oeffentlich, { type: 'all_group_chats' });
    }

    /**
     * Ruft setMyCommands für einen bestimmten Scope auf (JSON-Body, anders als
     * die übrigen Telegram-Aufrufe hier, die querystring-kodiert sind).
     * @param {Array<{command: String, description: String}>} commands
     * @param {{type: String}} scope
     * @private
     */
    setzeBotCommands(commands, scope) {
        if (this.dryRun) {
            logger('r', `Telegram (Trockenlauf): Bot-Menü gesetzt (${scope.type}, ${commands.length} Befehle)`);
            return Promise.resolve();
        }
        const postData = JSON.stringify({ commands, scope });
        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'api.telegram.org', port: 443, path: `/bot${this.telegramToken}/setMyCommands`, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
            }, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    try {
                        if (!JSON.parse(data).ok) logger('er', `Telegram: setMyCommands (${scope.type}) fehlgeschlagen: ${data}`);
                    } catch { /* Antwort nicht parsebar -- nichts weiter zu tun */ }
                    resolve();
                });
            });
            req.setTimeout(15000, () => req.destroy(new Error('Timeout bei setMyCommands')));
            req.on('error', (e) => { logger('er', `Telegram: setMyCommands Fehler: ${e.message}`); resolve(); });
            req.write(postData);
            req.end();
        });
    }

    /**
     * Send message to Telegram
     * @param {String} text Message text
     * @param {Object} options Additional options
     * @private
     */
    sendMessage(text, options = {}) {
        const message = {
            chat_id: this.chatId,
            text: text,
            parse_mode: 'HTML',
            ...options
        };

        this.messageQueue.push(message);
        this.processMessageQueue();
    }

    /**
     * Process message queue with rate limiting
     * @private
     */
    processMessageQueue() {
        if (this.isProcessingQueue || this.messageQueue.length === 0) return;

        this.isProcessingQueue = true;
        const message = this.messageQueue.shift();

        if (this.dryRun) {
            logger('r', `Telegram (Trockenlauf): ${message.text}`);
            this.isProcessingQueue = false;
            setTimeout(() => this.processMessageQueue(), 50);
            return;
        }

        const postData = querystring.stringify(message);

        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${this.telegramToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                this.isProcessingQueue = false;
                setTimeout(() => this.processMessageQueue(), 1000);
            });
        });

        // Ohne Timeout wuerde eine haengende Anfrage isProcessingQueue fuer
        // immer blockiert lassen -- dann kaeme NIE WIEDER eine Telegram-
        // Nachricht raus, ohne dass ein Fehler sichtbar wird.
        req.setTimeout(15000, () => req.destroy(new Error('Timeout beim Senden')));

        req.on('error', (error) => {
            logger('er', `Telegram: Error sending message: ${error.message}`);
            this.isProcessingQueue = false;
            setTimeout(() => this.processMessageQueue(), 1000);
        });

        req.write(postData);
        req.end();
    }

    /**
     * Start polling for Telegram updates
     * @private
     */
    startPolling() {
        // Telegram merkt sich serverseitig den zuletzt per getUpdates/setWebhook
        // uebergebenen allowed_updates-Filter fuer diesen Bot-Token, auch OHNE
        // Webhook -- ohne diesen expliziten Parameter kann ein frueherer (auch
        // externer) Aufruf einen Filter hinterlassen haben, der z.B. poll_answer
        // stillschweigend ausschliesst (2026-07-29 live entdeckt: Karma-Voting-
        // Stimmen kamen nie an, weil genau das passiert war). Deshalb bei JEDEM
        // Poll-Aufruf explizit die tatsaechlich verarbeiteten Update-Typen setzen.
        const ALLOWED_UPDATES = JSON.stringify(['message', 'poll_answer']);

        const poll = () => {
            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${this.telegramToken}/getUpdates?offset=${this.updateOffset}&timeout=30&allowed_updates=${encodeURIComponent(ALLOWED_UPDATES)}`,
                method: 'GET'
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.ok && response.result.length > 0) {
                            response.result.forEach(update => {
                                // WICHTIG: Offset IMMER zuerst weiterzaehlen, bevor verarbeitet wird.
                                // Sonst wuerde ein Fehler bei einem Update dazu fuehren, dass Telegram
                                // dieselbe Nachricht endlos erneut zustellt (und alles danach blockiert).
                                this.updateOffset = update.update_id + 1;
                                try {
                                    this.handleTelegramMessage(update);
                                } catch (error) {
                                    logger('er', `Telegram: Fehler bei der Verarbeitung eines Updates: ${error.message}`);
                                }
                            });
                        }
                    } catch (error) {
                        logger('er', `Telegram: Error parsing updates: ${error.message}`);
                    }
                    setTimeout(poll, 1000);
                });
            });

            // Client-seitiges Sicherheitsnetz: Telegram haelt die Verbindung bis zu
            // 30s offen (Long-Poll), falls sie darueber hinaus haengt, Verbindung
            // kappen statt fuer immer auf Updates zu warten.
            req.setTimeout(40000, () => req.destroy(new Error('Timeout beim Abrufen der Updates')));

            req.on('error', (error) => {
                logger('er', `Telegram: Polling error: ${error.message}`);
                setTimeout(poll, 5000);
            });

            req.end();
        };

        poll();
    }

    /**
     * Handle incoming Telegram messages
     * @param {Object} update Telegram update object
     * @private
     */
    handleTelegramMessage(update) {
        if (update.poll_answer) {
            this.handlePollAnswer(update.poll_answer);
            return;
        }

        if (!update.message || !update.message.text) return;

        const message = update.message.text.trim();
        const chatId = update.message.chat.id.toString();
        const istPrivat = update.message.chat.type === 'private';

        // Gruppe ODER privater Chat mit dem Bot -- alles andere ignorieren
        if (chatId !== this.chatId && !istPrivat) return;

        if (message.startsWith('/')) {
            // Antworten gehen immer an den Chat zurück, aus dem die Frage kam
            this.handleCommand(message, update.message.from, { chatId, istPrivat });
        } else if (!istPrivat && this.settings.enableChatChannel) {
            const username = update.message.from.username || update.message.from.first_name || 'Unknown';
            this.nextcontrol.client.query('ChatSendServerMessage', [
                `$09f[Telegram] $fff${username}$z$s: ${message}`
            ]);
        }
    }

    /**
     * Verarbeitet eine Stimmabgabe der laufenden Map-Abstimmung.
     * @param {Object} pollAnswer Telegram poll_answer update
     * @private
     */
    async handlePollAnswer(pollAnswer) {
        if (!this.abstimmungAktiv || pollAnswer.poll_id !== this.abstimmungPollId) return;
        this.abstimmungAntworten.set(pollAnswer.user.id, pollAnswer.option_ids);
        try {
            await this.speichereAbstimmungStatus();
        } catch (error) {
            logger('er', `Telegram: Fehler beim Speichern des Abstimmungsstatus: ${error.message}`);
        }
    }

    /**
     * Handle Telegram commands
     * @param {String} command Command string
     * @param {Object} from Telegram user object
     * @param {{chatId: String, istPrivat: Boolean}} herkunft Chat, aus dem der Befehl kam
     * @private
     */
    handleCommand(command, from, herkunft) {
        const args = command.split(' ');
        // "@botname"-Suffix abschneiden (Telegram hängt es in Gruppen oft an)
        const cmd = args[0].toLowerCase().split('@')[0];
        const ziel = herkunft.chatId;

        logger('r', `Telegram: ${from.username || from.first_name} sendete ${command}${herkunft.istPrivat ? ' (privat)' : ''}`);

        // Alles in try/catch: ein synchroner Fehler (z.B. status.map noch nicht
        // initialisiert) darf die Polling-Schleife nicht zum Absturz bringen.
        try {
            switch (cmd) {
                case '/status':
                    this.sendServerStatus(ziel);
                    break;
                case '/players':
                    this.sendPlayerList(ziel);
                    break;
                case '/map':
                    this.sendCurrentMap(ziel);
                    break;
                case '/records':
                    this.sendDatabaseRecords(ziel).catch((e) => this.meldeBefehlsFehler('/records', e, ziel));
                    break;
                case '/link':
                    this.telegramCommandLink(from, ziel).catch((e) => this.meldeBefehlsFehler('/link', e, ziel));
                    break;
                case '/mystats':
                    this.telegramCommandMystats(from, ziel).catch((e) => this.meldeBefehlsFehler('/mystats', e, ziel));
                    break;
                case '/monat':
                    this.telegramCommandMonat(ziel).catch((e) => this.meldeBefehlsFehler('/monat', e, ziel));
                    break;
                case '/gap':
                    this.telegramCommandGap(from, ziel).catch((e) => this.meldeBefehlsFehler('/gap', e, ziel));
                    break;
                case '/abo':
                    this.telegramCommandAbo(from, args.slice(1), ziel).catch((e) => this.meldeBefehlsFehler('/abo', e, ziel));
                    break;
                case '/cup':
                    this.telegramCommandCup(args.slice(1), from, ziel).catch((e) => this.meldeBefehlsFehler('/cup', e, ziel));
                    break;
                case '/help':
                case '/start':
                    this.sendHelp(ziel);
                    break;
                default:
                    // In der Gruppe still bleiben (könnte an einen anderen Bot gerichtet
                    // sein) -- nur im privaten Chat freundlich antworten.
                    if (herkunft.istPrivat) {
                        this.antworte(ziel, '❌ Unbekannter Befehl. Verwende /help für eine Liste der verfügbaren Befehle.');
                    } else {
                        logger('r', `Telegram: Unbekannter Gruppen-Befehl ${cmd} ignoriert`);
                    }
            }
        } catch (error) {
            this.meldeBefehlsFehler(cmd, error, ziel);
        }
    }

    /**
     * Sendet eine Befehls-Antwort an den Herkunfts-Chat (Gruppe oder privat).
     * Läuft über dieselbe Warteschlange wie sendMessage (Rate-Limiting).
     * @param {String} zielChatId
     * @param {String} text
     * @private
     */
    antworte(zielChatId, text) {
        this.sendMessage(text, zielChatId && zielChatId !== this.chatId ? { chat_id: zielChatId } : {});
    }

    /** Fängt Fehler in den Telegram-Befehlen ab, statt sie als unhandled rejection verschwinden zu lassen. */
    meldeBefehlsFehler(befehl, error, zielChatId) {
        logger('er', `Telegram: Fehler bei ${befehl}: ${error.stack || error.message}`);
        this.antworte(zielChatId, `❌ Fehler bei ${befehl}: ${error.message}`);
    }

    /**
     * Send server status
     * @private
     */
    sendServerStatus(zielChatId) {
        const players = this.nextcontrol.status.players;
        const currentMap = this.nextcontrol.status.map;

        let message = '📊 Server Status\n\n';
        message += `👥 Spieler: ${players.length}\n`;
        message += `🗺️ Aktuelle Map: ${stripFormatting(currentMap.name)}\n`;
        message += `👤 Autor: ${currentMap.author}`;

        this.antworte(zielChatId, message);
    }

    /**
     * Send player list
     * @private
     */
    sendPlayerList(zielChatId) {
        const players = this.nextcontrol.status.players;

        if (players.length === 0) {
            this.antworte(zielChatId, '👥 Keine Spieler online');
            return;
        }

        let message = `👥 Online Spieler (${players.length}):\n\n`;
        players.forEach((player, index) => {
            message += `${index + 1}. ${stripFormatting(player.name)}\n`;
        });

        this.antworte(zielChatId, message);
    }

    /**
     * Send current map info
     * @private
     */
    sendCurrentMap(zielChatId) {
        const map = this.nextcontrol.status.map;

        let message = '🗺️ Aktuelle Map\n\n';
        message += `📛 Name: ${stripFormatting(map.name)}\n`;
        message += `👤 Autor: ${map.author}`;

        this.antworte(zielChatId, message);
    }

    /**
     * Send database records for current map
     * @private
     */
    async sendDatabaseRecords(zielChatId) {
        try {
            const currentMap = this.nextcontrol.status.map;
            let records = [];
            const dbtype = Settings.usedDatabase.toLowerCase();

            if (dbtype === 'mongodb') {
                records = await this.nextcontrol.mongoDb.collection('records')
                    .find({ map: currentMap.uid })
                    .sort({ time: 1 })
                    .limit(15)
                    .toArray();
            } else if (dbtype === 'mysql') {
                const result = await this.nextcontrol.mysql.query(
                    'SELECT * FROM records WHERE map = ? ORDER BY time ASC LIMIT 15',
                    [currentMap.uid]
                );
                records = result;
            }

            if (records.length === 0) {
                this.antworte(zielChatId, '🏆 Noch keine Rekorde in der Datenbank vorhanden');
                return;
            }

            let message = `🏆 Datenbank-Rekorde (Top ${Math.min(records.length, 15)}):\n`;
            message += `🗺️ ${stripFormatting(currentMap.name)}\n\n`;

            for (let i = 0; i < records.length; i++) {
                const record = records[i];
                let medal;
                if (i === 0) medal = '🥇';
                else if (i === 1) medal = '🥈';
                else if (i === 2) medal = '🥉';
                else medal = `${i + 1}.`;

                const playerName = await this.getPlayerNameFromDatabase(record.login);
                message += `${medal} ${stripFormatting(playerName)} - ${this.formatTime(record.time)}\n`;
            }

            this.antworte(zielChatId, message);

        } catch (error) {
            logger('er', `Telegram: Error fetching database records: ${error.message}`);
            this.antworte(zielChatId, `❌ Fehler beim Laden der Rekorde: ${error.message}`);
        }
    }

    /**
     * Send help message
     * @private
     */
    sendHelp(zielChatId) {
        let message = '📋 Verfügbare Befehle:\n\n';
        message += '/status - Server Status anzeigen\n';
        message += '/players - Online Spieler auflisten\n';
        message += '/map - Aktuelle Map Info\n';
        message += '/records - Datenbank-Rekorde anzeigen\n';
        message += '/monat - Aktuelles Ranking anzeigen\n';
        message += '/link - Account mit deinem Spieler-Login verknüpfen\n';
        message += '/mystats - Eigene Punkte/Rang (nach /link)\n';
        message += '/gap - Rückstand auf Platz 1 je Map (nach /link)\n';
        message += '/abo - Private Benachrichtigungen ein-/ausschalten (nach /link)\n';
        if (Settings.cup.aktiv) {
            message += '/cup - Cup: anmelden/abmelden/status (Admins zusätzlich start/pause/weiter/abbruch/kick/add)\n';
        }
        message += '/help - Diese Hilfe anzeigen\n\n';
        message += '💬 Du kannst mir auch privat schreiben — Antworten kommen dann privat statt in die Gruppe.\n';
        message += '💬 Chat in der Gruppe: Nachrichten ohne / gehen an alle Spieler im Spiel.\n\n';
        message += '📋 Verknüpfte Spieler bekommen nach jeder Map eine private Zusammenfassung.';

        this.antworte(zielChatId, message);
    }

    /**
     * Verarbeitet das Ende einer Map: Ranking-Diffs (Monatstabelle + Hall of Fame),
     * Gaming-Log-Einträge, HoF-Sondermeldung, Endspurt-Gruppen-Update und die
     * privaten Digest-DMs an registrierte Nutzer. Ersetzt die frühere
     * Gruppen-Zusammenfassung "Persönliche Rekorde".
     * @param {String} mapName Name der beendeten Map
     * @private
     */
    async verarbeiteMapEnde(mapName) {
        try {
            // Ranking-Snapshots ziehen und mit dem Stand vom letzten Map-Beginn vergleichen
            const namen = await this.spielerNamenIndex();
            const records = await this.nextcontrol.mongoDb.collection('records').find({}).toArray();
            const monatsRanking = berechneRanking(records, namen);
            const archivRecords = await this.nextcontrol.mongoDb.collection('archivRecords').find({}).toArray();
            const hofRanking = berechneRanking(archivRecords.concat(records), namen);

            const tabellenWechsel = this.diffRanking(this.monatsRankingSnapshot, monatsRanking);
            const hofWechsel = this.diffRanking(this.hofRankingSnapshot, hofRanking);
            this.monatsRankingSnapshot = monatsRanking;
            this.hofRankingSnapshot = hofRanking;

            // Gaming-Log bekommt IMMER alles -- unabhängig von Registrierung/Telegram
            for (const u of this.ueberholEreignisse) {
                await protokolliere(this.nextcontrol, 'ueberholt',
                    `📉 ${namen[u.login] ?? u.login} wurde auf ${u.map} von ${u.durch} überholt (jetzt #${u.neuePos}, vorher #${u.altePos})`);
            }
            for (const w of tabellenWechsel) {
                const richtung = w.neu < w.alt ? '📈' : '📉';
                await protokolliere(this.nextcontrol, 'tabelle',
                    `${richtung} ${stripFormatting(w.name)} in der Monatstabelle: #${w.alt} → #${w.neu}`);
            }

            // Hall-of-Fame-Änderung: Sondermeldung auf allen Kanälen (selten!)
            if (hofWechsel.length > 0) {
                await this.sendeHofSondermeldung(hofWechsel);
            }

            // Endspurt: Monatstabellen-Änderungen (Top 10) kompakt in die Gruppe,
            // damit auch nicht registrierte Nutzer den Schlussspurt mitbekommen
            const top10Wechsel = tabellenWechsel.filter((w) => w.neu <= 10 || w.alt <= 10);
            if (this.istEndspurt() && top10Wechsel.length > 0) {
                let msg = `📊 <b>Tabellen-Update (Monatswertung)</b>\n\n`;
                for (const w of top10Wechsel) {
                    const richtung = w.neu < w.alt ? '📈' : '📉';
                    msg += `${richtung} ${this.escapeHtml(stripFormatting(w.name))}: #${w.alt} → #${w.neu}\n`;
                }
                this.sendMessage(msg);
            }

            // Private Digest-DMs an registrierte Nutzer
            if (this.settings.enableMapChangeSummary) {
                await this.sendeMapDigests(mapName, tabellenWechsel);
            }
        } catch (error) {
            logger('er', `Telegram: Fehler bei der Map-Ende-Verarbeitung: ${error.message}`);
        } finally {
            this.personalBestImprovements = [];
            this.ueberholEreignisse = [];
        }
    }

    /**
     * Vergleicht zwei Ranglisten (berechneRanking-Ergebnisse) und liefert alle
     * Positionswechsel: [{login, name, alt, neu}]. Neueinsteiger (ohne alte
     * Position) werden ausgelassen -- deren eigener Verbesserungs-Eintrag reicht.
     * @param {Array|null} alt Snapshot vom letzten Map-Beginn (null = erster Lauf)
     * @param {Array} neu aktuelles Ranking
     * @private
     */
    diffRanking(alt, neu) {
        if (!alt) return [];
        const altePositionen = new Map(alt.map((s, i) => [s.login, i + 1]));
        const wechsel = [];
        neu.forEach((s, i) => {
            const altePos = altePositionen.get(s.login);
            const neuePos = i + 1;
            if (altePos && altePos !== neuePos) {
                wechsel.push({ login: s.login, name: s.name, alt: altePos, neu: neuePos });
            }
        });
        return wechsel;
    }

    /**
     * Sondermeldung bei Änderung der Hall-of-Fame-Reihenfolge -- auf ALLEN Kanälen:
     * Telegram-Gruppe, In-Game-Chat, Gaming-Log und DM an die Betroffenen.
     * @param {Array} hofWechsel diffRanking-Ergebnis des HoF-Rankings
     * @private
     */
    async sendeHofSondermeldung(hofWechsel) {
        const aufsteiger = hofWechsel.filter((w) => w.neu < w.alt);
        for (const a of aufsteiger) {
            const ueberholte = hofWechsel.filter((w) => w.alt < a.alt && w.neu > a.neu);
            const ueberholteNamen = ueberholte.map((u) => stripFormatting(u.name)).join(', ');
            const kern = ueberholteNamen
                ? `${stripFormatting(a.name)} überholt ${ueberholteNamen} und ist jetzt #${a.neu} aller Zeiten!`
                : `${stripFormatting(a.name)} ist jetzt #${a.neu} aller Zeiten!`;

            // Telegram-Gruppe -- nur im Endspurt (letzte 5 Tage vor Monatsende, Betreiber-
            // Wunsch 2026-09-01), sonst wuerde jede Rangaenderung uebers ganze Monat verteilt
            // die Gruppe fluten. In-Game-Chat/Gaming-Log/DMs bleiben unabhaengig davon aktiv.
            if (this.istEndspurt()) {
                this.sendMessage(`🏛️ <b>HALL OF FAME!</b>\n\n${this.escapeHtml(kern)}`);
            }

            // In-Game-Chat
            await this.nextcontrol.client.query('ChatSendServerMessage', [
                format(Sentences.hof.rangwechsel, { text: kern })
            ]).catch(() => {});

            // Gaming-Log
            await protokolliere(this.nextcontrol, 'hof', `🏛️ Hall of Fame: ${kern}`);

            // DMs an die Betroffenen (Aufsteiger + Überholte)
            this.sendeDmAnLogin(a.login, `🏛️ <b>Hall of Fame:</b> Du bist jetzt #${a.neu} aller Zeiten! 🎉`, 'digest')
                .catch(() => {});
            for (const u of ueberholte) {
                this.sendeDmAnLogin(u.login,
                    `🏛️ <b>Hall of Fame:</b> ${this.escapeHtml(stripFormatting(a.name))} hat dich überholt — du bist jetzt #${u.neu} aller Zeiten.`,
                    'digest').catch(() => {});
            }
        }
    }

    /**
     * Schickt jedem registrierten, betroffenen Nutzer genau EINE private DM mit
     * seiner persönlichen Map-Bilanz: eigene Verbesserungen, Überhol-Ereignisse
     * und Monatstabellen-Rangwechsel.
     * @param {String} mapName Name der beendeten Map
     * @param {Array} tabellenWechsel diffRanking-Ergebnis der Monatstabelle
     * @private
     */
    async sendeMapDigests(mapName, tabellenWechsel) {
        // Betroffene Logins einsammeln
        const logins = new Set();
        this.personalBestImprovements.forEach((v) => logins.add(v.login));
        this.ueberholEreignisse.forEach((u) => logins.add(u.login));
        tabellenWechsel.forEach((w) => logins.add(w.login));

        for (const login of logins) {
            const link = await this.linkFuerLogin(login);
            if (!link || !this.hatAbo(link, 'digest')) continue;

            const teile = [];

            const verbesserungen = this.personalBestImprovements.filter((v) => v.login === login);
            if (verbesserungen.length > 0) {
                const letzte = verbesserungen[verbesserungen.length - 1];
                let z = `⏱️ Deine Bestzeit: ${this.formatTime(letzte.newTime)} (#${letzte.newPosition})`;
                if (letzte.oldTime) {
                    z += `\n⚡ ${verbesserungen.length} Verbesserung(en), gesamt: -${this.formatTime(letzte.oldTime - letzte.newTime)}`;
                }
                teile.push(z);
            }

            if (this.hatAbo(link, 'ueberholt')) {
                const ueberholungen = this.ueberholEreignisse.filter((u) => u.login === login);
                for (const u of ueberholungen) {
                    teile.push(`📉 ${this.escapeHtml(u.durch)} hat dich überholt: jetzt #${u.neuePos} (vorher #${u.altePos})`);
                }
            }

            const wechsel = tabellenWechsel.find((w) => w.login === login);
            if (wechsel) {
                const richtung = wechsel.neu < wechsel.alt ? '📈' : '📉';
                teile.push(`${richtung} Monatstabelle: #${wechsel.alt} → #${wechsel.neu}`);
            }

            if (teile.length === 0) continue;

            const text = `📋 <b>${this.escapeHtml(stripFormatting(mapName))}</b>\n\n` + teile.join('\n\n');
            await this.sendeDirekteNachricht(link.telegramUserId, text)
                .then((ok) => { if (!ok) logger('r', `Telegram: Digest-DM an ${login} nicht zustellbar`); })
                .catch((e) => logger('er', `Telegram: Digest-DM an ${login} fehlgeschlagen: ${e.message}`));
        }
    }

    /**
     * Escape HTML characters
     * @param {String} text Text to escape
     * @returns {String} Escaped text
     * @private
     */
    escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Format time in milliseconds to readable format
     * @param {Number} milliseconds Time in milliseconds
     * @returns {String} Formatted time
     * @private
     */
    formatTime(milliseconds) {
        const minutes = Math.floor(milliseconds / 60000);
        const seconds = Math.floor((milliseconds % 60000) / 1000);
        const ms = milliseconds % 1000;

        if (minutes > 0) {
            return `${minutes}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
        } else {
            return `${seconds}.${ms.toString().padStart(3, '0')}`;
        }
    }

    /**
     * Function run, whenever a player passes a waypoint (finish, multilap, checkpoint, ...)
     * NEUE LOGIK: Nur Server-Rekorde sofort, PB-Tracking für Map-Ende, Positionswechsel ab 15.
     * @param {Classes.WaypointInfo} waypointInfo
     */
    async onWaypoint(waypointInfo) {
        // Nur bei Zieleinläufen und wenn Rekord-Benachrichtigungen aktiviert sind
        if (!waypointInfo.isEndRace || !this.settings.enableLogChannel || !this.settings.enableRecordNotifications) return;
        
        const player = this.nextcontrol.status.getPlayer(waypointInfo.login);
        if (!player) return;
        
        const currentMap = this.nextcontrol.status.map;
        
        // Initialize leader tracking for new maps
        if (this.currentLeader.mapUid !== currentMap.uid) {
            await this.initializeCurrentLeader(currentMap.uid);
        }

        try {
            // Hole VORHERIGE Datenbank-Rekorde
            let oldDbRecords = [];
            const dbtype = Settings.usedDatabase.toLowerCase();

            if (dbtype === 'mongodb') {
                oldDbRecords = await this.nextcontrol.mongoDb.collection('records')
                    .find({ map: currentMap.uid })
                    .sort({ time: 1 })
                    .toArray();
            } else if (dbtype === 'mysql') {
                const result = await this.nextcontrol.mysql.query(
                    'SELECT * FROM records WHERE map = ? ORDER BY time ASC',
                    [currentMap.uid]
                );
                oldDbRecords = result;
            }

            const existingDbRecord = oldDbRecords.find(r => r.login === waypointInfo.login);
            const oldBestTime = oldDbRecords.length > 0 ? oldDbRecords[0].time : null;
            const oldPosition = existingDbRecord ? oldDbRecords.findIndex(r => r.login === waypointInfo.login) + 1 : null;
            const oldLeader = oldDbRecords.length > 0 ? oldDbRecords[0] : null;

            // Warte auf Datenbank-Update
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Hole NEUE Datenbank-Rekorde
            let newDbRecords = [];
            if (dbtype === 'mongodb') {
                newDbRecords = await this.nextcontrol.mongoDb.collection('records')
                    .find({ map: currentMap.uid })
                    .sort({ time: 1 })
                    .toArray();
            } else if (dbtype === 'mysql') {
                const result = await this.nextcontrol.mysql.query(
                    'SELECT * FROM records WHERE map = ? ORDER BY time ASC',
                    [currentMap.uid]
                );
                newDbRecords = result;
            }

            const newDbRecord = newDbRecords.find(r => r.login === waypointInfo.login);
            const newBestTime = newDbRecords.length > 0 ? newDbRecords[0].time : null;
            const newPosition = newDbRecord ? newDbRecords.findIndex(r => r.login === waypointInfo.login) + 1 : null;
            const newLeader = newDbRecords.length > 0 ? newDbRecords[0] : null;

            // Prüfe ob überhaupt ein Datenbank-Rekord erstellt/verbessert wurde
            if (!newDbRecord || (existingDbRecord && newDbRecord.time >= existingDbRecord.time)) return;

            // 1. SERVER-REKORD (neue #1): Gruppen-Nachricht nur im Monats-Endspurt,
            //    der entthronte Ex-Führende bekommt immer sofort eine private DM.
            //    Außerhalb des Endspurts erfährt die Gruppe es abends im Tagesreport.
            if (newPosition === 1 && (oldBestTime === null || newDbRecord.time < oldBestTime)) {
                if (this.istEndspurt()) {
                    let message = `🏆 NEUER SERVER-REKORD!\n\n`;
                    message += `👤 ${this.escapeHtml(stripFormatting(player.name))}\n`;
                    message += `⏱️ Zeit: ${this.formatTime(newDbRecord.time)}\n`;
                    message += `🗺️ Map: ${this.escapeHtml(stripFormatting(currentMap.name))}\n`;
                    message += `🥇 Position: #1`;

                    if (oldBestTime) {
                        message += `\n⚡ Verbesserung: -${this.formatTime(oldBestTime - newDbRecord.time)}`;
                    }
                    this.sendMessage(message);
                }

                if (oldLeader && oldLeader.login !== newDbRecord.login) {
                    const dmText = `⚡ Dein Rekord auf <b>${this.escapeHtml(stripFormatting(currentMap.name))}</b> wurde geknackt!\n` +
                        `${this.escapeHtml(stripFormatting(player.name))}: ${this.formatTime(newDbRecord.time)} (du: ${this.formatTime(oldLeader.time)})`;
                    this.sendeDmAnLogin(oldLeader.login, dmText, 'rekordVerlust')
                        .catch((e) => logger('er', `Telegram: Rekord-Verlust-DM fehlgeschlagen: ${e.message}`));
                }

                // Update leader tracking
                this.currentLeader = {
                    login: newDbRecord.login,
                    name: await this.getPlayerNameFromDatabase(newDbRecord.login),
                    time: newDbRecord.time,
                    mapUid: currentMap.uid
                };
            }

            // 2. ÜBERHOLT-ERKENNUNG: Wer ist durch diese Zeit in der Map-Rekordliste
            //    nach hinten gerutscht? Wird gepuffert und beim Map-Wechsel als
            //    private Digest-DM zugestellt (kein Sofort-Versand -> kein Spam).
            const altePositionen = new Map(oldDbRecords.map((r, i) => [r.login, i + 1]));
            newDbRecords.forEach((r, i) => {
                const alt = altePositionen.get(r.login);
                const neu = i + 1;
                if (alt && neu > alt && r.login !== waypointInfo.login) {
                    this.ueberholEreignisse.push({
                        login: r.login,
                        map: stripFormatting(currentMap.name),
                        altePos: alt,
                        neuePos: neu,
                        durch: stripFormatting(player.name),
                    });
                }
            });

            // 3. TRACKING FÜR MAP-WECHSEL ZUSAMMENFASSUNG: Alle persönlichen Verbesserungen
            if (this.settings.enableMapChangeSummary) {
                this.personalBestImprovements.push({
                    login: waypointInfo.login,
                    name: player.name,
                    oldTime: existingDbRecord ? existingDbRecord.time : null,
                    newTime: newDbRecord.time,
                    oldPosition: oldPosition,
                    newPosition: newPosition,
                    improvement: existingDbRecord ? existingDbRecord.time - newDbRecord.time : null
                });
            }

            // Tracking fuer den Tagesreport (Zeitplan konfigurierbar per Dashboard)
            this.tagesVerbesserungen.push({
                login: waypointInfo.login,
                name: player.name,
                map: stripFormatting(currentMap.name),
                time: newDbRecord.time,
                position: newPosition,
            });

        } catch (error) {
            logger('er', `Telegram: Error checking database records: ${error.message}`);
        }
    }

    /**
     * Function run, when a player sends a chat message or command
     * @param {String} login Player's login
     * @param {String} text Message text
     */
    async onChat(login, text) {
        if (this.settings.enableChatChannel) {
            const player = this.nextcontrol.status.getPlayer(login);
            if (!text.startsWith('/') && player && player.name !== "" && login !== "00000000") {
                this.sendMessage(`💬 ${this.escapeHtml(stripFormatting(player.name))}: ${this.escapeHtml(stripFormatting(text))}`);
            }
        }
    }

    /**
     * Function run when a new map begins
     * Initialize leader tracking and send PB summary for previous map
     * @param {Object} params
     */
    async onBeginMap(params) {
        // Bilanz der vorherigen Map verarbeiten (Digests, Ranking-Diffs, HoF).
        // Auch ohne Verbesserungen ausführen, damit die Ranking-Snapshots
        // initialisiert werden (erster Lauf nach Controller-Start).
        // ACHTUNG: status.map ist hier bereits die NEUE Map -- der Name der
        // beendeten Map kommt aus unserem eigenen Tracking (aktuelleMapName).
        if (this.nextcontrol && this.nextcontrol.status && this.nextcontrol.status.map) {
            const beendeteMap = this.aktuelleMapName ?? this.nextcontrol.status.map.name;
            this.aktuelleMapName = params?.name ?? this.nextcontrol.status.map.name;
            setTimeout(() => {
                this.verarbeiteMapEnde(beendeteMap)
                    .catch((e) => logger('er', `Telegram: verarbeiteMapEnde fehlgeschlagen: ${e.message}`));
            }, 2000); // Delay, bis der Map-Wechsel (inkl. DB-Writes) abgeschlossen ist
        }

        // Initialize leader tracking for new map
        setTimeout(async () => {
            if (this.nextcontrol && this.nextcontrol.status && this.nextcontrol.status.map) {
                await this.initializeCurrentLeader(this.nextcontrol.status.map.uid);
            }
        }, 3000);
    }

    /**
     * Function run when a map ends
     * @param {Object} params
     */
    async onEndMap(params) {
        // Map end - preparation for summary (actual summary sent in onBeginMap)
        // This ensures we have all final improvements before summarizing
    }

    // ─── Zeitgesteuerte Aufgaben (Tagesreport, Wochenrückblick, Map-Abstimmung) ───

    /**
     * Wird jede Minute aufgerufen und prüft, ob eine der zeitgesteuerten
     * Aufgaben jetzt fällig ist. Bewusst simpel (keine externen Cron-Jobs).
     * @private
     */
    async pruefeZeitgesteuerteAufgaben() {
        try {
            const jetzt = new Date();
            const heute = jetzt.toISOString().slice(0, 10);

            // Tagesreport-Zeitplan per Admin-Dashboard konfigurierbar (Default 20:00, wie
            // bisher fest verdrahtet). Ganztaegiges Fenster ab der konfigurierten Uhrzeit (Muster
            // wie automatikTakt.js) statt exaktem Minutentreffer -- robust gegen verpasste Ticks.
            const tagesreportEinst = holeEinstellungen().tagesreport;
            const jetztHHMM = `${String(jetzt.getHours()).padStart(2, '0')}:${String(jetzt.getMinutes()).padStart(2, '0')}`;
            if (jetztHHMM >= tagesreportEinst.uhrzeit && this.letzterTagesReport !== heute) {
                this.letzterTagesReport = heute;
                // Reset laeuft IMMER am Tagesende, auch wenn die Funktion per Dashboard
                // deaktiviert ist -- sonst wuerden sich bei spaeterer Reaktivierung mehrere
                // Tage an Verbesserungen zu einem falschen "Tagesreport" summieren.
                if (tagesreportEinst.aktiv && this.tagesVerbesserungen.length > 0) await this.sendeTagesReport();
                this.tagesVerbesserungen = [];
            }

            // Wochenrückblick sonntags um 20:30, nur einmal pro Woche
            const wocheKennung = `${jetzt.getFullYear()}-W${String(this.isoKalenderwoche(jetzt)).padStart(2, '0')}`;
            if (jetzt.getDay() === 0 && jetzt.getHours() === 20 && jetzt.getMinutes() >= 30 && this.letzterWochenRueckblick !== wocheKennung) {
                this.letzterWochenRueckblick = wocheKennung;
                await this.sendeWochenRueckblick();
            }

            // Map-Abstimmung in den letzten ~5 Tagen des Monats
            const monatKennung = monatsKennung(jetzt);
            const letzterTagDesMonats = new Date(jetzt.getFullYear(), jetzt.getMonth() + 1, 0).getDate();
            const tageBisMonatsende = letzterTagDesMonats - jetzt.getDate();

            if (this.abstimmungWiederherstellungAbgeschlossen && tageBisMonatsende <= 5 && !this.abstimmungAktiv && this.abstimmungGestartetFuerMonat !== monatKennung) {
                this.abstimmungGestartetFuerMonat = monatKennung;
                await this.starteMapAbstimmung();
            }
            if (this.abstimmungAktiv && tageBisMonatsende <= 1) {
                await this.schliesseMapAbstimmung();
            }

            // Cup-Start-Erinnerung -- nur wenn das Feature ueberhaupt aktiv ist
            if (Settings.cup.aktiv) {
                await this.pruefeCupErinnerung(jetzt);
            }
        } catch (error) {
            logger('er', `Telegram: Fehler bei zeitgesteuerten Aufgaben: ${error.message}`);
        }
    }

    /** ISO-Kalenderwoche einer Datumsangabe. @private */
    isoKalenderwoche(datum) {
        const d = new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const jahresstart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - jahresstart) / 86400000) + 1) / 7);
    }

    /**
     * Sendet den Tagesreport (Zeitplan per Dashboard konfigurierbar), sofern in den
     * letzten ~24 Stunden (seit dem letzten Report) jemand gefahren ist. Zeigt NICHT mehr jede
     * einzelne Verbesserung, sondern nur die Anzahl je Spieler, dazu einmal die aktuelle
     * Monatstabelle mit Trendangabe (Rangvergleich zum letzten Tagesreport, siehe dailySnapshots).
     * @private
     */
    async sendeTagesReport() {
        // 1. Verbesserungen je Spieler zaehlen (statt jede einzeln aufzulisten)
        const proSpieler = new Map();
        for (const v of this.tagesVerbesserungen) {
            const bisher = proSpieler.get(v.login);
            if (bisher) bisher.anzahl++;
            else proSpieler.set(v.login, { name: v.name, anzahl: 1 });
        }
        const verbesserungenListe = [...proSpieler.values()].sort((a, b) => b.anzahl - a.anzahl);

        let msg = `🌙 <b>Tagesreport</b>\n\n`;
        msg += `${this.tagesVerbesserungen.length} Verbesserung(en) von ${verbesserungenListe.length} Spieler(n) in den letzten 24 Stunden:\n\n`;
        for (const v of verbesserungenListe) {
            msg += `${this.escapeHtml(stripFormatting(v.name))} — ${v.anzahl} Verbesserung(en)\n`;
        }

        // 2. Aktuelle Monatstabelle mit Trend (Rangvergleich zum Snapshot vom letzten Tagesreport)
        const namen = await this.spielerNamenIndex();
        const records = await this.nextcontrol.mongoDb.collection('records').find({}).toArray();
        const ranking = berechneRanking(records, namen);
        let monatstabelle = [];

        if (ranking.length) {
            const vorherigeSnapshot = await this.nextcontrol.mongoDb.collection('dailySnapshots').findOne({ _id: 'aktuell' });
            const vorherigePosition = vorherigeSnapshot
                ? new Map(vorherigeSnapshot.rangliste.map((s, i) => [s.login, i + 1]))
                : null;

            monatstabelle = ranking.map((s, i) => {
                const neuePos = i + 1;
                const altePos = vorherigePosition?.get(s.login);
                const trend = !altePos ? '🆕' : altePos > neuePos ? '📈' : altePos < neuePos ? '📉' : '➡️';
                return { name: s.name, punkte: s.punkte, position: neuePos, trend };
            });

            msg += `\n📅 <b>Monatstabelle ${monatsKennung(new Date())}</b>\n\n`;
            monatstabelle.slice(0, 15).forEach((s) => {
                const medaille = s.position === 1 ? '🥇' : s.position === 2 ? '🥈' : s.position === 3 ? '🥉' : `${s.position}.`;
                msg += `${medaille} ${s.trend} ${this.escapeHtml(stripFormatting(s.name))} — ${s.punkte.toLocaleString('de-DE')} Punkte\n`;
            });

            await this.nextcontrol.mongoDb.collection('dailySnapshots').replaceOne(
                { _id: 'aktuell' },
                { _id: 'aktuell', takenAt: new Date(), rangliste: ranking.map((s) => ({ login: s.login, name: s.name, punkte: s.punkte })) },
                { upsert: true }
            );
        }

        this.sendMessage(msg);

        // Tagesreport zusaetzlich persistieren, damit die Analyseseite ihn anzeigen kann
        // (identisch zur Telegram-Ansicht: Verbesserungen je Spieler + Monatstabelle mit Trend).
        // Rein additiv -- ein Fehler hier darf den bereits verschickten Telegram-Bericht nicht als
        // Fehlschlag erscheinen lassen, daher eigenes try/catch.
        try {
            await this.nextcontrol.mongoDb.collection('tagesberichte').insertOne({
                datum: new Date().toISOString().slice(0, 10),
                erstelltAm: new Date(),
                anzahlSpieler: verbesserungenListe.length,
                anzahlVerbesserungen: this.tagesVerbesserungen.length,
                verbesserungen: verbesserungenListe.map((v) => ({ name: v.name, anzahl: v.anzahl })),
                monatstabelle: monatstabelle.slice(0, 15).map((s) => ({
                    name: s.name, punkte: s.punkte, position: s.position, trend: s.trend,
                })),
            });
        } catch (error) {
            logger('er', `Telegram: Tagesreport konnte nicht persistiert werden: ${error.message}`);
        }
    }

    /**
     * Sendet den sonntäglichen Wochenrückblick: größte Sprünge + engste Duelle.
     * @private
     */
    async sendeWochenRueckblick() {
        const namen = await this.spielerNamenIndex();
        const records = await this.nextcontrol.mongoDb.collection('records').find({}).toArray();
        const ranking = berechneRanking(records, namen);

        const vorherigeSnapshot = await this.nextcontrol.mongoDb.collection('weeklySnapshots').findOne({ _id: 'aktuell' });

        let msg = `📆 <b>Wochenrückblick</b>\n\n`;

        // Größte Sprünge (Punktezuwachs seit letzter Woche)
        if (vorherigeSnapshot) {
            const vorherPunkte = new Map(vorherigeSnapshot.rangliste.map((s) => [s.login, s.punkte]));
            const sprünge = ranking
                .map((s) => ({ name: s.name, delta: s.punkte - (vorherPunkte.get(s.login) ?? 0) }))
                .filter((s) => s.delta > 0)
                .sort((a, b) => b.delta - a.delta)
                .slice(0, 3);

            if (sprünge.length) {
                msg += `🚀 <b>Größte Sprünge diese Woche:</b>\n`;
                sprünge.forEach((s) => { msg += `${this.escapeHtml(stripFormatting(s.name))}: +${s.delta.toLocaleString('de-DE')} Punkte\n`; });
                msg += `\n`;
            }
        }

        // Engste Duelle (kleinster Punkteabstand zwischen benachbarten Rängen)
        const duelle = [];
        for (let i = 0; i < ranking.length - 1; i++) {
            duelle.push({ a: ranking[i], b: ranking[i + 1], abstand: ranking[i].punkte - ranking[i + 1].punkte });
        }
        duelle.sort((x, y) => x.abstand - y.abstand);
        if (duelle.length) {
            msg += `⚔️ <b>Engste Duelle:</b>\n`;
            duelle.slice(0, 3).forEach((d) => {
                msg += `${this.escapeHtml(stripFormatting(d.a.name))} vs ${this.escapeHtml(stripFormatting(d.b.name))}: ${d.abstand.toLocaleString('de-DE')} Punkte\n`;
            });
        }

        this.sendMessage(msg);

        await this.nextcontrol.mongoDb.collection('weeklySnapshots').replaceOne(
            { _id: 'aktuell' },
            { _id: 'aktuell', takenAt: new Date(), rangliste: ranking.map((s) => ({ login: s.login, name: s.name, punkte: s.punkte })) },
            { upsert: true }
        );
    }

    /**
     * Startet die Map-Abstimmung für den nächsten Monat (Telegram-Poll mit
     * bisher nie gespielten Maps aus dem gesamten Maps-Ordner -- neu
     * hinzugefügte Maps werden automatisch als Kandidaten erkannt, egal in
     * welchem Unterordner sie liegen, siehe listeAlleMapDateien()).
     * @private
     */
    async starteMapAbstimmung() {
        const gespielteDateien = new Set();
        for (const doc of await this.nextcontrol.mongoDb.collection('maps').find({}).toArray()) {
            if (doc.file) gespielteDateien.add(normalisierePfad(doc.file));
        }
        for (const doc of await this.nextcontrol.mongoDb.collection('archivMaps').find({}).toArray()) {
            if (doc.file) gespielteDateien.add(normalisierePfad(doc.file));
        }
        // Karten der AKTUELL laufenden Monats-Rotation ebenfalls ausschliessen -- auch wenn
        // sie dieses Monat noch nicht dran waren (dann fehlen sie noch in "maps"). Sonst
        // landet z.B. eine Karte, die erst in den letzten Tagen des Monats gefahren wird,
        // faelschlich wieder in der Abstimmung fuer den naechsten Monat. GetMapList spiegelt
        // exakt die aktuell geladene Playlist wider, keine Monats-Heuristik noetig.
        try {
            const aktuelleRotation = await this.nextcontrol.client.query('GetMapList', [-1, 0]);
            for (const m of aktuelleRotation) {
                if (m.FileName) gespielteDateien.add(normalisierePfad(m.FileName));
            }
        } catch (error) {
            logger('er', `Telegram: GetMapList fuer Abstimmungs-Ausschluss fehlgeschlagen: ${error.message}`);
        }

        const alleKandidaten = listeAlleMapDateien();
        const nieGespielt = alleKandidaten.filter((f) => !gespielteDateien.has(normalisierePfad(f)));

        if (nieGespielt.length < 2) {
            logger('er', 'Telegram: Zu wenige nie gespielte Maps für eine Abstimmung gefunden.');
            return;
        }

        const { kandidaten, metaByDatei } = await this.waehleKandidatenNachAehnlichkeit(nieGespielt);

        this.abstimmungKandidaten = kandidaten;
        this.abstimmungAntworten = new Map();

        // Kompakte Beschreibung je Strecke fuers Poll-Options-Feld (Telegram-Limit 100
        // Zeichen je Option) -- Betreiber-Wunsch: das Voting ist NUR NOCH der Poll selbst,
        // keine separate Vorschau-Nachricht mehr davor. erzeugeKompakteBeschreibung() laesst
        // Ersteller/Awards/Upload-Datum bewusst weg, um Platz fuer das Wesentliche zu lassen.
        const kurzBeschreibung = (f) => {
            const meta = metaByDatei.get(f);
            const name = (meta?.name || f.split('\\').pop().replace(/\.Map\.Gbx$/i, '')).trim();
            const text = meta ? `${name} — ${erzeugeKompakteBeschreibung(meta)}` : name;
            return text.length > 100 ? text.slice(0, 97) + '…' : text;
        };

        // Kandidaten-Details fuer den in Mongo persistierten Status (Website: voting.html
        // liest ausschliesslich aus der DB, nie direkt vom Controller) -- hier weiterhin die
        // ausfuehrliche Beschreibung, da die Website kein Zeichenlimit hat.
        this.abstimmungKandidatenDetails = kandidaten.map((f) => {
            const meta = metaByDatei.get(f);
            return {
                name: meta?.name || f.split('\\').pop().replace(/\.Map\.Gbx$/i, ''),
                beschreibung: meta ? erzeugeAusfuehrlicheBeschreibung(meta) : null,
                aehnlich: meta ? meta.punkte > 0 : false,
            };
        });

        const optionen = kandidaten.map(kurzBeschreibung);
        const poll = await this.sendePoll(
            `🗳️ Welche Strecken sollen nächsten Monat gefahren werden? (bis zu 6 auswählen)`,
            optionen
        );

        if (poll?.poll?.id) {
            this.abstimmungPollId = poll.poll.id;
            this.abstimmungPollMessageId = poll.message_id;
            this.abstimmungAktiv = true;

            const jetzt = new Date();
            this.abstimmungZielMonat = monatsKennung(new Date(jetzt.getFullYear(), jetzt.getMonth() + 1, 1));
            this.abstimmungGestartetAm = jetzt.toISOString();
            const letzterTagDesMonats = new Date(jetzt.getFullYear(), jetzt.getMonth() + 1, 0).getDate();
            this.abstimmungGeplantesEnde = new Date(jetzt.getFullYear(), jetzt.getMonth(), letzterTagDesMonats - 1).toISOString();

            await this.speichereAbstimmungStatus();
            await protokolliere(this.nextcontrol, 'voting', `🗳️ Monatsabstimmung für ${this.abstimmungZielMonat} gestartet (${kandidaten.length} Kandidaten)`);
            logger('ok', `Telegram: Map-Abstimmung gestartet (${kandidaten.length} Kandidaten).`);
        }
    }

    /**
     * Ermittelt aus den nie gespielten Kandidaten-Dateien die bis zu 10 Optionen fuers
     * Telegram-Voting - nach Aehnlichkeit zum Karma-Geschmacksprofil sortiert.
     * Faellt auf eine zufaellige Auswahl zurueck, wenn (noch) kein Profil ermittelbar ist
     * oder GetMapInfo fuer keinen Kandidaten Metadaten liefern konnte.
     * @param {String[]} nieGespielt Dateipfade aller nie gespielten Kandidaten
     * @returns {Promise<{kandidaten: String[], metaByDatei: Map<String, Classes.Map>}>}
     * @private
     */
    async waehleKandidatenNachAehnlichkeit(nieGespielt) {
        // 1. Karma-Aggregation + Map-Metadaten (maps ∪ archivMaps) fuers Geschmacksprofil
        const karmaAggregation = await this.nextcontrol.mongoDb.collection('karma').aggregate([
            { $group: { _id: '$map', schnitt: { $avg: '$score' }, stimmen: { $sum: 1 } } }
        ]).toArray();

        const mapMetaByUid = new Map();
        for (const doc of await this.nextcontrol.mongoDb.collection('maps').find({}).toArray()) {
            mapMetaByUid.set(doc.uid, doc);
        }
        for (const doc of await this.nextcontrol.mongoDb.collection('archivMaps').find({}).toArray()) {
            if (!mapMetaByUid.has(doc.uid)) mapMetaByUid.set(doc.uid, doc);
        }

        // 2. Metadaten je Kandidat: zuerst aus dem vorab erzeugten Cache
        // (scripts/erzeuge-map-beschreibungen.js -> Collection mapBeschreibungen),
        // nur fehlende Kandidaten live per GetMapInfo nachladen (funktioniert laut
        // admin.js auch fuer Maps, die noch nie geladen wurden - kein GBX-Parser noetig).
        const cacheDocs = await this.nextcontrol.mongoDb.collection('mapBeschreibungen').find({
            file: { $in: nieGespielt.map(normalisierePfad) }
        }).toArray();
        const cacheByDatei = new Map(cacheDocs.map((d) => [d.file, d]));

        const metaByDatei = new Map();
        for (const datei of nieGespielt) {
            const cache = cacheByDatei.get(normalisierePfad(datei));
            if (cache) {
                metaByDatei.set(datei, cache);
                continue;
            }
            try {
                const struct = await this.nextcontrol.client.query('GetMapInfo', [datei]);
                const meta = new Classes.Map(struct);
                meta.authorNickname = struct.AuthorNickname;
                metaByDatei.set(datei, meta);
            } catch (error) {
                logger('er', `Telegram: GetMapInfo fehlgeschlagen für ${datei}: ${error.message}`);
            }
        }

        // 2b. TMX-Daten (Tags/Schwierigkeit/Laenge) fuer beliebte + Kandidaten-Maps laden
        // (gecacht in tmxMapInfo, gleicher Cache wie website/api.php) -- fliesst zusaetzlich
        // zu Autor/Environment/Mood ins Geschmacksprofil ein. Awards fliessen bewusst NICHT
        // ein (Betreiber-Entscheidung: das waere die Meinung der gesamten TMX-Community,
        // nicht der eigenen Gruppe).
        const beliebteUids = ermittleBeliebteMapUids(karmaAggregation, mapMetaByUid);
        const kandidatenUids = [...metaByDatei.values()].map((m) => m.uid).filter(Boolean);
        const tmxDatenByUid = await holeTmxDatenFuerUids(this.nextcontrol.mongoDb, [...new Set([...beliebteUids, ...kandidatenUids])]);

        const profil = berechneGeschmacksprofil(karmaAggregation, mapMetaByUid, { tmxDatenByUid });

        // 3. Aehnlichkeits-Punktzahl einmalig je Kandidat berechnen und am Meta-Objekt
        // ablegen (wird von starteMapAbstimmung() fuer Vorschau-Text + persistierten
        // Status wiederverwendet, statt hier und dort erneut zu berechnen).
        for (const meta of metaByDatei.values()) {
            meta.tmxDaten = tmxDatenByUid.get(meta.uid) ?? null;
            meta.punkte = bewerteKandidat(meta, profil, meta.tmxDaten);
        }

        // 4. Bewerten + sortieren (Zufalls-Tiebreaker), Top 10 (Telegram-Poll-Limit)
        const bewertet = nieGespielt
            .filter((f) => metaByDatei.has(f))
            .map((f) => ({ f, punkte: metaByDatei.get(f).punkte, zufall: Math.random() }));

        const alleOhnePunkte = profil === null || bewertet.every((k) => k.punkte === 0);

        if (alleOhnePunkte) {
            // Fallback: unveraendertes Zufallsverfahren (kein Profil oder keine Uebereinstimmung)
            const kandidaten = nieGespielt
                .map((f) => ({ f, sort: Math.random() }))
                .sort((a, b) => a.sort - b.sort)
                .slice(0, 10)
                .map((x) => x.f);
            return { kandidaten, metaByDatei };
        }

        const kandidaten = bewertet
            .sort((a, b) => (b.punkte - a.punkte) || (b.zufall - a.zufall))
            .slice(0, 10)
            .map((x) => x.f);

        return { kandidaten, metaByDatei };
    }

    /**
     * Schließt die Map-Abstimmung, ermittelt die 6 Gewinner-Maps und schreibt
     * scripts/naechster-monat.json für monatswechsel.js.
     * @private
     */
    async schliesseMapAbstimmung() {
        this.abstimmungAktiv = false;
        if (this.abstimmungPollId) await this.stoppePoll();

        const stimmenProOption = this.berechneStimmenProOption();

        const rangfolge = this.abstimmungKandidaten
            .map((datei, idx) => ({ datei, stimmen: stimmenProOption[idx] }))
            .sort((a, b) => b.stimmen - a.stimmen);

        const gewinner = rangfolge.slice(0, 6).map((r) => r.datei);
        const naechsterMonat = this.abstimmungZielMonat
            ?? monatsKennung(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1));

        writeFileSync(NAECHSTER_MONAT_PFAD, JSON.stringify({ monat: naechsterMonat, maps: gewinner }, null, 2), 'utf8');

        const gewinnerNamen = gewinner.map((g) => g.split('\\').pop().replace(/\.Map\.Gbx$/i, ''));
        let msg = `🏁 <b>Abstimmung beendet!</b>\n\nStrecken für ${naechsterMonat}:\n`;
        gewinnerNamen.forEach((g) => { msg += `- ${g}\n`; });
        this.sendMessage(msg);

        await this.speichereAbstimmungStatus(gewinnerNamen);
        await protokolliere(this.nextcontrol, 'voting', `🏆 Abstimmung beendet, Sieger für ${naechsterMonat}: ${gewinnerNamen.join(', ')}`);

        logger('ok', `Telegram: Map-Abstimmung ausgewertet, ${NAECHSTER_MONAT_PFAD} geschrieben.`);
    }

    /** Aktuelle Stimmenzahl je Kandidat (Index = abstimmungKandidaten-Index). @private */
    berechneStimmenProOption() {
        const stimmenProOption = new Array(this.abstimmungKandidaten.length).fill(0);
        for (const optionIds of this.abstimmungAntworten.values()) {
            for (const idx of optionIds) stimmenProOption[idx]++;
        }
        return stimmenProOption;
    }

    /**
     * Persistiert den aktuellen Abstimmungsstatus in Mongo (Collection abstimmungStatus,
     * Singleton-Dokument _id="aktuell"), damit die Website (voting.html) ihn anzeigen
     * kann -- die Website spricht nie direkt mit dem Controller, nur mit der DB.
     * @param {String[]|null} gewinnerNamen Nur beim Abschluss gesetzt (Namen der 6 Gewinner-Strecken)
     * @private
     */
    async speichereAbstimmungStatus(gewinnerNamen = null) {
        const stimmenProOption = this.berechneStimmenProOption();
        const kandidaten = this.abstimmungKandidatenDetails.map((k, i) => ({ ...k, stimmen: stimmenProOption[i] ?? 0 }));

        await this.nextcontrol.mongoDb.collection('abstimmungStatus').replaceOne(
            { _id: 'aktuell' },
            {
                _id: 'aktuell',
                monat: this.abstimmungZielMonat,
                aktiv: this.abstimmungAktiv,
                gestartetAm: this.abstimmungGestartetAm,
                geplantesEnde: this.abstimmungGeplantesEnde,
                kandidaten,
                gewinner: gewinnerNamen,
                abgeschlossenAm: this.abstimmungAktiv ? null : new Date().toISOString(),
                // Zusaetzlich zu den reinen Anzeigedaten oben: alles, was fuer einen
                // vollstaendigen Neustart-Restore noetig ist (siehe stelleAbstimmungWiederHer()).
                pollId: this.abstimmungPollId,
                pollMessageId: this.abstimmungPollMessageId,
                gestartetFuerMonat: this.abstimmungGestartetFuerMonat,
                kandidatenDateien: this.abstimmungKandidaten,
            },
            { upsert: true }
        );
    }

    /**
     * Stellt eine beim letzten Neustart noch aktive Abstimmung aus Mongo wieder her, damit ein
     * Controller-Neustart waehrend einer laufenden Monatsabstimmung keine zweite, parallele
     * Abstimmung ausloest (die abstimmung*-Felder sind reine In-Memory-Klassenfelder, siehe
     * Deklarationen oben). Wird einmalig beim Boot aufgerufen, bevor der 60s-Tick in
     * pruefeZeitgesteuerteAufgaben() ueberhaupt starten darf (siehe dortiger Guard).
     * @private
     */
    async stelleAbstimmungWiederHer() {
        try {
            const status = await this.nextcontrol.mongoDb.collection('abstimmungStatus').findOne({ _id: 'aktuell' });
            if (status?.aktiv) {
                this.abstimmungAktiv = true;
                this.abstimmungPollId = status.pollId ?? null;
                this.abstimmungPollMessageId = status.pollMessageId ?? null;
                this.abstimmungZielMonat = status.monat ?? null;
                this.abstimmungGestartetAm = status.gestartetAm ?? null;
                this.abstimmungGeplantesEnde = status.geplantesEnde ?? null;
                this.abstimmungGestartetFuerMonat = status.gestartetFuerMonat ?? null;
                this.abstimmungKandidaten = status.kandidatenDateien ?? [];
                this.abstimmungKandidatenDetails = (status.kandidaten ?? []).map(({ stimmen, ...rest }) => rest);
                logger('ok', `Telegram: aktive Map-Abstimmung fuer ${this.abstimmungZielMonat} wiederhergestellt (${this.abstimmungKandidaten.length} Kandidaten) -- kein neuer Poll wird gestartet.`);
            }
        } catch (error) {
            logger('er', `Telegram: Wiederherstellung der Abstimmung fehlgeschlagen: ${error.message}`);
        } finally {
            this.abstimmungWiederherstellungAbgeschlossen = true;
        }
    }

    /**
     * Sendet einen Telegram-Poll (Mehrfachauswahl) und gibt die Antwort der API zurück.
     * @param {String} frage
     * @param {String[]} optionen
     * @returns {Promise<Object|null>}
     * @private
     */
    sendePoll(frage, optionen) {
        if (this.dryRun) {
            logger('r', `Telegram (Trockenlauf) Poll: ${frage} [${optionen.join(', ')}]`);
            return Promise.resolve({ poll: { id: `trockenlauf-${Date.now()}` } });
        }
        const postData = querystring.stringify({
            chat_id: this.chatId,
            question: frage,
            options: JSON.stringify(optionen),
            allows_multiple_answers: true,
            is_anonymous: false,
        });
        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'api.telegram.org', port: 443, path: `/bot${this.telegramToken}/sendPoll`, method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
            }, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data).result); } catch { resolve(null); } });
            });
            req.setTimeout(15000, () => req.destroy(new Error('Timeout bei sendPoll')));
            req.on('error', () => resolve(null));
            req.write(postData);
            req.end();
        });
    }

    /** Schließt den laufenden Poll über die Telegram-API. @private */
    stoppePoll() {
        if (this.dryRun) return Promise.resolve();
        const postData = querystring.stringify({ chat_id: this.chatId, message_id: this.abstimmungPollMessageId });
        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'api.telegram.org', port: 443, path: `/bot${this.telegramToken}/stopPoll`, method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
            }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
            req.setTimeout(15000, () => req.destroy(new Error('Timeout bei stopPoll')));
            req.on('error', () => resolve());
            req.write(postData);
            req.end();
        });
    }

    // Alle anderen Event-Handler bleiben leer - keine Session-Events
    async onPlayerConnect(player, isSpectator) {}
    async onPlayerDisconnect(player, reason) {}
    async onBeginMatch() {}
    async onBillUpdate(params) {}
    async onEndMatch(params) {}
    async onMaplistChange(params) {}
    async onModeScriptCallback(params) {}
    async onPlayersAlliesChange(login) {}
    async onPlayerInfoChange(params) {}
    /**
     * Function run, when a player clicks a Telegram-Menue-Knopf oder ein Eingabeformular
     * absendet (Muster wie karma.js -- Aktion parsen, eigenen Praefix pruefen, sonst ignorieren).
     * @param {CallbackParams.ManialinkPageAnswer} params
     */
    async onManialinkPageAnswer(params) {
        const { namespace, teile } = dekodiereAktion(params.answer);
        if (namespace !== AKTION_PRAEFIX) return;

        const login = params.login;

        if (teile[0] === 'status') {
            await this.commandTelegram(login, []);
            await schliesseMenue(this.nextcontrol, login);

        } else if (teile[0] === 'link_form') {
            const xml = baueEingabeXml({
                titel: 'Mit Telegram verknüpfen',
                hinweistext: 'Code aus /link (Telegram-Gruppe oder privat an den Bot) hier eingeben:',
                entryName: 'code',
                submitAktion: kodiereAktion(AKTION_PRAEFIX, 'link_submit'),
                zurueckAktion: ZURUECK_AKTION
            });
            await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [login, xml, 0, false]);

        } else if (teile[0] === 'link_submit') {
            const code = params.entries.find(e => e.name === 'code')?.value ?? '';
            await this.commandLink(login, [code]);
            await schliesseMenue(this.nextcontrol, login);

        } else if (teile[0] === 'broadcast_form') {
            if (!pruefeAdmin(this.nextcontrol, login)) return;
            const xml = baueEingabeXml({
                titel: 'Nachricht an Telegram senden',
                hinweistext: 'Wird als Admin-Nachricht an die Telegram-Gruppe gesendet:',
                entryName: 'nachricht',
                submitAktion: kodiereAktion(AKTION_PRAEFIX, 'broadcast_submit'),
                zurueckAktion: ZURUECK_AKTION
            });
            await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [login, xml, 0, false]);

        } else if (teile[0] === 'broadcast_submit') {
            if (!pruefeAdmin(this.nextcontrol, login)) return;
            const nachricht = params.entries.find(e => e.name === 'nachricht')?.value ?? '';
            await this.commandAdminTelegram(login, [nachricht]);
            await schliesseMenue(this.nextcontrol, login);
        }
    }
    async onStatusChange(params) {}
    async onTunnelDataReceived(params) {}
    async onVoteUpdate(params) {}
    async onCheckpoint(params) {}
    async onIncoherence(params) {}
}