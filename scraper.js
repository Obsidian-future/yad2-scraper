const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

const getYad2Response = async (url) => {
    const requestOptions = {
        method: 'GET',
        redirect: 'follow'
    };
    try {
        const res = await fetch(url, requestOptions)
        return await res.text()
    } catch (err) {
        console.log(err)
    }
}

const extractListings = async (url) => {
    const yad2Html = await getYad2Response(url);
    if (!yad2Html) {
        throw new Error("Could not get Yad2 response");
    }
    const $ = cheerio.load(yad2Html);
    const titleText = $("title").first().text();
    if (titleText === "ShieldSquare Captcha") {
        throw new Error("Bot detection");
    }

    // Extract __NEXT_DATA__ JSON from the page
    const nextDataScript = $('#__NEXT_DATA__');
    if (!nextDataScript.length) {
        throw new Error("Could not find __NEXT_DATA__ on page");
    }
    const nextData = JSON.parse(nextDataScript.html());
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries;
    if (!queries || !queries.length) {
        throw new Error("Could not find listing data in page");
    }

    // Find the query that contains feed items
    let items = [];
    for (const query of queries) {
        const pages = query?.state?.data?.pages;
        if (pages) {
            for (const page of pages) {
                if (page?.data) {
                    items = items.concat(page.data);
                }
            }
        }
        // Also handle non-paginated data
        const data = query?.state?.data?.data;
        if (Array.isArray(data)) {
            items = items.concat(data);
        }
    }

    // Filter to actual listings (ones with a token)
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

const formatListing = (listing) => {
    const price = listing.price ? `₪${listing.price.toLocaleString()}` : 'N/A';
    const rooms = listing.rooms ? `${listing.rooms} rooms` : '';
    const sqm = listing.sqm ? `${listing.sqm}m²` : '';
    const details = [listing.propertyType, rooms, sqm].filter(Boolean).join(' | ');
    return `${price} - ${listing.address}\n${details}\n${listing.link}`;
}

const checkForNewListings = async (listings, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedTokens = [];
    try {
        savedTokens = require(filePath);
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
            if (!fs.existsSync('data')) {
                fs.mkdirSync('data');
            }
            fs.writeFileSync(filePath, '[]');
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }

    const currentTokens = listings.map(l => l.token);
    // Keep tokens that still exist, add new ones
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
}

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({apiToken})
    try {
        await telenode.sendTextMessage(`Starting scanning ${topic} on link:\n${url}`, chatId)
        const listings = await extractListings(url);
        const newListings = await checkForNewListings(listings, topic);
        if (newListings.length > 0) {
            const formatted = newListings.map(formatListing).join("\n----------\n");
            const msg = `🏠 ${newListings.length} new listings:\n----------\n${formatted}`
            await telenode.sendTextMessage(msg, chatId);
        } else {
            await telenode.sendTextMessage("No new items were added", chatId);
        }
    } catch (e) {
        let errMsg = e?.message || "";
        if (errMsg) {
            errMsg = `Error: ${errMsg}`
        }
        await telenode.sendTextMessage(`Scan workflow failed... 😥\n${errMsg}`, chatId)
        throw new Error(e)
    }
}

const program = async () => {
    await Promise.all(config.projects.filter(project => {
        if (project.disabled) {
            console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        }
        return !project.disabled;
    }).map(async project => {
        await scrape(project.topic, project.url)
    }))
};

program();
