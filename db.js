const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const DB_PATH = path.join(dataDir, 'scraper.db');
let db = null;

async function init() {
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }
    db.run(`
        CREATE TABLE IF NOT EXISTS tracked_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            max_price_per_sqm REAL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS seen_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            link_id INTEGER NOT NULL,
            token TEXT NOT NULL,
            price REAL,
            sqm REAL,
            price_per_sqm REAL,
            address TEXT,
            rooms REAL,
            property_type TEXT,
            first_seen_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (link_id) REFERENCES tracked_links(id) ON DELETE CASCADE,
            UNIQUE(link_id, token)
        )
    `);
    save();
    return db;
}

function save() {
    if (!db) return;
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function addLink(name, url) {
    db.run('INSERT INTO tracked_links (name, url) VALUES (?, ?)', [name, url]);
    save();
    const row = db.exec('SELECT last_insert_rowid() as id');
    return { lastInsertRowid: row[0].values[0][0] };
}

function removeLink(id) {
    db.run('DELETE FROM seen_listings WHERE link_id = ?', [id]);
    db.run('DELETE FROM tracked_links WHERE id = ?', [id]);
    save();
}

function getLinks() {
    const result = db.exec('SELECT * FROM tracked_links ORDER BY created_at DESC');
    if (!result.length) return [];
    return result[0].values.map(row => ({
        id: row[0], name: row[1], url: row[2], max_price_per_sqm: row[3], created_at: row[4]
    }));
}

function getLink(id) {
    const result = db.exec('SELECT * FROM tracked_links WHERE id = ?', [id]);
    if (!result.length || !result[0].values.length) return null;
    const row = result[0].values[0];
    return { id: row[0], name: row[1], url: row[2], max_price_per_sqm: row[3], created_at: row[4] };
}

function updateLink(id, fields) {
    // If URL changed, clear old listings since they belong to the old search
    if (fields.url !== undefined) {
        const current = getLink(id);
        if (current && current.url !== fields.url) {
            db.run('DELETE FROM seen_listings WHERE link_id = ?', [id]);
        }
    }
    const sets = [];
    const vals = [];
    if (fields.name !== undefined) { sets.push('name = ?'); vals.push(fields.name); }
    if (fields.url !== undefined) { sets.push('url = ?'); vals.push(fields.url); }
    if (fields.max_price_per_sqm !== undefined) { sets.push('max_price_per_sqm = ?'); vals.push(fields.max_price_per_sqm); }
    if (sets.length === 0) return;
    vals.push(id);
    db.run(`UPDATE tracked_links SET ${sets.join(', ')} WHERE id = ?`, vals);
    save();
}

function updateThreshold(id, maxPricePerSqm) {
    db.run('UPDATE tracked_links SET max_price_per_sqm = ? WHERE id = ?', [maxPricePerSqm, id]);
    save();
}

function getSeenTokens(linkId) {
    const result = db.exec('SELECT token FROM seen_listings WHERE link_id = ?', [linkId]);
    if (!result.length) return [];
    return result[0].values.map(r => r[0]);
}

function addSeenListing(linkId, listing) {
    const pricePerSqm = (listing.price && listing.sqm) ? listing.price / listing.sqm : null;
    try {
        db.run(`
            INSERT OR IGNORE INTO seen_listings (link_id, token, price, sqm, price_per_sqm, address, rooms, property_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [linkId, listing.token, listing.price, listing.sqm, pricePerSqm, listing.address, listing.rooms, listing.propertyType]);
    } catch (e) {
        // UNIQUE constraint - already exists, ignore
    }
    save();
}

function getListings(linkId) {
    const result = db.exec('SELECT * FROM seen_listings WHERE link_id = ? ORDER BY first_seen_at DESC', [linkId]);
    if (!result.length) return [];
    return result[0].values.map(row => ({
        id: row[0], link_id: row[1], token: row[2], price: row[3], sqm: row[4],
        price_per_sqm: row[5], address: row[6], rooms: row[7], property_type: row[8], first_seen_at: row[9]
    }));
}

function getMedianPricePerSqm(linkId) {
    const result = db.exec(
        'SELECT price_per_sqm FROM seen_listings WHERE link_id = ? AND price_per_sqm IS NOT NULL ORDER BY price_per_sqm',
        [linkId]
    );
    if (!result.length || !result[0].values.length) return null;
    const values = result[0].values.map(r => r[0]);
    const mid = Math.floor(values.length / 2);
    if (values.length % 2 === 0) {
        return (values[mid - 1] + values[mid]) / 2;
    }
    return values[mid];
}

function getListingsBelowThreshold(linkId, maxPpsm) {
    const result = db.exec(
        'SELECT * FROM seen_listings WHERE link_id = ? AND price_per_sqm IS NOT NULL AND price_per_sqm <= ? ORDER BY price_per_sqm',
        [linkId, maxPpsm]
    );
    if (!result.length) return [];
    return result[0].values.map(row => ({
        id: row[0], link_id: row[1], token: row[2], price: row[3], sqm: row[4],
        price_per_sqm: row[5], address: row[6], rooms: row[7], property_type: row[8], first_seen_at: row[9]
    }));
}

function getStats(linkId) {
    const result = db.exec(`
        SELECT COUNT(*) as total,
               MIN(price_per_sqm) as min_ppsm,
               MAX(price_per_sqm) as max_ppsm,
               AVG(price_per_sqm) as avg_ppsm
        FROM seen_listings WHERE link_id = ? AND price_per_sqm IS NOT NULL
    `, [linkId]);
    const row = result.length ? result[0].values[0] : [0, null, null, null];
    return {
        total: row[0],
        min_ppsm: row[1],
        max_ppsm: row[2],
        avg_ppsm: row[3],
        median_ppsm: getMedianPricePerSqm(linkId)
    };
}

module.exports = {
    init,
    addLink,
    removeLink,
    getLinks,
    getLink,
    updateLink,
    updateThreshold,
    getSeenTokens,
    addSeenListing,
    getListings,
    getListingsBelowThreshold,
    getMedianPricePerSqm,
    getStats
};
