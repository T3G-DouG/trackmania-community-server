// telegram.js -- Minimaler Telegram-Sender fuer Standalone-Skripte (Monatswechsel u.a.).
// Nutzt dieselben Zugangsdaten wie der Controller (secrets.env).

import https from 'https';
import querystring from 'querystring';
import { secrets } from './secrets.js';

// Test-Modus: TELEGRAM_TEST_BOT=true node monatswechsel.js ... -> nutzt den dedizierten
// Test-Bot statt des produktiven Bots (gleiche Konvention wie controller/settings.js).
const TELEGRAM_TOKEN = process.env.TELEGRAM_TEST_BOT === 'true' ? secrets.TELEGRAM_TOKEN_TEST : secrets.TELEGRAM_TOKEN;

/**
 * Sendet eine Nachricht an die konfigurierte Telegram-Gruppe.
 * @param {string} text
 * @param {{dryRun?: boolean}} [optionen]
 */
export function sendeTelegramNachricht(text, { dryRun = false } = {}) {
    if (dryRun) {
        console.log(`[Telegram Trockenlauf]\n${text}\n`);
        return Promise.resolve();
    }
    const postData = querystring.stringify({ chat_id: secrets.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve(data));
            }
        );
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}
