// cup-anlegen.js -- Cup-Turniersystem (Beta-Feature, siehe README): legt ein neues
// Cup-Turnier an (status:'anmeldung') und kuendigt es in der Telegram-Gruppe an.
// Schreibt GENAU EIN Dokument in `cupTurniere` -- danach uebernimmt
// controller/plugins/cup.js (laeuft im separaten Cup-Controller-Prozess) alles Weitere.
//
// SICHERHEIT: Ohne --live tut dieses Skript NICHTS ausser anzuzeigen, was
// passieren wuerde (keine DB-Schreibzugriffe, keine Telegram-Nachricht).
// Verweigert sich, wenn bereits ein offenes Turnier existiert (Format-Wahl,
// Teilnehmerpflege etc. gehoert dann zu diesem, nicht zu einem neuen).
//
// Aufruf (Vorschau, Standard-Test-DB):
//   node cup-anlegen.js --input cup-vorlage.json
// Echt anlegen (gegen die Test-DB, zum Ueben/Testen):
//   node cup-anlegen.js --input cup-vorlage.json --live
// Echt anlegen gegen die Live-DB (erst nach expliziter Freigabe des Betreibers!):
//   node cup-anlegen.js --input cup-vorlage.json --db nextcontrol --live

import { MongoClient } from 'mongodb';
import { mongoUri } from './lib/mongo.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { erzeugeTurnier } from '../controller/lib/cup/cupEngine.js';
import { sendeTelegramNachricht } from './lib/telegram.js';

const args = process.argv.slice(2);
function argWert(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const LIVE = args.includes('--live');
const DB_NAME = argWert('db', 'nextcontrol_test');
const INPUT_PATH = argWert('input', join(process.cwd(), 'cup-vorlage.json'));
const TELEGRAM_DRY_RUN = args.includes('--telegram-dry-run') || !LIVE;

console.log(`Cup anlegen gegen DB "${DB_NAME}"${LIVE ? '  *** LIVE ***' : ' (Vorschau -- nichts wird geschrieben)'}\n`);

if (!existsSync(INPUT_PATH)) {
    console.error(`Eingabedatei fehlt: ${INPUT_PATH}\nSiehe cup-vorlage.example.json als Vorlage.`);
    process.exit(1);
}
const eingabe = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));

let turnier;
try {
    turnier = erzeugeTurnier(eingabe);
} catch (error) {
    console.error(`Ungültige Eingabe: ${error.message}`);
    process.exit(1);
}
// cup-anlegen.js eroeffnet die Anmeldung direkt (kein separater manueller Schritt
// fuer den Uebergang angekuendigt -> anmeldung).
turnier.status = 'anmeldung';
turnier.ereignisLog.push({ zeit: new Date().toISOString(), text: 'Anmeldung eröffnet (cup-anlegen.js).' });

console.log(`Turnier: "${turnier.name}" (${turnier.format})`);
console.log(`Karten: ${turnier.config.maps.length}`);
console.log(`Geplanter Start: ${turnier.geplanterStart ?? '(keiner angegeben)'}`);

const client = new MongoClient(mongoUri());
await client.connect();
const db = client.db(DB_NAME);

try {
    const offene = await db.collection('cupTurniere').countDocuments({
        status: { $in: ['angekuendigt', 'anmeldung', 'laeuft', 'siegerehrung'] },
    });
    if (offene > 0) {
        console.error(`\nEs gibt bereits ${offene} offene(s) Turnier(e) in "${DB_NAME}" -- erst abschließen/abbrechen, bevor ein neues angelegt wird.`);
        process.exit(1);
    }

    if (LIVE) {
        const result = await db.collection('cupTurniere').insertOne(turnier);
        console.log(`\nAngelegt: ${result.insertedId}`);

        const nachricht =
            `🏆 <b>Neuer Cup: ${turnier.name}!</b>\n\n` +
            `Format: ${turnier.format === 'phasenko' ? 'Phasen-KO' : 'Knockout'}\n` +
            (turnier.geplanterStart ? `Start: ${new Date(turnier.geplanterStart).toLocaleString('de-DE')}\n` : '') +
            `\nMit /cup anmelden in Telegram anmelden (Account vorher per /link verknüpfen).`;
        await sendeTelegramNachricht(nachricht, { dryRun: TELEGRAM_DRY_RUN });
        console.log(TELEGRAM_DRY_RUN ? 'Telegram-Ankündigung (Trockenlauf, siehe oben).' : 'Telegram-Ankündigung verschickt.');
    } else {
        console.log('\n(Vorschau -- nichts geschrieben, --live zum tatsächlichen Anlegen)');
    }
} finally {
    await client.close();
}
process.exit(0);
