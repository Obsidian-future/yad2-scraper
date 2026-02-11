const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const config = require('./config.json');

let browser = null;

const getBrowser = async () => {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });
    }
    return browser;
};

const getYad2Response = async (url) => {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return await page.content();
    } catch (err) {
        console.log('Page fetch error:', err.message);
        return null;
    } finally {
        await page.close();
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const extractListings = async (url, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const yad2Html = await getYad2Response(url);
        if (!yad2Html) {
            throw new Error("Could not get Yad2 response");
        }
        const $ = cheerio.load(yad2Html);
        const titleText = $("title").first().text();
        if (titleText === "ShieldSquare Captcha") {
            if (attempt < retries) {
                console.log(`Bot detection on attempt ${attempt}, retrying in ${attempt * 5}s...`);
                await sleep(attempt * 5000);
                continue;
            }
            throw new Error("Bot detection (all retries failed)");
        }

        const nextDataScript = $('#__NEXT_DATA__');
        if (!nextDataScript.length) {
            throw new Error("Could not find __NEXT_DATA__ on page");
        }
        const nextData = JSON.parse(nextDataScript.html());
        const queries = nextData?.props?.pageProps?.dehydratedState?.queries;
        if (!queries || !queries.length) {
            throw new Error("Could not find listing data in page");
        }

        let items = [];
        for (const query of queries) {
            const data = query?.state?.data;
            if (!data) continue;
            if (Array.isArray(data.private)) {
                items = items.concat(data.private);
            }
            if (Array.isArray(data.agency)) {
                items = items.concat(data.agency);
            }
            if (data.pages) {
                for (const page of data.pages) {
                    if (page?.data) items = items.concat(page.data);
                }
            }
            if (Array.isArray(data.data)) {
                items = items.concat(data.data);
            }
        }

        const listings = items.filter(item => item.token).map(item => {
            const addr = item.address || {};
            const street = addr.street?.text || '';
            const house = addr.house?.number ? ` ${addr.house.number}` : '';
            const city = addr.city?.text || '';
            const neighborhood = addr.neighborhood?.text || '';
            const addressStr = [street + house, neighborhood, city].filter(Boolean).join(', ');

            return {
                token: item.token,
                price: item.price,
                address: addressStr,
                rooms: item.additionalDetails?.roomsCount,
                sqm: item.additionalDetails?.squareMeter,
                propertyType: item.additionalDetails?.property?.text || '',
                adType: item.adType || '',
                link: `https://www.yad2.co.il/realestate/item/${item.token}`
            };
        });

        return listings;
    }
};

const formatListing = (listing) => {
    const price = listing.price ? `₪${listing.price.toLocaleString()}` : 'N/A';
    const ppsm = (listing.price && listing.sqm) ? `₪${Math.round(listing.price / listing.sqm).toLocaleString()}/m²` : '';
    const rooms = listing.rooms ? `${listing.rooms} rooms` : '';
    const sqm = listing.sqm ? `${listing.sqm}m²` : '';
    const details = [listing.propertyType, rooms, sqm, ppsm].filter(Boolean).join(' | ');
    return `${price} - ${listing.address}\n${details}\n${listing.link}`;
};

const getTelegramClient = () => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({ apiToken });
    return { telenode, chatId };
};

const sendTelegramBatched = async (telenode, chatId, messages) => {
    let batch = '';
    for (const msg of messages) {
        const entry = msg + "\n----------\n";
        if (batch.length + entry.length > 3500) {
            await telenode.sendTextMessage(batch, chatId);
            batch = '';
        }
        batch += entry;
    }
    if (batch) {
        await telenode.sendTextMessage(batch, chatId);
    }
};

const closeBrowser = async () => {
    if (browser && browser.connected) {
        await browser.close();
        browser = null;
    }
};

module.exports = {
    extractListings,
    formatListing,
    getTelegramClient,
    sendTelegramBatched,
    closeBrowser
};

// Allow standalone execution for GitHub Actions backward compatibility
if (require.main === module) {
    const fs = require('fs');

    const checkForNewListings = async (listings, topic) => {
        const filePath = `./data/${topic}.json`;
        let savedTokens = [];
        try {
            savedTokens = require(filePath);
        } catch (e) {
            if (e.code === "MODULE_NOT_FOUND") {
                if (!fs.existsSync('data')) fs.mkdirSync('data');
                fs.writeFileSync(filePath, '[]');
            } else {
                throw new Error(`Could not read / create ${filePath}`);
            }
        }
        const currentTokens = listings.map(l => l.token);
        let shouldUpdateFile = false;
        savedTokens = savedTokens.filter(t => {
            const stillExists = currentTokens.includes(t);
            if (!stillExists) shouldUpdateFile = true;
            return stillExists;
        });
        const newListings = listings.filter(l => !savedTokens.includes(l.token));
        if (newListings.length > 0) {
            savedTokens.push(...newListings.map(l => l.token));
            shouldUpdateFile = true;
        }
        if (shouldUpdateFile) {
            fs.writeFileSync(filePath, JSON.stringify(savedTokens, null, 2));
            fs.writeFileSync("push_me", "");
        }
        return newListings;
    };

    const scrape = async (topic, url) => {
        const { telenode, chatId } = getTelegramClient();
        try {
            await telenode.sendTextMessage(`Starting scanning ${topic} on link:\n${url}`, chatId);
            const listings = await extractListings(url);
            const newListings = await checkForNewListings(listings, topic);
            if (newListings.length > 0) {
                await telenode.sendTextMessage(`🏠 ${newListings.length} new listings found:`, chatId);
                await sendTelegramBatched(telenode, chatId, newListings.map(formatListing));
            } else {
                await telenode.sendTextMessage("No new items were added", chatId);
            }
        } catch (e) {
            let errMsg = e?.message || "";
            if (errMsg) errMsg = `Error: ${errMsg}`;
            await telenode.sendTextMessage(`Scan workflow failed... 😥\n${errMsg}`, chatId);
            throw new Error(e);
        }
    };

    const program = async () => {
        await Promise.all(config.projects.filter(project => {
            if (project.disabled) console.log(`Topic "${project.topic}" is disabled. Skipping.`);
            return !project.disabled;
        }).map(project => scrape(project.topic, project.url)));
        await closeBrowser();
    };

    program();
}
