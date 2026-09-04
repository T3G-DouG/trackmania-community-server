// punkte.js — FIXIERTE Punkteformel des Systems (Referenz: alte Website halloffame.js).
// Änderungen nur auf ausdrücklichen Wunsch des Betreibers!

/** Punkte für einen Rang innerhalb einer Map. */
export function calculatePoints(rank) {
    if (rank === 1) return 1000;
    if (rank === 2) return 800;
    if (rank === 3) return 600;
    if (rank <= 5) return 500;
    if (rank <= 10) return 400;
    if (rank <= 20) return 300;
    if (rank <= 50) return 200;
    if (rank <= 100) return 100;
    if (rank <= 200) return 50;
    return Math.max(10, Math.floor(1000 / rank));
}

/**
 * Ranking über eine Menge von Records berechnen — exakt der Algorithmus der
 * alten Website (halloffame.js): Records je Map nach Zeit sortieren, Rang →
 * Punkte, pro Spieler aufsummieren.
 *
 * @param {Array<{login:string, time:number, map:string}>} records
 * @param {Map<string,string>|Object} spielerNamen  login → Anzeigename (optional)
 * @returns {Array<{login:string, name:string, punkte:number, siege:number, mapsGespielt:number}>}
 *          absteigend nach Punkten sortiert
 */
export function berechneRanking(records, spielerNamen = {}) {
    const nameVon = (login) =>
        (spielerNamen instanceof Map ? spielerNamen.get(login) : spielerNamen[login]) || login;

    // Records nach Map gruppieren
    const proMap = new Map();
    for (const r of records) {
        if (!r.map || !r.login) continue;
        if (!proMap.has(r.map)) proMap.set(r.map, []);
        proMap.get(r.map).push(r);
    }

    const spieler = new Map();
    for (const mapRecords of proMap.values()) {
        mapRecords.sort((a, b) => a.time - b.time);
        const gezaehlt = new Set(); // ein Spieler zählt pro Map nur einmal
        mapRecords.forEach((r, i) => {
            const rank = i + 1;
            let s = spieler.get(r.login);
            if (!s) {
                s = { login: r.login, name: nameVon(r.login), punkte: 0, siege: 0, mapsGespielt: 0 };
                spieler.set(r.login, s);
            }
            s.punkte += calculatePoints(rank);
            if (rank === 1) s.siege++;
            if (!gezaehlt.has(r.login)) {
                s.mapsGespielt++;
                gezaehlt.add(r.login);
            }
        });
    }

    return [...spieler.values()].sort((a, b) => b.punkte - a.punkte);
}
