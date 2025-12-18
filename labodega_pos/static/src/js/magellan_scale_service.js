/** @odoo-module **/

import { registry } from "@web/core/registry";
import { BRIDGE_CONFIG } from "./magellan_config";

console.log("[Magellan] magellan_scale_service.js loaded (DIRECT browser → Pi)");
console.log("[Magellan] Pi bridge URL:", BRIDGE_CONFIG.BRIDGE_URL);
console.log("[Magellan] Direct LAN communication (browser → Pi) - NO TAILSCALE");

async function startBarcodePolling() {
    // wait until the barcodeReader service has been exposed
    while (!window.magellanBarcodeReader) {
        console.log("[Magellan] Waiting for magellanBarcodeReader...");
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const bridgeUrl = BRIDGE_CONFIG.BRIDGE_URL;
    console.log("[Magellan] Starting DIRECT barcode polling from Pi:", bridgeUrl);
    console.log("[Magellan] Browser → Pi (same LAN) - no proxy needed!");

    let pollCount = 0;
    while (true) {
        try {
            // Direct fetch to Pi (browser and Pi on same LAN)
            const piUrl = `${bridgeUrl}/barcode`;

            pollCount++;

            // Log every 10 polls for debugging
            if (pollCount % 10 === 0) {
                console.log(`[Magellan] 🔄 Barcode poll #${pollCount} - direct fetch: ${piUrl}`);
            }

            const response = await fetch(piUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                },
            });

            console.log(`[Magellan] 📡 Poll #${pollCount} - Response status: ${response.status} ${response.statusText}`);

            if (!response.ok) {
                console.error(`[Magellan] ❌ Bad response: ${response.status}`);
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            // Log EVERY response to see what we're getting
            console.log(`[Magellan] 📦 Poll #${pollCount} response data:`, JSON.stringify(data));

            if (data && data.barcode) {
                console.log("[Magellan] ✅✅✅ Got barcode directly from Pi:", data.barcode);
                console.log("[Magellan] 🎯 window.magellanBarcodeReader exists?", !!window.magellanBarcodeReader);
                console.log("[Magellan] 🎯 window.magellanBarcodeReader.scan exists?", typeof window.magellanBarcodeReader?.scan);

                try {
                    if (!window.magellanBarcodeReader) {
                        console.error("[Magellan] ❌ window.magellanBarcodeReader is null/undefined!");
                    } else if (typeof window.magellanBarcodeReader.scan !== 'function') {
                        console.error("[Magellan] ❌ window.magellanBarcodeReader.scan is not a function!");
                    } else {
                        console.log("[Magellan] 🚀 Calling barcodeReader.scan with:", data.barcode);
                        window.magellanBarcodeReader.scan(data.barcode);
                        console.log("[Magellan] ✅ barcodeReader.scan called successfully");
                    }
                } catch (err) {
                    console.error("[Magellan] ❌ Error calling barcodeReader.scan:", err);
                    console.error("[Magellan] ❌ Error stack:", err.stack);
                }
            } else {
                // Log null/empty responses occasionally
                if (pollCount % 50 === 0) {
                    console.log(`[Magellan] ⚪ Poll #${pollCount} - No barcode (empty response)`);
                }
                // no barcode → just loop again (poll every 200ms)
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        } catch (err) {
            console.error("[Magellan] ❌ Direct Pi fetch error:", err.message);
            console.error("[Magellan] ❌ Full error:", err);
            console.error("[Magellan] ❌ Error stack:", err.stack);
            // backoff a bit on errors
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}

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
                        console.log("[Magellan] 🎯 Captured callback context:", !!callbackContext);
                    }

                    console.log("[Magellan] 🔔 PRODUCT CALLBACK HIT!");
                    console.log("[Magellan] 📦 parsedBarcode:", JSON.stringify(parsedBarcode));

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
                        console.log("[Magellan] 🏪 POS available?", !!currentPos, "| barcode code:", code);

                        // Check multiple ways to access products in Odoo 18
                        const hasDB = !!currentPos?.db;
                        const hasModels = !!currentPos?.models;
                        const hasData = !!currentPos?.data;
                        console.log("[Magellan] 🏪 POS.db:", hasDB, "POS.models:", hasModels, "POS.data:", hasData);

                        // Try to find product using available methods
                        let product = null;
                        if (currentPos && code) {
                            // Odoo 18 uses pos.models['product.product']
                            if (currentPos.models && currentPos.models['product.product']) {
                                const products = currentPos.models['product.product'].getAll();
                                product = products.find(p => p.barcode === code);
                                console.log("[Magellan] 🔍 Searched", products.length, "products, found:", !!product);
                            }
                            // Fallback for older Odoo versions
                            else if (currentPos.db && typeof currentPos.db.get_product_by_barcode === 'function') {
                                product = currentPos.db.get_product_by_barcode(code);
                            }
                        }

                        if (product) {
                            console.log("[Magellan] 📦 Product found:", product.display_name || product.name);
                            console.log("[Magellan] 📦 Product details:", {
                                id: product.id,
                                name: product.display_name || product.name,
                                to_weight: product.to_weight
                            });

                            if (product && product.to_weight) {
                                console.log(
                                    "[Magellan] ⚖️ WEIGHTED PRODUCT DETECTED:",
                                    product.display_name
                                );

                                let weight = null;
                                try {
                                    // Direct fetch to Pi (browser and Pi on same LAN)
                                    const piWeightUrl = `${BRIDGE_CONFIG.BRIDGE_URL}/weight`;

                                    console.log("[Magellan] 🌐 Fetching weight directly from Pi:", piWeightUrl);
                                    const response = await fetch(piWeightUrl, {
                                        method: 'GET',
                                        headers: {
                                            'Accept': 'application/json',
                                        },
                                    });

                                    console.log("[Magellan] ⚖️ Weight response status:", response.status);

                                    if (!response.ok) {
                                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                                    }

                                    const data = await response.json();
                                    console.log("[Magellan] ⚖️ Weight response data:", JSON.stringify(data));

                                    if (
                                        data &&
                                        typeof data.weight === "number" &&
                                        data.weight !== null &&
                                        data.weight > 0
                                    ) {
                                        weight = data.weight;
                                        console.log("[Magellan] ✅ Valid weight received:", weight);
                                    } else {
                                        console.warn(
                                            "[Magellan] ⚠️ /weight returned invalid weight:",
                                            data
                                        );
                                    }
                                } catch (err) {
                                    console.error(
                                        "[Magellan] ❌ Error calling /weight directly from Pi:",
                                        err.message
                                    );
                                    console.error("[Magellan] ❌ Error stack:", err.stack);
                                }

                                if (weight && weight > 0) {
                                    try {
                                        console.log("[Magellan] ➕ Adding weighted product to order:", product.display_name || product.name, "qty:", weight);

                                        // Odoo 18 uses pos.addLineToCurrentOrder() instead of order.add_product()
                                        await currentPos.addLineToCurrentOrder(
                                            {
                                                product_id: product,
                                                quantity: weight,
                                            },
                                            {},
                                            true
                                        );

                                        console.log(
                                            "[Magellan] ✅ Successfully added weighted product",
                                            product.display_name || product.name,
                                            "qty =",
                                            weight
                                        );

                                        // Mark that we handled this product
                                        handledWeightedProduct = true;
                                        console.log("[Magellan] 🚫 Skipping original callback - already handled weighted product");

                                        // Return early - do NOT call originalProductCb
                                        return;
                                    } catch (addErr) {
                                        console.error("[Magellan] ❌ Error adding product to order:", addErr.message);
                                        console.error("[Magellan] ❌ Falling back to default handler");
                                        // handledWeightedProduct stays false, will call original callback
                                    }
                                } else {
                                    console.warn(
                                        "[Magellan] ⚠️ No valid weight, falling back to default handler"
                                    );
                                }
                            }
                        } else {
                            console.log("[Magellan] ⚪ Product not found or POS not ready");
                            console.log("[Magellan] ⚪ currentPos:", !!currentPos, "code:", code);
                            if (currentPos) {
                                console.log("[Magellan] ⚪ Available props:", Object.keys(currentPos).slice(0, 10));
                            }
                        }
                    } catch (err) {
                        console.error(
                            "[Magellan] ❌ Error in wrapped product callback:",
                            err
                        );
                        console.error("[Magellan] ❌ Error message:", err.message);
                        console.error("[Magellan] ❌ Error stack:", err.stack);
                    }

                    // Only call original callback if we didn't handle a weighted product
                    if (!handledWeightedProduct) {
                        console.log("[Magellan] 🔄 Calling original product callback (fallback)");
                        return originalProductCb.call(callbackContext || this, parsedBarcode);
                    } else {
                        console.log("[Magellan] ✅ Weighted product handled, not calling original callback");
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

