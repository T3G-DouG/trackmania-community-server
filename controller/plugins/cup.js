// cup.js -- Cup-Plugin (Beta-Feature, siehe README): verbindet die reine Turnier-
// Engine (controller/lib/cup/cupEngine.js) mit dem Dedicated Server und Telegram.
// Laeuft AUSSCHLIESSLICH im Cup-Controller-Prozess (CUP_MODUS=true, eigener Server)
// -- durch die CUP_MODUS-Allowlist (settings.js/plugins.js) wird dieses Plugin im
// normalen TimeAttack-Hauptcontroller NIE geladen und schreibt daher nie in
// records/playerStats/maps/serverStatus.
//
// Turnier-Anlage (Name/Format/Teilnehmerfreigabe) ist NICHT Aufgabe dieses Plugins
// -- das macht scripts/cup-anlegen.js. Dieses Plugin findet sich selbst das jeweils
// aktuelle (noch nicht abgeschlossene) Turnier in `cupTurniere` und treibt es voran.

import { logger, stripFormatting } from '../lib/utilities.js';
import { sendeTelegramWarnung } from '../lib/telegramAlert.js';
import { verarbeiteEreignis, CUP_STATUS } from '../lib/cup/cupEngine.js';
import { erzeugeCupMatchSettingsXml, MATCHSETTINGS_DIR } from '../../scripts/lib/matchsettings.js';
import * as Classes from '../lib/classes.js';
import { writeFileSync } from 'fs';

const CUP_STATUS_TICK_MS = 5 * 1000;
const CUP_KOMMANDO_TICK_MS = 2 * 1000;
const CUP_MATCHSETTINGS_DATEI = 'CupPhase.txt'; // wird bei jedem Phasenwechsel ueberschrieben

/** Turnier-Stati, die als "noch nicht abgeschlossen" gelten -- das jeweils juengste
 * davon ist "das aktuelle Turnier", das dieses Plugin bedient. */
const OFFENE_STATI = [CUP_STATUS.ANGEKUENDIGT, CUP_STATUS.ANMELDUNG, CUP_STATUS.LAEUFT, CUP_STATUS.SIEGEREHRUNG];

export class CupPlugin {
    name = 'Cup'
    author = 'system'
    description = 'Cup: verbindet die Turnier-Engine (Phasen-KO/Knockout) mit dem Cup-Dedicated-Server und der Telegram-Gruppe. Laeuft nur im CUP_MODUS.'

    /** @type {import('../nextcontrol.js').NextControl} */
    nextcontrol

    /** Zwischengespeichertes aktuelles Turnier-Dokument (immer der Stand nach der
     * letzten erfolgreich verarbeiteten Aktion) oder null, wenn keins offen ist. */
    aktuellesTurnier = null

    /** Finish-Reihenfolge (Logins) der laufenden Runde, gesammelt aus onWaypoint als
     * Rueckfalloption, falls Trackmania.Scores fuer eine Runde ausbleibt. */
    rundenFinishReihenfolge = []

    constructor(nextcontrol) {
        this.nextcontrol = nextcontrol;

        nextcontrol.addRequiredCollection('cupTurniere');
        nextcontrol.addRequiredCollection('cupStatus');
        nextcontrol.addRequiredCollection('cupKommandos');

        nextcontrol.registerAdminCommand(new Classes.ChatCommand(
            'cup',
            this.cupAdminCommand,
            'Cup-Steuerung: start|erzwingen|pause|weiter|phase|kick <login>|add <login>|abbruch|status',
            this.name
        ));

        // Recovery + Timer starten, ohne den (synchronen) Konstruktor zu blockieren --
        // gleiches Vorgehen wie telegram.js beim Verbindungsaufbau.
        this.starteAsync().catch((e) => logger('er', `Cup: Start fehlgeschlagen: ${e.message}`));
    }

