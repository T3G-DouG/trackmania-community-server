import { Sentences } from '../lib/sentences.js';
import { logger, format, stripFormatting } from '../lib/utilities.js';
import { protokolliere } from '../lib/eventLog.js';
import { sendeTelegramDm } from '../lib/telegramAlert.js';
import { formuliereChatNachrichtUm, formuliereUm } from '../lib/kiEnrich.js';
import * as Classes from '../lib/classes.js';
import { NextControl } from '../nextcontrol.js';
import { ERRUNGENSCHAFTEN_KATALOG } from '../lib/errungenschaftenKatalog.js';
import { kodiereAktion, dekodiereAktion, schliesseMenue } from '../lib/manialinkMenu.js';

const AKTION_PRAEFIX = 'errungenschaften';
import {
    schwellen,
    istNachtstunde,
    istLetzterTagDesMonats,
    ermittleSieger,
    ermittlePodest,
    pruefeHattrick,
    ermittleDurchmarschSieger,
    pruefeStatsSchwellen,
    pruefeKarmaSchwelle,
    ermittleFuehrendeProMap,
    pruefeFuehrungswechsel,
    pruefeSofortigeRevanche,
    ermittleVierJahreszeiten,
    ermittleJahresfahrer,
    ermittleDauerbrenner,
    ermittleEwigerZweiter,
    pruefeFairerWertrichter,
    pruefeRueckkehr,
    istErstbesuch,
    pruefeWillkommenskomitee,
    DAUERBRENNER_MINDEST_STREAK,
    EWIGER_ZWEITER_MINDEST_ANZAHL,
} from '../lib/errungenschaftenLogik.js';

const TICK_INTERVALL_MS = 60000;

/**
 * Errungenschaften-Plugin: vergibt Abzeichen fuer Monats-/Jahressiege, Streckendominanz,
 * Lifetime-Meilensteine und ein paar geheime Extras. Die eigentliche Erkennungslogik lebt
 * bewusst in errungenschaftenLogik.js (reine Funktionen, testbar ohne Mongo/Server) --
 * dieses Plugin ist nur der duenne I/O-Wrapper drumherum (DB lesen/schreiben, Chat, Log).
 *
 * ERRUNGENSCHAFTEN_TEST=true verkuerzt alle Grind-Schwellen fuer Tests am Trainingsserver
 * drastisch (siehe errungenschaftenLogik.js: schwellen()) -- NIE in Produktion setzen.
 */
export class ErrungenschaftenPlugin {
    name = 'Errungenschaften'
    author = 'system'
    description = 'Vergibt Abzeichen fuer Monats-/Jahressiege, Streckendominanz und Meilensteine, sichtbar auf der Profilseite und im Gaming-Log.'

    /** @type {NextControl} */
    nextcontrol

    /** @type {Map<string, number>} login -> Date.now() beim Connect */
    joinTimes

    /** @type {Date|null} Zeitpunkt, seit dem nur noch ein Spieler online ist (fuer "Einsamer Wolf") */
    alleinSeit = null

    /** @type {Map<string,{login:string,time:number,gapMs:number|null}>} Letzter bekannter Fuehrender je Map-UID */
    fuehrendeSnapshot

    /** @type {Map<string,{vorherigerFuehrender:string, verlorenAmMs:number}>} Letzter bekannter Fuehrungsverlust je Map-UID (fuer "Sofortige Revanche") */
    verlustHistorie = new Map()

    /** True bis zum Abschluss des ersten Durchlaufs -- unterdrueckt Chat/Log-Ankuendigungen fuer rueckwirkend vergebene Abzeichen */
    erstlaufAktiv = true

