// monatswechsel.js -- CLI-Wrapper fuer den monatlichen Wechsel. Baut die eigene
// Mongo- und XML-RPC-Verbindung auf (fuer manuelle Laeufe/Tests gegen
// nextcontrol_test bzw. einen Trainingsserver) und ruft die geteilte Kernlogik
// aus controller/lib/monatswechsel/ablauf.js auf. Die automatische Live-Ausfuehrung
// aus dem laufenden Controller (controller/plugins/monatswechselAutomatik.js) nutzt
// dieselbe Kernlogik, aber die bereits offene Controller-Verbindung statt einer
// zweiten hier aufgebauten.
//
// SICHERHEIT: Ohne --live tut dieses Skript NICHTS ausser anzuzeigen, was
// passieren wuerde (keine DB-Schreibzugriffe, keine Datei wird geschrieben,
// kein XML-RPC-Aufruf, keine Telegram-Nachricht wird wirklich gesendet).
//
// Aufruf (Vorschau, Standard-Test-DB):
//   node monatswechsel.js --input naechster-monat.json
// Echt ausfuehren:
//   node monatswechsel.js --input naechster-monat.json --db nextcontrol --live
// Gegen einen Trainings-Server testen (siehe docs/ARBEITSPAKETE.md AP8):
//   node monatswechsel.js --input naechster-monat.json --live --xmlrpc-port 5556
//   node monatswechsel.js --input naechster-monat.json --live --skip-server   (nur DB, kein Server)

import { MongoClient } from 'mongodb';
import { mongoUri } from './lib/mongo.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import gbxremote from 'gbxremote';
import { fuehreMonatswechselDurch } from '../controller/lib/monatswechsel/ablauf.js';
import { sendeTelegramNachricht } from './lib/telegram.js';
import { secrets } from './lib/secrets.js';

// -- Argumente --------------------------------------------------------------
const args = process.argv.slice(2);
function argWert(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const LIVE = args.includes('--live');
const DB_NAME = argWert('db', 'nextcontrol_test');
const INPUT_PATH = argWert('input', join(process.cwd(), 'naechster-monat.json'));
const XMLRPC_PORT = Number(argWert('xmlrpc-port', '5555'));
const SKIP_SERVER = args.includes('--skip-server');
const MONAT_OVERRIDE = argWert('monat', null);
const TELEGRAM_DRY_RUN = args.includes('--telegram-dry-run') || !LIVE;

console.log(`Monatswechsel gegen DB "${DB_NAME}"${LIVE ? '  *** LIVE ***' : ' (Vorschau -- nichts wird geschrieben)'}\n`);

if (!existsSync(INPUT_PATH)) {
    console.error(`Eingabedatei fehlt: ${INPUT_PATH}\nSiehe naechster-monat.example.json als Vorlage.`);
    process.exit(1);
}
const naechsterMonat = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));

const client = new MongoClient(mongoUri());
await client.connect();
const db = client.db(DB_NAME);

let gbxClient = null;

try {
    const ergebnis = await fuehreMonatswechselDurch({
        db,
        naechsterMonat,
        live: LIVE,
        monatOverride: MONAT_OVERRIDE,
        skipServer: SKIP_SERVER,
        query: SKIP_SERVER ? null : async (methode, methodenArgs) => {
            if (!gbxClient) gbxClient = await verbindeMitServer(XMLRPC_PORT);
            return gbxClient.query(methode, methodenArgs);
        },
        telegramSenden: (text) => sendeTelegramNachricht(text, { dryRun: TELEGRAM_DRY_RUN }),
    });

    if (!ergebnis.erfolgreich) {
        console.error(`\nABBRUCH (Schritt: ${ergebnis.schritt}): ${ergebnis.fehler}`);
        process.exitCode = 1;
    }
} finally {
    gbxClient?.terminate?.();
    await client.close();
}

// Erzwingt den Prozessabbruch, falls der gbxremote-Socket offen bleibt (kein .terminate()).
process.exit(process.exitCode ?? 0);

/**
 * Verbindet sich per XML-RPC mit dem Dedicated Server und authentifiziert sich.
 * @param {number} port
 * @returns {Promise<{query: (methode:string, args:any[]) => Promise<any>, terminate?: () => void}>}
 */
function verbindeMitServer(port) {
    return new Promise((resolve, reject) => {
        const client = gbxremote.createClient(port);
        client.on('error', (e) => reject(new Error(`Verbindung zum Server (Port ${port}) fehlgeschlagen: ${e.message}`)));
        client.on('connect', async () => {
            try {
                await client.query('SetApiVersion', ['2019-03-02']);
                await client.query('Authenticate', ['SuperAdmin', secrets.SUPERADMIN_PASSWORD]);
                resolve(client);
            } catch (e) {
                reject(e);
            }
        });
    });
}
