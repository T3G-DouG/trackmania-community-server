import https from 'https'
import { Settings } from '../settings.js'
import { logger } from './utilities.js'

/**
 * Dünner Client für die Anthropic Messages-API (https://api.anthropic.com/v1/messages).
 * Bewusst über Node-Bordmittel `https` statt eines npm-Pakets -- konsistent mit
 * telegramAlert.js/telegram.js und ohne neue Abhängigkeit. Nur ein einfacher,
 * nicht-streamender Aufruf für kurze Kommentar-Texte.
 *
 * Der API-Key liegt ausschließlich in secrets.env (Settings.ki.apiKey) -- niemals im Code.
 */

const HOST = 'api.anthropic.com';
const PFAD = '/v1/messages';
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 15000;

/**
 * Optional registrierter Tracker fuer das kiNutzung-Tracking. kiClient bleibt
 * bewusst DB-frei -- die eigentliche DB-Schreiblogik lebt in kiNutzungTracker.js, das
 * sich hier per setzeNutzungsTracker() einhaengt (Muster wie holeEinstellungen()/
 * setzeEinstellungen() in laufzeitEinstellungen.js: dünner Consumer, DB-Zugriff woanders).
 * @type {((feature: string, inputTokens: number, outputTokens: number) => void)|null}
 */
let nutzungsTracker = null;

/** Registriert den kiNutzung-Tracker (aufgerufen aus Plugin-Konstruktoren, siehe kiNutzungTracker.js). */
export function setzeNutzungsTracker(fn) {
    nutzungsTracker = fn;
}

/**
 * Meldet Nutzung an den Tracker, falls einer registriert und ein `feature` angegeben ist --
 * wirft nie. Der try/catch faengt nur SYNCHRONE Fehler; da der registrierte Tracker
 * (typischerweise async, z.B. erfasseNutzung()) ein Promise zurueckgeben kann, wird das
 * zusaetzlich per .catch() abgesichert -- sonst waere ein Fehler in einem kuenftigen,
 * weniger sorgfaeltigen Tracker eine unhandled rejection (kein globaler Handler im
 * Controller, siehe errungenschaften.js), obwohl kiClient laut eigenem Vertrag nie wirft.
 */
function meldeNutzung(feature, inputTokens, outputTokens) {
    if (!feature || !nutzungsTracker) return;
    try {
        Promise.resolve(nutzungsTracker(feature, inputTokens ?? 0, outputTokens ?? 0))
            .catch((error) => logger('er', `kiClient: Nutzungs-Tracker-Fehler (async): ${error.message}`));
    } catch (error) {
        logger('er', `kiClient: Nutzungs-Tracker-Fehler: ${error.message}`);
    }
}

/**
 * Fragt das konfigurierte Modell nach einem kurzen Kommentar.
 * Nie werfend: bei fehlendem Key, Fehler, Timeout oder unerwarteter Antwort wird
 * geloggt und `null` zurückgegeben -- der Aufrufer entscheidet dann, nichts zu senden.
 *
 * @param {string} systemPrompt Rolle/Ton des Kommentators (nicht spielerbeeinflusst)
 * @param {string} userInhalt   Situations-Fakten als DATEN (können manipulierte Namen/Chat enthalten)
 * @param {number} [maxTokens]  Obergrenze der Antwortlänge (Default 120 -- kurze Ansage)
 * @param {number} [timeoutMs]  Anfrage-Timeout (Default 15000 -- Rennleitung nutzt diesen Default
 *   unverändert; kiEnrich.js übergibt bewusst einen kürzeren Wert, da dort der Sendevorgang
 *   bestehender Nachrichten nicht spürbar verzögert werden darf)
 * @param {{modell?: string, feature?: string}} [opts] `modell`: Override statt Settings.ki.modell
 *   (z.B. aus laufzeitEinstellungen.js -- Admin-Dashboard). `feature`: Kennung fuer das
 *   kiNutzung-Tracking (z.B. 'rennleitung'/'nachrichtenKi'/'analyse') -- ohne Angabe wird nichts
 *   getrackt (z.B. wenn kein Tracker registriert ist, etwa in isolierten Testskripten).
 * @returns {Promise<string|null>} generierter Text oder null
 */
export function frageKommentar(systemPrompt, userInhalt, maxTokens = 120, timeoutMs = TIMEOUT_MS, opts = {}) {
    const modell = opts.modell ?? Settings.ki.modell;

    if (Settings.ki.dryRun) {
        // Trockenlauf VOR der Key-Prüfung: so lässt sich die komplette Ausgabe-Pipeline
        // (Log/Chat/Telegram-Routing, Anti-Spam) auch ohne echten API-Key testen, ohne
        // echte API-Kosten zu verursachen. Nur loggen + Platzhalter-Text zurückgeben.
        // Zaehlt im kiNutzung-Tracking bewusst mit 0 Tokens mit -- so ist auch im
        // Trockenlauf sichtbar, WIE OFT ein Feature angefragt haette werden wollen.
        logger('r', `kiClient (Trockenlauf): würde Modell ${modell} fragen -- Kontext: ${userInhalt.replace(/\s+/g, ' ').slice(0, 200)}`);
        meldeNutzung(opts.feature, 0, 0);
        return Promise.resolve(`[Trockenlauf-Kommentar zu: ${userInhalt.replace(/\s+/g, ' ').slice(0, 60)}…]`);
    }

    if (!Settings.ki.apiKey) {
        logger('w', 'kiClient: Kein ANTHROPIC_API_KEY konfiguriert -- Kommentar übersprungen.');
        return Promise.resolve(null);
    }

    const body = JSON.stringify({
        model: modell,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userInhalt }],
    });

    return new Promise((resolve) => {
        const req = https.request(
            {
                hostname: HOST,
                port: 443,
                path: PFAD,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': Settings.ki.apiKey,
                    'anthropic-version': API_VERSION,
                    'content-length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try {
                        const antwort = JSON.parse(data);
                        if (res.statusCode !== 200) {
                            logger('er', `kiClient: API-Fehler (HTTP ${res.statusCode}): ${antwort?.error?.message ?? data.slice(0, 200)}`);
                            resolve(null);
                            return;
                        }
                        // Tokens fallen auch bei einer Ablehnung (refusal) an -- deshalb hier und
                        // nicht erst nach der Refusal-Pruefung tracken.
                        meldeNutzung(opts.feature, antwort.usage?.input_tokens, antwort.usage?.output_tokens);
                        if (antwort.stop_reason === 'refusal') {
                            logger('w', 'kiClient: Modell hat abgelehnt (refusal) -- Kommentar übersprungen.');
                            resolve(null);
                            return;
                        }
                        const text = Array.isArray(antwort.content)
                            ? antwort.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim()
                            : '';
                        resolve(text || null);
                    } catch (error) {
                        logger('er', `kiClient: Antwort nicht parsebar: ${error.message}`);
                        resolve(null);
                    }
                });
            }
        );

        req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout nach ${timeoutMs} ms`)));
        req.on('error', (error) => {
            logger('er', `kiClient: Anfrage fehlgeschlagen: ${error.message}`);
            resolve(null);
        });
        req.write(body);
        req.end();
    });
}