    /**
     * @param {NextControl} nextcontrol
     */
    constructor(nextcontrol) {
        this.nextcontrol = nextcontrol;
        this.testModus = process.env.ERRUNGENSCHAFTEN_TEST === 'true';
        this.schwellenWerte = schwellen(this.testModus);
        this.joinTimes = new Map();
        this.fuehrendeSnapshot = new Map();

        nextcontrol.addRequiredCollection('errungenschaften');
        nextcontrol.addRequiredCollection('errungenschaftenKatalog');
        nextcontrol.addRequiredCollection('errungenschaftenStatus');
        nextcontrol.addRequiredCollection('errungenschaftenZaehler');

        nextcontrol.registerChatCommand(new Classes.ChatCommand(
            'abzeichen',
            this.chat_abzeichen,
            'Zeigt deine freigeschalteten Errungenschaften-Abzeichen an.',
            this.name
        ));

        nextcontrol.registerMenuEintrag(new Classes.MenuEintrag(
            'Allgemein', 'Meine Abzeichen', kodiereAktion(AKTION_PRAEFIX, 'zeigen'), { pluginName: this.name }
        ));

        if (this.testModus) logger('w', 'Errungenschaften: TESTMODUS aktiv (ERRUNGENSCHAFTEN_TEST=true) -- Schwellen stark verkuerzt, NIE in Produktion so lassen!');

        setTimeout(() => {
            this.start().catch((error) => logger('er', `Errungenschaften: Start fehlgeschlagen: ${error.message}`));
        }, 2000);
    }

    /** Katalog-Eintraege in die Collection spiegeln, damit die Website (PHP) sie ohne Duplikation lesen kann. */
    async seedKatalog() {
        for (const eintrag of ERRUNGENSCHAFTEN_KATALOG) {
            await this.nextcontrol.mongoDb.collection('errungenschaftenKatalog').updateOne(
                { id: eintrag.id },
                { $set: eintrag },
                { upsert: true }
            );
        }
    }

    async sicherstelleIndex() {
        await this.nextcontrol.mongoDb.collection('errungenschaften').createIndex({ login: 1, errungenschaft: 1 }, { unique: true });
    }

    /**
     * Vergibt (idempotent) ein Abzeichen. Kuendigt es nur bei tatsaechlich neuer Vergabe an
     * (upsertedCount === 1) und nur ausserhalb des stillen Erstlaufs.
     * @param {string} login
     * @param {string} errungenschaftId
     * @param {{erreichtAm?: Date}} [extra]
     */
    async vergeben(login, errungenschaftId, extra = {}) {
        try {
            const erreichtAm = extra.erreichtAm ?? new Date();
            const ergebnis = await this.nextcontrol.mongoDb.collection('errungenschaften').updateOne(
                { login, errungenschaft: errungenschaftId },
                { $setOnInsert: { login, errungenschaft: errungenschaftId, erreichtAm } },
                { upsert: true }
            );
            if (ergebnis.upsertedCount === 1 && !this.erstlaufAktiv) {
                await this.verkuende(login, errungenschaftId);
            }
        } catch (error) {
            logger('er', `Errungenschaften: Vergabe von "${errungenschaftId}" an ${login} fehlgeschlagen: ${error.message}`);
        }
    }

    /** Anzeigename ueber Online-Status, sonst Fallback auf die players-Collection (Spieler kann offline sein, z.B. bei Monatsauswertung). */
    async ermittleAnzeigename(login) {
        const online = this.nextcontrol.status?.getPlayer(login);
        if (online?.name) return stripFormatting(online.name);
        const doc = await this.nextcontrol.mongoDb.collection('players').findOne({ login });
        return doc?.name ? stripFormatting(doc.name) : login;
    }