    async starteAsync() {
        await this.ermittleAktuellesTurnier();
        if (this.aktuellesTurnier) {
            logger('dg', `Cup: aktives Turnier "${this.aktuellesTurnier.name}" wiederhergestellt (Status: ${this.aktuellesTurnier.status}).`);
        } else {
            logger('dg', 'Cup: kein offenes Turnier gefunden, wartet auf Anlage.');
        }
        await this.sendeCupStatusSnapshot();

        this.statusTimer = setInterval(
            () => this.sendeCupStatusSnapshot().catch((e) => logger('er', `Cup: Status-Snapshot fehlgeschlagen: ${e.message}`)),
            CUP_STATUS_TICK_MS
        );
        this.kommandoTimer = setInterval(
            () => this.pruefeCupKommando().catch((e) => logger('er', `Cup: Kommando-Tick fehlgeschlagen: ${e.message}`)),
            CUP_KOMMANDO_TICK_MS
        );
        logger('dg', 'Cup: Status-Snapshot (5s) + Kommando-Bruecke (2s) aktiv.');
    }

    /**
     * Sucht das juengste noch nicht abgeschlossene Turnier und cached es in
     * this.aktuellesTurnier. Wird vor jeder Aktion neu aufgerufen (nicht nur beim
     * Boot), damit ein per cup-anlegen.js (AP14e) neu angelegtes Turnier automatisch
     * gefunden wird, ohne den Controller neu starten zu muessen.
     * @private
     */
    async ermittleAktuellesTurnier() {
        const treffer = await this.nextcontrol.mongoDb.collection('cupTurniere')
            .find({ status: { $in: OFFENE_STATI } })
            .sort({ erstelltAm: -1 })
            .limit(1)
            .toArray();
        this.aktuellesTurnier = treffer[0] ?? null;
        return this.aktuellesTurnier;
    }

    /**
     * Zentrale Schleuse: verarbeitet ein Ereignis ueber die reine Engine, persistiert
     * das Ergebnis und fuehrt die zurueckgegebenen Aktionen aus. Einziger Ort, an dem
     * dieses Plugin in `cupTurniere` schreibt.
     * @param {object} ereignis
     * @returns {Promise<{aktionen: Array<object>, ohneWirkung: boolean}>} ausgefuehrte
     *          Aktionen + ob ein admin()-Kommando mangels passendem Turnier-Status intern
     *          ein stiller No-op war (siehe cupEngine.js) -- fuer ehrliches Chat-/Telegram-Feedback.
     * @private
     */
    async wende(ereignis) {
        if (!this.aktuellesTurnier) return { aktionen: [], ohneWirkung: true };
        // WICHTIG: cupEngine.js klont den Turnierzustand per structuredClone() (reine
        // Funktion, kein Mongo-Bezug) -- ein MongoDB-ObjectId-Objekt uebersteht das
        // NICHT unbeschaedigt (wird zu einer nutzlosen Kopie ohne funktionierende
        // ObjectId-Methoden). Deshalb _id hier abtrennen und NIE mit in die Engine geben,
        // erst danach wieder anhaengen -- sonst schlagen alle folgenden DB-Operationen
        // mit "is not a valid ObjectId" fehl (live so aufgetreten und hier gefixt).
        const { _id, ...turnierOhneId } = this.aktuellesTurnier;
        const { turnier, aktionen, ohneWirkung } = verarbeiteEreignis(turnierOhneId, ereignis, new Date());

        await this.nextcontrol.mongoDb.collection('cupTurniere').updateOne(
            { _id },
            { $set: turnier }
        );
        this.aktuellesTurnier = { ...turnier, _id };

        for (const aktion of aktionen) {
            await this.fuehreAktionAus(aktion).catch((e) => logger('er', `Cup: Aktion '${aktion.typ}' fehlgeschlagen: ${e.message}`));
        }
        await this.sendeCupStatusSnapshot();
        return { aktionen, ohneWirkung: ohneWirkung === true };
    }

