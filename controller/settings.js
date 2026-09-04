import { secrets } from './lib/secrets.js';

// Test-Modus: MONGO_DB=nextcontrol_test node . -> Controller arbeitet gegen die Test-DB.
const mongoDatabase = process.env.MONGO_DB || 'nextcontrol';

// Test-Modus: TRACKMANIA_PORT=5556 node . -> Controller verbindet sich mit einem
// anderen Server (z.B. dem isolierten Trainings-Server statt dem Live-Server).
const trackmaniaPort = Number(process.env.TRACKMANIA_PORT) || 5555;

// TM_SERVER_HOST erlaubt den Betrieb in einem eigenen Prozess/Container, waehrend
// der Dedicated Server (proprietaeres Binary, nicht containerisierbar) anderswo
// laeuft -- Default bleibt 'localhost' (bisheriges Verhalten unveraendert).
const trackmaniaHost = process.env.TM_SERVER_HOST || 'localhost';

// MONGO_HOST erlaubt den Betrieb gegen einen externen/containerisierten Mongo-
// Dienst (z.B. Docker-Compose-Service "mongo") -- Default bleibt 'localhost'.
const mongoHost = process.env.MONGO_HOST || 'localhost';

const Settings = {

// Trackmania server settings
trackmania: {

// Host des Dedicated Servers -- per Default localhost (Server laeuft auf
// demselben Rechner). Ueber TM_SERVER_HOST uebersteuerbar, wenn der Controller
// (z.B. in einem Docker-Container) den Server extern erreichen muss.
host: trackmaniaHost,

// server port
port: trackmaniaPort,

// Authentication details for SuperAdmin access
login: 'SuperAdmin',
password: secrets.SUPERADMIN_PASSWORD,

// Game: TM2020 or TM2
game: 'TM2020',

// The login of the server at the master server, look it up on the player page in doubt
server_login: 'SuperAdmin',

// The matchsettings file the server is started with
matchsettings_file: 'set.txt'
},

usedDatabase: 'mongodb', // or mysql...

// you only need to enter the details about the database you actually are going to use.

// MongoDB settings
mongoDb: {
// Connection URI
uri: `mongodb://${mongoHost}/?poolSize=20&w=majority`,

// Database name
database: mongoDatabase
},

// MySQL database settings (aktuell ungenutzt, usedDatabase=mongodb)
mySql: {
// host and port
host: "localhost",
port: 3306,

// user and password
user: "nextcontrol",
password: secrets.MYSQL_PASSWORD,

// database name
database: "nextcontrol"
},

// List of disabled plugins by their name. 'Cup' (AP14d) ist HIER bewusst mit
// aufgefuehrt: die Verbotsliste gilt im NORMALEN Betrieb (CUP_MODUS nicht gesetzt) --
// ohne diesen Eintrag wuerde das Cup-Plugin auch im normalen TimeAttack-Hauptcontroller
// laufen und cupTurniere/-Status/-Kommandos bedienen, obwohl es dort nie soll. Im
// CUP_MODUS greift stattdessen die Allowlist unten, die 'Cup' wieder ausdruecklich erlaubt.
disabledPlugins: ['Beispiel-Plugin', 'Cup'],

// Cup-Turniersystem (Beta-Feature, siehe README): CUP_MODUS=true laedt statt der
// disabledPlugins-Verbotsliste eine explizite Erlaubnisliste -- kuenftige Plugins
// landen so nie versehentlich im separaten Cup-Controller-Prozess.
cupModusPluginAllowlist: ['Admin-Werkzeuge', 'Hilfe', 'Cup'],

// List of administrators by their logins (kommagetrennt in secrets.env,
// ADMIN_LOGINS=login1,login2 -- siehe docs/SYSTEM.md).
admins: (secrets.ADMIN_LOGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

// Telegram-Bot-Zugangsdaten (zentral in secrets.env, siehe docs/SYSTEM.md)
// Test-Modus: TELEGRAM_TEST_BOT=true node . -> nutzt den dedizierten Test-Bot
// (@oracle0815_bot, TELEGRAM_TOKEN_TEST) statt des produktiven Bots -- verhindert
// den Mehrfach-Poller-Konflikt (ein Telegram-Bot-Token vertraegt nur einen Poller).
telegram: {
token: process.env.TELEGRAM_TEST_BOT === 'true' ? secrets.TELEGRAM_TOKEN_TEST : secrets.TELEGRAM_TOKEN,
chatId: secrets.TELEGRAM_CHAT_ID,
// Trockenlauf: Nachrichten werden nur geloggt statt an Telegram gesendet.
dryRun: process.env.TELEGRAM_DRY_RUN === 'true'
},

// KI-Kommentator ("Rennleitung"), siehe controller/plugins/rennleitung.js + docs/SYSTEM.md.
// API-Key ausschliesslich in secrets.env (ANTHROPIC_API_KEY). Fehlt er, bleibt das Plugin still.
// Modell als Config-Wert -> Upgrade auf 'claude-sonnet-5'/'claude-opus-4-8' ohne Codeaenderung.
// Aus-Schalter: KI_AUS=true node .   Trockenlauf: KI_DRY_RUN=true node . (nur loggen, nichts senden).
ki: {
apiKey: secrets.ANTHROPIC_API_KEY,
modell: 'claude-haiku-4-5',
// Analyse-Laeufe (AP15d, woechentlich) nutzen ein staerkeres Modell als die
// Live-Kommentare der Rennleitung -- als eigener Config-Wert, damit sich beide
// unabhaengig voneinander upgraden lassen. Override: KI_ANALYSE_MODELL=... node .
analyseModell: process.env.KI_ANALYSE_MODELL || 'claude-sonnet-5',
aktiv: process.env.KI_AUS !== 'true',
dryRun: process.env.KI_DRY_RUN === 'true'
},

// Zusatzfunktion "Nachrichten-KI": formuliert bestehende, statisch erzeugte Server-
// Benachrichtigungen (Chat/Gaming-Log/Telegram-DM) sprachlich um, OHNE Kanal/Zeitpunkt/Inhalt
// zu veraendern. Siehe controller/lib/kiEnrich.js + controller/plugins/nachrichtenKi.js.
// Nutzt denselben Anthropic-Zugang wie die Rennleitung (Settings.ki), aber EIGENEN
// Ein/Aus-Schalter + EIGENEN Stundendeckel (viel hoeheres Volumen moeglich, da JEDE
// Standard-Nachricht durchlaufen kann, nicht nur Besonderheiten).
// Aus-Schalter: NACHRICHTEN_KI_AUS=true node .
nachrichtenKi: {
aktiv: process.env.NACHRICHTEN_KI_AUS !== 'true',
maxProStunde: Number(process.env.NACHRICHTEN_KI_MAX_PRO_STUNDE) || 300
},

// Cup-Turniersystem (Beta-Feature, siehe README): /cup-Telegram-Befehle im Haupt-Controller.
// BEWUSST STANDARDMAESSIG AUS (kein CUP_MODUS-Gate wie beim separaten Cup-Controller
// moeglich, telegram.js laeuft immer im normal-live Prozess) -- der Betreiber muss
// CUP_TELEGRAM_AKTIV=true explizit setzen, bevor echte Nutzer im Live-Bot /cup nutzen
// koennen. Bis zur AP14j-Freigabe bleibt das aus, auch wenn dieser Code deployt ist.
cup: {
aktiv: process.env.CUP_TELEGRAM_AKTIV === 'true',
erinnerungMinutenVorher: 30
}

}

export { Settings }