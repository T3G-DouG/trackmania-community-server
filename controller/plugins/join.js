import { Sentences } from '../lib/sentences.js'
import { logger, format, stripFormatting } from '../lib/utilities.js'
import { formuliereChatNachrichtUm } from '../lib/kiEnrich.js'
import { protokolliere } from '../lib/eventLog.js'
import { NextControl } from '../nextcontrol.js'
import { Settings } from '../settings.js'
let dbtype = Settings.usedDatabase.toLocaleLowerCase();
import * as Classes from '../lib/classes.js'

/**
 * Join and leave message plugin
 */
export class Join {

    name           = 'Beitritt und Abschied'
    author         = 'dassschaf'
    description    = 'Meldet Beitritt und Verlassen des Servers im Chat'

    /**
     * Local reference to the main instance
     * @type {NextControl}
     */
    nextcontrol

    /**
     * Constructor, registering the chat commands at the main class upon plugin loading
     * @param {NextControl} nextcontrol 
     */
    constructor(nextcontrol) {
        // save reference
        this.nextcontrol = nextcontrol;
    }

    /**
     * Function run, when a player joins the server
     * @param {Classes.PlayerInfo} player Player info
     * @param {Boolean} isSpectator whether player spectates or not
     */
    async onPlayerConnect(player, isSpectator) {

        const name = stripFormatting(player.name);

        if (dbtype === 'mongodb') {
            const result = await this.nextcontrol.mongoDb.collection('players').updateOne(
                { login: player.login },
                { $set: { login: player.login, name: player.name }, $setOnInsert: { firstSeen: new Date() } },
                { upsert: true }
            );
            if (result.upsertedCount === 1) {
                await protokolliere(this.nextcontrol, 'erstbesuch', `✨ ${name} ist zum allerersten Mal auf dem Server!`, player.login);
            }
        } else if (dbtype === 'mysql') {
            this.nextcontrol.mysql.query('SELECT * FROM players WHERE login = ?', [player.login]).then(rows=>{
                if (rows.length === 0) {
                    this.nextcontrol.mysql.query('INSERT INTO players (login, name) VALUES (?,?)', [player.login, player.name]).catch(err => {
                        if (err) {
                            logger('er', err);
                        }
                    });
                } else {
                    // If the player exists, update the name
                    this.nextcontrol.mysql.query('UPDATE players SET name = ? WHERE login = ?', [player.name, player.login]).catch(err => {
                        if (err) {
                            logger('er', err);
                        }
                    });
                }
            }).catch(err=>{
                logger('er', err);
            });
        }

        if (Settings.admins.includes(player.login)) {
            logger('r','Admin ' + name + ' has joined the server');
            const nachricht = await formuliereChatNachrichtUm(format(Sentences.adminConnect, { player: player.name }), { pruefWoerter: [name], sprache: 'en' });
            await this.nextcontrol.client.query('ChatSendServerMessage', [nachricht]);
        }

        else {
            logger('r', name + ' has joined the server');
            const nachricht = await formuliereChatNachrichtUm(format(Sentences.playerConnect, { player: player.name }), { pruefWoerter: [name], sprache: 'en' });
            await this.nextcontrol.client.query('ChatSendServerMessage', [nachricht]);
        }
    }

    /**
     * Function run, when a player disconnects
     * @param {Classes.PlayerInfo} player Playerinfo of leaving player
     * @param {String} reason Reason for disconnection
     */
    async onPlayerDisconnect(player, reason) {
        const name = stripFormatting(player.name);
        logger('r', name + ' has left the server, reason: ' + reason);
        const nachricht = await formuliereChatNachrichtUm(format(Sentences.playerDisconnect, { player: player.name }), { pruefWoerter: [name], sprache: 'en' });
        await this.nextcontrol.client.query('ChatSendServerMessage', [nachricht]);
    }
}