    /**
     * Fuehrt eine einzelne von der Engine gelieferte Aktion aus. Wirft nie unbehandelt
     * (jeder Aufrufer faengt bereits ab), damit eine fehlgeschlagene Einzelaktion nicht
     * den ganzen Verarbeitungsschritt (und damit die persistierte Turnier-Aenderung) blockiert.
     * @param {object} aktion
     * @private
     */
    async fuehreAktionAus(aktion) {
        const q = (methode, args) => this.nextcontrol.client.query(methode, args);

        switch (aktion.typ) {
            case 'ansage': {
                if (aktion.kanal === 'ingame' || aktion.kanal === 'beide') {
                    await q('ChatSendServerMessage', [`$ff0~~ Cup: $z$s$fff${aktion.text}`]);
                }
                if (aktion.kanal === 'telegram' || aktion.kanal === 'beide') {
                    await sendeTelegramWarnung(`🏆 ${aktion.text}`);
                }
                return;
            }

            case 'forceSpectator': {
                // 1 = in den Zuschauermodus zwingen (0 = frei waehlbar, 2 = als Spieler erzwingen)
                await q('ForceSpectator', [aktion.login, 1]);
                return;
            }

            case 'ladeMatchSettings': {
                await this.ladeMatchSettingsFuerPhase(aktion.phaseIndex);
                return;
            }

            case 'naechsteMap': {
                // Kein expliziter NextMap-Aufruf noetig: S_RoundsPerMap wurde beim
                // LoadMatchSettings der aktuellen Phase exakt auf die dortige
                // rundenProMap gesetzt, der Dedicated Server wechselt die Karte
                // innerhalb der Phase also von sich aus im richtigen Takt.
                return;
            }

            case 'turnierBeendet': {
                const sieger = aktion.endstand.find((e) => e.platz === 1);
                const podium = aktion.endstand.slice(0, 3).map((e) => `${e.platz}. ${e.name}`).join(', ');
                await q('ChatSendServerMessage', [`$ff0🏆~~ Turnier beendet! Sieger: $fff${sieger?.name ?? '?'}$z$s$ff0. Podium: ${podium}`]);
                await sendeTelegramWarnung(`🏆 <b>Cup beendet!</b>\nSieger: ${sieger?.name ?? '?'}\nPodium: ${podium}`);
                // Keine separate manuelle Bestaetigung vorgesehen -- Siegerehrung ist
                // hier bereits vollstaendig (Ansagen sind raus), direkt archivieren.
                await this.wende({ typ: 'siegerehrungAbgeschlossen' });
                return;
            }

            default:
                logger('w', `Cup: unbekannte Aktion '${aktion.typ}' von der Engine ignoriert.`);
        }
    }

