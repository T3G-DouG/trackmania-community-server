import { NextControl } from './nextcontrol.js';
import { Settings } from './settings.js';

/*** List of Plugins: ****/
import { SamplePlugin } from './plugins/sample.js';
import { Join } from './plugins/join.js';
import { LocalRecords } from './plugins/localRecords.js';
import { AdminSuite } from './plugins/admin.js';
import { ListsPlugin } from './plugins/list.js';
import { JukeboxPlugin } from './plugins/jukebox.js';
import { ForceModsPlugin } from "./plugins/forceMods.js";
import { HelpCommand } from "./plugins/help.js";
import { TelegramBot } from "./plugins/telegram.js";
import { PlayerStatsPlugin } from "./plugins/playerStats.js";
import { LiveStatus } from "./plugins/liveStatus.js";
import { KarmaPlugin } from "./plugins/karma.js";
import { ErrungenschaftenPlugin } from "./plugins/errungenschaften.js";
import { Rennleitung } from "./plugins/rennleitung.js";
import { NachrichtenKi } from "./plugins/nachrichtenKi.js";
import { Analyse } from "./plugins/analyse.js";
import { ServerSteuerung } from "./plugins/serverSteuerung.js";
import { CupPlugin } from "./plugins/cup.js";
import { MonatswechselAutomatik } from "./plugins/monatswechselAutomatik.js";
import { MenuPlugin } from "./plugins/menu.js";

// to add another plugin, uncomment and adjust this line:
// import { PluginClass } from './path/to/file.js';

/**
 * Klasse+Name je Plugin, damit disabledPlugins/cupModusPluginAllowlist (AP14a,
 * docs/CUP-PLAN.md) VOR der Instanziierung ausgewertet werden koennen -- der Name
 * selbst ist erst nach dem Konstruktor als Instanzfeld verfuegbar, Konstruktoren
 * haben aber Seiteneffekte (Telegram-Polling, Timer, Befehls-Registrierung), die bei
 * einem deaktivierten/nicht erlaubten Plugin nie ausgeloest werden duerfen. Der
 * "name"-Wert hier muss exakt dem "name"-Feld der jeweiligen Plugin-Klasse entsprechen.
 */
const PLUGIN_DEFINITIONEN = [
    { Klasse: SamplePlugin, name: 'Beispiel-Plugin' },
    { Klasse: Join, name: 'Beitritt und Abschied' },
    { Klasse: LocalRecords, name: 'Streckenrekorde' },
    { Klasse: AdminSuite, name: 'Admin-Werkzeuge' },
    { Klasse: ListsPlugin, name: 'Listen' },
    { Klasse: JukeboxPlugin, name: 'Jukebox' },
    { Klasse: ForceModsPlugin, name: 'Mod-Erzwingung' },
    { Klasse: HelpCommand, name: 'Hilfe' },
    { Klasse: TelegramBot, name: 'Telegram-Anbindung' },
    { Klasse: PlayerStatsPlugin, name: 'Spielerstatistiken' },
    { Klasse: LiveStatus, name: 'Live Status' },
    { Klasse: KarmaPlugin, name: 'Karma' },
    { Klasse: ErrungenschaftenPlugin, name: 'Errungenschaften' },
    { Klasse: Rennleitung, name: 'Rennleitung (KI-Kommentator)' },
    { Klasse: NachrichtenKi, name: 'Nachrichten-KI (Umformulierung)' },
    { Klasse: Analyse, name: 'Analyse (KI-Wochenbericht)' },
    { Klasse: ServerSteuerung, name: 'Server-Steuerung (Dashboard)' },
    { Klasse: CupPlugin, name: 'Cup' },
    { Klasse: MonatswechselAutomatik, name: 'Monatswechsel-Automatik' },
    { Klasse: MenuPlugin, name: 'Hauptmenü' },

    // to add another plugin, add a { Klasse, name } pair here:
    // { Klasse: PluginClass, name: 'Exakter name-Feld-Wert der Klasse' }
];

/**
 * Returns the list of ready plugins
 * @param {NextControl} nextcontrol NextControl instance
 */
export function getPluginList(nextcontrol) {
    const cupModus = process.env.CUP_MODUS === 'true';

    const definitionen = cupModus
        ? PLUGIN_DEFINITIONEN.filter((def) => Settings.cupModusPluginAllowlist.includes(def.name))
        : PLUGIN_DEFINITIONEN.filter((def) => !Settings.disabledPlugins.includes(def.name));

    return definitionen.map((def) => new def.Klasse(nextcontrol));
}
