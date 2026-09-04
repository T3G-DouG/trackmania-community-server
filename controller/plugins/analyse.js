import { Settings } from '../settings.js'
import { logger } from '../lib/utilities.js'
import * as Classes from '../lib/classes.js'
import { fuehreAnalyseLaufDurch } from '../lib/analyse/berichtLauf.js'
import { pruefeAutoLaufErlaubnis, pruefeAutoMonatsLaufErlaubnis, pruefeManuellenLaufErlaubnis } from '../lib/analyse/automatikTakt.js'
import { istNaechtlicherRefreshFaellig, aktualisiereAlleDossiers } from '../lib/analyse/dossierRefresh.js'
import { holeEinstellungen } from '../lib/laufzeitEinstellungen.js'
import { sendeTelegramWarnung } from '../lib/telegramAlert.js'
import { NextControl } from '../nextcontrol.js'
import { kodiereAktion, dekodiereAktion, pruefeAdmin, schliesseMenue } from '../lib/manialinkMenu.js'

const AKTION_PRAEFIX = 'analyse';

/** Wie oft der Zeitfenster-/Budget-Guard geprueft wird -- muss nur grob ins Zeitfenster treffen. */
const STUNDEN_TICK_MS = 60 * 60 * 1000;

/**
 * Wie oft auf einen manuellen Website-Trigger (adminKommandos, AP16b) geprueft wird --
 * bewusst kurz getaktet (Muster: Ambient-Tick der Rennleitung), damit der "Jetzt ausloesen"-
 * Knopf im Dashboard sich nicht wie ein stiller No-op anfuehlt. Der eigentliche Budget-Guard
 * (1 Lauf/24h) sitzt weiterhin in automatikTakt.js und begrenzt die tatsaechlichen Laeufe --
 * die kurze Taktung hier betrifft nur, wie schnell eine ABLEHNUNG sichtbar wird.
 */
const KOMMANDO_TICK_MS = 60 * 1000;

/**
 * Automatisiert den woechentlichen KI-Analyse-Lauf (AP15d: controller/lib/analyse/berichtLauf.js)
 * und verschickt den Telegram-Kompaktbericht an die Gruppe. Bewusst duenn: die gesamte
 * Lauf-Logik (laden/rechnen/texten/guarden) steckt in controller/lib/analyse/, dieses Plugin
 * ist nur die Zeitsteuerung (Sonntagabend) + der manuelle Admin-Trigger.
 *
 * Budget-Guard + Wochen-Mindestabstand leben in automatikTakt.js und lesen ausschliesslich die
 * kiAnalysen-Collection als Quelle der Wahrheit (kein In-Memory-Zustand) -- ein Controller-
 * Neustart genau im Sonntagabend-Fenster fuehrt deshalb NICHT zu einem Doppel-Lauf.
 */
export class Analyse {
    name = 'Analyse (KI-Wochenbericht)'
    author = 'system'
    description = 'KI-gestuetzter Wochenbericht (Zeitplan per Admin-Dashboard) + monatlicher Rueckblick (fest am 2. ab 09:00) + manueller Trigger per Admin-Befehl/Dashboard + naechtlicher Dossier-Refresh'
    version = '1.2.0'

    /** @type {NextControl} */
    nextcontrol

    /** Verhindert ueberlappende Laeufe (Tick waehrend eines laufenden manuellen Triggers oder umgekehrt). */
    laeuftGerade = false

