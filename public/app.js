const linksContainer = document.getElementById('links-container');
const addForm = document.getElementById('add-link-form');
const scanAllBtn = document.getElementById('scan-all-btn');
const modal = document.getElementById('listings-modal');

const fmt = (n) => n != null ? Math.round(n).toLocaleString() : 'N/A';
const fmtPrice = (n) => n != null ? `₪${Math.round(n).toLocaleString()}` : 'N/A';

async function loadLinks() {
    const res = await fetch('/api/links');
    const links = await res.json();
    renderLinks(links);
}

function renderLinks(links) {
    if (links.length === 0) {
        linksContainer.innerHTML = '<div class="empty-state">No tracked links yet. Add one above.</div>';
        return;
    }
    linksContainer.innerHTML = links.map(link => {
        const s = link.stats;
        const savedResult = lastScanResult[link.id] || '';
        return `
        <div class="link-card" data-id="${link.id}">
            <div class="link-header">
                <span class="link-name">${esc(link.name)}</span>
            </div>
            <div class="link-url">${esc(link.url)}</div>
            <div class="link-stats">
                <div class="stat">
                    <span class="stat-label">Listings</span>
                    <span class="stat-value">${s.total || 0}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Median ₪/m²</span>
                    <span class="stat-value median">${s.median_ppsm ? fmt(s.median_ppsm) : '-'}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Min ₪/m²</span>
                    <span class="stat-value">${s.min_ppsm ? fmt(s.min_ppsm) : '-'}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Max ₪/m²</span>
                    <span class="stat-value">${s.max_ppsm ? fmt(s.max_ppsm) : '-'}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Avg ₪/m²</span>
                    <span class="stat-value">${s.avg_ppsm ? fmt(s.avg_ppsm) : '-'}</span>
                </div>
            </div>
            <div class="threshold-row">
                <label>Max ₪/m² for alerts:</label>
                <input type="number" class="threshold-input" value="${link.max_price_per_sqm || ''}" placeholder="No limit">
                <button class="btn-save" onclick="saveThreshold(${link.id}, this)">Save</button>
            </div>
            <div class="link-actions">
                <button class="btn-scan" onclick="scanLink(${link.id}, this)">Scan Now</button>
                <button class="btn-listings" data-id="${link.id}" data-name="${esc(link.name)}">View Listings</button>
                <button class="btn-edit" onclick="editLink(${link.id}, this)">Edit</button>
                <button class="btn-delete" onclick="deleteLink(${link.id})">Delete</button>
            </div>
            <div class="scan-result-area">${savedResult}</div>
        </div>`;
    }).join('');
}

function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('link-name').value.trim();
    const url = document.getElementById('link-url').value.trim();
    if (!name || !url) return;
    await fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url })
    });
    document.getElementById('link-name').value = '';
    document.getElementById('link-url').value = '';
    loadLinks();
});

async function saveThreshold(id, btn) {
    const input = btn.previousElementSibling;
    const value = input.value === '' ? null : Number(input.value);
    await fetch(`/api/links/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_price_per_sqm: value })
    });
    btn.textContent = 'Saved!';
    setTimeout(() => btn.textContent = 'Save', 1500);
}

async function editLink(id, btn) {
    const card = btn.closest('.link-card');
    const nameEl = card.querySelector('.link-name');
    const urlEl = card.querySelector('.link-url');
    const oldName = nameEl.textContent;
    const oldUrl = urlEl.textContent;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'edit-name-input';
    nameInput.value = oldName;

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'edit-url-input';
    urlInput.value = oldUrl;

    nameEl.textContent = '';
    nameEl.appendChild(nameInput);
    urlEl.textContent = '';
    urlEl.appendChild(urlInput);

    nameInput.focus();
    nameInput.select();

    btn.textContent = 'Save';
    btn.className = 'btn-edit saving';
    btn.onclick = async () => {
        const newName = nameInput.value.trim();
        const newUrl = urlInput.value.trim();
        if (!newName || !newUrl) return alert('Name and URL are required');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        await fetch(`/api/links/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName, url: newUrl })
        });
        loadLinks();
    };
}

let lastScanResult = {};

