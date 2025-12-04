/** @odoo-module **/

import { registry } from "@web/core/registry";

console.log("[Magellan] magellan_scale_service.js loaded");

// This service depends on the existing "barcode_reader" service.
// Its whole job is to PATCH barcode_reader.register so that
// weighted products ask the Flask bridge for a weight.
const magellanBarcodeReaderService = {
    dependencies: ["barcode_reader"],
    start(env, { barcode_reader }) {
        console.log("[Magellan] magellan_barcode_reader service start – patching barcode_reader");

        const barcodeReader = barcode_reader;
        console.log("barcodeReader", barcodeReader)
        console.log("barcodeReader type", typeof barcodeReader.register)
        if (!barcodeReader || typeof barcodeReader.register !== "function") {
            console.warn("[Magellan] barcode_reader service not available or invalid");
            return barcodeReader;
        }

        const originalRegister = barcodeReader.register.bind(barcodeReader);
        console.log("originalRegister", originalRegister)

        barcodeReader.register = function (cbMap, exclusive) {
            // cbMap is the callback map passed by useBarcodeReader({ product() { ... }, ... })
            console.log("inside barcodeReader.register")
            if (cbMap && typeof cbMap.product === "function") {
                console.log("typeof cbMap.product", typeof cbMap.product)
                const originalProductCb = cbMap.product;

                cbMap.product = async function (parsedBarcode) {
                    // In callbacks, `this` is the POS screen component (see barcode_reader_hook.js),
                    // so `this.pos` is the POS instance.
                    console.log("parsedBarcode", parsedBarcode)
                    try {
                        const pos = this.pos;
                        const code = parsedBarcode && parsedBarcode.code;
                        console.log("pos && pos.db && code", pos,pos.db,code)
                        if (pos && pos.db && code) {
                            const product = pos.db.get_product_by_barcode(code);
                            console.log("product", product, product.to_weight)

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
                                                "[Magellan] Bridge returned invalid weight:",
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
                                            "qty =",
                                            weight
                                        );
                                        // IMPORTANT: do NOT call originalProductCb here
                                        // → prevents extra qty=1 line.
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

            // Register callbacks (possibly wrapped)
            return originalRegister(cbMap, exclusive);
        };

        // Return the (patched) barcodeReader instance
        return barcodeReader;
    },
};

// IMPORTANT: new service name -> no conflict with "barcode_reader"
registry.category("services").add("magellan_barcode_reader", magellanBarcodeReaderService);
