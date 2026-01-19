/** @odoo-module **/

import { registry } from "@web/core/registry";
import { getBridgeUrl } from "./magellan_config";

/**
 * Magellan Print Service
 * Sends receipts directly to Raspberry Pi Epson printer without browser print dialog
 *
 * IMPORTANT: This version builds ESC/POS directly from order model data,
 * NOT from parsing HTML. This is more reliable and produces consistent output.
 */

console.log("[Magellan Print] magellan_print_service.js loaded (ORDER MODEL VERSION)");

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

// Store POS environment globally for printing
let POS_ENV = null;
let bridgeUrl = null;

/**
 * Format currency value
 */
function formatCurrency(pos, amount) {
    if (typeof amount !== 'number' || isNaN(amount)) {
        amount = 0;
    }
    const currency = pos.currency;
    const symbol = currency?.symbol || '$';
    const decimals = currency?.decimal_places ?? 2;
    const formatted = amount.toFixed(decimals);

    // Position symbol based on currency settings
    if (currency?.position === 'after') {
        return `${formatted} ${symbol}`;
    }
    return `${symbol} ${formatted}`;
}

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
 * Build ESC/POS receipt directly from order model data
 * This is the main function that creates the receipt content
 */
function buildEscposFromOrder(pos, order) {
    let output = COMMANDS.INIT;

    // === HEADER - Company Info ===
    const company = pos.company;
    output += COMMANDS.ALIGN_CENTER;
    output += COMMANDS.BOLD_ON;
    output += COMMANDS.DOUBLE_HEIGHT;
    output += (company?.name || 'LA BODEGA') + '\n';
    output += COMMANDS.NORMAL;
    output += COMMANDS.BOLD_OFF;

    // Company address
    if (company?.street) {
        output += company.street + '\n';
    }
    if (company?.city || company?.state_id || company?.zip) {
        const cityLine = [company?.city, company?.state_id?.[1], company?.zip].filter(Boolean).join(', ');
        if (cityLine) output += cityLine + '\n';
    }
    if (company?.phone) {
        output += 'Tel: ' + company.phone + '\n';
    }

    output += COMMANDS.ALIGN_LEFT;
    output += '\n';

    // === ORDER INFO ===
    output += separator() + '\n';

    // Order number
    const orderName = order.name || order.uid || 'N/A';
    output += formatLine('Order:', orderName) + '\n';

    // Date/time
    const orderDate = order.date_order || order.creation_date || new Date();
    let dateStr;
    if (orderDate instanceof Date) {
        dateStr = orderDate.toLocaleString();
    } else if (typeof orderDate === 'string') {
        dateStr = orderDate;
    } else {
        dateStr = new Date().toLocaleString();
    }
    output += formatLine('Date:', dateStr) + '\n';

    // Cashier
    const cashier = order.cashier || order.user_id || pos.user;
    const cashierName = cashier?.name || cashier?.[1] || 'N/A';
    output += formatLine('Cashier:', cashierName) + '\n';

    // Customer (if set)
    const partner = order.partner_id || order.get_partner?.();
    if (partner) {
        const partnerName = partner.name || partner[1] || '';
        if (partnerName) {
            output += formatLine('Customer:', partnerName) + '\n';
        }
    }

    output += separator() + '\n';

    // === ORDER LINES ===
    // Get orderlines - handle different Odoo versions
    let orderlines = [];
    if (typeof order.get_orderlines === 'function') {
        orderlines = order.get_orderlines();
    } else if (order.lines) {
        // Odoo 18 style - lines is a reactive object/array
        orderlines = Array.isArray(order.lines) ? order.lines : Object.values(order.lines || {});
    } else if (order.orderlines) {
        orderlines = Array.isArray(order.orderlines) ? order.orderlines : Object.values(order.orderlines || {});
    }

    console.log("[Magellan Print] Order lines count:", orderlines.length);

    for (const line of orderlines) {
        // Get product info
        const product = line.product || line.product_id || line.get_product?.();
        const productName = product?.display_name || product?.name || product?.[1] || 'Unknown Product';

        // Get quantity
        let qty = 1;
        if (typeof line.get_quantity === 'function') {
            qty = line.get_quantity();
        } else if (line.qty !== undefined) {
            qty = line.qty;
        } else if (line.quantity !== undefined) {
            qty = line.quantity;
        }

        // Get unit price
        let unitPrice = 0;
        if (typeof line.get_unit_price === 'function') {
            unitPrice = line.get_unit_price();
        } else if (line.price_unit !== undefined) {
            unitPrice = line.price_unit;
        } else if (line.unit_price !== undefined) {
            unitPrice = line.unit_price;
        }

        // Get line total (price with tax)
        let lineTotal = 0;
        if (typeof line.get_price_with_tax === 'function') {
            lineTotal = line.get_price_with_tax();
        } else if (typeof line.get_display_price === 'function') {
            lineTotal = line.get_display_price();
        } else if (line.price_subtotal_incl !== undefined) {
            lineTotal = line.price_subtotal_incl;
        } else if (line.price_subtotal !== undefined) {
            lineTotal = line.price_subtotal;
        } else {
            lineTotal = qty * unitPrice;
        }

        // Format the line
        const priceStr = formatCurrency(pos, lineTotal);

        // For qty > 1 or weighted products, show qty in the name
        let displayName = productName;
        if (qty !== 1) {
            // Check if it's a weighted product (decimal qty)
            if (qty % 1 !== 0) {
                displayName += ` x${qty.toFixed(2)}`;
            } else {
                displayName += ` x${qty}`;
            }
        }

        output += formatLine(displayName, priceStr) + '\n';

        // If qty > 1, show unit price on sub-line
        if (qty !== 1 && qty > 0) {
            const unitPriceStr = formatCurrency(pos, unitPrice);
            const qtyDisplay = qty % 1 !== 0 ? qty.toFixed(2) : qty.toString();
            output += `  ${qtyDisplay} @ ${unitPriceStr}\n`;
        }

        // Check for order line note
        const note = line.note || line.customer_note || '';
        if (note) {
            output += `  Note: ${note}\n`;
        }
    }

    output += separator() + '\n';

    // === TOTALS ===
    // Subtotal (before tax)
    let subtotal = 0;
    if (typeof order.get_total_without_tax === 'function') {
        subtotal = order.get_total_without_tax();
    } else if (order.amount_total !== undefined && order.amount_tax !== undefined) {
        subtotal = order.amount_total - order.amount_tax;
    }

    // Tax
    let tax = 0;
    if (typeof order.get_total_tax === 'function') {
        tax = order.get_total_tax();
    } else if (order.amount_tax !== undefined) {
        tax = order.amount_tax;
    }

    // Total with tax
    let total = 0;
    if (typeof order.get_total_with_tax === 'function') {
        total = order.get_total_with_tax();
    } else if (order.amount_total !== undefined) {
        total = order.amount_total;
    } else {
        total = subtotal + tax;
    }

    // Display subtotal
    output += formatLine('Subtotal:', formatCurrency(pos, subtotal)) + '\n';

    // Display tax (if any)
    if (tax > 0) {
        output += formatLine('Tax:', formatCurrency(pos, tax)) + '\n';
    }

    // Display discounts (if any)
    let discount = 0;
    if (typeof order.get_total_discount === 'function') {
        discount = order.get_total_discount();
    }
    if (discount > 0) {
        output += formatLine('Discount:', '-' + formatCurrency(pos, discount)) + '\n';
    }

    output += separator('=') + '\n';

    // TOTAL - Bold and bigger
    output += COMMANDS.BOLD_ON;
    output += COMMANDS.DOUBLE_HEIGHT;
    output += formatLine('TOTAL:', formatCurrency(pos, total)) + '\n';
    output += COMMANDS.NORMAL;
    output += COMMANDS.BOLD_OFF;

    output += separator() + '\n';

    // === PAYMENT INFO ===
    let paymentlines = [];
    if (typeof order.get_paymentlines === 'function') {
        paymentlines = order.get_paymentlines();
    } else if (order.payment_ids) {
        paymentlines = Array.isArray(order.payment_ids) ? order.payment_ids : Object.values(order.payment_ids || {});
    }

    if (paymentlines.length > 0) {
        for (const payment of paymentlines) {
            const method = payment.payment_method_id || payment.payment_method || payment.name;
            const methodName = method?.name || method?.[1] || method || 'Payment';

            let amount = 0;
            if (typeof payment.get_amount === 'function') {
                amount = payment.get_amount();
            } else if (payment.amount !== undefined) {
                amount = payment.amount;
            }

            output += formatLine(methodName + ':', formatCurrency(pos, amount)) + '\n';
        }

        // Change
        let change = 0;
        if (typeof order.get_change === 'function') {
            change = order.get_change();
        } else if (order.amount_return !== undefined) {
            change = order.amount_return;
        }

        if (change > 0) {
            output += formatLine('Change:', formatCurrency(pos, change)) + '\n';
        }

        output += '\n';
    }

    // === FOOTER ===
    output += COMMANDS.ALIGN_CENTER;

    // Custom receipt footer from POS config
    const receiptFooter = pos.config?.receipt_footer || '';
    if (receiptFooter) {
        output += receiptFooter + '\n';
        output += '\n';
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

/**
 * Create Magellan printer device compatible with Odoo's PrinterService
 */
function createMagellanPrinterDevice() {
    return {
        /**
         * Print receipt - called by Odoo's PrinterService
         * IMPORTANT: This ignores the HTML receipt and builds from order model
         * @param {HTMLElement|string} receipt - Receipt HTML element (ignored)
         * @returns {Promise<{successful: boolean, message?: object}>}
         */
        async printReceipt(receipt) {
            console.log("[Magellan Print] printReceipt called");

            try {
                // Get current order from POS environment
                if (!POS_ENV) {
                    throw new Error("POS environment not available");
                }

                // Get the current order
                let order = null;
                if (typeof POS_ENV.get_order === 'function') {
                    order = POS_ENV.get_order();
                } else if (POS_ENV.selectedOrder) {
                    order = POS_ENV.selectedOrder;
                } else if (POS_ENV.orders && POS_ENV.orders.length > 0) {
                    // Get the last/current order
                    order = POS_ENV.orders[POS_ENV.orders.length - 1];
                }

                if (!order) {
                    console.warn("[Magellan Print] No active order found");
                    throw new Error("No active order found");
                }

                console.log("[Magellan Print] Building receipt from order:", order.name || order.uid);

                // Build ESC/POS data directly from order model
                const data = buildEscposFromOrder(POS_ENV, order);

                console.log("[Magellan Print] ESC/POS data preview:", data.substring(0, 300));
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
        console.log("[Magellan Print] Service starting (ORDER MODEL VERSION)");
        console.log("[Magellan Print] POS available:", !!pos);
        console.log("[Magellan Print] Printer service available:", !!printer);
        console.log("[Magellan Print] Hardware proxy available:", !!hardware_proxy);

        // Store POS environment globally for use in printReceipt
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

console.log("[Magellan Print] Service registered (ORDER MODEL VERSION)");
