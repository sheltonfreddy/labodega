/** @odoo-module */

import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";
import { patch } from "@web/core/utils/patch";

// Patch the OrderReceipt component to use compact template
patch(OrderReceipt.prototype, {
    setup() {
        super.setup(...arguments);
        console.log("[Compact Receipt] Patched OrderReceipt component");
    }
});

// Override the template
OrderReceipt.template = "labodega_pos.CompactOrderReceipt";

console.log("[Compact Receipt] Module loaded - using compact template");

