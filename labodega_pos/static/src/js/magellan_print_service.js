/** @odoo-module **/

import { registry } from "@web/core/registry";
import { patch } from "@web/core/utils/patch";
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
        console.log("[Magellan Print] Sending to printer:", bridgeUrl);

        const response = await fetch(`${bridgeUrl}/print_raw`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
            },
            body: data,
            signal: AbortSignal.timeout(15000),
            targetAddressSpace: 'private',
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
            targetAddressSpace: 'private',
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
 * Convert base64 image to ESC/POS raster format
 * This is simplified - full implementation would need proper bitmap conversion
 */
function imageToEscPos(base64Image) {
    // For now, we'll skip image printing and just return empty
    // A full implementation would convert the image to ESC/POS bitmap format
    console.log("[Magellan Print] Image printing not fully implemented yet");
    return '';
}

/**
 * Magellan Print Service - integrates with Odoo's printer system
 */
const magellanPrintService = {
    dependencies: ["pos", "hardware_proxy"],

    start(env, { pos, hardware_proxy }) {
        console.log("[Magellan Print] Service starting");

        // Get bridge URL from POS config
        bridgeUrl = getBridgeUrl(pos);
        console.log("[Magellan Print] Bridge URL:", bridgeUrl);

        // Create the Magellan printer object
        const magellanPrinter = {
            /**
             * Print receipt - called by Odoo's print system
             * @param {HTMLElement|string} receipt - Receipt HTML element or base64 image
             * @returns {Promise<{successful: boolean, message?: object}>}
             */
            async printReceipt(receipt) {
                console.log("[Magellan Print] printReceipt called");

                try {
                    let data;

                    if (typeof receipt === 'string' && receipt.length > 100) {
                        // This is likely a base64 image from Odoo's htmlToCanvas
                        // We need to convert to ESC/POS format
                        console.log("[Magellan Print] Received base64 image");

                        // For now, send as raw image data
                        // The Pi bridge will need to handle conversion
                        const response = await fetch(`${bridgeUrl}/print_image`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ image: receipt }),
                            signal: AbortSignal.timeout(15000),
                            targetAddressSpace: 'private',
                        });

                        if (response.ok) {
                            const result = await response.json();
                            if (result.status !== "error") {
                                return { successful: true };
                            }
                        }

                        // Fallback: try to decode and print text
                        console.log("[Magellan Print] Image print failed, falling back");
                    }

                    // If it's an HTML element, extract text content
                    if (receipt instanceof HTMLElement) {
                        data = this.htmlToEscPos(receipt);
                    } else if (typeof receipt === 'string' && receipt.includes('<')) {
                        // HTML string
                        const div = document.createElement('div');
                        div.innerHTML = receipt;
                        data = this.htmlToEscPos(div);
                    } else {
                        // Plain text or unknown
                        data = COMMANDS.INIT + (receipt || 'No content') + COMMANDS.FEED_5 + COMMANDS.CUT;
                    }

                    await sendToPrinter(data);
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

            /**
             * Convert HTML element to ESC/POS format
             */
            htmlToEscPos(element) {
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
                            // Skip images for text-based printing
                            return '';

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
            },
        };

        // Expose globally for debugging
        window.magellanPrinter = magellanPrinter;

        // Patch the hardware proxy to use our printer
        if (hardware_proxy && hardware_proxy.printer) {
            console.log("[Magellan Print] Patching hardware_proxy.printer");

            const originalPrinter = hardware_proxy.printer;

            // Create a wrapper that tries Magellan first
            hardware_proxy.printer = {
                ...originalPrinter,

                async printReceipt(receipt) {
                    console.log("[Magellan Print] Intercepted printReceipt");

                    // Try Magellan printer first
                    try {
                        const result = await magellanPrinter.printReceipt(receipt);
                        if (result.successful) {
                            console.log("[Magellan Print] ✅ Printed via Magellan");
                            return result;
                        }
                    } catch (err) {
                        console.warn("[Magellan Print] Magellan print failed:", err.message);
                    }

                    // Fallback to original printer
                    console.log("[Magellan Print] Falling back to default printer");
                    if (originalPrinter.printReceipt) {
                        return originalPrinter.printReceipt(receipt);
                    }

                    return { successful: false };
                },

                async openCashbox() {
                    console.log("[Magellan Print] Intercepted openCashbox");

                    try {
                        await magellanPrinter.openCashbox();
                        return { successful: true };
                    } catch (err) {
                        console.warn("[Magellan Print] Magellan drawer failed:", err.message);
                    }

                    if (originalPrinter.openCashbox) {
                        return originalPrinter.openCashbox();
                    }

                    return { successful: false };
                },

                // Keep the 'is' check
                is: () => true,
            };

            console.log("[Magellan Print] ✅ Hardware proxy patched");
        }

        return magellanPrinter;
    },
};

// Register the service
registry.category("services").add("magellan_print", magellanPrintService);

console.log("[Magellan Print] Service registered");