    /**
     * Generiert die Rounds-MatchSettings fuer eine Turnierphase (phasenko: nur die
     * dieser Phase zugeteilten Maps; knockout: der komplette Pool, rotiert nativ) und
     * laedt sie per XML-RPC. Wird bewusst NICHT vorab fuer alle Phasen einmalig
     * generiert, sondern jedes Mal frisch aus turnier.config -- genauso robust
     * gegenueber einem zwischenzeitlichen resetSettings() (siehe nextcontrol.js,
     * ManiaPlanet.EndMatch), aber ohne verwaiste Dateien fuer nie erreichte Phasen.
     * @param {number} phaseIndex
     * @private
     */
    async ladeMatchSettingsFuerPhase(phaseIndex) {
        const turnier = this.aktuellesTurnier;
        let mapDateien, modeSettings;

        if (turnier.format === 'knockout') {
            mapDateien = turnier.config.maps;
            modeSettings = {
                punkteProRunde: turnier.config.punkteProRunde,
                rundenProMap: turnier.config.formatConfig.rundenProMap,
            };
        } else {
            const phasen = turnier.config.formatConfig.phasen;
            let offset = 0;
            for (let i = 0; i < phaseIndex; i++) offset += phasen[i].mapAnzahl;
            mapDateien = turnier.config.maps.slice(offset, offset + phasen[phaseIndex].mapAnzahl);
            modeSettings = {
                punkteProRunde: turnier.config.punkteProRunde,
                rundenProMap: phasen[phaseIndex].rundenProMap,
            };
        }

        if (!mapDateien.length) {
            logger('er', `Cup: Phase ${phaseIndex} hat keine zugeteilten Karten -- turnier.config.maps zu kurz fuer formatConfig?`);
            return;
        }

        const xml = erzeugeCupMatchSettingsXml(mapDateien, { modeSettings });
        writeFileSync(`${MATCHSETTINGS_DIR}/${CUP_MATCHSETTINGS_DATEI}`, xml, 'utf8');
        await this.nextcontrol.client.query('LoadMatchSettings', [`MatchSettings/${CUP_MATCHSETTINGS_DATEI}`]);
        // LoadMatchSettings ersetzt nur die Playlist fuer die naechste Karte -- es
        // unterbricht die AKTUELL laufende Karte nicht (anders als bei monatswechsel.js,
        // wo ein Uebergang bis zum naturlichen Kartenende tolerierbar ist). Ein Cup-
        // Phasenwechsel muss aber sofort greifen, deshalb hier explizit erzwingen
        // (live verifiziert: ohne NextMap blieb der Server auf der alten Karte stehen).
        await this.nextcontrol.client.query('NextMap');
        logger('dg', `Cup: MatchSettings fuer Phase ${phaseIndex} geladen (${mapDateien.length} Karte(n)).`);
        this.rundenFinishReihenfolge = [];
    }

    /**
     * Admin-Kommando `/admin cup ...` bzw. Kurzform `//cup ...` (identischer
     * Mechanismus wie bei allen anderen Admin-Kommandos, siehe nextcontrol.js).
     * @param {String} login
     * @param {Array<String>} params
     */
    async cupAdminCommand(login, params) {
        await this.ermittleAktuellesTurnier();
        const antwort = (text) => this.nextcontrol.client.query('ChatSendServerMessageToLogin', [`$ff0~~ Cup: $z$s$fff${text}`, login]);

        const unterbefehl = params.shift();

        if (unterbefehl === 'status') {
            if (!this.aktuellesTurnier) return antwort('Kein offenes Turnier gefunden.');
            const t = this.aktuellesTurnier;
            return antwort(`"${t.name}" -- Status: ${t.status}${t.pausiert ? ' (pausiert)' : ''}, ${t.teilnehmer.length} Teilnehmer.`);
        }

        if (!this.aktuellesTurnier) return antwort('Kein offenes Turnier gefunden -- erst mit cup-anlegen.js anlegen.');

        switch (unterbefehl) {
            case 'start': {
                if (params[0] === 'erzwingen') {
                    await this.wende({ typ: 'admin', kommando: 'startErzwingen' });
                } else {
                    await this.wende({ typ: 'start' });
                }
                return antwort(`Turnier-Status jetzt: ${this.aktuellesTurnier.status}.`);
            }
            case 'pause':
                await this.wende({ typ: 'admin', kommando: 'pause' });
                return antwort('Pausiert.');
            case 'weiter':
                await this.wende({ typ: 'admin', kommando: 'weiter' });
                return antwort('Geht weiter.');
            case 'phase':
                await this.wende({ typ: 'admin', kommando: 'phaseWiederholen' });
                return antwort('Aktuelle Phase wird wiederholt.');
            case 'kick':
                await this.wende({ typ: 'admin', kommando: 'spielerEntfernen', login: params[0] });
                return antwort(`${params[0]} entfernt.`);
            case 'add': {
                if (this.aktuellesTurnier.status === CUP_STATUS.ANMELDUNG) {
                    const spieler = this.nextcontrol.status.getPlayer(params[0]);
                    await this.wende({ typ: 'anmelden', login: params[0], name: spieler?.name ?? params[0], quelle: 'admin' });
                } else {
                    await this.wende({ typ: 'admin', kommando: 'spielerReinholen', login: params[0] });
                }
                return antwort(`${params[0]} hinzugefuegt.`);
            }
            case 'abbruch':
                await this.wende({ typ: 'admin', kommando: 'abbruch' });
                return antwort('Turnier abgebrochen.');
            default:
                return antwort('Unbekannt. Nutzung: start|erzwingen|pause|weiter|phase|kick <login>|add <login>|abbruch|status');
        }
    }

