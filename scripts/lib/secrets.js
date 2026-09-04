// secrets.js -- Laedt Zugangsdaten aus der zentralen .env-Datei (siehe auch
// controller/lib/secrets.js -- bewusst dupliziert, damit scripts/ unabhaengig
// vom controller/-Ordner nutzbar bleibt).

import { readFileSync, existsSync } from 'fs';

const SECRETS_PATH = process.env.TRACKMANIA_SECRETS_PATH || 'C:/LAN/trackma2020/secrets.env';

function ladeSecrets(pfad) {
    if (!existsSync(pfad)) {
        throw new Error(`Secrets-Datei nicht gefunden: ${pfad}`);
    }
    const werte = {};
    for (const zeile of readFileSync(pfad, 'utf8').split(/\r?\n/)) {
        const t = zeile.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i === -1) continue;
        werte[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return werte;
}

export const secrets = ladeSecrets(SECRETS_PATH);
