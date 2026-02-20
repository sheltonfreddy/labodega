{
    'name': 'Product CSV Import Wizard',
    'version': '18.0.1.2.0',
    'category': 'Inventory',
    'summary': 'Import products from CSV, update barcodes, and print product labels',
    'description': """
        Import products from Diaz Foods CSV price list.
        
        Features:
        - Match existing products by barcode
        - Update name, cost, sale price, and purchase description
        - Keep existing barcodes in Odoo (won't overwrite)
        - Create new products if barcode doesn't exist
        - Print product labels (5x3cm, 32 per sheet)
        - Bulk update barcodes via CSV (Current Barcode → New Barcode)
    """,
    'author': 'La Bodega',
    'depends': ['product', 'stock', 'point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'report/product_label_report.xml',
        'views/import_wizard_views.xml',
        'views/label_wizard_views.xml',
        'views/barcode_update_wizard_views.xml',
    ],
    'installable': True,
    'application': False,
    'license': 'LGPL-3',
}