    /**
     * Admin-Bruecke Haupt-Controller -> Cup-Controller (AP14e, Telegram-seitig noch
     * nicht gebaut): identisches Muster wie serverSteuerung.js/analyse.js
     * (Collection `cupKommandos`, atomare Beanspruchung ueber `verarbeitetAm:null`).
     * @private
     */
    async pruefeCupKommando() {
        if (!this.aktuellesTurnier) await this.ermittleAktuellesTurnier();
        if (!this.aktuellesTurnier) return;

        let treffer;
        try {
            treffer = await this.nextcontrol.mongoDb.collection('cupKommandos')
                .find({ turnierId: this.aktuellesTurnier._id, verarbeitetAm: null })
                .sort({ erstelltAm: 1 })
                .limit(1)
                .toArray();
        } catch (error) {
            logger('er', `Cup: cupKommandos-Abfrage fehlgeschlagen: ${error.message}`);
            return;
        }
        if (!treffer.length) return;
        const kommando = treffer[0];

        const beansprucht = await this.nextcontrol.mongoDb.collection('cupKommandos').updateOne(
            { _id: kommando._id, verarbeitetAm: null },
            { $set: { verarbeitetAm: new Date() } }
        );
        if (beansprucht.modifiedCount === 0) return; // von einem anderen Tick bereits beansprucht

        const ereignisFuerKommando = {
            start: { typ: 'start' },
            startErzwingen: { typ: 'admin', kommando: 'startErzwingen' },
            pause: { typ: 'admin', kommando: 'pause' },
            weiter: { typ: 'admin', kommando: 'weiter' },
            phaseWiederholen: { typ: 'admin', kommando: 'phaseWiederholen' },
            spielerEntfernen: { typ: 'admin', kommando: 'spielerEntfernen', login: kommando.params?.login },
            spielerReinholen: { typ: 'admin', kommando: 'spielerReinholen', login: kommando.params?.login },
            abbruch: { typ: 'admin', kommando: 'abbruch' },
            anmelden: { typ: 'anmelden', login: kommando.params?.login, name: kommando.params?.name, quelle: 'telegram' },
            abmelden: { typ: 'abmelden', login: kommando.params?.login },
        }[kommando.kommando];

        if (!ereignisFuerKommando) {
            logger('w', `Cup: unbekanntes cupKommando '${kommando.kommando}' ignoriert.`);
            return;
        }

        try {
            const { ohneWirkung } = await this.wende(ereignisFuerKommando);
            // Ehrliches Feedback statt eines falschen "erfolgreich": telegramCommandCup()
            // (telegram.js) behandelt jeden ergebnis-Wert != 'erfolgreich' bereits als
            // Fehlermeldung an den Nutzer -- ohne Codeaenderung dort.
            const ergebnis = ohneWirkung ? 'ohne Wirkung (falscher Turnier-Status)' : 'erfolgreich';
            await this.nextcontrol.mongoDb.collection('cupKommandos').updateOne({ _id: kommando._id }, { $set: { ergebnis } });
        } catch (error) {
            logger('er', `Cup: Kommando '${kommando.kommando}' fehlgeschlagen: ${error.message}`);
            await this.nextcontrol.mongoDb.collection('cupKommandos').updateOne({ _id: kommando._id }, { $set: { ergebnis: `fehlgeschlagen: ${error.message}` } });
        }
    }