    async verkuende(login, errungenschaftId) {
        const eintrag = ERRUNGENSCHAFTEN_KATALOG.find((e) => e.id === errungenschaftId);
        if (!eintrag) return;
        const name = await this.ermittleAnzeigename(login);
        const pruefWoerter = [name, eintrag.name];

        const msg = await formuliereChatNachrichtUm(
            format(Sentences.errungenschaften.freigeschaltet, { player: name, icon: eintrag.icon, badge: eintrag.name }),
            { pruefWoerter }
        );
        await this.nextcontrol.client.query('ChatSendServerMessage', [msg]).catch(() => {});

        const logText = await formuliereUm(`🏅 ${name} hat das Abzeichen »${eintrag.icon} ${eintrag.name}« freigeschaltet!`, { pruefWoerter: [...pruefWoerter, '🏅'] });
        await protokolliere(this.nextcontrol, 'errungenschaft', logText);

        // Private Telegram-DM an den verknuepften Nutzer -- wichtig fuer Vergaben,
        // waehrend der Spieler offline ist (z.B. Monatsmeister beim Monatswechsel).
        // Opt-out via /abo errungenschaften aus (abos-Feld in telegramLinks).
        try {
            const link = await this.nextcontrol.mongoDb.collection('telegramLinks').findOne({
                login,
                telegramUserId: { $ne: null },
            });
            if (link && link.abos?.errungenschaften !== false) {
                // Nur der freie Ansage-Satz wird umformuliert -- die Katalog-Beschreibung
                // dahinter ist bereits redaktionell verfasst und wiederholt sich nicht.
                const dmKern = await formuliereUm(`Abzeichen freigeschaltet: ${eintrag.icon} ${eintrag.name}`, { pruefWoerter: [eintrag.name] });
                await sendeTelegramDm(link.telegramUserId,
                    `🏅 <b>${dmKern}</b>\n${eintrag.beschreibung}`);
            }
        } catch (error) {
            logger('er', `Errungenschaften: Telegram-DM an ${login} fehlgeschlagen: ${error.message}`);
        }
    }

    /** Lifetime-Meilensteine (playerStats) + Streckenkritiker (karma), fuer ALLE Spieler geprueft, nicht nur online. */
    async pruefeStatsUndKarma(jetzt) {
        const alleStats = await this.nextcontrol.mongoDb.collection('playerStats').find({}).toArray();
        for (const stats of alleStats) {
            const laufendeSession = this.joinTimes.has(stats.login)
                ? (jetzt.getTime() - this.joinTimes.get(stats.login)) / 60000
                : 0;
            for (const id of pruefeStatsSchwellen(stats, laufendeSession, this.schwellenWerte)) {
                await this.vergeben(stats.login, id);
            }
        }

        const karmaProLogin = await this.nextcontrol.mongoDb.collection('karma').aggregate([
            { $group: { _id: '$login', anzahl: { $sum: 1 } } },
        ]).toArray();
        for (const { _id: login, anzahl } of karmaProLogin) {
            if (pruefeKarmaSchwelle(anzahl, this.schwellenWerte)) await this.vergeben(login, 'streckenkritiker');
        }
    }

    /** Platzhirsch / Wimpernschlag / Last-Minute-Held / Sofortige Revanche ueber einen Fuehrende-Snapshot-Vergleich (vermeidet Race mit localRecords.js). */
    async pruefeFuehrende(jetzt) {
        const records = await this.nextcontrol.mongoDb.collection('records').find({}).toArray();
        const neuSnapshot = ermittleFuehrendeProMap(records);
        // Waehrend des Erstlaufs nie "letzter Tag des Monats" werten -- sonst wuerden bereits
        // bestehende Bestzeiten faelschlich als "in letzter Minute aufgestellt" gewertet.
        const istLetzterTag = this.erstlaufAktiv ? false : istLetzterTagDesMonats(jetzt, this.testModus);
        const ereignisse = pruefeFuehrungswechsel(this.fuehrendeSnapshot, neuSnapshot, this.schwellenWerte, { istLetzterTag });
        for (const { login, errungenschaft } of ereignisse) await this.vergeben(login, errungenschaft);

        // Sofortige Revanche baut auf derselben Snapshot-Differenz auf, braucht aber eine eigene
        // kleine Verlust-Historie je Map -- waehrend des Erstlaufs nie werten (sonst wuerde der
        // allererste Snapshot-Aufbau als Kaskade von Fuehrungswechseln + Revanchen misinterpretiert).
        if (!this.erstlaufAktiv) {
            const { ereignisse: revancheEreignisse, neueHistorie } = pruefeSofortigeRevanche(
                this.fuehrendeSnapshot, neuSnapshot, this.verlustHistorie, jetzt.getTime(), this.schwellenWerte
            );
            for (const { login, errungenschaft } of revancheEreignisse) await this.vergeben(login, errungenschaft);
            this.verlustHistorie = neueHistorie;
        }

        this.fuehrendeSnapshot = neuSnapshot;
    }

