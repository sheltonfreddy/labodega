/** @odoo-module **/

import { registry } from "@web/core/registry";
import { jsonrpc } from "@web/core/network/rpc_service";

console.log("[Magellan] magellan_scale_service.js loaded");

async function startBarcodePolling(rpc) {
    // wait until the barcodeReader service has been exposed
    while (!window.magellanBarcodeReader) {
        console.log("[Magellan] Waiting for magellanBarcodeReader...");
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log("[Magellan] Starting barcode polling from bridge via Odoo proxy");

    while (true) {
        try {
            const data = await rpc("/pos/magellan/barcode");

            if (data.error) {
                console.warn("[Magellan] Bridge error:", data.error);
                await new Promise((resolve) => setTimeout(resolve, 3000));
                continue;
            }

            if (data.barcode) {
                console.log("[Magellan] Got barcode from bridge:", data.barcode);
                try {
                    window.magellanBarcodeReader.scan(data.barcode);
                } catch (err) {
                    console.error("[Magellan] Error calling barcodeReader.scan:", err);
                }
            } else {
                // no barcode → just loop again (poll every 200ms)
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        } catch (err) {
            console.error("[Magellan] Error while polling /barcode:", err);
            // backoff a bit on errors
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}

// Service wrapper to:
// - patch barcode_reader for weighted products (call /weight via Odoo proxy)
// - expose barcode_reader globally
const magellanBarcodeReaderService = {
    dependencies: ["barcode_reader", "rpc"],
    start(env, { barcode_reader, rpc }) {
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
                                console.log(
                                    "[Magellan] Detected weighted product:",
                                    product.display_name
                                );

                                let weight = null;
                                try {
                                    const data = await rpc("/pos/magellan/weight");
                                    console.log("[Magellan] /weight response:", data);

                                    if (data.error) {
                                        console.warn("[Magellan] Bridge /weight error:", data.error);
                                    } else if (
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
                                        "[Magellan] Error calling /weight bridge:",
                                        err
                                    );
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

                    // Fallback: normal behavior
                    return originalProductCb.call(this, parsedBarcode);
                };
            }

            return originalRegister(cbMap, exclusive);
        };

        // kick off barcode polling loop (once)
        startBarcodePolling(rpc).catch((err) => {
            console.error("[Magellan] Error starting polling:", err);
        });

        return barcodeReader;
    },
};

registry.category("services").add(
    "magellan_barcode_reader",
    magellanBarcodeReaderService
);
