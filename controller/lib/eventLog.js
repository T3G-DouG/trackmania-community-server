import { logger } from './utilities.js'

/** Maximale Anzahl an Einträgen in der serverEvents-Collection (ältere werden automatisch entfernt). */
const MAX_EVENTS = 300;

/**
 * Schreibt ein Ereignis für das Live-Dashboard der Website in die Collection `serverEvents`.
 * Fehler werden nur geloggt, nie nach oben geworfen -- ein Logging-Problem darf nie eine
 * Spieler- oder Admin-Aktion zum Absturz bringen.
 * @param {import('../nextcontrol.js').NextControl} nextcontrol
 * @param {string} typ Kurzer Kategorie-Schlüssel, z.B. 'verbindung', 'strecke', 'rekord', 'admin', 'voting'
 * @param {string} text Bereits klartext-formatierter, deutscher Anzeigetext (keine Trackmania-Farbcodes)
 * @param {string|null} [login] Optionaler Login, dem das Ereignis zuzuordnen ist (z.B. 'erstbesuch', AP15h Rennleitung-Kontext).
 *   Wird NIE an api.php durchgereicht (dortiges Feld-Whitelisting gibt nur typ/text/zeit aus) --
 *   ausschließlich fuer serverseitige Weiterverarbeitung (z.B. Dossier-Lookup).
 */
export async function protokolliere(nextcontrol, typ, text, login = null) {
    try {
        await nextcontrol.mongoDb.collection('serverEvents').insertOne({ typ, text, zeit: new Date(), login });

        const anzahl = await nextcontrol.mongoDb.collection('serverEvents').countDocuments();
        if (anzahl > MAX_EVENTS) {
            const ueberschuss = await nextcontrol.mongoDb.collection('serverEvents')
                .find({}, { projection: { _id: 1 } })
                .sort({ zeit: 1 })
                .limit(anzahl - MAX_EVENTS)
                .toArray();
            await nextcontrol.mongoDb.collection('serverEvents').deleteMany({ _id: { $in: ueberschuss.map((e) => e._id) } });
        }
    } catch (error) {
        logger('er', `eventLog: Fehler beim Protokollieren: ${error.message}`);
    }
}