    /** Vier Jahreszeiten / Jahresfahrer / Dauerbrenner / Ewiger Zweiter -- Monatshistorie (monthlyRankings) fuer ALLE Spieler geprueft. */
    async pruefeMonatshistorie() {
        const alleMonate = await this.nextcontrol.mongoDb.collection('monthlyRankings').find({}).sort({ monat: 1 }).toArray();
        if (!alleMonate.length) return;

        for (const login of ermittleVierJahreszeiten(alleMonate)) await this.vergeben(login, 'vierjahreszeiten');
        for (const login of ermittleJahresfahrer(alleMonate)) await this.vergeben(login, 'jahresfahrer');
        for (const login of ermittleDauerbrenner(alleMonate, DAUERBRENNER_MINDEST_STREAK)) await this.vergeben(login, 'dauerbrenner');
        for (const login of ermittleEwigerZweiter(alleMonate, EWIGER_ZWEITER_MINDEST_ANZAHL)) await this.vergeben(login, 'ewigerzweiter');
    }

    /** Fairer Wertrichter: alle aktuell im Pool befindlichen Strecken per /karma bewertet. */
    async pruefeFairerWertrichterAlle() {
        const poolMaps = await this.nextcontrol.mongoDb.collection('maps').find({}, { projection: { uid: 1 } }).toArray();
        const poolUids = new Set(poolMaps.map((m) => m.uid));
        if (!poolUids.size) return;

        const karmaProLogin = await this.nextcontrol.mongoDb.collection('karma').aggregate([
            { $group: { _id: '$login', maps: { $addToSet: '$map' } } },
        ]).toArray();
        for (const { _id: login, maps } of karmaProLogin) {
            if (pruefeFairerWertrichter(new Set(maps), poolUids)) await this.vergeben(login, 'fairerwertrichter');
        }
    }

    /** Neu eingefrorene Monate/Jahre verarbeiten (monatsmeister/hattrick/podestfahrer/durchmarsch/jahresmeister). */
    async verarbeiteMonateUndJahre() {
        const bestehenderStatus = await this.nextcontrol.mongoDb.collection('errungenschaftenStatus').findOne({ _id: 'status' });
        const statusDoc = bestehenderStatus ?? { verarbeiteteMonate: [], verarbeiteteJahre: [] };

        const alleMonate = await this.nextcontrol.mongoDb.collection('monthlyRankings').find({}).sort({ monat: 1 }).toArray();
        const siegerProMonat = new Map(alleMonate.map((m) => [m.monat, ermittleSieger(m.eintraege)]));
        const neueMonate = alleMonate.filter((m) => !statusDoc.verarbeiteteMonate.includes(m.monat));

        for (const m of neueMonate) {
            const sieger = siegerProMonat.get(m.monat);
            if (sieger) {
                await this.vergeben(sieger, 'monatsmeister', { erreichtAm: m.frozenAt });
                const hattrickSieger = pruefeHattrick(m.monat, siegerProMonat);
                if (hattrickSieger) await this.vergeben(hattrickSieger, 'hattrick', { erreichtAm: m.frozenAt });
            }
            for (const login of ermittlePodest(m.eintraege)) {
                await this.vergeben(login, 'podestfahrer', { erreichtAm: m.frozenAt });
            }

            const archivRecords = await this.nextcontrol.mongoDb.collection('archivRecords').find({ monat: m.monat }).toArray();
            const archivMapsAnzahl = await this.nextcontrol.mongoDb.collection('archivMaps').countDocuments({ monat: m.monat });
            const durchmarschSieger = ermittleDurchmarschSieger(archivRecords, archivMapsAnzahl);
            if (durchmarschSieger) await this.vergeben(durchmarschSieger, 'durchmarsch', { erreichtAm: m.frozenAt });

            statusDoc.verarbeiteteMonate.push(m.monat);
        }

        const alleJahre = await this.nextcontrol.mongoDb.collection('yearlyRankings').find({}).toArray();
        const neueJahre = alleJahre.filter((j) => !statusDoc.verarbeiteteJahre.includes(j.jahr));
        for (const j of neueJahre) {
            const sieger = ermittleSieger(j.eintraege);
            if (sieger) await this.vergeben(sieger, 'jahresmeister', { erreichtAm: j.frozenAt });
            statusDoc.verarbeiteteJahre.push(j.jahr);
        }

        if (neueMonate.length || neueJahre.length) {
            await this.nextcontrol.mongoDb.collection('errungenschaftenStatus').updateOne(
                { _id: 'status' },
                { $set: { verarbeiteteMonate: statusDoc.verarbeiteteMonate, verarbeiteteJahre: statusDoc.verarbeiteteJahre } },
                { upsert: true }
            );
        }
    }

