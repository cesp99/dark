document.addEventListener("DOMContentLoaded", () => {
    const siteToggle = document.getElementById("siteToggle");
    const siteList = document.getElementById("site-list-items");
    const addSiteBtn = document.getElementById("addSiteBtn");
    const siteInput = document.getElementById("siteInput");
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
        browser.storage.local.get(["listMode", "blacklist_sites", "whitelist_sites", "tempDisabled"], (data) => {
            // Set list mode
            currentMode = data.listMode || "blacklist";
            listMode.value = currentMode;
            updateUIText();
    
    
            // Update site toggle state for current domain
            browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
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
        browser.storage.local.get([currentMode + "_sites"], (data) => {
            const sites = data[currentMode + "_sites"] || [];
            browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const url = new URL(tabs[0].url);
                const domain = url.hostname.replace("www.", "");
                siteToggle.checked = sites.includes(domain);
                browser.storage.local.set({ listMode: currentMode }, () => {
                    updateUIText();
                    browser.tabs.sendMessage(tabs[0].id, { 
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

    browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const url = new URL(tabs[0].url);
        const domain = url.hostname.replace("www.", "");

        siteToggle.addEventListener("change", () => {
            browser.storage.local.get([currentMode + "_sites"], (data) => {
                let sites = data[currentMode + "_sites"] || [];

                if (siteToggle.checked && !sites.includes(domain)) {
                    sites.push(domain);
                } else {
                    sites = sites.filter(site => site !== domain);
                }

                let storageUpdate = {};
                storageUpdate[currentMode + "_sites"] = sites;
                browser.storage.local.set(storageUpdate, () => {
                    browser.tabs.sendMessage(tabs[0].id, { 
                        action: "toggleDarkMode",
                        mode: currentMode,
                        sites: sites
                    });
                    updateSiteList();
                });
            });
        });

        addSiteBtn.addEventListener("click", addSite);
        siteInput.addEventListener("keyup", (e) => {
            if (e.key === "Enter") addSite();
        });
    });

    function isValidDomainPattern(pattern) {
        // Allow exact domains, *.domain.com, or domain.* patterns
        return /^(\*\.[a-z0-9-]+\.[a-z0-9-.]+|[a-z0-9-]+\.[a-z0-9-.]+|[a-z0-9-]+\.\*)$/.test(pattern);
    }

    function addSite() {
        let newSite = siteInput.value.trim().toLowerCase();
        if (newSite && !newSite.startsWith("http") && isValidDomainPattern(newSite)) {
            browser.storage.local.get([currentMode + "_sites"], (data) => {
                let sites = data[currentMode + "_sites"] || [];
                if (!sites.includes(newSite)) {
                    sites.push(newSite);
                    let storageUpdate = {};
                    storageUpdate[currentMode + "_sites"] = sites;
                    browser.storage.local.set(storageUpdate, () => {
                        updateSiteList();
                    });
                }
            });
            siteInput.value = "";
        } else if (!isValidDomainPattern(newSite)) {
            alert("Please enter a valid domain pattern (e.g., example.com, *.example.com, or example.*)");
        }
    }

    function updateSiteList() {
        browser.storage.local.get([currentMode + "_sites"], (data) => {
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
                    browser.storage.local.set(storageUpdate, () => {
                        updateSiteList();
                    });
                });
            });
        });
    }
});
