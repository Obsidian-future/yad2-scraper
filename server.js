const express = require('express');
const cron = require('node-cron');
const path = require('path');
const db = require('./db');
const { extractListings, formatListing, getTelegramClient, sendTelegramBatched } = require('./scraper');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API Routes ---

app.get('/api/links', (req, res) => {
    const links = db.getLinks();
    const result = links.map(link => ({
        ...link,
        stats: db.getStats(link.id)
    }));
    res.json(result);
});

app.post('/api/links', (req, res) => {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    const result = db.addLink(name, url);
    res.json({ id: result.lastInsertRowid, name, url });
});

app.delete('/api/links/:id', (req, res) => {
    db.removeLink(req.params.id);
    res.json({ ok: true });
});

app.put('/api/links/:id', (req, res) => {
    const { name, url, max_price_per_sqm } = req.body;
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (url !== undefined) fields.url = url;
    if (max_price_per_sqm !== undefined) {
        fields.max_price_per_sqm = (max_price_per_sqm === null || max_price_per_sqm === '') ? null : Number(max_price_per_sqm);
    }
    db.updateLink(req.params.id, fields);
    res.json({ ok: true });
});

app.get('/api/links/:id/listings', (req, res) => {
    const listings = db.getListings(req.params.id);
    res.json(listings);
});

app.post('/api/scan/:id', async (req, res) => {
    const link = db.getLink(req.params.id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    try {
        const result = await scanLink(link, false);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/scan', async (req, res) => {
    const links = db.getLinks();
    const results = [];
    for (const link of links) {
        try {
            const result = await scanLink(link, false);
            results.push({ id: link.id, name: link.name, ...result });
        } catch (e) {
            results.push({ id: link.id, name: link.name, error: e.message });
        }
    }
    res.json(results);
});

// --- Scanning Logic ---

async function scanLink(link, isFirstScan) {
    const listings = await extractListings(link.url);
    const seenTokens = db.getSeenTokens(link.id);
    const newListings = listings.filter(l => !seenTokens.includes(l.token));

    // Store all new listings in DB
    for (const listing of newListings) {
        db.addSeenListing(link.id, listing);
    }

    // Filter by threshold for notifications
    let notifyListings = newListings;
    if (link.max_price_per_sqm) {
        notifyListings = newListings.filter(l => {
            if (!l.price || !l.sqm) return true; // notify if we can't calculate
            return (l.price / l.sqm) <= link.max_price_per_sqm;
        });
    }

    // Send Telegram notifications (skip on first scan to avoid flooding)
    let telegramStatus = 'skipped';
    if (!isFirstScan && notifyListings.length > 0) {
        try {
            const { telenode, chatId } = getTelegramClient();
            console.log(`Sending Telegram to chatId=${chatId}, ${notifyListings.length} listings...`);
            await telenode.sendTextMessage(
                `🏠 ${notifyListings.length} new listing(s) for "${link.name}":`,
                chatId
            );
            await sendTelegramBatched(telenode, chatId, notifyListings.map(formatListing));
            telegramStatus = 'sent';
            console.log('Telegram messages sent successfully');
        } catch (e) {
            telegramStatus = `error: ${e.message}`;
            console.error(`Telegram error for "${link.name}":`, e.message);
        }
    }

    const stats = db.getStats(link.id);
    const notifiedData = (!isFirstScan ? notifyListings : []).map(l => ({
        price: l.price,
        sqm: l.sqm,
        price_per_sqm: (l.price && l.sqm) ? l.price / l.sqm : null,
        address: l.address,
        rooms: l.rooms,
        propertyType: l.propertyType,
        link: l.link
    }));

    // Get all stored listings below threshold for the UI
    let belowThreshold = [];
    if (link.max_price_per_sqm) {
        belowThreshold = db.getListingsBelowThreshold(link.id, link.max_price_per_sqm).map(l => ({
            price: l.price,
            sqm: l.sqm,
            price_per_sqm: l.price_per_sqm,
            address: l.address,
            rooms: l.rooms,
            propertyType: l.property_type,
            link: `https://www.yad2.co.il/realestate/item/${l.token}`
        }));
    }

    return {
        total_scraped: listings.length,
        new_found: newListings.length,
        notified: isFirstScan ? 0 : notifyListings.length,
        telegram: telegramStatus,
        notified_listings: notifiedData,
        below_threshold: belowThreshold,
        stats
    };
}

// --- Scheduler: every 15 minutes ---

cron.schedule('*/15 * * * *', async () => {
    console.log(`[${new Date().toISOString()}] Running scheduled scan...`);
    const links = db.getLinks();
    for (const link of links) {
        try {
            const result = await scanLink(link, false);
            console.log(`  ${link.name}: ${result.new_found} new, ${result.notified} notified`);
        } catch (e) {
            console.error(`  ${link.name}: ERROR - ${e.message}`);
        }
    }
});

// --- Start Server ---

const PORT = process.env.PORT || 3000;

async function start() {
    await db.init();
    app.listen(PORT, () => {
        console.log(`Yad2 Scraper UI running at http://localhost:${PORT}`);
        console.log(`Scheduled scans every 15 minutes`);
    });
}

start();