    /** Periodischer Tick (60s). Komplett in try/catch: es gibt keinen globalen unhandledRejection-Handler im Controller. */
    async tick() {
        try {
            const jetzt = new Date();

            for (const [login, start] of this.joinTimes) {
                const minuten = (jetzt.getTime() - start) / 60000;
                if (minuten >= this.schwellenWerte.marathonMinuten) await this.vergeben(login, 'marathonfahrer');
                if (minuten >= this.schwellenWerte.kellerkindMinuten) await this.vergeben(login, 'kellerkind');
            }

            const online = this.nextcontrol.status?.players ?? [];
            if (online.length === 1) {
                if (!this.alleinSeit) this.alleinSeit = jetzt;
                const minutenAllein = (jetzt.getTime() - this.alleinSeit.getTime()) / 60000;
                if (minutenAllein >= this.schwellenWerte.alleinMinuten) await this.vergeben(online[0].login, 'einsamerwolf');
            } else {
                this.alleinSeit = null;
            }

            await this.pruefeStatsUndKarma(jetzt);
            await this.pruefeFuehrende(jetzt);
            await this.pruefeMonatshistorie();
            await this.pruefeFairerWertrichterAlle();
            await this.verarbeiteMonateUndJahre();
        } catch (error) {
            logger('er', `Errungenschaften: Fehler im Tick: ${error.message}`);
        }
    }

    async start() {
        await this.seedKatalog();
        await this.sicherstelleIndex();

        const bestehenderStatus = await this.nextcontrol.mongoDb.collection('errungenschaftenStatus').findOne({ _id: 'status' });
        this.erstlaufAktiv = bestehenderStatus === null;
        if (this.erstlaufAktiv) {
            logger('i', 'Errungenschaften: Erstlauf erkannt -- stiller Retro-Scan über Bestandsdaten (keine Chat-/Log-Ankündigungen).');
        } else {
            // KEIN echter Erstlauf, nur ein Prozess-Neustart: den In-Memory-Fuehrende-Snapshot still
            // wiederherstellen, BEVOR der erste Tick laeuft. Ohne das wuerde jeder Controller-Neustart
            // wie ein frischer Fuehrungswechsel aussehen (leerer Snapshot -> Diff gegen alle aktuellen
            // Fuehrenden) und faelschlich Platzhirsch/Wimpernschlag/Last-Minute-Held erneut ausloesen,
            // obwohl sich seit dem letzten Lauf nichts geaendert hat.
            const records = await this.nextcontrol.mongoDb.collection('records').find({}).toArray();
            this.fuehrendeSnapshot = ermittleFuehrendeProMap(records);
        }

        // Konservativ: bereits online befindliche Spieler zaehlen erst ab Controller-Start (Sitzung koennte laenger laufen).
        for (const p of this.nextcontrol.status?.players ?? []) {
            this.joinTimes.set(p.login, Date.now());
        }

        await this.tick();
        this.erstlaufAktiv = false;

        setInterval(() => this.tick(), TICK_INTERVALL_MS);
    }

    /** @param {Classes.WaypointInfo} waypointInfo */
    async onWaypoint(waypointInfo) {
        try {
            if (waypointInfo.isEndRace && istNachtstunde(new Date(), this.testModus)) {
                await this.vergeben(waypointInfo.login, 'nachtschwaermer');
            }
        } catch (error) {
            logger('er', `Errungenschaften: onWaypoint fehlgeschlagen: ${error.message}`);
        }
    }