    /**
     * Schreibt den Live-Snapshot fuer die Website (Muster serverStatus/liveStatus.js)
     * -- AP14f (Website) ist noch nicht gebaut, die Collection wird aber bereits jetzt
     * konsistent gepflegt, damit AP14f rein additiv bleibt.
     * @private
     */
    async sendeCupStatusSnapshot() {
        const t = this.aktuellesTurnier;
        const snapshot = {
            _id: 'cup',
            turnierId: t?._id ?? null,
            status: t?.status ?? 'keins',
            phaseName: this.aktuellePhaseName(t),
            // Vor Turnierstart existiert noch kein "verlauf" (aktuelleRangliste liefert dann
            // absichtlich []) -- waehrend der Anmeldephase ist stattdessen die Teilnehmerliste
            // die relevante Information fuer eine Live-Anzeige (/cup status).
            teilnehmer: t?.teilnehmer?.map((p) => stripFormatting(p.name)) ?? [],
            rangliste: t ? this.aktuelleRangliste(t) : [],
            letzteRunde: t?.verlauf?.rundenErgebnisse?.at(-1) ?? null,
            updatedAt: new Date(),
        };
        await this.nextcontrol.mongoDb.collection('cupStatus').updateOne({ _id: 'cup' }, { $set: snapshot }, { upsert: true });
    }

    /** @private */
    aktuellePhaseName(turnier) {
        if (!turnier?.verlauf) return null;
        if (turnier.format === 'knockout') return 'Knockout';
        return turnier.config.formatConfig.phasen[turnier.verlauf.phaseIndex]?.name ?? null;
    }

    /** Grobe Zwischenrangliste fuer den Snapshot (aktive Teilnehmer nach Punkten/Leben
     * bzw. Ausgeschiedene nach endPlatz) -- ruft bewusst NICHT das Format-Interface
     * auf, um cupEngine.js nicht ausserhalb der eigentlichen Ereignisverarbeitung
     * mitimportieren zu muessen; reicht fuer eine Live-Anzeige. @private */
    aktuelleRangliste(turnier) {
        if (!turnier.verlauf) return [];
        const aktive = turnier.verlauf.aktivTeilnehmer.map((login) => {
            const name = turnier.teilnehmer.find((t) => t.login === login)?.name ?? login;
            const wert = turnier.verlauf.punkte?.[login] ?? turnier.verlauf.leben?.[login] ?? 0;
            return { login, name, wert };
        }).sort((a, b) => b.wert - a.wert);
        return aktive;
    }

    // ---- Callback-Handler (nextcontrol.js dispatcher) --------------------------------

    /**
     * Finish-Reihenfolge als Rueckfalloption sammeln, falls Trackmania.Scores fuer
     * eine Runde ausbleiben sollte. Primaerquelle ist onModeScriptCallback (Scores).
     * @param {Classes.WaypointInfo} waypointInfo
     */
    async onWaypoint(waypointInfo) {
        if (!waypointInfo.isEndRace) return;
        if (!this.rundenFinishReihenfolge.includes(waypointInfo.login)) {
            this.rundenFinishReihenfolge.push(waypointInfo.login);
        }
    }