    constructor(nextcontrol) {
        this.nextcontrol = nextcontrol;

        // WICHTIG: kein .bind(this) -- nextcontrol.js ruft Befehle per plugin[name](...) auf,
        // das durch .bind() erzeugte Funktionsnamen ("bound xyz") nicht mehr findet.
        nextcontrol.registerAdminCommand(new Classes.ChatCommand(
            'analyse', this.commandAdminAnalyse,
            'Analyse-Lauf steuern: /admin analyse jetzt [woche|monat]|status', this.name
        ));

        // AP17d: Menue-Eintraege
        const eintrag = (label, ...aktionsTeile) => new Classes.MenuEintrag(
            'Admin · KI', label, kodiereAktion(AKTION_PRAEFIX, ...aktionsTeile), { adminOnly: true, pluginName: this.name }
        );
        nextcontrol.registerMenuEintrag(eintrag('Analyse jetzt (Woche)', 'jetzt', 'woche'));
        nextcontrol.registerMenuEintrag(eintrag('Analyse jetzt (Monat)', 'jetzt', 'monat'));
        nextcontrol.registerMenuEintrag(eintrag('Analyse-Status', 'status'));

        this.tickTimer = setInterval(() => this.stundenTick(), STUNDEN_TICK_MS);
        // Zusaetzlich kurz nach dem Start einmal pruefen -- deckt den Fall ab, dass der
        // Controller genau im Wochenlauf-/04-Uhr-Fenster neu gestartet wird und sonst bis zu
        // einer Stunde auf den ersten Tick warten wuerde.
        setTimeout(() => this.stundenTick(), 5000);

        // Eigener, kurz getakteter Timer fuer den manuellen Website-Trigger (AP16b) -- siehe
        // KOMMANDO_TICK_MS-Kommentar oben.
        this.kommandoTimer = setInterval(
            () => this.pruefeAdminKommando().catch((e) => logger('er', `Analyse: Tick-Fehler (Dashboard-Trigger): ${e.message}`)),
            KOMMANDO_TICK_MS
        );

        // Ohne API-Key laeuft fuehreAnalyseLaufDurch trotzdem durch (Guard-Fallbacktexte statt
        // KI-Text, siehe berichtKi.js) -- der Hinweis dient nur der Transparenz, analog zu
        // rennleitung.js.
        if (!Settings.ki.apiKey && !Settings.ki.dryRun) {
            logger('w', 'Analyse: kein ANTHROPIC_API_KEY in secrets.env -- Laeufe liefern nur deterministische Fallback-Texte statt KI-Einordnung.');
        }
        logger('dg', 'Analyse: Automatik registriert (Wochenbericht per Dashboard-Zeitplan, Default So ab 19:30 + Monatsbericht fest am 2. ab 09:00, Budget-Guard 24h) + naechtlicher Dossier-Refresh (~04:00) + Dashboard-Trigger-Polling (60s).');
    }

    /**
     * Stuendlicher Tick: drei unabhaengige, voneinander getrennt abgesicherte Pruefungen
     * (ein Fehler in einer darf die anderen nicht verhindern) -- woechentlicher UND
     * monatlicher Analyse-Lauf (AP15d/e, AP17-Nachtrag: siehe kennzahlen.js fuer den
     * Unterschied) sowie der naechtliche Dossier-Refresh (AP15g).
     * @private
     */
    stundenTick() {
        this.pruefeUndFuehreAus('automatisch', undefined, 'woche').catch((e) => logger('er', `Analyse: Tick-Fehler (Wochen-Lauf): ${e.message}`));
        this.pruefeUndFuehreAus('automatisch', undefined, 'monat').catch((e) => logger('er', `Analyse: Tick-Fehler (Monats-Lauf): ${e.message}`));
        this.pruefeDossierRefresh().catch((e) => logger('er', `Analyse: Tick-Fehler (Dossier-Refresh): ${e.message}`));
    }

    /**
     * Aktualisiert bei Bedarf (~04:00, DB-basierter Guard, siehe dossierRefresh.js) alle
     * Spieler-Dossiers (AP15g). Keine KI-Aufrufe, rein deterministisch -- daher kein eigener
     * Budget-Guard noetig, nur der Zeitfenster-Check in istNaechtlicherRefreshFaellig().
     * @private
     */
    async pruefeDossierRefresh() {
        let faellig;
        try {
            faellig = await istNaechtlicherRefreshFaellig(this.nextcontrol.mongoDb);
        } catch (error) {
            logger('er', `Analyse: Dossier-Refresh-Pruefung fehlgeschlagen (Datenbank nicht erreichbar?): ${error.message}`);
            return;
        }
        if (!faellig) return;

        try {
            const { aktualisiert, fehlgeschlagen } = await aktualisiereAlleDossiers(this.nextcontrol.mongoDb);
            logger('ok', `Analyse: naechtlicher Dossier-Refresh abgeschlossen (${aktualisiert} aktualisiert${fehlgeschlagen > 0 ? `, ${fehlgeschlagen} fehlgeschlagen` : ''}).`);
        } catch (error) {
            logger('er', `Analyse: Dossier-Refresh fehlgeschlagen: ${error.message}`);
        }
    }

