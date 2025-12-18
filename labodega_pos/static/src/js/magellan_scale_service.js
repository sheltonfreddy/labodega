/** @odoo-module **/

import { registry } from "@web/core/registry";
import { BRIDGE_CONFIG } from "./magellan_config";

console.log("[Magellan] magellan_scale_service.js loaded (DIRECT browser → Pi)");
console.log("[Magellan] Pi bridge URL:", BRIDGE_CONFIG.BRIDGE_URL);
console.log("[Magellan] Direct LAN communication (browser → Pi) - NO TAILSCALE");

// Polling control state
let pollingActive = true;
let pollingController = null;
let lastScanTime = 0;
const SCAN_DEBOUNCE_MS = 500; // Prevent duplicate scans within 500ms

async function startBarcodePolling() {
    // wait until the barcodeReader service has been exposed
    while (!window.magellanBarcodeReader) {
        console.log("[Magellan] Waiting for magellanBarcodeReader...");
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const bridgeUrl = BRIDGE_CONFIG.BRIDGE_URL;
    console.log("[Magellan] Starting OPTIMIZED barcode polling from Pi:", bridgeUrl);
    console.log("[Magellan] Browser → Pi (same LAN) - with dynamic intervals");

    let pollCount = 0;
    let consecutiveErrors = 0;
    let consecutiveEmptyPolls = 0;

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        pollingActive = false;
        console.log("[Magellan] Stopping polling - page unload");
    });

    // Pause polling when page is hidden (browser tab inactive)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log("[Magellan] ⏸️ Page hidden - slowing poll rate");
        } else {
            console.log("[Magellan] ▶️ Page visible - resuming normal poll rate");
            consecutiveEmptyPolls = 0; // Reset on activation
        }
    });

    while (pollingActive) {
        try {
            // Dynamic polling interval based on activity and visibility
            let pollInterval = BRIDGE_CONFIG.BARCODE_POLL_INTERVAL; // Default 200ms

            if (document.hidden) {
                // Page not visible - poll much less frequently
                pollInterval = 2000; // 2 seconds
            } else if (consecutiveEmptyPolls > 100) {
                // No activity for a while - slow down
                pollInterval = 500; // 500ms
            } else if (consecutiveEmptyPolls > 50) {
                // Some inactivity - slightly slower
                pollInterval = 300; // 300ms
            }

            // Direct fetch to Pi (browser and Pi on same LAN)
            const piUrl = `${bridgeUrl}/barcode`;
            pollCount++;

            // Reduced logging for better performance
            if (pollCount % 50 === 0) {
                console.log(`[Magellan] 🔄 Poll #${pollCount} (interval: ${pollInterval}ms, errors: ${consecutiveErrors})`);
            }

            const response = await fetch(piUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                },
                signal: AbortSignal.timeout(5000), // 5 second timeout
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            consecutiveErrors = 0; // Reset error count on success

            if (data && data.barcode) {
                // Debounce: ignore if same barcode scanned too quickly
                const now = Date.now();
                if (now - lastScanTime < SCAN_DEBOUNCE_MS) {
                    console.log("[Magellan] ⏭️ Debounced - ignoring rapid re-scan");
                    await new Promise((resolve) => setTimeout(resolve, pollInterval));
                    continue;
                }
                lastScanTime = now;
                consecutiveEmptyPolls = 0; // Reset on scan

                console.log("[Magellan] ✅ Got barcode from Pi:", data.barcode);

                try {
                    if (window.magellanBarcodeReader?.scan) {
                        window.magellanBarcodeReader.scan(data.barcode);
                        console.log("[Magellan] 📦 Barcode processed");
                    }
                } catch (err) {
                    console.error("[Magellan] ❌ Error processing barcode:", err.message);
                }

                // Small delay after successful scan
                await new Promise((resolve) => setTimeout(resolve, 100));
            } else {
                consecutiveEmptyPolls++;
                // Wait before next poll
                await new Promise((resolve) => setTimeout(resolve, pollInterval));
            }
        } catch (err) {
            consecutiveErrors++;

            // Log errors less frequently to reduce console spam
            if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
                console.error(`[Magellan] ❌ Poll error (${consecutiveErrors} consecutive):`, err.message);
            }

            // Exponential backoff on repeated errors (max 10 seconds)
            const backoffDelay = Math.min(2000 * Math.pow(1.5, Math.min(consecutiveErrors, 5)), 10000);
            await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
    }

    console.log("[Magellan] Polling stopped");
}

// Expose control functions globally
window.magellanPollingControl = {
    pause: () => {
        pollingActive = false;
        console.log("[Magellan] Polling paused");
    },
    resume: () => {
        if (!pollingActive) {
            pollingActive = true;
            console.log("[Magellan] Polling resumed");
            startBarcodePolling().catch(err => console.error("[Magellan] Resume error:", err));
        }
    },
    isActive: () => pollingActive
};

