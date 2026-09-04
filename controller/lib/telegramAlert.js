import https from 'https'
import querystring from 'querystring'
import { Settings } from '../settings.js'
import { logger } from './utilities.js'

/**
 * Gemeinsamer HTTPS-Kern: sendet eine Telegram-Nachricht an eine beliebige chatId.
 * Nutzt dieselben Zugangsdaten/Toggles wie das Plugin (Settings.telegram, inkl.
 * TELEGRAM_TEST_BOT-Umschaltung aus settings.js). Nur senden, kein Polling --
 * daher kein Token-Konflikt mit der TelegramBot-Plugin-Instanz.
 * @param {string|number} chatId
 * @param {string} text
 * @returns {Promise<*>}
 */
function sende(chatId, text) {
    const postData = querystring.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    return new Promise((resolve) => {
        const req = https.request(
            {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${Settings.telegram.token}/sendMessage`,
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve(data));
            }
        );
        req.on('error', (error) => {
            logger('er', `telegramAlert: Fehler beim Senden: ${error.message}`);
            resolve(null);
        });
        req.write(postData);
        req.end();
    });
}

/**
 * Minimaler, von der TelegramBot-Plugin-Instanz unabhaengiger Telegram-Sender fuer
 * Systemwarnungen (z.B. Datenbank-Aussetzer), die auch ausserhalb des telegram.js-Plugins
 * ausgeloest werden koennen. Geht an die Gruppen-chatId.
 * @param {string} text
 */
export function sendeTelegramWarnung(text) {
    if (Settings.telegram.dryRun) {
        logger('w', `Telegram-Warnung (Trockenlauf): ${text}`);
        return Promise.resolve();
    }
    return sende(Settings.telegram.chatId, text);
}

/**
 * Private Telegram-Direktnachricht an einen einzelnen Nutzer (z.B. Errungenschaften-DM
 * aus errungenschaften.js), unabhaengig von der Plugin-Instanz.
 * @param {string|number} chatId Telegram-User-Id des Empfaengers
 * @param {string} text
 */
export function sendeTelegramDm(chatId, text) {
    if (Settings.telegram.dryRun) {
        logger('r', `Telegram-DM (Trockenlauf, an ${chatId}): ${text}`);
        return Promise.resolve();
    }
    return sende(chatId, text);
}
