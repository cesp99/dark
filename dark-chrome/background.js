// Listen for extension installation
chrome.runtime.onInstalled.addListener(() => {
    // Load and merge default blacklisted sites
    fetch(chrome.runtime.getURL('blacklist.json'))
        .then(response => response.json())
        .then(defaultData => {
            chrome.storage.local.get({ blacklist_sites: [] }, (data) => {
                const mergedSites = [...new Set([...defaultData.blacklisted_sites, ...(data.blacklist_sites || [])])];
                chrome.storage.local.set({ blacklist_sites: mergedSites });
            });
        })
        .catch(error => console.error('Error loading default blacklist:', error));
});

// Listen for messages from popup.js or content scripts with enhanced security
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Verify message origin for security
    if (!sender.id || sender.id !== chrome.runtime.id) {
        sendResponse({ success: false, error: 'Invalid message origin' });
        return true;
    }

    if (message.action === "getBlacklist") {
        chrome.storage.local.get("blacklisted_sites", (data) => {
            sendResponse({ success: true, sites: data.blacklisted_sites || [], tabId: sender.tab?.id });
        });
        return true; // Ensures async response works
    }

    if (message.action === "toggleDarkMode") {
        if (!sender.tab?.id) {
            sendResponse({ success: false, error: 'No tab context found' });
            return true;
        }
        chrome.tabs.sendMessage(sender.tab.id, { 
            action: "toggleDarkMode",
            tabId: sender.tab.id,
            url: sender.tab.url
        }, (response) => {
            sendResponse({ success: true, response, tabId: sender.tab.id });
        });
        return true;
    }

    if (message.action === "blacklistSite") {
        const url = new URL(sender.tab.url).hostname.replace("www.", "");
        chrome.storage.local.get("blacklisted_sites", (data) => {
            let blacklistedSites = data.blacklisted_sites || [];
            if (!blacklistedSites.includes(url)) {
                blacklistedSites.push(url);
                chrome.storage.local.set({ blacklisted_sites: blacklistedSites }, () => {
                    sendResponse({ success: true, sites: blacklistedSites });
                });
            } else {
                sendResponse({ success: false, message: "Site already blacklisted" });
            }
        });
        return true;
    }

    if (message.action === "removeFromBlacklist") {
        chrome.storage.local.get("blacklisted_sites", (data) => {
            let blacklistedSites = data.blacklisted_sites.filter(site => site !== message.site);
            chrome.storage.local.set({ blacklisted_sites: blacklistedSites }, () => {
                sendResponse({ success: true, sites: blacklistedSites });
            });
        });
        return true;
    }
});