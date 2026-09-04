import { NextControl } from '../nextcontrol.js'
import { MatchResults } from '../lib/callbackparams.js';
import { Sentences } from '../lib/sentences.js';
import * as Classes from '../lib/classes.js';
import { logger, stripFormatting, format } from '../lib/utilities.js';
import { kodiereAktion, dekodiereAktion, pruefeAdmin, schliesseMenue } from '../lib/manialinkMenu.js';

const AKTION_PRAEFIX = 'jukebox';

export class JukeboxPlugin {
    name = 'Jukebox'
    author = 'dassschaf'
    description = 'Fügt eine Jukebox-Funktion hinzu.'

    /**
     * Local reference to the main instance
     * @type {NextControl}
     */
    nextcontrol

    /**
     * 
     * @param {NextControl} nc 
     */
    constructor(nc) {
        nc.registerChatCommand(new Classes.ChatCommand('jukebox', this.jukeboxCommand, 'Reiht eine Karte in die Jukebox ein.', this.name));
        nc.registerAdminCommand(new Classes.ChatCommand('jukebox', this.jukeboxAdmin, 'Admin-Jukebox-Kommando.', this.name));

        // AP17f: Menue-Eintraege -- "Karte in Jukebox einreihen" bewusst NICHT im Menue
        // (Betreiber-Wunsch 2026-09-01), /jukebox <id> bleibt Chat-Befehl. Nur die
        // Admin-Aktion "Jukebox leeren" bleibt im Menue.
        nc.registerMenuEintrag(new Classes.MenuEintrag(
            'Admin · Server', 'Jukebox leeren', kodiereAktion(AKTION_PRAEFIX, 'clear'), { adminOnly: true, pluginName: this.name }
        ));

        // save reference
        this.nextcontrol = nc;
    }

    /**
     * 
     * @param {String} login 
     * @param {Array<String>} params 
     */
    async jukeboxAdmin(login, params) {
        if (params[0] === 'clear') {
            // clear jukebox:
            this.nextcontrol.jukebox.reset();

            await this.nextcontrol.client.query('ChatSendServerMessage', [format(Sentences.jukebox.cleared, {name: this.nextcontrol.status.getPlayer(login).name})]);
            logger('r', `Jukebox: ${stripFormatting(this.nextcontrol.status.getPlayer(login).name)} has cleared the jukebox.`);
        
            // if params[1] is a number:
        } else if (!isNaN(Number(params[0]))) {
            // priority jukebox:
            await this.jukebox(login, params[0], true);            
        }
    }

    /**
     * Jukeboxing command
     * @param {String} login 
     * @param {Array<String>} params 
     */
    async jukeboxCommand(login, params) {
        if (params.length !== 1) {
            await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [Sentences.jukebox.requiresId, login]);
            return;
        }

        await this.jukebox(login, params[0], false);
    }

    async jukebox(login, idInput, priority) {

        // check if map query list is empty:
        if (this.nextcontrol.lists.maps.has(login) && this.nextcontrol.lists.maps.get(login).length > 0) {

            let id = Number(idInput);

            // check if valid number
            if (isNaN(id)) {
                await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [Sentences.jukebox.invalidNumber, login]);
                return;
            }

            // check if valid index
            if (this.nextcontrol.lists.maps.get(login).length < id - 1) {
                await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [format(Sentences.jukebox.invalidIndex, {lo: 0, hi: this.nextcontrol.lists.maps.get(login).length - 1}), login]);
                return;
            }
            
            let map = this.nextcontrol.lists.maps.get(login)[id],
                player = this.nextcontrol.status.getPlayer(login);

            if (!priority) {
                this.nextcontrol.jukebox.queueMap(map, player);

                await this.nextcontrol.client.query('ChatSendServerMessage', [format(Sentences.jukebox.hasQueued, {name: this.nextcontrol.status.getPlayer(login).name, map: map.name})]);
                logger('r', `Jukebox: ${stripFormatting(player.name)} has successfully jukeboxed map ${stripFormatting(map.name)}.`);
            } else {
                this.nextcontrol.jukebox.priorityAdd(map, player);

                await this.nextcontrol.client.query('ChatSendServerMessage', [format(Sentences.jukebox.priorityAdd, {name: this.nextcontrol.status.getPlayer(login).name, map: map.name})]);
                logger('r', `Jukebox: ${stripFormatting(player.name)} has set next played map to ${stripFormatting(map.name)}.`);
            }

        } else {
            // tell the user to first query for maps
            await this.nextcontrol.client.query('ChatSendServerMessageToLogin', [Sentences.jukebox.requiresList, login]);
        }
    }

    /**
     * Function run on match end to check for Jukebox things
     * @param {MatchResults} results 
     */
    async onEndMatch(results) {
        // jukebox stuff
        if (!this.nextcontrol.jukebox.isEmpty()) {

            let entry = this.nextcontrol.jukebox.unqueueMap(),
                abort = false;

            // broken as of now, will fix sometime else
            /*while (!this.nextcontrol.status.playerOnline(entry.player.login) && !abort) {
                // skip jukebox submission:
                await this.nextcontrol.client.query('ChatSendServerMessage', [format(Sentences.jukebox.leftSkipWish, {name: entry.player.name, map: entry.map.name})]);
                logger('r', `Jukebox: Skipping queue entry for map ${stripFormatting(entry.map.name)} as requested by ${entry.player.name} because player left.`);
        
                if (!this.nextcontrol.jukebox.isEmpty())
                    entry = this.nextcontrol.jukebox.unqueueMap();

                else
                    abort = true;
            }*/
            
            if (!abort) {
                await this.nextcontrol.client.query('SetNextMapIdent', [entry.map.uid]);
                await this.nextcontrol.client.query('ChatSendServerMessage', [format(Sentences.jukebox.nextMapIs, {name: entry.player.name, map: entry.map.name})]);

                logger('r', `Jukebox: Set next map to ${stripFormatting(entry.map.name)} as requested by ${entry.player.name}`);
            }
        }
    }

    /**
     * Function run, when a player clicks a Jukebox-Menue-Knopf.
     * @param {CallbackParams.ManialinkPageAnswer} params
     */
    async onManialinkPageAnswer(params) {
        const { namespace, teile } = dekodiereAktion(params.answer);
        if (namespace !== AKTION_PRAEFIX) return;

        const login = params.login;

        if (teile[0] === 'clear') {
            if (!pruefeAdmin(this.nextcontrol, login)) return;
            await this.jukeboxAdmin(login, ['clear']);
            await schliesseMenue(this.nextcontrol, login);
        }
    }
}