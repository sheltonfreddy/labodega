{
    "name": "POS Magellan Scale Integration",
    "version": "18.0.1.2.0",  # Added POS Sales Summary Report
    "depends": ["point_of_sale"],
    "author": "Shelton / Labodega",
    "category": "Point of Sale",
    "data": [
        "security/ir.model.access.csv",
        "security/pos_security.xml",
        "views/pos_config_views.xml",
        "views/pos_sales_summary_views.xml",
        "report/pos_sales_summary_template.xml",
    ],
    "assets": {
        "point_of_sale._assets_pos": [
            "labodega_pos/static/src/js/magellan_config.js",
            "labodega_pos/static/src/js/magellan_scale_service.js",
            "labodega_pos/static/src/js/magellan_print_service.js",
            "labodega_pos/static/src/css/compact_receipt_v2.css",
            "labodega_pos/static/src/css/navbar_logo.css",
            "labodega_pos/static/src/css/screensaver_logo.css",
            "labodega_pos/static/src/xml/compact_receipt.xml",
            "labodega_pos/static/src/xml/navbar_logo.xml",
            "labodega_pos/static/src/xml/screensaver_logo.xml",
        ],
    },
    "installable": True,
}
