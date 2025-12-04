/** @odoo-module **/

import { registry } from "@web/core/registry";

console.log("[Magellan] magellan_scale_service.js loaded");

const serviceRegistry = registry.category("services");
const originalService = serviceRegistry.get("barcode_reader");

if (!originalService || !originalService.start) {
    console.warn("[Magellan] barcode_reader service not found or invalid:", originalService);
} else {
    // Re-register the barcode_reader service, wrapping its start() so we can patch
    // the instance that it returns.
    serviceRegistry.add("barcode_reader", {
        ...originalService,
        async start(env, deps) {
            const barcodeReader = await originalService.start(env, deps);

            if (!barcodeReader) {
                console.warn("[Magellan] barcodeReader instance is null");
                return barcodeReader;
            }

            console.log("[Magellan] Patching barcodeReader.register for weighted products");

            const originalRegister = barcodeReader.register.bind(barcodeReader);

            // This is called when screens/components mount (via useBarcodeReader),
            // NOT when a scan happens.
            barcodeReader.register = function (cbMap, exclusive) {
                console.log(
                    "[Magellan] register called",
                    "exclusive=",
                    exclusive,
                    "keys=",
                    cbMap ? Object.keys(cbMap) : []
                );

                if (cbMap && typeof cbMap.product === "function") {
                    const originalProductCb = cbMap.product;

                    cbMap.product = async function (parsedBarcode) {
                        console.log("[Magellan] product callback hit, parsedBarcode =", parsedBarcode);

                        try {
                            // In barcode_reader_hook.js they do callback.bind(current),
                            // so inside here `this` is the POS screen component.
                            const ui = this;
                            const pos = ui.pos || (ui.env && ui.env.pos);

                            // Be defensive: different parsers may use different fields
                            const code =
                                parsedBarcode.code ||
                                parsedBarcode.barcode ||
                                parsedBarcode.value ||
                                parsedBarcode;

                            console.log("[Magellan] resolved scanned code =", code);

                            let product = null;
                            if (pos && pos.db && code) {
                                product = pos.db.get_product_by_barcode(code);
                            }

                            if (product && product.to_weight) {
                                console.log(
                                    "[Magellan] Weighted product detected:",
                                    product.display_name,
                                    "from code",
                                    code
                                );

                                let weight = null;

                                try {
                                    const response = await fetch("http://127.0.0.1:5001/weight", {
                                        method: "GET",
                                        headers: { Accept: "application/json" },
                                    });

                                    if (!response.ok) {
                                        console.warn(
                                            "[Magellan] Bridge HTTP error:",
                                            response.status
                                        );
                                    } else {
                                        const data = await response.json();
                                        console.log("[Magellan] Bridge response:", data);

                                        if (
                                            data &&
                                            data.success &&
                                            typeof data.weight === "number" &&
                                            data.weight > 0
                                        ) {
                                            weight = data.weight;
                                        } else {
                                            console.warn(
                                                "[Magellan] Bridge returned invalid weight",
                                                data
                                            );
                                        }
                                    }
                                } catch (err) {
                                    console.error(
                                        "[Magellan] Error calling weight bridge:",
                                        err
                                    );
                                }

                                if (weight && weight > 0) {
                                    const order = pos.get_order();
                                    if (order) {
                                        order.add_product(product, { quantity: weight });
                                        console.log(
                                            "[Magellan] Added weighted product",
                                            product.display_name,
                                            "qty=",
                                            weight
                                        );
                                        // IMPORTANT: do NOT call the original handler
                                        // => avoid default qty=1 line.
                                        return;
                                    }
                                } else {
                                    console.warn(
                                        "[Magellan] No valid weight, falling back to default handler"
                                    );
                                }
                            }
                        } catch (err) {
                            console.error(
                                "[Magellan] Error in wrapped product callback:",
                                err
                            );
                        }

                        // Fallback: original behavior (normal POS flow)
                        return originalProductCb.call(this, parsedBarcode);
                    };
                }

                // Register (with our wrapped product callback, if any)
                return originalRegister(cbMap, exclusive);
            };

            return barcodeReader;
        },
    });
}