    /** @param {import('../lib/classes.js').PlayerInfo} player */
    async onPlayerConnect(player, isSpectator) {
        this.joinTimes.set(player.login, Date.now());
        try {
            await this.pruefeRueckkehrBeiConnect(player.login);
            await this.pruefeErstbesuchBeiConnect(player.login);
        } catch (error) {
            logger('er', `Errungenschaften: onPlayerConnect-Pruefung fuer ${player.login} fehlgeschlagen: ${error.message}`);
        }
    }

    /** Rueckkehrer: Luecke zur letzten bekannten Session (spielerSessions) pruefen. */
    async pruefeRueckkehrBeiConnect(login) {
        const letzte = await this.nextcontrol.mongoDb.collection('spielerSessions')
            .find({ login }).sort({ bis: -1 }).limit(1).toArray();
        if (!letzte.length) return; // keine bekannte vorherige Session -- kein Rueckkehrer
        if (pruefeRueckkehr(letzte[0].bis, new Date(), this.schwellenWerte)) {
            await this.vergeben(login, 'rueckkehrer');
        }
    }

    /**
     * Willkommenskomitee: bei einem echten Erstbesuch (players.firstSeen liegt praktisch genau
     * jetzt, siehe join.js) zaehlt fuer jeden ANDEREN gerade online befindlichen Spieler ein
     * kleiner, persistenter Zaehler (Collection errungenschaftenZaehler) hoch; ab der
     * konfigurierten Mindestanzahl wird das Abzeichen vergeben.
     */
    async pruefeErstbesuchBeiConnect(login) {
        const spieler = await this.nextcontrol.mongoDb.collection('players').findOne({ login });
        if (!spieler || !istErstbesuch(spieler.firstSeen, new Date())) return;

        const andereOnline = (this.nextcontrol.status?.players ?? []).filter((p) => p.login !== login);
        for (const p of andereOnline) {
            await this.nextcontrol.mongoDb.collection('errungenschaftenZaehler').updateOne(
                { login: p.login, art: 'willkommenskomitee' },
                { $inc: { anzahl: 1 } },
                { upsert: true }
            );
            const zaehlerDoc = await this.nextcontrol.mongoDb.collection('errungenschaftenZaehler')
                .findOne({ login: p.login, art: 'willkommenskomitee' });
            if (pruefeWillkommenskomitee(zaehlerDoc?.anzahl, this.schwellenWerte)) {
                await this.vergeben(p.login, 'willkommenskomitee');
            }
        }
    }

    /** @param {import('../lib/classes.js').PlayerInfo} player */
    async onPlayerDisconnect(player, reason) {
        this.joinTimes.delete(player.login);
    }

    /**
     * Chat-Befehl /abzeichen: eigene Anzahl + zuletzt freigeschaltete Abzeichen.
     * @param {string} login
     * @param {Array<string>} params
     */
    async chat_abzeichen(login, params) {
        try {
            const eigene = await this.nextcontrol.mongoDb.collection('errungenschaften').find({ login }).sort({ erreichtAm: -1 }).toArray();
            if (!eigene.length) {
                await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [Sentences.errungenschaften.eigeneUebersichtLeer, login]);
                return;
            }
            const letzte = eigene.slice(0, 3).map((e) => {
                const def = ERRUNGENSCHAFTEN_KATALOG.find((k) => k.id === e.errungenschaft);
                return def ? `${def.icon} ${def.name}` : e.errungenschaft;
            }).join(', ');
            const msg = format(Sentences.errungenschaften.eigeneUebersicht, {
                anzahl: eigene.length,
                gesamt: ERRUNGENSCHAFTEN_KATALOG.length,
                letzte,
            });
            await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [msg, login]);
        } catch (error) {
            logger('er', `Errungenschaften: /abzeichen fehlgeschlagen: ${error.message}`);
        }
    }

    /**
     * Function run, when a player clicks the "Meine Abzeichen"-Menue-Knopf.
     * @param {CallbackParams.ManialinkPageAnswer} params
     */
    async onManialinkPageAnswer(params) {
        const { namespace, teile } = dekodiereAktion(params.answer);
        if (namespace !== AKTION_PRAEFIX) return;

        if (teile[0] === 'zeigen') await this.chat_abzeichen(params.login, []);

        await schliesseMenue(this.nextcontrol, params.login);
    }
}
