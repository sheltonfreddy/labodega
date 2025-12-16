/** @odoo-module **/

import { registry } from "@web/core/registry";
import { BRIDGE_CONFIG } from "./magellan_config";

console.log("[Magellan] magellan_scale_service.js loaded (via Odoo proxy)");
console.log("[Magellan] Pi bridge URL:", BRIDGE_CONFIG.BRIDGE_URL);
console.log("[Magellan] Using Odoo proxy to avoid HTTPS→HTTP mixed content errors");

async function startBarcodePolling() {
    // wait until the barcodeReader service has been exposed
    while (!window.magellanBarcodeReader) {
        console.log("[Magellan] Waiting for magellanBarcodeReader...");
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const bridgeUrl = BRIDGE_CONFIG.BRIDGE_URL.replace('http://', '').replace('https://', '');
    console.log("[Magellan] Starting barcode polling via Odoo proxy");
    console.log("[Magellan] Pi bridge:", bridgeUrl);
    console.log("[Magellan] Browser → Odoo (HTTPS) → Pi (HTTP) to avoid mixed content");

    let pollCount = 0;
    while (true) {
        try {
            // Use Odoo proxy to avoid mixed content HTTPS→HTTP issue
            const odooProxyUrl = `/labodega_pos/proxy/barcode?bridge_url=${encodeURIComponent(bridgeUrl)}`;

            pollCount++;

            // Log every 10 polls for debugging
            if (pollCount % 10 === 0) {
                console.log(`[Magellan] 🔄 Barcode poll #${pollCount} - fetching: ${odooProxyUrl}`);
            }

            const response = await fetch(odooProxyUrl, {
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
                console.log("[Magellan] ✅✅✅ Got barcode via Odoo proxy:", data.barcode);
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
            console.error("[Magellan] ❌ Odoo proxy error:", err.message);
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

                    try {
                        // Get POS from multiple possible sources
                        const currentPos = pos || (this && this.pos) || (env && env.services && env.services.pos);
                        const code = parsedBarcode && parsedBarcode.code;
                        console.log("[Magellan] 🏪 POS available?", !!currentPos, "| barcode code:", code);
                        console.log("[Magellan] 🏪 POS.db available?", !!currentPos?.db);

                        if (currentPos && currentPos.db && code) {
                            console.log("[Magellan] 🔍 Looking up product with barcode:", code);
                            const product = currentPos.db.get_product_by_barcode(code);
                            console.log("[Magellan] 📦 Product found:", !!product);
                            if (product) {
                                console.log("[Magellan] 📦 Product details:", {
                                    id: product.id,
                                    name: product.display_name,
                                    to_weight: product.to_weight
                                });
                            }

                            if (product && product.to_weight) {
                                console.log(
                                    "[Magellan] ⚖️ WEIGHTED PRODUCT DETECTED:",
                                    product.display_name
                                );

                                let weight = null;
                                try {
                                    // Use Odoo proxy to avoid mixed content HTTPS→HTTP issue
                                    const bridgeUrl = BRIDGE_CONFIG.BRIDGE_URL.replace('http://', '').replace('https://', '');
                                    const odooProxyUrl = `/labodega_pos/proxy/weight?bridge_url=${encodeURIComponent(bridgeUrl)}`;

                                    console.log("[Magellan] Fetching weight via Odoo proxy:", odooProxyUrl);
                                    const response = await fetch(odooProxyUrl, {
                                        method: 'GET',
                                        headers: {
                                            'Accept': 'application/json',
                                        },
                                    });

                                    if (!response.ok) {
                                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                                    }

                                    const data = await response.json();
                                    console.log("[Magellan] /weight response:", data);

                                    if (
                                        data &&
                                        typeof data.weight === "number" &&
                                        data.weight !== null &&
                                        data.weight > 0
                                    ) {
                                        weight = data.weight;
                                    } else {
                                        console.warn(
                                            "[Magellan] /weight returned invalid weight:",
                                            data
                                        );
                                    }
                                } catch (err) {
                                    console.error(
                                        "[Magellan] Error calling /weight via Odoo proxy:",
                                        err.message
                                    );
                                }

                                if (weight && weight > 0) {
                                    const order = currentPos.get_order();
                                    console.log("[Magellan] Current order:", order);
                                    if (order) {
                                        order.add_product(product, { quantity: weight });
                                        console.log(
                                            "[Magellan] Added weighted product",
                                            product.display_name,
                                            "qty =",
                                            weight
                                        );
                                        // Do NOT call originalProductCb to avoid extra qty=1
                                        return;
                                    }
                                } else {
                                    console.warn(
                                        "[Magellan] No valid weight, falling back to default handler"
                                    );
                                }
                            }
                        }
                    } catch (err) {
                        console.error(
                            "[Magellan] Error in wrapped product callback:",
                            err
                        );
                    }

                    // Fallback: normal behavior - use captured context
                    return originalProductCb.call(callbackContext || this, parsedBarcode);
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

