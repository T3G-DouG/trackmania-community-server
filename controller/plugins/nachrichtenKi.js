import { Settings } from '../settings.js'
import { logger } from '../lib/utilities.js'
import { istAktiviert, setzeAktiviert } from '../lib/kiEnrich.js'
import { initialisiereLaufzeitEinstellungen } from '../lib/laufzeitEinstellungen.js'
import { setzeNutzungsTracker } from '../lib/kiClient.js'
import { initialisiereKiNutzungTracker, erfasseNutzung } from '../lib/kiNutzungTracker.js'
import * as Classes from '../lib/classes.js'
import { NextControl } from '../nextcontrol.js'
import { kodiereAktion, dekodiereAktion, pruefeAdmin, schliesseMenue } from '../lib/manialinkMenu.js'

const AKTION_PRAEFIX = 'nachrichtenki';

/**
 * Reines Admin-Schalter-Plugin für die Zusatzfunktion "Nachrichten-KI" (sprachliche
 * Umformulierung bestehender Server-Benachrichtigungen, siehe lib/kiEnrich.js). Enthält selbst
 * KEINE Umformulierungs-Logik -- die lebt in lib/kiEnrich.js und wird von den einzelnen
 * Sendestellen (join.js, liveStatus.js, localRecords.js, karma.js, errungenschaften.js,
 * admin.js) direkt importiert, da Plugins sich untereinander nie importieren.
 *
 * Unabhängig von der Rennleitung (rennleitung.js) -- eigener Ein/Aus-Schalter.
 */
export class NachrichtenKi {
    name = 'Nachrichten-KI (Umformulierung)'
    author = 'system'
    description = 'Schaltet die KI-gestützte sprachliche Umformulierung bestehender Server-Benachrichtigungen ein/aus'
    version = '1.0.0'

    /** @type {NextControl} */
    nextcontrol

    constructor(nextcontrol) {
        this.nextcontrol = nextcontrol;
        initialisiereLaufzeitEinstellungen(nextcontrol.mongoDb);
        initialisiereKiNutzungTracker(nextcontrol.mongoDb);
        setzeNutzungsTracker(erfasseNutzung);

        // Admin-Befehl immer registrieren -- auch ohne Key/Trockenlauf, damit /status jederzeit
        // funktioniert und eine klare Fehlermeldung liefert.
        nextcontrol.registerAdminCommand(new Classes.ChatCommand(
            'nachrichtenki', this.commandAdminNachrichtenKi,
            'Schaltet die KI-Umformulierung von Server-Nachrichten ein/aus: /admin nachrichtenki an|aus|status', this.name
        ));

        // AP17d: Menue-Eintraege
        const eintrag = (label, wert) => new Classes.MenuEintrag(
            'Admin · KI', label, kodiereAktion(AKTION_PRAEFIX, wert), { adminOnly: true, pluginName: this.name }
        );
        nextcontrol.registerMenuEintrag(eintrag('Nachrichten-KI: an', 'an'));
        nextcontrol.registerMenuEintrag(eintrag('Nachrichten-KI: aus', 'aus'));
        nextcontrol.registerMenuEintrag(eintrag('Nachrichten-KI: Status', 'status'));

        logger('dg', `Nachrichten-KI: ${istAktiviert() ? 'aktiv' : 'registriert, aber ausgeschaltet'}.`);
    }

    /**
     * /admin nachrichtenki an|aus|status -- schaltet die Umformulierung zur Laufzeit ein/aus.
     * WICHTIG: niemals .bind(this) verwenden -- der Name-basierte Dispatch in nextcontrol.js
     * sucht die Methode über handlerFunction.name auf der Plugin-Instanz; ein gebundenes
     * Funktionsobjekt hieße "bound commandAdminNachrichtenKi" und würde nicht gefunden.
     * @param {String} login
     * @param {Array<String>} params
     */
    async commandAdminNachrichtenKi(login, params) {
        const arg = (params[0] ?? '').toLowerCase();

        if (arg === 'an' || arg === 'ein' || arg === 'on') {
            if (!Settings.ki.apiKey && !Settings.ki.dryRun) {
                this.nextcontrol.client.query('ChatSendServerMessageToLogin', ['$f00Nachrichten-KI: kein ANTHROPIC_API_KEY konfiguriert -- kann nicht eingeschaltet werden.', login]);
                return;
            }
            if (!(await setzeAktiviert(true, login))) {
                this.nextcontrol.client.query('ChatSendServerMessageToLogin', ['$f00Nachrichten-KI: Einstellung konnte nicht gespeichert werden (Datenbank nicht erreichbar?). Bitte erneut versuchen.', login]);
                return;
            }
            logger('dg', `Nachrichten-KI: von ${login} eingeschaltet.`);
            this.nextcontrol.client.query('ChatSendServerMessage', ['$0f0Umformulierung der Server-Nachrichten eingeschaltet.']);
        } else if (arg === 'aus' || arg === 'off') {
            if (!(await setzeAktiviert(false, login))) {
                this.nextcontrol.client.query('ChatSendServerMessageToLogin', ['$f00Nachrichten-KI: Einstellung konnte nicht gespeichert werden (Datenbank nicht erreichbar?). Bitte erneut versuchen.', login]);
                return;
            }
            logger('dg', `Nachrichten-KI: von ${login} ausgeschaltet.`);
            this.nextcontrol.client.query('ChatSendServerMessage', ['$f80Umformulierung der Server-Nachrichten ausgeschaltet.']);
        } else {
            const status = istAktiviert() ? '$0f0an' : '$f00aus';
            this.nextcontrol.client.query('ChatSendServerMessageToLogin', [`$fffNachrichten-KI ist aktuell ${status}$fff. Nutzung: /admin nachrichtenki an|aus`, login]);
        }
    }

    /**
     * Function run, when a player clicks a Nachrichten-KI-Menue-Knopf.
     * @param {CallbackParams.ManialinkPageAnswer} params
     */
    async onManialinkPageAnswer(params) {
        const { namespace, teile } = dekodiereAktion(params.answer);
        if (namespace !== AKTION_PRAEFIX) return;

        const login = params.login;
        if (!pruefeAdmin(this.nextcontrol, login)) return;

        await this.commandAdminNachrichtenKi(login, [teile[0]]);
        await schliesseMenue(this.nextcontrol, login);
    }
}