    /**
     * Fuehrt -- sofern die Guards (automatikTakt.js) das erlauben -- einen Analyse-Lauf durch
     * und verschickt den Telegram-Kompaktbericht an die Gruppe. Wirft nie unbehandelt (kein
     * globaler unhandledRejection-Handler im Controller, siehe errungenschaften.js).
     * @param {'automatisch'|'manuell'} ausloeser
     * @param {String} [angefordertVon] Login des Admins bei manuellem Trigger, nur fuers Logging
     * @param {'woche'|'monat'} [berichtTyp] AP17-Nachtrag: welches Kennzahlen-Set (siehe kennzahlen.js)
     * @returns {Promise<{gestartet: boolean, grund?: string, naechsterErlaubterZeitpunkt?: Date, erfolgreich?: boolean, dokument?: object}>}
     */
    async pruefeUndFuehreAus(ausloeser, angefordertVon, berichtTyp = 'woche') {
        if (this.laeuftGerade) return { gestartet: false, grund: 'laeuftBereits' };

        // AP16b: Zeitplan/Modell/Telegram-Toggle kommen aus dem Admin-Dashboard (systemSettings.analyse),
        // holeEinstellungen() liefert ohne Konfiguration exakt die bisherigen Festwerte (So 19:30,
        // Settings.ki.analyseModell, Telegram an) -- wirft nie, siehe laufzeitEinstellungen.js.
        // Der Zeitplan gilt nur fuer den Wochenbericht -- der Monatsbericht hat einen festen,
        // nicht konfigurierbaren Termin (siehe automatikTakt.js, Muster monatswechselAutomatik.js).
        const einstellungen = holeEinstellungen().analyse;

        let erlaubnis;
        try {
            if (ausloeser !== 'automatisch') {
                erlaubnis = await pruefeManuellenLaufErlaubnis(this.nextcontrol.mongoDb);
            } else if (berichtTyp === 'monat') {
                erlaubnis = await pruefeAutoMonatsLaufErlaubnis(this.nextcontrol.mongoDb);
            } else {
                erlaubnis = await pruefeAutoLaufErlaubnis(this.nextcontrol.mongoDb, new Date(), einstellungen.wochentag, einstellungen.uhrzeit);
            }
        } catch (error) {
            logger('er', `Analyse: Guard-Pruefung fehlgeschlagen (Datenbank nicht erreichbar?): ${error.message}`);
            return { gestartet: false, grund: 'fehler' };
        }
        if (!erlaubnis.erlaubt) {
            return { gestartet: false, grund: erlaubnis.grund, naechsterErlaubterZeitpunkt: erlaubnis.naechsterErlaubterZeitpunkt };
        }

        this.laeuftGerade = true;
        try {
            logger('dg', `Analyse: Lauf gestartet (${ausloeser}, ${berichtTyp}${angefordertVon ? `, angefordert von ${angefordertVon}` : ''}, Modell ${einstellungen.modell}).`);
            const dokument = await fuehreAnalyseLaufDurch(this.nextcontrol.mongoDb, { ausloeser, berichtTyp, live: true, modell: einstellungen.modell });
            if (!dokument) {
                logger('er', 'Analyse: Lauf fehlgeschlagen (siehe vorherige Fehlermeldung).');
                return { gestartet: true, erfolgreich: false };
            }

            if (einstellungen.telegramBericht) {
                await sendeTelegramWarnung(dokument.telegramBericht);

                // Nur ein Zeitstempel-Update -- ein Fehler hier darf den bereits erfolgreichen
                // Lauf (Dokument persistiert, Nachricht verschickt) nicht als Fehlschlag melden.
                try {
                    await this.nextcontrol.mongoDb.collection('kiAnalysen').updateOne(
                        { _id: dokument._id },
                        { $set: { telegramGesendetAm: new Date() } }
                    );
                } catch (error) {
                    logger('er', `Analyse: telegramGesendetAm konnte nicht gesetzt werden: ${error.message}`);
                }
            } else {
                logger('dg', 'Analyse: Telegram-Bericht per Dashboard-Einstellung deaktiviert -- Lauf nur gespeichert, nicht verschickt.');
            }

            logger('ok', `Analyse: Lauf abgeschlossen (Status ${dokument.textStatus}).`);
            return { gestartet: true, erfolgreich: true, dokument };
        } catch (error) {
            logger('er', `Analyse: unerwarteter Fehler waehrend des Laufs: ${error.message}`);
            return { gestartet: true, erfolgreich: false };
        } finally {
            this.laeuftGerade = false;
        }
    }

