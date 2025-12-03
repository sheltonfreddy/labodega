/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import BarcodeReader from "point_of_sale.BarcodeReader";

/*
 * Idea:
 * - When a barcode is scanned, Odoo POS calls BarcodeReader.scan(code).
 * - We patch scan() to:
 *      1) Resolve the product from barcode
 *      2) If product.to_weight == true:
 *            - call local Flask bridge http://127.0.0.1:5001/weight
 *            - add product with qty = weight
 *         else:
 *            - fall back to normal behavior (super)
 */

patch(BarcodeReader.prototype, "pos_magellan_scale.BarcodeReader", {
    async scan(code) {
        // "code" can be a string or an object depending on Odoo version;
        // normalize to raw string.
        const rawCode = typeof code === "string" ? code : (code.code || "");

        const pos = this.env.pos;
        const product = pos.db.get_product_by_barcode(rawCode);

        // Only intercept if:
        //  - barcode matched a product
        //  - and product is flagged as "to_weight"
        if (product && product.to_weight) {
            console.log("[Magellan] Weighted product barcode scanned:", rawCode, product.display_name);

            let weight = null;
            try {
                const response = await fetch("http://127.0.0.1:5001/weight", {
                    method: "GET",
                    headers: {
                        "Accept": "application/json",
                    },
                });
                if (!response.ok) {
                    console.warn("[Magellan] Bridge HTTP error:", response.status);
                } else {
                    const data = await response.json();
                    if (data.success && typeof data.weight === "number" && data.weight > 0) {
                        weight = data.weight;
                    } else {
                        console.warn("[Magellan] Bridge returned no/invalid weight:", data);
                    }
                }
            } catch (err) {
                console.error("[Magellan] Error calling weight bridge:", err);
            }

            if (weight && weight > 0) {
                const order = pos.get_order();
                // Add with quantity = weight, let POS handle price / taxes.
                order.add_product(product, {
                    quantity: weight,
                });
                return; // IMPORTANT: do not call super => avoid qty=1
            } else {
                // If no weight coming back, fall back to normal behavior.
                console.warn("[Magellan] Falling back to default scan behavior for", rawCode);
                return this._super(code);
            }
        }

        // Non-weighted product or no product -> normal behavior
        return this._super(code);
    },
});
