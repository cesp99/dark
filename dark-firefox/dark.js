(function() {
    // Configuration object for customizable dark mode settings
    const DarkModeConfig = {
        primaryBackground: '#121212',
        primaryText: '#e0e0e0',
        accentColor: '#bb86fc',
        secondaryBackground: '#2B2B2B',
        borderColor: '#444444',
        imageAdjustment: {
            brightness: 0.8,
            contrast: 1.2,
            saturation: 1.1
        },
        excludedSelectors: [
            'img[alt*="darkmode"]',
            'picture[alt*="darkmode"]',
            'video[alt*="darkmode"]',
            '.no-dark-mode',
            '.darkmode-exempt'
        ]
    };

    // Advanced dark mode injection function
    function injectDarkMode() {
        const style = document.createElement('style');
        style.id = 'dark-mode-styles';
        style.innerHTML = `
            /* Dynamic dark mode styles with enhanced configurability */
            body, html {
                background-color: ${DarkModeConfig.primaryBackground} !important;
                color: ${DarkModeConfig.primaryText} !important;
            }

            /* Universal dark mode application with exclusion support */
            *:not(${DarkModeConfig.excludedSelectors.join(',')}) {
                background-color: ${DarkModeConfig.primaryBackground} !important;
                color: ${DarkModeConfig.primaryText} !important;
                border-color: ${DarkModeConfig.borderColor} !important;
                transition: background-color 0.2s ease, color 0.2s ease;
            }

            /* Enhanced link styling */
            a, a:visited {
                color: ${DarkModeConfig.accentColor} !important;
                transition: color 0.2s ease;
            }

            a:hover, a:focus {
                color: ${DarkModeConfig.accentColor} !important;
            }

            /* Interactive elements */
            button, input, select, textarea {
                background-color: ${DarkModeConfig.secondaryBackground} !important;
                color: ${DarkModeConfig.primaryText} !important;
                border: 1px solid ${DarkModeConfig.borderColor} !important;
                transition: background-color 0.2s ease;
            }

            button:hover, input:hover, select:hover {
                background-color: #444 !important;
            }

            /* Smart image processing */
            img, picture, video {
                filter: brightness(${DarkModeConfig.imageAdjustment.brightness}) 
                        contrast(${DarkModeConfig.imageAdjustment.contrast}) 
                        saturate(${DarkModeConfig.imageAdjustment.saturation}) !important;
                transition: filter 0.2s ease;
            }

            /* Advanced scrollbar styling */
            ::-webkit-scrollbar {
                width: 12px;
                height: 12px;
            }
            ::-webkit-scrollbar-thumb {
                background-color: #444;
                border-radius: 10px;
            }
            ::-webkit-scrollbar-track {
                background-color: #222;
            }

            /* Code and pre elements */
            pre, code {
                background-color: ${DarkModeConfig.secondaryBackground} !important;
                color: ${DarkModeConfig.primaryText} !important;
                border-radius: 5px;
                padding: 5px;
            }

            /* Selection highlight */
            ::selection {
                background-color: ${DarkModeConfig.accentColor};
                color: #ffffff;
            }
        `;
        document.head.appendChild(style);
    }

    function removeDarkMode() {
        const existingStyles = document.getElementById('dark-mode-styles');
        if (existingStyles) existingStyles.remove();
    }

    function matchDomain(pattern, domain) {
        if (pattern.startsWith('*.')) {
            const suffix = pattern.slice(2);
            return domain.endsWith(suffix);
        } else if (pattern.endsWith('.*')) {
            const prefix = pattern.slice(0, -2);
            return domain.startsWith(prefix);
        }
        return pattern === domain;
    }

    function checkAndApplyDarkMode() {
        browser.storage.local.get(['listMode', 'blacklist_sites', 'whitelist_sites'], (data) => {
            const url = new URL(window.location.href);
            const domain = url.hostname.replace('www.', '');
            const mode = data.listMode || 'blacklist';
            const sites = data[mode + '_sites'] || [];

            const isMatched = sites.some(pattern => matchDomain(pattern, domain));

            if (mode === 'blacklist') {
                if (isMatched) {
                    removeDarkMode();
                } else {
                    injectDarkMode();
                }
            } else { // whitelist mode
                if (isMatched) {
                    injectDarkMode();
                } else {
                    removeDarkMode();
                }
            }
        });
    }

    // Listen for messages from popup with enhanced security
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Verify message origin for security
        if (!sender.id || sender.id !== browser.runtime.id) {
            sendResponse({ success: false, error: 'Invalid message origin' });
            return true;
        }

        // Handle different message actions with proper sender context
        if (message.action === 'toggleDarkMode') {
            checkAndApplyDarkMode();
            sendResponse({ success: true });
        } else if (message.action === 'applyDarkMode') {
            injectDarkMode();
            sendResponse({ success: true });
        } else if (message.action === 'removeDarkMode') {
            removeDarkMode();
            sendResponse({ success: true });
        } else if (message.action === 'tempToggleDarkMode') {
            if (message.enabled !== undefined) {
                message.enabled ? checkAndApplyDarkMode() : removeDarkMode();
            } else {
                const darkModeStyle = document.getElementById('dark-mode-styles');
                darkModeStyle ? removeDarkMode() : checkAndApplyDarkMode();
            }
            sendResponse({ success: true });
        }
        return true;
    });

    // Initial check
    checkAndApplyDarkMode();
})();
