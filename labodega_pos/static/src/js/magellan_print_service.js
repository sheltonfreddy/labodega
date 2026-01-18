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
 * Properly encodes the string as bytes for the printer
 */
async function sendToPrinter(data) {
    if (!bridgeUrl) {
        throw new Error("Bridge URL not configured");
    }

    try {
        console.log("[Magellan Print] Sending to printer:", bridgeUrl, "Data length:", data.length);

        // Convert string to Uint8Array for proper byte transmission
        // This ensures ESC/POS control characters are sent correctly
        const encoder = new TextEncoder();
        const bytes = encoder.encode(data);

        console.log("[Magellan Print] Encoded bytes:", bytes.length);

        const response = await fetch(`${bridgeUrl}/print_raw`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
            },
            body: bytes,
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

// Receipt width in characters (48 for 80mm paper at standard font, 32 for 58mm)
// Using 48 to avoid cutting off text
const RECEIPT_WIDTH = 48;

/**
 * Format a two-column line (left-aligned text, right-aligned price)
 * Allows longer text and wraps if needed
 */
function formatLine(left, right, width = RECEIPT_WIDTH) {
    left = String(left || '');
    right = String(right || '');

    // Calculate available space for left side (leave room for right + 1 space)
    const rightLen = right.length;
    const maxLeftLen = width - rightLen - 1;

    // If left is too long, we need to wrap or truncate
    if (left.length > maxLeftLen) {
        // For now, truncate with ellipsis but keep more chars
        left = left.substring(0, maxLeftLen - 1) + '…';
    }

    const padding = width - left.length - right.length;
    return left + ' '.repeat(Math.max(1, padding)) + right;
}

/**
 * Format a single line that may need wrapping
 */
function formatSingleLine(text, width = RECEIPT_WIDTH) {
    text = String(text || '');
    if (text.length <= width) return text;

    // Split into multiple lines
    const lines = [];
    while (text.length > 0) {
        lines.push(text.substring(0, width));
        text = text.substring(width);
    }
    return lines.join('\n');
}

/**
 * Center text within receipt width
 */
function centerText(text, width = RECEIPT_WIDTH) {
    text = String(text || '');
    if (text.length >= width) return text.substring(0, width);
    const padding = Math.floor((width - text.length) / 2);
    return ' '.repeat(padding) + text;
}

/**
 * Convert HTML element to ESC/POS format
 * Specifically handles the compact receipt template structure
 */
function htmlToEscPos(element) {
    let output = COMMANDS.INIT;

    // Debug: Log the HTML structure we're receiving
    console.log("[Magellan Print] HTML to convert:", element.outerHTML?.substring(0, 500));
    console.log("[Magellan Print] Classes:", element.className);

    // Try to detect if this is a compact receipt
    const compactEl = element.querySelector('.compact-receipt');
    const posReceiptEl = element.querySelector('.pos-receipt');

    console.log("[Magellan Print] Found .compact-receipt:", !!compactEl);
    console.log("[Magellan Print] Found .pos-receipt:", !!posReceiptEl);
    console.log("[Magellan Print] Element has .compact-receipt:", element.classList?.contains('compact-receipt'));

    const isCompactReceipt = compactEl || posReceiptEl ||
                              element.classList?.contains('compact-receipt') ||
                              element.classList?.contains('pos-receipt');

    if (isCompactReceipt) {
        console.log("[Magellan Print] Using compact receipt converter");
        // Use the found element or the main element
        const receiptEl = compactEl || posReceiptEl || element;
        output += convertCompactReceipt(receiptEl);
    } else {
        console.log("[Magellan Print] Using generic HTML converter");
        output += convertGenericHtml(element);
    }

    output += COMMANDS.FEED_3;
    output += COMMANDS.CUT;

    console.log("[Magellan Print] Final ESC/POS output preview:", output.substring(0, 300));
    return output;
}

/**
 * Convert compact receipt HTML to ESC/POS
 */
function convertCompactReceipt(element) {
    let output = '';
    const separator = '-'.repeat(RECEIPT_WIDTH) + '\n';
    const thinSeparator = '-'.repeat(RECEIPT_WIDTH) + '\n';

    // Header - Company name (bold, centered)
    output += COMMANDS.ALIGN_CENTER;
    output += COMMANDS.BOLD_ON;

    // Try to get company name from various places
    const logoSection = element.querySelector('.logo-section');
    const companyName = element.querySelector('.company-name');

    // If there's a company name element, use it
    if (companyName && companyName.textContent.trim()) {
        output += companyName.textContent.trim() + '\n';
    } else {
        // Default company name if not found
        output += 'LA BODEGA\n';
    }
    output += COMMANDS.BOLD_OFF;

    // Company info (address, phone - centered)
    const companyInfo = element.querySelector('.company-info, .h2');
    if (companyInfo) {
        const infoText = companyInfo.innerText.trim();
        if (infoText) {
            const lines = infoText.split('\n').filter(l => l.trim());
            for (const line of lines) {
                output += line.trim() + '\n';
            }
        }
    }
    output += COMMANDS.ALIGN_LEFT;
    output += '\n';

    // Meta info (order #, date, cashier)
    const meta = element.querySelector('.meta');
    if (meta) {
        const metaRows = meta.querySelectorAll('.meta-row');
        for (const row of metaRows) {
            const lbl = row.querySelector('.meta-lbl')?.textContent?.trim() || '';
            const val = row.querySelector('.meta-val')?.textContent?.trim() || row.textContent.trim();
            if (lbl && val) {
                output += formatLine(lbl + ':', val) + '\n';
            } else if (val) {
                output += val + '\n';
            }
        }
    }

    // Separator
    output += separator;

    // Order lines
    const linesContainer = element.querySelector('.lines');
    if (linesContainer) {
        const orderlines = linesContainer.querySelectorAll('.orderline-row');

        for (const line of orderlines) {
            // Get product name, qty, and price
            const nameEl = line.querySelector('.name');
            const qtyEl = line.querySelector('.qty');
            const priceEl = line.querySelector('.price-cell, .price');

            let productName = nameEl?.textContent?.trim() || '';
            let qty = qtyEl?.textContent?.trim() || '';
            let price = priceEl?.textContent?.trim() || '';

            // If no specific elements, try table cells
            if (!productName) {
                const nameCell = line.querySelector('.product-name-cell');
                if (nameCell) {
                    productName = nameCell.querySelector('.name')?.textContent?.trim() ||
                                  nameCell.textContent.trim().split(/\s+x/)[0];
                    const qtyMatch = nameCell.textContent.match(/x([\d.]+)/);
                    if (qtyMatch) qty = 'x' + qtyMatch[1];
                }
            }
            if (!price) {
                const cells = line.querySelectorAll('td');
                if (cells.length >= 2) {
                    price = cells[cells.length - 1].textContent.trim();
                }
            }

            // Build the line
            let leftPart = productName;
            if (qty && qty !== 'x1' && qty !== 'x1.00' && !qty.includes('1.00')) {
                leftPart += ' ' + qty;
            }

            if (leftPart && price) {
                output += formatLine(leftPart, price) + '\n';
            } else if (leftPart || price) {
                output += (leftPart || price) + '\n';
            }

            // Check for sub-line (qty @ unit price) - look at next sibling
            let nextEl = line.nextElementSibling;
            while (nextEl && nextEl.classList?.contains('sub')) {
                output += '  ' + nextEl.textContent.trim() + '\n';
                nextEl = nextEl.nextElementSibling;
            }

            // Check for notes
            const note = line.querySelector('.note');
            if (note) {
                output += '  ' + note.textContent.trim() + '\n';
            }
        }

        // Also handle .sub elements that might be direct children
        const subLines = linesContainer.querySelectorAll(':scope > .sub');
        // These are already handled above when iterating orderlines
    }

    // Separator before totals
    output += separator;

    // Totals section
    const totals = element.querySelector('.totals');
    if (totals) {
        const rows = totals.querySelectorAll('tr');
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
                const label = cells[0].textContent.trim();
                const amount = cells[1].textContent.trim();

                // Check if this is the TOTAL row - make it bold
                if (row.classList.contains('total-row') ||
                    label.toUpperCase() === 'TOTAL' ||
                    row.closest('.total-row')) {
                    output += COMMANDS.BOLD_ON;
                    output += formatLine(label, amount) + '\n';
                    output += COMMANDS.BOLD_OFF;
                } else {
                    output += formatLine(label, amount) + '\n';
                }
            }
        }
    }

    // Footer text (custom message)
    const footerText = element.querySelector('.footer-text');
    if (footerText && footerText.textContent.trim()) {
        output += '\n';
        output += COMMANDS.ALIGN_CENTER;
        output += footerText.textContent.trim() + '\n';
        output += COMMANDS.ALIGN_LEFT;
    }

    // Thank you message
    const thanks = element.querySelector('.thanks');
    if (thanks) {
        output += '\n';
        output += COMMANDS.ALIGN_CENTER;
        output += COMMANDS.BOLD_ON;
        output += thanks.textContent.trim() + '\n';
        output += COMMANDS.BOLD_OFF;
        output += COMMANDS.ALIGN_LEFT;
    }

    // Generic footer
    const footer = element.querySelector('.footer');
    if (footer && !thanks) {
        const footerContent = footer.textContent.trim();
        if (footerContent) {
            output += '\n';
            output += COMMANDS.ALIGN_CENTER;
            output += footerContent + '\n';
            output += COMMANDS.ALIGN_LEFT;
        }
    }

    return output;
}

/**
 * Generic HTML to ESC/POS conversion (fallback)
 */
function convertGenericHtml(element) {
    let output = '';

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
                return '-'.repeat(RECEIPT_WIDTH) + '\n';

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
                // Check for separator class
                if (className.includes('sep')) {
                    return '-'.repeat(RECEIPT_WIDTH) + '\n';
                }
                for (const child of node.childNodes) {
                    text += processNode(child, depth + 1);
                }
                if (text && !text.endsWith('\n')) {
                    text += '\n';
                }
                return text;

            case 'span':
                for (const child of node.childNodes) {
                    text += processNode(child, depth + 1);
                }
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
                        text += formatLine(cellTexts[0], cellTexts[1]) + '\n';
                    } else if (cellTexts.length > 0) {
                        text += cellTexts.join('  ') + '\n';
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

    output = processNode(element);
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