    /**
     * Prueft auf einen ausstehenden manuellen Trigger aus dem Admin-Dashboard (AP16b,
     * Collection adminKommandos, {typ:'analyseJetzt', erledigtAm:null}) und fuehrt ihn ueber
     * den regulaeren manuellen Pfad aus (identischer Budget-Guard wie /admin analyse jetzt).
     * Markiert den Eintrag ATOMAR ueber den updateOne-Filter erledigtAm:null als bearbeitet,
     * BEVOR der Lauf startet -- ein ueberlappender Tick (z.B. bei sehr langsamer DB) kann den
     * selben Eintrag dadurch nie doppelt aufgreifen. Wirft nie unbehandelt.
     * @private
     */
    async pruefeAdminKommando() {
        let treffer;
        try {
            treffer = await this.nextcontrol.mongoDb.collection('adminKommandos')
                .find({ typ: 'analyseJetzt', erledigtAm: null })
                .sort({ angefordertAm: 1 })
                .limit(1)
                .toArray();
        } catch (error) {
            logger('er', `Analyse: adminKommandos-Abfrage fehlgeschlagen: ${error.message}`);
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
            logger('er', `Analyse: adminKommandos-Markierung fehlgeschlagen: ${error.message}`);
            return;
        }
        if (beansprucht.modifiedCount === 0) return; // von einem anderen Tick bereits beansprucht

        const berichtTyp = kommando.berichtTyp === 'monat' ? 'monat' : 'woche';
        logger('dg', `Analyse: manueller Trigger vom Admin-Dashboard erkannt (${berichtTyp}).`);
        const ergebnis = await this.pruefeUndFuehreAus('manuell', 'dashboard', berichtTyp);

        // Ergebnis nachtragen, damit admin-api.php dem Betreiber zeigen kann, ob/warum der
        // Trigger abgelehnt wurde, statt eines stillen No-ops.
        try {
            await this.nextcontrol.mongoDb.collection('adminKommandos').updateOne(
                { _id: kommando._id },
                { $set: {
                    ergebnis: ergebnis.gestartet ? (ergebnis.erfolgreich ? 'erfolgreich' : 'fehlgeschlagen') : ergebnis.grund,
                    naechsterErlaubterZeitpunkt: ergebnis.naechsterErlaubterZeitpunkt ?? null,
                } }
            );
        } catch (error) {
            logger('er', `Analyse: adminKommandos-Ergebnis konnte nicht gespeichert werden: ${error.message}`);
        }
    }

    /**
     * /admin analyse jetzt [woche|monat]|status
     * @param {String} login
     * @param {Array<String>} params
     */
    async commandAdminAnalyse(login, params) {
        const antworten = (msg) => this.nextcontrol.client.query('ChatSendServerMessageToLogin', [msg, login]);
        const arg = (params[0] ?? 'status').toLowerCase();

        if (arg === 'jetzt') {
            const berichtTyp = (params[1] ?? 'woche').toLowerCase() === 'monat' ? 'monat' : 'woche';
            antworten(`$fffAnalyse-Lauf (${berichtTyp}) wird geprueft ...`);
            const ergebnis = await this.pruefeUndFuehreAus('manuell', login, berichtTyp);
            if (!ergebnis.gestartet) {
                const grundText = ergebnis.grund === 'laeuftBereits'
                    ? 'es laeuft bereits ein Analyse-Lauf'
                    : ergebnis.naechsterErlaubterZeitpunkt
                        ? `Budget-Guard aktiv, naechster Lauf erst ab ${ergebnis.naechsterErlaubterZeitpunkt.toLocaleString('de-DE')} moeglich`
                        : 'aktuell nicht erlaubt';
                antworten(`$f00Analyse-Lauf abgelehnt: ${grundText}.`);
                return;
            }
            antworten(ergebnis.erfolgreich
                ? '$0f0Analyse-Lauf abgeschlossen und an Telegram gesendet.'
                : '$f00Analyse-Lauf fehlgeschlagen (siehe Server-Log).');
            return;
        }

        let letzte;
        try {
            letzte = await this.nextcontrol.mongoDb.collection('kiAnalysen').find({}).sort({ erstelltAm: -1 }).limit(1).toArray();
        } catch (error) {
            logger('er', `Analyse: Status lesen fehlgeschlagen (Datenbank nicht erreichbar?): ${error.message}`);
            antworten('$f00Status konnte nicht geladen werden (Datenbank nicht erreichbar?).');
            return;
        }
        if (!letzte.length) {
            antworten('$fffNoch kein Analyse-Lauf durchgefuehrt. Nutzung: /admin analyse jetzt [woche|monat]|status');
            return;
        }
        const d = letzte[0];
        antworten(
            `$fffLetzter Lauf: ${new Date(d.erstelltAm).toLocaleString('de-DE')} (${d.berichtTyp ?? 'woche'}, ${d.ausloeser}, Status ${d.textStatus}, Modell ${d.modell}). ` +
            `Nutzung: /admin analyse jetzt [woche|monat]|status`
        );
    }

    /**
     * Function run, when a player clicks an Analyse-Menue-Knopf.
     * @param {CallbackParams.ManialinkPageAnswer} params
     */
    async onManialinkPageAnswer(params) {
        const { namespace, teile } = dekodiereAktion(params.answer);
        if (namespace !== AKTION_PRAEFIX) return;

        const login = params.login;
        if (!pruefeAdmin(this.nextcontrol, login)) return;

        await this.commandAdminAnalyse(login, teile);
        await schliesseMenue(this.nextcontrol, login);
    }
}
