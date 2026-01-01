{
    "name": "POS Magellan Scale Integration",
    "version": "18.0.1.0.0",
    "depends": ["point_of_sale"],
    "author": "Shelton / Labodega",
    "category": "Point of Sale",
    "data": [
        "views/pos_config_views.xml",
    ],
    "assets": {
        "point_of_sale._assets_pos": [
            "labodega_pos/static/src/js/magellan_config.js",
            "labodega_pos/static/src/js/magellan_scale_service.js",
            "labodega_pos/static/src/css/compact_receipt.css",
            "labodega_pos/static/src/xml/compact_receipt.xml",
        ],
    },
    "installable": True,
}
