document.addEventListener("DOMContentLoaded", () => {
    const siteToggle = document.getElementById("siteToggle");
    const siteList = document.getElementById("site-list-items");
    const addSite = document.getElementById("addSite");
    const newSite = document.getElementById("newSite");
    const listMode = document.getElementById("listMode");
    const listTypeText = document.getElementById("listTypeText");
    const listTitle = document.getElementById("listTitle");
    const currentUrl = document.getElementById("currentUrl");
    const tabs = document.querySelectorAll(".tab");
    const tabContents = document.querySelectorAll(".tab-content");

    // Tab switching
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            tabContents.forEach(content => content.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById(`${tab.dataset.tab}-tab`).classList.add("active");
        });
    });

    let currentMode = "blacklist";
    // Load initial mode and sync UI
    function initializeUI() {
        chrome.storage.local.get(["listMode", "blacklist_sites", "whitelist_sites", "tempDisabled"], (data) => {
            // Set list mode
            currentMode = data.listMode || "blacklist";
            listMode.value = currentMode;
            updateUIText();
    
            // Update site toggle state for current domain
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const url = new URL(tabs[0].url);
                const domain = url.hostname.replace("www.", "");
                currentUrl.textContent = domain;
                const sites = data[currentMode + "_sites"] || [];
                siteToggle.checked = sites.includes(domain);
                updateSiteList();
            });
        });
    }

    // Initialize UI when popup opens
    initializeUI();

    // Mode change handler
    listMode.addEventListener("change", () => {
        currentMode = listMode.value;
        chrome.storage.local.get([currentMode + "_sites"], (data) => {
            const sites = data[currentMode + "_sites"] || [];
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const url = new URL(tabs[0].url);
                const domain = url.hostname.replace("www.", "");
                siteToggle.checked = sites.includes(domain);
                chrome.storage.local.set({ listMode: currentMode }, () => {
                    updateUIText();
                    chrome.tabs.sendMessage(tabs[0].id, { 
                        action: "toggleDarkMode",
                        mode: currentMode,
                        sites: sites
                    });
                    updateSiteList();
                });
            });
        });
    });

    function updateUIText() {
        listTypeText.textContent = currentMode === "blacklist" ? "Blacklist" : "Whitelist";
        listTitle.textContent = currentMode === "blacklist" ? "Blacklisted" : "Whitelisted";
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const url = new URL(tabs[0].url);
        const domain = url.hostname.replace("www.", "");

        siteToggle.addEventListener("change", () => {
            chrome.storage.local.get([currentMode + "_sites"], (data) => {
                let sites = data[currentMode + "_sites"] || [];

                if (siteToggle.checked && !sites.includes(domain)) {
                    sites.push(domain);
                } else {
                    sites = sites.filter(site => site !== domain);
                }

                let storageUpdate = {};
                storageUpdate[currentMode + "_sites"] = sites;
                chrome.storage.local.set(storageUpdate, () => {
                    chrome.tabs.sendMessage(tabs[0].id, { 
                        action: "toggleDarkMode",
                        mode: currentMode,
                        sites: sites
                    });
                    updateSiteList();
                });
            });
        });

        addSite.addEventListener("click", addNewSite);
        newSite.addEventListener("keyup", (e) => {
            if (e.key === "Enter") addNewSite();
        });
    });

    function isValidDomainPattern(pattern) {
        // Allow exact domains, *.domain.com, or domain.* patterns
        return /^(\*\.[a-z0-9-]+\.[a-z0-9-.]+|[a-z0-9-]+\.[a-z0-9-.]+|[a-z0-9-]+\.\*)$/.test(pattern);
    }

    function addNewSite() {
        let site = newSite.value.trim().toLowerCase();
        if (site && !site.startsWith("http") && isValidDomainPattern(site)) {
            chrome.storage.local.get([currentMode + "_sites"], (data) => {
                let sites = data[currentMode + "_sites"] || [];
                if (!sites.includes(site)) {
                    sites.push(site);
                    let storageUpdate = {};
                    storageUpdate[currentMode + "_sites"] = sites;
                    chrome.storage.local.set(storageUpdate, () => {
                        updateSiteList();
                    });
                }
            });
            newSite.value = "";
        } else if (!isValidDomainPattern(site)) {
            alert("Please enter a valid domain pattern (e.g., example.com, *.example.com, or example.*)");
        }
    }

    function updateSiteList() {
        chrome.storage.local.get([currentMode + "_sites"], (data) => {
            let sites = data[currentMode + "_sites"] || [];
            siteList.innerHTML = "";
            sites.forEach(site => {
                let item = document.createElement("div");
                item.className = "site-item";
                item.innerHTML = `<span>${site}</span> <button data-site="${site}">X</button>`;
                siteList.appendChild(item);
            });

            document.querySelectorAll(".site-item button").forEach(button => {
                button.addEventListener("click", () => {
                    let siteToRemove = button.getAttribute("data-site");
                    let sites = data[currentMode + "_sites"].filter(site => site !== siteToRemove);
                    let storageUpdate = {};
                    storageUpdate[currentMode + "_sites"] = sites;
                    chrome.storage.local.set(storageUpdate, () => {
                        updateSiteList();
                    });
                });
            });
        });
    }
});