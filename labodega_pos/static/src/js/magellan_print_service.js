/** @odoo-module **/

import { registry } from "@web/core/registry";
import { getBridgeUrl } from "./magellan_config";

/**
 * Magellan Print Service
 * Sends receipts directly to Raspberry Pi Epson printer without browser print dialog
 *
 * This version parses the rendered HTML receipt that Odoo provides,
 * which is more reliable than trying to access the order model directly.
 */

console.log("[Magellan Print] magellan_print_service.js loaded (HTML PARSER VERSION)");

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
    DOUBLE_HEIGHT: ESC + '!' + '\x10',  // Double height
    DOUBLE_WIDTH: ESC + '!' + '\x20',   // Double width
    DOUBLE_ON: ESC + '!' + '\x30',      // Double height + width
    NORMAL: ESC + '!' + '\x00',         // Normal size
    UNDERLINE_ON: ESC + '-' + '\x01',   // Underline on
    UNDERLINE_OFF: ESC + '-' + '\x00',  // Underline off
    CUT: GS + 'V' + '\x00',             // Full cut
    PARTIAL_CUT: GS + 'V' + '\x01',     // Partial cut
    FEED_1: '\n',                       // Feed 1 line
    FEED_3: '\n\n\n',                   // Feed 3 lines
    FEED_5: '\n\n\n\n\n',               // Feed 5 lines
    OPEN_DRAWER: ESC + 'p' + '\x00' + '\x19' + '\x19',  // Open cash drawer
};

// Receipt width in characters (48 for 80mm paper at standard font)
const RECEIPT_WIDTH = 48;

// Store bridge URL globally
let bridgeUrl = null;
let POS_ENV = null;

/**
 * Format a two-column line (left-aligned text, right-aligned value)
 */