// Service wrapper to:
// - patch barcode_reader for weighted products (call /weight via Odoo proxy)
// - expose barcode_reader globally
// - support multiple terminals with different Raspberry Pis
const magellanBarcodeReaderService = {
    dependencies: ["barcode_reader", "pos"],
    start(env, { barcode_reader, pos }) {
        console.log(
            "[Magellan] magellan_barcode_reader service start – got barcode_reader:",
            barcode_reader
        );

        const barcodeReader = barcode_reader;

        // expose for polling code
        window.magellanBarcodeReader = barcodeReader;

        if (!barcodeReader || typeof barcodeReader.register !== "function") {
            console.warn("[Magellan] barcode_reader service not available or invalid");
            return barcodeReader;
        }

        const originalRegister = barcodeReader.register.bind(barcodeReader);

        barcodeReader.register = function (cbMap, exclusive) {
            console.log(
                "[Magellan] barcodeReader.register called. Keys:",
                Object.keys(cbMap || {}),
                "exclusive:",
                exclusive
            );

            if (cbMap && typeof cbMap.product === "function") {
                const originalProductCb = cbMap.product;

                // Store the callback owner context (usually the ProductScreen component)
                let callbackContext = null;

                // Wrapper function for weighted products
                const wrappedProductCb = async function (parsedBarcode) {
                    // Capture the context on first call
                    if (!callbackContext) {
                        callbackContext = this;
                    }

                    // Flag to track if we handled the product
                    let handledWeightedProduct = false;

                    try {
                        // Get POS from multiple possible sources
                        let currentPos = pos || (this && this.pos) || (env && env.services && env.services.pos);

                        // Try to get POS from callback context if not found
                        if (!currentPos && callbackContext) {
                            currentPos = callbackContext.pos || callbackContext.env?.services?.pos;
                        }

                        const code = parsedBarcode && parsedBarcode.code;

                        // Try to find product using available methods
                        let product = null;
                        if (currentPos && code) {
                            // Odoo 18 uses pos.models['product.product']
                            if (currentPos.models && currentPos.models['product.product']) {
                                const products = currentPos.models['product.product'].getAll();
                                product = products.find(p => p.barcode === code);
                            }
                            // Fallback for older Odoo versions
                            else if (currentPos.db && typeof currentPos.db.get_product_by_barcode === 'function') {
                                product = currentPos.db.get_product_by_barcode(code);
                            }
                        }

                        if (product) {
                            if (product && product.to_weight) {
                                console.log(
                                    "[Magellan] ⚖️ Weighted product:",
                                    product.display_name || product.name
                                );

                                let weight = null;
                                try {
                                    // Direct fetch to Pi (browser and Pi on same LAN)
                                    const piWeightUrl = `${BRIDGE_CONFIG.BRIDGE_URL}/weight`;

                                    const response = await fetch(piWeightUrl, {
                                        method: 'GET',
                                        headers: {
                                            'Accept': 'application/json',
                                        },
                                        signal: AbortSignal.timeout(3000), // 3 second timeout
                                    });

                                    if (!response.ok) {
                                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                                    }

                                    const data = await response.json();

                                    if (
                                        data &&
                                        typeof data.weight === "number" &&
                                        data.weight !== null &&
                                        data.weight > 0
                                    ) {
                                        weight = data.weight;
                                        console.log("[Magellan] ✅ Weight:", weight, "kg");
                                    } else {
                                        console.warn("[Magellan] ⚠️ Invalid weight from scale");
                                    }
                                } catch (err) {
                                    console.error("[Magellan] ❌ Weight fetch error:", err.message);
                                }

                                if (weight && weight > 0) {
                                    try {
                                        // Odoo 18 uses pos.addLineToCurrentOrder() instead of order.add_product()
                                        // Note: Odoo expects 'qty' not 'quantity', and configure=false prevents auto scale reading
                                        await currentPos.addLineToCurrentOrder(
                                            {
                                                product_id: product,
                                                qty: weight,  // Use 'qty' not 'quantity'!
                                            },
                                            {},
                                            false  // configure=false to skip automatic scale reading
                                        );

                                        console.log(
                                            "[Magellan] ✅ Added:",
                                            product.display_name || product.name,
                                            "qty =",
                                            weight
                                        );

                                        // Mark that we handled this product
                                        handledWeightedProduct = true;

                                        // Return early - do NOT call originalProductCb
                                        return;
                                    } catch (addErr) {
                                        console.error("[Magellan] ❌ Add error:", addErr.message);
                                        // handledWeightedProduct stays false, will call original callback
                                    }
                                } else {
                                    console.warn("[Magellan] ⚠️ No valid weight, using default handler");
                                }
                            }
                        }
                    } catch (err) {
                        console.error("[Magellan] ❌ Error:", err.message);
                    }

                    // Only call original callback if we didn't handle a weighted product
                    if (!handledWeightedProduct) {
                        return originalProductCb.call(callbackContext || this, parsedBarcode);
                    }
                };

                cbMap.product = wrappedProductCb;
            }

            return originalRegister(cbMap, exclusive);
        };

        // kick off barcode polling loop (once)
        startBarcodePolling().catch((err) => {
            console.error("[Magellan] Error starting polling:", err);
        });

        return barcodeReader;
    },
};

registry.category("services").add(
    "magellan_barcode_reader",
    magellanBarcodeReaderService
);

