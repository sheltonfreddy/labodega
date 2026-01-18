/** @odoo-module **/

import { registry } from "@web/core/registry";
import { getBridgeUrl } from "./magellan_config";

/**
 * Magellan Print Service
 * Sends receipts directly to Raspberry Pi Epson printer without browser print dialog
 */

console.log("[Magellan Print] magellan_print_service.js loaded");

// ESC/POS Commands
const ESC = '\x1b';
const GS = '\x1d';
const COMMANDS = {
    INIT: ESC + '@',                    // Initialize printer
    BOLD_ON: ESC + 'E' + '\x01',        // Bold on
    BOLD_OFF: ESC + 'E' + '\x00',       // Bold off
    ALIGN_LEFT: ESC + 'a' + '\x00',     // Left align
    ALIGN_CENTER: ESC + 'a' + '\x01',   // Center align
    ALIGN_RIGHT: ESC + 'a' + '\x02',    // Right align
    DOUBLE_ON: ESC + '!' + '\x30',      // Double height + width
    NORMAL: ESC + '!' + '\x00',         // Normal size
    CUT: GS + 'V' + '\x00',             // Full cut
    PARTIAL_CUT: GS + 'V' + '\x01',     // Partial cut
    FEED_3: '\n\n\n',                   // Feed 3 lines
    FEED_5: '\n\n\n\n\n',               // Feed 5 lines
    OPEN_DRAWER: ESC + 'p' + '\x00' + '\x19' + '\x19',  // Open cash drawer
};

// Store bridge URL globally
let bridgeUrl = null;

/**
 * Send raw ESC/POS data to printer via Pi bridge
 */
async function sendToPrinter(data) {
    if (!bridgeUrl) {
        throw new Error("Bridge URL not configured");
    }

    try {
        console.log("[Magellan Print] Sending to printer:", bridgeUrl, "Data length:", data.length);

        const response = await fetch(`${bridgeUrl}/print_raw`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
            },
            body: data,
            signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        console.log("[Magellan Print] Print result:", result);

        if (result.status === "error") {
            throw new Error(result.message);
        }

        return { successful: true, result };
    } catch (err) {
        console.error("[Magellan Print] Print error:", err);
        throw err;
    }
}

/**
 * Open cash drawer via Pi bridge
 */
