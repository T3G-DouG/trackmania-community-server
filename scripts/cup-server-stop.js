// cup-server-stop.js -- Cup-Turniersystem (Beta-Feature): stoppt den (Test-)Cup-
// Dedicated-Server sauber per XML-RPC statt per Prozess-Kill. Eigener, minimaler
// gbxremote-Client nach dem Muster von monatswechsel.js -- absichtlich NICHT der
// Controller-Client (nextcontrol.js), da dieses Skript unabhaengig vom Controller
// laufen koennen soll (z.B. wenn der Cup-Controller bereits abgestuerzt ist).
//
// Nutzung:
//   node cup-server-stop.js --xmlrpc-port 5556   (Test: Trainings-Server-Rolle)
//   node cup-server-stop.js --xmlrpc-port 5557   (echt, erst nach expliziter Freigabe)
//   node cup-server-stop.js                      (Default: 5557)

import gbxremote from 'gbxremote';
import { secrets } from './lib/secrets.js';

function argWert(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const XMLRPC_PORT = Number(argWert('xmlrpc-port', '5557'));

console.log(`[Cup-Server-Stop] Verbinde zu Port ${XMLRPC_PORT} ...`);

try {
    await stoppeServer(XMLRPC_PORT);
    console.log('[Cup-Server-Stop] StopServer erfolgreich ausgeloest.');
} catch (e) {
    console.error(`[Cup-Server-Stop] Fehlgeschlagen: ${e.message}`);
    process.exitCode = 1;
}

// Erzwingt den Prozessabbruch, falls der gbxremote-Socket offen bleibt (kein .terminate()).
process.exit(process.exitCode ?? 0);

/**
 * Verbindet sich per XML-RPC mit dem Dedicated Server und ruft StopServer auf
 * (existierende Methode, per system.methodSignature verifiziert -- "QuitServer"/
 * "QuitApplication" aus der ersten Grobplanung existieren auf diesem Server NICHT).
 * @param {number} port
 */
function stoppeServer(port) {
    return new Promise((resolve, reject) => {
        const client = gbxremote.createClient(port);
        client.on('error', (e) => reject(new Error(`Verbindung zum Server (Port ${port}) fehlgeschlagen: ${e.message}`)));
        client.on('connect', async () => {
            try {
                await client.query('SetApiVersion', ['2019-03-02']);
                await client.query('Authenticate', ['SuperAdmin', secrets.SUPERADMIN_PASSWORD]);
                await client.query('StopServer');
                client.terminate?.();
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}
