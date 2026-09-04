
import * as Classes from '../lib/classes.js'
import { NextControl } from '../nextcontrol.js'
import {
    MENU_MANIALINK_ID, kodiereAktion, dekodiereAktion, istAdmin,
    leereManialinkXml, baueListenMenuXml, baueEinstiegsKnopfXml
} from '../lib/manialinkMenu.js'

const AKTION_PRAEFIX = 'menu';
const EINSTIEG_AKTION = kodiereAktion(AKTION_PRAEFIX, 'offen');
const SCHLIESSEN_AKTION = kodiereAktion(AKTION_PRAEFIX, 'schliessen');

/**
 * Hauptmenue-Plugin: dauerhaft eingeblendeter Einstiegs-Knopf + grafisches
 * Kategorie-Menue, das alle bei nextcontrol.menuEintraege registrierten Befehle anderer
 * Plugins auflistet. Zeichnet selbst KEINE Befehlslogik -- ist reine Navigations-Huelle,
 * jedes Plugin behandelt seine eigene Menue-Aktion weiterhin in seinem eigenen
 * onManialinkPageAnswer (siehe controller/lib/manialinkMenu.js Kopfkommentar).
 */
export class MenuPlugin {

    name           = 'Hauptmenü'
    author         = 'system'
    description    = 'Grafisches ManiaLink-Hauptmenü (Zugriff auf die Chat-/Admin-Befehle als Knöpfe)'

    /**
     * @type {NextControl}
     */
    nextcontrol

    /**
     * @param {NextControl} nextcontrol
     */
    constructor(nextcontrol) {
        nextcontrol.registerChatCommand(new Classes.ChatCommand(
            'menu', this.commandMenu, 'Öffnet das grafische Hauptmenü.', this.name
        ));

        this.nextcontrol = nextcontrol;

        // Einstiegs-Knopf fuer bereits verbundene Spieler nachreichen (Muster wie
        // localRecords.js: nextcontrol.status ist beim Konstruktor noch nicht befuellt).
        setTimeout(() => this.sendeEinstiegsKnopf(), 1200);
    }

    /**
     * Sendet den dauerhaften Einstiegs-Knopf -- an alle (Broadcast) oder gezielt an einen
     * neu verbundenen Login.
     * @param {String} [nurAnLogin]
     */
    async sendeEinstiegsKnopf(nurAnLogin) {
        const xml = baueEinstiegsKnopfXml(EINSTIEG_AKTION);
        if (nurAnLogin) {
            await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [nurAnLogin, xml, 0, false]);
        } else {
            await this.nextcontrol.client.query('SendDisplayManialinkPage', [xml, 0, false]);
        }
    }

    /** Liefert die (nach Adminstatus gefilterte) Kategorienliste in Registrierungs-Reihenfolge. */
    kategorien(login) {
        const admin = istAdmin(login);
        const liste = [];
        for (const eintrag of this.nextcontrol.menuEintraege) {
            if (eintrag.adminOnly && !admin) continue;
            if (!liste.includes(eintrag.kategorie)) liste.push(eintrag.kategorie);
        }
        return liste;
    }

    async oeffneHauptmenue(login) {
        const kategorien = this.kategorien(login);
        const zeilen = kategorien.map((k, i) => ({ label: k, aktion: kodiereAktion(AKTION_PRAEFIX, 'kat', i) }));
        zeilen.push({ label: 'Schließen', aktion: SCHLIESSEN_AKTION });

        const xml = baueListenMenuXml({ titel: 'Hauptmenü', zeilen });
        await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [login, xml, 0, false]);
    }

    async oeffneKategorie(login, idx) {
        const kategorien = this.kategorien(login);
        const kategorie = kategorien[idx];
        if (kategorie === undefined) { await this.oeffneHauptmenue(login); return; }

        const admin = istAdmin(login);
        const zeilen = this.nextcontrol.menuEintraege
            .filter(e => e.kategorie === kategorie && (!e.adminOnly || admin))
            .map(e => ({ label: e.label, aktion: e.aktion }));
        zeilen.push({ label: '« Zurück', aktion: EINSTIEG_AKTION });

        const xml = baueListenMenuXml({ titel: kategorie, zeilen });
        await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [login, xml, 0, false]);
    }

    /**
     * Chat-Befehl /menu -- oeffnet das Hauptmenue.
     * @param {String} login
     */
    async commandMenu(login) {
        await this.oeffneHauptmenue(login);
    }

    /**
     * Function run, when a new map begins -- Einstiegs-Knopf erneut senden (dauerhafte
     * Anzeige, Muster wie localRecords.js Top-10-Tafel).
     */
    async onBeginMap() {
        await this.sendeEinstiegsKnopf();
    }

    /**
     * Function run, when a player connects -- Einstiegs-Knopf gezielt nachreichen.
     * @param {Classes.PlayerInfo} p
     */
    async onPlayerConnect(p) {
        await this.sendeEinstiegsKnopf(p.login);
    }

    /**
     * Function run, when a player clicks a menu navigation button.
     * @param {CallbackParams.ManialinkPageAnswer} params
     */
    async onManialinkPageAnswer(params) {
        const { namespace, teile } = dekodiereAktion(params.answer);
        if (namespace !== AKTION_PRAEFIX) return;

        if (teile[0] === 'offen') {
            await this.oeffneHauptmenue(params.login);
        } else if (teile[0] === 'kat') {
            await this.oeffneKategorie(params.login, Number(teile[1]));
        } else if (teile[0] === 'schliessen') {
            await this.nextcontrol.client.query('SendDisplayManialinkPageToLogin', [params.login, leereManialinkXml(MENU_MANIALINK_ID), 0, false]);
        }
    }
}