async function openCashDrawer() {
    if (!bridgeUrl) {
        throw new Error("Bridge URL not configured");
    }

    try {
        const response = await fetch(`${bridgeUrl}/open_drawer`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: '{}',
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        console.log("[Magellan Print] Cash drawer result:", result);
        return result;
    } catch (err) {
        console.error("[Magellan Print] Cash drawer error:", err);
        throw err;
    }
}

/**
 * Convert HTML element to ESC/POS format
 */
function htmlToEscPos(element) {
    let output = COMMANDS.INIT;

    const processNode = (node, depth = 0) => {
        let text = '';

        if (node.nodeType === Node.TEXT_NODE) {
            const content = node.textContent.trim();
            if (content) {
                return content;
            }
            return '';
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        const tagName = node.tagName?.toLowerCase() || '';
        const className = node.className || '';

        switch (tagName) {
            case 'br':
                return '\n';

            case 'hr':
                return '-'.repeat(42) + '\n';

            case 'h1':
            case 'h2':
            case 'h3':
                text += COMMANDS.ALIGN_CENTER + COMMANDS.BOLD_ON;
                for (const child of node.childNodes) {
                    text += processNode(child, depth + 1);
                }
                text += COMMANDS.BOLD_OFF + COMMANDS.ALIGN_LEFT + '\n';
                return text;

            case 'b':
            case 'strong':
                text += COMMANDS.BOLD_ON;
                for (const child of node.childNodes) {
                    text += processNode(child, depth + 1);
                }
                text += COMMANDS.BOLD_OFF;
                return text;

            case 'div':
            case 'p':
            case 'section':
                for (const child of node.childNodes) {
                    text += processNode(child, depth + 1);
                }
                if (text && !text.endsWith('\n')) {
                    text += '\n';
                }
                return text;

            case 'span':
                if (className.includes('text-center') || className.includes('center')) {
                    text += COMMANDS.ALIGN_CENTER;
                } else if (className.includes('text-end') || className.includes('right')) {
                    text += COMMANDS.ALIGN_RIGHT;
                }
                for (const child of node.childNodes) {
                    text += processNode(child, depth + 1);
                }
                text += COMMANDS.ALIGN_LEFT;
                return text;

            case 'table':
                const rows = node.querySelectorAll('tr');
                for (const row of rows) {
                    const cells = row.querySelectorAll('td, th');
                    const cellTexts = [];
                    for (const cell of cells) {
                        cellTexts.push(cell.textContent.trim());
                    }
                    if (cellTexts.length === 2) {
                        const left = cellTexts[0].substring(0, 28);
                        const right = cellTexts[1].substring(0, 12);
                        const padding = 42 - left.length - right.length;
                        text += left + ' '.repeat(Math.max(1, padding)) + right + '\n';
                    } else if (cellTexts.length > 0) {
                        text += cellTexts.join(' ') + '\n';
                    }
                }
                return text;

            case 'img':
            case 'style':
            case 'script':
                return '';

            default:
                for (const child of node.childNodes) {
                    text += processNode(child, depth + 1);
                }
                return text;
        }
    };

    output += processNode(element);
    output += COMMANDS.FEED_5;
    output += COMMANDS.CUT;

    return output;
}

/**
 * Create Magellan printer device compatible with Odoo's PrinterService
 */
function createMagellanPrinterDevice() {
    return {
        /**
         * Print receipt - called by Odoo's PrinterService
         * @param {HTMLElement} receipt - Receipt HTML element
         * @returns {Promise<{successful: boolean, message?: object}>}
         */
        async printReceipt(receipt) {
            console.log("[Magellan Print] printReceipt called with:", typeof receipt);

            try {
                let data;

                // Handle HTMLElement
                if (receipt instanceof HTMLElement) {
                    console.log("[Magellan Print] Converting HTML element to ESC/POS");
                    console.log("[Magellan Print] Element HTML preview:", receipt.innerHTML.substring(0, 200));
                    data = htmlToEscPos(receipt);
                }
                // Handle string (HTML or base64)
                else if (typeof receipt === 'string') {
                    if (receipt.includes('<')) {
                        // HTML string
                        console.log("[Magellan Print] Converting HTML string to ESC/POS");
                        const div = document.createElement('div');
                        div.innerHTML = receipt;
                        data = htmlToEscPos(div);
                    } else if (receipt.length > 100) {
                        // Likely base64 image - try image endpoint
                        console.log("[Magellan Print] Attempting base64 image print");
                        try {
                            const response = await fetch(`${bridgeUrl}/print_image`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ image: receipt }),
                                signal: AbortSignal.timeout(15000),
                            });
                            if (response.ok) {
                                const result = await response.json();
                                if (result.status !== "error") {
                                    console.log("[Magellan Print] ✅ Image print successful");
                                    return { successful: true };
                                }
                            }
                        } catch (e) {
                            console.warn("[Magellan Print] Image print failed:", e);
                        }
                        // Fallback to text
                        data = COMMANDS.INIT + "Receipt Image\n" + COMMANDS.FEED_5 + COMMANDS.CUT;
                    } else {
                        // Plain text
                        data = COMMANDS.INIT + receipt + COMMANDS.FEED_5 + COMMANDS.CUT;
                    }
                } else {
                    console.warn("[Magellan Print] Unknown receipt type:", typeof receipt);
                    return { successful: false, message: { title: "Print Error", body: "Unknown receipt format" } };
                }

                console.log("[Magellan Print] Sending", data.length, "bytes to printer");
                await sendToPrinter(data);

                console.log("[Magellan Print] ✅ Print successful");
                return { successful: true };

            } catch (err) {
                console.error("[Magellan Print] Print failed:", err);
                return {
                    successful: false,
                    message: {
                        title: "Print Failed",
                        body: err.message || "Could not print to Magellan printer"
                    }
                };
            }
        },

        /**
         * Open cash drawer
         */
        async openCashbox() {
            console.log("[Magellan Print] openCashbox called");
            try {
                await openCashDrawer();
                return { successful: true };
            } catch (err) {
                console.error("[Magellan Print] Cash drawer failed:", err);
                return { successful: false };
            }
        },
    };
}

/**
 * Magellan Print Service - integrates with Odoo's printer system
 */
const magellanPrintService = {
    dependencies: ["pos", "printer", "hardware_proxy"],

    start(env, { pos, printer, hardware_proxy }) {
        console.log("[Magellan Print] Service starting");
        console.log("[Magellan Print] POS available:", !!pos);
        console.log("[Magellan Print] Printer service available:", !!printer);
        console.log("[Magellan Print] Hardware proxy available:", !!hardware_proxy);

        // Get bridge URL from POS config
        bridgeUrl = getBridgeUrl(pos);
        console.log("[Magellan Print] Bridge URL:", bridgeUrl);

        // Create the Magellan printer device
        const magellanDevice = createMagellanPrinterDevice();

        // Expose globally for debugging
        window.magellanPrinter = magellanDevice;
        window.magellanBridgeUrl = bridgeUrl;

        // Method 1: Set on hardware_proxy so PosPrinterService picks it up
        if (hardware_proxy) {
            console.log("[Magellan Print] Setting hardware_proxy.printer to Magellan device");
            hardware_proxy.printer = magellanDevice;
            console.log("[Magellan Print] ✅ hardware_proxy.printer set");
        }

        // Method 2: Also set on printer service directly
        if (printer) {
            console.log("[Magellan Print] Setting printer.device to Magellan device");
            printer.setPrinter(magellanDevice);
            console.log("[Magellan Print] ✅ printer.device set");
        }

        // Test connectivity asynchronously
        (async () => {
            try {
                const response = await fetch(`${bridgeUrl}/printer_status`, {
                    signal: AbortSignal.timeout(3000),
                });
                const status = await response.json();
                console.log("[Magellan Print] Printer status:", status);
                if (status.status === "ready") {
                    console.log("[Magellan Print] ✅ Printer is ready!");
                }
            } catch (e) {
                console.warn("[Magellan Print] Could not check printer status:", e.message);
            }
        })();

        return magellanDevice;
    },
};

// Register the service
registry.category("services").add("magellan_print", magellanPrintService);

console.log("[Magellan Print] Service registered");