function renderListingCards(listings, type) {
    let html = `<div class="notified-listings ${type}">`;
    for (const l of listings) {
        const ppsm = l.price_per_sqm ? fmt(l.price_per_sqm) + ' ₪/m²' : '';
        html += `<div class="notified-item">
            <div class="notified-main">
                <span class="notified-price">${fmtPrice(l.price)}</span>
                <span class="notified-address">${esc(l.address || 'Unknown')}</span>
            </div>
            <div class="notified-details">${esc(l.propertyType || '')} | ${l.rooms || '?'} rooms | ${l.sqm || '?'}m² | ${ppsm}</div>
            <a class="listing-link" href="${esc(l.link)}" target="_blank">View on Yad2</a>
        </div>`;
    }
    html += `</div>`;
    return html;
}

async function scanLink(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    const card = btn.closest('.link-card');
    const resultArea = card.querySelector('.scan-result-area');
    resultArea.innerHTML = `<div class="scan-result scanning">Scanning... this takes ~15 seconds</div>`;
    try {
        const res = await fetch(`/api/scan/${id}`, { method: 'POST' });
        const data = await res.json();
        if (data.error) {
            lastScanResult[id] = `<div class="scan-result error">${esc(data.error)}</div>`;
        } else {
            const tgIcon = data.telegram === 'sent' ? '✅' : data.telegram === 'skipped' ? '⏭️' : '❌';
            const tgText = data.telegram === 'sent' ? 'Telegram sent' : data.telegram === 'skipped' ? 'No new to notify' : `Telegram: ${data.telegram}`;
            let html = `<div class="scan-result">Found ${data.total_scraped} listings, ${data.new_found} new, ${data.notified} notified — ${tgIcon} ${tgText}</div>`;
            if (data.notified_listings && data.notified_listings.length > 0) {
                html += `<div class="notified-header">New listings sent to Telegram:</div>`;
                html += renderListingCards(data.notified_listings, 'new');
            }
            if (data.below_threshold && data.below_threshold.length > 0) {
                html += `<div class="notified-header below">All ${data.below_threshold.length} stored listings below threshold:</div>`;
                html += renderListingCards(data.below_threshold, 'below');
            }
            lastScanResult[id] = html;
        }
        resultArea.innerHTML = lastScanResult[id];
        loadLinks();
    } catch (e) {
        lastScanResult[id] = `<div class="scan-result error">${esc(e.message)}</div>`;
        resultArea.innerHTML = lastScanResult[id];
    }
    btn.disabled = false;
    btn.textContent = 'Scan Now';
}

async function deleteLink(id) {
    if (!confirm('Delete this tracked link and all its listings?')) return;
    await fetch(`/api/links/${id}`, { method: 'DELETE' });
    loadLinks();
}

scanAllBtn.addEventListener('click', async () => {
    scanAllBtn.disabled = true;
    scanAllBtn.textContent = 'Scanning...';
    try {
        await fetch('/api/scan', { method: 'POST' });
        loadLinks();
    } catch (e) {
        alert('Scan failed: ' + e.message);
    }
    scanAllBtn.disabled = false;
    scanAllBtn.textContent = 'Scan All Now';
});

async function viewListings(id, name) {
    document.getElementById('modal-title').textContent = name;
    const res = await fetch(`/api/links/${id}/listings`);
    const listings = await res.json();
    const body = document.getElementById('modal-body');
    if (listings.length === 0) {
        body.innerHTML = '<div class="empty-state">No listings yet. Run a scan first.</div>';
    } else {
        body.innerHTML = listings.map(l => `
            <div class="listing-row">
                <div>
                    <div class="listing-address">${esc(l.address || 'Unknown')}</div>
                    <div class="listing-details">${esc(l.property_type || '')} | ${l.rooms || '?'} rooms | ${l.sqm || '?'}m²</div>
                    <a class="listing-link" href="https://www.yad2.co.il/realestate/item/${l.token}" target="_blank">View on Yad2</a>
                </div>
                <div style="text-align:right">
                    <div class="listing-price">${fmtPrice(l.price)}</div>
                    <div class="listing-ppsm">${l.price_per_sqm ? fmt(l.price_per_sqm) + ' ₪/m²' : ''}</div>
                </div>
            </div>
        `).join('');
    }
    modal.classList.remove('hidden');
}

function closeModal() {
    modal.classList.add('hidden');
}

modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
});

linksContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-listings');
    if (btn) {
        viewListings(btn.dataset.id, btn.dataset.name);
    }
});

loadLinks();
