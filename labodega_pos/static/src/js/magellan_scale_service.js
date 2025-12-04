/** @odoo-module **/

import { registry } from "@web/core/registry";

console.log("[Magellan] magellan_scale_service.js loaded");

// New service that *wraps* the core barcode_reader service
const magellanBarcodeReaderService = {
    dependencies: ["barcode_reader"],
    start(env, { barcode_reader }) {
        console.log("[Magellan] magellan_barcode_reader service start – got barcode_reader:", barcode_reader);

        const barcodeReader = barcode_reader;
        if (!barcodeReader || typeof barcodeReader.register !== "function") {
            console.warn("[Magellan] barcode_reader service not available or invalid");
            return barcodeReader;
        }

        // ---- Patch scan() just to see if ANY scan reaches the service ----
        if (typeof barcodeReader.scan === "function") {
            const originalScan = barcodeReader.scan.bind(barcodeReader);
            barcodeReader.scan = function (code) {
                console.log("[Magellan] barcodeReader.scan called with code:", code);
                return originalScan(code);
            };
        } else {
            console.warn("[Magellan] barcode_reader.scan is not a function");
        }

        // ---- Patch register() so we can log registrations AND wrap product ----
        const originalRegister = barcodeReader.register.bind(barcodeReader);

        barcodeReader.register = function (cbMap, exclusive) {
            console.log("[Magellan] barcodeReader.register called. Keys:", Object.keys(cbMap || {}), "exclusive:", exclusive);

            if (cbMap && typeof cbMap.product === "function") {
                const originalProductCb = cbMap.product;

                cbMap.product = async function (parsedBarcode) {
                    console.log("[Magellan] product callback hit. parsedBarcode:", parsedBarcode);

                    try {
                        const pos = this.pos;
                        const code = parsedBarcode && parsedBarcode.code;

                        console.log("[Magellan] product callback this.pos:", !!pos, "code:", code);

                        if (pos && pos.db && code) {
                            const product = pos.db.get_product_by_barcode(code);
                            console.log("[Magellan] product from POS DB:", product);

                            if (product && product.to_weight) {
                                console.log("[Magellan] Detected weighted product:", product.display_name);

                                let weight = null;

                                try {
                                    const response = await fetch("http://127.0.0.1:5001/weight", {
                                        method: "GET",
                                        headers: { Accept: "application/json" },
                                    });

                                    console.log("[Magellan] Bridge HTTP status:", response.status);

                                    if (!response.ok) {
                                        console.warn("[Magellan] Bridge HTTP error:", response.status);
                                    } else {
                                        const data = await response.json();
                                        console.log("[Magellan] Bridge JSON response:", data);

                                        if (
                                            data &&
                                            data.success &&
                                            typeof data.weight === "number" &&
                                            data.weight > 0
                                        ) {
                                            weight = data.weight;
                                        } else {
                                            console.warn(
                                                "[Magellan] Bridge returned invalid weight:",
                                                data
                                            );
                                        }
                                    }
                                } catch (err) {
                                    console.error("[Magellan] Error calling weight bridge:", err);
                                }

                                if (weight && weight > 0) {
                                    const order = pos.get_order();
                                    console.log("[Magellan] Current order:", order);

                                    if (order) {
                                        order.add_product(product, { quantity: weight });
                                        console.log(
                                            "[Magellan] Added weighted product",
                                            product.display_name,
                                            "qty =",
                                            weight
                                        );
                                        // Do NOT call the original callback → avoid extra qty=1
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
                        console.error("[Magellan] Error in wrapped product callback:", err);
                    }

                    // Fallback: normal behavior
                    return originalProductCb.call(this, parsedBarcode);
                };
            }

            // Always call original register so POS still works
            return originalRegister(cbMap, exclusive);
        };

        return barcodeReader;
    },
};

// Register a *new* service (no name conflict)
registry.category("services").add("magellan_barcode_reader", magellanBarcodeReaderService);
