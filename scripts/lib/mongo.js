// mongo.js — zentrale Mongo-URI-Erzeugung fuer die scripts/-CLI-Tools.
// Per MONGO_HOST uebersteuerbar (gleiches Muster wie in controller/settings.js
// und website/config.php), damit ein Docker-Container/anderer Host nur eine
// Umgebungsvariable statt eines Codeeingriffs braucht. Default bleibt 'localhost'
// (bisheriges Verhalten unveraendert).
export function mongoUri() {
    return `mongodb://${process.env.MONGO_HOST || 'localhost'}:27017`;
}
