// analyse-lauf.js -- AP15d: fuehrt einen Analyse-Lauf durch (laden -> rechnen -> texten
// mit Zahlen-/Namens-Guard -> kiAnalysen-Insert) und verschickt optional den
// Telegram-Kompaktbericht.
//
// SICHERHEIT: Ohne --live wird NICHTS in die Datenbank geschrieben und KEINE echte
// Telegram-Nachricht verschickt. ACHTUNG, Abweichung vom sonstigen Vorschau-Muster
// (z.B. monatswechsel.js): KI-Aufrufe (mit echten API-Kosten!) passieren AUCH im
// Vorschau-Modus, weil sie zur Guard-Verifikation gehoeren -- fuer eine wirklich
// kostenlose Vorschau zusaetzlich KI_DRY_RUN=true setzen.
//
// Aufruf (Vorschau, Trockenlauf, KEINE echten API-Kosten):
//   KI_DRY_RUN=true node analyse-lauf.js --db nextcontrol_test
// Vorschau mit echten KI-Aufrufen (kostet echtes Geld, schreibt aber nichts in die DB):
//   node analyse-lauf.js --db nextcontrol_test
// Echt ausfuehren (DB-Schreibzugriff + Telegram-Test-Bot):
//   TELEGRAM_TEST_BOT=true node analyse-lauf.js --db nextcontrol_test --live
// Telegram-Versand unabhaengig von --live im Trockenlauf halten:
//   node analyse-lauf.js --live --telegram-dry-run
// Berichtstyp waehlen (Default woche): --typ woche|monat

import { MongoClient } from 'mongodb';
import { fuehreAnalyseLaufDurch } from '../controller/lib/analyse/berichtLauf.js';
import { sendeTelegramNachricht } from './lib/telegram.js';

const args = process.argv.slice(2);
function argWert(name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const LIVE = args.includes('--live');
const DB_NAME = argWert('db', 'nextcontrol_test');
const TELEGRAM_DRY_RUN = args.includes('--telegram-dry-run') || !LIVE;
const BERICHT_TYP = argWert('typ', 'woche') === 'monat' ? 'monat' : 'woche';

console.log(`Analyse-Lauf (${BERICHT_TYP}) gegen DB "${DB_NAME}"${LIVE ? '  *** LIVE ***' : ' (Vorschau -- kein DB-Schreibzugriff)'}`);
console.log(`KI-Aufrufe: ${process.env.KI_DRY_RUN === 'true' ? 'Trockenlauf (kein echter API-Call)' : 'ECHT (verursacht API-Kosten, unabhaengig von --live)'}\n`);

const client = new MongoClient('mongodb://localhost:27017');
await client.connect();
const db = client.db(DB_NAME);

try {
    const dokument = await fuehreAnalyseLaufDurch(db, { ausloeser: 'manuell', berichtTyp: BERICHT_TYP, live: LIVE });

    if (!dokument) {
        console.error('Analyse-Lauf fehlgeschlagen (siehe Fehlermeldung oben).');
        process.exitCode = 1;
    } else {
        console.log(`Status: ${dokument.textStatus}`);
        console.log(`Zeitraum: ${dokument.zeitraum.vonMonat ?? '-'} bis ${dokument.zeitraum.bisMonat ?? '-'}`);
        console.log(`Modell: ${dokument.modell}\n`);

        console.log(`-- Gesamtzusammenfassung --\n${dokument.texte.zusammenfassung ?? '(kein Text)'}\n`);
        for (const a of dokument.texte.abschnitte) {
            console.log(`-- ${a.schluessel} (${a.status}) --\n${a.text ?? '(kein Text)'}\n`);
        }
        console.log(`-- Telegram-Kompaktbericht --\n${dokument.telegramBericht}\n`);

        await sendeTelegramNachricht(dokument.telegramBericht, { dryRun: TELEGRAM_DRY_RUN });

        if (LIVE && !TELEGRAM_DRY_RUN) {
            await db.collection('kiAnalysen').updateOne({ _id: dokument._id }, { $set: { telegramGesendetAm: new Date() } });
            console.log('Telegram-Nachricht verschickt, telegramGesendetAm gesetzt.');
        } else if (LIVE) {
            console.log(`kiAnalysen-Dokument gespeichert (_id: ${dokument._id}). Telegram-Versand war Trockenlauf.`);
        } else {
            console.log('(Vorschau -- nichts wurde in die DB geschrieben, --live zum Ausführen.)');
        }
    }
} finally {
    await client.close();
}
