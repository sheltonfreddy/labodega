/** @odoo-module **/
console.log("[Magellan] magellan_scale_service.js loaded");
import { patch } from "@web/core/utils/patch";
import { BarcodeReader } from "@point_of_sale/app/barcode_reader/barcode_reader";

console.log("[Magellan] magellan_scale_service.js loaded (POS patch init)");

patch(BarcodeReader.prototype, "pos_magellan_scale.BarcodeReader", {
    async scan(code) {
        const rawCode = typeof code === "string" ? code : (code.code || "");
        console.log("[Magellan] scan intercepted:", rawCode);

        const pos = this.env.pos;
        const product = pos.db.get_product_by_barcode(rawCode);

        if (product && product.to_weight) {
            console.log("[Magellan] Weighted product scanned:", rawCode, product.display_name);

            let weight = null;
            try {
                const response = await fetch("http://127.0.0.1:5001/weight", {
                    method: "GET",
                    headers: { "Accept": "application/json" },
                });
                if (!response.ok) {
                    console.warn("[Magellan] Bridge HTTP error:", response.status);
                } else {
                    const data = await response.json();
                    console.log("[Magellan] Bridge response:", data);
                    if (data.success && typeof data.weight === "number" && data.weight > 0) {
                        weight = data.weight;
                    }
                }
            } catch (err) {
                console.error("[Magellan] Error calling weight bridge:", err);
            }

            if (weight && weight > 0) {
                const order = pos.get_order();
                order.add_product(product, { quantity: weight });
                console.log("[Magellan] Added product with qty =", weight);
                return; // don’t call super → avoid qty=1
            } else {
                console.warn("[Magellan] No weight, falling back to default scan");
                return this._super(code);
            }
        }

        // Non-weight product or barcode not found → default behavior
        return this._super(code);
    },
});