    /**
     * AP14a-Fallthrough liefert hier jeden nicht speziell behandelten ModeScript-
     * Callback. Autoritative Rundenergebnis-Quelle ist `Trackmania.Scores` (Payload-
     * Struktur live verifiziert, AP14i-Generalprobe) -- players[].name traegt den
     * klassischen Login, players[].login ist eine anonymisierte WebServices-ID (siehe
     * Kommentar unten). Trotzdem robust mit Fallback auf die per onWaypoint gesammelte
     * Finish-Reihenfolge, falls ein Spieler ueber den Namen nicht zugeordnet werden kann.
     * @param {String} method
     * @param {*} params
     */
    async onModeScriptCallback(method, params) {
        if (method !== 'Trackmania.Scores') return;
        if (!this.aktuellesTurnier || this.aktuellesTurnier.status !== CUP_STATUS.LAEUFT) return;
        // Trackmania.Scores feuert an mehreren Punkten (u.a. Zwischenstand); nur beim
        // tatsaechlichen Rundenende reagieren.
        if (params?.section && params.section !== 'EndRound') return;

        const aktive = this.aktuellesTurnier.verlauf.aktivTeilnehmer;
        let reihenfolge = [];

        // WICHTIG (live per Debug-Log verifiziert, AP14i): players[].login ist eine
        // anonymisierte WebServices-ID, NICHT der klassische Dedicated-Server-Login,
        // den aktivTeilnehmer/onWaypoint/der Rest dieser Datei verwenden. Der klassische
        // Login steckt stattdessen in players[].name (ggf. mit Formatierungscodes,
        // daher stripFormatting). Deckt nicht 100% der Faelle ab (ein Spieler koennte
        // theoretisch einen Anzeigenamen abweichend vom Login haben) -- der onWaypoint-
        // Fallback unten faengt die dadurch fehlenden Eintraege ab.
        const spielerListe = Array.isArray(params?.players) ? params.players : null;
        if (spielerListe) {
            reihenfolge = spielerListe
                .map((p) => ({ ...p, login: stripFormatting(p.name ?? '') }))
                .filter((p) => aktive.includes(p.login))
                .sort((a, b) => (a.roundpoints ?? a.matchpoints ?? 0) < (b.roundpoints ?? b.matchpoints ?? 0) ? 1 : -1)
                .map((p) => p.login);
        }
        if (reihenfolge.length < aktive.length) {
            // Fallback / Ergaenzung: onWaypoint-Reihenfolge fuer fehlende Logins nutzen.
            for (const login of this.rundenFinishReihenfolge) {
                if (aktive.includes(login) && !reihenfolge.includes(login)) reihenfolge.push(login);
            }
        }
        if (!reihenfolge.length) {
            logger('w', 'Cup: Trackmania.Scores ohne auswertbare Spielerliste UND keine onWaypoint-Reihenfolge -- Runde wird uebersprungen.');
            return;
        }

        const ergebnisse = reihenfolge.map((login, i) => ({ login, platz: i + 1 }));
        await this.wende({ typ: 'rundenErgebnis', ergebnisse });
    }

    async onEndMap(map) {
        this.rundenFinishReihenfolge = [];
    }

    /**
     * Nicht-Teilnehmer werden freundlich in den Zuschauermodus geschickt (kein
     * join.js im Cup-Prozess -- eigene, minimale Begruessung). Zurueckkehrende
     * Teilnehmer werden der Engine als "wieder verbunden" gemeldet.
     * @param {Classes.PlayerInfo} player
     * @param {Boolean} isSpectator
     */
    async onPlayerConnect(player, isSpectator) {
        if (!this.aktuellesTurnier || this.aktuellesTurnier.status !== CUP_STATUS.LAEUFT) return;
        const name = stripFormatting(player.name);
        const aktiv = this.aktuellesTurnier.verlauf.aktivTeilnehmer.includes(player.login);

        if (!aktiv) {
            if (!isSpectator) await this.nextcontrol.client.query('ForceSpectator', [player.login, 1]);
            await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [
                `$ff0~~ Cup: $z$s$fffGerade laeuft "${this.aktuellesTurnier.name}" -- du bist nicht angemeldet, schau gerne als Zuschauer zu.`,
                player.login,
            ]);
            return;
        }

        if (this.aktuellesTurnier.verlauf.getrennt.includes(player.login)) {
            await this.wende({ typ: 'spielerVerbunden', login: player.login });
            await this.nextcontrol.client.query('ChatSendServerMessage', [`$ff0~~ Cup: $z$s$fff${name} ist zurueck!`]);
        }
    }

    async onPlayerDisconnect(player, reason) {
        if (!this.aktuellesTurnier || this.aktuellesTurnier.status !== CUP_STATUS.LAEUFT) return;
        if (this.aktuellesTurnier.verlauf.aktivTeilnehmer.includes(player.login)) {
            await this.wende({ typ: 'spielerGetrennt', login: player.login });
        }
    }
}
