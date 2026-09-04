import { NextControl  } from "../nextcontrol.js";
import { WaypointInfo } from "../lib/classes.js";
import { MatchResults } from "../lib/callbackparams.js";
import { logger } from "../lib/utilities.js";

/** Aufbewahrungsdauer der Session-Dokumente (Tage) -- TTL-Index raeumt automatisch auf. */
const SESSION_TTL_TAGE = 400;

// Player Statistics plugin
export class PlayerStatsPlugin {

    name = 'Spielerstatistiken'
    author = 'dassschaf'
    description = 'Stellt Spielerstatistiken auf dem Server bereit.'

    /**
     * Contains the time of joining when a player joins the server
     * @type {Map<string, Number>}
     */
    joinTimes

    /**
     * Constructs the plugin.
     * @param {NextControl} nc
     */
    constructor(nc) {
        this.nc = nc;
        this.joinTimes = new Map();
        this.nc.addRequiredCollection('playerStats');
        this.nc.addRequiredCollection('spielerSessions');
        this.nc.mongoDb.collection('spielerSessions')
            .createIndex({ von: 1 }, { expireAfterSeconds: SESSION_TTL_TAGE * 24 * 3600 })
            .catch((error) => logger('er', `PlayerStats: TTL-Index auf spielerSessions fehlgeschlagen: ${error.message}`));
    }

    /**
     * Saves the player stats to the database
     * @param {PlayerStats} stats
     * @returns {Promise<void>}
     */
    async saveStats(stats) {
        // Schutz: niemals einen Datensatz mit leerem Login anlegen (Backstop fuer
        // Phantom-Events des Servers z.B. bei Map-Uebergaengen -> sonst entsteht ein
        // unsichtbarer playerStats-Eintrag mit login:"").
        if (!stats || !stats.login) return;
        await this.nc.mongoDb.collection('playerStats').updateOne(
            { login: stats.login },
            { $set: stats },
            { upsert: true }
        );
    }

    /**
     * Loads the player statistics from database or creates a new object if none can be found.
     * @param {String} login
     * @returns {Promise<PlayerStats>}
     */
    async loadStats(login) {
        const doc = await this.nc.mongoDb.collection('playerStats').findOne({ login: login });
        if (doc) {
            return Object.assign(new PlayerStats(login), doc);
        } else {
            return new PlayerStats(login);
        }
    }

    /**
     * Run on player connection
     * FIX: Framework passes a PlayerInfo object, not a login string
     * @param {import('../lib/classes.js').PlayerInfo} player
     * @param {Boolean} isSpec
     * @returns {Promise<void>}
     */
    async onPlayerConnect(player, isSpec) {
        if (!player || !player.login) return; // Schutz gegen leere Logins
        this.joinTimes.set(player.login, Date.now());
        const stats = await this.loadStats(player.login);
        stats.connections += 1;
        stats.connectionsMonat += 1;
        await this.saveStats(stats);
    }

    /**
     * Run on player passing waypoint
     * @param {WaypointInfo} waypointInfo
     * @returns {Promise<void>}
     */
    async onWaypoint(waypointInfo) {
        if (!waypointInfo || !waypointInfo.login) return; // Schutz gegen leere Logins
        const login = waypointInfo.login;
        const stats = await this.loadStats(login);

        if (waypointInfo.isEndRace) {
            stats.finishes += 1;
            stats.finishesMonat += 1;
        } else {
            stats.checkpoints += 1;
            stats.checkpointsMonat += 1;
        }
        await this.saveStats(stats);
    }

    /**
     * Run when a player leaves the server
     * FIX: Framework passes a PlayerInfo object, not a login string
     * @param {import('../lib/classes.js').PlayerInfo} player
     * @param {String} reason
     * @returns {Promise<void>}
     */
    async onPlayerDisconnect(player, reason) {
        if (!player || !player.login) return; // Schutz gegen leere Logins
        const stats = await this.loadStats(player.login);

        if (this.joinTimes.has(player.login)) {
            const von = new Date(this.joinTimes.get(player.login));
            const bis = new Date();
            const minuten = Math.floor((bis.getTime() - von.getTime()) / 60000);
            stats.timePlayed += minuten;
            stats.timePlayedMonat += minuten;
            this.joinTimes.delete(player.login);
            // Eigenes try/catch: das Session-Tracking (nur Grundlage fuer spaetere
            // Analysen) darf NIEMALS die schon vorher bestehende, wichtigere saveStats()
            // darunter verhindern -- weder durch einen Wurf hier noch durch eine
            // unhandled rejection (es gibt keinen globalen Handler im Controller).
            try {
                await this.nc.mongoDb.collection('spielerSessions').insertOne({ login: player.login, von, bis, dauerMin: minuten });
            } catch (error) {
                logger('er', `PlayerStats: spielerSessions-Insert fehlgeschlagen (Statistik wird trotzdem gespeichert): ${error.message}`);
            }
        }
        await this.saveStats(stats);
    }

    /**
     * Run on the end of a match
     * @param {MatchResults} results
     * @returns {Promise<void>}
     */
    async onEndMatch(results) {
        if (results && results.winner) {
            const stats = await this.loadStats(results.winner);
            stats.wins += 1;
            await this.saveStats(stats);
        }
    }
}

/**
 * Class describing the player statistics, giving the structure of database documents used by this plugin
 */
export class PlayerStats {
    /**
     * Constructs an empty instance for player 'login'.
     * @param {String} login
     */
    constructor(login) {
        this.login = login;
        this.wins = 0;
        // Lifetime-Akkumulatoren (bleiben ueber Monatswechsel erhalten)
        this.timePlayed = 0;
        this.connections = 0;
        this.finishes = 0;
        this.checkpoints = 0;
        // Monats-Zaehler (werden beim Monatswechsel auf 0 gesetzt, siehe scripts/monatswechsel.js)
        this.timePlayedMonat = 0;
        this.connectionsMonat = 0;
        this.finishesMonat = 0;
        this.checkpointsMonat = 0;
    }
}