/** @odoo-module */

import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";
import { patch } from "@web/core/utils/patch";

console.log("[Compact Receipt] Module loading...");

// Patch the OrderReceipt component to add compact-receipt class
patch(OrderReceipt.prototype, {
    setup() {
        super.setup();
        console.log("[Compact Receipt] OrderReceipt patched - adding compact styling");
    }
});

// Override the template property
const originalTemplate = OrderReceipt.template;
OrderReceipt.template = "labodega_pos.CompactOrderReceipt";

console.log("[Compact Receipt] Template override applied:", OrderReceipt.template);
console.log("[Compact Receipt] Original template was:", originalTemplate);


