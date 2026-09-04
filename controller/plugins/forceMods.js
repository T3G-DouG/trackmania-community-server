import { NextControl } from "../nextcontrol.js";
import fs from 'fs';
import * as Classes from '../lib/classes.js';
import { ServerLib } from '../lib/serverLib.js';
import { Sentences } from "../lib/sentences.js";
import { kodiereAktion, dekodiereAktion, pruefeAdmin, schliesseMenue } from '../lib/manialinkMenu.js';

const AKTION_PRAEFIX = 'mods';

const settingsPath = './settings/forceMods.json'

const defaultSettings = {
    override: false
}

export class ForceModsPlugin {

    name = 'Mod-Erzwingung'

    author = 'dassschaf'

    description = 'Fügt Werkzeuge zum Erzwingen von Mods auf dem Server hinzu'

    initialApplication = false;

    /**
     * Constructs the plugin
     * @param {NextControl} nc
     */
    constructor(nc) {
        // save reference
        this.nc = nc;

        this.server = new ServerLib(nc);

        if (fs.existsSync('.' + settingsPath))
            this.settings = fs.readdirSync('.' + settingsPath)
        else {
            this.settings = defaultSettings;

            // write settings file
            this.saveSettings();
        }

        nc.registerAdminCommand(new Classes.ChatCommand('modserzwingen', this.forceModsCommand, 'Aktiviert, deaktiviert oder ändert erzwungene Mods auf dem Server', this.name));

        // Menue-Eintraege -- nur der feste Schluesselwort-Teil, die Mod-URL-Freitext-
        // Ausnahme bleibt bewusst nur Chat-Befehl (Muster wie //hinzufuegen, siehe admin.js).
        const modsEintrag = (label, op) => new Classes.MenuEintrag(
            'Admin · Server', label, kodiereAktion(AKTION_PRAEFIX, op), { adminOnly: true, pluginName: this.name }
        );
        nc.registerMenuEintrag(modsEintrag('Mod-Erzwingung speichern', 'save'));
        nc.registerMenuEintrag(modsEintrag('Mod-Erzwingung neu einlesen', 'read'));
        nc.registerMenuEintrag(modsEintrag('Mod-Erzwingung zurücksetzen', 'reset'));
        nc.registerMenuEintrag(modsEintrag('Mod-Erzwingung deaktivieren', 'disable'));
        nc.registerMenuEintrag(modsEintrag('Mod-Erzwingung aktivieren', 'enable'));
    }

    /**
     * Function run, when a player clicks a Mod-Erzwingung-Menue-Knopf.
     * @param {CallbackParams.ManialinkPageAnswer} params
     */
    async onManialinkPageAnswer(params) {
        const { namespace, teile } = dekodiereAktion(params.answer);
        if (namespace !== AKTION_PRAEFIX) return;

        const login = params.login;
        if (!pruefeAdmin(this.nc, login)) return;

        await this.forceModsCommand(login, [teile[0]]);
        await schliesseMenue(this.nc, login);
    }

    /**
     * Chat command of the plugin
     * @param {String} login
     * @param {Array<String>} params
     * @returns {Promise<void>}
     */
    async forceModsCommand(login, params) {

        // The plugin currently supports TM2020 only.
        // for more environments, adjust:
        //  - params to be treated as [ENVI, URL]

        if (params.length === 0) {
            await this.server.chatMessageToLogin(login, Sentences.admin.forceMod.invalid);
            return;
        }

        // save settings
        if (params[0] === 'save') {
            this.saveSettings()
            await this.server.chatMessageToLogin(login, Sentences.admin.forceMod.saved);
            return;
        }

        // load settings
        if (params[0] === 'read') {
            this.readSettings()
            await this.applySettings();
            await this.server.chatMessageToLogin(login, Sentences.admin.forceMod.read);
            return;
        }

        // reset settings
        if (params[0] === 'reset') {
            this.resetSettings();
            await this.applySettings();
            await this.server.chatMessageToLogin(login, Sentences.admin.forceMod.reset);
            return;
        }

        // disable override
        if (params[0] === 'disable') {
            this.settings.override = false;
            await this.applySettings();
            await this.server.chatMessageToLogin(login, Sentences.admin.forceMod.overrideOff);
            return;
        }

        // enable override
        if (params[0] === 'enable') {
            this.settings.override = true;
            await this.applySettings();
            await this.server.chatMessageToLogin(login, Sentences.admin.forceMod.overrideOn);
            return;
        }

        // Otherwise the parameter is an URL (hopefully)
        const envi = 'Stadium',
            url = params.shift();

        this.settings[envi] = url;
        await this.applySettings();
        await this.server.chatMessageToLogin(login, Sentences.admin.forceMod.applied);
    }

    /**
     * Saves the settings
     */
    saveSettings() {
        let jsonString = JSON.stringify(this.settings);
        fs.writeFileSync(settingsPath, jsonString);
    }

    /**
     * Reads the settings from file
     */
    readSettings() {
        if (fs.existsSync(settingsPath))
            this.settings = fs.readdirSync(settingsPath)
        else {
            this.settings = defaultSettings;

            // write settings file
            this.saveSettings();
        }
    }

    resetSettings() {
        this.settings = defaultSettings;
    }

    /**
     * Applies the current settings to the server
     * @returns {Promise<void>}
     */
    async applySettings() {
        // make array of structs like the server wants
        let modArray = [];
        Object.keys(this.settings).forEach(key => {
            if (key !== 'override')
                modArray.push({Env: key, Url: this.settings[key]});
        })

        // send settings to server
        await this.nc.client.query('SetForcedMods', [this.settings.override, modArray]);
    }

    /**
     * Function run on map end --- will apply the mod settings after NextControl launches once.
     * @param {Classes.Map} map
     * @returns {Promise<void>}
     */
    async onEndMap(map) {
        if (!this.initialApplication)
            await this.applySettings();
    }
}