function formatLine(left, right, width = RECEIPT_WIDTH) {
    left = String(left || '');
    right = String(right || '');

    const rightLen = right.length;
    const maxLeftLen = width - rightLen - 1;

    // Truncate left side if too long
    if (left.length > maxLeftLen) {
        left = left.substring(0, maxLeftLen - 1) + '…';
    }

    const padding = width - left.length - right.length;
    return left + ' '.repeat(Math.max(1, padding)) + right;
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
 * Create separator line
 */
function separator(char = '-', width = RECEIPT_WIDTH) {
    return char.repeat(width);
}

/**
 * Extract text content from an element, handling nested elements
 */
function getTextContent(element) {
    if (!element) return '';
    // Get text content, normalize whitespace
    return (element.textContent || element.innerText || '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse the rendered HTML receipt and convert to ESC/POS format
 * This parses the actual Odoo 18 receipt HTML structure
 */
function parseHtmlToEscpos(receiptElement) {
    let output = COMMANDS.INIT;

    console.log("[Magellan Print] Parsing HTML receipt (Odoo 18 structure)...");
    console.log("[Magellan Print] Full HTML:", receiptElement.outerHTML.substring(0, 2000));

    // Get the receipt container
    const receipt = receiptElement.querySelector('.pos-receipt') || receiptElement;

    // === HEADER - Company Info (from ReceiptHeader component) ===
    output += COMMANDS.ALIGN_CENTER;

    // Company name - Odoo 18's ReceiptHeader puts company name as first div in .pos-receipt-contact
    const contactSection = receipt.querySelector('.pos-receipt-contact');
    let companyName = '';
    let companyInfoStartIndex = 0;

    if (contactSection) {
        // First div is usually company name
        const allDivs = contactSection.querySelectorAll('div');
        if (allDivs.length > 0) {
            companyName = getTextContent(allDivs[0]);
            companyInfoStartIndex = 1;
        }
    }

    // Fallback selectors
    if (!companyName) {
        const companyNameEl = receipt.querySelector('.pos-receipt-company-name, .company-name, h2.name');
        if (companyNameEl) {
            companyName = getTextContent(companyNameEl);
        }
    }

    if (companyName) {
        output += COMMANDS.BOLD_ON;
        output += COMMANDS.DOUBLE_HEIGHT;
        output += companyName + '\n';
        output += COMMANDS.NORMAL;
        output += COMMANDS.BOLD_OFF;
    }

    // Company address/contact - remaining divs in .pos-receipt-contact
    if (contactSection) {
        const allDivs = contactSection.querySelectorAll('div');
        for (let i = companyInfoStartIndex; i < allDivs.length; i++) {
            const text = getTextContent(allDivs[i]);
            // Skip separator lines and cashier (handled separately)
            if (text && text.length > 2 && !text.startsWith('---') && !text.includes('Cashier')) {
                output += text + '\n';
            }
        }

        // Look for cashier in .cashier
        const cashierEl = contactSection.querySelector('.cashier');
        if (cashierEl) {
            const cashierText = getTextContent(cashierEl).replace(/^-+/, '').trim();
            if (cashierText) {
                output += '\n';
                output += formatLine('Cashier:', cashierText) + '\n';
            }
        }
    }

    output += COMMANDS.ALIGN_LEFT;
    output += '\n';

    // === ORDER INFO ===
    output += separator() + '\n';

    // Look for order data at the bottom (Odoo 18 puts it in .pos-receipt-order-data)
    const orderDataElements = receipt.querySelectorAll('.pos-receipt-order-data');
    let orderName = '';
    let orderDate = '';
    for (const el of orderDataElements) {
        const text = getTextContent(el);
        if (text.startsWith('Order')) {
            orderName = text;
        } else if (/\d{2}\/\d{2}\/\d{4}/.test(text) || /\d{4}-\d{2}-\d{2}/.test(text)) {
            orderDate = text;
        }
    }

    // Also check #order-date
    const orderDateEl = receipt.querySelector('#order-date');
    if (orderDateEl) {
        orderDate = getTextContent(orderDateEl);
    }

    if (orderName) {
        output += formatLine('Order:', orderName.replace('Order', '').trim()) + '\n';
    }
    if (orderDate) {
        output += formatLine('Date:', orderDate) + '\n';
    }

    output += separator() + '\n';

    // === ORDER LINES (Odoo 18 uses li.orderline) ===
    const orderLines = receipt.querySelectorAll('li.orderline, .orderline');

    console.log("[Magellan Print] Found", orderLines.length, "order lines in HTML");

    for (const line of orderLines) {
        // Odoo 18 structure:
        // - .product-name contains the product name
        // - .product-price.price contains the line total
        // - .qty contains the quantity
        // - .price-per-unit contains qty x unit price / unit

        const productNameEl = line.querySelector('.product-name');
        const productPriceEl = line.querySelector('.product-price.price, .price');
        const qtyEl = line.querySelector('.qty');
        const pricePerUnitEl = line.querySelector('.price-per-unit');

        const productName = productNameEl ? getTextContent(productNameEl) : '';
        const price = productPriceEl ? getTextContent(productPriceEl) : '';
        const qty = qtyEl ? getTextContent(qtyEl) : '';

        console.log("[Magellan Print] Line:", { productName, price, qty });

        if (productName) {
            // Format: Product Name (with qty if not 1)          Price
            let displayName = productName;
            if (qty && qty !== '1' && qty !== '1.00') {
                displayName += ` x${qty}`;
            }
            output += formatLine(displayName, price) + '\n';

            // Show unit price breakdown if qty > 1
            if (pricePerUnitEl && qty && qty !== '1') {
                const pricePerUnitText = getTextContent(pricePerUnitEl);
                // Extract just the unit price part
                const unitPriceMatch = pricePerUnitText.match(/x\s*([\$€£]?\s*[\d,.]+)/);
                if (unitPriceMatch) {
                    output += `  ${qty} @ ${unitPriceMatch[1]}\n`;
                }
            }
        }
    }

    // If no orderlines found with li.orderline, try alternative selectors
    if (orderLines.length === 0) {
        console.log("[Magellan Print] No orderlines found, trying alternative parsing...");

        // Look for any element that contains product and price info
        const allText = getTextContent(receipt);
        console.log("[Magellan Print] Receipt full text:", allText.substring(0, 500));
    }

    output += separator() + '\n';

    // === TOTALS (Odoo 18 uses .receipt-total, .receipt-rounding, etc.) ===
    const receiptTotal = receipt.querySelector('.receipt-total');
    if (receiptTotal) {
        output += COMMANDS.BOLD_ON;
        output += formatLine('TOTAL', getTextContent(receiptTotal.querySelector('.pos-receipt-right-align, span:last-child') || receiptTotal)) + '\n';
        output += COMMANDS.BOLD_OFF;
    }

    // Rounding
    const receiptRounding = receipt.querySelector('.receipt-rounding');
    if (receiptRounding) {
        const roundingAmount = getTextContent(receiptRounding.querySelector('.pos-receipt-right-align, span:last-child'));
        output += formatLine('Rounding:', roundingAmount) + '\n';
    }

    output += separator() + '\n';

    // === PAYMENT INFO (Odoo 18 uses .paymentlines div) ===
    const paymentLinesContainer = receipt.querySelector('.paymentlines');
    if (paymentLinesContainer) {
        const paymentDivs = paymentLinesContainer.children;
        for (const payment of paymentDivs) {
            const text = getTextContent(payment);
            const rightAlign = payment.querySelector('.pos-receipt-right-align');
            if (rightAlign) {
                const method = text.replace(getTextContent(rightAlign), '').trim();
                const amount = getTextContent(rightAlign);
                output += formatLine(method, amount) + '\n';
            } else if (text.length > 3) {
                output += text + '\n';
            }
        }
    }

    // === CHANGE ===
    const changeElement = receipt.querySelector('.receipt-change');
    if (changeElement) {
        const changeAmount = getTextContent(changeElement.querySelector('.pos-receipt-right-align') || changeElement);
        output += COMMANDS.BOLD_ON;
        output += formatLine('CHANGE', changeAmount) + '\n';
        output += COMMANDS.BOLD_OFF;
    }

    // === FOOTER ===
    output += '\n';
    output += COMMANDS.ALIGN_CENTER;

    // Custom footer from config
    const footerEl = receipt.querySelector('.pos-receipt-center-align');
    if (footerEl) {
        const footerText = getTextContent(footerEl);
        if (footerText && footerText.length > 3) {
            output += footerText + '\n';
        }
    }

    // Thank you message
    output += COMMANDS.BOLD_ON;
    output += 'Thank You!\n';
    output += COMMANDS.BOLD_OFF;
    output += 'Please Come Again\n';

    output += COMMANDS.ALIGN_LEFT;
    output += COMMANDS.FEED_3;
    output += COMMANDS.CUT;

    return output;
}

/**
 * Alternative: Build receipt from exported order data if available
 * This is used when we have access to the order export data
 */
function buildEscposFromExportData(data) {
    let output = COMMANDS.INIT;

    console.log("[Magellan Print] Building from export data...", data);

    // === HEADER ===
    output += COMMANDS.ALIGN_CENTER;
    output += COMMANDS.BOLD_ON;
    output += COMMANDS.DOUBLE_HEIGHT;

    const companyName = data.headerData?.company?.name || data.company?.name || 'LA BODEGA';
    output += companyName + '\n';
    output += COMMANDS.NORMAL;
    output += COMMANDS.BOLD_OFF;

    // Company info from headerData
    if (data.headerData?.company) {
        const c = data.headerData.company;
        if (c.street) output += c.street + '\n';
        if (c.city || c.state || c.zip) {
            output += [c.city, c.state, c.zip].filter(Boolean).join(', ') + '\n';
        }
        if (c.phone) output += 'Tel: ' + c.phone + '\n';
    }

    output += COMMANDS.ALIGN_LEFT;
    output += '\n';
    output += separator() + '\n';

    // === ORDER INFO ===
    if (data.name) {
        output += formatLine('Order:', data.name) + '\n';
    }
    if (data.date) {
        output += formatLine('Date:', data.date) + '\n';
    }
    if (data.cashier) {
        output += formatLine('Cashier:', data.cashier) + '\n';
    }
    if (data.headerData?.trackingNumber) {
        output += formatLine('Ticket #:', data.headerData.trackingNumber) + '\n';
    }

    output += separator() + '\n';

    // === ORDER LINES ===
    // Odoo 18 getDisplayData() returns: productName, price (formatted string), qty (string), unitPrice (formatted string)
    const orderlines = data.orderlines || [];
    console.log("[Magellan Print] Export data orderlines count:", orderlines.length);
    if (orderlines.length > 0) {
        console.log("[Magellan Print] First orderline sample:", orderlines[0]);
    }

    for (const line of orderlines) {
        // Odoo 18 fields from getDisplayData()
        const name = line.productName || line.product_name || line.name || 'Unknown';
        const qty = line.qty || line.quantity || '1';
        // price is already formatted as string like "$ 12.50"
        const priceStr = line.price || '';
        // unitPrice is already formatted as string
        const unitPriceStr = line.unitPrice || '';

        console.log("[Magellan Print] Processing line:", { name, qty, priceStr, unitPriceStr });

        // Product name with qty if > 1
        let displayName = name;
        const qtyNum = parseFloat(qty) || 1;
        if (qtyNum !== 1) {
            displayName += ` x${qty}`;
        }

        output += formatLine(displayName, priceStr) + '\n';

        // Show unit price breakdown if qty > 1
        if (qtyNum !== 1 && unitPriceStr) {
            output += `  ${qty} @ ${unitPriceStr}\n`;
        }
    }

    output += separator() + '\n';

    // === TOTALS ===
    if (data.total_without_tax !== undefined) {
        output += formatLine('Subtotal:', '$ ' + data.total_without_tax.toFixed(2)) + '\n';
    }
    if (data.amount_tax && data.amount_tax > 0) {
        output += formatLine('Tax:', '$ ' + data.amount_tax.toFixed(2)) + '\n';
    }
    if (data.total_discount && data.total_discount > 0) {
        output += formatLine('Discount:', '-$ ' + data.total_discount.toFixed(2)) + '\n';
    }

    output += separator('=') + '\n';

    output += COMMANDS.BOLD_ON;
    output += COMMANDS.DOUBLE_HEIGHT;
    const total = data.amount_total || 0;
    output += formatLine('TOTAL:', '$ ' + total.toFixed(2)) + '\n';
    output += COMMANDS.NORMAL;
    output += COMMANDS.BOLD_OFF;

    output += separator() + '\n';

    // === PAYMENTS ===
    const paymentlines = data.paymentlines || [];
    for (const payment of paymentlines) {
        const name = payment.name || payment.payment_method || 'Payment';
        const amount = payment.amount || 0;
        output += formatLine(name + ':', '$ ' + amount.toFixed(2)) + '\n';
    }

    if (data.order_change && data.show_change) {
        output += formatLine('Change:', '$ ' + data.order_change.toFixed(2)) + '\n';
    }

    // === FOOTER ===
    output += '\n';
    output += COMMANDS.ALIGN_CENTER;

    if (data.footer) {
        output += data.footer + '\n';
    }

    output += COMMANDS.BOLD_ON;
    output += 'Thank You!\n';
    output += COMMANDS.BOLD_OFF;
    output += 'Please Come Again\n';

    output += COMMANDS.ALIGN_LEFT;
    output += COMMANDS.FEED_3;
    output += COMMANDS.CUT;

    return output;
}

/**
 * Send raw ESC/POS data to printer via Pi bridge
 */
async function sendToPrinter(data) {
    if (!bridgeUrl) {
        throw new Error("Bridge URL not configured");
    }

    try {
        console.log("[Magellan Print] Sending to printer:", bridgeUrl, "Data length:", data.length);

        // Convert string to Uint8Array for proper byte transmission
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

// Store the last receipt data for printing
let lastReceiptData = null;

/**
 * Create Magellan printer device compatible with Odoo's PrinterService
 */
function createMagellanPrinterDevice() {
    return {
        /**
         * Print receipt - called by Odoo's PrinterService
         * @param {HTMLElement} receipt - The rendered receipt HTML element
         * @returns {Promise<{successful: boolean, message?: object}>}
         */
        async printReceipt(receipt) {
            console.log("[Magellan Print] printReceipt called");
            console.log("[Magellan Print] Receipt type:", typeof receipt);
            console.log("[Magellan Print] Receipt is Element:", receipt instanceof Element);

            try {
                let escposData;

                // Check if we have stored receipt data from the print call
                if (lastReceiptData && lastReceiptData.orderlines && lastReceiptData.orderlines.length > 0) {
                    console.log("[Magellan Print] Using stored receipt export data");
                    escposData = buildEscposFromExportData(lastReceiptData);
                } else if (receipt instanceof Element || receipt instanceof HTMLElement) {
                    // Parse the HTML element
                    console.log("[Magellan Print] Parsing HTML element...");
                    console.log("[Magellan Print] HTML preview:", receipt.outerHTML.substring(0, 500));
                    escposData = parseHtmlToEscpos(receipt);
                } else if (typeof receipt === 'string') {
                    // It's HTML string - parse it
                    console.log("[Magellan Print] Parsing HTML string...");
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(receipt, 'text/html');
                    escposData = parseHtmlToEscpos(doc.body);
                } else {
                    console.error("[Magellan Print] Unknown receipt type:", typeof receipt);
                    throw new Error("Invalid receipt format");
                }

                console.log("[Magellan Print] ESC/POS data preview:", escposData.substring(0, 400));
                console.log("[Magellan Print] Sending", escposData.length, "bytes to printer");

                await sendToPrinter(escposData);

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
        console.log("[Magellan Print] Service starting (HTML PARSER VERSION)");
        console.log("[Magellan Print] POS available:", !!pos);
        console.log("[Magellan Print] Printer service available:", !!printer);
        console.log("[Magellan Print] Hardware proxy available:", !!hardware_proxy);

        // Store POS environment globally
        POS_ENV = pos;

        // Get bridge URL from POS config
        bridgeUrl = getBridgeUrl(pos);
        console.log("[Magellan Print] Bridge URL:", bridgeUrl);

        // Create the Magellan printer device
        const magellanDevice = createMagellanPrinterDevice();

        // Expose globally for debugging
        window.magellanPrinter = magellanDevice;
        window.magellanBridgeUrl = bridgeUrl;
        window.magellanPosEnv = pos;

        // Method 1: Set on hardware_proxy so PosPrinterService picks it up
        if (hardware_proxy) {
            console.log("[Magellan Print] Setting hardware_proxy.printer to Magellan device");
            hardware_proxy.printer = magellanDevice;
            console.log("[Magellan Print] ✅ hardware_proxy.printer set");
        }

        // Method 2: Override the printer service's print method to capture receipt data
        if (printer) {
            console.log("[Magellan Print] Setting printer.device to Magellan device");
            printer.setPrinter(magellanDevice);
            console.log("[Magellan Print] ✅ printer.device set");

            // Patch the print method to capture receipt data before rendering
            const originalPrint = printer.print.bind(printer);
            printer.print = async function(component, props, options) {
                // Capture the receipt data before it gets rendered
                if (props && props.data) {
                    console.log("[Magellan Print] Captured receipt export data");
                    console.log("[Magellan Print] - Order name:", props.data.name);
                    console.log("[Magellan Print] - Orderlines count:", props.data.orderlines?.length || 0);
                    console.log("[Magellan Print] - Amount total:", props.data.amount_total);
                    console.log("[Magellan Print] - Cashier:", props.data.cashier);
                    if (props.data.orderlines && props.data.orderlines.length > 0) {
                        console.log("[Magellan Print] - First line:", JSON.stringify(props.data.orderlines[0]));
                    }
                    lastReceiptData = props.data;
                } else {
                    console.log("[Magellan Print] No props.data in print call");
                    lastReceiptData = null;
                }
                return originalPrint(component, props, options);
            };
            console.log("[Magellan Print] ✅ Patched printer.print to capture receipt data");
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

console.log("[Magellan Print] Service registered (HTML PARSER VERSION)");
