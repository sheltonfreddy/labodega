/** @odoo-module **/

import { registry } from "@web/core/registry";

console.log("[Magellan] magellan_scale_service.js loaded");

const serviceRegistry = registry.category("services");
const baseService = serviceRegistry.get("barcode_reader");

if (baseService && baseService.start) {
    const originalStart = baseService.start;

    baseService.start = async (env, deps) => {
        const barcodeReader = await originalStart(env, deps);

        if (!barcodeReader) {
            console.warn("[Magellan] barcode_reader service returned null");
            return barcodeReader;
        }

        console.log("[Magellan] Patching barcodeReader.register for weighted products");

        const originalRegister = barcodeReader.register.bind(barcodeReader);

        // Wrap register to intercept the 'product' callback
        barcodeReader.register = function (cbMap, exclusive) {
            if (cbMap && typeof cbMap.product === "function") {
                const originalProductCb = cbMap.product;

                cbMap.product = async function (parsedBarcode) {
                    // NOTE: thanks to useBarcodeReader, `this` here is the POS screen component
                    // (see barcode_reader_hook.js). So we can use `this.pos`.
                    try {
                        const pos = this.pos;
                        const code = parsedBarcode.code;

                        if (pos && pos.db && code) {
                            const product = pos.db.get_product_by_barcode(code);

                            if (product && product.to_weight) {
                                console.log(
                                    "[Magellan] Weighted product via barcode:",
                                    code,
                                    product.display_name
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
                                        // IMPORTANT: do NOT call originalProductCb
                                        // so we avoid the default qty=1 behavior.
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

                    // Fallback: run the original behavior (qty = 1 etc.)
                    return originalProductCb.call(this, parsedBarcode);
                };
            }

            return originalRegister(cbMap, exclusive);
        };

        return barcodeReader;
    };
} else {
    console.warn("[Magellan] barcode_reader service not found – scale integration disabled");
}
